// dsh-graph-client — host 半边（Node）：具名导出，禁止 export default。
// 职责：注册 GET /api/dsh-graph（看板投影 + supervisorSession，g-108）与 /api/dsh-graph/goal?id=（目标详情）。
// g-109 新增：写操作路由（accept / edit-description / add-card / start-collection），事件先行，前端不直改文件。
import { relative } from "node:path";
import {
  goalDetail,
  requestAcceptReview,
  resolveAccept,
  amendGoal,
  addCard,
  startAttempt,
  bindAttemptChild,
  bindCardChild,
  findGoalFile,
  loadGoal,
  readSupervisorSession,
  readExecutorModel,
  init,
  boardPayload,
} from "../core/ops.ts";
import { resolveRoot } from "../core/root.ts";

// g-112：两半共用同一 root 解析函数（re-export 供验收/测试直接核对函数同一性）
export { resolveRoot } from "../core/root.ts";
// g-111 B7：boardPayload 已移入 core，client 不再跨包依赖 dsh-graph-host
export { boardPayload } from "../core/ops.ts";

export const name = "dsh-graph-client";
export const inject = ["webServer"];

export function apply(ctx, config) {
  // g-112：统一 root 解析 = resolve(workspaceRoot, config?.root ?? ".dsh-graph")
  const root = resolveRoot(config);
  const json = (res, code, data) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => {
        try {
          resolve(buf ? JSON.parse(buf) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });
  // GUI 派发的子代理需要真实 parent Agent：startContinuable 内部强解引用 parent
  // （parent.options / childSessionMeta / captureDelegatedPolicyOverrides），传 null 必然失败。
  // 取 project.yaml supervisor.session 对应的 live Agent（AgentRegistry.get）；无则降级为仅本地建 attempt。
  const resolveSpawnParent = () => {
    try {
      const supervisorId = readSupervisorSession(root);
      if (!supervisorId) return { supervisorId: null, parent: null, error: "未配置 supervisor.session（project.yaml）" };
      const agents = ctx.get?.("agents");
      const parent = agents?.get?.(supervisorId) ?? null;
      if (!parent) return { supervisorId, parent: null, error: `主管会话 ${supervisorId} 无 live Agent（可能未在运行）` };
      return { supervisorId, parent, error: null };
    } catch (e) {
      return { supervisorId: null, parent: null, error: String(e?.message ?? e) };
    }
  };
  // 派发一个可续轮子代理（模型路由：overrides 优先，其次 project.yaml executor.provider/model，与 graph_start_attempt 一致）。
  // overrides: {provider?, model?} —— 由「重新执行」的 provider/model 选择器显式指定。
  // 返回 {childId, parentSessionId, error}；error 非空表示未派发成功。
  const spawnChild = async (label, promptText, req, overrides = {}) => {
    const subagents = ctx.get?.("subagents");
    if (!subagents) return { childId: null, parentSessionId: null, error: "subagents 服务不可用" };
    const { supervisorId, parent, error } = resolveSpawnParent();
    if (error) return { childId: null, parentSessionId: null, error };
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    try {
      // subagent provider（spawn/fork）与 LLM provider（模型路由）是两回事：
      // 这里自动挑选带 prepareContinuable 能力的 subagent provider，绝不把用户选的 LLM provider 当 subagent provider。
      const available = (subagents.list?.() ?? []).filter((n) => {
        try { return typeof subagents.getProvider(n)?.prepareContinuable === "function"; } catch { return false; }
      });
      const provider = available[0];
      if (!provider) {
        return { childId: null, parentSessionId: null, error: `无可用 subagent provider（需 prepareContinuable 能力，已注册：${(subagents.list?.() ?? []).join(",") || "无"}）` };
      }
      const request = { parent, prompt: [{ type: "text", text: promptText }] };
      const cfg = readExecutorModel(root);
      const agentOptions = {};
      const effProvider = overrides.provider ?? cfg.provider;
      const effModel = overrides.model ?? cfg.model;
      if (effProvider) agentOptions.provider = effProvider;
      if (effModel) agentOptions.model = effModel;
      if (Object.keys(agentOptions).length) request.agentOptions = agentOptions;
      const started = await subagents.startContinuable({ provider, label, request, signal: ac.signal });
      return { childId: started.childId, parentSessionId: supervisorId, error: null, model_route: `${effProvider ?? "继承"}/${effModel ?? "继承"}` };
    } catch (e) {
      return { childId: null, parentSessionId: null, error: String(e?.message ?? e) };
    }
  };
  // 枚举派发选项（重新执行选择器用）：LLM provider 分组模型目录（ctx.llm 注册表）+ 默认（project.yaml executor）。
  // 注意区分两个 provider 概念：subagent provider（spawn/fork，子代理创建方式，用户不可选）与
  // LLM provider（deepseek/kimi，模型路由，用户可选）。此处只暴露 LLM 目录，避免用户把 spawn/fork 当模型路由。
  const readSpawnOptions = async () => {
    let modelGroups = null;
    try {
      const llm = ctx.get?.("llm");
      if (llm?.listProviders) {
        const providers = llm.listProviders() ?? [];
        modelGroups = await Promise.all(providers.map(async (p) => {
          const pid = p.id ?? p;
          let models = [];
          try { models = (await llm.listModels?.(pid)) ?? []; } catch { models = []; }
          return { id: pid, name: p.name ?? pid, models: models.map((m) => ({ id: m.id, name: m.name ?? m.id })) };
        }));
        if (!modelGroups.length) modelGroups = null;
      }
    } catch { modelGroups = null; }
    const def = readExecutorModel(root);
    return {
      modelGroups,
      default: { provider: def.provider, model: def.model },
    };
  };
  ctx.effect(() => {
    // g-112：幂等初始化数据骨架（与 host 同款）——任一半边先加载即自动建骨架，重复 apply 不重复建
    init(root);
    const d1 = ctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-graph",
      handler: (_req, res) => {
        try {
          json(res, 200, boardPayload(root));
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    });
    const d2 = ctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-graph/goal",
      handler: (req, res) => {
        try {
          const id = new URL(req.url ?? "", "http://x").searchParams.get("id");
          if (!id) return json(res, 400, { error: "missing id" });
          json(res, 200, goalDetail(root, id));
        } catch (e) {
          json(res, 404, { error: String(e?.message ?? e) });
        }
      },
    });
    // g-109 写操作端点（POST，事件先行）
    // accept：非 force → requestAcceptReview 写 review.requested；force → resolveAccept(force) 直接落地
    const d3 = ctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-graph/accept",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, force, reason } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          if (force) {
            resolveAccept(root, goal, { actor: "human:gui", verdict: "accept", force: true, reason });
            json(res, 200, { ok: true });
          } else {
            const result = requestAcceptReview(root, goal, "human:gui");
            json(res, 200, { pending: true, goal: result.goal });
          }
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    });
    // g-109：resolve-accept 端点（供主管工具或调试用）
    const d3b = ctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-graph/resolve-accept",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, verdict, objection, force, reason } = body;
          if (!goal || !verdict) return json(res, 400, { error: "missing goal or verdict" });
          resolveAccept(root, goal, { actor: "human:gui", verdict, objection, force, reason });
          json(res, 200, { ok: true });
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    });
    const d4 = ctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-graph/edit-description",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, text } = body;
          if (!goal || typeof text !== "string") return json(res, 400, { error: "missing goal or text" });
          amendGoal(root, goal, { note: "直接编辑目标描述", appendDescription: text, actor: "human:gui" });
          json(res, 200, { ok: true });
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    });
    const d5 = ctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-graph/add-card",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, title, kind } = body;
          if (!goal || !title || !kind) return json(res, 400, { error: "missing goal/title/kind" });
          const card = addCard(root, goal, { title, kind, actor: "human:gui" });
          json(res, 200, { ok: true, card });
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    });
    const d6 = ctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-graph/start-collection",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, card, prompt, provider, model } = body;
          if (!goal || !card) return json(res, 400, { error: "missing goal or card" });
          const attempt = startAttempt(root, goal, { executor: "agent:collect", actor: "human:gui" });
          const spawned = await spawnChild(
            `graph:collect/${goal}/${card}`,
            prompt || `请收集关于「${card}」的上下文信息。`,
            req,
            { provider, model },
          );
          if (spawned.error) {
            console.error("[dsh-graph-client] start-collection 子代理启动失败:", spawned.error);
          } else {
            // 事件先行：attempt.bound → card.collecting（bindCardChild 写 child_id/parent_session_id）
            bindAttemptChild(root, goal, attempt, spawned.childId, "human:gui", spawned.parentSessionId);
            bindCardChild(root, goal, card, { childId: spawned.childId, parentSessionId: spawned.parentSessionId, actor: "human:gui" });
          }
          json(res, 200, { ok: true, attempt, child_id: spawned.childId, child_error: spawned.error });
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    });
    // g-109：start-execution 端点——点击「执行」直接创建执行子代理
    const d7 = ctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-graph/start-execution",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, provider, model } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          const goalFile = findGoalFile(root, goal);
          const doc = loadGoal(goalFile);
          const descMatch = doc.body.match(/## 目标描述\n([\s\S]*?)(?=\n## |$)/);
          const critMatch = doc.body.match(/## 质量判据\n([\s\S]*?)(?=\n## |$)/);
          const desc = descMatch ? descMatch[1].trim() : "（无描述）";
          const crit = critMatch ? critMatch[1].trim() : "（无判据）";
          const attempt = startAttempt(root, goal, { executor: "agent:executor", actor: "human:gui" });
          const rel = relative(process.cwd(), goalFile); // 精确相对路径（子代理工作目录=仓库根，与数据目录根不同）
          const prompt = `你是 dsh-graph 目标 ${goal} 的执行 attempt ${attempt}。
目标文件精确路径（工作目录相对）：${rel}——用 read 工具读它，不要自己猜路径。

## 目标描述
${desc}

## 质量判据
${crit}

【状态汇报——你自己做，supervisor 不会替你更新】看板卡片上的状态摘要（status_line）由你自行维护：
每做一个动作就及时调用 graph_report_status 更新，参数 goal="${goal}"、attempt="${attempt}"、status=<一句话简短描述你此刻在干什么>。
status 要简短（一句人话，尽量 20 字内，如「正在改 modal tab 样式」「跑验收脚本」），不要攒到结束才写、不要长篇。
开工、每完成一块、遇到阻塞、转向新任务、临近完成，都要立即更新；这句就是卡片上实时显示的那一行，滞留或失实等于对负责人隐瞒进展。

【泳道迁移——你自己做，卡片位置是状态的投影】看板列＝状态的投影，状态滞留＝卡片滞留，必须及时调用 graph_transition：
开工时（若当前非 in_progress）graph_transition(goal="${goal}", to="in_progress")；
完成后 graph_transition(goal="${goal}", to="review")；
遇到阻塞 graph_transition(goal="${goal}", to="blocked", reason=<一句话原因>)；
【禁区】绝不自行 graph_transition 到 "delivered"——delivered 是负责人/supervisor 的 human gate（review→delivered 只有 verdict 通过后由主管执行），你最多到 review 就停。
迁移要与 graph_report_status 同步进行，别只改 status_line 不动卡片；若迁移被引擎拒绝（如判据未登记、状态不允许），保留 status 汇报并继续工作，不要反复硬试。

完成后用 graph_report_status 汇报最终状态，声明完成并等待 review。`;
          const spawned = await spawnChild(`graph:exec/${goal}/${attempt}`, prompt, req, { provider, model });
          if (spawned.error) {
            console.error("[dsh-graph-client] start-execution 子代理启动失败:", spawned.error);
          } else {
            bindAttemptChild(root, goal, attempt, spawned.childId, "human:gui", spawned.parentSessionId);
          }
          json(res, 200, { ok: true, attempt, child_id: spawned.childId, child_error: spawned.error, model_route: spawned.model_route ?? null });
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    });
    // g-109 判据反馈：重新执行选择器用——枚举 providers + 模型分组 + project.yaml 默认
    const d8 = ctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-graph/spawn-options",
      handler: async (_req, res) => {
        try {
          json(res, 200, await readSpawnOptions());
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    });
    return () => {
      d1();
      d2();
      d3();
      d3b();
      d4();
      d5();
      d6();
      d7();
      d8();
    };
  });
  process.stderr.write(`[dsh-graph-client] host apply: /api/dsh-graph(+goal+write) registered (root=${root})\n`);
}
