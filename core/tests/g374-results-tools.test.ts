import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { dirname, join } from "node:path";
import {
  init,
  createGoal,
  setCriteria,
  appendGoalComment,
  findGoalFile,
  goalResults,
  goalResultsSummaryFile,
  writeAttemptResults,
  stripAttemptReportSkeleton,
  MODULE_TOOL_NAMES,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dist/index.js";

// g-374 F3/F4：两个**新工具**（单目标 + 批量）与 REST 端点的行为契约，外加 F3-b
// 「仅注册不告知视为未完成」的**提示面源契约**（discipline / guide-hint / usage / help / tool description）。
//
// 判据 5、6 对应：
//  - F4 人工写入：source=manual + 写入者标注、与自动截获同格式/同路径/同归档策略、零 LLM；
//  - 批量：多目标一次调用，逐目标报告写入/跳过/失败原因，单目标失败不中断整批；
//  - F3-b：工具必须被 agent「知道存在」（四处提示面 + 工具描述共同指路）。

const repoRoot = join(import.meta.dirname, "../..");
const promptPath = (name: string) => join(repoRoot, "prompts", name);

function createHarness() {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g374-tools-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const capturedRequests: any[] = [];
  const registeredTools: any[] = [];
  const routes: any[] = [];
  const webServer = { register: (r: any) => { routes.push(r); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "webServer") return webServer;
      if (name === "subagents") {
        return {
          list: () => ["spawn"],
          getProvider: (n: string) => (n === "spawn" ? { prepareContinuable: () => {} } : {}),
          startContinuable: async (opts: any) => {
            capturedRequests.push(opts);
            return { childId: "child-fixed-1", parentSessionId: "sess-super" };
          },
        };
      }
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (def: any) => { registeredTools.push(def); return () => {}; }, get: () => ({}) },
    on: () => () => {},
  };
  apply(ctx, { root });
  const toolsByName = new Map(registeredTools.map((t: any) => [t.name, t]));
  const execContext = {
    agent: { id: "a1", session: { header: { cwd: ws }, id: "sess-exec" } },
    signal: new AbortController().signal,
  };
  const call = (name: string, args: any) => {
    const tool = toolsByName.get(name);
    assert.ok(tool, `工具未注册：${name}`);
    return tool.execute(args, execContext);
  };
  return { ws, root, toolsByName, routes, call, capturedRequests, execContext };
}

