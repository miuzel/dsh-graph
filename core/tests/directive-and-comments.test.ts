/** g-150 范围扩展：最近指令（directive）与评论（comments）——行为级测试。
 *  验证：
 *  ① core 函数：readGoalDirective / setGoalDirective / readGoalComments / appendGoalComment
 *  ② 格式化：formatGoalDirectiveSection 无指令返回空字符串，有指令返回带标题段
 *  ③ goalDetail 返回 directive 和 comments 字段
 *  ④ startAttempt 记录 injected_directive 到 meta 和事件
 *  ⑤ 兼容性：无指令时 prompt 不含指令段；GOAL_BODY 新模板有「最近指令」「评论」小节
 *  ⑥ 畸形输入：空评论、非 string directive 不崩溃
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  readGoalDirective,
  setGoalDirective,
  readGoalComments,
  appendGoalComment,
  formatGoalDirectiveSection,
  startAttempt,
  findGoalFile,
  loadGoal,
  goalDetail,
  saveGoal,
  recordAttemptHandoff,
} from "../ops.ts";
import { sectionText } from "../model.ts";
import { readEvents } from "../events.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g150-dir-"));
  init(dir);
  return dir;
}

// ---- ① core 读取函数 ----

test("g-150 directive：新目标的 GOAL_BODY 包含最近指令和评论小节", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试目标", version: "v-t", actor: "test" });
  const file = findGoalFile(root, goal);
  const body = loadGoal(file).body;
  assert.ok(body.includes("## 最近指令"), "GOAL_BODY 应包含最近指令小节");
  assert.ok(body.includes("## 评论"), "GOAL_BODY 应包含评论小节");
});

test("g-150 directive：readGoalDirective 无指令时返回 null", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  assert.equal(readGoalDirective(root, goal), null);
});

test("g-150 directive：setGoalDirective 写入 + readGoalDirective 读取", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  setGoalDirective(root, goal, "本次只改 API 层，不要动 GUI", "supervisor:test");
  assert.equal(readGoalDirective(root, goal), "本次只改 API 层，不要动 GUI");
});

test("g-150 directive：setGoalDirective 覆盖旧指令", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  setGoalDirective(root, goal, "旧指令", "test");
  setGoalDirective(root, goal, "新指令", "test");
  assert.equal(readGoalDirective(root, goal), "新指令");
});

test("g-150 directive：setGoalDirective 清空指令", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  setGoalDirective(root, goal, "有内容", "test");
  setGoalDirective(root, goal, "", "test");
  assert.equal(readGoalDirective(root, goal), null);
});

test("g-150 directive：setGoalDirective 事件先行", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  setGoalDirective(root, goal, "测试指令", "supervisor:abc");
  const events = readEvents(root).filter((e) => e.event === "goal.directive_set" && e.goal === goal);
  assert.equal(events.length, 1);
  assert.equal(events[0].details.directive, "测试指令");
  assert.equal(events[0].actor, "supervisor:abc");
});

test("g-150 directive：setGoalDirective 非 string 抛错", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  assert.throws(() => setGoalDirective(root, goal, 123 as any, "test"), /directive 必须是 string 类型/);
});

// ---- ① core 读取函数（评论） ----

test("g-150 comments：readGoalComments 无评论返回空数组", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  assert.deepEqual(readGoalComments(root, goal), []);
});

test("g-150 comments：appendGoalComment 写入 + readGoalComments 读取", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  appendGoalComment(root, goal, "这是一条评论", "human:负责人");
  const comments = readGoalComments(root, goal);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].text, "这是一条评论");
  assert.equal(comments[0].author, "负责人");
});

test("g-150 comments：多条评论按顺序追加", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  appendGoalComment(root, goal, "第一条", "test");
  appendGoalComment(root, goal, "第二条", "test");
  appendGoalComment(root, goal, "第三条", "test");
  const comments = readGoalComments(root, goal);
  assert.equal(comments.length, 3);
  assert.equal(comments[0].text, "第一条");
  assert.equal(comments[1].text, "第二条");
  assert.equal(comments[2].text, "第三条");
});

test("g-150 comments：appendGoalComment 空文本抛错", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  assert.throws(() => appendGoalComment(root, goal, "", "test"), /评论内容不能为空/);
  assert.throws(() => appendGoalComment(root, goal, "  \n  ", "test"), /评论内容不能为空/);
});

test("g-150 comments：appendGoalComment 事件先行", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  appendGoalComment(root, goal, "测试评论", "supervisor:abc");
  const events = readEvents(root).filter((e) => e.event === "goal.comment_added" && e.goal === goal);
  assert.equal(events.length, 1);
  assert.equal(events[0].details.text, "测试评论");
  assert.equal(events[0].actor, "supervisor:abc");
});

// ---- ② 格式化 ----

test("g-150 directive：formatGoalDirectiveSection 无指令返回空字符串", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  assert.equal(formatGoalDirectiveSection(root, goal), "");
});

test("g-150 directive：formatGoalDirectiveSection 有指令返回带标题段", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  setGoalDirective(root, goal, "只改 core 层", "test");
  const section = formatGoalDirectiveSection(root, goal);
  assert.ok(section.includes("## 最近指令"), "应包含标题");
  assert.ok(section.includes("只改 core 层"), "应包含指令内容");
  assert.ok(section.includes(goal), "应包含 goal id");
});

// ---- ③ goalDetail ----

test("g-150 directive/comments：goalDetail 返回 directive 和 comments", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  setGoalDirective(root, goal, "测试指令", "test");
  appendGoalComment(root, goal, "测试评论", "test");
  const detail = goalDetail(root, goal);
  assert.equal(detail.directive, "测试指令");
  assert.equal(detail.comments.length, 1);
  assert.equal(detail.comments[0].text, "测试评论");
});

test("g-150 directive/comments：goalDetail 无指令无评论返回 null 和空数组", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  const detail = goalDetail(root, goal);
  assert.equal(detail.directive, null);
  assert.deepEqual(detail.comments, []);
  assert.equal(detail.handoff, null, "无 handoff 时返回 null");
});

test("g-150 directive/comments/handoff：goalDetail 返回 handoff", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试handoff", version: "v-t", actor: "test" });
  const att = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  recordAttemptHandoff(root, goal, {
    source_attempts: [att],
    failures: "失败",
    constraints: "约束",
    baseline: "基线",
    verification: "验收",
    confirmed_by: "supervisor:s1",
    actor: "supervisor:s1",
  });
  const detail = goalDetail(root, goal);
  assert.ok(detail.handoff, "有 handoff");
  assert.equal(detail.handoff.failures, "失败");
  assert.equal(detail.handoff.constraints, "约束");
});

// ---- ④ startAttempt 记录 injected_directive ----

test("g-150 directive：startAttempt 有 injectedDirective 时记录到 meta 和事件", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  const attId = startAttempt(root, goal, {
    executor: "agent:test",
    actor: "test",
    injectedDirective: "只改 API",
  });
  const attFile = join(findGoalFile(root, goal).replace(/goal\.md$/, ""), "attempts", attId, "attempt.md");
  const attMeta = loadGoal(attFile).meta;
  assert.equal(attMeta.injected_directive, "只改 API");
  const events = readEvents(root).filter((e) => e.event === "attempt.started" && e.goal === goal);
  assert.equal(events[0].details.injected_directive, "只改 API");
});

test("g-150 directive：startAttempt 无 injectedDirective 时不记录", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  const attId = startAttempt(root, goal, { executor: "agent:test", actor: "test" });
  const attFile = join(findGoalFile(root, goal).replace(/goal\.md$/, ""), "attempts", attId, "attempt.md");
  const attMeta = loadGoal(attFile).meta;
  assert.equal(attMeta.injected_directive, undefined);
  const events = readEvents(root).filter((e) => e.event === "attempt.started" && e.goal === goal);
  assert.equal(events[0].details.injected_directive, undefined);
});

// ---- ⑤ 兼容性 ----

test("g-150 directive：无指令时 formatGoalDirectiveSection 返回空字符串", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  assert.equal(formatGoalDirectiveSection(root, goal), "");
});

test("g-150 directive：老目标（无最近指令小节）setGoalDirective 追加小节", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  // 手动删除最近指令小节模拟老目标
  const file = findGoalFile(root, goal);
  const doc = loadGoal(file);
  doc.body = doc.body.replace(/\n## 最近指令[\s\S]*?(?=\n## )/, "");
  saveGoal(file, doc);
  // 现在设置指令
  setGoalDirective(root, goal, "老目标的指令", "test");
  assert.equal(readGoalDirective(root, goal), "老目标的指令");
});

// ---- ⑥ 畸形输入 ----

test("g-150 directive：空白指令清空小节", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  setGoalDirective(root, goal, "有内容", "test");
  setGoalDirective(root, goal, "   \n  ", "test");
  assert.equal(readGoalDirective(root, goal), null);
});

test("g-150 comments：多行评论正确保存和读取", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  appendGoalComment(root, goal, "第一行\n第二行\n第三行", "test");
  const comments = readGoalComments(root, goal);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].text, "第一行\n第二行\n第三行");
});

test("g-150 directive：startAttempt 同时有 injectedDirective 和 injectedHandoffs", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  const attId = startAttempt(root, goal, {
    executor: "agent:test",
    actor: "test",
    injectedDirective: "指令内容",
    injectedHandoffs: [{ id: "hf-001", revision: 1, source_attempts: ["att-001"] }],
  });
  const attFile = join(findGoalFile(root, goal).replace(/goal\.md$/, ""), "attempts", attId, "attempt.md");
  const attMeta = loadGoal(attFile).meta;
  assert.equal(attMeta.injected_directive, "指令内容");
  assert.deepEqual(attMeta.injected_handoffs, [{ id: "hf-001", revision: 1, source_attempts: ["att-001"] }]);
});

// ---- ⑦ 结构保护：directive/comment 内容中的 ## / ### 不得破坏 section 边界（g-150 返工阻断项 #5） ----

test("g-150 结构保护：directive 中 ## 开头的行被转义为 \\## ", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "结构保护", version: "v-t", actor: "test" });
  setGoalDirective(root, goal, "正常内容\n## 这不是标题\n### 子标题", "test");
  // 读取文件验证 ## 被转义
  const goalFile = findGoalFile(root, goal);
  const doc = loadGoal(goalFile);
  const raw = sectionText(doc.body, "最近指令");
  assert.ok(raw, "最近指令小节存在");
  assert.ok(!raw.includes("\n## 这不是标题\n"), "## 开头的行不应原样出现");
  assert.ok(raw.includes("\\## 这不是标题"), "## 被转义为 \\##");
  assert.ok(raw.includes("\\### 子标题"), "### 被转义为 \\###");
  // 但 readGoalDirective 应返回转义后的内容（非 null）
  const directive = readGoalDirective(root, goal);
  assert.ok(directive, "readGoalDirective 返回非 null");
  assert.ok(directive.includes("\\## 这不是标题"), "转义后内容保留");
});

test("g-150 结构保护：comment 中 ## 开头的行被转义", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "评论保护", version: "v-t", actor: "test" });
  appendGoalComment(root, goal, "好\n## 伪造标题\n### 伪造子标题", "test");
  const goalFile = findGoalFile(root, goal);
  const doc = loadGoal(goalFile);
  const raw = sectionText(doc.body, "评论");
  assert.ok(raw, "评论小节存在");
  assert.ok(!raw.includes("\n## 伪造标题\n"), "## 不应原样出现");
  assert.ok(raw.includes("\\## 伪造标题"), "## 被转义");
  // readGoalComments 应返回转义后的内容
  const comments = readGoalComments(root, goal);
  assert.equal(comments.length, 1);
  assert.ok(comments[0].text.includes("\\## 伪造标题"), "评论中 ## 被转义");
});
