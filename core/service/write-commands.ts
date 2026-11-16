/**
 * g-632 A：本地服务的**按需写模式**（MCP 写工具）—— 「哪些写工具可达」的单一真源。
 *
 * 负责人裁决（2026-11-17）：外部宿主（Claude Code / Codex / OpenCode）经插件使用 dsh-graph 时
 * 需要**修改 graph 目录**，因此 MCP 入口必须能在**显式开启**后提供写工具。本模块落地该边界，
 * 并保持 g-623 的全部安全性质：
 *
 * ① **默认关闭**：`WRITE_MODE_COMMANDS` 只在调用方显式传入 `writeMode.enabled === true` 时被注册；
 *    未开启时工具表与 g-623 逐项一致（11 个只读工具，写工具名**根本不注册** ⇒ E_UNKNOWN_COMMAND）。
 * ② **开启是服务端动作**：唯一入口是 `dsh-graph serve --allow-write`（写进服务私有运行配置，
 *    `serve status` 可查）。请求参数（`allowWrite` / `write` / `mode` …）一律不是开启通道：
 *    既不被读取，也在认证层被判定为**保留参数**直接拒绝（见 `mcp.RESERVED_PARAM_KEYS`）。
 * ③ **Human Gate 仍然 fail-closed**：`graph_resolve_accept` 与 `graph_transition → delivered`
 *    **不在本表**（写模式下同样不注册 ⇒ E_UNKNOWN_COMMAND），给出的原因指向本地 GUI/人工裁决。
 *    同理 `graph_claim_supervisor`（主管身份）与 `graph_start_attempt`（派发子代理）也不开放。
 *    注意 `graph_abandon_attempt` **不是** Human Gate：它只标记清理陈旧 attempt、不启动执行体，
 *    开放后仍受 core `authorizeUnbind` 的角色校验约束（见该条目的注释）。
 * ④ **actor 可追溯**：所有写调用传入固定 actor `mcp:local-service`，不可能伪装 `human:*`
 *    （`RESERVED_ARG_KEYS` 同时拒绝客户端提供 actor/owner/human/approval）。
 * ⑤ **不造第二真源**：每个工具都是 core `ops.ts` 既有写函数的**薄适配**（不拼 frontmatter、
 *    不解析事件、不绕过状态机/CAS/锁/恢复），也不复制插件侧的 schema/校验。
 *
 * 覆盖口径（判据 3 / 回归保护）：g-623 名单的 27 个写工具中，除 3 个整工具 Human Gate
 * （`graph_resolve_accept` / `graph_claim_supervisor` / `graph_start_attempt`）外，
 * 其余 24 个**全部**登记在本表 —— 由 `core/tests/g632-write-mode-and-custom-root.test.ts`
 * 的 A③ 结构性断言钉住（名单口径来自 g-623 原文，任何遗漏即变红）。
 */
import {
  abandonAttempt,
  addCard,
  archiveGoal,
  deleteCard,
  deleteGoal,
  fillCard,
  moveGoal,
  addMemory,
  removeMemory,
  renameGoal,
  reportSupervisorStatus,
  setGoalBudget,
  setGoalTags,
  setGoalType,
  writeProjectConfig,
  appendGoalComment,
  setGoalDescription,
  setGoalDirective,
  setCriteria,
  updateCriteria,
  createGoal,
  storeAttachment,
  addRelation,
  removeRelation,
  transition,
  setMemoryToolsEnabled,
  isMemoryToolsEnabled,
} from "../ops.ts";
import { ServiceError, assertGoalId } from "./queries.ts";

/**
 * MCP 写模式的**固定 actor**（可追溯、不可伪装）。
 *
 * 形如 `mcp:<通道>`：既不是 `human:*`（`isHumanActor` 为 false），也不是 `agent:<session>`，
 * 因此在事件流、结果摘要与审计面都能把「MCP 写入」与「人工操作」「宿主 agent 操作」区分开。
 */
export const MCP_WRITE_ACTOR = "mcp:local-service";

