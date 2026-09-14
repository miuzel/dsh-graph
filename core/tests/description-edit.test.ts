/** g-260：目标描述就地编辑——行为级测试。
 *  验证：
 *  ① setGoalDescription 写入后 goal.md 描述小节内容一致
 *  ② frontmatter 与其他小节（质量判据/最近指令/评论）字节级不变
 *  ③ 事件先行：goal.description_set 事件正确追加
 *  ④ 空串清空描述小节
 *  ⑤ sanitizeHeadingContent 防 ## 标题注入破坏 section 边界
 *  ⑥ 含特殊字符（代码块、@att/ 引用、中文、空行）往返保存无损坏
 *  ⑦ 小节不存在时兜底追加
 *  ⑧ 非 string 输入抛错
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  setGoalDescription,
  setGoalDirective,
  appendGoalComment,
  findGoalFile,
  loadGoal,
  saveGoal,
} from "../ops.ts";
import { sectionText, parseDoc, serializeDoc } from "../model.ts";
import { readEvents } from "../events.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g260-desc-"));
  init(dir);
  return dir;
}

// ---- ① 基本写入 + 读取 ----

test("g-260 setGoalDescription：写入后描述小节内容一致", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  const newDesc = "这是新的目标描述\n\n支持多行内容";
  setGoalDescription(root, goal, newDesc, "human:gui");
  const file = findGoalFile(root, goal);
  const body = loadGoal(file).body;
  const actual = sectionText(body, "目标描述");
  assert.ok(actual, "描述小节应存在");
  assert.ok(actual.includes("这是新的目标描述"), "应包含新描述内容");
  assert.ok(actual.includes("支持多行内容"), "应包含多行内容");
});

// ---- ② frontmatter 与其他小节不变 ----

test("g-260 setGoalDescription：frontmatter 与其他小节字节级不变", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  const file = findGoalFile(root, goal);

  // 先写入一些其他小节内容
  setGoalDirective(root, goal, "测试指令内容", "test");
  appendGoalComment(root, goal, "测试评论内容", "test");

  // 读取保存前的 frontmatter + 其他小节
  const before = readFileSync(file, "utf8");
  const beforeDoc = parseDoc(before);
  const beforeMeta = JSON.stringify(beforeDoc.meta);
  const beforeCrit = sectionText(beforeDoc.body, "质量判据");
  const beforeDir = sectionText(beforeDoc.body, "最近指令");
  const beforeCmt = sectionText(beforeDoc.body, "评论");

  // 修改描述
  setGoalDescription(root, goal, "新描述内容", "human:gui");

  // 读取保存后
  const after = readFileSync(file, "utf8");
  const afterDoc = parseDoc(after);
  const afterMeta = JSON.stringify(afterDoc.meta);
  const afterCrit = sectionText(afterDoc.body, "质量判据");
  const afterDir = sectionText(afterDoc.body, "最近指令");
  const afterCmt = sectionText(afterDoc.body, "评论");

  // frontmatter 字节级不变
  assert.equal(afterMeta, beforeMeta, "frontmatter 应字节级不变");
  // 其他小节不变
  assert.equal(afterCrit, beforeCrit, "质量判据小节应不变");
  assert.equal(afterDir, beforeDir, "最近指令小节应不变");
  assert.equal(afterCmt, beforeCmt, "评论小节应不变");
});

// ---- ③ 事件先行 ----

test("g-260 setGoalDescription：goal.description_set 事件正确追加", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  setGoalDescription(root, goal, "描述内容", "human:gui");
  const events = readEvents(root);
  const descEvents = events.filter((e) => e.event === "goal.description_set");
  assert.equal(descEvents.length, 1, "应有一条 description_set 事件");
  assert.equal(descEvents[0].goal, goal, "事件应关联正确目标");
  assert.equal(descEvents[0].details?.description, "描述内容", "事件应记录描述内容");
  assert.equal(descEvents[0].actor, "human:gui", "事件应记录 actor");
});

test("g-260 setGoalDescription：多次修改产生多条事件", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  setGoalDescription(root, goal, "第一版", "test");
  setGoalDescription(root, goal, "第二版", "test");
  const events = readEvents(root);
  const descEvents = events.filter((e) => e.event === "goal.description_set");
  assert.equal(descEvents.length, 2, "应有两条 description_set 事件");
  assert.equal(descEvents[1].details?.description, "第二版", "第二条事件记录最新内容");
});

// ---- ④ 空串清空描述 ----

test("g-260 setGoalDescription：空串清空描述小节", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  setGoalDescription(root, goal, "有内容", "test");
  setGoalDescription(root, goal, "", "test");
  const file = findGoalFile(root, goal);
  const body = loadGoal(file).body;
  const actual = sectionText(body, "目标描述");
  // 空串清空后，小节内容应为空（仅含空白）
  assert.equal(actual?.trim(), "", "空串应清空描述小节");
});

test("g-260 setGoalDescription：空串事件记录 description=null", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  setGoalDescription(root, goal, "", "test");
  const events = readEvents(root);
  const descEvents = events.filter((e) => e.event === "goal.description_set");
  assert.equal(descEvents[0].details?.description, null, "空串事件应记录 description=null");
});

// ---- ⑤ g-270：normalizeDescriptionHeadings 标题结构保护（h1/h2 降级为 h3，不加反斜杠） ----

test("g-270 setGoalDescription：## 标题自动降级为 ###，不产生多余反斜杠且不破坏 section 边界", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  // 尝试注入 ## 质量判据 标题
  const malicious = "正常描述\n## 质量判据\n假判据内容\n## 评论\n假评论";
  setGoalDescription(root, goal, malicious, "test");

  const file = findGoalFile(root, goal);
  const body = loadGoal(file).body;

  // 描述小节内不应出现未降级的 ## 质量判据，也不应出现反斜杠 \##
  const descSection = sectionText(body, "目标描述");
  assert.ok(descSection, "描述小节应存在");
  assert.ok(!descSection.includes("\n## 质量判据\n"), "不应包含未降级的 ## 标题");
  assert.ok(!descSection.includes("\\##"), "不应包含反斜杠转义");
  assert.ok(descSection.includes("### 质量判据"), "## 标题应被优雅降级为 ### 标题");

  // 质量判据小节应保持原样（模板占位）
  const critSection = sectionText(body, "质量判据");
  assert.ok(critSection, "质量判据小节应存在");
  assert.ok(!critSection.includes("假判据内容"), "质量判据不应被注入内容");
});

test("g-270 setGoalDescription：### 标题完全保留，不加反斜杠转义", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  const input = "描述内容\n### 子标题注入\n#### 四级标题";
  setGoalDescription(root, goal, input, "test");

  const file = findGoalFile(root, goal);
  const body = loadGoal(file).body;
  const descSection = sectionText(body, "目标描述");
  assert.ok(descSection, "描述小节应存在");
  assert.ok(descSection.includes("### 子标题注入"), "### 标题应原样保留");
  assert.ok(descSection.includes("#### 四级标题"), "#### 标题应原样保留");
  assert.ok(!descSection.includes("\\###"), "不应包含任何反斜杠转义字符");
});

test("g-270 setGoalDescription：代码围栏内的 ## 标题不被降级且不破坏小节边界", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  const fenced = "正文\n\n```markdown\n## 围栏内保留的标题\n```\n\n## 围栏外标题";
  setGoalDescription(root, goal, fenced, "test");

  const file = findGoalFile(root, goal);
  const body = loadGoal(file).body;
  const descSection = sectionText(body, "目标描述");
  assert.ok(descSection, "描述小节应存在");
  assert.ok(descSection.includes("```markdown\n## 围栏内保留的标题\n```"), "围栏内的 ## 标题应逐字保留");
  assert.ok(descSection.includes("### 围栏外标题"), "围栏外的 ## 标题应降级为 ###");

  // 质量判据小节依然完好
  const critSection = sectionText(body, "质量判据");
  assert.ok(critSection, "质量判据小节应完好存在");
});

// ---- ⑥ 特殊字符往返保存 ----

test("g-260 setGoalDescription：代码块、@att/ 引用、中文、空行往返保存无损坏", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  const complex = [
    "这是中文描述",
    "",
    "引用附件：@att/design-spec.md",
    "",
    "代码示例：",
    "```",
    "function hello() {",
    '  console.log("world");',
    "}",
    "```",
    "",
    "另一引用：@att/data.xlsx",
  ].join("\n");

  setGoalDescription(root, goal, complex, "test");

  const file = findGoalFile(root, goal);
  const body = loadGoal(file).body;
  const actual = sectionText(body, "目标描述");
  assert.ok(actual, "描述小节应存在");
  assert.ok(actual.includes("这是中文描述"), "中文内容应保留");
  assert.ok(actual.includes("@att/design-spec.md"), "@att/ 引用应保留");
  assert.ok(actual.includes("```"), "代码块标记应保留");
  assert.ok(actual.includes('console.log("world")'), "代码内容应保留");
  assert.ok(actual.includes("@att/data.xlsx"), "第二个 @att/ 引用应保留");
});

// ---- ⑦ 小节不存在时兜底 ----

test("g-260 setGoalDescription：小节不存在时兜底追加", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  const file = findGoalFile(root, goal);

  // 手动删除描述小节
  const doc = loadGoal(file);
  doc.body = doc.body.replace(/## 目标描述[\s\S]*?(?=\n## |$)/, "");
  saveGoal(file, doc);

  // 写入描述
  setGoalDescription(root, goal, "兜底写入的描述", "test");

  const afterBody = loadGoal(file).body;
  const actual = sectionText(afterBody, "目标描述");
  assert.ok(actual, "描述小节应被创建");
  assert.ok(actual.includes("兜底写入的描述"), "应包含写入的内容");
});

// ---- ⑧ 非 string 输入抛错 ----

test("g-260 setGoalDescription：非 string description 抛 GraphError", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  assert.throws(
    () => setGoalDescription(root, goal, 123 as any, "test"),
    (e: any) => e.message.includes("description 必须是 string 类型"),
    "应抛出类型错误",
  );
});

// ---- ⑨ 目标不存在时抛错 ----

test("g-260 setGoalDescription：目标不存在时抛错", () => {
  const root = tmpRoot();
  assert.throws(
    () => setGoalDescription(root, "nonexistent", "描述", "test"),
    (e: any) => e.message.includes("目标不存在"),
    "应抛出目标不存在错误",
  );
});
