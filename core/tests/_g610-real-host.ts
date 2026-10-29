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
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, createGoal, setCriteria, goalDetail, CRITERIA_VERIFIED_MARK } from "../ops.ts";
import { apply } from "../../dist/index.js";

export class FakeGateAdapter {
  gate: { promise: Promise<void>; resolve: () => void } | null = null;
  calls = 0;
  hold() {
    this.gate = Promise.withResolvers<void>();
    return this.gate;
  }
  release() {
    this.gate?.resolve();
    this.gate = null;
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
  };
}

export async function makeRealHost(opts: { gitRepo?: boolean } = {}) {
  const P = await loadHostPackages();
  const ws = mkdtempSync(join(tmpdir(), "g610-real-"));
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
  await P.persist.apply(ctx, P.persist.Config({ root: join(ws, ".sessions") }));
  new P.session.SessionStore(ctx);
  new P.projection.default(ctx);
  new P.systemPrompt.SystemPrompt(ctx, {});
  new P.tools.ToolRuntime(ctx, {});
  new P.fs.LocalFileSystem(ctx, P.fs.LocalFileSystem.Config({}));
  new P.wd.WorkingDirectoryService(ctx, P.wd.WorkingDirectoryService.Config({ defaultDirectory: ws }));
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
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "fake-done" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "fake-done" } };
    yield { type: "finish", reason: { kind: "stop" } };
  };
  llm.registerAdapter(["fake"], adapter);
  const subagents = new P.sub.SubagentRuntime(ctx, P.sub.SubagentRuntime.Config({ maxDepth: 3, maxActiveSubagents: 8 }));
  const loop = new P.loop.AgentLoop(ctx, { agents: [], maxParallelToolCalls: 4 });
  subagents.registerProvider({
    name: "spawn",
    capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
    inheritsParentContext: false,
    prepareContinuable: async () => ({}),
  });
  // 能力自检只要求这些工具名存在；真实 ToolRuntime 注册，测试不执行它们。
  for (const name of ["read", "write", "edit", "bash", "pwsh"]) {
    ctx.tools.register({
      name, description: name, parameters: { type: "object", properties: {} },
      output: { schema: { type: "object" }, render: () => [] },
      execute: async () => ({}),
    });
  }
  const parent = await loop.create("sess-super", { provider: "fake", model: "fake-model" }, { cwd: ws });
  writeFileSync(join(root, "project.yaml"), `supervisor:\n  session: ${parent.id}\n`, "utf8");

  const registered: any[] = [];
  const orig = ctx.tools.register.bind(ctx.tools);
  ctx.tools.register = (d: any) => { registered.push(d); return orig(d); };
  apply(ctx, { root });

  const tool = (name: string) => registered.find((t) => t.name === name);
  const exec = { agent: parent, signal: new AbortController().signal };
  const api = {
    ws, root, ctx, reg, parent, fake, subagents, registered,
    tools: { get: tool },
    dispatch: async (goal: string, brief = "real host dispatch", extra: any = {}) =>
      tool("graph_start_attempt").execute({ goal, attempt_brief: brief, worktree: false, ...extra }, exec),
    childLive: (childId: string) => {
      const a = reg.get(childId);
      if (!a) return "gone";
      return a.status === "running" ? "running" : "idle";
    },
    attempts: (goal: string) => goalDetail(root, goal).attempts,
    shutdown: async () => { try { await ctx.fiber.dispose(); } catch { /* disposed */ } },
  };
  return api;
}

export async function makeGoal(h: any, title: string, type = "task", verified = false) {
  const goal = createGoal(h.root, { title, version: "v1.0", type, actor: "human:gui" });
  setCriteria(h.root, goal, [verified ? `判据：真实宿主路径 ${CRITERIA_VERIFIED_MARK}` : "判据：真实宿主路径"], "human:gui");
  return goal;
}