/** 写模式的稳定标签（自省/审计用；不含秘密）。 */
export const WRITE_MODE_LABEL = "allow-write";

/** 写模式未开启时，写类工具的统一拒绝理由（可读、指明开启方式）。 */
export const WRITE_MODE_DISABLED_REASON =
  "写模式未开启：本服务默认只读。如需经 MCP 修改 graph 目录，请由服务端显式启动 `dsh-graph serve --allow-write`（请求参数不能开启写模式）";

/** 写模式下**仍 fail-closed** 的操作及原因（不在 `WRITE_MODE_COMMANDS` 中，因此调用一律 E_UNKNOWN_COMMAND）。 */
export const HUMAN_GATE_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  graph_resolve_accept: "人工裁决保留：接受/异议必须由人在本地 GUI 看板裁决（MCP token 只是服务访问权，不是审批权）",
  graph_claim_supervisor: "主管身份保留：接管 supervisor 只允许本地人工/宿主会话执行，MCP 写入不得冒充主管",
  graph_start_attempt: "执行派发保留：派发子代理会启动真实执行体，必须由宿主会话/主管发起，MCP 只读可达其产物",
});

/**
 * Human Gate 的**部分限制**：工具本身可达，但某些参数/目标被拒。
 * `graph_transition` 只允许非 delivered 的目标状态（delivered 必须由人在本地 GUI 裁决）。
 */
export const HUMAN_GATE_PARTIAL: Readonly<Record<string, string>> = Object.freeze({
  graph_transition: "人工裁决保留：只允许迁移到非 delivered 的状态；delivered 必须由人在本地 GUI 看板裁决",
});

/** 写模式下允许的目标状态（`delivered` 是 Human Gate，写模式不得直接到达）。 */
export const WRITE_MODE_TRANSITION_TARGETS = Object.freeze([
  "draft",
  "planning",
  "collecting",
  "ready",
  "in_progress",
  "review",
  "blocked",
] as const);

export interface WriteCommand {
  name: string;
  description: string;
  input: Record<string, "string" | "number" | "boolean" | "string[]" | "object">;
  required?: readonly string[];
  /** 该工具触及 Human Gate 时的说明（写进 tools/list description，便于客户端理解边界）。 */
  gateNote?: string;
  run: (ctx: { graphRoot: string; executionWorkspace: string }, args: Record<string, any>) => unknown;
}

function str(v: unknown, label: string): string {
  const s = String(v ?? "").trim();
  if (s === "") throw new ServiceError("E_INPUT", `参数 ${label} 不能为空`);
  return s;
}

function strList(v: unknown, label: string): string[] {
  if (!Array.isArray(v)) throw new ServiceError("E_INPUT", `参数 ${label} 必须是字符串数组`);
  const out = v.map((x) => String(x ?? "").trim()).filter((x) => x !== "");
  if (out.length === 0) throw new ServiceError("E_INPUT", `参数 ${label} 不能为空`);
  return out;
}

