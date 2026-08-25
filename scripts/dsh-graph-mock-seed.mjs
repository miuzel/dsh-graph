#!/usr/bin/env node
/**
 * dsh-graph mock seed（g-178）
 * ------------------------------------------------------------------
 * 可重复生成「虚构演示项目 nebula-notes」的看板数据，供 README 截图复现：
 *
 *   - 数据全部虚构（nebula-notes 笔记应用）：无真实 workspace/session/凭据，
 *     所有 child_id / parent_session_id 一律为空；不提交 mock .dsh-graph。
 *   - 输出到仓库外 MOCK_ROOT（默认 /tmp/dsh-graph-mock-demo），可通过环境变量覆盖。
 *   - 用仓库 core 引擎（core/main.ts）生成目标/判据/状态迁移/卡片/attempt/状态汇报，
 *     保证数据形态与引擎 validate 一致；随后做展示层 polish（描述正文、版本名、
 *     评论、类型色、mtime 固定到过去，避免 g-171 更新强调扫光影响构图）。
 *
 * 用法：
 *   node scripts/dsh-graph-mock-seed.mjs             # 生成（幂等：先清空再重建）
 *   node scripts/dsh-graph-mock-seed.mjs --validate  # 生成后跑 core validate + rebuild 对账
 *
 * 截图复现（两图必须同一次 seed、同一 3082 实例、同一主题与固定视口）：
 *   1. MOCK_ROOT=/tmp/dsh-graph-mock-demo CWD=/tmp/dsh-graph-mock-demo \
 *        bash scripts/dev-dsh-instance.sh run --port 3082
 *   2. 等看板稳定渲染（旧数据 mtime 已固定为过去，不会触发更新强调扫光）后：
 *        screenshot/screenshot-1.png ← 看板全景（含版本泳道/backlog/独立目标）
 *        screenshot/screenshot-2.png ← 点击 g-006（收集列「就绪」）打开目标详情弹窗
 *   3. 脱敏检查：图片中不出现真实 workspace 路径、会话 id 或凭据。
 */

