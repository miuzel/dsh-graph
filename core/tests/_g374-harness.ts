// g-374 共用宿主桩：注册插件、捕获子代理派发请求、捕获 `subagent/end` 处理器、直连工具与 REST 路由。
//
// 为什么共用：F5（LLM 摘要通道 / 缓存 / 降级 / 归因红线）、F6（报文骨架）、F7（输入预算）三套断言
// 必须落在**同一个**宿主行为上；各写一份桩会让「归因红线」这类跨路径断言出现口径漂移。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { init, createGoal, setCriteria, findGoalFile, loadGoal, saveGoal } from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dist/index.js";
import { ownerConnectionStub, OWNER_HEADER } from "./_http-auth-harness.ts";

export function createHarness() {
  return createHarnessWith({});
}

/**
 * g-469：同宿主桩的**可参数化**入口——用于把「派发 API 形态」当自变量。
 *
 * 宿主 `@deepseek-ai/dsh-subagent` 在 `0.2.1-alpha.2` 把 `startContinuable` 改名为
 * `startActivation`，故派发口径必须两版可测：
 *   · `legacy`（默认，= g-374 以来的既有桩行为）：只有 `startContinuable`；
 *   · `activation`：只有 `startActivation`（**且 receipt 刻意不带 `parentSessionId`**，
 *     与真实新宿主一致 ⇒ 顺带钉住 `?? null` 兜底）；
 *   · `both`：两版同时挂着（用于断言「新名优先」）；
 *   · `none`：两版皆无（用于断言 fail-closed，不得静默回退）。
 *
 * `capturedRequests` 的既有元素形状（原始 spec，`.request.prompt` / `.label` 可直接读）**逐字不变**；
 * 新增的 `capturedVia` 平行记录本次实际走的是哪个方法名。
 */
export type HarnessDispatchApi = "legacy" | "activation" | "both" | "none";

/**
 * g-613：复用空闲专家子代理所需的**宿主面桩**（全部可选；缺省 = 与 g-374 以来逐字一致的行为）。
 *
 * 为什么复用同一桩：复用路径同样要过「准入 → attempt 落盘 → 绑定 → 投递 → 归因 → 结果截获」，
 * 各写一份桩会让「谁被绑定/谁收到提示词/哪个 end 被丢弃」出现口径漂移。
 *   · `childRegistry`：`agents.get` / `agents.isOwnedBy` 的可控返回值（id → { status, ownedBy }）。
 *     未列出的 child 视为 `gone`（不存在于 live registry）。
 *   · `sendMessage`：`subagents.sendMessage` 的行为（accepted / reject / hang）。
 */
export interface ReuseChildStub {
  status?: "running" | "idle" | "unknown";
  /** 允许向其发消息的父 Agent id；缺省 = 任意（测试不关心归属时）。 */
  ownedBy?: string[];
}

export interface ReuseHarnessOptions {
  childRegistry?: Record<string, ReuseChildStub | undefined>;
  sendMessage?: (parent: any, targetId: string, content: any[]) => Promise<string>;
}

