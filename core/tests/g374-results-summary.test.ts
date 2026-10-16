import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  init,
  createGoal,
  setCriteria,
  startAttempt,
  writeAttemptResults,
  appendGoalComment,
  setGoalDirective,
  findGoalFile,
  goalDetail,
  goalResults,
  refreshGoalResults,
  goalResultsSummaryFile,
  goalResultsArchiveFile,
  goalResultsArchiveFiles,
  resultsArchiveStamp,
  moveGoal,
  GOAL_RESULTS_MAX_BYTES,
  GOAL_RESULTS_READ_TOTAL_MAX_BYTES,
  GOAL_RESULTS_BODY_MAX_BYTES,
  RESULTS_SOURCE_LLM,
  RESULTS_ARCHIVE_PATTERN,
  RESULTS_SUMMARY_NAME,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { dirEntries, assertNoNewEntries } from "./_residue-guard.ts";

// g-374 F2（+ 修 F1 复核 must-fix②）：`results.md` 规范化摘要的**零 LLM** 重写契约。
// 覆盖判据 4：由目标历史确定性重写、旧版归档不覆盖、结果来源为空时优雅空态、
// 以及「机器头不得被值内换行/标记注入伪字段」（写入侧净化 + 读取侧整行匹配，双重防御）。

// 与 core/ops.ts 的 OVERWRITE_NOTE 逐字一致（该常量不导出，F1 测试亦同法）
const OVERWRITE_NOTE = "本文件由机器生成，下次写入整体覆盖";

// g-504 去冗余瘦身：确定性正文只保留「终态交付快照」四节。
// 旧六节里的 `## 关键决策`（评论区 + 3000 字指令原文）与 `## 时间线`（30 条事件）是**整体搬运**，
// 本就在目标弹窗「详情」「活动」Tab 可见 ⇒ 已删除。本清单是**强契约**：多一节（回归倾倒）或少一节都判红。
const SECTIONS = ["## 交付快照", "## 判据达成", "## 证据引用", "## 来源"];
/** g-504 反回归：这些节**不得**再出现（旧版的体积膨胀来源）。 */
const REMOVED_SECTIONS = ["## 关键决策", "## 时间线", "## 改动与影响", "## 结论"];

function setup({ withVersion = true }: { withVersion?: boolean } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g374-f2-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goal = createGoal(root, withVersion
    ? { title: "规范化摘要", version: "v-test", actor: "human:gui" }
    : { title: "规范化摘要", actor: "human:gui" });
  setCriteria(root, goal, ["判据 1：xx", "判据 2：yy ✅已验"], "human:gui");
  const goalFile = findGoalFile(root, goal);
  return { ws, root, goal, goalFile, dir: dirname(goalFile) };
}

function summaryEvents(root: string, name: string) {
  return readEvents(root).filter((e) => e.event === name);
}

/** 填充「有来源」的最小历史：1 条评论 + 1 条指令 + 1 个 attempt + 1 份 attempt 结果。 */
function seed(root: string, goal: string) {
  appendGoalComment(root, goal, "关键决策：先做 F1。", "human:gui");
  setGoalDirective(root, goal, "## 本次任务\n只做规范化摘要。", "human:gui");
  const attempt = startAttempt(root, goal, {
    executor: "agent:exec", actor: "human:gui",
    // 判据 4 的「相关 commit」来源：attempt 记录里的 baseline_commit（另含 worktree.head）——
    // 纯读既有投影、不跑 git 命令 ⇒ 仍是零 LLM / 零副作用。
    baselineCommit: "deadbeefcafe0123456789abcdef0123456789ab",
  });
  writeAttemptResults(root, {
    goal, attempt, source: "subagent/end", childId: "c1", stopReason: "completed",
    text: "交付正文第一行\n第二行",
  });
  return attempt;
}

// ============================================================================
// 判据 4-a：由目标历史确定性重写（节齐全、机器头完整、非覆盖式说明）
// ============================================================================