function prepare(h: ReturnType<typeof createHarness>) {
  writeFileSync(join(h.root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const goal = createGoal(h.root, { title: "F3 工具面", version: "v1.0", actor: "human:gui" });
  setCriteria(h.root, goal, ["判据 1"], "human:gui");
  const goalFile = findGoalFile(h.root, goal);
  return { goal, goalFile, dir: dirname(goalFile) };
}

/** 用图工具派发一个 attempt，返回 attempt id。 */
async function dispatch(h: ReturnType<typeof createHarness>, goal: string) {
  const res = await h.call("graph_start_attempt", { goal, attempt_brief: "做点事", task_type: "fix" });
  assert.ok(res?.attempt, "派发必须返回 attempt");
  return res.attempt as string;
}

/** 极简 REST 请求/响应桩（readBodyCapped 只用到 data/end/error 事件）。 */
function restCall(route: any, body: any, method = "POST") {
  const req: any = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  req.method = method;
  req.url = route.path;
  req.headers = {};
  const res: any = {
    code: 0, payload: null,
    writeHead(code: number) { this.code = code; },
    end(text: string) { this.payload = JSON.parse(text); },
  };
  return { req, res };
}

// ============================================================================
// F3-b：两个工具确实注册（名字 + 参数面钉住，防后续漂移）
// ============================================================================

test("g-374 F3/F4：graph_write_results / graph_refresh_results 已注册，参数面与必填项精确", () => {
  const h = createHarness();
  const write = h.toolsByName.get("graph_write_results");
  const refresh = h.toolsByName.get("graph_refresh_results");
  assert.ok(write && refresh, "两个新工具必须注册");
  assert.deepEqual(Object.keys(write.parameters.properties), ["goal", "attempt", "text", "source", "actor"]);
  assert.deepEqual(write.parameters.required, ["goal", "attempt", "text"]);
  // F5 参数面：content/source（成品正文通道）+ llm/force（按需 LLM 摘要 + 强制重写）
  assert.deepEqual(Object.keys(refresh.parameters.properties), ["goal", "goals", "content", "source", "llm", "force", "actor"]);
  assert.deepEqual(refresh.parameters.required, [], "单目标/批量二选一 ⇒ 均非必填（运行时校验）");
  assert.equal(refresh.parameters.properties.llm.type, "boolean", "llm 必须是布尔开关（默认不调 LLM）");
  assert.equal(refresh.parameters.properties.force.type, "boolean", "force 必须是布尔开关（默认吃缓存）");
  assert.equal(write.parameters.additionalProperties, false, "参数白名单（g-190 P0 约定）");
  assert.equal(refresh.parameters.additionalProperties, false);
  // 工具描述必须指路（F3-b：仅注册不告知视为未完成）
  for (const [tool, needles] of [
    [write, ["manual", "零 LLM"]],
    [refresh, ["零 LLM", "归档", "summarizer", "llm:true", "deterministic"]],
  ] as const) {
    for (const n of needles) assert.ok(String(tool.description).includes(n), `${tool.name} 描述应包含「${n}」`);
  }
});

// ============================================================================
// F4：人工写入（source=manual + 写入者标注、同格式同路径、零 LLM）
// ============================================================================

test("g-374 F4：graph_write_results 写 source=manual + 写入者标注，同路径同格式，零 LLM 调用", async () => {
  const h = createHarness();
  const { goal, dir } = prepare(h);
  const attempt = await dispatch(h, goal);
  const before = h.capturedRequests.length;

  const res = h.call("graph_write_results", { goal, attempt, text: "主管自做的一两行改动：修了文档错字。" });
  assert.equal(res.ok, true);
  assert.equal(res.written, true);
  assert.equal(res.file, join(dir, `results-${attempt}.md`), "路径与自动截获同一约定");
  assert.equal(h.capturedRequests.length, before, "零 LLM：不得派发任何子代理/会话");

  const raw = readFileSync(res.file, "utf8");
  assert.match(raw, /^<!-- dsh-graph:results:begin -->/);
  assert.ok(raw.includes("source: manual"), "默认 source=manual");
  assert.ok(raw.includes("actor: agent:a1"), "写入者标注（agentOf(exec)）");
  assert.ok(raw.includes("人工写入"), "文件内可见「人工写入」标注");
  assert.ok(raw.includes("主管自做的一两行改动"), "正文落盘");
  assert.ok(raw.includes(`attempt: ${attempt}`));

  // 事件留痕：source/writer 可审计
  const ev = readEvents(h.root).filter((e) => e.event === "attempt.results_written").pop()!;
  assert.equal(ev.details.source, "manual");
  assert.equal(ev.details.writer, "agent:a1");
  assert.equal(ev.details.attempt, attempt);

  // 与自动截获同一投影/同一读取器：结果文件能被 goalResults 正常解析
  const view = goalResults(h.root, goal).attempts.find((a) => a.attempt === attempt)!;
  assert.equal(view.source, "manual");
  assert.equal(view.actor, "agent:a1");
  assert.equal(view.placeholder, false);
  assert.equal(view.degraded, null);
  assert.ok(view.body.includes("主管自做的一两行改动"));
});

test("g-374 F4：显式 source/actor 覆盖 + 重复写入 last-wins + 非法输入不制造孤儿文件", async () => {
  const h = createHarness();
  const { goal, dir } = prepare(h);
  const attempt = await dispatch(h, goal);

  h.call("graph_write_results", { goal, attempt, text: "第一版", actor: "human:gui", source: "manual" });
  const raw1 = readFileSync(join(dir, `results-${attempt}.md`), "utf8");
  assert.ok(raw1.includes("actor: human:gui"));
  h.call("graph_write_results", { goal, attempt, text: "第二版", actor: "human:gui" });
  const raw2 = readFileSync(join(dir, `results-${attempt}.md`), "utf8");
  assert.ok(raw2.includes("第二版") && !raw2.includes("第一版"), "同一 attempt last-wins（显式契约，非静默 no-op）");
  assert.equal(readdirSync(dir).filter((n) => n.startsWith("results-")).length, 1, "同一 attempt 只有一份文件");

  // 非法输入：空文本 / attempt 不存在 / 暂存目标 ⇒ 明确抛错（工具错误对 agent 可见）
  assert.throws(() => h.call("graph_write_results", { goal, attempt, text: "   " }), /text 不能为空/);
  assert.throws(() => h.call("graph_write_results", { goal, attempt: "att-999", text: "x" }), /attempt 不存在/);
  assert.throws(() => h.call("graph_write_results", { goal, attempt: "../escape", text: "x" }), /attempt 不存在/);
  assert.equal(existsSync(join(dir, "results-att-999.md")), false, "不得制造孤儿结果文件");
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("results-")), [`results-${attempt}.md`]);
});

