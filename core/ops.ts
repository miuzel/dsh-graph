/** 核心操作：init / createGoal / setCriteria / transition / validate / rebuild。 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join, basename, dirname, relative } from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseDoc,
  serializeDoc,
  replaceSection,
  criteriaPresent,
  type GoalDoc,
} from "./model.ts";
import { appendEvent, readEvents, replayStatuses, nowIso } from "./events.ts";
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

/** 读取 project.yaml 的 supervisor.session（看板顶部状态栏数据源，g-108）。
 *  零依赖行扫描：supervisor: 块内的 session: 标量，去引号与行尾注释；缺失返回 null。 */
export function readSupervisorSession(root: string): string | null {
  const file = join(root, "project.yaml");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const m = text.match(/^supervisor:\s*\n(?:[ \t].*\n)*?[ \t]+session:\s*"?([^\s"#]+)"?/m);
  return m ? m[1] : null;
}

/** supervisor 汇报自己的状态摘要（看板顶部状态栏 status_line，g-a92e1406 判据 3① 扩展）。
 *  事件流唯一真相源（R-02）：只追加 supervisor.status_reported 事件，读取时取最新一条。 */
export function reportSupervisorStatus(root: string, line: string, actor: string): void {
  if (!line.trim()) throw new GraphError("status 不能为空");
  appendEvent(root, {
    actor,
    event: "supervisor.status_reported",
    details: { status: line },
  });
}

/** 读取 supervisor 最新一条状态摘要（事件流，坏行跳过）；无则 null。 */
export function readSupervisorStatus(root: string): string | null {
  let latest: string | null = null;
  try {
    for (const e of readEvents(root)) {
      if (e.event !== "supervisor.status_reported") continue;
      const s = String(e.details?.status ?? "").trim();
      if (s) latest = s;
    }
  } catch {
    /* 事件流异常时返回已读到的最新值（可能为 null） */
  }
  return latest;
}

/** 读取 project.yaml 的 executor.provider/model（执行子代理模型路由，负责人 2026-08 指示：
 *  子代理不继承父会话模型，统一走配置的 provider 防余额/配额串号）。
 *  零依赖行扫描；缺失字段返回 null。 */
export function readExecutorModel(root: string): { provider: string | null; model: string | null } {
  const file = join(root, "project.yaml");
  if (!existsSync(file)) return { provider: null, model: null };
  const text = readFileSync(file, "utf8");
  const block = text.match(/^executor:\s*\n((?:[ \t].*\n)*)/m);
  if (!block) return { provider: null, model: null };
  const grab = (k: string): string | null => {
    const m = block[1].match(new RegExp(`^[ \\t]+${k}:\\s*"?([^\\s"#]+)"?`, "m"));
    return m ? m[1] : null;
  };
  return { provider: grab("provider"), model: grab("model") };
}

const GOAL_BODY = `
## 目标描述

（待填写）

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

/** 连号 id：扫描所有目标的 frontmatter meta.id 取最大数字编号 +1（g-001…g-9999）。
 *  注意必须读 frontmatter 而非路径——真实仓库目录/文件名是 slug（如 goals/session-embed/），
 *  g-id 只存在于 meta.id（发现#24：按路径推导曾误生成 g-001 撞号）。
 *  历史上的随机 8 位 id（如 g-a92e1406、g-77647351）不匹配 \d{1,4}，自然跳过；
 *  既有 id 永不改写（事件流引用它们，R-02）。 */
function nextGoalSeq(root: string): string {
  let max = 0;
  for (const f of listGoalFiles(root)) {
    let id = "";
    try {
      id = String(loadGoal(f).meta.id ?? "");
    } catch {
      continue;
    }
    const m = /^g-(\d{1,4})$/.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "g-" + String(max + 1).padStart(3, "0");
}

export function createGoal(
  root: string,
  opts: { title: string; version?: string; scope?: string[]; actor: string },
): string {
  const id = nextGoalSeq(root);
  const meta: Record<string, any> = {
    id,
    title: opts.title,
    status: "draft",
    blocked_reason: null,
    created_at: nowIso(),
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
    // 隐式版本：version.md 不存在时补骨架（发现#14）
    const vfile = join(root, "versions", opts.version, "version.md");
    if (!existsSync(vfile)) {
      saveGoal(vfile, {
        meta: {
          id: "v-" + randomUUID().slice(0, 8),
          name: opts.version,
          status: "planning",
          created_at: nowIso(),
        },
        body: "\n## 范围\n\n（隐式创建：由 create-goal --version 带入）\n",
      });
      appendEvent(root, {
        actor: opts.actor,
        event: "version.created",
        details: { version: opts.version, implicit: true },
      });
    }
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
    summary: null,            // 一句摘要（看板芯片/抽屉标题下显示）
    child_id: null,           // 收集子代理 id（graph_collect_card 绑定）
    parent_session_id: null,  // 派发方会话 id（GUI 打开子代理用）
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
  opts: { text?: string; contentRef?: string; summary?: string; by: string; actor: string },
): void {
  const { file, doc } = loadCard(root, goalId, cardId);
  if (opts.text !== undefined) doc.body = "\n" + opts.text + "\n";
  if (opts.contentRef !== undefined) doc.meta.content_ref = opts.contentRef;
  if (opts.summary !== undefined) doc.meta.summary = opts.summary;
  doc.meta.status = "filled";
  doc.meta.filled_by = opts.by;
  doc.meta.filled_at = nowIso();
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
    started_at: nowIso(),
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
  parentSessionId?: string,
): void {
  const goalFile = findGoalFile(root, goalId);
  const file = join(goalDirOf(goalFile), "attempts", attemptId, "attempt.md");
  if (!existsSync(file)) throw new GraphError(`attempt 不存在：${attemptId}（目标 ${goalId}）`);
  const doc = loadGoal(file);
  doc.meta.child_id = childId;
  if (parentSessionId) doc.meta.parent_session_id = parentSessionId;
  saveGoal(file, doc);
  appendEvent(root, {
    actor,
    event: "attempt.bound",
    goal: goalId,
    details: { attempt: attemptId, child_id: childId },
  });
}

/**
 * 排期/位置移动（backlog ↔ standalone goals/ ↔ versions/<v>/）。
 * 文件移动即归属变更，记 goal.moved 事件（不影响状态机状态）。
 */
export function moveGoal(
  root: string,
  id: string,
  opts: { to: "backlog" | "standalone" | "version"; version?: string; actor: string },
): void {
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  const srcDir = basename(file) === "goal.md" ? dirname(file) : null;
  let targetFile: string;
  let targetDirForm: boolean;
  if (opts.to === "backlog") {
    if (srcDir) {
      const extras = readdirSync(srcDir).filter((x) => x !== "goal.md");
      if (extras.length > 0) {
        throw new GraphError("目标已有 cards/attempts 等目录附件，不能移回 backlog 平铺");
      }
    }
    targetFile = join(root, "backlog", `${id}.md`);
    targetDirForm = false;
    doc.meta.version = null;
  } else if (opts.to === "standalone") {
    targetFile = join(root, "goals", id, "goal.md");
    targetDirForm = true;
    doc.meta.version = null;
  } else if (opts.to === "version") {
    if (!opts.version) throw new GraphError("移动到版本需要指定 version");
    targetFile = join(root, "versions", opts.version, "goals", id, "goal.md");
    targetDirForm = true;
    doc.meta.version = opts.version;
  } else {
    throw new GraphError(`非法移动目标：${opts.to}`);
  }
  if (targetFile === file) return;
  if (existsSync(targetFile)) throw new GraphError(`目标位置已存在：${targetFile}`);
  mkdirSync(dirname(targetFile), { recursive: true });
  if (srcDir && targetDirForm) {
    // 目录形态互转：整体移动目录（cards/ attempts/ 一起走）
    renameSync(srcDir, dirname(targetFile));
  } else {
    renameSync(file, targetFile);
    if (srcDir) {
      try {
        rmdirSync(srcDir); // 仅当空目录（移回 backlog 平铺方向）
      } catch {
        /* 有附件目录则保留 */
      }
    }
  }
  saveGoal(targetFile, doc);
  appendEvent(root, {
    actor: opts.actor,
    event: "goal.moved",
    goal: id,
    details: { from: relative(root, file), to: relative(root, targetFile) },
  });
}

// ---- 看板数据投影（供 host 端点与文字版看板共用） ----

export interface BoardGoal {
  id: string;
  title: string;
  status: string;
  status_line: string | null;
  reviewer: string | null;
  depends_on: string[];
  pk_lanes: number;
  blocked_reason: string | null;
  attempt_child_id?: string | null;
  attempt_parent_session_id?: string | null;
  created_at?: string | null;
  attempt_started_at?: string | null;
  /** 被复用派生（g-a92e1406）：子代理被跨目标复用时，旧绑定目标标 reused_by = 新目标 id */
  reused_by?: string | null;
  cards?: Array<Record<string, any>>;
}

export interface BoardVersion {
  slug: string;
  id: string | null;
  name: string;
  status: string;
  goals: BoardGoal[];
}

export function boardProjection(root: string): {
  generated_at: string;
  versions: BoardVersion[];
  standalone: BoardGoal[];
  backlog: BoardGoal[];
} {
  const goalItem = (file: string): BoardGoal => {
    const meta = loadGoal(file).meta;
    // 取最新一个带 status_line 的 attempt
    let statusLine: string | null = null;
    const dir = basename(file) === "goal.md" ? dirname(file) : null;
    if (dir) {
      const attDir = join(dir, "attempts");
      if (existsSync(attDir)) {
        const atts = readdirSync(attDir).filter((d) => d.startsWith("att-")).sort();
        for (let i = atts.length - 1; i >= 0; i--) {
          const f = join(attDir, atts[i], "attempt.md");
          if (!existsSync(f)) continue;
          try {
            const m = loadGoal(f).meta;
            if (m.status_line) {
              statusLine = m.status_line;
              break;
            }
          } catch {
            /* 坏的 attempt 文件跳过 */
          }
        }
      }
    }
    // 最新一个绑定了子代理的 attempt（卡片会话链接用）
    let attemptChild: Record<string, any> = {};
    if (dir) {
      const attDir = join(dir, "attempts");
      if (existsSync(attDir)) {
        const atts = readdirSync(attDir).filter((d) => d.startsWith("att-")).sort().reverse();
        for (const a of atts) {
          const f = join(attDir, a, "attempt.md");
          if (!existsSync(f)) continue;
          try {
            const m = loadGoal(f).meta;
            if (m.child_id) {
              attemptChild = {
                child_id: m.child_id,
                parent_session_id: m.parent_session_id ?? null,
                started_at: m.started_at ?? null,
              };
              break;
            }
          } catch { /* 跳过 */ }
        }
      }
    }
    // 上下文卡片摘要（目标目录 cards/ 下）
    const cards: Array<Record<string, any>> = [];
    if (dir) {
      const cdir = join(dir, "cards");
      if (existsSync(cdir)) {
        for (const f of readdirSync(cdir).sort()) {
          if (!f.endsWith(".md")) continue;
          try {
            const cm = loadGoal(join(cdir, f)).meta;
            cards.push({
              id: cm.id, title: cm.title, kind: cm.kind, status: cm.status,
              summary: cm.summary ?? null,
              child_id: cm.child_id ?? null,
              parent_session_id: cm.parent_session_id ?? null,
            });
          } catch {
            /* 跳过坏卡片 */
          }
        }
      }
    }
    return {
      id: String(meta.id),
      title: String(meta.title ?? meta.id),
      status: String(meta.status ?? "unknown"),
      status_line: statusLine,
      reviewer: meta.review?.reviewer ?? null,
      depends_on: (Array.isArray(meta.depends_on) ? meta.depends_on : []).map((d: any) =>
        String(d?.goal ?? d),
      ),
      attempt_child_id: attemptChild.child_id ?? null,
      attempt_parent_session_id: attemptChild.parent_session_id ?? null,
      created_at: String(meta.created_at ?? ""),
      attempt_started_at: attemptChild.started_at ?? null,
      reused_by: null,
      pk_lanes: meta.pk?.lanes ?? 1,
      blocked_reason: meta.blocked_reason ?? null,
      cards,
    };
  };
  const versions: BoardVersion[] = [];
  const vdir = join(root, "versions");
  if (existsSync(vdir)) {
    for (const v of readdirSync(vdir).sort()) {
      const vfile = join(vdir, v, "version.md");
      if (!existsSync(vfile)) continue;
      let vmeta: Record<string, any> = {};
      try {
        vmeta = loadGoal(vfile).meta;
      } catch {
        /* 坏版本文件按未知处理 */
      }
      const goals: BoardGoal[] = [];
      const gdir = join(vdir, v, "goals");
      if (existsSync(gdir)) {
        for (const g of readdirSync(gdir).sort()) {
          const gf = join(gdir, g, "goal.md");
          if (!existsSync(gf)) continue;
          try {
            goals.push(goalItem(gf));
          } catch {
            /* 坏目标文件跳过 */
          }
        }
      }
      versions.push({
        slug: v,
        id: vmeta.id ?? null,
        name: String(vmeta.name ?? v),
        status: String(vmeta.status ?? "unknown"),
        goals,
      });
    }
  }
  const standalone: BoardGoal[] = [];
  const sdir = join(root, "goals");
  if (existsSync(sdir)) {
    for (const g of readdirSync(sdir).sort()) {
      const gf = join(sdir, g, "goal.md");
      if (!existsSync(gf)) continue;
      try {
        standalone.push(goalItem(gf));
      } catch {
        /* 跳过 */
      }
    }
  }
  const backlog: BoardGoal[] = [];
  const bdir = join(root, "backlog");
  if (existsSync(bdir)) {
    for (const f of readdirSync(bdir).sort()) {
      if (!f.endsWith(".md")) continue;
      try {
        backlog.push(goalItem(join(bdir, f)));
      } catch {
        /* 跳过 */
      }
    }
  }
  // 被复用派生（g-a92e1406）：同一 child_id 跨目标绑定时，旧绑定加 reused 标记。
  // 数据双源：① attempt.reused 事件（权威方向：goal=旧绑定, details.reused_by="新目标/att-N"）
  //           ② 绑定记录兜底（无事件时按绑定 attempt 的 started_at 定旧新，最早者为旧绑定）
  const allGoals = [
    ...versions.flatMap((v) => v.goals),
    ...standalone,
    ...backlog,
  ];
  const reusedBy = new Map<string, string>(); // oldGoalId -> newGoalId
  try {
    for (const e of readEvents(root)) {
      if (e.event !== "attempt.reused" || !e.goal) continue;
      const rb = String(e.details?.reused_by ?? "");
      const newGoal = rb.split("/")[0];
      if (newGoal) reusedBy.set(String(e.goal), newGoal);
    }
  } catch {
    /* 事件流异常时退化为绑定记录 */
  }
  // 绑定记录：同一 child 出现在多个目标，且无事件方向 → 按绑定时间定旧/新
  const byChild = new Map<string, BoardGoal[]>();
  for (const g of allGoals) {
    if (!g.attempt_child_id) continue;
    const arr = byChild.get(g.attempt_child_id) ?? [];
    arr.push(g);
    byChild.set(g.attempt_child_id, arr);
  }
  for (const arr of byChild.values()) {
    if (arr.length < 2) continue;
    // 该 child 已有事件方向（旧→新）则跳过兜底
    const decided = arr.filter((g) => reusedBy.has(g.id));
    if (decided.length > 0) continue;
    arr.sort((a, b) =>
      String(a.attempt_started_at ?? a.created_at ?? "").localeCompare(
        String(b.attempt_started_at ?? b.created_at ?? ""),
      ),
    );
    const oldG = arr[0];
    const newG = arr[arr.length - 1];
    if (oldG.id !== newG.id) reusedBy.set(oldG.id, newG.id);
  }
  for (const g of allGoals) g.reused_by = reusedBy.get(g.id) ?? null;
  return { generated_at: nowIso(), versions, standalone, backlog };
}

/** 目标的上下文卡片摘要列表（看板子卡片）。 */
export function goalCards(root: string, goalId: string): Array<Record<string, any>> {
  const file = findGoalFile(root, goalId);
  const dir = basename(file) === "goal.md" ? dirname(file) : null;
  if (!dir) return [];
  const cdir = join(dir, "cards");
  if (!existsSync(cdir)) return [];
  const out: Array<Record<string, any>> = [];
  for (const f of readdirSync(cdir).sort()) {
    if (!f.endsWith(".md")) continue;
    try {
      const doc = loadGoal(join(cdir, f));
      out.push({
        id: doc.meta.id,
        title: doc.meta.title,
        kind: doc.meta.kind,
        status: doc.meta.status,
        filled_by: doc.meta.filled_by ?? null,
        summary: doc.meta.summary ?? null,
        child_id: doc.meta.child_id ?? null,
        parent_session_id: doc.meta.parent_session_id ?? null,
      });
    } catch {
      /* 跳过坏卡片 */
    }
  }
  return out;
}

/** 目标详情（看板详情弹层）：meta + 正文小节 + 卡片 + 近期事件。 */
export function goalDetail(root: string, goalId: string): Record<string, any> {
  const file = findGoalFile(root, goalId);
  const doc = loadGoal(file);
  const events = readEvents(root)
    .filter((e) => e.goal === goalId)
    .slice(-50)
    .map((e) => ({ ts: e.ts, actor: e.actor, event: e.event, details: e.details }));
  const cards = goalCards(root, goalId).map((c) => {
    // 附全文（抽屉展示）
    const dir = basename(file) === "goal.md" ? dirname(file) : null;
    let content = "";
    if (dir) {
      const cf = join(dir, "cards", `${c.id}.md`);
      if (existsSync(cf)) {
        try {
          content = loadGoal(cf).body.trim();
        } catch { /* 忽略 */ }
      }
    }
    return { ...c, content };
  });
  const attempts: Array<Record<string, any>> = [];
  {
    const dir = basename(file) === "goal.md" ? dirname(file) : null;
    const attDir = dir ? join(dir, "attempts") : null;
    if (attDir && existsSync(attDir)) {
      for (const a of readdirSync(attDir).sort()) {
        const f = join(attDir, a, "attempt.md");
        if (!existsSync(f)) continue;
        try {
          const m = loadGoal(f).meta;
          attempts.push({
            id: m.id, executor: m.executor, result: m.result,
            status_line: m.status_line ?? null,
            child_id: m.child_id ?? null,
            parent_session_id: m.parent_session_id ?? null,
          });
        } catch { /* 跳过 */ }
      }
    }
  }
  return {
    meta: doc.meta,
    body: doc.body,
    cards,
    attempts,
    events,
  };
}

/** 修订目标：把修订说明追加进「目标描述」，并记 goal.amended 事件（人工反馈的一等记录）。 */
export function amendGoal(
  root: string,
  id: string,
  opts: { note: string; appendDescription?: string; actor: string },
): void {
  if (!opts.note.trim()) throw new GraphError("修订说明不能为空");
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  if (opts.appendDescription) {
    const desc = doc.body.match(/## 目标描述\n([\s\S]*?)(?=\n## |$)/);
    if (desc) {
      doc.body = doc.body.replace(
        /## 目标描述\n([\s\S]*?)(?=\n## |$)/,
        `## 目标描述\n${desc[1].replace(/\n*$/, "")}\n\n${opts.appendDescription}\n\n`,
      );
    } else {
      doc.body = doc.body.replace(/\n*$/, "") + "\n\n## 目标描述\n\n" + opts.appendDescription + "\n";
    }
  }
  saveGoal(file, doc);
  appendEvent(root, {
    actor: opts.actor,
    event: "goal.amended",
    goal: id,
    details: { note: opts.note },
  });
}