test("g-374 F2/g-504：由目标历史重写 results.md——终态交付四节齐全 + 反回归（旧胖节不得复活）", () => {
  const { root, goal, goalFile } = setup();
  const attempt = seed(root, goal);

  const dirBefore = readdirSync(dirname(goalFile)).sort();
  const res = refreshGoalResults(root, goal, { actor: "human:gui" });
  assert.equal(res.written, true, "有来源必须写入");
  assert.equal(res.skipped, false);
  assert.equal(res.archive, null, "首版无旧版可归档");
  const file = goalResultsSummaryFile(goalFile);
  assert.equal(res.file, file, "路径唯一真源 = goalResultsSummaryFile");
  assert.equal(basename(file), RESULTS_SUMMARY_NAME);
  assert.ok(existsSync(file), "results.md 必须出现");

  const raw = readFileSync(file, "utf8");
  for (const s of SECTIONS) assert.ok(raw.includes(s), `缺小节：${s}`);
  // g-504 反回归（负向对照）：旧版的体积膨胀节一旦被改回来（倾倒评论/指令/事件），本断言必红。
  for (const s of REMOVED_SECTIONS) assert.ok(!raw.includes(s), `g-504 瘦身后不得再出现小节：${s}`);
  assert.match(raw, /^<!-- dsh-graph:results:begin -->/, "机器头起始标记");
  for (const field of [
    "kind: summary", "generated_at: ", `goal: ${goal}`, "title: 规范化摘要", "status: ",
    "source: deterministic", "actor: human:gui", "truncated: false",
    "sources: comments=1 directive=yes attempts=1 results_files=1", "source_hash: ", "bytes: ",
  ]) {
    assert.ok(raw.includes(field), `机器头缺字段：${field}`);
  }
  assert.ok(raw.includes(OVERWRITE_NOTE), "必须含覆盖式说明（逐字）");
  assert.ok(raw.includes("旧版自动归档") || raw.includes("本次为首版"), "必须说明归档策略");
  assert.ok(raw.includes("零 LLM 拼装"), "必须声明零 LLM 来源");
  assert.ok(raw.includes("✅") && raw.includes("⬜"), "判据达成如实转述 goal.md 的 ✅已验 标记（不做语义判定）");
  assert.ok(raw.includes("交付正文第一行"), "交付快照的终态交付取自 attempt 结果文件");
  assert.ok(raw.includes(`\`${attempt}\``), "证据引用列出 attempt");
  // 判据 4：证据引用必须带上 attempt 的提交与基线（commit 来源，零 git 调用）
  assert.ok(raw.includes("baseline=`deadbeefcafe0123456789abcdef0123456789ab"), "证据引用含基线 commit");
  assert.ok(new RegExp(`^- attempt=\`${attempt}\`(；commit=[0-9a-f]+)?；终态=`, "m").test(raw),
    "证据引用为单行紧凑索引：attempt（+ 可选 commit）+ 终态");
  // g-504 反回归：前序 attempt 的 brief 与验收项不得再逐条展开（旧版在结论与证据引用里各展开一次）。
  assert.ok(!raw.includes("任务 brief："), "g-504：证据引用不再展开 attempt brief");
  assert.ok(!raw.includes("本次验收项："), "g-504：证据引用不再展开验收项");
  // g-504：终态成果绝不因瘦身而丢失 —— 结果文件的一手交付首句仍必须在正文里。
  assert.ok(raw.includes("结果文件="), "交付快照含结果文件定位");
  assert.ok(raw.includes("事件留痕："), "事件改为单行计数（不再列 30 条时间线）");
  assert.ok(raw.includes("明细见目标弹窗"), "必须指路弹窗详情/活动 Tab，说明明细未丢只是不再搬运");
  // g-504：事件不再逐条列时间线 —— 但「事件台账」这一事实仍须可见（改为计数），不得整体消失。
  assert.ok(/事件留痕：.*×/.test(raw), "事件以计数留痕（旧版逐条列 30 条时间线）");
  assert.ok(!/^- \d{4}-\d{2}-\d{2}T.*｜.*｜goal\./.test(raw), "g-504：不得再逐条列事件时间线（反回归）");

  // 事件先行：写入事件载荷完整
  const evs = summaryEvents(root, "goal.results_summary_written");
  assert.equal(evs.length, 1);
  const d = evs[0].details;
  assert.equal(d.file, file);
  assert.equal(d.archive, null);
  assert.equal(d.overwrite, false);
  assert.equal(d.bytes, res.bytes);
  assert.equal(d.source_hash, res.source_hash);
  assert.equal(d.actor_writer, "human:gui");
  assert.deepEqual(d.sources, res.sources);
  // 原子写：不留半文件（F1 复核 must-fix①：**名字无关**的清单相等检查）。
  // 本路径（core/ops.ts:atomicWrite）真实临时名是同目录 `.tmp-<randomUUID()>`；按名字过滤会空转，
  // 故此处用「除预期目标 results.md 外不得出现任何新文件」，任何命名的残留都会红。
  assertNoNewEntries(dirname(goalFile), dirBefore, `除 ${RESULTS_SUMMARY_NAME} 外`, [RESULTS_SUMMARY_NAME]);
});

