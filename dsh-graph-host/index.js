/**
 * dsh-graph-host：单包双半（g-116 合并）——把 dsh-graph 核心层包装为 DSH cordis 插件。
 * npm 包名 = dsh-graph（负责人定案，g-116 命名更正）；内部 host 插件 id 保留 dsh-graph-host。
 *
 * 本包同时承载原 dsh-graph-host（graph_* 工具 + skill）与 dsh-graph-client
 * （/api/dsh-graph* REST 端点）两个半边，浏览器看板（lib/client.js，经 dsh.client
 * 声明 + exports["./client"] 加载进 conversation.view 槽）同包分发。
 *
 * 约定（实机验证的坑，docs/plugin-loading-recipe.md）：
 * - 具名导出 name/inject/apply，禁止 export default；
 * - 运行时零 @deepseek-ai/* import（类型只用 import type）；
 * - 副作用收进 ctx.effect。
 */
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { relative, join } from "node:path";
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
  reportSupervisorStatus,
  readSupervisorStatus,
  readSupervisorStatusAt,
  generateHandoff,
  claimSupervisor,
  bindAttemptChild,
  moveGoal,
  amendGoal,
  requestAcceptReview,
  resolveAccept,
  boardProjection,
  readSupervisorSession,
  readExecutorModel,
  findGoalFile,
  init,
  boardPayload,
  goalDetail,
  loadGoal,
  bindCardChild,
  harvestedCards,
  formatHarvestedCardsSection,
} from "./core/ops.js";
import { resolveRoot } from "./core/root.js";

// g-112：两半共用同一 root 解析函数（re-export 供验收/测试直接核对函数同一性）
export { resolveRoot } from "./core/root.js";
// g-111 B7：boardPayload 已移入 core（消除 client→host 跨包依赖），此处 re-export 保持兼容。
// board 载荷含 supervisorSession 字段（project.yaml 的 supervisor.session，g-108），由 host 端点 /api/dsh-graph 下发。
export { boardPayload } from "./core/ops.js";

export const name = "dsh-graph-host";
// 只硬依赖 tools：webServer 由 web-app 行提供且可能在 apply 之后才激活，经 ctx.get 轮询注册
// （同 dsh-project-kanban 参考实现），保证 headless（仅工具）与 web（工具+端点+看板）两种组合都可用。
export const inject = ["tools"];

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

// g-113：普通 agent 的 dsh-graph 使用指引（精简，非主管繁文）
const USAGE = [
  "dsh-graph 是把工作组织成「目标看板」的插件。你有 graph_* 工具可用：",
  "- graph_create_goal(title[, version, scope]) 建目标（进 backlog，带 version 则排期）；",
  "- graph_set_criteria(goal, criteria[]) 先登记质量判据（判据先于执行，硬规则）；",
  "- graph_transition(goal, to[, reason]) 迁移状态；生命周期 draft→planning→collecting→ready→in_progress→review→delivered，另有 blocked（进 blocked 必须 reason）；",
  "- graph_add_card / graph_fill_card / graph_review_card 管理目标下的上下文卡片（信息收集）；",
  "- graph_start_attempt(goal) 派发执行子代理；graph_report_status(goal, attempt, status) 用一句 ≤20 字的话自报进展（看板卡片显示这句）；",
  "- graph_amend_goal(goal, note) 记录修订/人工反馈；graph_validate / graph_rebuild 校验与对账。",
  "原则：状态不是证据、产出物才是；每做一步主动迁移卡片、自报状态；不确定先问。",
].join("\n");

// g-118（负责人 2026-08-22 设计转向）：注入**简短引导提示词**（非完整守则）——
// 完整 supervisor 守则（supervisor-guide.md）不自动注入，仍走显式 skill 调用
// （dsh-graph-supervisor），避免临时会话被注入主管角色而争抢 supervisor。
// 注入内容只告知「如何」接管：claim 新 supervisor 的用法 + dsh-graph help 命令存在。
const GUIDE_HINT = [
  "dsh-graph 是把工作组织成「目标看板」的插件。本会话可用 graph_* 工具管理目标/判据/卡片/执行。",
  "【重要】本会话默认是普通会话，**不要自动接管 supervisor**（graph_claim_supervisor 只在负责人明确要求你接管时调用——自动接管会让临时会话争抢主管角色）。",
  "查看 dsh-graph 使用说明与 claim 指引：调用 graph_help。",
  "（完整 supervisor 工作守则不自动注入；如需，显式调用 skill dsh-graph-supervisor 加载。）",
].join("\n");

