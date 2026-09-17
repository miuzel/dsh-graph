/**
 * g-296：派发上下文去重与最终渲染预算诊断测试。
 *
 * 覆盖：
 * 1. brief/directive 归一化去重（相同、不同、单空、双空、空白差异、中英）
 * 2. 卡片预算诊断（per-card 字符数、总输出、超预算标识）
 * 3. 黄金样本兼容（无重复/未超预算时逐字节一致）
 * 4. 边界场景（空正文、中英混合、长摘要、多卡、附件、安全记忆保留）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAttemptPrompt } from "../../dsh-graph-host/index.js";
import {
  init,
  createGoal,
  addCard,
  fillCard,
  reviewCard,
  formatHarvestedCardsSection,
  setCriteria,
} from "../ops.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- helpers ----

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g296-"));
  init(dir);
  return dir;
}

function prompt(overrides: Record<string, unknown> = {}) {
  return formatAttemptPrompt({
    goal: "g-296",
    attempt: "att-001",
    goalRel: ".dsh-graph/versions/v0.11.1/goals/g-296/goal.md",
    cardsSection: "## 已收集上下文卡片成果\n\n（无）",
    worktreeBlock: "【强制 worktree 隔离】",
    ...overrides,
  });
}

// ============================================================
// 1. brief/directive 归一化去重
// ============================================================

test("g-296：brief==directive 归一化相等时，directive 标记为冗余并注明以 brief 为准", () => {
  const text = "执行 g-296：实现 prompt 去重与预算诊断";
  const output = prompt({ attemptBrief: text, directive: text });
  // brief 保留全文
  assert.ok(output.includes(text), "brief 全文保留");
  // directive 标记冗余
  assert.ok(output.includes("归一化后与上方 brief 完全相同；以 brief 为准"), "directive 标记冗余");
  // directive 全文不重复出现
  const briefIdx = output.indexOf("**attempt brief（当前数据）**");
  const dirIdx = output.indexOf("**directive（当前数据）**");
  assert.ok(briefIdx >= 0 && dirIdx >= 0 && briefIdx < dirIdx, "brief 和 directive 标签均存在且顺序正确");
  // 在 directive 标签之后不应再出现 brief 全文
  const afterDir = output.slice(dirIdx);
  assert.ok(!afterDir.includes(text), "directive 之后不再重复 brief 全文");
});

test("g-296：brief==directive 仅空白差异时仍去重（归一化处理）", () => {
  const brief = "  执行任务\n\n  去重  ";
  const directive = "执行任务\n去重";
  const output = prompt({ attemptBrief: brief, directive });
  assert.ok(output.includes("归一化后与上方 brief 完全相同"), "空白差异归一化后相等应去重");
});

test("g-296：brief==directive CRLF/LF 差异归一化后去重", () => {
  const brief = "执行任务\r\n换行\r\n继续";
  const directive = "执行任务\n换行\n继续";
  const output = prompt({ attemptBrief: brief, directive });
  assert.ok(output.includes("归一化后与上方 brief 完全相同"), "CRLF/LF 差异归一化后应去重");
});

test("g-296：brief 和 directive 不同时各自保留全文", () => {
  const output = prompt({
    attemptBrief: "本次 brief 内容",
    directive: "directive 内容不同",
  });
  assert.ok(output.includes("本次 brief 内容"), "brief 全文保留");
  assert.ok(output.includes("directive 内容不同"), "directive 全文保留");
  assert.ok(!output.includes("归一化后与上方 brief 完全相同"), "不同时不标记冗余");
});

test("g-296：仅 brief 有值、directive 为空时，各自渲染", () => {
  const output = prompt({ attemptBrief: "仅 brief" });
  assert.ok(output.includes("仅 brief"), "brief 有值");
  assert.ok(output.includes("当前目标没有最近指令"), "directive 缺失原因");
  assert.ok(!output.includes("归一化后与上方 brief 完全相同"), "不标记冗余");
});

test("g-296：仅 directive 有值、brief 为空时，各自渲染", () => {
  const output = prompt({ directive: "仅 directive" });
  assert.ok(output.includes("仅 directive"), "directive 有值");
  assert.ok(output.includes("本次请求未传 attempt_brief"), "brief 缺失原因");
  assert.ok(!output.includes("归一化后与上方 brief 完全相同"), "不标记冗余");
});

test("g-296：brief 和 directive 均空时，各自渲染缺失原因", () => {
  const output = prompt({});
  assert.ok(output.includes("（未提供）"), "两处均显示未提供");
  assert.ok(!output.includes("归一化后与上方 brief 完全相同"), "均空不标记冗余");
});

test("g-296：部分重叠不做模糊去重", () => {
  const output = prompt({
    attemptBrief: "执行任务第一步：分析需求",
    directive: "执行任务第一步：分析需求；第二步：实现功能",
  });
  assert.ok(output.includes("执行任务第一步：分析需求"), "brief 全文保留");
  assert.ok(output.includes("第二步：实现功能"), "directive 全文保留");
  assert.ok(!output.includes("归一化后与上方 brief 完全相同"), "部分重叠不去重");
});

// ============================================================
// 2. 卡片预算诊断
// ============================================================

test("g-296：预算诊断——输出各段字符数与超预算来源", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "g296-budget", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["判据"], "test");

  // 创建9张小卡片（不超过单卡预算），触发数量限制（maxFullCards=8）
  for (let i = 0; i < 9; i++) {
    const ci = addCard(root, goal, { title: `卡${i}`, kind: "text", actor: "test", scope: "goal" });
    fillCard(root, goal, ci, { text: `内容${i}`, summary: `摘要${i}`, by: "human:a", actor: "test" });
  }

  const sec = formatHarvestedCardsSection(root, goal, { diagnostics: true });
  // 诊断输出应包含 [预算诊断]
  assert.ok(sec.includes("[预算诊断]"), "包含预算诊断标记");
  // 应包含总字符数
  assert.ok(sec.includes("输出="), "包含输出字符数");
  assert.ok(sec.includes("限额=4000"), "包含限额");
  // 9张小卡中8张内联、1张折叠（数量限制）
  assert.ok(sec.includes("已完整展开 8 张卡片"), "8张内联");
  assert.ok(sec.includes("1 张卡片超出总预算折叠"), "1张折叠");
  // 诊断应有超数量警告（9 > 8）
  assert.ok(sec.includes("超出完整展开卡片数量上限"), "有超数量警告");
});

test("g-296：预算诊断——未超预算时不输出超预算警告", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "g296-under", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["判据"], "test");

  const c1 = addCard(root, goal, { title: "小卡", kind: "text", actor: "test", scope: "goal" });
  fillCard(root, goal, c1, { text: "短内容", summary: "短摘要", by: "human:a", actor: "test" });

  const sec = formatHarvestedCardsSection(root, goal, { diagnostics: true });
  assert.ok(sec.includes("[预算诊断]"), "诊断仍输出");
  assert.ok(!sec.includes("总输出超出预算"), "未超预算不警告");
  assert.ok(!sec.includes("⚠️超限"), "单卡未超限不标记");
});

test("g-296：预算诊断——单卡超限标记", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "g296-overcard", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["判据"], "test");

  const c1 = addCard(root, goal, { title: "长卡", kind: "text", actor: "test", scope: "goal" });
  fillCard(root, goal, c1, { text: "X".repeat(5000), summary: "长摘要", by: "human:a", actor: "test" });

  const sec = formatHarvestedCardsSection(root, goal, { diagnostics: true, maxTotalChars: 99999 });
  // 单卡正文 5000 > 默认 4096，应被截断且诊断标记超限
  assert.ok(sec.includes("⚠️超限") || sec.includes("⚠️over"), "单卡超限标记");
});

test("g-296 回归：diagnostics output 字符数必须等于最终返回串 JS.length（含 diagnostics 自身）", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "g296-reg1", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["判据"], "test");

  // 用短内容卡片制造 output 值较小的场景，方便验证
  const c1 = addCard(root, goal, { title: "😀卡", kind: "text", actor: "test", scope: "goal" });
  fillCard(root, goal, c1, { text: "短", summary: "摘要", by: "human:a", actor: "test" });

  const sec = formatHarvestedCardsSection(root, goal, { diagnostics: true });
  // 从诊断行提取报告的 output 值
  const match = sec.match(/输出=(\d+) 字符/);
  assert.ok(match, "诊断行应包含输出字符数");
  const reportedOutput = Number(match![1]);
  // 最终返回串的实际 JS.length
  const actualLength = sec.length;
  assert.equal(reportedOutput, actualLength, `报告的 output=${reportedOutput} 必须等于 sec.length=${actualLength}`);
});

test("g-296 回归：长标题+短正文不应误报单卡超限（预算语义=正文长度）", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "g296-reg2", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["判据"], "test");

  // 标题很长（50字符），正文很短（10字符）
  const longTitle = "这是一个非常非常非常非常非常非常非常长的卡片标题名称用于测试";
  const c1 = addCard(root, goal, { title: longTitle, kind: "text", actor: "test", scope: "goal" });
  fillCard(root, goal, c1, { text: "短短正文", summary: "短摘要", by: "human:a", actor: "test" });

  const sec = formatHarvestedCardsSection(root, goal, { diagnostics: true });
  // 正文只有 4 字符，远低于 4096 限额，不应标记超限
  assert.ok(!sec.includes("⚠️超限"), "短正文不应因长标题误报超限");
  assert.ok(!sec.includes("⚠️over"), "短正文不应因长标题误报超限(英文)");
  // 诊断应显示正文字符数远低于限额
  assert.ok(sec.includes("正文 4 字符"), "诊断应显示正文字符数");
});

test("g-296 回归：overTotal 告警追加后 output 仍等于 sec.length（maxTotalChars=10 触发超总预算）", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "g296-reg3", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["判据"], "test");

  // 两张卡各100字摘要、短正文，设 maxTotalChars=10 强制超总预算
  const c1 = addCard(root, goal, { title: "卡A", kind: "text", actor: "test", scope: "goal" });
  const c2 = addCard(root, goal, { title: "卡B", kind: "text", actor: "test", scope: "goal" });
  fillCard(root, goal, c1, { text: "内容A", summary: "摘要".repeat(50), by: "human:a", actor: "test" });
  fillCard(root, goal, c2, { text: "内容B", summary: "摘要".repeat(50), by: "human:a", actor: "test" });

  const sec = formatHarvestedCardsSection(root, goal, { diagnostics: true, maxTotalChars: 10 });
  // 超总预算告警必须存在
  assert.ok(sec.includes("总输出超出预算") || sec.includes("Total output exceeds budget"), "有超总预算告警");
  // output 字符数必须等于 sec.length
  const match = sec.match(/输出=0*(\d+) 字符/);
  assert.ok(match, "诊断行应包含输出字符数");
  const reportedOutput = Number(match![1]);
  assert.equal(reportedOutput, sec.length, `overTotal 后 output=${reportedOutput} 必须等于 sec.length=${sec.length}`);
});

test("g-296 回归：折叠卡 bodyChars=0 不应误报单卡正文超限", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "g296-reg4", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["判据"], "test");

  // 创建9张小卡片，第9张会被折叠（数量限制），bodyChars 应为 0
  for (let i = 0; i < 9; i++) {
    const ci = addCard(root, goal, { title: `卡${i}`, kind: "text", actor: "test", scope: "goal" });
    fillCard(root, goal, ci, { text: `内容${i}`, summary: `摘要${i}`, by: "human:a", actor: "test" });
  }

  const sec = formatHarvestedCardsSection(root, goal, { diagnostics: true });
  // 第9张卡被折叠，bodyChars=0，不应触发单卡正文超限
  // 超限警告只应来自真正正文超限的卡片
  const overLimitCards = (sec.match(/⚠️超限/g) || []).length;
  assert.equal(overLimitCards, 0, "折叠卡 bodyChars=0 不应触发超限标记");
  // 但应有超数量警告
  assert.ok(sec.includes("超出完整展开卡片数量上限"), "有超数量警告");
  // output == sec.length
  const match = sec.match(/输出=0*(\d+) 字符/);
  assert.ok(match, "诊断行应包含输出字符数");
  const reportedOutput = Number(match![1]);
  assert.equal(reportedOutput, sec.length, `output=${reportedOutput} 必须等于 sec.length=${sec.length}`);
});

test("g-296：未启用诊断时输出不变（黄金样本兼容）", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "g296-golden", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["判据"], "test");

  const c1 = addCard(root, goal, { title: "甲", kind: "text", actor: "test", scope: "goal" });
  fillCard(root, goal, c1, { text: "甲正文", summary: "甲摘要", by: "human:a", actor: "test" });

  const secDefault = formatHarvestedCardsSection(root, goal);
  const secNoDiag = formatHarvestedCardsSection(root, goal, {});
  const secExplicitOff = formatHarvestedCardsSection(root, goal, { diagnostics: false });

  // 三种调用方式输出完全一致
  assert.equal(secDefault, secNoDiag, "默认与空 opts 一致");
  assert.equal(secDefault, secExplicitOff, "默认与显式关闭诊断一致");
  // 不含诊断标记
  assert.ok(!secDefault.includes("[预算诊断]"), "不含诊断标记");
  assert.ok(!secDefault.includes("[Budget diagnostics]"), "不含英文诊断标记");
});

// ============================================================
// 3. 英文语言诊断
// ============================================================

test("g-296：英文语言下预算诊断使用英文标签", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "g296-en", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["criterion"], "test");

  const c1 = addCard(root, goal, { title: "Card1", kind: "text", actor: "test", scope: "goal" });
  fillCard(root, goal, c1, { text: "E".repeat(1500), summary: "sum1", by: "human:a", actor: "test" });

  const sec = formatHarvestedCardsSection(root, goal, { diagnostics: true }, undefined, "en");
  assert.ok(sec.includes("[Budget diagnostics]"), "英文诊断标记");
  assert.ok(sec.includes("chars"), "英文字符单位");
  assert.ok(sec.includes("limit=4000"), "英文限额");
});

// ============================================================
// 4. 边界场景
// ============================================================

test("g-296：空正文卡片——预算诊断正常输出", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "g296-empty", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["判据"], "test");

  const c1 = addCard(root, goal, { title: "空卡", kind: "text", actor: "test", scope: "goal" });
  fillCard(root, goal, c1, { text: "", summary: "有摘要", by: "human:a", actor: "test" });

  const sec = formatHarvestedCardsSection(root, goal, { diagnostics: true });
  assert.ok(sec.includes("[预算诊断]"), "空正文也有诊断");
  assert.ok(sec.includes("（正文为空）"), "空正文显示占位");
  assert.ok(!sec.includes("总输出超出预算"), "空正文不超预算");
});

test("g-296：中英混合内容——去重与诊断均正常", () => {
  const brief = "执行 g-296：implement dedup & budget diagnostics（中英混合）";
  const directive = "执行 g-296：implement dedup & budget diagnostics（中英混合）";
  const output = prompt({ attemptBrief: brief, directive });
  assert.ok(output.includes("归一化后与上方 brief 完全相同"), "中英混合也能去重");
});

test("g-296：长摘要卡片——诊断正确计量", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "g296-longsum", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["判据"], "test");

  const c1 = addCard(root, goal, { title: "长摘要卡", kind: "text", actor: "test", scope: "goal" });
  fillCard(root, goal, c1, {
    text: "正文",
    summary: "摘要".repeat(200), // 长摘要
    by: "human:a",
    actor: "test",
  });

  const sec = formatHarvestedCardsSection(root, goal, { diagnostics: true });
  assert.ok(sec.includes("长摘要卡"), "包含卡片标题");
  assert.ok(sec.includes("[预算诊断]"), "有诊断");
  // 摘要计入 meta，应反映在字符数中
  assert.ok(sec.includes(c1), "包含卡片 id");
});

test("g-296：多卡+附件——诊断列出每张卡字符数", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "g296-multi", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["判据"], "test");

  const c1 = addCard(root, goal, { title: "卡A", kind: "text", actor: "test", scope: "goal" });
  const c2 = addCard(root, goal, { title: "卡B", kind: "file", actor: "test", scope: "goal" });
  const c3 = addCard(root, goal, { title: "卡C", kind: "text", actor: "test", scope: "goal" });
  fillCard(root, goal, c1, { text: "内容A", summary: "摘要A", by: "human:a", actor: "test" });
  // 附件引用需在卡片正文中以 @att/<name> 形式出现
  fillCard(root, goal, c2, { text: "内容B\n@att/img.png\n@att/data.csv", summary: "摘要B", by: "human:a", actor: "test" });
  fillCard(root, goal, c3, { text: "C".repeat(500), summary: "摘要C", by: "human:a", actor: "test" });
  reviewCard(root, goal, c2, { by: "human:b", actor: "test" });

  const sec = formatHarvestedCardsSection(root, goal, { diagnostics: true });
  assert.ok(sec.includes(c1), "包含卡A id");
  assert.ok(sec.includes(c2), "包含卡B id");
  assert.ok(sec.includes(c3), "包含卡C id");
  assert.ok(sec.includes("@att/img.png"), "包含附件引用");
  assert.ok(sec.includes("@att/data.csv"), "包含附件引用");
  // 诊断应列出每张卡
  assert.ok(sec.includes("卡A"), "诊断列出卡A");
  assert.ok(sec.includes("卡B"), "诊断列出卡B");
  assert.ok(sec.includes("卡C"), "诊断列出卡C");
});

test("g-296：安全记忆与人工 gate 在 prompt 中原样保留", () => {
  const output = prompt({
    attemptBrief: "执行任务",
    directive: "执行任务",
    targetContext: "## 目标描述\n\n包含安全禁令：不得删除任何文件\n\n## 质量判据\n\n人工 gate：需人工确认",
  });
  assert.ok(output.includes("不得删除任何文件"), "安全禁令保留");
  assert.ok(output.includes("需人工确认"), "人工 gate 保留");
  assert.ok(output.includes("归一化后与上方 brief 完全相同"), "去重仍生效");
});

test("g-296：英文 prompt 的 brief/directive 去重", () => {
  const text = "Implement dedup and budget diagnostics";
  const output = formatAttemptPrompt({
    goal: "g-296",
    attempt: "att-001",
    goalRel: ".dsh-graph/goals/g-296/goal.md",
    attemptBrief: text,
    directive: text,
    promptLanguage: "en",
  });
  assert.ok(output.includes(text), "英文 brief 全文保留");
  assert.ok(output.includes("content identical to brief above after normalization"), "英文冗余标记");
  assert.ok(output.includes("brief takes priority"), "英文优先级注记");
});

test("g-296：英文 prompt 的 brief 和 directive 不同时各自保留", () => {
  const output = formatAttemptPrompt({
    goal: "g-296",
    attempt: "att-001",
    goalRel: ".dsh-graph/goals/g-296/goal.md",
    attemptBrief: "English brief content",
    directive: "English directive content",
    promptLanguage: "en",
  });
  assert.ok(output.includes("English brief content"), "英文 brief 保留");
  assert.ok(output.includes("English directive content"), "英文 directive 保留");
  assert.ok(!output.includes("content identical to brief"), "不同时不标记冗余");
});

// ============================================================
// 5. 折叠卡保留精确路径与 digest
// ============================================================

test("g-296：折叠卡保留精确路径与 digest", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "g296-collapse", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["判据"], "test");

  // 创建 9 张卡片，超过默认 8 张限制
  for (let i = 0; i < 9; i++) {
    const ci = addCard(root, goal, { title: `卡${i}`, kind: "text", actor: "test", scope: "goal" });
    fillCard(root, goal, ci, { text: `内容${i}`, summary: `摘要${i}`, by: "human:a", actor: "test" });
  }

  const sec = formatHarvestedCardsSection(root, goal);
  // 应有折叠卡片
  assert.ok(sec.includes("精确路径：") || sec.includes("Exact path:"), "折叠卡有精确路径");
  assert.ok(sec.includes("digest="), "折叠卡有 digest");
  assert.ok(sec.includes("按需查阅全文") || sec.includes("read full content on demand"), "折叠卡提示按需读取");
});

// ============================================================
// 6. formatAttemptPrompt 输出结构验证
// ============================================================

test("g-296：formatAttemptPrompt 输出结构——section 顺序正确", () => {
  const output = prompt({
    attemptBrief: "brief 内容",
    directive: "directive 内容",
    taskType: "fix",
    baselineCommit: "abc123",
    acceptanceItems: ["验收项一"],
  });
  const idxBrief = output.indexOf("## 本次 attempt brief/directive");
  const idxOverride = output.indexOf("## 覆盖声明");
  const idxCards = output.indexOf("## 已收集上下文卡片成果");
  const idxDiscipline = output.indexOf("## 通用执行纪律");

  assert.ok(idxBrief >= 0, "brief/directive 段存在");
  assert.ok(idxOverride >= 0, "覆盖声明段存在");
  assert.ok(idxCards >= 0, "卡片段存在");
  assert.ok(idxDiscipline >= 0, "通用纪律段存在");
  assert.ok(idxBrief < idxOverride, "brief/directive 在覆盖声明前");
  assert.ok(idxOverride < idxCards, "覆盖声明在卡片前");
  assert.ok(idxCards < idxDiscipline, "卡片在通用纪律前");
});