test("g-374 F2：原子写残留检查**非恒真**——摘要侧调用与 F1 同一份共享 helper（造出真实半文件即红）", () => {
  const { root, goal, goalFile } = setup();
  seed(root, goal);
  const dir = dirname(goalFile);
  const before = dirEntries(dir); // 共享 helper（core/tests/_residue-guard.ts）
  const residue = join(dir, `.tmp-${randomUUID()}`); // 与 core/ops.ts:atomicWrite 逐字同名的真实半文件
  writeFileSync(residue, "半文件");
  try {
    const addedOldWay = dirEntries(dir).filter((n) => n.includes(".tmp."));
    assert.deepEqual(addedOldWay, [], "旧写法（只过滤 `.tmp.` 子串）看不见 `.tmp-<uuid>` ⇒ 恒真");
    const added = dirEntries(dir).filter((n) => !before.includes(n));
    assert.ok(added.includes(basename(residue)), "残留必须被清单看见（名字无关）");
    // 关键：这里调的是**产品侧与 F1 共用的同一个**判定函数；若它被改成恒真，本断言必红。
    assert.throws(
      () => assertNoNewEntries(dir, before, "残留检查", [RESULTS_SUMMARY_NAME]),
      /不得出现任何新文件/,
      "有残留时共享判定必须红（证明非恒真，且不是自指的局部实现）",
    );
  } finally {
    rmSync(residue, { force: true });
  }
  assertNoNewEntries(dir, before, "对照后", []);
});

test("g-374 F2：共享 helper 被 F1 与摘要侧同时引用（单一真源，禁止各写一份）", () => {
  const a = readFileSync(join(import.meta.dirname, "g374-attempt-results.test.ts"), "utf8");
  const b = readFileSync(join(import.meta.dirname, "g374-results-summary.test.ts"), "utf8");
  for (const [name, src] of [["F1", a], ["摘要", b]] as const) {
    assert.match(src, /from "\.\/_residue-guard\.ts"/, `${name} 套件必须 import 共享 helper`);
    // 注意：断言文本本身不能与「禁止出现的字面量」相同，否则会自匹配（拼出来即可）。
    const localImpl = "function assert" + "NoNewEntries(";
    assert.ok(!src.includes(localImpl), `${name} 套件不得自带第二份实现`);
  }
});

test("g-374 F2：source_hash 只代表历史状态——同一历史重复刷新指纹不变、历史变化则指纹变化", () => {
  const { root, goal } = setup();
  seed(root, goal);
  const a = refreshGoalResults(root, goal, { actor: "human:gui", stamp: "20260101T000001" });
  const b = refreshGoalResults(root, goal, { actor: "human:gui", stamp: "20260101T000002" });
  assert.equal(a.source_hash, b.source_hash, "同一历史状态 ⇒ 指纹稳定（摘要自身事件不得自我污染）");
  assert.notEqual(a.bytes, 0);
  // 历史变化（新增评论）⇒ 指纹变化
  appendGoalComment(root, goal, "追加一条决策。", "human:gui");
  const c = refreshGoalResults(root, goal, { actor: "human:gui", stamp: "20260101T000003" });
  assert.notEqual(c.source_hash, b.source_hash, "历史变化 ⇒ 指纹必须变化");
  // 时间线不得包含摘要自身的生成事件（自指噪声）
  const raw = readFileSync(a.file, "utf8");
  assert.ok(!raw.includes("goal.results_summary_written"), "摘要自身事件不得进时间线");
});

// ============================================================================
// 判据 4-b：旧版归档（绝不就地覆盖丢失；可枚举；被 attempt 投影正则排除）
// ============================================================================