test("g-374 F4：人造输出与自动截获的输出**同格式同读取器**（字段面逐一相等）", async () => {
  const h = createHarness();
  const { goal, dir } = prepare(h);
  const manualAttempt = await dispatch(h, goal);
  h.call("graph_write_results", { goal, attempt: manualAttempt, text: "人工摘要" });
  // 同一目标再写一份「自动截获形状」的文件作对照（source=subagent/end）
  writeAttemptResults(h.root, {
    goal, attempt: "att-002", source: "subagent/end", childId: "c9", stopReason: "completed", text: "自动输出",
  });
  const proj = goalResults(h.root, goal);
  const manual = proj.attempts.find((a) => a.attempt === manualAttempt)!;
  const auto = proj.attempts.find((a) => a.attempt === "att-002")!;
  // 字段面（同格式的证据）：同一批键，非空判定一致
  assert.deepEqual(Object.keys(manual).sort(), Object.keys(auto).sort(), "两种来源的投影键集必须一致");
  for (const k of ["attempt", "source", "generated_at", "bytes", "truncated", "placeholder", "degraded", "file"] as const) {
    assert.notEqual(manual[k], undefined, `人工结果必须提供 ${k}`);
    assert.notEqual(auto[k], undefined, `自动结果必须提供 ${k}`);
  }
  assert.equal(manual.placeholder, auto.placeholder);
  assert.equal(manual.truncated, auto.truncated);
  assert.equal(manual.stop_reason, null);
  assert.equal(auto.stop_reason, "completed");
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("results-")).length, 2);
});

// ============================================================================
// F2/F4：graph_refresh_results —— 单目标、归档、零 LLM
// ============================================================================

