// g-374 共用宿主桩：注册插件、捕获子代理派发请求、捕获 `subagent/end` 处理器、直连工具与 REST 路由。
//
// 为什么共用：F5（LLM 摘要通道 / 缓存 / 降级 / 归因红线）、F6（报文骨架）、F7（输入预算）三套断言
// 必须落在**同一个**宿主行为上；各写一份桩会让「归因红线」这类跨路径断言出现口径漂移。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { init, createGoal, setCriteria, findGoalFile } from "../ops.ts";
import { apply } from "../../dist/index.js";

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

export function createHarnessWith(opts: { dispatchApi?: HarnessDispatchApi; dispatchError?: unknown }) {
  const dispatchApi: HarnessDispatchApi = opts.dispatchApi ?? "legacy";
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g374-h-"));
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
  const ctx: any = {
    get: (name: string) => {
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "webServer") return webServer;
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
  return { ws, root, toolsByName, routes, call, emit, labels, capturedRequests, capturedVia, execContext, handlers };
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
  req.headers = {};
  const res: any = {
    code: 0, payload: null,
    writeHead(code: number) { this.code = code; },
    end(text: string) { this.payload = JSON.parse(text); },
  };
  return route.handler(req, res).then(() => res);
}
