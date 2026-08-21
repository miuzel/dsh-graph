/**
 * dsh-graph-host：把 dsh-graph 核心层包装为 DSH cordis 插件。
 *
 * 约定（实机验证的坑，docs/plugin-loading-recipe.md）：
 * - 具名导出 name/inject/apply，禁止 export default；
 * - 运行时零 @deepseek-ai/* import（类型只用 import type）；
 * - 副作用收进 ctx.effect。
 */
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGoal,
  setCriteria,
  transition,
  validate,
  rebuild,
  addCard,
  fillCard,
  reviewCard,
  startAttempt,
  reportStatus,
  bindAttemptChild,
  moveGoal,
  amendGoal,
  boardProjection,
  readSupervisorSession,
  readExecutorModel,
  findGoalFile,
} from "../core/ops.ts";

export const name = "dsh-graph-host";
export const inject = ["tools"];

/** 看板端点载荷：board 投影 + supervisorSession（project.yaml 的 supervisor.session，g-108）。
 *  由 dsh-graph-client 的 host 半边（/api/dsh-graph）消费，会话 id 不在任何代码里硬编码。 */
export function boardPayload(root) {
  return { ...boardProjection(root), supervisorSession: readSupervisorSession(root) };
}

const text = (s) => [{ type: "text", text: s }];
const objOut = {
  schema: { type: "object" },
  render: (_a, v) => text(JSON.stringify(v, null, 2)),
};
const str = { type: "string" };
const strArr = { type: "array", items: { type: "string" } };

function params(properties, required) {
  return { type: "object", properties, required };
}

const GUIDE = readFileSync(new URL("./supervisor-guide.md", import.meta.url), "utf8");

