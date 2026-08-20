/** 核心操作：init / createGoal / setCriteria / transition / validate / rebuild。 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseDoc,
  serializeDoc,
  replaceSection,
  criteriaPresent,
  type GoalDoc,
} from "./model.ts";
import { appendEvent, readEvents, replayStatuses } from "./events.ts";
import { GraphError, STATUSES, assertTransition } from "./machine.ts";

export { GraphError };

/** 扫描图根下全部目标文件：backlog/*.md、goals/<id>/goal.md、versions/<v>/goals/<id>/goal.md。 */
export function listGoalFiles(root: string): string[] {
  const out: string[] = [];
  const backlog = join(root, "backlog");
  if (existsSync(backlog)) {
    for (const f of readdirSync(backlog)) {
      if (f.endsWith(".md")) out.push(join(backlog, f));
    }
  }
  const goals = join(root, "goals");
  if (existsSync(goals)) {
    for (const d of readdirSync(goals)) {
      const p = join(goals, d, "goal.md");
      if (existsSync(p)) out.push(p);
    }
  }
  const versions = join(root, "versions");
  if (existsSync(versions)) {
    for (const v of readdirSync(versions)) {
      const gdir = join(versions, v, "goals");
      if (!existsSync(gdir)) continue;
      for (const d of readdirSync(gdir)) {
        const p = join(gdir, d, "goal.md");
        if (existsSync(p)) out.push(p);
      }
    }
  }
  return out.sort();
}

export function loadGoal(file: string): GoalDoc {
  return parseDoc(readFileSync(file, "utf8"));
}

export function saveGoal(file: string, doc: GoalDoc): void {
  writeFileSync(file, serializeDoc(doc), "utf8");
}

export function findGoalFile(root: string, id: string): string {
  for (const f of listGoalFiles(root)) {
    try {
      if (loadGoal(f).meta.id === id) return f;
    } catch {
      // 解析失败的文件由 validate 报告，这里跳过
    }
  }
  throw new GraphError(`目标不存在：${id}`);
}