export function createHarnessWith(opts: {
  dispatchApi?: HarnessDispatchApi;
  dispatchError?: unknown;
  reuse?: ReuseHarnessOptions;
}) {
  const dispatchApi: HarnessDispatchApi = opts.dispatchApi ?? "legacy";
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g374-h-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  writeFileSync(join(ws, ".gitignore"), ".dsh-graph/\n.worktrees/\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: ws });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "init"], { cwd: ws });
  execFileSync("git", ["branch", "v1.0-test"], { cwd: ws });
  const root = join(ws, ".dsh-graph");
  init(root);
  const capturedRequests: any[] = [];
  const capturedVia: string[] = [];
  const registeredTools: any[] = [];
  const routes: any[] = [];
  const handlers = new Map<string, Array<(info: any) => void>>();
  const webServer = { register: (r: any) => { routes.push(r); return () => {}; } };
  const service: any = {
    list: () => ["spawn"],
    getProvider: (n: string) => (n === "spawn" ? { prepareContinuable: () => {} } : {}),
  };
  const record = (via: string, spec: any, receipt: any) => {
    capturedRequests.push(spec);
    capturedVia.push(via);
    return { childId: `child-${capturedRequests.length}`, ...receipt };
  };
  if (dispatchApi === "legacy" || dispatchApi === "both") {
    service.startContinuable = async (spec: any) => {
      if (opts.dispatchError) throw opts.dispatchError;
      return record("startContinuable", spec, { parentSessionId: "sess-super" });
    };
  }
  if (dispatchApi === "activation" || dispatchApi === "both") {
    service.startActivation = async (spec: any) => {
      if (opts.dispatchError) throw opts.dispatchError;
      // 真实新宿主 receipt = { childId, result, dispose }（无 parentSessionId，g-469 夹具实测）。
      return record("startActivation", spec, {});
    };
  }
  const sentMessages: Array<{ parentId: string; targetId: string; content: any[] }> = [];
  const childRegistry = opts.reuse?.childRegistry ?? null;
  if (childRegistry) {
    service.sendMessage = async (parent: any, targetId: string, content: any[]) => {
      sentMessages.push({ parentId: String(parent?.id ?? ""), targetId: String(targetId), content });
      if (opts.reuse?.sendMessage) return opts.reuse.sendMessage(parent, targetId, content);
      return `msg-${sentMessages.length}`;
    };
  }
  const ctx: any = {
    get: (name: string) => {
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "workingDirectory") return { get: () => ws };
      if (name === "agents" && childRegistry) {
        return {
          get: (id: string) => {
            const row = childRegistry[String(id)];
            return row ? { id, session: { id }, status: row.status ?? "idle" } : undefined;
          },
          isOwnedBy: (id: string, _agent: any) => {
            const row = childRegistry[String(id)];
            if (!row) return false;
            if (!row.ownedBy) return true;
            return row.ownedBy.includes(String(_agent?.id ?? ""));
          },
        };
      }
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "webServer") return webServer;
      if (name === "connection") return ownerConnectionStub(); // g-507：测试自有 owner 凭证夹具（经唯一门禁入口）
      if (name === "subagents") return service;
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (def: any) => { registeredTools.push(def); return () => {}; }, get: () => ({}) },
    on: (evt: string, fn: (info: any) => void) => {
      const list = handlers.get(evt) ?? [];
      list.push(fn);
      handlers.set(evt, list);
      return () => {};
    },
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
  /** 触发宿主事件（如 `subagent/end`）。 */
  const emit = (evt: string, info: any) => {
    for (const fn of handlers.get(evt) ?? []) fn(info);
  };
  /** 子代理派发的 label 列表（用于「谁被派发了」的精确断言）。 */
  const labels = () => capturedRequests.map((r) => r?.label ?? "");
  return {
    ws, root, toolsByName, routes, call, emit, labels, capturedRequests, capturedVia, execContext, handlers,
    /** g-613：复用路径投递到既有子代理的消息（parent/target/正文）。 */
    sentMessages,
  };
}

export function prepare(h: ReturnType<typeof createHarness>, opts: { title?: string; description?: string } = {}) {
  writeFileSync(join(h.root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const goal = createGoal(h.root, {
    title: opts.title ?? "F5 摘要", version: "v1.0", actor: "human:gui",
    ...(opts.description ? { description: opts.description } : {}),
  });
  setCriteria(h.root, goal, ["判据 1"], "human:gui");
  const goalFile = findGoalFile(h.root, goal);
  return { goal, goalFile, dir: dirname(goalFile) };
}

/** 派发一个 attempt 并返回 attempt id（同时会捕获 1 次子代理派发）。 */
export async function dispatch(h: ReturnType<typeof createHarness>, goal: string, brief = "做点事") {
  const res = await h.call("graph_start_attempt", { goal, attempt_brief: brief, task_type: "fix" });
  assert.ok(res?.attempt, "派发必须返回 attempt");
  return res.attempt as string;
}

/** 极简 REST 请求/响应桩（readBodyCapped 只用到 data/end/error 事件）。 */
export function restCall(route: any, body: any, method = "POST") {
  const req: any = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  req.method = method;
  req.url = route.path;
  req.headers = { [OWNER_HEADER]: "1" }; // g-507：经门禁入口 ⇒ 带测试自有 owner 凭证
  const res: any = {
    code: 0, payload: null,
    writeHead(code: number) { this.code = code; },
    end(text: string) { this.payload = JSON.parse(text); },
  };
  return route.handler(req, res).then(() => res);
}

/** g-613：直接构造一条「目标正在执行/已交付」的事实（不经过工具，避免把被测派发路径绕回来）。 */
export function seedGoalState(root: string, goal: string, attempt: string, childId: string, opts: { status?: string; result?: string } = {}) {
  const file = join(root, "versions", "v1.0", "goals", goal, "goal.md");
  const att = join(root, "versions", "v1.0", "goals", goal, "attempts", attempt, "attempt.md");
  const goalDoc = loadGoal(file);
  if (opts.status) goalDoc.meta.status = opts.status;
  saveGoal(file, goalDoc);
  const attDoc = loadGoal(att);
  attDoc.meta.child_id = childId;
  attDoc.meta.binding_version = (Number(attDoc.meta.binding_version) || 0) + 1;
  if (opts.result) attDoc.meta.result = opts.result;
  saveGoal(att, attDoc);
  return { file, att };
}

/** g-613：读 attempt.md 的 meta（测试断言归属/绑定版本真源）。 */
export function attemptMeta(root: string, goal: string, attempt: string): Record<string, any> {
  return loadGoal(join(root, "versions", "v1.0", "goals", goal, "attempts", attempt, "attempt.md")).meta as Record<string, any>;
}

/** g-613：读整个事件流（断言 attempt.bound / attempt.reused / attempt.reuse_failed 等）。 */
export function readAllEvents(root: string) {
  return readEvents(root);
}