test("g-374 F2：重复刷新 = 每次重写 + 每次归档；旧版逐字保留，新版不覆盖旧版", () => {
  const { root, goal, goalFile, dir } = setup();
  seed(root, goal);
  const first = refreshGoalResults(root, goal, { actor: "human:gui", stamp: "20260101T010101" });
  const v1 = readFileSync(first.file, "utf8");

  appendGoalComment(root, goal, "第二次决策。", "human:gui");
  // 唯一真源：归档名为「下一次空闲名」，须在写入前求值（写入后该名已被占用 ⇒ 求值会得到 -2）
  const expectedArchive = goalResultsArchiveFile(goalFile, "20260101T020202");
  const second = refreshGoalResults(root, goal, { actor: "human:gui", stamp: "20260101T020202" });
  assert.equal(second.written, true);
  assert.equal(second.archive, expectedArchive, "归档路径唯一真源");
  assert.equal(basename(second.archive!), "results-archive-20260101T020202.md");
  assert.match(basename(second.archive!), RESULTS_ARCHIVE_PATTERN, "归档名匹配可枚举正则");

  // 旧版逐字保留（这就是「不丢历史」的判据）
  assert.equal(readFileSync(second.archive!, "utf8"), v1, "归档内容必须与旧版逐字一致");
  // 新版已更新（g-504 起评论**正文不再倾倒**，故以「单行计数」为可见变化信号 —— 比断言评论原文更稳，
  // 且同样能证伪「第二次刷新没重写」。计数不入评论区正文，但如实反映历史变化。）
  const v2 = readFileSync(second.file, "utf8");
  assert.ok(v1.includes("评论 1 条") && v2.includes("评论 2 条"),
    "g-504：评论区改为单行计数，新评论仍必须体现为可见变化");
  assert.ok(!v2.includes("第二次决策。"), "g-504：评论正文不得再被全量倾倒进完成摘要（反回归）");
  assert.notEqual(v2, v1);
  assert.deepEqual(
    readdirSync(dir).filter((n) => RESULTS_ARCHIVE_PATTERN.test(n)),
    ["results-archive-20260101T020202.md"],
    "归档可枚举（首版无旧版可归档 ⇒ 只有第二次归档）",
  );
  // 事件留痕：每次刷新一条 written（含归档名）；第二次起标注覆盖
  const evs = summaryEvents(root, "goal.results_summary_written");
  assert.equal(evs.length, 2, "两次写入两条事件");
  assert.equal(evs[0].details.overwrite, false);
  assert.equal(evs[1].details.overwrite, true, "第二次标注覆盖");
  assert.equal(evs[1].details.archive, second.archive);
  assert.equal(evs[1].details.source_hash, second.source_hash);

  // 归档不得被当成 attempt 结果文件投影（判据 3 的一一对应不被 F2 破坏）
  const proj = goalResults(root, goal);
  assert.deepEqual(proj.attempts.map((a) => a.attempt), ["att-001"]);
  assert.deepEqual(proj.archives, goalResultsArchiveFiles(goalFile), "归档投影可枚举");
  assert.equal(proj.summary?.source, "deterministic", "results.md 作为 summary 投影（source=deterministic）");
  assert.equal(proj.summary?.truncated, false);
});

test("g-374 F2：同一秒内多次归档 ⇒ 追加 -2/-3 后缀（仍可枚举、不互相覆盖）", () => {
  const { root, goal, goalFile, dir } = setup();
  seed(root, goal);
  for (let i = 0; i < 4; i++) {
    const r = refreshGoalResults(root, goal, { actor: "human:gui", stamp: "20260101T030303" });
    assert.equal(r.written, true);
  }
  const archives = readdirSync(dir).filter((n) => RESULTS_ARCHIVE_PATTERN.test(n)).sort();
  assert.deepEqual(archives, [
    "results-archive-20260101T030303-2.md",
    "results-archive-20260101T030303-3.md",
    "results-archive-20260101T030303.md",
  ], "同秒冲突追加后缀且全部可枚举");
  assert.equal(resultsArchiveStamp(new Date(2026, 0, 1, 3, 3, 3)), "20260101T030303", "时间戳格式写死");
  // 时间戳会进文件名 ⇒ 非法形状必须回落到当前时间（防路径穿越），绝不按原样拼路径
  const evil = refreshGoalResults(root, goal, { actor: "human:gui", stamp: "../../escape" });
  assert.equal(evil.written, true);
  assert.equal(basename(evil.archive!), `results-archive-${resultsArchiveStamp()}.md`, "非法 stamp 回落当前时间");
  assert.equal(dirname(evil.archive!), dir, "归档绝不逃出目标目录");
});