/** 初始化图根目录骨架。 */
export function init(root: string): void {
  for (const d of ["backlog", "goals", "versions", "memory/long-term"]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  const events = join(root, "events.jsonl");
  if (!existsSync(events)) writeFileSync(events, "", "utf8");
  const index = join(root, "index.json");
  if (!existsSync(index)) writeFileSync(index, "{}\n", "utf8");
  const rules = join(root, "rules.md");
  if (!existsSync(rules)) {
    writeFileSync(
      rules,
      '---\n{\n  "version": "r-init"\n}\n---\n\n（暂无规则）\n',
      "utf8",
    );
  }
  appendEvent(root, { actor: "core", event: "project.initialized", details: { root } });
}

/** 读取规则库版本；frontmatter 允许 JSON 或简单 `version: x` 行。 */
export function readRulesVersion(root: string): string | null {
  const file = join(root, "rules.md");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  try {
    const meta = parseDoc(text).meta;
    if (typeof meta.version === "string") return meta.version;
  } catch {
    // 非 JSON frontmatter：退化为行扫描
  }
  const m = text.match(/^version:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

const GOAL_BODY = `
## 目标描述

（待填写）

## 收集计划

- [ ] （待规划）

## 质量判据

（待登记；进入 in_progress 前必须非空且已确认）

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
`;

export function createGoal(
  root: string,
  opts: { title: string; version?: string; scope?: string[]; actor: string },
): string {
  const id = "g-" + randomUUID().slice(0, 8);
  const meta: Record<string, any> = {
    id,
    title: opts.title,
    status: "draft",
    blocked_reason: null,
    created_at: new Date().toISOString(),
    created_by: opts.actor,
    version: opts.version ?? null,
    scope: opts.scope ?? [],
    depends_on: [],
    review: { reviewer: "human", prompt: null },
    pk: { lanes: 1, sandbox: "directory" },
    rules_snapshot: null,
    skill_refs: [],
  };
  let file: string;
  if (opts.version) {
    file = join(root, "versions", opts.version, "goals", id, "goal.md");
    mkdirSync(join(root, "versions", opts.version, "goals", id), {
      recursive: true,
    });
  } else {
    file = join(root, "backlog", `${id}.md`);
    mkdirSync(join(root, "backlog"), { recursive: true });
  }
  saveGoal(file, { meta, body: GOAL_BODY });
  appendEvent(root, {
    actor: opts.actor,
    event: "goal.created",
    goal: id,
    details: { title: opts.title, version: opts.version ?? null },
  });
  return id;
}

/** 登记判据（覆盖质量判据小节），快照规则库版本，并记录 criteria.confirmed 事件。 */
export function setCriteria(
  root: string,
  id: string,
  criteria: string[],
  actor: string,
): void {
  if (criteria.length === 0) throw new GraphError("判据列表不能为空");
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  const content =
    "\n" + criteria.map((c, i) => `${i + 1}. ${c}`).join("\n") + "\n";
  try {
    doc.body = replaceSection(doc.body, "质量判据", content);
  } catch {
    // 小节不存在（如 backlog 草稿模板缺标准小节）：追加到正文末尾
    doc.body = doc.body.replace(/\n*$/, "") + "\n\n## 质量判据\n" + content;
  }
  if (!doc.meta.rules_snapshot) {
    doc.meta.rules_snapshot = readRulesVersion(root);
  }
  saveGoal(file, doc);
  appendEvent(root, {
    actor,
    event: "criteria.confirmed",
    goal: id,
    details: {
      criteria_count: criteria.length,
      rules_snapshot: doc.meta.rules_snapshot,
    },
  });
}

/** 状态迁移：状态机校验 → 写回 frontmatter（保留正文）→ 追加事件。 */
export function transition(
  root: string,
  id: string,
  to: string,
  opts: { reason?: string; actor: string },
): void {
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  const events = readEvents(root);
  const criteriaConfirmed = events.some(
    (e) => e.goal === id && e.event === "criteria.confirmed",
  );
  const from = doc.meta.status as string;
  assertTransition(doc.meta, to, {
    body: doc.body,
    criteriaConfirmed,
    reason: opts.reason,
  });
  if (to === "blocked") {
    doc.meta.blocked_from = from;
    doc.meta.blocked_reason = opts.reason!;
  }
  if (from === "blocked") {
    doc.meta.blocked_from = null;
    doc.meta.blocked_reason = null;
  }
  doc.meta.status = to;
  saveGoal(file, doc);
  appendEvent(root, {
    actor: opts.actor,
    event: "goal.transition",
    goal: id,
    details: { from, to, ...(opts.reason ? { reason: opts.reason } : {}) },
  });
}

/** 位置/归属一致性：backlog 与 goals/ 下 version 必须为 null；版本内必须等于目录名。 */function locationProblems(root: string, file: string, meta: Record<string, any>): string[] {
  const problems: string[] = [];
  const rel = file.slice(root.length + 1);
  const parts = rel.split("/");
  const version = meta.version ?? null;
  if (parts[0] === "versions") {
    const dirVersion = parts[1];
    if (version !== dirVersion) {
      problems.push(`${meta.id}: version 字段(${version}) 与目录(${dirVersion})不一致`);
    }
  } else if ((parts[0] === "backlog" || parts[0] === "goals") && version !== null) {
    problems.push(`${meta.id}: 位于 ${parts[0]}/ 但 version=${version}`);
  }
  return problems;
}

/** 依赖环检测：对所有目标的 depends_on 做 DFS。 */
function cycleProblems(docs: Map<string, GoalDoc>): string[] {
  const problems: string[] = [];
  const deps = new Map<string, string[]>();
  for (const [id, doc] of docs) {
    const list = Array.isArray(doc.meta.depends_on) ? doc.meta.depends_on : [];
    deps.set(
      id,
      list.map((d: any) => String(d?.goal ?? d)),
    );
  }
  const state = new Map<string, number>(); // 0=未访问 1=在栈 2=完成
  const stack: string[] = [];
  const visit = (id: string): void => {
    state.set(id, 1);
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      if (!deps.has(dep)) continue; // 悬空依赖由 validate 另行报告
      const s = state.get(dep) ?? 0;
      if (s === 1) {
        const cycle = [...stack.slice(stack.indexOf(dep)), dep].join(" → ");
        problems.push(`依赖环：${cycle}`);
      } else if (s === 0) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of deps.keys()) {
    if ((state.get(id) ?? 0) === 0) visit(id);
  }
  return problems;
}

/** 全量不变式校验；返回问题列表（空 = 通过）。 */
export function validate(root: string): string[] {
  const problems: string[] = [];
  const docs = new Map<string, GoalDoc>();
  for (const file of listGoalFiles(root)) {
    let doc: GoalDoc;
    try {
      doc = loadGoal(file);
    } catch (e) {
      problems.push(`${file}: ${(e as Error).message}`);
      continue;
    }
    const meta = doc.meta;
    const id = String(meta.id ?? basename(file));
    if (docs.has(id)) {
      problems.push(`${id}: ID 重复`);
      continue;
    }
    docs.set(id, doc);
    if (!STATUSES.includes(meta.status)) {
      problems.push(`${id}: 非法状态 ${meta.status}`);
    }
    if (meta.status === "blocked" && !meta.blocked_reason) {
      problems.push(`${id}: blocked 缺少 blocked_reason`);
    }
    if (
      ["in_progress", "review", "delivered"].includes(meta.status) &&
      !criteriaPresent(doc.body)
    ) {
      problems.push(`${id}: ${meta.status} 状态但质量判据为空`);
    }
    problems.push(...locationProblems(root, file, meta));
    // 卡片引用完整性
    if (Array.isArray(meta.context_cards) && basename(file) === "goal.md") {
      const dir = file.slice(0, file.length - "goal.md".length);
      for (const ref of meta.context_cards) {
        const cardFile = join(dir, "cards", `${ref}.md`);
        if (!existsSync(cardFile)) {
          problems.push(`${id}: 悬空卡片引用 ${ref}`);
          continue;
        }
        try {
          const card = loadGoal(cardFile).meta;
          if (card.goal !== id) {
            problems.push(`${id}: 卡片 ${ref} 归属不一致（card.goal=${card.goal}）`);
          }
          if (!(CARD_STATUSES as readonly string[]).includes(card.status)) {
            problems.push(`${id}: 卡片 ${ref} 非法状态 ${card.status}`);
          }
        } catch (e) {
          problems.push(`${id}: 卡片 ${ref} 解析失败：${(e as Error).message}`);
        }
      }
    }
    for (const d of Array.isArray(meta.depends_on) ? meta.depends_on : []) {
      const dep = String(d?.goal ?? d);
      // 悬空依赖在 docs 全部收集后统一检查
      void dep;
    }
  }
  for (const [id, doc] of docs) {
    for (const d of Array.isArray(doc.meta.depends_on) ? doc.meta.depends_on : []) {
      const dep = String(d?.goal ?? d);
      if (!docs.has(dep)) problems.push(`${id}: 依赖不存在的目标 ${dep}`);
    }
  }
  problems.push(...cycleProblems(docs));
  try {
    readEvents(root);
  } catch (e) {
    problems.push((e as Error).message);
  }
  return problems;
}

/** 从事件流重建状态并与 frontmatter 比对；返回 drift 列表。 */
export function rebuild(root: string): string[] {
  const replayed = replayStatuses(readEvents(root));
  const drift: string[] = [];
  for (const file of listGoalFiles(root)) {
    let doc: GoalDoc;
    try {
      doc = loadGoal(file);
    } catch {
      continue; // 解析失败归 validate 管
    }
    const id = String(doc.meta.id);
    const expected = replayed.get(id);
    if (expected === undefined) {
      drift.push(`${id}: 事件流中无记录（goal.created 缺失）`);
    } else if (expected !== doc.meta.status) {
      drift.push(
        `${id}: frontmatter=${doc.meta.status} 与事件流重建=${expected} 不一致`,
      );
    }
  }
  return drift;
}

// ---- 上下文卡片（SCHEMA §2.5） ----

export const CARD_KINDS = ["text", "file", "image", "data"] as const;
export const CARD_STATUSES = ["empty", "collecting", "filled", "reviewed"] as const;

/** 目标文件所在目录；backlog 平铺文件没有目录，不能建卡。 */
function goalDirOf(file: string): string {
  if (basename(file) !== "goal.md") {
    throw new GraphError("暂存目标（backlog）没有目录，需先排期移入 goals/ 或版本后才能建卡");
  }
  return file.slice(0, file.length - "goal.md".length);
}

export function addCard(
  root: string,
  goalId: string,
  opts: { title: string; kind: string; actor: string },
): string {
  if (!(CARD_KINDS as readonly string[]).includes(opts.kind)) {
    throw new GraphError(`非法卡片 kind：${opts.kind}（${CARD_KINDS.join("|")}）`);
  }
  const file = findGoalFile(root, goalId);
  const dir = goalDirOf(file);
  const cardId = "card-" + randomUUID().slice(0, 8);
  const cardDir = join(dir, "cards");
  mkdirSync(cardDir, { recursive: true });
  const meta: Record<string, any> = {
    id: cardId,
    goal: goalId,
    title: opts.title,
    kind: opts.kind,
    status: "empty",
    filled_by: null,
    filled_at: null,
    content_ref: null,
  };
  saveGoal(join(cardDir, `${cardId}.md`), { meta, body: "\n" });
  const doc = loadGoal(file);
  if (!Array.isArray(doc.meta.context_cards)) doc.meta.context_cards = [];
  doc.meta.context_cards.push(cardId);
  saveGoal(file, doc);
  appendEvent(root, {
    actor: opts.actor,
    event: "card.created",
    goal: goalId,
    details: { card: cardId, title: opts.title, kind: opts.kind },
  });
  return cardId;
}

function loadCard(
  root: string,
  goalId: string,
  cardId: string,
): { file: string; doc: GoalDoc } {
  const goalFile = findGoalFile(root, goalId);
  const file = join(goalDirOf(goalFile), "cards", `${cardId}.md`);
  if (!existsSync(file)) throw new GraphError(`卡片不存在：${cardId}（目标 ${goalId}）`);
  return { file, doc: loadGoal(file) };
}

export function fillCard(
  root: string,
  goalId: string,
  cardId: string,
  opts: { text?: string; contentRef?: string; by: string; actor: string },
): void {
  const { file, doc } = loadCard(root, goalId, cardId);
  if (opts.text !== undefined) doc.body = "\n" + opts.text + "\n";
  if (opts.contentRef !== undefined) doc.meta.content_ref = opts.contentRef;
  doc.meta.status = "filled";
  doc.meta.filled_by = opts.by;
  doc.meta.filled_at = new Date().toISOString();
  saveGoal(file, doc);
  appendEvent(root, {
    actor: opts.actor,
    event: "card.filled",
    goal: goalId,
    details: { card: cardId, by: opts.by },
  });
}

export function reviewCard(
  root: string,
  goalId: string,
  cardId: string,
  opts: { by: string; actor: string },
): void {
  const { file, doc } = loadCard(root, goalId, cardId);
  if (doc.meta.status !== "filled") {
    throw new GraphError(`卡片 ${cardId} 状态为 ${doc.meta.status}，只有 filled 可复核`);
  }
  doc.meta.status = "reviewed";
  saveGoal(file, doc);
  appendEvent(root, {
    actor: opts.actor,
    event: "card.reviewed",
    goal: goalId,
    details: { card: cardId, by: opts.by },
  });
}

// ---- Attempt（SCHEMA §3） ----

const ATTEMPT_BODY = `
## 执行笔记

（执行者自由记录）

## Review 记录

<!-- 受管小节 -->
`;

/** 创建 attempt 目录与 attempt.md，追加 attempt.started 事件；返回 attempt id。 */
export function startAttempt(
  root: string,
  goalId: string,
  opts: { executor: string; actor: string },
): string {
  const goalFile = findGoalFile(root, goalId);
  const dir = join(goalDirOf(goalFile), "attempts");
  mkdirSync(dir, { recursive: true });
  const seq = readdirSync(dir).filter((d) => d.startsWith("att-")).length + 1;
  const attId = `att-${String(seq).padStart(3, "0")}`;
  const attDir = join(dir, attId);
  mkdirSync(join(attDir, "delivery"), { recursive: true });
  const meta: Record<string, any> = {
    id: attId,
    goal: goalId,
    executor: opts.executor,
    sandbox: "directory",
    started_at: new Date().toISOString(),
    claimed_at: null,
    status_line: null,
    result: "pending",
    child_id: null,
  };
  saveGoal(join(attDir, "attempt.md"), { meta, body: ATTEMPT_BODY });
  appendEvent(root, {
    actor: opts.actor,
    event: "attempt.started",
    goal: goalId,
    details: { attempt: attId, executor: opts.executor },
  });
  return attId;
}

/** 更新 attempt 的一句最新状态，追加 attempt.status_reported 事件。 */
export function reportStatus(
  root: string,
  goalId: string,
  attemptId: string,
  line: string,
  actor: string,
): void {
  if (!line.trim()) throw new GraphError("status 不能为空");
  const goalFile = findGoalFile(root, goalId);
  const file = join(goalDirOf(goalFile), "attempts", attemptId, "attempt.md");
  if (!existsSync(file)) throw new GraphError(`attempt 不存在：${attemptId}（目标 ${goalId}）`);
  const doc = loadGoal(file);
  doc.meta.status_line = line;
  saveGoal(file, doc);
  appendEvent(root, {
    actor,
    event: "attempt.status_reported",
    goal: goalId,
    details: { attempt: attemptId, status: line },
  });
}

/** 把 subagent childId 绑定到 attempt（startContinuable 之后调用）。 */
export function bindAttemptChild(
  root: string,
  goalId: string,
  attemptId: string,
  childId: string,
  actor: string,
): void {
  const goalFile = findGoalFile(root, goalId);
  const file = join(goalDirOf(goalFile), "attempts", attemptId, "attempt.md");
  if (!existsSync(file)) throw new GraphError(`attempt 不存在：${attemptId}（目标 ${goalId}）`);
  const doc = loadGoal(file);
  doc.meta.child_id = childId;
  saveGoal(file, doc);
  appendEvent(root, {
    actor,
    event: "attempt.bound",
    goal: goalId,
    details: { attempt: attemptId, child_id: childId },
  });
}