import { execFileSync } from "node:child_process";
import {
  readdirSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  statSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---- 常量 ----
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const CORE_MAIN = path.join(REPO_ROOT, "core", "main.ts");
const MOCK_ROOT = process.env.MOCK_ROOT ?? "/tmp/dsh-graph-mock-demo";
const GRAPH = path.join(MOCK_ROOT, ".dsh-graph");
const ACTOR = "mock:seed"; // 虚构执行者，非真实会话
const EXECUTOR = "agent:mock-executor"; // 虚构执行子代理名
// 固定到过去 48h，保证 boardPayload 的 generated_at - updated_at 远超 10s 强调窗口
const PAST = new Date(Date.now() - 48 * 3600 * 1000);
const VERSION_SLUG = "v1.4";

// ---- core 引擎 runner ----
function core(args, { capture = false } = {}) {
  const out = execFileSync(process.execPath, [CORE_MAIN, "--root", GRAPH, ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  return out ? out.trim() : "";
}

const log = (msg) => console.log(`[seed] ${msg}`);

// ---- goal.md 读写（frontmatter --- JSON --- body） ----
function readGoalDoc(file) {
  const text = readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`无法解析 frontmatter：${file}`);
  return { meta: JSON.parse(m[1]), body: m[2] };
}
function writeGoalDoc(file, doc) {
  writeFileSync(file, `---\n${JSON.stringify(doc.meta, null, 2)}\n---\n${doc.body}`, "utf8");
}
function section(body, name) {
  const re = new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`);
  const m = re.exec(body);
  return m ? m[1].replace(/\n+$/, "") : null;
}
function replaceSection(body, name, content) {
  const re = new RegExp(`(## ${name}\\n)[\\s\\S]*?(?=\\n## |$)`);
  if (!re.test(body)) return body + `\n## ${name}\n\n${content}\n`;
  return body.replace(re, `$1\n${content}\n`);
}

// ---- 目标创建辅助 ----
const createdIds = [];
function makeGoal({ title, version, type, status, criteria = [], cards = [], attempt, blockedReason }) {
  // standalone 目标走引擎规范路径：先入版本（planning）再 move-goal 到独立，
  // 避免 g-147（draft→planning）与事件流重建不一致导致的 rebuild drift。
  const createVersion = version === "standalone" ? VERSION_SLUG : version;
  const args = ["create-goal", "--title", title, "--actor", ACTOR];
  if (createVersion) args.push("--version", createVersion);
  const id = core(args, { capture: true });
  createdIds.push(id);
  log(`创建 ${id}（${title}）`);

  if (version === "standalone") {
    core(["move-goal", "--goal", id, "--to", "standalone", "--actor", ACTOR]);
  }

  if (criteria.length > 0) {
    const cargs = ["set-criteria", "--goal", id, "--actor", ACTOR];
    for (const c of criteria) cargs.push("--criteria", c);
    core(cargs);
  }

  // 按状态机路径迁移到目标状态。
  // 版本内目标创建即 planning，backlog/standalone 创建即 draft：跳过已在的状态。
  const pathMap = {
    planning: ["planning"],
    collecting: ["planning", "collecting"],
    ready: ["planning", "ready"],
    in_progress: ["planning", "ready", "in_progress"],
    review: ["planning", "ready", "in_progress", "review"],
    delivered: ["planning", "ready", "in_progress", "review", "delivered"],
  };
  const initial = version ? "planning" : "draft";
  let current = initial;
  for (const hop of pathMap[status] ?? []) {
    if (hop === current) continue;
    core(["transition", "--goal", id, "--to", hop, "--actor", ACTOR]);
    current = hop;
  }
  if (status === "blocked") {
    core(["transition", "--goal", id, "--to", "blocked", "--reason", blockedReason, "--actor", ACTOR]);
  }

  for (const c of cards) {
    const cardId = core(["add-card", "--goal", id, "--title", c.title, "--kind", c.kind, "--actor", ACTOR], { capture: true });
    if (c.status === "collecting") {
      // 收集子代理已派发、尚未填充：post-polish 阶段把状态改为 collecting（展示层）
      pendingCollectingCards.push({ file: goalFileOf(id), cardId, title: c.title, kind: c.kind });
    } else {
      if (c.text) {
        core(["fill-card", "--goal", id, "--card", cardId, "--text", c.text, "--summary", c.summary ?? "", "--actor", ACTOR]);
      }
      if (c.reviewed) {
        core(["review-card", "--goal", id, "--card", cardId, "--actor", ACTOR]);
      }
    }
  }

  if (attempt) {
    core(["start-attempt", "--goal", id, "--executor", EXECUTOR, "--actor", ACTOR]);
    if (attempt.statusLine) {
      core(["report-status", "--goal", id, "--attempt", "att-001", "--status", attempt.statusLine, "--actor", ACTOR]);
    }
  }

  return id;
}

function goalFileOf(id) {
  // backlog 扁平 <id>.md；standalone/版本 goals/<id>/goal.md
  const candidates = [
    path.join(GRAPH, "backlog", `${id}.md`),
    path.join(GRAPH, "goals", id, "goal.md"),
    path.join(GRAPH, "versions", VERSION_SLUG, "goals", id, "goal.md"),
  ];
  for (const f of candidates) {
    try {
      if (statSync(f).isFile()) return f;
    } catch { /* 不存在则试下一个 */ }
  }
  throw new Error(`找不到目标文件：${id}`);
}

const pendingCollectingCards = [];

// ---- 递归固定 mtime（展示稳定：g-171 强调窗口按 goal.md mtime 判定） ----
function pinMtimes(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) pinMtimes(p);
    else utimesSync(p, PAST, PAST);
  }
}

// ==================================================================
function main() {
  const wantValidate = process.argv.includes("--validate");

  log(`清空并重建 mock 数据：${MOCK_ROOT}`);
  rmSync(MOCK_ROOT, { recursive: true, force: true });
  mkdirSync(GRAPH, { recursive: true });
  core(["init"]);

  // ---- 版本泳道 v1.4（虚构 nebula-notes） ----
  log(`创建版本泳道：${VERSION_SLUG}`);
  // 版本泳道由首个 --version 目标隐式创建，先建一个空壳目标保证泳道存在
  // （后续 polish 阶段会改写 version.md 的 name）

  // g-001 … g-010：覆盖 描述/收集/执行/确认/交付/阻塞 全阶段
  makeGoal({
    title: "设计笔记双向链接数据模型", version: VERSION_SLUG, type: "feature", status: "planning",
    criteria: ["链接以 ([[note]]) 语法表达，支持别名与块级锚点", "反向引用索引可由笔记内容增量更新", "数据模型可被 Markdown 文件无损序列化"],
  });
  makeGoal({
    title: "评审本地优先存储选型", version: VERSION_SLUG, type: "task", status: "collecting",
    criteria: ["对比 SQLite / CRDT 文件方案给出结论", "明确离线优先的同步边界"],
  });
  makeGoal({
    title: "收集竞品知识图谱交互行为", version: VERSION_SLUG, type: "task", status: "collecting",
    criteria: ["至少覆盖 4 个主流笔记产品", "输出交互行为对照表"],
    cards: [{ title: "竞品图谱功能行为截图与说明", kind: "file", status: "collecting" }],
  });
  makeGoal({
    title: "确认同步冲突合并策略", version: VERSION_SLUG, type: "improvement", status: "ready",
    criteria: ["冲突按字段级合并", "无法自动合并时保留双方版本并提示"],
  });
  makeGoal({
    title: "实现双向链接索引", version: VERSION_SLUG, type: "feature", status: "in_progress",
    criteria: ["新增/编辑笔记后索引 500ms 内可见", "删除笔记后反向引用同步清理", "索引可随启动增量重建", "全量重建在 10k 笔记下 < 3s", "不阻塞笔记编辑主线程"],
    attempt: { statusLine: "正在构建索引与反向引用查询" },
  });
  // g-006：README 目标详情弹窗截图对象（ready / 收集列，信息收集展示）
  makeGoal({
    title: "调研用户笔记组织与检索习惯", version: VERSION_SLUG, type: "task", status: "ready",
    criteria: ["访谈 ≥ 6 位重度笔记用户", "总结 3 类典型笔记组织模式", "梳理高频检索路径与失败场景", "输出信息架构改进建议清单", "结论进入 v1.4 需求池"],
    cards: [
      { title: "用户访谈记录：文件夹与标签习惯", kind: "text", reviewed: true, summary: "多数用户按主题建文件夹，标签用于临时聚合", text: "访谈 6 位用户后发现：笔记组织以主题文件夹为主，标签更多用于跨主题临时聚合；检索主要靠全文搜索，反向链接使用率低但期望高。" },
      { title: "检索行为日志分析", kind: "data", reviewed: true, summary: "高频检索词集中于最近编辑笔记，失败率 18%", text: "抽样 2 万次检索：近 80% 落在最近 7 天编辑过的笔记；检索失败率 18%，主要原因是别名与缩写未索引。" },
      { title: "竞品信息架构对照表", kind: "file", reviewed: true, summary: "4 款竞品均提供图谱视图，但入口层级不同", text: "对照表见附件：4 款竞品均提供图谱视图；2 款将图谱作为一级入口，2 款藏在更多菜单内。" },
    ],
  });
  makeGoal({
    title: "验收块引用与嵌入渲染", version: VERSION_SLUG, type: "improvement", status: "review",
    criteria: ["块引用在阅读/编辑视图均可渲染", "嵌入内容跟随源块实时更新", "循环引用有保护提示"],
  });
  makeGoal({
    title: "发布本地同步 MVP", version: VERSION_SLUG, type: "feature", status: "delivered",
    criteria: ["双设备局域网同步可用", "冲突合并策略落地", "发布说明与回滚预案齐备"],
  });
  makeGoal({
    title: "迁移旧版笔记数据格式", version: VERSION_SLUG, type: "bug", status: "delivered",
    criteria: ["旧格式无损导入", "迁移过程可中断续跑"],
  });
  makeGoal({
    title: "端到端加密同步", version: VERSION_SLUG, type: "feature", status: "blocked",
    blockedReason: "依赖第三方密钥服务评审，暂缓排期",
    criteria: ["传输与存储全程加密", "密钥不落服务器"],
  });

  // ---- backlog（暂存池） ----
  makeGoal({ title: "导出 Markdown 增强", version: null, type: "feature", status: "draft" });
  makeGoal({ title: "标签云视图", version: null, type: "feature", status: "draft" });
  makeGoal({ title: "移动端离线阅读", version: null, type: "improvement", status: "draft" });

  // ---- 独立目标（standalone，走版本→move 规范路径，最终 planning） ----
  makeGoal({ title: "团队协作模式可行性调研", version: "standalone", type: "task", status: "planning" });

  // ==================================================================
  // polish：展示层润色（不改变引擎状态机语义）
  log("polish：目标正文 / 版本名 / 类型色 / 评论 / 收集卡状态");

  // 1) g-006 富正文（描述 / 最近指令 / 评论），判据保留引擎生成
  const g006File = goalFileOf("g-006");
  const g006 = readGoalDoc(g006File);
  let body = g006.body;
  body = replaceSection(body, "目标描述", [
    "为 v1.4 知识图谱功能做用户侧信息收集：理解目标用户如何组织笔记、如何检索与复读，",
    "为双向链接、图谱视图与检索增强提供需求依据。",
    "",
    "交付物：访谈纪要、检索日志分析、竞品信息架构对照表（见上下文卡片）。",
  ].join("\n"));
  body = replaceSection(body, "最近指令", [
    "收集范围聚焦个人知识管理场景；访谈对象覆盖研发/写作/运营三类角色；",
    "卡片填充后需复核再进入 ready。",
  ].join("\n"));
  body = replaceSection(body, "评论", [
    "### 2026-08-22T10:30:00+08:00 | mock:supervisor",
    "",
    "建议补充检索失败场景的量化数据，用于信息架构改进建议。",
    "",
    "### 2026-08-23T15:00:00+08:00 | mock:reviewer",
    "",
    "卡片已复核，结论进入需求池后即可排期执行。",
  ].join("\n"));
  g006.body = body;
  writeGoalDoc(g006File, g006);

  // 2) 版本泳道名
  const vfile = path.join(GRAPH, "versions", VERSION_SLUG, "version.md");
  const vdoc = readGoalDoc(vfile);
  vdoc.meta.name = "v1.4 知识图谱与同步";
  writeGoalDoc(vfile, vdoc);

  // 3) 类型色（create-goal CLI 未暴露 --type，polish 阶段写 frontmatter；board 侧 normalize 读取）
  const typeById = {
    "g-001": "feature", "g-002": "task", "g-003": "task", "g-004": "improvement",
    "g-005": "feature", "g-006": "task", "g-007": "improvement", "g-008": "feature",
    "g-009": "bug", "g-010": "feature",
  };
  for (const [id, type] of Object.entries(typeById)) {
    const f = goalFileOf(id);
    const doc = readGoalDoc(f);
    doc.meta.type = type;
    writeGoalDoc(f, doc);
  }

  // 4) 收集中的卡片状态（展示层：bind_collect_card 之后、填充之前的形态）
  for (const pc of pendingCollectingCards) {
    const doc = readGoalDoc(pc.file);
    const cardsDir = path.join(path.dirname(pc.file), "cards");
    const cardFile = path.join(cardsDir, `${pc.cardId}.md`);
    const cdoc = readGoalDoc(cardFile);
    cdoc.meta.status = "collecting";
    cdoc.meta.summary = "收集子代理已派发，等待填充";
    writeGoalDoc(cardFile, cdoc);
  }

  // 5) project.yaml（虚构项目；supervisor.session 为空，无真实会话）
  writeFileSync(path.join(GRAPH, "project.yaml"), [
    "name: nebula-notes",
    "description: 虚构演示项目——本地优先的笔记应用（g-178 README 截图 mock，非真实项目）",
    "defaults:",
    "  review:",
    "    reviewer: human",
    "    prompt: null",
    "  pk:",
    "    lanes: 1",
    "    sandbox: directory",
    "  disposition: {}",
    "supervisor:",
    "  session: null",
    "  automation: {}",
    "executor:",
    "  provider: mock-provider",
    "  model: mock-model",
    "",
  ].join("\n"));

  // 6) 固定全部文件 mtime 到过去（避免 g-171 更新强调扫光）
  pinMtimes(GRAPH);
  log("全部文件 mtime 已固定到过去（48h 前）");

  // ---- 验收 ----
  if (wantValidate) {
    log("运行 core validate …");
    core(["validate"]);
    log("validate: PASS");
    log("运行 core rebuild 对账 …");
    core(["rebuild", "--check"]);
    log("rebuild: consistent");
  }

  // 脱敏自检：数据中不应出现真实会话/路径
  const all = walk(GRAPH).join("\n");
  const sensitive = ["session-", "/home/", "/workspace/", "~/.dsh", "api_key", "token"];
  const hits = sensitive.filter((s) => all.includes(s));
  if (hits.length > 0) {
    console.error(`[seed] 脱敏检查未通过，出现敏感字样：${hits.join(", ")}`);
    process.exit(1);
  }
  log("脱敏检查通过（无真实会话/路径/凭据字样）");

  log(`完成：mock 数据在 ${GRAPH}`);
  log(`目标分布：${createdIds.join(" ")}`);
  log(`g-006 就绪（收集列）→ 目标详情弹窗截图对象`);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

main();