function obj(v: unknown, label: string): Record<string, any> {
  if (v === null || v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new ServiceError("E_INPUT", `参数 ${label} 必须是对象`);
  return v as Record<string, any>;
}

/**
 * 写模式工具表（**白名单**；只有 `writeMode.enabled === true` 时才会被注册）。
 *
 * 刻意**不包含**：`graph_resolve_accept`（人工裁决）、`graph_claim_supervisor`（主管身份）、
 * `graph_start_attempt`（派发执行体）、`graph_transition → delivered`（仅状态过滤，工具本身可用）。
 */
const WRITE_MODE_COMMAND_LIST: WriteCommand[] = [
  {
    name: "graph_create_goal",
    description: "创建目标（默认进 backlog；给 version 则排期入版本）。写入 actor 固定为 mcp:local-service。",
    input: { title: "string", version: "string", type: "string" },
    required: ["title"],
    run: (ctx, a) => ({
      goal: createGoal(ctx.graphRoot, {
        title: str(a.title, "title"),
        version: a.version === undefined ? undefined : str(a.version, "version"),
        type: a.type === undefined ? undefined : str(a.type, "type"),
        actor: MCP_WRITE_ACTOR,
      }),
    }),
  },
  {
    name: "graph_set_criteria",
    description:
      "登记并确认目标质量判据（core setCriteria：写 rules_snapshot + criteria.confirmed）。判据先于执行。",
    input: { goal: "string", criteria: "string[]" },
    required: ["goal", "criteria"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      setCriteria(ctx.graphRoot, id, strList(a.criteria, "criteria"), MCP_WRITE_ACTOR);
      return { ok: true, goal: id };
    },
  },
  {
    name: "graph_update_criteria",
    description: "编辑目标质量判据条目（core updateCriteria：只改条目，不记录 criteria.confirmed）。",
    input: { goal: "string", items: "string[]", base_items: "string[]", force: "boolean" },
    required: ["goal", "items"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      return updateCriteria(ctx.graphRoot, id, {
        items: Array.isArray(a.items) ? a.items.map((x: unknown) => String(x ?? "")) : strList(a.items, "items"),
        base_items: Array.isArray(a.base_items) ? a.base_items.map((x: unknown) => String(x ?? "")) : null,
        force: a.force === true,
        actor: MCP_WRITE_ACTOR,
      });
    },
  },
  {
    name: "graph_transition",
    description:
      "目标阶段迁移（写模式）：只接受 draft/planning/collecting/ready/in_progress/review/blocked。" +
      "delivered 是人工裁决保留项，必须由人在本地 GUI 看板完成。",
    input: { goal: "string", to: "string", reason: "string" },
    required: ["goal", "to"],
    gateNote: "delivered 不在写模式可达集合内（Human Gate）",
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      const to = str(a.to, "to");
      if (!(WRITE_MODE_TRANSITION_TARGETS as readonly string[]).includes(to)) {
        throw new ServiceError(
          "E_FORBIDDEN",
          `写模式不允许迁移到 ${to}：${HUMAN_GATE_PARTIAL.graph_transition}（可达：${WRITE_MODE_TRANSITION_TARGETS.join("/")}）`,
        );
      }
      transition(ctx.graphRoot, id, to, {
        reason: a.reason === undefined ? undefined : String(a.reason),
        actor: MCP_WRITE_ACTOR,
      });
      return { ok: true, goal: id, to };
    },
  },
  {
    name: "graph_move_goal",
    description: "排期移动目标：to=backlog|standalone|version（version 形态需给 version）；语义为文件移动即归属变更。",
    input: { goal: "string", to: "string", version: "string" },
    required: ["goal", "to"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      const to = str(a.to, "to");
      if (!["backlog", "standalone", "version"].includes(to)) {
        throw new ServiceError("E_INPUT", `参数 to 只接受 backlog/standalone/version：${to}`);
      }
      moveGoal(ctx.graphRoot, id, {
        to: to as "backlog" | "standalone" | "version",
        version: a.version === undefined ? undefined : str(a.version, "version"),
        actor: MCP_WRITE_ACTOR,
      });
      return { ok: true, goal: id, to };
    },
  },
  {
    name: "graph_add_comment",
    description: "向目标「评论」小节追加一条可追溯的历史讨论/反馈（不自动注入执行 prompt）。",
    input: { goal: "string", text: "string" },
    required: ["goal", "text"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      appendGoalComment(ctx.graphRoot, id, str(a.text, "text"), MCP_WRITE_ACTOR);
      return { ok: true, goal: id };
    },
  },
  {
    // 与 `graph_add_comment` 的差别只在工具名（插件侧 `graph_append_comment` 是同一 ops 函数的别名入口）。
    name: "graph_append_comment",
    description:
      "向目标「评论」小节追加一条可追溯的历史讨论/反馈（与 graph_add_comment 同一 core 实现，插件侧的别名入口）。" +
      "评论不自动注入执行 prompt，但执行者可通过 goal.md 查看历史。事件先行。",
    input: { goal: "string", text: "string" },
    required: ["goal", "text"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      appendGoalComment(ctx.graphRoot, id, str(a.text, "text"), MCP_WRITE_ACTOR);
      return { ok: true, goal: id };
    },
  },
  {
    name: "graph_set_directive",
    description: "设置/替换目标「最近指令」（下一次 attempt 派发时生效）。",
    input: { goal: "string", directive: "string" },
    required: ["goal", "directive"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      setGoalDirective(ctx.graphRoot, id, String(a.directive ?? ""), MCP_WRITE_ACTOR);
      return { ok: true, goal: id };
    },
  },
  {
    name: "graph_set_description",
    description: "设置/替换目标「目标描述」小节正文。",
    input: { goal: "string", description: "string" },
    required: ["goal", "description"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      setGoalDescription(ctx.graphRoot, id, String(a.description ?? ""), MCP_WRITE_ACTOR);
      return { ok: true, goal: id };
    },
  },
  {
    name: "graph_rename_goal",
    description: "重命名目标标题（记 goal.renamed 事件）。",
    input: { goal: "string", title: "string" },
    required: ["goal", "title"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      return renameGoal(ctx.graphRoot, id, { title: str(a.title, "title"), actor: MCP_WRITE_ACTOR });
    },
  },
  {
    name: "graph_set_goal_tags",
    description: "设置目标标签列表（≤20 个，每个 ≤32 字）。",
    input: { goal: "string", tags: "string[]", force: "boolean" },
    required: ["goal", "tags"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      return setGoalTags(ctx.graphRoot, id, {
        tags: Array.isArray(a.tags) ? a.tags.map((x: unknown) => String(x ?? "")) : [],
        force: a.force === true,
        actor: MCP_WRITE_ACTOR,
      });
    },
  },
  {
    name: "graph_set_goal_type",
    description: "设置目标类型（feature/bug/task/improvement/patch/chore）。",
    input: { goal: "string", type: "string" },
    required: ["goal", "type"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      return setGoalType(ctx.graphRoot, id, { type: str(a.type, "type"), actor: MCP_WRITE_ACTOR });
    },
  },
  {
    name: "graph_set_goal_budget",
    description: "设置/清空目标级预计任务预算（秒；null 清空并继承项目默认）。",
    input: { goal: "string", budget_seconds: "number" },
    required: ["goal"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      const raw = a.budget_seconds;
      const value = raw === undefined || raw === null || raw === "" ? null : Number(raw);
      if (value !== null && !Number.isInteger(value)) throw new ServiceError("E_INPUT", "参数 budget_seconds 必须是整数秒或 null");
      const r = setGoalBudget(ctx.graphRoot, id, { budget_seconds: value, actor: MCP_WRITE_ACTOR });
      return { ok: true, goal: id, budget_seconds: r.new_seconds };
    },
  },
  {
    name: "graph_report_supervisor_status",
    description: "汇报主管一句话状态（写 supervisor.status 事件；不改变主管身份）。",
    input: { status: "string" },
    required: ["status"],
    run: (ctx, a) => {
      reportSupervisorStatus(ctx.graphRoot, str(a.status, "status"), MCP_WRITE_ACTOR);
      return { ok: true };
    },
  },
  {
    name: "graph_add_card",
    description: "为目标创建上下文卡片（空占位），返回卡片 id。",
    input: { goal: "string", title: "string", scope: "string", kind: "string" },
    required: ["goal", "title"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      const scope = a.scope === undefined ? "shared" : str(a.scope, "scope");
      if (!["goal", "shared"].includes(scope)) throw new ServiceError("E_INPUT", `参数 scope 只接受 goal/shared：${scope}`);
      return addCard(ctx.graphRoot, id, {
        title: str(a.title, "title"),
        scope: scope as "goal" | "shared",
        kind: a.kind === undefined ? undefined : str(a.kind, "kind"),
        actor: MCP_WRITE_ACTOR,
      });
    },
  },
  {
    name: "graph_fill_card",
    description: "填充上下文卡片（正文 + 一句话摘要；可选 content_ref 兼容字段）。",
    input: { goal: "string", card: "string", text: "string", summary: "string", content_ref: "string" },
    required: ["goal", "card", "text"],
    run: (ctx, a) => {
      fillCard(ctx.graphRoot, assertGoalId(a.goal), str(a.card, "card"), {
        text: String(a.text ?? ""),
        summary: a.summary === undefined ? undefined : String(a.summary),
        contentRef: a.content_ref === undefined ? undefined : String(a.content_ref),
        by: MCP_WRITE_ACTOR,
        actor: MCP_WRITE_ACTOR,
      });
      return { ok: true };
    },
  },
  {
    name: "graph_delete_card",
    description: "删除目标上下文卡片（记 card.deleted 事件）。",
    input: { goal: "string", card: "string" },
    required: ["goal", "card"],
    run: (ctx, a) => {
      deleteCard(ctx.graphRoot, assertGoalId(a.goal), str(a.card, "card"), { actor: MCP_WRITE_ACTOR });
      return { ok: true };
    },
  },
  {
    name: "graph_archive_goal",
    description: "归档目标（仅 draft/planning/delivered 可归档）。",
    input: { goal: "string" },
    required: ["goal"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      archiveGoal(ctx.graphRoot, id, { actor: MCP_WRITE_ACTOR });
      return { ok: true, goal: id };
    },
  },
  {
    name: "graph_delete_goal",
    description: "删除已归档目标（含其卡片/attempts 目录）。",
    input: { goal: "string" },
    required: ["goal"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      deleteGoal(ctx.graphRoot, id, { actor: MCP_WRITE_ACTOR });
      return { ok: true, goal: id };
    },
  },
  {
    name: "graph_add_relation",
    description: "标记目标间关系：type=supersedes|amends|extends|related。",
    input: { goal: "string", type: "string", target: "string", force: "boolean" },
    required: ["goal", "type", "target"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      return addRelation(ctx.graphRoot, {
        from: id,
        type: str(a.type, "type"),
        goal: assertGoalId(a.target),
        actor: MCP_WRITE_ACTOR,
        force: a.force === true,
      });
    },
  },
  {
    name: "graph_remove_relation",
    description: "解除目标间关系标记。",
    input: { goal: "string", type: "string", target: "string", force: "boolean" },
    required: ["goal", "type", "target"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      return removeRelation(ctx.graphRoot, {
        from: id,
        type: str(a.type, "type"),
        goal: assertGoalId(a.target),
        actor: MCP_WRITE_ACTOR,
        force: a.force === true,
      });
    },
  },
  {
    name: "graph_store_attachment",
    description:
      "存储上下文附件到 <graphRoot>/attachments/（自定义根下落在同一根内），返回稳定引用名 @att/<name>。" +
      "文本用 content，二进制用 base64；穿越/绝对路径/symlink 由 core 拒绝。",
    input: { name: "string", content: "string", base64: "string" },
    required: ["name"],
    run: (ctx, a) =>
      storeAttachment(ctx.graphRoot, {
        name: str(a.name, "name"),
        content: a.content === undefined ? undefined : String(a.content),
        base64: a.base64 === undefined ? undefined : String(a.base64),
        actor: MCP_WRITE_ACTOR,
      }),
  },
  {
    name: "graph_memory_add",
    description: "新增持久事实/记忆（scope 默认 on_demand；正常上限 1000 字符）。",
    input: { kind: "string", text: "string", scope: "string", importance: "number", source_goal: "string", source_ref: "string" },
    required: ["kind", "text"],
    run: (ctx, a) => {
      const kind = str(a.kind, "kind");
      if (kind !== "project" && kind !== "user") throw new ServiceError("E_INPUT", `参数 kind 只接受 project/user：${kind}`);
      const scope = a.scope === undefined ? undefined : str(a.scope, "scope");
      if (scope !== undefined && scope !== "on_demand" && scope !== "standing") {
        throw new ServiceError("E_INPUT", `参数 scope 只接受 standing/on_demand：${scope}`);
      }
      const r = addMemory(ctx.graphRoot, {
        kind,
        text: String(a.text ?? ""),
        scope: scope as "standing" | "on_demand" | undefined,
        importance: a.importance === undefined ? undefined : Number(a.importance),
        source_goal: a.source_goal === undefined ? undefined : str(a.source_goal, "source_goal"),
        source_ref: a.source_ref === undefined ? undefined : String(a.source_ref),
        actor: MCP_WRITE_ACTOR,
      });
      return { id: r.id, deduped: r.deduped ?? false };
    },
  },
  {
    name: "graph_memory_remove",
    description: "删除记忆条目（用短唯一片段定位；仅在负责人撤回或证实过时后使用）。",
    input: { old: "string", reason: "string" },
    required: ["old"],
    run: (ctx, a) => {
      removeMemory(ctx.graphRoot, {
        old: str(a.old, "old"),
        reason: a.reason === undefined ? undefined : String(a.reason),
        actor: MCP_WRITE_ACTOR,
      });
      return { ok: true };
    },
  },
  {
    name: "graph_update_settings",
    description: "更新项目配置（部分 patch；保留未知键与注释、schema 校验、非法枚举拒绝）。",
    input: { patch: "object" },
    required: ["patch"],
    run: (ctx, a) => {
      writeProjectConfig(ctx.graphRoot, obj(a.patch, "patch"), MCP_WRITE_ACTOR);
      return { ok: true };
    },
  },
  {
    name: "graph_set_memory_tools_enabled",
    description: "切换记忆模块开关（写 project.yaml 的 modules.memory）。",
    input: { enabled: "boolean" },
    required: ["enabled"],
    run: (ctx, a) => {
      const enabled = a.enabled === true;
      setMemoryToolsEnabled(ctx.graphRoot, enabled, MCP_WRITE_ACTOR);
      return { ok: true, enabled: isMemoryToolsEnabled(ctx.graphRoot) };
    },
  },
  {
    // 语义与 `graph_start_attempt` **不同**：后者会启动真实执行体（Human Gate，不可达）；
    // 前者只是把**陈旧/失联**的 attempt 标记为已放弃（result=cancelled、detached=true）并清绑定，
    // 不启动任何进程。core `abandonAttempt` 自带授权（`authorizeUnbind`：仅目标 owner 或已配置主管），
    // 因此 MCP 的固定 actor `mcp:local-service` 只在该 actor 恰为目标创建者时通过，否则被 core 拒绝。
    name: "graph_abandon_attempt",
    description:
      "放弃陈旧/失联 attempt：标记 result=cancelled、detached=true 并清除绑定（不启动执行体，与 graph_start_attempt 无关）。" +
      "仅授权主管或目标 owner 可执行；子代理仍运行或状态不可确认时拒绝；事件先行（attempt.abandoned 含 reason/actor）。",
    input: { goal: "string", attempt: "string", reason: "string" },
    required: ["goal", "attempt", "reason"],
    run: (ctx, a) => {
      const id = assertGoalId(a.goal);
      const result = abandonAttempt(ctx.graphRoot, id, {
        attempt: str(a.attempt, "attempt"),
        reason: str(a.reason, "reason"),
        actor: MCP_WRITE_ACTOR,
      });
      return { ok: true, ...result };
    },
  },
];

/** 冻结后的写模式白名单（**唯一真源**；只在 `writeMode.enabled === true` 时被注册）。 */
export const WRITE_MODE_COMMANDS: readonly WriteCommand[] = Object.freeze(WRITE_MODE_COMMAND_LIST);

export const WRITE_MODE_COMMAND_NAMES: readonly string[] = WRITE_MODE_COMMANDS.map((c) => c.name);

/** 工具名是否属于写模式白名单（**与是否启用无关**；启用判定在调用方）。 */
export function isWriteModeCommand(name: unknown): boolean {
  return WRITE_MODE_COMMANDS.some((c) => c.name === name);
}
