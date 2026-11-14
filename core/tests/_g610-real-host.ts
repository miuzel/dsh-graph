/**
 * g-610：真实 0.2.1-rc.2 宿主栈夹具（供单活派发/系统动作测试复用）。
 *
 * 装配的是**公开包**的真实服务：Context、SessionStore、SessionProjections、SystemPrompt、
 * ToolRuntime、LocalFileSystem、WorkingDirectoryService、SessionPersistence(JSONL)、
 * AgentRegistry、LlmRuntime、AgentLoop、SubagentRuntime + spawn-in-process provider；
 * 仅 LLM adapter 为进程内 fake（可 gate 住 stream 以保持 child running），
 * 不联网、不发真实 provider、不读写真实看板/3110/其他树。
 */
import { pathToFileURL } from "node:url";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, createGoal, setCriteria, goalDetail, CRITERIA_VERIFIED_MARK } from "../ops.ts";
import { apply, startSubagentCompat } from "../../dist/index.js";
import { loadServicePlugin } from "./_http-auth-harness.ts";
import { initServiceInstances, loadHostStack } from "./_host-stack.ts";

const INIT = Symbol.for("cordis.init");

function memoryCredentials() {
  const records = new Map<string, any>();
  return {
    records,
    provider: {
      async readRecord(key: any) { return records.get(String(key)); },
      async describeRecord(key: any) { const rec = records.get(String(key)); return { present: rec !== undefined, kind: rec?.kind, writable: true }; },
      async listRecords() { return [...records.entries()].map(([key, rec]) => ({ key, kind: rec?.kind })); },
      async modifyRecord(key: any, mutate: (current: any) => Promise<any>) { const next = await mutate(records.get(String(key))); if (next !== undefined) records.set(String(key), next); return records.get(String(key)); },
      async deleteRecord(key: any) { records.delete(String(key)); },
      async unset() {},
    },
  };
}

export class FakeGateAdapter {
  gate: { promise: Promise<void>; resolve: () => void } | null = null;
  /** g-506 联合夹具：按正文 marker 定向 hold，避免把主管的关照回合也一起卡住。 */
  holds = new Map<string, Promise<void>>();
  releases: Array<() => void> = [];
  calls = 0;
  hold(marker?: string) {
    if (marker) {
      const d = Promise.withResolvers<void>();
      this.holds.set(marker, d.promise);
      this.releases.push(d.resolve);
      return d.promise;
    }
    this.gate = Promise.withResolvers<void>();
    return this.gate;
  }
  release() {
    this.gate?.resolve();
    this.gate = null;
  }
  releaseAll() {
    this.release();
    for (const resolve of this.releases.splice(0)) resolve();
    this.holds.clear();
  }
}