test("g-374 F2/F4：graph_refresh_results 单目标写入 results.md（旧版归档）+ 零 LLM 调用", async () => {
  const h = createHarness();
  const { goal, goalFile } = prepare(h);
  const attempt = await dispatch(h, goal);
  h.call("graph_write_results", { goal, attempt, text: "交付内容" });
  appendGoalComment(h.root, goal, "补一条决策。", "human:gui");
  const before = h.capturedRequests.length;

  const first = h.call("graph_refresh_results", { goal });
  assert.equal(first.total, 1);
  assert.equal(first.written, 1);
  assert.equal(first.failed, 0);
  assert.equal(first.items[0].status, "written");
  assert.equal(first.items[0].archive, null, "首版无旧版");
  assert.equal(first.items[0].file, goalResultsSummaryFile(goalFile));
  assert.ok(existsSync(first.items[0].file));
  // g-504：评论正文不再倾倒进正文，但「目标历史被读取到」仍须可证 —— 以单行计数为可见信号。
  assert.ok(readFileSync(first.items[0].file, "utf8").includes("评论 1 条"), "正文反映目标历史（评论计数）");
  assert.ok(!readFileSync(first.items[0].file, "utf8").includes("补一条决策。"), "g-504：评论正文不得被倾倒（反回归）");
  assert.equal(h.capturedRequests.length, before, "零 LLM：刷新摘要不得派发子代理");

  const second = h.call("graph_refresh_results", { goal });
  assert.equal(second.items[0].status, "written");
  assert.match(String(second.items[0].archive), /results-archive-\d{8}T\d{6}(-\d+)?\.md$/, "旧版归档名");
  assert.equal(second.items[0].generated_at.length > 0, true);
  assert.equal(second.items[0].source_hash.length, 40, "sha1 指纹（40 hex）");
  assert.equal(h.capturedRequests.length, before, "反复刷新同样零 LLM");

  // 空态：来源为空的目标 ⇒ skipped（不写空文件），并在批量结果里如实报告
  const emptyGoal = createGoal(h.root, { title: "空目标", version: "v1.0", actor: "human:gui" });
  setCriteria(h.root, emptyGoal, ["判据 1"], "human:gui");
  const skip = h.call("graph_refresh_results", { goal: emptyGoal });
  assert.equal(skip.items[0].status, "skipped");
  assert.equal(skip.items[0].reason, "no-source");
  assert.equal(skip.failed, 0, "业务跳过不算失败");
  assert.equal(existsSync(goalResultsSummaryFile(findGoalFile(h.root, emptyGoal))), false);
});

// ============================================================================
// F4 批量：逐目标报告、单目标失败不中断整批
// ============================================================================

test("g-374 F4：批量 goals[] 逐目标报告写入/跳过/失败，单目标失败不中断整批", async () => {
  const h = createHarness();
  const { goal } = prepare(h);
  const attempt = await dispatch(h, goal);
  h.call("graph_write_results", { goal, attempt, text: "交付内容" });
  appendGoalComment(h.root, goal, "批量用例。", "human:gui");
  // 第二个目标：来源为空 ⇒ 跳过
  const emptyGoal = createGoal(h.root, { title: "空目标 2", version: "v1.0", actor: "human:gui" });
  setCriteria(h.root, emptyGoal, ["判据 1"], "human:gui");
  // 第三个：不存在 ⇒ 失败
  const before = h.capturedRequests.length;

  const res = h.call("graph_refresh_results", { goals: [goal, emptyGoal, "g-missing", goal] });
  assert.equal(res.total, 3, "去重后 3 个目标（重复 goal 只算一次）");
  assert.equal(res.written, 1);
  assert.equal(res.skipped, 1);
  assert.equal(res.failed, 1);
  assert.equal(res.ok, false, "有失败项 ⇒ 整批 ok=false（但成功的已落盘）");
  const byGoal = new Map(res.items.map((i: any) => [i.goal, i]));
  assert.equal((byGoal.get(goal) as any).status, "written", "失败项不得阻断其它目标");
  assert.equal((byGoal.get(emptyGoal) as any).status, "skipped");
  assert.equal((byGoal.get("g-missing") as any).status, "failed");
  assert.match((byGoal.get("g-missing") as any).reason, /^error:/, "失败必须带可读原因");
  assert.ok(existsSync((byGoal.get(goal) as any).file), "成功目标的结果文件确实存在");
  assert.equal(h.capturedRequests.length, before, "批量同样零 LLM");

  // 无参 ⇒ 明确抛错（而不是静默 no-op）
  assert.throws(() => h.call("graph_refresh_results", {}), /需要 goal/);
  assert.throws(() => h.call("graph_refresh_results", { goals: [] }), /需要 goal/);
});

// ============================================================================
// F3-a/F2：REST 端点（GUI「更新摘要」按钮走的就是它）
// ============================================================================