export function apply(ctx, config) {
  const root = resolve(process.cwd(), config?.root ?? ".dsh-graph");
  const actorOf = (exec) => `agent:${exec?.agent?.id ?? "dsh"}`;

  /** @type {Array<{def: object, run: (args: any, exec: any) => any}>} */
  const tools = [
    {
      def: {
        name: "graph_create_goal",
        description: "创建目标（默认进 backlog；带 version 则排期入版本）。返回目标 id。",
        parameters: params({ title: str, version: str, scope: strArr }, ["title"]),
      },
      run: (a, ex) => ({ goal: createGoal(root, { title: a.title, version: a.version, scope: a.scope, actor: actorOf(ex) }) }),
    },
    {
      def: {
        name: "graph_set_criteria",
        description: "登记目标的质量判据（判据先于执行；自动快照规则库版本）。",
        parameters: params({ goal: str, criteria: strArr }, ["goal", "criteria"]),
      },
      run: (a, ex) => { setCriteria(root, a.goal, a.criteria, actorOf(ex)); return { ok: true }; },
    },
    {
      def: {
        name: "graph_transition",
        description: "目标状态迁移。状态机与不变式由核心层强制；进 blocked 必须给 reason。",
        parameters: params({ goal: str, to: str, reason: str }, ["goal", "to"]),
      },
      run: (a, ex) => { transition(root, a.goal, a.to, { reason: a.reason, actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      def: {
        name: "graph_add_card",
        description: "为目标创建上下文卡片（empty 占位）。返回卡片 id。",
        parameters: params(
          { goal: str, title: str, kind: { type: "string", enum: ["text", "file", "image", "data"] } },
          ["goal", "title", "kind"],
        ),
      },
      run: (a, ex) => ({ card: addCard(root, a.goal, { title: a.title, kind: a.kind, actor: actorOf(ex) }) }),
    },
    {
      def: {
        name: "graph_fill_card",
        description: "填充上下文卡片内容（text 或 content_ref），状态变为 filled。",
        parameters: params({ goal: str, card: str, text: str, content_ref: str, summary: str }, ["goal", "card"]),
      },
      run: (a, ex) => { fillCard(root, a.goal, a.card, { text: a.text, contentRef: a.content_ref, summary: a.summary, by: actorOf(ex), actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      def: {
        name: "graph_review_card",
        description: "复核已填充的上下文卡片（filled → reviewed）。",
        parameters: params({ goal: str, card: str }, ["goal", "card"]),
      },
      run: (a, ex) => { reviewCard(root, a.goal, a.card, { by: actorOf(ex), actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      def: {
        name: "graph_move_goal",
        description: "排期移动目标：backlog ↔ 独立 goals/ ↔ 版本。文件移动即归属变更，记 goal.moved 事件。",
        parameters: params(
          { goal: str, to: { type: "string", enum: ["backlog", "standalone", "version"] }, version: str },
          ["goal", "to"],
        ),
      },
      run: (a, ex) => { moveGoal(root, a.goal, { to: a.to, version: a.version, actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      def: {
        name: "graph_amend_goal",
        description: "记录对目标的修订/补充（人工反馈的一等记录）；可选把修订内容追加进目标描述，使目标内容体现最终修订。",
        parameters: params({ goal: str, note: str, append: str }, ["goal", "note"]),
      },
      run: (a, ex) => { amendGoal(root, a.goal, { note: a.note, appendDescription: a.append, actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      def: {
        name: "graph_validate",
        description: "全量不变式校验（状态、归属、判据、依赖环、卡片引用）。返回问题列表。",
        parameters: params({}, []),
      },
      run: () => ({ problems: validate(root) }),
    },
    {
      def: {
        name: "graph_rebuild",
        description: "从事件流重建各目标状态并与 frontmatter 对账。返回 drift 列表。",
        parameters: params({}, []),
      },
      run: () => ({ drift: rebuild(root) }),
    },
    {
      def: {
        name: "graph_report_status",
        description: "汇报当前 attempt 的一句最新工作状态（会显示在看板卡片上）。执行过程中应周期性调用。",
        parameters: params({ goal: str, attempt: str, status: str }, ["goal", "attempt", "status"]),
      },
      run: (a, ex) => { reportStatus(root, a.goal, a.attempt, a.status, actorOf(ex)); return { ok: true }; },
    },
    {
      def: {
        name: "graph_start_attempt",
        description: "为目标派发一个 attempt：创建 attempt 目录与记录；若 subagent 服务可用则同时启动可续轮子 agent 并绑定 childId。provider/model 指定执行子代理的模型（缺省读 project.yaml 的 executor.provider/model，再无则继承父会话）。",
        parameters: params({ goal: str, executor: str, provider: str, model: str }, ["goal"]),
      },
      run: async (a, ex) => {
        const executor = a.executor ?? actorOf(ex);
        const attempt = startAttempt(root, a.goal, { executor, actor: actorOf(ex) });
        // 注意：返回值必须是无损 JSON——绝不写入值为 undefined 的字段（registry 会拒绝）
        const result = { attempt, child_id: null };
        const subagents = ctx.get?.("subagents");
        if (subagents && ex?.agent) {
          try {
            // 挑选具备可续轮能力的提供方（prepareContinuable 存在即能力）
            const provider =
              subagents.list().find((n) => {
                const p = subagents.getProvider(n);
                return typeof p?.prepareContinuable === "function";
              }) ?? "spawn";
            // 模型路由：工具参数 > project.yaml executor.provider/model > 继承父会话
            const goalFile = findGoalFile(root, a.goal);
            const rel = goalFile ? relative(root, goalFile) : null;
            const prompt = [
              `你是 dsh-graph 目标 ${a.goal} 的执行 attempt ${attempt}。`,
              rel ? `目标文件精确路径（工作目录相对）：${rel}——用 read 工具读它，不要自己猜路径。` : null,
              `【状态汇报——你自己做，supervisor 不会替你更新】看板卡片上的状态摘要（status_line）由你自行维护：`,
              `每做一个动作就及时调用 graph_report_status 更新，参数 goal="${a.goal}"、attempt="${attempt}"、status=<一句话简短描述你此刻在干什么>。`,
              `status 要简短（一句人话，尽量 20 字内，如「正在改 modal tab 样式」「跑验收脚本」），不要攒到结束才写、不要长篇。`,
              `开工、每完成一块、遇到阻塞、转向新任务、临近完成，都要立即更新；这句就是卡片上实时显示的那一行，滞留或失实等于对负责人隐瞒进展。`,
              `完成后用 graph_report_status 汇报最终状态，声明完成并等待 review。`,
            ].filter(Boolean).join("\n");
            const request = { parent: ex.agent, prompt: text(prompt) };
            const agentOptions = {};
            // 模型路由：工具参数 > project.yaml executor.provider/model > 继承父会话（每次调用现读，改配置免重启）
            const cfg = readExecutorModel(root);
            const effProvider = a.provider ?? cfg.provider ?? null;
            const effModel = a.model ?? cfg.model ?? null;
            if (effProvider) agentOptions.provider = effProvider;
            if (effModel) agentOptions.model = effModel;
            if (Object.keys(agentOptions).length) request.agentOptions = agentOptions;
            const started = await subagents.startContinuable({
              provider,
              label: `graph:${a.goal}/${attempt}`,
              request,
              signal: ex.signal,
            });
            bindAttemptChild(root, a.goal, attempt, started.childId, actorOf(ex), ex.agent?.session?.id);
            result.child_id = started.childId;
            if (effProvider || effModel) result.model_route = `${effProvider ?? "继承"}/${effModel ?? "继承"}`;
          } catch (e) {
            result.note = `subagent 派发失败（attempt 已本地创建）：${e?.message ?? e}`;
          }
        } else {
          result.note = "subagents 服务不可用或无调用 agent，attempt 仅本地创建";
        }
        return result;
      },
    },
  ];

  return ctx.effect(() => {
    // 注册 supervisor 工作指南为运行时技能（可选服务，缺失时静默）
    const skills = ctx.get?.('skills');
    if (skills) { try { skills.register({ name: 'dsh-graph-supervisor', description: 'dsh-graph 主管 Agent 工作指南', source: 'dsh-graph-host', content: GUIDE }); } catch { /* 静默 */ } }

    const disposers = tools.map((t) =>
      ctx.tools.register({ ...t.def, output: objOut, execute: (args, exec) => t.run(args, exec) }),
    );
    // 加载自测（marker）：证明在 DSH 进程内 core 可用、工具已注册
    if (config?.marker) {
      const found = tools.map((t) => t.def.name).filter((n) => ctx.tools.get(n));
      let validateResult = "PASS";
      try {
        const problems = validate(root);
        if (problems.length > 0) validateResult = problems.join(" | ");
      } catch (e) {
        validateResult = `ERROR: ${e?.message ?? e}`;
      }
      writeFileSync(
        config.marker,
        JSON.stringify({ plugin: name, tools: found, validate: validateResult }, null, 2),
      );
    }
    return () => disposers.forEach((d) => d());
  });
}