// ============================================================================
// 判据 4-c：优雅空态（无评论/无指令/无 attempt ⇒ 不写空文件、不抛错）
// ============================================================================

test("g-374 F2：来源为空 ⇒ skipped（no-source）：不写空文件、不归档、不抛错，仅留 skipped 事件", () => {
  const { root, goal, goalFile, dir } = setup();
  const res = refreshGoalResults(root, goal, { actor: "human:gui" });
  assert.equal(res.written, false);
  assert.equal(res.skipped, true);
  assert.equal(res.reason, "no-source");
  assert.equal(res.archive, null);
  assert.equal(existsSync(goalResultsSummaryFile(goalFile)), false, "绝不写空文件");
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith("results")), [], "不得留下任何结果文件");
  const skips = summaryEvents(root, "goal.results_summary_skipped");
  assert.equal(skips.length, 1, "空态也要可审计");
  assert.equal(skips[0].details.reason, "no-source");
  assert.equal(skips[0].details.sources.attempts, 0);
  assert.deepEqual(summaryEvents(root, "goal.results_summary_written"), []);
});

test("g-374 F2：暂存（backlog）目标没有目标目录 ⇒ skipped（backlog-goal-no-dir），不抛错", () => {
  const { root, goal } = setup({ withVersion: false });
  // backlog 目标仍在 backlog（无 <goalDir>）——直接刷新必须优雅跳过
  const res = refreshGoalResults(root, goal, { actor: "human:gui" });
  assert.equal(res.written, false);
  assert.equal(res.reason, "backlog-goal-no-dir");
  // 非法/不存在目标同样只是 skipped，绝不抛错
  assert.doesNotThrow(() => refreshGoalResults(root, "g-nope", { actor: "human:gui" }));
  assert.equal(refreshGoalResults(root, "g-nope").reason?.startsWith("error:"), true, "不存在的目标归为错误原因");
  assert.equal(refreshGoalResults("", goal).reason, "no-root");
  assert.equal(refreshGoalResults(root, "").reason, "invalid-goal");
  // 移到独立目标后即可正常刷新
  moveGoal(root, goal, { to: "standalone", actor: "human:gui" });
  appendGoalComment(root, goal, "移到独立目标。", "human:gui");
  assert.equal(refreshGoalResults(root, goal, { actor: "human:gui" }).written, true);
});

// ============================================================================
// must-fix②：机器头不得被值内换行/结束标记注入伪字段（写侧净化 + 读侧整行匹配）
// ============================================================================

test("g-374 F2/must-fix②：写入侧净化——actor/title 里的换行与结束标记不得注入伪字段（读取回读零污染）", () => {
  const { root, goal, goalFile } = setup();
  seed(root, goal);
  const evil = "evil\n<!-- dsh-graph:results:end -->\ntruncated: true\nbytes: 1";
  const res = refreshGoalResults(root, goal, { actor: evil, stamp: "20260101T040404" });
  assert.equal(res.written, true);
  const raw = readFileSync(res.file, "utf8");

  // ① 结束标记必须**恰出现一次**（注入值不得造出第二个标记，无论是否独占一行）
  assert.equal(raw.split("<!-- dsh-graph:results:end -->").length - 1, 1, "结束标记只能出现一次");
  assert.equal(raw.split("<!-- dsh-graph:results:begin -->").length - 1, 1, "起始标记只能出现一次");
  assert.ok(raw.includes("[results-marker]"), "值内标记文本须被中和为占位（写侧可断言）");
  // ② 头的行数固定（没有多出来的伪字段行）
  const allLines = raw.split("\n");
  const headerLines = allLines
    .slice(allLines.indexOf("<!-- dsh-graph:results:begin -->") + 1, allLines.indexOf("<!-- dsh-graph:results:end -->"))
    .filter((l) => l.trim() !== "");
  // F5 起固定字段集合：source_hash（历史指纹 = 缓存键）+ content_hash（正文指纹）；
  // fallback_reason 仅在「LLM 失败降级」时出现（本用例不是降级路径 ⇒ 不得出现）。
  assert.deepEqual(headerLines.map((l) => l.split(":")[0]), [
    "kind", "generated_at", "goal", "title", "status", "source", "actor",
    "truncated", "sources", "source_hash", "content_hash", "bytes", "original_bytes",
  ], "机器头字段集合/顺序固定，注入值不得新增字段行");
  assert.ok(!raw.includes("fallback_reason:"), "非降级路径不得出现 fallback_reason 字段");
  // ③ 回读：注入的伪字段不生效（truncated/bytes 以写入器真实值为准）
  const view = goalResults(root, goal).summary!;
  assert.equal(view.truncated, false, "注入的 truncated: true 不得被解析");
  assert.equal(view.bytes, res.bytes, "注入的 bytes: 1 不得被解析");
  assert.equal(view.source, "deterministic");
  assert.ok(view.actor!.includes("evil") && !view.actor!.includes("\n"), "actor 单行化但保留可识别内容");
  assert.equal(view.degraded, null, "写入侧净化后读取不得降级");
});