test("g-374 F2/F3-a：POST /api/dsh-graph/refresh-results 与工具共用同一实现（GET/缺参各有明确响应）", async () => {
  const h = createHarness();
  const { goal, goalFile } = prepare(h);
  const attempt = await dispatch(h, goal);
  h.call("graph_write_results", { goal, attempt, text: "交付内容" });
  appendGoalComment(h.root, goal, "REST 用例。", "human:gui");

  const route = h.routes.find((r: any) => r.path === "/api/dsh-graph/refresh-results");
  assert.ok(route, "REST 路由必须注册（GUI 按钮依赖它，无需 CLI/会话指令）");

  // ① 正常 POST：写盘 + 返回文件与来源信息
  const ok = restCall(route, { workspace: h.ws, goal });
  await route.handler(ok.req, ok.res);
  assert.equal(ok.res.code, 200);
  assert.equal(ok.res.payload.ok, true);
  assert.equal(ok.res.payload.written, true);
  assert.equal(ok.res.payload.file, goalResultsSummaryFile(goalFile));
  assert.equal(ok.res.payload.goal, goal);
  assert.ok(readFileSync(goalResultsSummaryFile(goalFile), "utf8").includes("评论 1 条"), "REST 落盘正文反映目标历史");

  // ② 再次 POST：归档旧版（按钮上能看到归档文件名）
  const again = restCall(route, { workspace: h.ws, goal });
  await route.handler(again.req, again.res);
  assert.equal(again.res.code, 200);
  assert.match(String(again.res.payload.archive), /results-archive-\d{8}T\d{6}/, "第二次点击必须归档旧版");

  // ③ 空态：HTTP 200 + ok:false + reason（不是 HTTP 错误；前端按 reason 显示）
  const emptyGoal = createGoal(h.root, { title: "REST 空目标", version: "v1.0", actor: "human:gui" });
  setCriteria(h.root, emptyGoal, ["判据 1"], "human:gui");
  const skip = restCall(route, { workspace: h.ws, goal: emptyGoal });
  await route.handler(skip.req, skip.res);
  assert.equal(skip.res.code, 200);
  assert.equal(skip.res.payload.ok, false);
  assert.equal(skip.res.payload.reason, "no-source");

  // ④ 参数/方法校验
  const missing = restCall(route, { workspace: h.ws });
  await route.handler(missing.req, missing.res);
  assert.equal(missing.res.code, 400);
  assert.match(String(missing.res.payload.error), /missing goal/);
  const wrongMethod = restCall(route, { workspace: h.ws, goal }, "GET");
  await route.handler(wrongMethod.req, wrongMethod.res);
  assert.equal(wrongMethod.res.code, 405);
});

// ============================================================================
// F3-b：提示面源契约（「仅注册不告知视为未完成」）
// ============================================================================

