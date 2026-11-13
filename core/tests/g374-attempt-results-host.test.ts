import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  init, createGoal, setCriteria, findGoalFile, loadGoal,
  stripAttemptReportSkeleton,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dist/index.js";

// g-374 F1：宿主侧零 token 截获（ctx.on("subagent/end")）的行为契约。
// 覆盖：正常文本 / 无 text 块 / stopReason 异常 / 字段整体缺失 / Map miss / 多 epoch last-wins /
// 截断 / child_error / 旧宿主无 ctx.on 静默降级 / 事件回调不依赖父轮次存活 / 零新增 LLM 会话。

const OVERWRITE_NOTE = "本文件由机器生成，下次写入整体覆盖";

function createHarness({ providers = ["spawn"], withOn = true, withSubagents = true }: {
  providers?: string[];
  withOn?: boolean;
  withSubagents?: boolean;
} = {}) {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g374-host-"));
  const root = join(ws, ".dsh-graph");
  // 每个夹具使用私有仓库及版本基线，避免依赖外层工作树。
  const git = (...args: string[]) => execFileSync("git", args, { cwd: ws, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init", "--allow-empty");
  git("branch", "v1.0-test");
  init(root);
  const events: Record<string, Function[]> = {};
  const capturedRequests: any[] = [];
  const registeredTools: any[] = [];

  const ctx: any = {
    get: (name: string) => {
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "subagents" && withSubagents) {
        return {
          list: () => providers,
          getProvider: (n: string) => (providers.includes(n) ? { prepareContinuable: () => {} } : {}),
          startContinuable: async (opts: any) => {
            capturedRequests.push(opts);
            return { childId: "child-fixed-1", parentSessionId: "sess-super" };
          },
        };
      }
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    tools: { register: (def: any) => { registeredTools.push(def); return () => {}; }, get: () => ({}) },
  };
  if (withOn) {
    ctx.on = (name: string, fn: Function) => {
      (events[name] = events[name] ?? []).push(fn);
      return () => {};
    };
  }

  apply(ctx, { root });
  const toolsByName = new Map(registeredTools.map((t: any) => [t.name, t]));
  const execContext = {
    agent: { id: "a1", session: { header: { cwd: ws }, id: "sess-exec" } },
    signal: new AbortController().signal,
  };
  const emit = (name: string, info: any) => {
    for (const fn of events[name] ?? []) fn(info);
    return (events[name] ?? []).length;
  };
  return { ws, root, toolsByName, execContext, capturedRequests, emit, events };
}

function prepare(h: ReturnType<typeof createHarness>) {
  writeFileSync(join(h.root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const goal = createGoal(h.root, { title: "F1 截获", version: "v1.0", actor: "human:gui" });
  setCriteria(h.root, goal, ["判据 1"], "human:gui");
  return { goal, dir: dirname(findGoalFile(h.root, goal)) };
}

function dispatch(h: ReturnType<typeof createHarness>, goal: string) {
  return h.toolsByName.get("graph_start_attempt")!.execute(
    { goal, attempt_brief: "F1 派发 action" },
    h.execContext,
  );
}

function resultsEvents(root: string, name: string) {
  return readEvents(root).filter((e) => e.event === name);
}

// ============================================================================
// 判据 1（零 token）+ 判据 2（事件回调侧落盘）
// ============================================================================

test("g-374 F1+F6：零 token——派发链路无新增 LLM 调用/会话，除报文骨架尾注外注入文本不含任何摘要指令", async () => {
  const h = createHarness();
  const { goal } = prepare(h);
  const res = await dispatch(h, goal);

  assert.ok(res.child_id, "派发成功并绑定 child");
  assert.equal(h.capturedRequests.length, 1, "一次派发只产生一次子代理会话（无额外 LLM 调用）");
  const prompt = h.capturedRequests[0].request.prompt[0].text;
  // F6：注入文本尾部新增「交回报文骨架」尾注块（单一真源 core/ops.ts），该块**允许**提到 results.md；
  // 其余部分仍是「严禁把写总结塞进子代理 prompt」的零 token 语义 ⇒ 剥离尾注块后判定。
  const stripped = stripAttemptReportSkeleton(prompt);
  assert.equal(stripped.stripped, true, "注入文本必须含报文骨架尾注块（F6）");
  assert.doesNotMatch(stripped.text, /完成摘要|results-att|lastAssistantMessage|results\.md/,
    "剥离骨架尾注后，prompt 仍不得含任何「写总结」指令（零 token 硬判据）");

  // 事件到达不产生任何新的子代理会话
  h.emit("subagent/end", { id: "child-fixed-1", local: true, stopReason: "completed", lastAssistantMessage: [{ type: "text", text: "x" }] });
  assert.equal(h.capturedRequests.length, 1, "截获路径零新增 LLM 调用");
});

test("g-374 F1：截获与写入在事件回调侧完成——不依赖父轮次存活", async () => {
  const h = createHarness();
  const { goal, dir } = prepare(h);
  const res = await dispatch(h, goal);
  const file = join(dir, `results-${res.attempt}.md`);

  // 父轮次（派发调用）已经**完全返回**，此时尚无结果文件
  assert.equal(existsSync(file), false, "派发期不得写结果文件（写入必须挂事件回调）");

  h.emit("subagent/end", {
    id: "child-fixed-1", local: true, stopReason: "completed",
    lastAssistantMessage: [{ type: "text", text: "子代理交付正文\n第二段" }],
  });

  assert.ok(existsSync(file), "父轮次已结束，事件到达仍必须落盘");
  const raw = readFileSync(file, "utf8");
  assert.ok(raw.includes("子代理交付正文\n第二段"), "内容 = 最后一条 assistant 文本块拼接");
  assert.ok(raw.includes("source: subagent/end"));
  assert.ok(raw.includes("child_id: child-fixed-1"), "info.id 为 durable childId = attempt.md 的 child_id");
  assert.ok(raw.includes(`attempt: ${res.attempt}`));
  assert.ok(raw.includes(OVERWRITE_NOTE));

  const evs = resultsEvents(h.root, "attempt.results_written");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].details.child_id, "child-fixed-1");
  assert.equal(evs[0].details.source, "subagent/end");
  // attempt.md 的 child_id 与 info.id 逐字一致（归因 Map 的正确性前提）
  const attemptDoc = loadGoal(join(dir, "attempts", res.attempt, "attempt.md"));
  assert.equal(attemptDoc.meta.child_id, "child-fixed-1");
});

// ============================================================================
// 降级矩阵（card-fe88f5ef §5）
// ============================================================================

test("g-374 F1：事件到达但无 text 块 ⇒ 占位（no-output），不抛错", async () => {
  const h = createHarness();
  const { goal, dir } = prepare(h);
  const res = await dispatch(h, goal);
  h.emit("subagent/end", { id: "child-fixed-1", local: true, stopReason: "completed", lastAssistantMessage: [] });
  const raw = readFileSync(join(dir, `results-${res.attempt}.md`), "utf8");
  assert.ok(raw.includes("placeholder: true"));
  assert.ok(raw.includes("reason: no-output"));
  assert.equal(resultsEvents(h.root, "attempt.results_written")[0].details.reason, "no-output");
});

test("g-374 F1：字段整体缺失 + stopReason=error（在线实测的「无输出」形状）⇒ 占位 stop-error", async () => {
  const h = createHarness();
  const { goal, dir } = prepare(h);
  const res = await dispatch(h, goal);
  // 探针实测形状：stopReason=error 且 lastAssistantMessage **字段整体缺失**（非空数组）
  h.emit("subagent/end", { id: "child-fixed-1", local: true, stopReason: "error" });
  const raw = readFileSync(join(dir, `results-${res.attempt}.md`), "utf8");
  assert.ok(raw.includes("stop_reason: error"));
  assert.ok(raw.includes("placeholder: true"));
  assert.ok(raw.includes("reason: stop-error"));
});

test("g-374 F1：特性探测——payload 完全不含 g-374 载荷（无字段且无 stopReason）⇒ 静默跳过", async () => {
  const h = createHarness();
  const { goal, dir } = prepare(h);
  const res = await dispatch(h, goal);
  const file = join(dir, `results-${res.attempt}.md`);
  // 不抛错
  assert.doesNotThrow(() => h.emit("subagent/end", { id: "child-fixed-1", local: true }));
  assert.equal(existsSync(file), false, "宿主流未提供该载荷 ⇒ 不写文件");
  assert.equal(resultsEvents(h.root, "attempt.results_written").length, 0);
  assert.equal(resultsEvents(h.root, "attempt.results_skipped").length, 0, "已登记 child 不做无意义留痕");
});

test("g-374 F1/F3：Map miss（宿主重启冷恢复）⇒ 不猜归属、不写文件、不抛错，仅 stderr 留痕（不污染看板事件流）", async () => {
  const h = createHarness();
  const { goal, dir } = prepare(h);
  await dispatch(h, goal);
  const chunks: string[] = [];
  const orig = process.stderr.write;
  (process.stderr as any).write = (c: any) => { chunks.push(String(c)); return true; };
  try {
    assert.doesNotThrow(() => h.emit("subagent/end", {
      id: "child-unknown-cold-restore", local: true, stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "不属于任何已知 attempt" }],
    }));
  } finally {
    (process.stderr as any).write = orig;
  }
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("results-")), [], "Map miss 绝不写文件");
  assert.equal(resultsEvents(h.root, "attempt.results_written").length, 0);
  // g-374 F3（F1 复核注记③）：对所有非 attempt 子代理记 attempt.results_skipped ⇒ 事件流噪声无界增长
  // 且不可归因到目标。契约收敛为**纯 stderr**：诊断保留，看板事件流零写入。
  assert.equal(resultsEvents(h.root, "attempt.results_skipped").length, 0, "不得污染事件流（降级为纯 stderr）");
  assert.ok(chunks.join("").includes("child-unknown-cold-restore"), "必须留 stderr 诊断（可排查）");
  assert.ok(chunks.join("").includes("未登记"), "stderr 文案需指出归属未登记");
});