test("g-374 F2/must-fix②：读取侧整行匹配——值内出现结束标记文本不得提前截断机器头（反恒真对照）", () => {
  const { root, goal, goalFile, dir } = setup();
  const file = goalResultsSummaryFile(goalFile);
  // 手工构造「未净化写入器」会产出的形状：值中间出现结束标记文本，真字段在其后。
  const forged = [
    "<!-- dsh-graph:results:begin -->",
    "source: manual",
    "note: x <!-- dsh-graph:results:end --> y",
    "truncated: true",
    "<!-- dsh-graph:results:end -->",
    "",
    "正文",
    "",
  ].join("\n");
  writeFileSync(file, forged, "utf8");

  const view = goalResults(root, goal).summary!;
  assert.equal(view.degraded, null, "整行匹配 ⇒ 不得判为不可解析");
  assert.equal(view.truncated, true, "真字段（标记之后的 truncated）必须被解析到");
  assert.equal(view.source, "manual");
  assert.ok(view.body.includes("正文"), "正文从头之后的标记处开始");

  // 反恒真对照：旧算法（裸 indexOf）在同一份样本上会提前截断 ⇒ 看不到真字段。
  // 这里把旧行为在测试内复现，证明该断言确实能区分新旧实现（而非恒真）。
  const oldEnd = (() => {
    const b = forged.indexOf("<!-- dsh-graph:results:begin -->");
    return forged.indexOf("<!-- dsh-graph:results:end -->", b);
  })();
  const oldHeader = forged.slice(forged.indexOf("<!-- dsh-graph:results:begin -->"), oldEnd);
  assert.ok(!oldHeader.includes("truncated: true"), "旧算法（裸 indexOf）确实漏掉真字段 ⇒ 新断言非恒真");
  rmSync(file);
});

// ============================================================================
// 零 LLM 契约 + 读取总量预算（F1 复核注记④）
// ============================================================================