test("g-374 F3-b：四个提示面 + 文档镜像都告知两个新工具，且点明「无子代理时主管必须自己写」", () => {
  // g-495 改判：help.zh/en 不再逐条列工具（改判为功能模块清单 + 当前开关状态），
  // 故这两个面从「必须含工具名 + 场景」改判为「必须声明承载该能力的**模块**归属」
  // （memory 模块，见 MODULE_TOOL_NAMES）；工具级告知由其余**四个**承载面 + schema 注入承担。
  const faces = [
    ["discipline.zh.md", promptPath("discipline.zh.md"), "无子代理"],
    ["discipline.en.md", promptPath("discipline.en.md"), "no subagent"],
    ["guide-hint.zh.md", promptPath("guide-hint.zh.md"), "主管自做无子代理"],
    ["guide-hint.en.md", promptPath("guide-hint.en.md"), "no subagent"],
    ["usage.zh.md", promptPath("usage.zh.md"), "无子代理"],
    ["usage.en.md", promptPath("usage.en.md"), "subagent-less"],
  ] as const;
  for (const [label, path, scenarioNeedle] of faces) {
    const text = readFileSync(path, "utf8");
    assert.ok(text.includes("graph_write_results"), `${label} 必须告知 graph_write_results`);
    assert.ok(text.includes("graph_refresh_results"), `${label} 必须告知 graph_refresh_results`);
    // 场景必须与工具名**同一行**（否则只是清单里的名字，agent 不知道何时用）
    const line = text.split("\n").find((l) => l.includes("graph_write_results") || l.includes("graph_refresh_results"))!;
    assert.ok(line.includes(scenarioNeedle), `${label} 的工具说明行必须点明场景「${scenarioNeedle}」：${line.slice(0, 80)}`);
  }
  // help 面（agent 侧）改判：这两个结果工具**不属于任何可裁剪模块**（常驻工具，见
  // MODULE_TOOL_NAMES 中不存在它们）⇒ agent 面必须声明「模块只管被裁剪的工具组」这一前提，
  // 否则 agent 会误以为没在表里就等于不可用。
  for (const label of ["help.zh.md", "help.en.md"] as const) {
    const text = readFileSync(promptPath(label), "utf8");
    assert.match(text, /\{memory\}/, `${label} 必须声明模块行（模块表是 agent 面的开关视图）`);
    // 负向对照（内存变异）：模块占位被改坏时判据必红。
    assert.doesNotMatch(text.replace("{memory}", "{memry}"), /\{memory\}/, `${label} 模块占位改坏时判据必须变红`);
    // 必须点明「关闭的模块其工具不暴露」——即表外的常驻工具不受模块影响。
    assert.match(text, /不暴露|not exposed/, `${label} 必须点明关闭模块的工具不暴露（否则表外工具被误读为不可用）`);
  }
  // 真源核对：两个结果工具**确实**不在任何模块的工具集里（常驻）。
  const allModuleTools = new Set(Object.values(MODULE_TOOL_NAMES).flat());
  for (const n of ["graph_write_results", "graph_refresh_results"]) {
    assert.ok(!allModuleTools.has(n), `${n} 不应归属任何可裁剪模块（它是常驻工具，不受模块开关影响）`);
  }
  // discipline 的 zh/en 必须**逐条对称**（行数一致 + 两个工具都出现）
  const zh = readFileSync(promptPath("discipline.zh.md"), "utf8").split("\n").filter((l) => l.trim());
  const en = readFileSync(promptPath("discipline.en.md"), "utf8").split("\n").filter((l) => l.trim());
  assert.equal(zh.length, en.length, "discipline zh/en 必须逐条对称");
  // g-496 改判（负责人批准）：docs 不再持正文副本 ⇒ 原「镜像逐条一致」**反转**为「不得含副本」；
  // 告知义务**前移到真源**（下方对 discipline.zh 本身的断言，与上面 [discipline.zh.md, "无子代理"] 同源）。
  // 独立验证者 BLOCK 记录：去镜像最初只覆盖 discipline，**漏了同文的 guide-hint 副本** ⇒ 此处两份都查。
  const mirror = readFileSync(join(repoRoot, "docs", "guide-auto-injection.md"), "utf8");
  assert.doesNotMatch(mirror, /SUPERVISOR_DISCIPLINE/, "docs 不得再含 SUPERVISOR_DISCIPLINE 副本（g-496 去镜像）");
  assert.doesNotMatch(mirror, /\bGUIDE_HINT\b/, "docs 不得再含 GUIDE_HINT 副本（g-496 去镜像，同文另一处）");
  const zhText = readFileSync(promptPath("discipline.zh.md"), "utf8");
  for (const need of ["graph_write_results", "graph_refresh_results"]) {
    assert.ok(zhText.includes(need), `纪律真源必须包含 ${need}（承载面已从 docs 副本前移到真源）`);
  }
  assert.ok(zhText.includes("无子代理"), "纪律真源必须点明「无子代理」场景（原 docs 副本的同一条语义）");
  // 引导真源同样必须承载结果面告知（原 docs GUIDE_HINT 副本里就有这两条；副本删了，义务前移）。
  const guideText = readFileSync(promptPath("guide-hint.zh.md"), "utf8");
  for (const need of ["graph_write_results", "graph_refresh_results"]) {
    assert.ok(guideText.includes(need), `引导真源必须包含 ${need}（原 docs GUIDE_HINT 副本的同一条语义）`);
  }
  assert.ok(guideText.includes("不要自动接管 supervisor"), "引导真源必须点明「不要自动接管 supervisor」（claim 限制）");
  // 主管守则（skill 资产，主管显式加载后的主要依据）也必须指路
  for (const [label, path, scenarioNeedle] of [
    ["supervisor-guide.zh.md", join(repoRoot, "prompts", "supervisor-guide.zh.md"), "无子代理"],
    ["supervisor-guide.en.md", join(repoRoot, "prompts", "supervisor-guide.en.md"), "subagent-less"],
  ] as const) {
    const text = readFileSync(path, "utf8");
    assert.ok(text.includes("graph_write_results"), `${label} 必须告知 graph_write_results`);
    assert.ok(text.includes("graph_refresh_results"), `${label} 必须告知 graph_refresh_results`);
    assert.ok(text.includes(scenarioNeedle), `${label} 必须点明场景「${scenarioNeedle}」`);
  }
});

