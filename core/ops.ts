/** 核心操作：init / createGoal / setCriteria / transition / validate / rebuild。 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join, basename, dirname, relative } from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseDoc,
  serializeDoc,
  replaceSection,
  sectionText,
  criteriaPresent,
  countCriteria,
  type GoalDoc,
} from "./model.ts";
import { appendEvent, readEvents, replayStatuses, replayVersionLanes, nowIso, type GraphEvent } from "./events.ts";
import { GraphError, STATUSES, assertTransition } from "./machine.ts";
import { createVersion, renameVersion, deleteVersion } from "./version-lane.ts";

export { GraphError };
export { createVersion, renameVersion, deleteVersion };

/** 防止用户输入内容中包含 `## ` 或 `### ` 开头的行，破坏 goal.md section 边界。
 *  将行首 `## ` / `### ` 转义为 `\## ` / `\### `（Markdown 不渲染为标题）。
 *  用于 setGoalDirective 和 appendGoalComment 的输入保护（g-150 返工阻断项 #5）。 */
function sanitizeHeadingContent(text: string): string {
  // 匹配行首可选空白 + 2-3 个 # + 至少一个空格（标题语法）
  // 替换为 \## 或 \###（Markdown 不渲染为标题）
  return text.replace(/^([ \t]{0,3})(###[ \t]+|##[ \t]+)/gm, "$1\\$2");
}

/** 扫描图根下全部目标文件：backlog/*.md、goals/<id>/goal.md、versions/<v>/goals/<id>/goal.md。
 *  opts.includeArchived=true 时也扫描 archived 目录下的目标。 */
export function listGoalFiles(root: string, opts?: { includeArchived?: boolean }): string[] {
  const out: string[] = [];
  const includeArchived = opts?.includeArchived ?? false;
  const backlog = join(root, "backlog");
  if (existsSync(backlog)) {
    for (const f of readdirSync(backlog)) {
      if (f.endsWith(".md")) {
        const fp = join(backlog, f);
        if (!includeArchived && isArchivedFile(fp)) continue;
        out.push(fp);
      }
    }
    // backlog/archived/ 目录
    if (includeArchived) {
      const backlogArchived = join(backlog, "archived");
      if (existsSync(backlogArchived)) {
        for (const f of readdirSync(backlogArchived)) {
          if (f.endsWith(".md")) out.push(join(backlogArchived, f));
        }
      }
    }
  }
  const goals = join(root, "goals");
  if (existsSync(goals)) {
    for (const d of readdirSync(goals)) {
      if (d === "archived") {
        if (includeArchived) {
          const archivedDir = join(goals, "archived");
          for (const ad of readdirSync(archivedDir)) {
            const p = join(archivedDir, ad, "goal.md");
            if (existsSync(p)) out.push(p);
          }
        }
        continue;
      }
      const p = join(goals, d, "goal.md");
      if (existsSync(p)) out.push(p);
    }
  }
  const versions = join(root, "versions");
  if (existsSync(versions)) {
    for (const v of readdirSync(versions)) {
      const gdir = join(versions, v, "goals");
      if (existsSync(gdir)) {
        for (const d of readdirSync(gdir)) {
          const p = join(gdir, d, "goal.md");
          if (existsSync(p)) out.push(p);
        }
      }
      // versions/vX/archived/ 目录
      if (includeArchived) {
        const archivedDir = join(versions, v, "archived");
        if (existsSync(archivedDir)) {
          for (const d of readdirSync(archivedDir)) {
            const p = join(archivedDir, d, "goal.md");
            if (existsSync(p)) out.push(p);
          }
        }
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
  // 先搜索非归档目录
  for (const f of listGoalFiles(root)) {
    try {
      if (loadGoal(f).meta.id === id) return f;
    } catch {
      // 解析失败的文件由 validate 报告，这里跳过
    }
  }
  // 再搜索归档目录（归档目标也需要能找到）
  for (const f of listGoalFiles(root, { includeArchived: true })) {
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
  if (opts.write) writeHandoff(root, content);
  return content;
}

/** g-121：HANDOFF 写盘统一入口（graph_handoff 与 claimSupervisor 共用）——
 *  若 <root>/HANDOFF.md 已存在且内容不同，先把旧版归档到 <root>/handoffs/HANDOFF-<ts>.md，
 *  再写新文件。归档目录 handoffs/ 不入 git（仓库根 .gitignore 排除，g-121 判据 2）。 */
export function writeHandoff(root: string, content: string): void {
  const target = join(root, "HANDOFF.md");
  if (existsSync(target) && readFileSync(target, "utf8") !== content) {
    const dir = join(root, "handoffs");
    mkdirSync(dir, { recursive: true });
    const ts = handoffTs();
    copyFileSync(target, join(dir, `HANDOFF-${ts}.md`));
  }
  writeFileSync(target, content, "utf8");
}

/** g-121：文件系统安全的时间戳（YYYYMMDD-HHmmss-fff，本地时区），供归档文件名使用。 */
function handoffTs(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-` +
    `${pad3(d.getMilliseconds())}`
  );
}

/** supervisor 会话交接（g-117）：把 project.yaml 的 supervisor.session 更新为 sessionId，
 *  记 supervisor.claimed 事件（幂等：值未变不重复记事件），并返回 HANDOFF 交接全文。
 *  返回 HANDOFF 时同时落盘（写盘统一走 writeHandoff 归档逻辑，g-121 判据 3）。
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
  return { supervisor_session: sessionId, handoff: generateHandoff(root, { write: true }) };
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

## 质量判据

（待登记；进入 in_progress 前必须非空且已确认）

## 最近指令

<!-- 下一次 attempt 生效的补充任务、边界和验收；新 attempt spawn 前自动读取注入 -->

## 评论

<!-- 可追溯的历史讨论/反馈；不自动注入 prompt，执行者可通过目标文件查看 -->

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
  opts: { title: string; version?: string; description?: string; actor: string },
): string {
  const id = nextGoalSeq(root);
  // g-137：带 version（非 standalone）→ planning；backlog/standalone → draft
  const isStandalone = opts.version === "standalone";
  const initialStatus = (opts.version && !isStandalone) ? "planning" : "draft";
  const meta: Record<string, any> = {
    id,
    title: opts.title,
    status: initialStatus,
    blocked_reason: null,
    created_at: nowIso(),
    created_by: opts.actor,
    version: isStandalone ? null : (opts.version ?? null),
    depends_on: [],
    review: { reviewer: "human", prompt: null },
    pk: { lanes: 1, sandbox: "directory" },
    rules_snapshot: null,
    skill_refs: [],
  };
  let file: string;
  if (isStandalone) {
    // g-129/g-137：创建独立目标 → root/goals/<id>/goal.md，version=null
    file = join(root, "goals", id, "goal.md");
    mkdirSync(join(root, "goals", id), { recursive: true });
  } else if (opts.version) {
    file = join(root, "versions", opts.version, "goals", id, "goal.md");
    mkdirSync(join(root, "versions", opts.version, "goals", id), {
      recursive: true,
    });
    // 隐式版本：version.md 不存在时补骨架（发现#14）
    const vfile = join(root, "versions", opts.version, "version.md");
    if (!existsSync(vfile)) {
      const vId = "v-" + randomUUID().slice(0, 8);
      const vCreatedAt = nowIso();
      saveGoal(vfile, {
        meta: {
          id: vId,
          name: opts.version,
          status: "planning",
          created_at: vCreatedAt,
        },
        body: "\n## 范围\n\n（隐式创建：由 create-goal --version 带入）\n",
      });
      appendEvent(root, {
        actor: opts.actor,
        event: "version.created",
        details: {
          version: opts.version,
          name: opts.version,
          version_id: vId,
          status: "planning",
          created_at: vCreatedAt,
          implicit: true,
        },
      });
    }
  } else {
    file = join(root, "backlog", `${id}.md`);
    mkdirSync(join(root, "backlog"), { recursive: true });
  }
  // g-129: 支持初始描述——有 description 时替换 GOAL_BODY 的目标描述小节占位
  let body = GOAL_BODY;
  if (opts.description?.trim()) {
    body = body.replace(/## 目标描述\n/, `## 目标描述\n\n${opts.description.trim()}\n`);
  }
  saveGoal(file, { meta, body });
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

// ---- 最近指令（directive）与评论（comments）—— g-150 范围扩展 ----
// 设计兼容性：最近指令是 goal 级持久化设置，仅在 graph_start_attempt / start-execution
// 创建新 attempt 时被读取注入。它不影响 send_message 续办既有 agent 会话的路径——
// 小范围 review 修复应优先 send_message 到已有 child，不必新建 attempt（负责人规则）。
// 评论仅写入 goal.md 供人工查看，不自动注入任何 prompt。

/** 读取目标的「最近指令」：从 goal.md body 的 `## 最近指令` 小节提取纯文本。
 *  小节不存在或为空（仅含 HTML 注释/空白）返回 null。 */
export function readGoalDirective(root: string, goalId: string): string | null {
  const file = findGoalFile(root, goalId);
  const doc = loadGoal(file);
  const raw = sectionText(doc.body, "最近指令");
  if (raw === null) return null;
  // 去掉 HTML 注释和首尾空白
  const cleaned = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  return cleaned || null;
}

/** 设置/替换目标的「最近指令」——覆盖 `## 最近指令` 小节内容。
 *  事件先行：先追加 goal.directive_set 事件，再写文件。
 *  directive 为空字符串时清空小节（保留占位 HTML 注释）。 */
export function setGoalDirective(
  root: string,
  goalId: string,
  directive: string,
  actor: string,
): void {
  if (typeof directive !== "string") throw new GraphError("directive 必须是 string 类型");
  const file = findGoalFile(root, goalId);
  const doc = loadGoal(file);
  const trimmed = directive.trim();
  // 防止 directive 内容包含 ## 标题破坏 section 边界（g-150 返工阻断项 #5）
  const safe = sanitizeHeadingContent(trimmed);
  // 构造小节内容：有实质内容时以空行开头、换行结尾；无内容时保留占位注释
  const sectionContent = safe
    ? `\n${safe}\n\n`
    : `\n<!-- 下一次 attempt 生效的补充任务、边界和验收；新 attempt spawn 前自动读取注入 -->\n\n`;
  try {
    doc.body = replaceSection(doc.body, "最近指令", sectionContent);
  } catch {
    // 小节不存在（老目标模板）：追加到目标描述和质量判据之间
    const marker = "\n## 质量判据\n";
    const idx = doc.body.indexOf(marker);
    if (idx >= 0) {
      doc.body = doc.body.slice(0, idx) + `\n## 最近指令\n${sectionContent}` + doc.body.slice(idx);
    } else {
      // 都没有则追加到末尾
      doc.body = doc.body.replace(/\n*$/, "") + `\n\n## 最近指令\n${sectionContent}`;
    }
  }
  // 事件先行
  appendEvent(root, {
    actor,
    event: "goal.directive_set",
    goal: goalId,
    details: { directive: trimmed || null },
  });
  saveGoal(file, doc);
}

/** 读取目标的「评论」历史：从 goal.md body 的 `## 评论` 小节解析结构化评论列表。
 *  评论以 `### <时间> | <作者>` 开头分隔，正文到下一个 ### 或小节末尾。
 *  无评论或小节不存在返回空数组。 */
export function readGoalComments(root: string, goalId: string): Array<{ ts: string; author: string; text: string }> {
  const file = findGoalFile(root, goalId);
  const doc = loadGoal(file);
  const raw = sectionText(doc.body, "评论");
  if (raw === null) return [];
  const cleaned = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!cleaned) return [];
  const comments: Array<{ ts: string; author: string; text: string }> = [];
  const lines = cleaned.split("\n");
  let current: { ts: string; author: string; text: string } | null = null;
  for (const line of lines) {
    const m = /^###\s+(.+?)\s*\|\s*(.+)$/.exec(line.trim());
    if (m) {
      if (current) comments.push(current);
      current = { ts: m[1].trim(), author: m[2].trim(), text: "" };
    } else if (current) {
      current.text += (current.text ? "\n" : "") + line;
    }
  }
  if (current) comments.push(current);
  // 清理每条评论的首尾空白
  for (const c of comments) c.text = c.text.trim();
  return comments;
}

/** 向目标的「评论」小节追加一条评论。
 *  事件先行：先追加 goal.comment_added 事件，再写文件。 */
export function appendGoalComment(
  root: string,
  goalId: string,
  text: string,
  actor: string,
): void {
  if (typeof text !== "string" || !text.trim()) throw new GraphError("评论内容不能为空");
  const file = findGoalFile(root, goalId);
  const doc = loadGoal(file);
  const ts = nowIso();
  const authorLabel = actor.replace(/^human:/, "").replace(/^supervisor:/, "主管:").replace(/^agent:/, "Agent:");
  // 防止评论内容包含 ## / ### 标题破坏 section 边界（g-150 返工阻断项 #5）
  const safeText = sanitizeHeadingContent(text.trim());
  const entry = `\n### ${ts} | ${authorLabel}\n\n${safeText}\n`;
  // 事件先行
  appendEvent(root, {
    actor,
    event: "goal.comment_added",
    goal: goalId,
    details: { text: text.trim(), ts },
  });
  const raw = sectionText(doc.body, "评论");
  if (raw === null) {
    // 小节不存在（老目标模板）：追加到末尾
    doc.body = doc.body.replace(/\n*$/, "") + `\n\n## 评论\n${entry}\n`;
  } else {
    // 追加到现有小节末尾
    const sectionContent = raw.replace(/<!--[\s\S]*?-->/g, "").trimEnd();
    const newContent = (sectionContent ? `\n${sectionContent}` : "") + entry + "\n";
    try {
      doc.body = replaceSection(doc.body, "评论", newContent);
    } catch {
      // 不应到这里，但保底
      doc.body = doc.body.replace(/\n*$/, "") + entry;
    }
  }
  saveGoal(file, doc);
}

/** 格式化最近指令注入段（供执行派发 prompt）。
 *  无指令时返回空字符串（调用方条件拼接，不影响无指令 prompt）。 */
export function formatGoalDirectiveSection(root: string, goalId: string): string {
  const directive = readGoalDirective(root, goalId);
  if (!directive) return "";
  return `## 最近指令（g-150 注入：目标 ${goalId} 的当前补充约束）\n\n${directive}\n`;
}

/** 状态迁移：状态机校验 → 写回 frontmatter（保留正文）→ 追加事件。 */
export function transition(
  root: string,
  id: string,
  to: string,
  opts: { reason?: string; actor: string; force?: boolean },
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
    force: opts.force,
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
    // 目标描述小节重复检查（g-130）：行首锚定的独立小节标题，正文内引用不计
    const descMatches = doc.body.match(/^## 目标描述$/gm);
    if (descMatches && descMatches.length > 1) {
      problems.push(`${id}: 目标描述小节重复`);
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
  const events = readEvents(root);
  const replayed = replayStatuses(events);
  const versionLanes = replayVersionLanes(events);
  const drift: string[] = [];

  // 目标状态对账
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

  // 版本泳道对账：事件流中存活但磁盘缺失 → 需恢复
  for (const [slug, lane] of versionLanes) {
    if (!lane.alive) continue; // 已删除版本无需对账
    const vdir = join(root, "versions", slug);
    const vfile = join(vdir, "version.md");
    if (!existsSync(vfile)) {
      drift.push(`版本 ${slug}: 事件流中存活但 version.md 缺失，需从事件恢复`);
      // 从事件重建版本目录与 version.md
      mkdirSync(join(vdir, "goals"), { recursive: true });
      const body = "\n## 范围\n\n（由 rebuild 从事件流恢复）\n";
      const doc: GoalDoc = { meta: lane.meta, body };
      writeFileSync(vfile, serializeDoc(doc), "utf8");
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
  
  // g-145：绑定保护——如果卡片处于 collecting 状态且有 child_id，
  // 则只有绑定的 child 或非 collect agent（human/supervisor 通过工具调用）可以填充。
  // human actor 以 "human:" 开头；supervisor/其他 agent 以 "agent:" 开头但 by !== child_id。
  // 区分方式：绑定 child 的 by === child_id 或 by === "agent:" + child_id → 直接放行；human → 放行；其余 → mismatch 软事件。
  if (doc.meta.status === "collecting" && doc.meta.child_id) {
    const isBoundChild = opts.by === doc.meta.child_id || opts.by === `agent:${doc.meta.child_id}`;
    const isHuman = opts.actor.startsWith("human:");
    if (!isBoundChild && !isHuman) {
      appendEvent(root, {
        actor: opts.actor,
        event: "card.fill_mismatch",
        goal: goalId,
        details: {
          card: cardId,
          by: opts.by,
          expected_child: doc.meta.child_id,
          message: "填充者与绑定的 child 不匹配"
        },
      });
    }
  }
  
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

// ---- 已收集卡片成果注入（g-120） ----

export interface HarvestedCard {
  id: string;
  title: string;
  kind: string;
  status: string;
  summary: string | null;
  /** 卡片正文全文（trim 后；空卡片为 ""） */
  content: string;
}

/** 按 context_cards 顺序读取 filled/reviewed 卡片的成果（title+summary+正文全文），
 *  跳过 empty/collecting；无成果卡片时返回空数组（g-120）。
 *  悬空引用与坏卡片跳过（由 validate 报告），不在此抛错。 */
export function harvestedCards(root: string, goalId: string): HarvestedCard[] {
  const file = findGoalFile(root, goalId);
  const dir = basename(file) === "goal.md" ? dirname(file) : null;
  if (!dir) return [];
  const doc = loadGoal(file);
  const refs = Array.isArray(doc.meta.context_cards) ? doc.meta.context_cards : [];
  const out: HarvestedCard[] = [];
  for (const ref of refs) {
    const id = String(ref);
    const cardFile = join(dir, "cards", `${id}.md`);
    if (!existsSync(cardFile)) continue; // 悬空引用（validate 管）
    try {
      const card = loadGoal(cardFile);
      const status = String(card.meta.status ?? "");
      if (status !== "filled" && status !== "reviewed") continue; // 跳过 empty/collecting
      out.push({
        id,
        title: String(card.meta.title ?? id),
        kind: String(card.meta.kind ?? ""),
        status,
        summary: card.meta.summary ?? null,
        content: card.body.trim(),
      });
    } catch {
      /* 坏卡片跳过（validate 管） */
    }
  }
  return out;
}

/** 生成「已收集上下文卡片成果」注入段（g-120，供执行派发 prompt）：按 context_cards 顺序
 *  列出每张卡的 title/summary/正文全文，子代理直接使用、无需猜卡片路径。
 *  无 filled/reviewed 卡片时返回带「（无）」说明的短段（恒非 null，调用方总能注入）。 */
export function formatHarvestedCardsSection(root: string, goalId: string): string {
  const cards = harvestedCards(root, goalId);
  if (cards.length === 0) {
    return [
      `## 已收集上下文卡片成果（g-120 注入）`,
      ``,
      `（无：context_cards 为空或没有 filled/reviewed 卡片，无需复用，直接按目标描述/判据执行）`,
    ].join("\n");
  }
  const items = cards.map((c, i) => {
    const meta = [
      `id=${c.id}`,
      `status=${c.status}`,
      c.kind ? `kind=${c.kind}` : null,
      c.summary ? `摘要：${c.summary}` : null,
    ].filter(Boolean).join("，");
    const body = c.content
      ? c.content.split("\n").map((l) => `  ${l}`).join("\n")
      : "  （正文为空）";
    return `- **${c.title}**（${meta}）\n${body}`;
  });
  return [
    `## 已收集上下文卡片成果（g-120 注入：按 context_cards 顺序，子代理直接使用，无需猜卡片路径）`,
    ``,
    items.join("\n\n"),
  ].join("\n");
}

// ---- Attempt Handoff（g-150，单文件简化） ----

/** 手动确认的 attempt 返工 handoff 记录（主管/负责人登记，可注入新 attempt prompt）。
 *  每个 goal 仅保留一个当前有效 handoff（handoff.md），新登记覆盖旧内容。 */
export interface AttemptHandoff {
  id: string;
  goal: string;
  status: "confirmed";
  source_attempts: string[];
  confirmed_by: string;
  confirmed_at: string;
  revision: number;
  /** 已核实失败/风险 */
  failures: string;
  /** 返工约束（禁止项） */
  constraints: string;
  /** 推荐基线/必须保留项 */
  baseline: string;
  /** 验收命令 */
  verification: string;
}

/** handoff 文件的正文模板（结构化可读指令，供新执行者阅读）。 */
function handoffBody(h: AttemptHandoff): string {
  const lines: string[] = [];
  lines.push(`## 已核实失败/风险`);
  lines.push(``);
  lines.push(h.failures);
  lines.push(``);
  lines.push(`## 返工约束（禁止项）`);
  lines.push(``);
  lines.push(h.constraints);
  lines.push(``);
  lines.push(`## 推荐基线/必须保留项`);
  lines.push(``);
  lines.push(h.baseline);
  lines.push(``);
  lines.push(`## 验收命令`);
  lines.push(``);
  lines.push(h.verification);
  lines.push(``);
  lines.push(`## 来源与裁决说明`);
  lines.push(``);
  lines.push(`来源 attempt：${h.source_attempts.join(", ") || "（无）"}`);
  lines.push(`确认人：${h.confirmed_by}`);
  lines.push(`确认时间：${h.confirmed_at}`);
  return lines.join("\n");
}

/** 校验 confirmed_by 是否为可信的确认来源（g-150 review 问题 1）。
 *  可信来源：① human:* 类型的 actor（如 human:gui，负责人 GUI 操作）；
 *  ② supervisor:<sessionId> 格式且 sessionId 匹配 project.yaml 的 supervisor.session。
 *  不可信来源（如 agent:*）会被拒绝，防止任意 caller 伪造确认身份。 */
function validateConfirmedBy(root: string, confirmed_by: string): void {
  if (!confirmed_by || !confirmed_by.trim()) {
    throw new GraphError("confirmed_by 不能为空");
  }
  // human:* 类型是可信的（负责人直接操作）
  if (confirmed_by.startsWith("human:")) return;
  // supervisor:<sessionId> 需要校验 sessionId 匹配 project.yaml 的 supervisor.session
  if (confirmed_by.startsWith("supervisor:")) {
    const sessionId = confirmed_by.slice("supervisor:".length);
    const configuredSession = readSupervisorSession(root);
    if (configuredSession && sessionId === configuredSession) return;
    // 未配置 supervisor.session 时，允许 supervisor:* 前缀（首次 claim 前的引导阶段）
    if (!configuredSession) return;
    throw new GraphError(
      `确认身份 ${confirmed_by} 不匹配已配置的 supervisor.session（${configuredSession}）——只有已 claim 的主管会话或负责人可确认 handoff`,
    );
  }
  // 本地可信工作区：agent:* 格式允许（g-150 返工阻断项 #1）
  // confirmed_by 仅为审计溯源字段，不作为安全边界
  if (confirmed_by.startsWith("agent:")) return;
  // 其他未知前缀仍拒绝
  throw new GraphError(
    `确认身份 ${confirmed_by} 前缀未知——仅支持 human:*、supervisor:* 或 agent:*`,
  );
}

/** 主管/负责人登记 attempt handoff（g-150，单文件简化）。
 *  每个 goal 仅一个 handoff.md；新登记覆盖旧内容（旧历史由事件流保留）。
 *  事件先行：确认事件在 handoff 文件写入之前追加。 */
export function recordAttemptHandoff(
  root: string,
  goalId: string,
  opts: {
    source_attempts: string[];
    failures: string;
    constraints: string;
    baseline: string;
    verification: string;
    confirmed_by: string;
    actor: string;
  },
): string {
  // 校验确认身份可信
  validateConfirmedBy(root, opts.confirmed_by);

  // 校验 source attempts 属于该 goal
  const goalFile = findGoalFile(root, goalId);
  const dir = goalDirOf(goalFile);
  for (const att of opts.source_attempts) {
    const attFile = join(dir, "attempts", att, "attempt.md");
    if (!existsSync(attFile)) {
      throw new GraphError(`来源 attempt 不存在：${att}（目标 ${goalId}）`);
    }
  }

  const now = nowIso();
  const hfFile = join(dir, "handoff.md");
  const isNew = !existsSync(hfFile);

  // 读旧 handoff 的 revision（覆盖时递增）
  let revision = 1;
  if (!isNew) {
    try {
      const oldDoc = loadGoal(hfFile);
      const oldRev = (oldDoc.meta as Record<string, unknown>).revision;
      if (typeof oldRev === "number" && oldRev >= 1) revision = oldRev + 1;
    } catch { /* 坏文件从 1 开始 */ }
  }

  const handoff: AttemptHandoff = {
    id: "handoff",
    goal: goalId,
    status: "confirmed",
    source_attempts: opts.source_attempts,
    confirmed_by: opts.confirmed_by,
    confirmed_at: now,
    revision,
    failures: opts.failures,
    constraints: opts.constraints,
    baseline: opts.baseline,
    verification: opts.verification,
  };

  // 事件先行：先写确认事件，再写 handoff 文件
  appendEvent(root, {
    actor: opts.actor,
    event: "attempt.handoff.confirmed",
    goal: goalId,
    details: {
      handoff: "handoff",
      revision,
      source_attempts: opts.source_attempts,
      overwrote_previous: !isNew,
    },
  });

  // 写 handoff 文件（覆盖）
  saveGoal(hfFile, { meta: handoff, body: handoffBody(handoff) });

  return "handoff";
}

/** 读取目标的当前有效 attempt handoff（g-150，单文件简化）。
 *  优先读 <goal>/handoff.md；若不存在则兼容读取遗留 handoffs/ 目录中最新 confirmed。
 *  malformed 数据安全降级，不崩溃。 */
export function harvestReviewedAttemptHandoffs(root: string, goalId: string): AttemptHandoff[] {
  const goalFile = findGoalFile(root, goalId);
  const dir = goalDirOf(goalFile);

  // 优先：单文件 handoff.md
  const singleFile = join(dir, "handoff.md");
  if (existsSync(singleFile)) {
    try {
      const doc = loadGoal(singleFile);
      const raw = doc.meta as Record<string, unknown>;
      if (raw.status === "confirmed" && raw.id && raw.confirmed_by && raw.confirmed_at) {
        const h: AttemptHandoff = {
          id: String(raw.id) || "handoff",
          goal: goalId,
          status: "confirmed",
          source_attempts: Array.isArray(raw.source_attempts) ? raw.source_attempts as string[] : [],
          confirmed_by: String(raw.confirmed_by),
          confirmed_at: String(raw.confirmed_at),
          revision: typeof raw.revision === "number" ? raw.revision : 1,
          failures: String(raw.failures ?? ""),
          constraints: String(raw.constraints ?? ""),
          baseline: String(raw.baseline ?? ""),
          verification: String(raw.verification ?? ""),
        };
        if (h.failures && h.constraints && h.baseline && h.verification) return [h];
      }
    } catch { /* 坏文件跳过 */ }
  }

  // 兼容遗留：handoffs/ 目录下多个文件，取最新 confirmed
  const handoffsDir = join(dir, "handoffs");
  if (!existsSync(handoffsDir)) return [];
  const files = readdirSync(handoffsDir).filter((f) => f.startsWith("hf-") && f.endsWith(".md"));
  const all: AttemptHandoff[] = [];
  for (const f of files) {
    try {
      const doc = loadGoal(join(handoffsDir, f));
      const raw = doc.meta as Record<string, unknown>;
      if (raw.status !== "confirmed") continue;
      if (raw.superseded_by != null) continue;
      if (!raw.id || !raw.confirmed_by || !raw.confirmed_at) continue;
      if (!Array.isArray(raw.source_attempts) || !raw.failures || !raw.constraints || !raw.baseline || !raw.verification) continue;
      const supersedes = Array.isArray(raw.supersedes)
        ? (raw.supersedes as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      // 用 superseded 事件和 supersedes 链排除被淘汰的
      const supersededEvents = readEvents(root).filter(
        (e) => e.event === "attempt.handoff.superseded" && e.goal === goalId,
      );
      const supersededIds = new Set(supersededEvents.map((e) => e.details?.old_handoff).filter(Boolean));
      if (supersededIds.has(raw.id as string)) continue;
      // 检查是否被其他 handoff 的 supersedes 引用
      const isSupersededByOther = files.some((other) => {
        if (other === f) return false;
        try {
          const otherDoc = loadGoal(join(handoffsDir, other));
          const otherMeta = otherDoc.meta as Record<string, unknown>;
          if (otherMeta.status !== "confirmed") return false;
          const otherSupersedes = Array.isArray(otherMeta.supersedes) ? otherMeta.supersedes as string[] : [];
          return otherSupersedes.includes(raw.id as string);
        } catch { return false; }
      });
      if (isSupersededByOther) continue;
      all.push({
        id: raw.id as string,
        goal: goalId,
        status: "confirmed",
        source_attempts: raw.source_attempts as string[],
        confirmed_by: raw.confirmed_by as string,
        confirmed_at: raw.confirmed_at as string,
        revision: typeof raw.revision === "number" ? raw.revision : 1,
        failures: raw.failures as string,
        constraints: raw.constraints as string,
        baseline: raw.baseline as string,
        verification: raw.verification as string,
      });
    } catch { /* 坏文件跳过 */ }
  }
  if (all.length === 0) return [];
  // 取最新
  all.sort((a, b) => a.confirmed_at.localeCompare(b.confirmed_at));
  return [all[all.length - 1]];
}

/** 格式化已确认 handoff 注入段（g-150，供执行派发 prompt）。
 *  无有效 handoff 时返回空字符串（调用方条件拼接，不影响无历史 prompt）。 */
export function formatReviewedAttemptHandoffsSection(root: string, goalId: string): string {
  const handoffs = harvestReviewedAttemptHandoffs(root, goalId);
  if (handoffs.length === 0) return "";

  const h = handoffs[0]; // 单文件简化：最多一个
  const meta = [
    `来源 attempt：${h.source_attempts.join(", ")}`,
    `确认人：${h.confirmed_by}`,
    `确认时间：${h.confirmed_at}`,
    `revision：${h.revision}`,
  ].filter(Boolean).join("；");

  const sections = [
    `## 前序 attempt 已确认 handoff（g-150 注入：仅主管/负责人确认的返工约束，非 agent 自述）`,
    ``,
    `（${meta}）`,
    ``,
    `**已核实失败/风险：**`,
    ...h.failures.split("\n").map((l) => `${l}`),
    ``,
    `**返工约束（禁止项）：**`,
    ...h.constraints.split("\n").map((l) => `${l}`),
    ``,
    `**推荐基线/必须保留项：**`,
    ...h.baseline.split("\n").map((l) => `${l}`),
    ``,
    `**验收命令：**`,
    ...h.verification.split("\n").map((l) => `${l}`),
  ];
  return sections.join("\n");
}

/** 生成收集子代理的完整提示词（g-145）：注入仓库根、goal/card 元数据、收集范围、
 *  精确回填模板和禁区。用户提供的 prompt 作为附加要求追加在末尾。 */
export function formatCollectPrompt(
  root: string,
  goalId: string,
  cardId: string,
  userPrompt?: string,
): string {
  // 加载 goal 和 card 元数据
  const goalFile = findGoalFile(root, goalId);
  const goalDoc = loadGoal(goalFile);
  const goalTitle = goalDoc.meta.title ?? goalId;
  
  const cardFile = join(goalDirOf(goalFile), "cards", `${cardId}.md`);
  if (!existsSync(cardFile)) {
    throw new GraphError(`卡片不存在：${cardId}（目标 ${goalId}）`);
  }
  const cardDoc = loadGoal(cardFile);
  const cardTitle = cardDoc.meta.title ?? cardId;
  const cardKind = cardDoc.meta.kind ?? "text";
  
  // 构建结构化提示词
  const sections = [
    `## 收集任务上下文`,
    ``,
    `**工作目录**：当前分配的 worktree/当前工作目录（不要猜测 .dsh-graph 文件路径）`,
    ``,
    `**目标信息**：`,
    `- id: \`${goalId}\``,
    `- 标题: ${goalTitle}`,
    ``,
    `**卡片信息**：`,
    `- id: \`${cardId}\``,
    `- 标题: ${cardTitle}`,
    `- 类型: ${cardKind}`,
    ``,
    `**收集范围**：`,
    `请收集与卡片「${cardTitle}」相关的详细上下文信息，用于填充该卡片。`,
    ``,
    `**回填要求**：`,
    `1. 全文写进 \`text\` 参数`,
    `2. \`summary\` 写一句话要点式摘要（≤100 字左右），不要长文`,
    `3. 完成后必须调用以下精确命令回填结果：`,
    `\`\`\``,
    `graph_fill_card(goal="${goalId}", card="${cardId}", text=<全文>, summary=<≤100字摘要>)`,
    `\`\`\``,
    ``,
    `**禁区（严格遵守）**：`,
    `1. 不得猜测 \`.dsh-graph\` 文件路径——所有路径已在上方提供`,
    `2. 不得修改其他 goal 或 card——只能回填当前绑定的卡片 \`${cardId}\``,
    `3. 不得自行调用 \`graph_review_card\`——完成后由 supervisor 复核`,
    `4. 所有 graph 工具操作必须在当前分配的 worktree/当前工作目录下运行`,
  ];
  
  // 如果有用户提供的附加要求，追加在末尾
  if (userPrompt && userPrompt.trim()) {
    sections.push(
      ``,
      `**用户附加要求**：`,
      userPrompt.trim(),
    );
  }
  
  return sections.join("\n");
}

/** 获取卡片元数据（供 GUI 收集 prompt 使用） */
export function getCardMeta(
  root: string,
  goalId: string,
  cardId: string,
): { title: string; kind: string; goalTitle: string } {
  const goalFile = findGoalFile(root, goalId);
  const goalDoc = loadGoal(goalFile);
  const goalTitle = goalDoc.meta.title ?? goalId;
  
  const cardFile = join(goalDirOf(goalFile), "cards", `${cardId}.md`);
  if (!existsSync(cardFile)) {
    throw new GraphError(`卡片不存在：${cardId}（目标 ${goalId}）`);
  }
  const cardDoc = loadGoal(cardFile);
  const cardTitle = cardDoc.meta.title ?? cardId;
  const cardKind = cardDoc.meta.kind ?? "text";
  
  return { title: cardTitle, kind: cardKind, goalTitle };
}

// ---- Attempt（SCHEMA §3） ----

const ATTEMPT_BODY = `
## 执行笔记

（执行者自由记录）

## Review 记录

<!-- 受管小节 -->
`;

/** 创建 attempt 目录与 attempt.md，追加 attempt.started 事件；返回 attempt id。
 *  opts.injectedCards：已注入执行子代理 prompt 的卡片 id 清单（按注入顺序，g-120）；
 *  提供时记入 attempt.started 的 details.injected_cards（含空数组＝明确注入零张）。
 *  opts.injectedHandoffs：已注入执行子代理 prompt 的 handoff 引用清单（g-150）；
 *  提供时记入 attempt.started 的 details.injected_handoffs 与 attempt.md meta。
 *  opts.attemptBrief：主管为本次 attempt 提供的可审计 brief/directive（g-150）；
 *  提供时记入 attempt.started 的 details.brief 与 attempt.md meta。
 *  opts.injectedDirective：从 goal.md「最近指令」小节读取并注入 prompt 的内容快照（g-150 范围扩展）；
 *  提供时记入 attempt.started 的 details.injected_directive 与 attempt.md meta。 */
export function startAttempt(
  root: string,
  goalId: string,
  opts: {
    executor: string;
    actor: string;
    injectedCards?: string[];
    injectedHandoffs?: Array<{ id: string; revision: number; source_attempts: string[] }>;
    attemptBrief?: string;
    injectedDirective?: string;
  },
): string {
  // 校验 attemptBrief 类型（g-150 review 问题 4：必须是 string 或 undefined，不可是其他类型）
  if (opts.attemptBrief !== undefined && typeof opts.attemptBrief !== "string") {
    throw new GraphError("attemptBrief 必须是 string 类型");
  }
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
  // g-150：写入 injected_handoffs 和 brief 到 attempt meta（审计可追溯）
  // 无 handoff/brief 时保持当前 prompt 兼容（g-150 review 问题 5）
  if (Array.isArray(opts.injectedHandoffs)) {
    meta.injected_handoffs = opts.injectedHandoffs;
  }
  if (opts.attemptBrief && opts.attemptBrief.trim()) {
    meta.brief = opts.attemptBrief;
  }
  // g-150 范围扩展：写入最近指令快照到 attempt meta（审计可追溯）
  if (opts.injectedDirective && opts.injectedDirective.trim()) {
    meta.injected_directive = opts.injectedDirective.trim();
  }
  saveGoal(join(attDir, "attempt.md"), { meta, body: ATTEMPT_BODY });
  const details: Record<string, any> = {
    attempt: attId,
    executor: opts.executor,
    ...(Array.isArray(opts.injectedCards)
      ? { injected_cards: opts.injectedCards }
      : {}),
    // 空值表达一致（g-150 review 问题 4）：有 injectedHandoffs 且非空时记录，空数组也明确记录
    ...(Array.isArray(opts.injectedHandoffs)
      ? { injected_handoffs: opts.injectedHandoffs }
      : {}),
    ...(opts.attemptBrief && opts.attemptBrief.trim()
      ? { brief: opts.attemptBrief }
      : {}),
    // g-150 范围扩展：记录注入的最近指令快照
    ...(opts.injectedDirective && opts.injectedDirective.trim()
      ? { injected_directive: opts.injectedDirective.trim() }
      : {}),
  };
  appendEvent(root, {
    actor: opts.actor,
    event: "attempt.started",
    goal: goalId,
    details,
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
  // g-137：记录迁移前状态，迁移后根据目标位置调整状态
  const prevStatus = doc.meta.status as string;
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
    // g-137：进 backlog → 状态变为 draft
    if (prevStatus !== "draft") {
      doc.meta.status = "draft";
    }
  } else if (opts.to === "standalone") {
    targetFile = join(root, "goals", id, "goal.md");
    targetDirForm = true;
    doc.meta.version = null;
    // g-147：只有从 backlog（draft 状态）进入时才变为 planning
    if (prevStatus === "draft") {
      doc.meta.status = "planning";
    }
  } else if (opts.to === "version") {
    if (!opts.version) throw new GraphError("移动到版本需要指定 version");
    targetFile = join(root, "versions", opts.version, "goals", id, "goal.md");
    targetDirForm = true;
    doc.meta.version = opts.version;
    // g-147：只有从 backlog（draft 状态）进入时才变为 planning
    if (prevStatus === "draft") {
      doc.meta.status = "planning";
    }
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

// ---- 目标归档/取消归档（g-110） ----

/** 归档目标：仅 draft/planning/delivered 可归档；移动到对应 archived 目录。
 *  版本 goals→versions/vX/archived/<id>/；standalone→goals/archived/<id>/；backlog→backlog/archived/<id>.md。
 *  归档后目标保持原状态不变，记 goal.archived 事件。 */
export function archiveGoal(
  root: string,
  id: string,
  opts: { actor: string },
): void {
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  const status = doc.meta.status as string;
  // 只有 draft/planning/delivered 可归档
  if (!["draft", "planning", "delivered"].includes(status)) {
    throw new GraphError(`目标 ${id} 当前状态为 ${status}，只有 draft/planning/delivered 可归档`);
  }
  const srcDir = basename(file) === "goal.md" ? dirname(file) : null;
  const rel = file.slice(root.length + 1);
  const parts = rel.split("/");
  let targetFile: string;
  if (parts[0] === "versions") {
    // 版本目标 → versions/vX/archived/<id>/goal.md
    const ver = parts[1];
    targetFile = join(root, "versions", ver, "archived", id, "goal.md");
  } else if (parts[0] === "goals") {
    // 独立目标 → goals/archived/<id>/goal.md
    targetFile = join(root, "goals", "archived", id, "goal.md");
  } else if (parts[0] === "backlog") {
    // backlog 目标 → backlog/archived/<id>.md
    targetFile = join(root, "backlog", "archived", `${id}.md`);
  } else {
    throw new GraphError(`无法确定目标 ${id} 的当前位置：${rel}`);
  }
  if (existsSync(targetFile)) throw new GraphError(`归档位置已存在：${targetFile}`);
  // 标记已归档
  doc.meta.archived = true;
  mkdirSync(dirname(targetFile), { recursive: true });
  if (srcDir) {
    // 目录形态：整体移动目录（cards/ attempts/ 一起走）
    renameSync(srcDir, dirname(targetFile));
  } else {
    renameSync(file, targetFile);
  }
  saveGoal(targetFile, doc);
  appendEvent(root, {
    actor: opts.actor,
    event: "goal.archived",
    goal: id,
    details: { from: relative(root, file), to: relative(root, targetFile), status },
  });
}

/** 取消归档：移回原位置（版本 goals/、独立 goals/、backlog/），状态保持原样。
 *  从 archived 目录移出，清除 archived 标记，记 goal.unarchived 事件。 */
export function unarchiveGoal(
  root: string,
  id: string,
  opts: { actor: string },
): void {
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  if (!doc.meta.archived) {
    throw new GraphError(`目标 ${id} 未归档，无需取消归档`);
  }
  const rel = file.slice(root.length + 1);
  const parts = rel.split("/");
  let targetFile: string;
  if (parts[0] === "versions" && parts[1] === "archived") {
    // versions/archived/<id>/goal.md → 需要知道原版本，从 meta.version 取
    const ver = doc.meta.version;
    if (!ver) throw new GraphError(`归档目标 ${id} 缺少 version 字段，无法恢复到版本目录`);
    targetFile = join(root, "versions", ver, "goals", id, "goal.md");
  } else if (parts[0] === "versions" && parts[2] === "archived") {
    // versions/vX/archived/<id>/goal.md → versions/vX/goals/<id>/goal.md
    const ver = parts[1];
    targetFile = join(root, "versions", ver, "goals", id, "goal.md");
  } else if (parts[0] === "goals" && parts[1] === "archived") {
    // goals/archived/<id>/goal.md → goals/<id>/goal.md
    targetFile = join(root, "goals", id, "goal.md");
  } else if (parts[0] === "backlog" && parts[1] === "archived") {
    // backlog/archived/<id>.md → backlog/<id>.md
    targetFile = join(root, "backlog", `${id}.md`);
  } else {
    throw new GraphError(`无法确定归档目标 ${id} 的位置：${rel}`);
  }
  if (existsSync(targetFile)) throw new GraphError(`恢复位置已存在：${targetFile}`);
  // 清除归档标记
  doc.meta.archived = false;
  const srcDir = basename(file) === "goal.md" ? dirname(file) : null;
  mkdirSync(dirname(targetFile), { recursive: true });
  if (srcDir) {
    // 目录形态：整体移动目录（cards/ attempts/ 一起走）
    renameSync(srcDir, dirname(targetFile));
  } else {
    renameSync(file, targetFile);
  }
  saveGoal(targetFile, doc);
  appendEvent(root, {
    actor: opts.actor,
    event: "goal.unarchived",
    goal: id,
    details: { from: relative(root, file), to: relative(root, targetFile) },
  });
}

/** 判断目标文件是否在 archived 目录下。 */
function isArchivedFile(file: string): boolean {
  return file.includes("/archived/") || file.includes("\\archived\\");
}

// ---- 目标删除（g-140） ----

/** 删除已归档目标：仅已归档（在 archived 目录下）且无活跃子代理（所有 attempt result !== "pending"）的目标可删除。
 *  删除 = 删目标目录（含 cards/attempts） + 记 goal.deleted 事件（R-02，details 含 id）。
 *  backlog 平铺文件（无目录）直接删文件 + 记事件。 */
export function deleteGoal(
  root: string,
  id: string,
  opts: { actor: string },
): void {
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  // 前置校验 1：仅已归档目标可删除
  if (!isArchivedFile(file) && !doc.meta.archived) {
    throw new GraphError(`目标 ${id} 未归档，不能删除——请先归档再删除`);
  }
  // 前置校验 2：不能有活跃子代理——注意 result=pending 不视为活跃（pending 可能空闲/已完成，
  // result 恒为 pending 不更新，负责人 2026-08-23）。仅当子代理 status_line 仍在进行中
  // （未表明 空闲/完成/待命/已交付 等结束态）才视为活跃。
  const dir = basename(file) === "goal.md" ? dirname(file) : null;
  if (dir) {
    const attDir = join(dir, "attempts");
    if (existsSync(attDir)) {
      for (const d of readdirSync(attDir)) {
        if (!d.startsWith("att-")) continue;
        const attFile = join(attDir, d, "attempt.md");
        if (!existsSync(attFile)) continue;
        try {
          const att = loadGoal(attFile);
          const sl = String(att.meta.status_line ?? "").trim();
          const done = /空闲|完成|待命|已交付|结束|等待|finished|done|idle|completed/i.test(sl);
          if (att.meta.result === "pending" && sl !== "" && !done) {
            throw new GraphError(
              `目标 ${id} 有进行中的子代理 ${d}（status_line="${sl}"），不能删除——请先停止或等其结束`,
            );
          }
        } catch (e) {
          if (e instanceof GraphError) throw e;
          // 坏的 attempt 文件跳过
        }
      }
    }
  }
  // 执行删除
  if (dir) {
    // 目录形态：删整个目标目录（含 cards/ attempts/）
    rmSync(dir, { recursive: true, force: true });
  } else {
    // backlog 平铺文件：直接删文件
    rmSync(file, { force: true });
  }
  // 记 goal.deleted 事件（R-02，details 含 id）
  appendEvent(root, {
    actor: opts.actor,
    event: "goal.deleted",
    goal: id,
    details: { id },
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
  /** 质量判据实质行数（g-77647351 看板「判据未登记」提示数据源）；≥1 即已登记 */
  criteria_count?: number;
  rules_snapshot?: string | null;
  /** g-110：目标是否已归档 */
  archived?: boolean;
}

export interface BoardVersion {
  slug: string;
  id: string | null;
  name: string;
  status: string;
  goals: BoardGoal[];
}

export function boardProjection(root: string, opts?: { includeArchived?: boolean }): {
  generated_at: string;
  versions: BoardVersion[];
  standalone: BoardGoal[];
  backlog: BoardGoal[];
} {
  const includeArchived = opts?.includeArchived ?? false;
  const goalItem = (file: string): BoardGoal => {
    const doc = loadGoal(file);
    const meta = doc.meta;
    const archived = meta.archived === true || isArchivedFile(file);
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
      archived,
      cards,
      criteria_count: countCriteria(doc.body),
      rules_snapshot: meta.rules_snapshot ?? null,
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
      // g-110：归档目标（versions/vX/archived/）
      if (includeArchived) {
        const archivedDir = join(vdir, v, "archived");
        if (existsSync(archivedDir)) {
          for (const g of readdirSync(archivedDir).sort()) {
            const gf = join(archivedDir, g, "goal.md");
            if (!existsSync(gf)) continue;
            try {
              goals.push(goalItem(gf));
            } catch {
              /* 坏目标文件跳过 */
            }
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
      if (g === "archived") {
        // g-110：独立归档目标（goals/archived/）
        if (includeArchived) {
          const archivedDir = join(sdir, "archived");
          for (const ag of readdirSync(archivedDir).sort()) {
            const gf = join(archivedDir, ag, "goal.md");
            if (!existsSync(gf)) continue;
            try {
              standalone.push(goalItem(gf));
            } catch {
              /* 跳过 */
            }
          }
        }
        continue;
      }
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
      if (f === "archived") {
        // g-110：backlog 归档目标（backlog/archived/）
        if (includeArchived) {
          const archivedDir = join(bdir, "archived");
          for (const af of readdirSync(archivedDir).sort()) {
            if (!af.endsWith(".md")) continue;
            try {
              backlog.push(goalItem(join(archivedDir, af)));
            } catch {
              /* 跳过 */
            }
          }
        }
        continue;
      }
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
 *  g-111 B7：从 dsh-graph-host/index.js 移入 core，消除跨包依赖（g-116 合并后单包内复用）。
 *  g-110：opts.includeArchived 控制是否包含已归档目标。 */
export function boardPayload(root: string, opts?: { includeArchived?: boolean }) {
  return {
    ...boardProjection(root, opts),
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
  // g-150：读取最近指令和评论历史
  const directive = readGoalDirective(root, goalId);
  const comments = readGoalComments(root, goalId);
  // g-150：读取当前有效 handoff
  const handoffs = harvestReviewedAttemptHandoffs(root, goalId);
  const handoff = handoffs.length > 0 ? handoffs[0] : null;
  return {
    meta: doc.meta,
    body: doc.body,
    cards,
    attempts,
    events,
    goalFile: file,  // g-129: 暴露 goal.md 路径（绝对路径）
    directive,
    comments,
    handoff,
  };
}

/**
 * 规范化 appendDescription 文本：
 * 1. 开头 ## / # 标题 → 剥离标题保留正文（### 开头不剥离）
 * 2. 只含标题无正文 → 抛 GraphError
 * 3. 正文中 h2 → 降级为 h3（代码围栏内不处理）
 * 4. 首尾空行清理
 */
export function normalizeAppend(raw: string): { text: string; normalized: boolean } {
  let text = raw;
  let normalized = false;

  // 1. 剥离开头的 h1/h2 标题（保留正文）
  //    /^#{1,2}[ \t]+\S/ 匹配 # 或 ## 开头的行
  const lines = text.split("\n");
  let startIdx = 0;
  while (startIdx < lines.length && lines[startIdx].trim() === "") {
    startIdx++;
  }
  if (startIdx < lines.length) {
    const firstLine = lines[startIdx];
    // h1 或 h2 开头（但不匹配 ###）
    if (/^[ \t]{0,3}#{1,2}[ \t]+\S/.test(firstLine) && !/^#{3}/.test(firstLine)) {
      // 剥离标题行，保留后续内容
      lines.splice(startIdx, 1);
      normalized = true;
    }
  }

  // 检查是否只含标题无正文
  const afterStrip = lines.join("\n").trim();
  if (afterStrip === "") {
    throw new GraphError("append 只含标题没有正文");
  }

  // 2. 降级正文中 h2 → h3（代码围栏内不处理）
  let inFence = false;
  const fencePattern = /^(`{3,}|~{3,})/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fencePattern.test(line.trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      // 匹配 h2（## 开头）但不匹配 h3+（### 开头）
      if (/^[ \t]{0,3}##[ \t]+/.test(line) && !/^#{3}/.test(line)) {
        lines[i] = line.replace(/^([ \t]{0,3})##([ \t]+)/, "$1###$2");
        normalized = true;
      }
    }
  }

  // 3. 首尾空行清理
  text = lines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "").trim();

  // 确保首行无前导空行
  text = text.trimStart();

  return { text, normalized };
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
  let appendNormalized = false;
  if (opts.appendDescription) {
    // 纯空白视为未传（跳 append 仍记 note）
    if (opts.appendDescription.trim() === "") {
      // 跳过 append，不报错
    } else {
      const { text, normalized } = normalizeAppend(opts.appendDescription);
      appendNormalized = normalized;
      const desc = doc.body.match(/## 目标描述\n([\s\S]*?)(?=\n## |$)/);
      if (desc) {
        doc.body = doc.body.replace(
          /## 目标描述\n([\s\S]*?)(?=\n## |$)/,
          `## 目标描述\n${desc[1].replace(/\n*$/, "")}\n\n${text}\n\n`,
        );
      } else {
        doc.body = doc.body.replace(/\n*$/, "") + "\n\n## 目标描述\n\n" + text + "\n";
      }
    }
  }
  saveGoal(file, doc);
  appendEvent(root, {
    actor: opts.actor,
    event: "goal.amended",
    goal: id,
    details: {
      note: opts.note,
      ...(appendNormalized ? { append_normalized: true } : {}),
    },
  });
}

/** 重命名目标：更新 goal.md 的 meta.title，记 goal.renamed 事件（旧/新标题）。
 *  校验：title 非空、去首尾空白；相同标题视为 no-op（不记事件）。 */
export function renameGoal(
  root: string,
  id: string,
  opts: { title: string; actor: string },
): { old_title: string; new_title: string } {
  const newTitle = opts.title.trim();
  if (!newTitle) throw new GraphError("标题不能为空");
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  const oldTitle = String(doc.meta.title ?? "");
  if (oldTitle === newTitle) return { old_title: oldTitle, new_title: newTitle };
  doc.meta.title = newTitle;
  saveGoal(file, doc);
  appendEvent(root, {
    actor: opts.actor,
    event: "goal.renamed",
    goal: id,
    details: { old_title: oldTitle, new_title: newTitle },
  });
  return { old_title: oldTitle, new_title: newTitle };
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