test("g-374 F1：非 continuable（local=false）事件跳过，不写文件", async () => {
  const h = createHarness();
  const { goal, dir } = prepare(h);
  await dispatch(h, goal);
  h.emit("subagent/end", { id: "child-fixed-1", local: false, stopReason: "completed", lastAssistantMessage: [{ type: "text", text: "x" }] });
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("results-")), []);
});

// ============================================================================
// 多 epoch last-wins / 截断
// ============================================================================

test("g-374 F1：多 epoch（同 childId 再次 end）⇒ last-wins 覆盖同一文件，事件累加", async () => {
  const h = createHarness();
  const { goal, dir } = prepare(h);
  const res = await dispatch(h, goal);
  const file = join(dir, `results-${res.attempt}.md`);
  h.emit("subagent/end", { id: "child-fixed-1", local: true, stopReason: "completed", lastAssistantMessage: [{ type: "text", text: "epoch-1" }] });
  h.emit("subagent/end", { id: "child-fixed-1", local: true, stopReason: "completed", lastAssistantMessage: [{ type: "text", text: "epoch-2" }] });
  const raw = readFileSync(file, "utf8");
  assert.ok(raw.includes("epoch-2") && !raw.includes("epoch-1"), "last-wins");
  assert.equal(resultsEvents(h.root, "attempt.results_written").length, 2, "每次写入都追加事件");
});