// g-118：dsh-graph help 命令内容源（graph_help 工具输出 + 引导提示词指向它）。
// 使用说明 + claim 指引；不含主管守则（完整守则仍在 supervisor-guide.md / skill）。
const HELP_TEXT = [
  "dsh-graph 是把工作组织成「目标看板」的插件。可用 graph_* 工具：",
  "- graph_create_goal(title[, version, scope]) 建目标（进 backlog，带 version 则排期）；",
  "- graph_set_criteria(goal, criteria[]) 先登记质量判据（判据先于执行，硬规则）；",
  "- graph_transition(goal, to[, reason]) 迁移状态；生命周期 draft→planning→collecting→ready→in_progress→review→delivered，另有 blocked（进 blocked 必须 reason）；",
  "- graph_add_card / graph_fill_card / graph_review_card 管理目标下的上下文卡片（信息收集）；",
  "- graph_bind_collect_card(goal, card, child_id) 把收集子代理绑定到卡片（g-119）；",
  "- graph_start_attempt(goal) 派发执行子代理；graph_report_status(goal, attempt, status) 用一句 ≤20 字的话自报进展；",
  "- graph_amend_goal(goal, note) 记录修订/人工反馈；graph_validate / graph_rebuild 校验与对账；",
  "- graph_report_supervisor_status(status) 主管自报状态（看板顶部状态栏）；graph_resolve_accept 评审裁决；",
  "- graph_handoff() / graph_claim_supervisor() 换会话交接（g-117）。",
  "",
  "## 接管 supervisor（换会话，g-117）",
  "**仅在负责人明确要求你接管 supervisor 时执行**——默认任何会话都不得自动 claim（避免临时会话争抢主管角色）：",
  "1. 旧会话：graph_handoff() —— 生成/更新 .dsh-graph/HANDOFF.md（board 投影 + 长期记忆 + 环境事实）；",
  "2. 新会话：graph_claim_supervisor() —— 把 project.yaml 的 supervisor.session 更新为当前会话 id，记 supervisor.claimed 事件（幂等），并返回 HANDOFF 全文。",
  "",
  "完整 supervisor 工作守则（阶段推进/信息收集/执行规范/环境事实等）见 skill dsh-graph-supervisor，显式调用加载。",
  "原则：状态不是证据、产出物才是；每做一步主动迁移卡片、自报状态；不确定先问。",
].join("\n");

// g-120：worktree 隔离指令（负责人 2026-08-22 指示）——与 supervisor-guide.md 执行规范
// 「worktree 隔离」条目保持一致。两处执行派发（graph_start_attempt 工具 + start-execution
// 端点）默认注入本段；派发方可显式关闭（工具参数 worktree=false / 端点 body.worktree=false）
// 跳过 worktree（简单/单文件小修）。数据分工：代码改动在 worktree，看板数据 .dsh-graph/
// 仍在主工作树写（graph_* 工具写的是主工作树的看板/事件流，不被 worktree 分支隔离）。
const WORKTREE_GUIDE = `【worktree 隔离（负责人 2026-08-22 指示）】并发/复杂的执行任务：先 \`git worktree add\` 一个独立工作树（与 main 隔离）再改代码，review 交付阶段由 supervisor 复核通过后合并回 main——避免并发子代理互相踩提交、半成品直接落 main。简单/单文件小修可跳过 worktree（本段由派发方开关：worktree=false 时省略）。
数据分工：代码改动在 worktree；看板数据 .dsh-graph/ 仍在主工作树写（graph_* 工具写的是主工作树的看板/事件流，不被 worktree 分支隔离，避免状态漂移）。`;

