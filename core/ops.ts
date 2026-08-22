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
import { appendEvent, readEvents, replayStatuses, nowIso, type GraphEvent } from "./events.ts";
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

/** 初始化图根目录骨架（幂等，g-112）：重复调用不重复建、不重复记 project.initialized。
 *  建 backlog/goals/versions/memory + events.jsonl/index.json/rules.md；不建 project.yaml、不带 demo 数据。 */
export function init(root: string): void {
  const events = join(root, "events.jsonl");
  const fresh = !existsSync(events); // 以事件流是否存在判定「是否首次初始化」
  for (const d of ["backlog", "goals", "versions", "memory/long-term"]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  if (fresh) writeFileSync(events, "", "utf8");
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
  if (fresh) appendEvent(root, { actor: "core", event: "project.initialized", details: { root } });
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

/** 写 project.yaml 的 supervisor.session（g-117）：原子写（临时文件 + rename）、事件先行。
 *  零依赖行编辑：无 supervisor 块则新建；有块无 session 键则插入（跟随块内已有缩进）；
 *  有则替换值并保留行尾注释与其他键。事件：supervisor.claimed（actor 为调用者）。
 *  幂等由 claimSupervisor 把关（值未变不重复记事件）；本 op 每次调用都写 + 记事件。 */
export function writeSupervisorSession(root: string, sessionId: string, actor: string): void {
  if (!sessionId.trim()) throw new GraphError("session id 不能为空");
  const file = join(root, "project.yaml");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = text.split("\n");
  const blockIdx = lines.findIndex((l) => /^supervisor:\s*$/.test(l));
  if (blockIdx >= 0) {
    // 在块内找 session 行（块 = supervisor: 后的缩进行）
    let sessionIdx = -1;
    let indent = "  ";
    for (let i = blockIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (!/^[ \t]/.test(l)) break; // 块结束
      const sm = l.match(/^([ \t]+)session:/);
      if (sm) {
        sessionIdx = i;
        indent = sm[1];
        break;
      }
    }
    if (sessionIdx >= 0) {
      // 保留行尾注释：`session: <value>  [comment]` → 只换 value
      const m = lines[sessionIdx].match(/^([ \t]+session:\s*)[^\s"#]+(\s*#.*)?$/);
      const tail = m ? (m[2] ?? "") : "";
      lines[sessionIdx] = `${indent}session: ${sessionId}${tail}`;
    } else {
      lines.splice(blockIdx + 1, 0, `${indent}session: ${sessionId}`);
    }
    writeFileSync(`${file}.tmp`, lines.join("\n"), "utf8");
  } else {
    // 无 supervisor 块：文末追加新块
    const block = `supervisor:\n  session: ${sessionId}`;
    const trimmed = text.replace(/\s+$/, "");
    writeFileSync(`${file}.tmp`, trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`, "utf8");
  }
  renameSync(`${file}.tmp`, file);
  appendEvent(root, {
    actor,
    event: "supervisor.claimed",
    details: { supervisor_session: sessionId },
  });
}

/** 生成交接文档全文（g-117）：board 投影 + 长期记忆 + 固定环境事实段。
 *  产物不依赖会话上下文（不读 session、不读 ex）；opts.write 时落盘 <root>/HANDOFF.md。
 *  结构：目标看板（按版本/独立/backlog）→ 进行中（下一步就干）→ 已交付 → 阻塞 →
 *  关键环境事实（固定段）→ 长期记忆。 */
export function generateHandoff(
  root: string,
  opts: { write?: boolean } = {},
): string {
  const board = boardProjection(root);
  const line = (g: {
    id: string; title: string; status: string; status_line?: string | null;
    blocked_reason?: string | null; reused_by?: string | null;
  }): string => {
    let s = `- **${g.id}（${g.title}）**：\`${g.status}\``;
    if (g.blocked_reason) s += ` —— ${g.blocked_reason}`;
    if (g.status_line) s += `（${g.status_line}）`;
    if (g.reused_by) s += `（被复用→${g.reused_by}）`;
    return s;
  };
  const parts: string[] = [];
  parts.push("# HANDOFF（换会话交接）", "");
  parts.push(`> 由 graph_handoff 自动生成于 ${nowIso()}（g-117）。图根：\`${root}\`。`);
  parts.push("> 你的职责指南：dsh-graph-host/supervisor-guide.md（注册为 skill `dsh-graph-supervisor`）。", "");
  parts.push("## 目标看板", "");
  for (const v of board.versions) {
    parts.push(`### 版本 ${v.slug}（${v.status}）`, "");
    for (const g of v.goals) parts.push(line(g));
    parts.push("");
  }
  if (board.standalone.length) {
    parts.push("### 独立目标", "");
    for (const g of board.standalone) parts.push(line(g));
    parts.push("");
  }
  if (board.backlog.length) {
    parts.push("### backlog", "");
    for (const g of board.backlog) parts.push(line(g));
    parts.push("");
  }
  const all = [
    ...board.versions.flatMap((v) => v.goals),
    ...board.standalone,
    ...board.backlog,
  ];
  const active = all.filter((g) => g.status !== "delivered" && g.status !== "blocked");
  const delivered = all.filter((g) => g.status === "delivered");
  const blocked = all.filter((g) => g.status === "blocked");
  if (active.length) {
    parts.push("## 进行中（下一步就干）", "");
    for (const g of active) parts.push(line(g));
    parts.push("");
  }
  if (delivered.length) {
    parts.push("## 已交付", "");
    parts.push(delivered.map((g) => `- **${g.id}**：${g.title}`).join("\n"), "");
  }
  if (blocked.length) {
    parts.push("## 阻塞", "");
    for (const g of blocked) parts.push(line(g));
    parts.push("");
  }
  parts.push("## 关键环境事实（固定段）", "");
  parts.push(
    "- **executor provider** = `deepseek-official`/deepseek-v4-flash（「deepseek」是错名；DSH adapter 注册名是 deepseek-official）",
    "- **本地 dev 的 root 覆盖必须用相对值 `.dsh-graph`**（绝对路径会被 `path.resolve` 顶掉、破坏 workspace 跟随）",
    "- **pnpm 11 supply-chain 策略在 `pnpm-workspace.yaml` 设 `minimumReleaseAge`**（不是 .npmrc）",
    "- **冻结脚本 R-03**：执行方不得改；规划方（supervisor）可改但必须加 revision 注记",
    "- **子代理 spawn 两个 provider 概念别混**：subagent provider（spawn/fork）≠ LLM provider（agentOptions）",
    "",
  );
  const memDir = join(root, "memory", "long-term");
  const memFiles = existsSync(memDir)
    ? readdirSync(memDir).filter((f) => f.endsWith(".md")).sort()
    : [];
  parts.push("## 长期记忆", "");
  parts.push(
    memFiles.length
      ? `\`memory/long-term/\` 下 ${memFiles.length} 个文件：\n${memFiles.map((f) => `- ${f}`).join("\n")}`
      : "（无）",
    "",
  );
  const content = parts.join("\n");
  if (opts.write) writeFileSync(join(root, "HANDOFF.md"), content, "utf8");
  return content;
}

/** supervisor 会话交接（g-117）：把 project.yaml 的 supervisor.session 更新为 sessionId，
 *  记 supervisor.claimed 事件（幂等：值未变不重复记事件），并返回 HANDOFF 交接全文。
 *  sessionId 取 ex.agent.session.id 同链（调用方注入）。 */
export function claimSupervisor(
  root: string,
  sessionId: string,
  actor: string,
): { supervisor_session: string; handoff: string } {
  if (!sessionId || !sessionId.trim()) {
    throw new GraphError("无法确定当前会话 id（ex.agent.session.id 缺失）");
  }
  if (readSupervisorSession(root) !== sessionId) {
    writeSupervisorSession(root, sessionId, actor);
  }
  return { supervisor_session: sessionId, handoff: generateHandoff(root) };
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

/** 读取 supervisor 最新状态的时间戳（epoch ms；无则 null）——供客户端判断状态是否过期清空。 */
export function readSupervisorStatusAt(root: string): number | null {
  let latest: number | null = null;
  try {
    for (const e of readEvents(root)) {
      if (e.event !== "supervisor.status_reported") continue;
      const t = Date.parse(String(e.ts ?? ""));
      if (Number.isFinite(t)) latest = t;
    }
  } catch {
    /* 事件流异常时返回已读到的最新值 */
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
    child_id: null,           // 收集子代理 id（graph_bind_collect_card 绑定）
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

/** 把收集子代理绑定到卡片（g-109）：写 child_id/parent_session_id、置 status=collecting，并记 card.collecting 事件（事件先行）。
 *  g-119：幂等——同一 child_id+parent_session_id 对同一卡片重复绑定（状态已 collecting）为 no-op，
 *  不重写、不重复记事件（防重试/重复派发刷事件流）；换 child（重新收集）或换 parent 仍正常写。 */
export function bindCardChild(
  root: string,
  goalId: string,
  cardId: string,
  opts: { childId: string; parentSessionId?: string | null; actor: string },
): void {
  const { file, doc } = loadCard(root, goalId, cardId);
  const parentSessionId = opts.parentSessionId ?? null;
  if (
    doc.meta.status === "collecting" &&
    doc.meta.child_id === opts.childId &&
    (doc.meta.parent_session_id ?? null) === parentSessionId
  ) {
    return;
  }
  doc.meta.child_id = opts.childId;
  doc.meta.parent_session_id = parentSessionId;
  doc.meta.status = "collecting";
  saveGoal(file, doc);
  appendEvent(root, {
    actor: opts.actor,
    event: "card.collecting",
    goal: goalId,
    details: { card: cardId, child_id: opts.childId },
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

/** 看板端点载荷：board 投影 + supervisorSession（g-108）。
 *  由 dsh-graph-host 的 client 半边（/api/dsh-graph）消费，会话 id 不在任何代码里硬编码。
 *  g-111 B7：从 dsh-graph-host/index.js 移入 core，消除跨包依赖（g-116 合并后单包内复用）。 */
export function boardPayload(root: string) {
  return {
    ...boardProjection(root),
    supervisorSession: readSupervisorSession(root),
    // g-a92e1406 判据 3① 扩展：supervisor 状态栏显示 supervisor 自己的 status_line（事件流最新一条）
    supervisorStatus: readSupervisorStatus(root),
    // 状态新鲜度（负责人 2026-08 指示：新一轮开始应清空上次 status，等快速替换）——时间戳供客户端过期清空
    supervisorStatusAt: readSupervisorStatusAt(root),
  };
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

/** 主管复核接受请求（兼容旧名，内部转发 requestAcceptReview / resolveAccept）。 */
export function acceptReview(
  root: string,
  id: string,
  opts: { actor: string; force?: boolean; reason?: string },
): { ok: boolean; objection?: string; pending?: boolean } {
  if (opts.force) {
    resolveAccept(root, id, { actor: opts.actor, verdict: "accept", force: true, reason: opts.reason });
    return { ok: true };
  }
  const r = requestAcceptReview(root, id, opts.actor);
  return { ok: false, pending: r.pending };
}

/** 请求主管复核接受：追加 review.requested 事件，返回 {pending:true}。
 *  details 带 targetStage=当前 status、what=描述/判据/review、snapshot 简要。 */
export function requestAcceptReview(
  root: string,
  id: string,
  actor: string,
): { pending: true; goal: string } {
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  const status = String(doc.meta.status ?? "");
  const allowed = ["draft", "planning", "collecting", "ready", "review"];
  if (!allowed.includes(status)) {
    throw new GraphError(`当前状态 ${status} 不允许接受操作`);
  }
  const what =
    status === "draft" || status === "planning"
      ? "描述"
      : status === "collecting" || status === "ready"
        ? "判据"
        : "review";
  const snapshot = doc.body.match(/## 目标描述\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim()?.slice(0, 200) ?? "";
  appendEvent(root, {
    actor,
    event: "review.requested",
    goal: id,
    details: { targetStage: status, what, snapshot },
  });
  return { pending: true, goal: id };
}

/** 主管裁决接受请求。
 *  verdict="accept" → 按阶段追加 description.confirmed / criteria.confirmed(actor=human) / review.passed+transition delivered
 *  verdict="object" → 追加 review.objected（details.objection=异议内容）
 *  force=true + reason → 记 goal.amended（理由），直接走 accept 分支 */
export function resolveAccept(
  root: string,
  id: string,
  opts: { actor: string; verdict: "accept" | "object"; objection?: string; force?: boolean; reason?: string },
): { ok: boolean } {
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  const status = String(doc.meta.status ?? "");

  if (opts.force) {
    if (opts.reason) {
      appendEvent(root, {
        actor: opts.actor,
        event: "goal.amended",
        goal: id,
        details: { note: `强制接受理由：${opts.reason}` },
      });
    }
    // force 直接走 accept 分支
    applyAcceptMapping(root, id, status, opts.actor);
    return { ok: true };
  }

  if (opts.verdict === "object") {
    if (!opts.objection?.trim()) throw new GraphError("异议内容不能为空");
    appendEvent(root, {
      actor: opts.actor,
      event: "review.objected",
      goal: id,
      details: { objection: opts.objection },
    });
    return { ok: true };
  }

  // verdict === "accept"
  applyAcceptMapping(root, id, status, opts.actor);
  return { ok: true };
}

/** 接受生效的阶段映射（内部复用） */
function applyAcceptMapping(root: string, id: string, status: string, actor: string): void {
  if (status === "draft" || status === "planning") {
    appendEvent(root, { actor, event: "description.confirmed", goal: id, details: {} });
  } else if (status === "collecting") {
    transition(root, id, "ready", { actor });
    appendEvent(root, { actor, event: "criteria.confirmed", goal: id, details: { actor: "human" } });
  } else if (status === "ready") {
    // 已在 ready，不再 transition，仅追加 criteria.confirmed
    appendEvent(root, { actor, event: "criteria.confirmed", goal: id, details: { actor: "human" } });
  } else if (status === "review") {
    transition(root, id, "delivered", { actor });
    appendEvent(root, { actor, event: "review.passed", goal: id, details: {} });
  }
}

/** 读取目标的接受复核状态（事件流查询）。
 *  返回：{state: 'pending'|'resolved'|'objection'|'none', result?:object} */
export function readAcceptStatus(
  root: string,
  id: string,
): { state: "pending" | "resolved" | "objection" | "none"; result?: Record<string, any> } {
  const events = readEvents(root).filter((e) => e.goal === id);
  let latestRequested: GraphEvent | null = null;
  let latestResolved: GraphEvent | null = null;
  let latestObjected: GraphEvent | null = null;
  for (const e of events) {
    if (e.event === "review.requested") latestRequested = e;
    if (e.event === "description.confirmed" || e.event === "criteria.confirmed" || e.event === "review.passed") {
      latestResolved = e;
    }
    if (e.event === "review.objected") latestObjected = e;
  }
  if (!latestRequested) return { state: "none" };
  // 检查是否有比 requested 更新的 resolved 或 objected
  const reqIdx = events.indexOf(latestRequested);
  if (latestObjected) {
    const objIdx = events.indexOf(latestObjected);
    if (objIdx > reqIdx) {
      return { state: "objection", result: { objection: latestObjected.details?.objection, by: latestObjected.actor } };
    }
  }
  if (latestResolved) {
    const resIdx = events.indexOf(latestResolved);
    if (resIdx > reqIdx) {
      return { state: "resolved", result: { event: latestResolved.event, by: latestResolved.actor } };
    }
  }
  return { state: "pending" };
}