test("g-374 F2：零 LLM 源码契约——F2 代码路径只做文件/事件拼装，无任何会话或模型调用", () => {
  const src = readFileSync(join(import.meta.dirname, "../ops.ts"), "utf8");
  const start = src.indexOf("export function goalResultsSummaryFile(");
  assert.ok(start > 0, "必须能定位 F2 实现块（源码契约锚点）");
  const block = src.slice(start, src.indexOf("\n// ---- g-190", start));
  assert.ok(block.includes("export function refreshGoalResults("), "锚点必须覆盖到写入器");
  assert.ok(block.length > 1000, "锚点覆盖完整的 F2 实现块");
  for (const forbidden of [/fetch\(/, /startContinuable/, /prepareContinuable/, /\bmodel\b/, /\bsession\b/, /@deepseek-ai/]) {
    assert.doesNotMatch(block, forbidden, `F2 代码不得出现 ${forbidden}（零 LLM / 零会话调用）`);
  }
  // 只允许用到的 io/事件原语（正向锚点：确实走既有文件写入 + 事件先行 + 事务）
  for (const used of ["atomicWrite", "withTx", "appendEvent", "createHash"]) {
    assert.ok(block.includes(used), `F2 实现应使用既有原语：${used}`);
  }
});

test("g-374 F2：读取总量预算——超预算的 attempt 结果文件不下发但计数可见（不静默丢数据）", () => {
  const { root, goal, dir } = setup();
  assert.ok(GOAL_RESULTS_READ_TOTAL_MAX_BYTES > GOAL_RESULTS_MAX_BYTES);
  // 三份超大文件（各自 > 单文件读取上限 ⇒ 读取按上限截断，仍逐份计入总量预算）
  const big = "x".repeat(GOAL_RESULTS_READ_TOTAL_MAX_BYTES / 2 + 10);
  for (const attempt of ["att-001", "att-002", "att-003"]) {
    writeFileSync(join(dir, `results-${attempt}.md`), big, "utf8");
  }
  const proj = goalResults(root, goal);
  assert.equal(proj.omitted, 1, "超出总量预算的文件必须计入 omitted（可见降级）");
  assert.deepEqual(proj.attempts.map((a) => a.attempt), ["att-003", "att-002"], "预算内按 attempt 倒序下发");
  assert.ok(proj.attempts.every((a) => a.degraded === "oversized"), "超大文件单份即降级标注");
});

test("g-374 F2：summary 截断——超上限时截断并在机器头与文件内双标注（不切坏多字节字符）", () => {
  const { root, goal, goalFile } = setup();
  // g-504：确定性正文已被压到 5 KiB 以内，**不再可能**靠「超长指令」撑爆正文（那正是被删掉的倾倒面）。
  // 截断是写入器的**通用**防线（对 llm / manual 正文同样生效），故改用调用方正文作为超限载体 —— 口径不变、
  // 且比旧写法更能覆盖真实超限来源。
  const res = refreshGoalResults(root, goal, {
    actor: "human:gui", maxBytes: 2048,
    content: "长正文".repeat(4000),
    source: RESULTS_SOURCE_LLM,
  });
  assert.equal(res.written, true);
  assert.equal(res.truncated, true);
  assert.ok(res.bytes <= 2048 && res.bytes >= 2044, `截断后字节数应贴近上限（实际 ${res.bytes}）`);
  assert.ok(res.original_bytes > 2048);
  const raw = readFileSync(res.file, "utf8");
  assert.ok(raw.includes("truncated: true"), "机器头标注截断");
  assert.ok(raw.includes("已截断"), "文件内可见截断标注（UI 要能看到）");
  assert.ok(!raw.includes("\uFFFD"), "不得切坏多字节字符");
  assert.equal(goalResults(root, goal).summary!.truncated, true, "回读标注一致");
  assert.ok(raw.includes(OVERWRITE_NOTE));
});

test("g-504 判据 1：中长目标确定性正文 ≤5 KiB——旧版会把评论/指令/事件倾倒回 26–94 KB（反回归）", () => {
  const { root, goal } = setup();
  seed(root, goal);
  // 造出典型「中长目标」的历史：大量评论 + 超长指令 + 更多 attempt。
  for (let i = 0; i < 40; i++) appendGoalComment(root, goal, `评论 ${i}：` + "历史讨论内容与裁决。".repeat(40), "human:gui");
  setGoalDirective(root, goal, "## 本次任务\n" + "很长的指令沿革正文。".repeat(300), "human:gui");
  const res = refreshGoalResults(root, goal, { actor: "human:gui" });
  assert.equal(res.written, true);
  assert.equal(res.truncated, false, "中长目标不应触发截断（说明正文本身已足够小）");
  assert.ok(res.bytes <= GOAL_RESULTS_BODY_MAX_BYTES,
    `中长目标正文必须 ≤ ${GOAL_RESULTS_BODY_MAX_BYTES} 字节（实际 ${res.bytes}）：旧版此规模即 26–94 KB`);
  const raw = readFileSync(res.file, "utf8");
  // 「瘦身」不得靠丢终态成果实现：终态交付、判据、证据三样必须仍在。
  for (const s of SECTIONS) assert.ok(raw.includes(s), `瘦身后仍必须含：${s}`);
  assert.ok(raw.includes("交付正文第一行"), "终态交付成果不得因瘦身而丢失");
  assert.ok(!raw.includes("评论 39："), "40 条评论的正文不得被倾倒（只留计数）");
  assert.ok(!raw.includes("很长的指令沿革正文"), "最近指令原文不得被照搬（只留有无）");
  assert.ok(raw.includes("评论 41 条"), "评论改为单行计数，仍如实反映历史规模");
});
