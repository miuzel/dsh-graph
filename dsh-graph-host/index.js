/**
 * dsh-graph-host：把 dsh-graph 核心层包装为 DSH cordis 插件。
 *
 * 约定（实机验证的坑，docs/plugin-loading-recipe.md）：
 * - 具名导出 name/inject/apply，禁止 export default；
 * - 运行时零 @deepseek-ai/* import（类型只用 import type）；
 * - 副作用收进 ctx.effect。
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
} from "../core/ops.ts";

export const name = "dsh-graph-host";
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
        parameters: params({ goal: str, card: str, text: str, content_ref: str }, ["goal", "card"]),
      },
      run: (a, ex) => { fillCard(root, a.goal, a.card, { text: a.text, contentRef: a.content_ref, by: actorOf(ex), actor: actorOf(ex) }); return { ok: true }; },
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
        description: "为目标派发一个 attempt：创建 attempt 目录与记录；若 subagent 服务可用则同时启动可续轮子 agent 并绑定 childId。",
        parameters: params({ goal: str, executor: str }, ["goal"]),
      },
      run: async (a, ex) => {
        const executor = a.executor ?? actorOf(ex);
        const attempt = startAttempt(root, a.goal, { executor, actor: actorOf(ex) });
        const result = { attempt, child_id: null, note: undefined };
        const subagents = ctx.get?.("subagents");
        if (subagents && ex?.agent) {
          try {
            const prompt = [
              `你是 dsh-graph 目标 ${a.goal} 的执行 attempt ${attempt}。`,
              `工作区 .dsh-graph 下有该目标的 goal.md（描述、质量判据、上下文卡片）。`,
              `执行过程中周期性调用 graph_report_status 汇报一句最新状态；完成后声明完成并等待 review。`,
            ].join("\n");
            const started = await subagents.startContinuable({
              parent: ex.agent,
              label: `graph:${a.goal}/${attempt}`,
              prompt: text(prompt),
            });
            bindAttemptChild(root, a.goal, attempt, started.childId, actorOf(ex));
            result.child_id = started.childId;
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