export function apply(ctx, config) {
  // g-112：统一 root 解析 = resolve(workspaceRoot, config?.root ?? ".dsh-graph")
  const root = resolveRoot(config); // 默认（init/marker 等无会话上下文时用）
  // g-113 会话 workspace 跟随：session.header.cwd 优先（工具调用所在会话），
  // 缺失时兜底 sandboxPolicy.workspaceRoot（部署级 workspace 根），再无则 process.cwd()（CLI/headless）。
  // 解析后幂等 init：工具首次触达某个 workspace 时确保其 .dsh-graph 骨架齐全（开箱即用，
  // 与 apply 期 init 同款：backlog/goals/versions/memory + events.jsonl/index.json/rules.md）。
  const sessionWorkspace = (ex) => ex?.agent?.session?.header?.cwd ?? ctx.get?.("sandboxPolicy")?.workspaceRoot ?? process.cwd();
  const rootFor = (ex) => {
    const r = resolveRoot(config, sessionWorkspace(ex));
    init(r);
    return r;
  };
  const actorOf = (exec) => `agent:${exec?.agent?.id ?? "dsh"}`;

  /** @type {Array<{def: object, run: (args: any, exec: any) => any}>} */
  const tools = [
    {
      def: {
        name: "graph_create_goal",
        description: "创建目标（默认进 backlog；带 version 则排期入版本）。返回目标 id。",
        parameters: params({ title: str, version: str, scope: strArr }, ["title"]),
      },
      run: (a, ex) => ({ goal: createGoal(rootFor(ex), { title: a.title, version: a.version, scope: a.scope, actor: actorOf(ex) }) }),
    },
    {
      def: {
        name: "graph_set_criteria",
        description: "登记目标的质量判据（判据先于执行；自动快照规则库版本）。",
        parameters: params({ goal: str, criteria: strArr }, ["goal", "criteria"]),
      },
      run: (a, ex) => { setCriteria(rootFor(ex), a.goal, a.criteria, actorOf(ex)); return { ok: true }; },
    },
    {
      def: {
        name: "graph_transition",
        description: "目标状态迁移。状态机与不变式由核心层强制；进 blocked 必须给 reason。",
        parameters: params({ goal: str, to: str, reason: str }, ["goal", "to"]),
      },
      run: (a, ex) => { transition(rootFor(ex), a.goal, a.to, { reason: a.reason, actor: actorOf(ex) }); return { ok: true }; },
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
      run: (a, ex) => ({ card: addCard(rootFor(ex), a.goal, { title: a.title, kind: a.kind, actor: actorOf(ex) }) }),
    },
    {
      def: {
        name: "graph_fill_card",
        description: "填充上下文卡片内容（text 或 content_ref），状态变为 filled。",
        parameters: params({ goal: str, card: str, text: str, content_ref: str, summary: str }, ["goal", "card"]),
      },
      run: (a, ex) => { fillCard(rootFor(ex), a.goal, a.card, { text: a.text, contentRef: a.content_ref, summary: a.summary, by: actorOf(ex), actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      def: {
        name: "graph_review_card",
        description: "复核已填充的上下文卡片（filled → reviewed）。",
        parameters: params({ goal: str, card: str }, ["goal", "card"]),
      },
      run: (a, ex) => { reviewCard(rootFor(ex), a.goal, a.card, { by: actorOf(ex), actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      // g-119：supervisor 侧把已派发的收集子代理绑定到上下文卡片（此前只有 GUI 的
      // /api/dsh-graph/start-collection 端点走 bindCardChild，主管只能写 tmp 探针脚本 hack）
      def: {
        name: "graph_bind_collect_card",
        description: "把已派发的收集子代理绑定到上下文卡片：写 child_id/parent_session_id、置 status=collecting，并记 card.collecting 事件（事件先行，R-02）。parent_session_id 缺省取当前会话 id（子代理会话文件头 parentSession 为权威来源，需不一致时显式传入）；重复绑定同一 child 幂等（不重复记事件）。",
        parameters: params({ goal: str, card: str, child_id: str, parent_session_id: str }, ["goal", "card", "child_id"]),
      },
      run: (a, ex) => {
        if (!a.goal || !a.card || !a.child_id) {
          throw new Error("graph_bind_collect_card 缺参：需要 goal/card/child_id（parent_session_id 可选）");
        }
        const parentSessionId = a.parent_session_id ?? ex?.agent?.session?.id ?? null;
        bindCardChild(rootFor(ex), a.goal, a.card, { childId: a.child_id, parentSessionId, actor: actorOf(ex) });
        return { ok: true, card: a.card, child_id: a.child_id, parent_session_id: parentSessionId };
      },
    },
    {
      // g-118：dsh-graph help 命令——输出使用说明 + supervisor 接管（claim）指引。
      // 与引导提示词（systemPrompt section GUIDE_HINT）呼应：提示词告知 help 命令存在，
      // help 给出完整工具清单与换会话步骤。不含主管守则（完整守则走 skill 显式调用）。
      def: {
        name: "graph_help",
        description: "输出 dsh-graph 使用说明与 supervisor 接管（claim）指引：graph_* 工具清单、graph_handoff/graph_claim_supervisor 换会话步骤。",
        parameters: params({}, []),
      },
      run: () => ({ help: HELP_TEXT }),
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
      run: (a, ex) => { moveGoal(rootFor(ex), a.goal, { to: a.to, version: a.version, actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      def: {
        name: "graph_amend_goal",
        description: "记录对目标的修订/补充（人工反馈的一等记录）；可选把修订内容追加进目标描述，使目标内容体现最终修订。",
        parameters: params({ goal: str, note: str, append: str }, ["goal", "note"]),
      },
      run: (a, ex) => { amendGoal(rootFor(ex), a.goal, { note: a.note, appendDescription: a.append, actor: actorOf(ex) }); return { ok: true }; },
    },
    {
      def: {
        name: "graph_validate",
        description: "全量不变式校验（状态、归属、判据、依赖环、卡片引用）。返回问题列表。",
        parameters: params({}, []),
      },
      run: (a, ex) => ({ problems: validate(rootFor(ex)) }),
    },
    {
      def: {
        name: "graph_rebuild",
        description: "从事件流重建各目标状态并与 frontmatter 对账。返回 drift 列表。",
        parameters: params({}, []),
      },
      run: (a, ex) => ({ drift: rebuild(rootFor(ex)) }),
    },
    {
      def: {
        name: "graph_report_status",
        description: "汇报当前 attempt 的一句最新工作状态（会显示在看板卡片上）。执行过程中应周期性调用。",
        parameters: params({ goal: str, attempt: str, status: str }, ["goal", "attempt", "status"]),
      },
      run: (a, ex) => { reportStatus(rootFor(ex), a.goal, a.attempt, a.status, actorOf(ex)); return { ok: true }; },
    },
    {
      def: {
        name: "graph_report_supervisor_status",
        description: "supervisor 汇报自己的一句最新工作状态（显示在看板顶部状态栏，带运行动画）。status 要简短（一句人话）。",
        parameters: params({ status: str }, ["status"]),
      },
      run: (a, ex) => { reportSupervisorStatus(rootFor(ex), a.status, actorOf(ex)); return { ok: true }; },
    },
    {
      def: {
        name: "graph_handoff",
        description: "生成/更新 .dsh-graph/HANDOFF.md 换会话交接文档（g-117）：board 投影 + 长期记忆 + 关键环境事实段自动拼接。产物不依赖会话上下文；返回交接全文。旧会话交接时调用。写盘前若旧 HANDOFF.md 存在且内容不同，先归档到 <root>/handoffs/HANDOFF-<时间戳>.md（g-121，归档目录不入 git）。",
        parameters: params({}, []),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        const content = generateHandoff(r, { write: true });
        return { ok: true, path: join(r, "HANDOFF.md"), handoff: content };
      },
    },
    {
      def: {
        name: "graph_claim_supervisor",
        description: "新会话接手时调用：把 project.yaml 的 supervisor.session 更新为当前会话 id（ex.agent.session 链），记 supervisor.claimed 事件（幂等：重复调用不重复记），返回 HANDOFF 交接全文并同时落盘 HANDOFF.md（写盘统一走归档逻辑：旧版先归档到 <root>/handoffs/，g-121）。",
        parameters: params({}, []),
      },
      run: (a, ex) => {
        const r = rootFor(ex);
        const res = claimSupervisor(r, ex?.agent?.session?.id, actorOf(ex));
        return { supervisor_session: res.supervisor_session, handoff: res.handoff };
      },
    },
    {
      def: {
        name: "graph_start_attempt",
        description: "为目标派发一个 attempt：创建 attempt 目录与记录；若 subagent 服务可用则同时启动可续轮子 agent 并绑定 childId。provider/model 指定执行子代理的模型（缺省读 project.yaml 的 executor.provider/model，再无则继承父会话）。worktree=false 时省略 spawn 提示词里的 worktree 隔离指令（简单/单文件小修可跳过，默认注入）。",
        parameters: params({ goal: str, executor: str, provider: str, model: str, worktree: { type: "boolean" } }, ["goal"]),
      },
      run: async (a, ex) => {
        const executor = a.executor ?? actorOf(ex);
        const r = rootFor(ex);
        // g-120：按 context_cards 顺序收集 filled/reviewed 卡片成果，注入清单记入 attempt.started 的
        // details.injected_cards（事件先行：必须在 startAttempt 之前算好，与 prompt 注入内容一致）
        const injectedCards = harvestedCards(r, a.goal).map((c) => c.id);
        const attempt = startAttempt(r, a.goal, { executor, actor: actorOf(ex), injectedCards });
        // 注意：返回值必须是无损 JSON——绝不写入值为 undefined 的字段（registry 会拒绝）
        const result = { attempt, child_id: null, injected_cards: injectedCards };
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
            // g-113 修正：子代理工作目录 = 父会话 workspace（startContinuable 继承 session.header.cwd），
            // 目标文件相对路径必须相对 workspace 根（如 .dsh-graph/versions/...），不是相对 .dsh-graph 目录本身
            const goalFile = findGoalFile(r, a.goal);
            const rel = goalFile ? relative(sessionWorkspace(ex), goalFile) : null;
            // g-120：已收集卡片成果段（子代理直接使用，无需猜卡片路径）+ worktree 隔离指令（可开关）
            const cardsSection = formatHarvestedCardsSection(r, a.goal);
            const worktreeBlock = a.worktree === false ? null : WORKTREE_GUIDE;
            const prompt = [
              `你是 dsh-graph 目标 ${a.goal} 的执行 attempt ${attempt}。`,
              rel ? `目标文件精确路径（工作目录相对）：${rel}——用 read 工具读它，不要自己猜路径。` : null,
              cardsSection,
              worktreeBlock,
              `【状态汇报——你自己做，supervisor 不会替你更新】看板卡片上的状态摘要（status_line）由你自行维护：`,
              `每做一个动作就及时调用 graph_report_status 更新，参数 goal="${a.goal}"、attempt="${attempt}"、status=<一句话简短描述你此刻在干什么>。`,
              `status 要简短（一句人话，尽量 20 字内，如「正在改 modal tab 样式」「跑验收脚本」），不要攒到结束才写、不要长篇。`,
              `开工、每完成一块、遇到阻塞、转向新任务、临近完成，都要立即更新；这句就是卡片上实时显示的那一行，滞留或失实等于对负责人隐瞒进展。`,
              `【泳道迁移——你自己做，卡片位置是状态的投影】看板列＝状态的投影，状态滞留＝卡片滞留，必须及时调用 graph_transition：`,
              `开工时（若当前非 in_progress）graph_transition(goal="${a.goal}", to="in_progress")；`,
              `完成后 graph_transition(goal="${a.goal}", to="review")；`,
              `遇到阻塞 graph_transition(goal="${a.goal}", to="blocked", reason=<一句话原因>)；`,
              `【禁区】绝不自行 graph_transition 到 "delivered"——delivered 是负责人/supervisor 的 human gate（review→delivered 只有 verdict 通过后由主管执行），你最多到 review 就停。`,
              `迁移要与 graph_report_status 同步进行，别只改 status_line 不动卡片；若迁移被引擎拒绝（如判据未登记、状态不允许），保留 status 汇报并继续工作，不要反复硬试。`,
              `完成后用 graph_report_status 汇报最终状态，声明完成并等待 review。`,
            ].filter(Boolean).join("\n");
            const request = { parent: ex.agent, prompt: text(prompt) };
            const agentOptions = {};
            // 模型路由：工具参数 > project.yaml executor.provider/model > 继承父会话（每次调用现读，改配置免重启）
            const cfg = readExecutorModel(rootFor(ex));
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
            bindAttemptChild(rootFor(ex), a.goal, attempt, started.childId, actorOf(ex), ex.agent?.session?.id);
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
    {
      def: {
        name: "graph_resolve_accept",
        description: "主管裁决目标的接受请求（review.requested 出现后调用）。verdict=accept 通过，verdict=object 提出异议；force=true 强制接受并记录理由。",
        parameters: params({
          goal: str,
          verdict: { type: "string", enum: ["accept", "object"] },
          objection: str,
          force: { type: "boolean" },
          reason: str,
        }, ["goal", "verdict"]),
      },
      run: (a, ex) => {
        resolveAccept(rootFor(ex), a.goal, {
          actor: actorOf(ex),
          verdict: a.verdict,
          objection: a.objection,
          force: a.force,
          reason: a.reason,
        });
        return { ok: true };
      },
    },
  ];

  // ===== client 半边：/api/dsh-graph* REST 端点（原 dsh-graph-client/index.js，g-116 并入） =====
  // g-113 会话 workspace 跟随：HTTP 请求本身不带会话，workspace 由前端显式携带
  // （query 参数 ?workspace= / ?root=，或 POST body.workspace / body.root）——
  // 前端从当前会话 session.header.cwd 派生。两个参数名等价（brief 建议 root），
  // 语义都是「workspace 根」，传入 resolveRoot 的 workspaceRoot 参数（→ <ws>/.dsh-graph）。
  // 缺失时兜底 process.cwd()（无 GUI 上下文 / 测试直调）。
  const workspaceOf = (req, body) => {
    try {
      const sp = new URL(req?.url ?? "", "http://x").searchParams;
      return sp.get("workspace") || sp.get("root") || body?.workspace || body?.root || process.cwd();
    } catch {
      return body?.workspace || body?.root || process.cwd();
    }
  };
  // 解析后幂等 init：端点首次触达某个 workspace 时确保其 .dsh-graph 骨架齐全（开箱即用，
  // 与 apply 期 init 同款；board/写端点不会因缺骨架半成品落盘）
  const rootForReq = (req, body) => {
    const r = resolveRoot(config, workspaceOf(req, body));
    init(r);
    return r;
  };
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
  const resolveSpawnParent = (rootForReq) => {
    try {
      const supervisorId = readSupervisorSession(rootForReq);
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
  const spawnChild = async (label, promptText, req, rootForReq, overrides = {}) => {
    const subagents = ctx.get?.("subagents");
    if (!subagents) return { childId: null, parentSessionId: null, error: "subagents 服务不可用" };
    const { supervisorId, parent, error } = resolveSpawnParent(rootForReq);
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
      const cfg = readExecutorModel(rootForReq);
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
  const readSpawnOptions = async (rootForReq) => {
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
    const def = readExecutorModel(rootForReq);
    return {
      modelGroups,
      default: { provider: def.provider, model: def.model },
    };
  };

  // webServer 路由定义（惰性：webServer 服务出现后才注册；headless 组合下静默跳过）
  const httpRoutes = () => [
    {
      path: "/api/dsh-graph",
      handler: (_req, res) => {
        try {
          json(res, 200, boardPayload(rootForReq(_req)));
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/goal",
      handler: (req, res) => {
        try {
          const id = new URL(req.url ?? "", "http://x").searchParams.get("id");
          if (!id) return json(res, 400, { error: "missing id" });
          json(res, 200, goalDetail(rootForReq(req), id));
        } catch (e) {
          json(res, 404, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-109 写操作端点（POST，事件先行）
    // accept：非 force → requestAcceptReview 写 review.requested；force → resolveAccept(force) 直接落地
    {
      path: "/api/dsh-graph/accept",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, force, reason } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          if (force) {
            resolveAccept(rootForReq(req, body), goal, { actor: "human:gui", verdict: "accept", force: true, reason });
            json(res, 200, { ok: true });
          } else {
            const result = requestAcceptReview(rootForReq(req, body), goal, "human:gui");
            json(res, 200, { pending: true, goal: result.goal });
          }
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-109：resolve-accept 端点（供主管工具或调试用）
    {
      path: "/api/dsh-graph/resolve-accept",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, verdict, objection, force, reason } = body;
          if (!goal || !verdict) return json(res, 400, { error: "missing goal or verdict" });
          resolveAccept(rootForReq(req, body), goal, { actor: "human:gui", verdict, objection, force, reason });
          json(res, 200, { ok: true });
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/edit-description",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, text } = body;
          if (!goal || typeof text !== "string") return json(res, 400, { error: "missing goal or text" });
          amendGoal(rootForReq(req, body), goal, { note: "直接编辑目标描述", appendDescription: text, actor: "human:gui" });
          json(res, 200, { ok: true });
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/add-card",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, title, kind } = body;
          if (!goal || !title || !kind) return json(res, 400, { error: "missing goal/title/kind" });
          const card = addCard(rootForReq(req, body), goal, { title, kind, actor: "human:gui" });
          json(res, 200, { ok: true, card });
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    },
    {
      path: "/api/dsh-graph/start-collection",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, card, prompt, provider, model } = body;
          if (!goal || !card) return json(res, 400, { error: "missing goal or card" });
          const rRoot = rootForReq(req, body);
          const attempt = startAttempt(rRoot, goal, { executor: "agent:collect", actor: "human:gui" });
          const spawned = await spawnChild(
            `graph:collect/${goal}/${card}`,
            prompt || `请收集关于「${card}」的上下文信息。`,
            req,
            rRoot,
            { provider, model },
          );
          if (spawned.error) {
            console.error("[dsh-graph-host] start-collection 子代理启动失败:", spawned.error);
          } else {
            // 事件先行：attempt.bound → card.collecting（bindCardChild 写 child_id/parent_session_id）
            bindAttemptChild(rRoot, goal, attempt, spawned.childId, "human:gui", spawned.parentSessionId);
            bindCardChild(rRoot, goal, card, { childId: spawned.childId, parentSessionId: spawned.parentSessionId, actor: "human:gui" });
          }
          json(res, 200, { ok: true, attempt, child_id: spawned.childId, child_error: spawned.error });
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-109：start-execution 端点——点击「执行」直接创建执行子代理
    {
      path: "/api/dsh-graph/start-execution",
      handler: async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = await readBody(req);
          const { goal, provider, model, worktree } = body;
          if (!goal) return json(res, 400, { error: "missing goal" });
          const rRoot = rootForReq(req, body);
          const goalFile = findGoalFile(rRoot, goal);
          const doc = loadGoal(goalFile);
          const descMatch = doc.body.match(/## 目标描述\n([\s\S]*?)(?=\n## |$)/);
          const critMatch = doc.body.match(/## 质量判据\n([\s\S]*?)(?=\n## |$)/);
          const desc = descMatch ? descMatch[1].trim() : "（无描述）";
          const crit = critMatch ? critMatch[1].trim() : "（无判据）";
          // g-120：按 context_cards 顺序收集 filled/reviewed 卡片成果——注入清单先于
          // startAttempt 算出（事件先行，记入 attempt.started 的 details.injected_cards），
          // 成果段注入 spawn prompt（子代理直接使用，无需猜卡片路径）
          const injectedCards = harvestedCards(rRoot, goal).map((c) => c.id);
          const cardsSection = formatHarvestedCardsSection(rRoot, goal);
          // worktree 隔离指令（g-120）：body.worktree=false 关闭（简单/单文件小修跳过），默认注入
          const worktreeBlock = worktree === false ? "" : WORKTREE_GUIDE;
          const attempt = startAttempt(rRoot, goal, { executor: "agent:executor", actor: "human:gui", injectedCards });
          // g-113 修正：子代理工作目录 = 会话 workspace（继承 session.header.cwd），
          // 相对路径以 workspace 根为基准（.dsh-graph/versions/...），不是服务进程 cwd 或 .dsh-graph 目录
          const rel = relative(workspaceOf(req, body), goalFile);
          const prompt = `你是 dsh-graph 目标 ${goal} 的执行 attempt ${attempt}。
目标文件精确路径（工作目录相对）：${rel}——用 read 工具读它，不要自己猜路径。

## 目标描述
${desc}

## 质量判据
${crit}

${cardsSection}

${worktreeBlock}

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
          const spawned = await spawnChild(`graph:exec/${goal}/${attempt}`, prompt, req, rRoot, { provider, model });
          if (spawned.error) {
            console.error("[dsh-graph-host] start-execution 子代理启动失败:", spawned.error);
          } else {
            bindAttemptChild(rRoot, goal, attempt, spawned.childId, "human:gui", spawned.parentSessionId);
          }
          json(res, 200, { ok: true, attempt, child_id: spawned.childId, child_error: spawned.error, model_route: spawned.model_route ?? null, injected_cards: injectedCards });
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    },
    // g-109 判据反馈：重新执行选择器用——枚举 providers + 模型分组 + project.yaml 默认
    {
      path: "/api/dsh-graph/spawn-options",
      handler: async (req, res) => {
        try {
          json(res, 200, await readSpawnOptions(rootForReq(req)));
        } catch (e) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    },
  ];

  return ctx.effect(() => {
    // g-112：幂等初始化数据骨架——发布后新用户装上自动建 backlog/goals/versions/memory +
    // events.jsonl/index.json/rules.md（不建 project.yaml、不带 demo 数据）；重复 apply 不重复建
    init(root);
    // 注册 supervisor 工作指南为运行时技能（可选服务，缺失时静默）
    const skills = ctx.get?.('skills');
    if (skills) { try { skills.register({ name: 'dsh-graph-supervisor', description: 'dsh-graph 主管 Agent 工作指南', source: 'dsh-graph-host', content: GUIDE }); } catch { /* 静默 */ } }
    // g-113：普通 agent 的 dsh-graph 使用指引（新会话开箱即用）
    if (skills) { try { skills.register({ name: 'dsh-graph', description: 'dsh-graph 目标看板：用 graph_* 工具管理目标/判据/卡片/执行', source: 'dsh-graph-host', content: USAGE }); } catch { /* 静默 */ } }

    const disposers = tools.map((t) =>
      ctx.tools.register({ ...t.def, output: objOut, execute: (args, exec) => t.run(args, exec) }),
    );

    // g-118：supervisor 守则自动注入（不依赖显式 skill 调用）——
    // g-118（负责人 2026-08-22 设计转向）：在所有会话注入**简短引导提示词**（非完整守则）。
    // systemPrompt.section 注册一个恒定渲染 GUIDE_HINT 的提示词段落：所有会话（主管/普通/
    // 执行子代理）都看到「如何 claim 新 supervisor + graph_help 命令存在」，内容轻量无害，
    // 只告知「如何」接管、不授予主管角色——完整 supervisor 守则绝不自动注入（仍走显式
    // skill dsh-graph-supervisor 调用），避免临时会话被注入主管角色而争抢 supervisor。
    // 方案 A 机制复用（调研结论）：section.text 渲染进 system prompt；此处无空文本分支，
    // 恒渲染 GUIDE_HINT（简短，token 成本 ~120 字）。
    // systemPrompt 服务可能晚激活（dsh-base bundle 行，激活时序不保证）：轮询注册。
    const sectionState = { registered: false, timer: null };
    const registerGuideSection = () => {
      if (sectionState.registered) return;
      const sp = ctx.get?.("systemPrompt");
      if (!sp) return;
      try {
        disposers.push(sp.section({
          name: "dsh-graph-guide-hint",
          order: 10,
          text: () => GUIDE_HINT,
        }));
        sectionState.registered = true;
        process.stderr.write(`[dsh-graph-host] g-118: guide hint section 已注册（所有会话注入引导提示词，root=${root}）\n`);
      } catch (e) {
        console.error("[dsh-graph-host] g-118 guide hint section 注册失败:", e?.message ?? e);
      }
    };
    registerGuideSection();
    if (!sectionState.registered) {
      let sectionTicks = 0;
      const pollSection = () => {
        if (sectionState.registered) return;
        sectionTicks++;
        registerGuideSection();
        if (sectionState.registered) return;
        if (sectionTicks >= 40) return; // 20s 上限；无 systemPrompt 的组合静默跳过（skill 目录兜底）
        sectionState.timer = setTimeout(pollSection, 500);
        sectionState.timer.unref?.();
      };
      pollSection();
    }

    // webServer 由 web-app 行提供，可能在 apply 之后才激活：轮询注册（同参考实现）。
    const routeState = { registered: false, timer: null };
    const registerHttpRoutes = () => {
      if (routeState.registered) return;
      const webServer = ctx.get?.("webServer");
      if (!webServer) return;
      try {
        for (const r of httpRoutes()) disposers.push(webServer.register(r));
        routeState.registered = true;
        process.stderr.write(`[dsh-graph-host] apply: tools + /api/dsh-graph(+goal+write) registered (root=${root})\n`);
      } catch (e) {
        console.error("[dsh-graph-host] webServer 路由注册失败:", e?.message ?? e);
      }
    };
    registerHttpRoutes();
    if (!routeState.registered) {
      // webServer 由 web-app 行提供，可能在 apply 之后才激活：轮询注册（同参考实现）。
      // 首段用 100ms 密轮询（web 启动竞态：server 就绪时路由应已注册），10 次后转 500ms 疏轮询，20 秒兜底。
      // 链式 setTimeout（setInterval 延迟创建后不可变）；unref 不阻止进程退出（测试/CLI 场景）。
      let ticks = 0;
      const poll = () => {
        if (routeState.registered) return;
        ticks++;
        registerHttpRoutes();
        if (routeState.registered) return;
        if (ticks >= 40) return; // 10×100ms + 30×500ms ≈ 16s 上限；无 webServer 组合静默跳过
        routeState.timer = setTimeout(poll, ticks >= 10 ? 500 : 100);
        routeState.timer.unref?.();
      };
      poll();
    }

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
    return () => {
      if (routeState.timer) clearTimeout(routeState.timer);
      if (sectionState.timer) clearTimeout(sectionState.timer);
      disposers.forEach((d) => d());
    };
  });
}