test("g-374 F1：超长输出 ⇒ 64 KiB 截断，文件头 + 事件双标注", async () => {
  const h = createHarness();
  const { goal, dir } = prepare(h);
  const res = await dispatch(h, goal);
  h.emit("subagent/end", {
    id: "child-fixed-1", local: true, stopReason: "completed",
    lastAssistantMessage: [{ type: "text", text: "字".repeat(40000) }], // 120000 字节 > 64 KiB
  });
  const raw = readFileSync(join(dir, `results-${res.attempt}.md`), "utf8");
  assert.ok(raw.includes("truncated: true"));
  assert.ok(raw.includes("已截断"));
  assert.ok(!raw.includes("\uFFFD"), "不得切坏多字节字符");
  assert.equal(resultsEvents(h.root, "attempt.results_written")[0].details.truncated, true);
});

// ============================================================================
// child_error 三类占位之一（无子代理 ⇒ 永远不会有 subagent/end）
// ============================================================================

test("g-374 F1：child_error——无可用 provider ⇒ 写 source=child_error 占位 + 事件", async () => {
  const h = createHarness({ providers: [] });
  const { goal, dir } = prepare(h);
  const res = await dispatch(h, goal);
  assert.equal(res.child_id, null);
  assert.ok(res.child_error, "返回 child_error 可操作提示");
  const file = join(dir, `results-${res.attempt}.md`);
  assert.ok(existsSync(file), "无子代理也必须写占位（禁静默跳过）");
  const raw = readFileSync(file, "utf8");
  assert.ok(raw.includes("source: child_error"));
  assert.ok(raw.includes("placeholder: true"));
  assert.equal(resultsEvents(h.root, "attempt.results_written")[0].details.source, "child_error");
});