function resolveScope(): string {
  const env = process.env.G505_HOST_STACK_DIR || process.env.G507_HOST_STACK_DIR;
  if (env) return env;
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  for (const p of [
    join(globalRoot, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"),
    join(globalRoot, "@deepseek-ai"),
  ]) {
    try {
      if (execFileSync("test", ["-f", join(p, "dsh-llm/lib/index.js")]).length >= 0) return p;
    } catch { /* next */ }
  }
  throw new Error("g610 real-host 需要完整宿主栈（设置 G505_HOST_STACK_DIR 指向 @deepseek-ai 目录）");
}

export async function loadHostPackages() {
  const S = resolveScope();
  const load = (p: string, f = "index.js") => import(pathToFileURL(join(S, p, "lib", f)).href);
  return {
    S,
    Context: (await load("cordis")).Context,
    llm: await load("dsh-llm"),
    agent: await load("dsh-agent"),
    session: await load("dsh-session"),
    projection: await load("dsh-session-projection"),
    systemPrompt: await load("dsh-system-prompt"),
    tools: await load("dsh-tools"),
    fs: await load("dsh-fs-local"),
    wd: await load("dsh-working-directory"),
    persist: await load("dsh-session-persistence-jsonl"),
    loop: await load("dsh-agent-loop"),
    sub: await load("dsh-subagent"),
    // g-617：0.2.2 起 ToolRuntime 需要一个**已装载的工具执行器**才能跑 tool 批次；
    // 不装载则每轮 turn 立即以 TOOL_EXECUTOR_UNAVAILABLE 结束（「The selected tool executor is unavailable」）。
    toolExecutorNative: await load("dsh-tool-executor-native"),
  };
}

/**
 * @param opts.relativeRoot  g-506 联合夹具：以 `sandboxPolicy.workspaceRoot`（相对 root 解析）
 *   代替绝对 `config.root`，使同一宿主可服务多个私有 workspace（各自 `<ws>/.dsh-graph`）。
 * @param opts.sandboxWorkspace 相对 root 模式下的默认 workspace（默认即本夹具 ws）。
 * @param opts.projectYaml  覆盖启动时写入的 project.yaml（默认只写 supervisor.session）。
 * @param opts.sessionQuery  在 SubagentRuntime 之前装载真实 `sessionQuery` 服务（cold resume 需要）。
 * @param opts.workspace  复用既有 workspace（重启夹具：同一 `.dsh-graph`/goal 事件跨宿主实例）。
 * @param opts.sessionId  主管会话 id（重启夹具必须换新 id，避免持久 session 重名）。
 */
export async function makeRealHost(opts: {
  gitRepo?: boolean;
  holdPrepare?: boolean;
  http?: boolean;
  relativeRoot?: boolean;
  sandboxWorkspace?: string;
  projectYaml?: string;
  sessionQuery?: boolean;
  workspace?: string;
  sessionId?: string;
} = {}) {
  const P = await loadHostPackages();
  const wsBase = join(process.cwd(), "tmp", "g610");
  mkdirSync(wsBase, { recursive: true });
  const ws = opts.workspace ?? mkdtempSync(join(wsBase, "real-"));
  mkdirSync(ws, { recursive: true });
  if (opts.gitRepo) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    writeFileSync(join(ws, ".gitignore"), ".worktrees/\n.dsh-graph/\n.sessions/\n");
    writeFileSync(join(ws, "README"), "x");
    execFileSync("git", ["add", "."], { cwd: ws });
    execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: ws });
  }
  const root = join(ws, ".dsh-graph");
  init(root);
  const ctx = new P.Context();
  const creds = memoryCredentials();
  ctx.provide("credentials", creds.provider);
  if (opts.relativeRoot) {
    ctx.provide("sandboxPolicy", {
      workspaceRoot: opts.sandboxWorkspace ?? ws,
      overrideOf: () => null, // dsh-subagent 会读 parent.ctx.get("sandboxPolicy")?.overrideOf(...)
    });
  }
  await P.persist.apply(ctx, P.persist.Config({ root: join(ws, ".sessions") }));
  new P.session.SessionStore(ctx);
  if (opts.sessionQuery) {
    const q = await import(pathToFileURL(join(P.S, "dsh-session-query", "lib", "index.js")).href);
    new q.SessionQueryEngine(ctx);
  }
  new P.projection.default(ctx);
  new P.systemPrompt.SystemPrompt(ctx, {});
  new P.tools.ToolRuntime(ctx, {});
  // g-617：装载真实原生工具执行器（与宿主组合里的 `native-tool-executor` 同一实现，仅进程内直构）。
  (P.toolExecutorNative as any).apply(ctx);
  new P.fs.LocalFileSystem(ctx, P.fs.LocalFileSystem.Config({}));
  new P.wd.WorkingDirectoryService(ctx, P.wd.WorkingDirectoryService.Config({ defaultDirectory: ws }));
  const wd = ctx.get("workingDirectory");
  const reg = new P.agent.AgentRegistry(ctx);
  const llm = new P.llm.LlmRuntime(ctx);
  const adapter: any = new P.llm.LlmAdapter();
  const fake = new FakeGateAdapter();
  adapter.providerInfo = (p: string) => ({ id: p, name: p, protocol: "fake" });
  adapter.resolveModel = async (p: string, m: string) => ({
    provider: p, id: m, name: m, inputModalities: ["text"],
    context: { contextWindow: 128000 }, defaultMaxTokens: 1024,
  });
  adapter.stream = async function* (_options: any) {
    fake.calls += 1;
    if (fake.gate) await fake.gate.promise;
    const serialized = JSON.stringify(_options?.messages ?? "");
    for (const [marker, gate] of fake.holds) if (serialized.includes(marker)) await gate;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "fake-done" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "fake-done" } };
    yield { type: "finish", reason: { kind: "stop" } };
  };
  llm.registerAdapter(["fake"], adapter);
  const subagents = new P.sub.SubagentRuntime(ctx, P.sub.SubagentRuntime.Config({ maxDepth: 3, maxActiveSubagents: 8 }));
  const loop = new P.loop.AgentLoop(ctx, { agents: [], maxParallelToolCalls: 4 });
  // g-617：驱动直构服务的 `[Service.init]`（视为依次 `ctx.plugin()`）。
  // 顺序 = 依赖顺序：WorkingDirectoryService 注册 workingDirectory 投影（子代理启动时 ensure() 要读）
  // → AgentRegistry 注册 turnBoundary 投影 → AgentLoop 注册其投影并 setFactory
  // → SubagentRuntime 注册 catalog/timing/identity 三个投影。
  await initServiceInstances([wd, reg, llm, loop, subagents]);
  const prepareGate = opts.holdPrepare ? Promise.withResolvers<void>() : null;
  subagents.registerProvider({
    name: "spawn",
    capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
    inheritsParentContext: false,
    prepareContinuable: async () => {
      if (prepareGate) await prepareGate.promise;
      return {};
    },
  });
  // 能力自检只要求这些工具名存在；真实 ToolRuntime 注册，测试不执行它们。
  for (const name of ["read", "write", "edit", "bash", "pwsh"]) {
    ctx.tools.register({
      name, description: name, parameters: { type: "object", properties: {} },
      output: { schema: { type: "object" }, render: () => [] },
      execute: async () => ({}),
    });
  }
  const parent = await loop.create(opts.sessionId ?? "sess-super", { provider: "fake", model: "fake-model" }, { cwd: ws });
  writeFileSync(join(root, "project.yaml"), opts.projectYaml ?? `supervisor:\n  session: ${parent.id}\n`, "utf8");

  let webState: any = null;
  let webFiber: any = null;
  let connFiber: any = null;
  if (opts.http) {
    const { WebServer, connectionApi } = await loadHostStack();
    const loaded = await loadServicePlugin(ctx, "g610-test-webserver", (c: any) => {
      const server = new WebServer(c, { host: "127.0.0.1", port: 0 });
      c.effect(() => server[INIT](), "g610: webServer.listen");
      return server;
    });
    webState = loaded.service; webFiber = loaded.fiber;
    for (let i = 0; i < 400 && !webState?.server?.listening; i++) await new Promise((r) => setTimeout(r, 5));
    connFiber = ctx.plugin({ name: connectionApi.name, inject: connectionApi.inject, apply: connectionApi.apply, Config: connectionApi.Config }, {});
    await connFiber;
  }

  const registered: any[] = [];
  const orig = ctx.tools.register.bind(ctx.tools);
  ctx.tools.register = (d: any) => { registered.push(d); return orig(d); };
  apply(ctx, opts.relativeRoot ? {} : { root });

  const tool = (name: string) => registered.find((t) => t.name === name);
  const exec = { agent: parent, signal: new AbortController().signal };
  const origin = () => webState?.getOrigin?.() ?? "";
  const request = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
    new Promise<{ status: number; body: any }>((resolve) => {
      const url = new URL(origin());
      const payload = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
      const req = http.request({ host: url.hostname, port: Number(url.port), path, method, headers: {
        host: new URL(origin()).host,
        ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
        ...headers,
      } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: any = text;
          try { parsed = text.length ? JSON.parse(text) : null; } catch { /* raw */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.on("error", (e) => resolve({ status: 0, body: String(e) }));
      if (payload) req.write(payload);
      req.end();
    });
  const mintOwnerCookie = () => {
    const connection = ctx.get("connection");
    assert(connection, "真实 connection 必须已引导");
    const url = connection.authenticatedUrl(`${origin()}/`);
    const token = new URL(url).searchParams.get("token");
    let status = 0; let setCookie: string | undefined;
    connection.authorizeIndex({ method: "GET", url: `/?token=${encodeURIComponent(token)}`, headers: { host: new URL(origin()).host } }, {
      writeHead(code: number, headers: any) { status = code; setCookie = headers?.["set-cookie"]; },
      end() {},
    });
    if (![302, 303].includes(status) || !setCookie) throw new Error("真实 token 交换失败");
    return setCookie.split(";")[0];
  };
  const api = {
    ws, root, ctx, reg, parent, fake, subagents, registered, modules: P, llm,
    releasePrepare: () => prepareGate?.resolve(),
    http: { origin, request, mintOwnerCookie },
    tools: { get: tool },
    dispatch: async (goal: string, brief = "real host dispatch", extra: any = {}) =>
      tool("graph_start_attempt").execute({ goal, attempt_brief: brief, worktree: false, ...extra }, exec),
    // g-626：rc.3 的 `startActivation` spec 是**扁平** `{ provider, parent, prompt }`
    // （rc.1 的 `request: { parent, prompt }` 分组已不再被接受：`spec.parent` 会是 undefined）。
    // 统一走产品同源的 compat helper，夹具不另立一套派发形态。
    startChild: async (label = "fixture") => startSubagentCompat(subagents, {
      provider: "spawn",
      label,
      parent,
      prompt: [{ type: "text", text: "fixture child" }],
      signal: new AbortController().signal,
    }),
    childLive: (childId: string) => {
      const a = reg.get(childId);
      if (!a) return "gone";
      return a.status === "running" ? "running" : "idle";
    },
    attempts: (goal: string) => goalDetail(root, goal).attempts,
    shutdown: async () => {
      try { await connFiber?.dispose?.(); } catch { /* disposed */ }
      try { if (webState?.server?.listening) await new Promise<void>((resolve) => { webState.server.close(() => resolve()); webState.server.closeAllConnections?.(); setTimeout(resolve, 1000).unref?.(); }); } catch { /* closed */ }
      try { await webFiber?.dispose?.(); } catch { /* disposed */ }
      try { await ctx.fiber.dispose(); } catch { /* disposed */ }
    },
  };
  return api;
}

export async function makeGoal(h: any, title: string, type = "task", verified = false) {
  const goal = createGoal(h.root, { title, version: "v1.0", type, actor: "human:gui" });
  setCriteria(h.root, goal, [verified ? `判据：真实宿主路径 ${CRITERIA_VERIFIED_MARK}` : "判据：真实宿主路径"], "human:gui");
  return goal;
}