test("g-374 F3-b：server-i18n 工具描述 zh/en 对称、含工具名与「主动使用」措辞，且 en 零 CJK", () => {
  const source = readFileSync(join(repoRoot, "dsh-graph-host", "lib", "server-i18n.js"), "utf8");
  for (const key of ["tool.graph_write_results", "tool.graph_refresh_results"]) {
    assert.ok(source.includes(`"${key}":`), `server-i18n 缺 ${key}`);
  }
  // zh/en 两个字典的键集必须对称（与 assertServerI18nParity 同源；此处为静态可读断言）
  const zhKeys = [...source.matchAll(/^\s{2}"(tool\.[a-z0-9_]+)":/gm)].map((m) => m[1]);
  const counts = new Map<string, number>();
  for (const k of zhKeys) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const [k, c] of counts) assert.equal(c, 2, `${k} 必须在 zh/en 各出现一次（实际 ${c}）`);
  // 工具名与「务必主动使用」类措辞必须落在描述里（描述 = agent 唯一可见的工具说明）
  const zhLine = source.split("\n").find((l) => l.includes('"tool.graph_write_results":'))!;
  assert.ok(zhLine.includes("务必主动使用") || zhLine.includes("务必"), "zh 描述必须含主动使用指令");
  assert.ok(zhLine.includes("<goalDir>/results-att-<attempt>.md"), "zh 描述必须给出落盘路径");
  // 取最后一次出现 = en 字典（zh 在前、en 在后）
  const enLine = source.split("\n").filter((l) => l.includes('"tool.graph_refresh_results":')).pop()!;
  assert.doesNotMatch(enLine, /[\u3400-\u9fff]/, "en 描述不得含 CJK");
  assert.ok(enLine.includes("zero LLM"), "en 描述必须声明零 LLM");
});

test("g-374 零 token 自证：新增的提示面不得进入 graph_start_attempt 的注入文本", async () => {
  const h = createHarness();
  const { goal } = prepare(h);
  await dispatch(h, goal);
  const prompt = h.capturedRequests[0]?.request?.prompt?.[0]?.text ?? "";
  assert.ok(prompt.length > 0, "必须捕获到派发 prompt（零 token 对照的锚点）");
  // 新工具的存在只在「告知 agent」的提示面出现；派发给执行子代理的注入文本必须逐字不变 ⇒
  // 本目标不增加任何派发期 token（对照 cf7c66d 的字节同一性由交付证据给出）。
  //
  // F6 判据调整：注入文本尾部现在**必定**带「交回报文骨架」尾注块（单一真源 core/ops.ts），
  // 该块允许提到 results.md；因此零 token 断言改为「**剥离骨架尾注块后**逐字不变/不含新提示面」。
  const stripped = stripAttemptReportSkeleton(prompt);
  assert.equal(stripped.stripped, true, "注入文本必须含报文骨架尾注块（F6）");
  assert.ok(!stripped.text.includes("graph_write_results"), "剥离骨架后派发注入文本不得混入新工具（零 token 增量）");
  assert.ok(!stripped.text.includes("graph_refresh_results"), "剥离骨架后派发注入文本不得混入新工具（零 token 增量）");
  assert.ok(!stripped.text.includes("完成摘要"), "剥离骨架后派发注入文本不得混入结果面文案");
  assert.ok(!stripped.text.includes("summarizer"), "summarizer 角色提示面不得进入普通派发注入文本");
});