test("g-374 F1：child_error——subagents 服务不可用（child_error 为 null 的易漏分支）同样写占位", async () => {
  const h = createHarness({ withSubagents: false });
  const { goal, dir } = prepare(h);
  const res = await dispatch(h, goal);
  assert.equal(res.child_id, null);
  // 该分支 child_error 恒为 null（历史易漏），只能靠 note 区分
  assert.equal(res.child_error, undefined, "此分支 child_error 为空（工具面省略 falsy）");
  assert.equal(res.note, "subagents 服务不可用或无调用 agent，attempt 仅本地创建");
  assert.ok(existsSync(join(dir, `results-${res.attempt}.md`)), "必须写占位");
  assert.equal(resultsEvents(h.root, "attempt.results_written")[0].details.source, "child_error");
});

// ============================================================================
// 判据 6：宿主兼容下界——旧宿主无 ctx.on ⇒ 静默降级（不写文件、不抛错、不影响既有功能）
// ============================================================================

test("g-374 F1：旧宿主无 ctx.on ⇒ 不注册、不写文件、不抛错、派发与既有功能不变", async () => {
  const h = createHarness({ withOn: false });
  const { goal, dir } = prepare(h);
  assert.equal(Object.keys(h.events).length, 0, "无 ctx.on ⇒ 不得注册任何监听");
  const res = await dispatch(h, goal);
  assert.ok(res.child_id, "派发路径不受影响");
  assert.equal(h.capturedRequests.length, 1);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("results-")), [], "旧宿主不写文件");
  assert.equal(resultsEvents(h.root, "attempt.results_written").length, 0);
  assert.equal(resultsEvents(h.root, "attempt.results_skipped").length, 0, "完全静默");
});

test("g-374 F1：事件回调对畸形 payload 健壮——绝不抛出（不得打断子代理结算）", async () => {
  const h = createHarness();
  const { goal } = prepare(h);
  await dispatch(h, goal);
  for (const bad of [undefined, null, {}, { id: 123 }, { id: "child-fixed-1" }, { id: "child-fixed-1", lastAssistantMessage: "not-array" }]) {
    assert.doesNotThrow(() => h.emit("subagent/end", bad), `畸形 payload 不得抛出：${JSON.stringify(bad)}`);
  }
});
