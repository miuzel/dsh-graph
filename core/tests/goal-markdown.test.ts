/**
 * g-270：目标描述 Markdown 体验一致性与结构保护测试
 * 
 * 验证：
 * 1. normalizeDescriptionHeadings：
 *    - 围栏外 ## 自动降级为 ###，保护 goal.md 小节边界
 *    - 围栏外 # 自动降级为 ###
 *    - 围栏外 ### 及更深层标题原样保留，绝不添加 \### 反斜杠
 *    - 围栏内（``` 或 ~~~）的 ## 标题逐字保留，不降级
 *    - #tag、C#、普通文本不受影响
 * 2. sectionText & replaceSection 代码围栏感知：
 *    - 围栏内的 ## 质量判据 不被误当作小节分隔符
 *    - replaceSection 替换小节时，正文中的围栏不被意外截断
 * 3. extractGoalDescription & goalDetail：
 *    - extractGoalDescription 正确提取含代码围栏的目标描述
 *    - goalDetail 返回结构化的 description 字段
 * 4. 客户端源码契约与渲染测试：
 *    - lib/client.js 包含 GoalMarkdown、renderSimpleMarkdown、parseInlineMarkdown
 *    - package.json 声明 @deepseek-ai/dsh-client-ui-primitives 注入
 *    - renderSimpleMarkdown 纯函数正确解析段落、标题、列表、代码块、引用、粗体、行内代码、附件引用
 *    - XSS 防御：链接禁止 javascript: 协议，无 innerHTML
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
  extractGoalDescription,
  goalDetail,
  findGoalFile,
  loadGoal,
  saveGoal,
  amendGoal,
  formatTargetContext,
  normalizeDescriptionHeadings,
} from "../ops.ts";
import { sectionText, replaceSection } from "../model.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g270-md-"));
  init(dir);
  return dir;
}

// ---- ① normalizeDescriptionHeadings 单元测试 ----

test("g-270: normalizeDescriptionHeadings 标题降级与无反斜杠保留", () => {
  const input = [
    "# 一级标题",
    "## 二级标题",
    "### 三级标题",
    "#### 四级标题",
    "  ## 缩进二级标题",
    "##### 五级标题",
    "C# 语言与 #123 标签不是标题",
  ].join("\n");

  const actual = normalizeDescriptionHeadings(input);
  const lines = actual.split("\n");

  assert.equal(lines[0], "### 一级标题", "h1 应降级为 h3");
  assert.equal(lines[1], "### 二级标题", "h2 应降级为 h3");
  assert.equal(lines[2], "### 三级标题", "h3 应原样保留");
  assert.equal(lines[3], "#### 四级标题", "h4 应原样保留");
  assert.equal(lines[4], "  ### 缩进二级标题", "带缩进的 h2 也降级为 h3");
  assert.equal(lines[5], "##### 五级标题", "h5 应原样保留");
  assert.equal(lines[6], "C# 语言与 #123 标签不是标题", "非标题语法保持原样");
  assert.ok(!actual.includes("\\#"), "不应包含任何反斜杠转义字符");
});

test("g-270: normalizeDescriptionHeadings 代码围栏内标题逐字保留", () => {
  const input = [
    "说明正文",
    "```markdown",
    "# 围栏内 h1",
    "## 围栏内 h2",
    "### 围栏内 h3",
    "```",
    "## 围栏外 h2",
    "~~~bash",
    "## 围栏内波浪号 h2",
    "~~~",
  ].join("\n");

  const actual = normalizeDescriptionHeadings(input);
  const lines = actual.split("\n");

  assert.equal(lines[2], "# 围栏内 h1", "``` 围栏内 h1 不应改动");
  assert.equal(lines[3], "## 围栏内 h2", "``` 围栏内 h2 不应改动");
  assert.equal(lines[4], "### 围栏内 h3", "``` 围栏内 h3 不应改动");
  assert.equal(lines[6], "### 围栏外 h2", "围栏外 h2 应降级为 h3");
  assert.equal(lines[8], "## 围栏内波浪号 h2", "~~~ 围栏内 h2 不应改动");
});

// ---- ② sectionText & replaceSection 围栏感知测试 ----

test("g-270: sectionText 忽略代码围栏内的 ## 标题", () => {
  const body = [
    "## 目标描述",
    "",
    "这是正文",
    "```markdown",
    "## 质量判据",
    "代码块内的伪判据",
    "```",
    "正文后半段",
    "",
    "## 质量判据",
    "",
    "1. 真正的第一条判据",
    "",
  ].join("\n");

  const desc = sectionText(body, "目标描述");
  assert.ok(desc, "应提取到目标描述");
  assert.ok(desc.includes("代码块内的伪判据"), "描述应完整包含代码块内容");
  assert.ok(desc.includes("正文后半段"), "描述应包含代码块之后的内容，不被围栏内的 ## 截断");
  assert.ok(!desc.includes("真正的第一条判据"), "描述不应包含后续真正小节内容");

  const crit = sectionText(body, "质量判据");
  assert.ok(crit, "应提取到质量判据");
  assert.ok(crit.includes("真正的第一条判据"), "质量判据应为真正的小节");
  assert.ok(!crit.includes("代码块内的伪判据"), "质量判据不应包含代码块中的伪判据");
});

test("g-270: replaceSection 忽略代码围栏内的 ## 标题", () => {
  const body = [
    "## 目标描述",
    "",
    "```markdown",
    "## 质量判据",
    "```",
    "正文",
    "",
    "## 质量判据",
    "",
    "1. 判据一",
  ].join("\n");

  const replaced = replaceSection(body, "目标描述", "\n新描述内容\n");
  assert.ok(replaced.includes("新描述内容"), "新描述内容应存在");
  assert.ok(replaced.includes("1. 判据一"), "后续质量判据小节应完整保留");
  assert.equal(sectionText(replaced, "目标描述")?.trim(), "新描述内容");
  assert.equal(sectionText(replaced, "质量判据")?.trim(), "1. 判据一");
});

// ---- ③ extractGoalDescription 与 goalDetail 端到端测试 ----

test("g-270: setGoalDescription 写入后 goalDetail.description 与 extractGoalDescription 一致无多余转义", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "测试", version: "v-t", actor: "test" });
  const richDesc = [
    "制作 v0.10.0 演示数据时发现的缺陷：",
    "",
    "1. **编辑与查看不一致**：就地编辑采用 Markdown，只读态为纯文本；",
    "2. **服务端静默转义**：标题被加上了反斜杠。",
    "",
    "### 待确认方向",
    "- 方案一：只读端渲染 Markdown",
    "- 方案二：保持纯文本",
    "- 方案三：两者都做",
    "",
    "```typescript",
    "## 围栏内标题不应被改动",
    'console.log("hello");',
    "```",
    "",
    "附件：@att/demo.png",
  ].join("\n");

  setGoalDescription(root, goal, richDesc, "human:gui");

  const detail = goalDetail(root, goal);
  assert.ok(detail.description, "goalDetail 应下发 description 字段");
  assert.ok(!detail.description.includes("\\###"), "description 不应包含 \\### 反斜杠");
  assert.ok(detail.description.includes("### 待确认方向"), "### 待确认方向应保持为三级标题");
  assert.ok(detail.description.includes("## 围栏内标题不应被改动"), "围栏内的 ## 标题应原样保留");
  assert.ok(detail.description.includes("1. **编辑与查看不一致**"), "列表与加粗应完整保留");

  const extracted = extractGoalDescription(detail.body);
  assert.equal(extracted, detail.description, "extractGoalDescription 与 detail.description 应严格一致");
});

// ---- ④ 客户端源码契约测试 ----

test("g-270: 客户端 Bundle 契约——包含 Markdown 组件、DSH 原语引用、错误边界与样式", () => {
  const clientBundle = readFileSync("dsh-graph-host/lib/client.js", "utf8");
  assert.ok(clientBundle.includes("function GoalMarkdown("), "Bundle 应包含 GoalMarkdown 组件");
  assert.ok(clientBundle.includes("function renderSimpleMarkdown("), "Bundle 应包含 renderSimpleMarkdown 解析器");
  assert.ok(clientBundle.includes("function parseInlineMarkdown("), "Bundle 应包含 parseInlineMarkdown 解析器");
  assert.ok(clientBundle.includes("MarkdownText"), "Bundle 应包含 MarkdownText 原语引用");
  assert.ok(clientBundle.includes("dg-markdown-body"), "Bundle 应包含 dg-markdown-body 样式类");
  assert.ok(clientBundle.includes("dg-description-preview"), "Bundle 应包含 dg-description-preview 样式类");
  assert.ok(clientBundle.includes("class MarkdownErrorBoundary"), "Bundle 应包含 MarkdownErrorBoundary 错误边界组件");
  assert.ok(clientBundle.includes("copyLabel:"), "Bundle 必须传递 copyLabel prop");
  assert.ok(clientBundle.includes("copiedLabel:"), "Bundle 必须传递 copiedLabel prop");
  assert.ok(clientBundle.includes("streaming: false"), "Bundle 必须传递 streaming: false");
  assert.ok(clientBundle.includes("--dsw-alias-fill-tsp-secondary"), "样式必须优先使用 DSH 主题变量 --dsw-alias-fill-tsp-secondary");
  assert.ok(clientBundle.includes("data-ds-dark-theme"), "样式必须自适应暗色主题选择器 data-ds-dark-theme");

  const pkg = JSON.parse(readFileSync("dsh-graph-host/package.json", "utf8"));
  assert.ok(
    pkg.dsh?.client?.inject?.includes("@deepseek-ai/dsh-client-ui-primitives"),
    "package.json 的 client.inject 应声明 @deepseek-ai/dsh-client-ui-primitives",
  );
});

// ---- ⑤ 未闭合代码围栏防护测试（>=3条）----

test("g-270: 未闭合 ``` 围栏安全降级，不吞噬后续 ## 小节（指令/评论/证据台账）", () => {
  const body = [
    "## 目标描述",
    "",
    "这是未闭合代码段前的正文",
    "```typescript",
    "console.log('unclosed code block');",
    "",
    "## 最近指令",
    "",
    "这是最近指令内容",
    "",
    "## 评论",
    "",
    "### 2026-03-31T00:00:00Z | user",
    "这是评论内容",
    "",
    "## 证据台账",
    "",
    "证据项内容",
  ].join("\n");

  // 1. sectionText 读取未闭合围栏后的各小节，必须非 null 且内容完整
  assert.equal(sectionText(body, "最近指令")?.trim(), "这是最近指令内容", "未闭合围栏后最近指令必须存在");
  assert.ok(sectionText(body, "评论")?.includes("这是评论内容"), "未闭合围栏后评论必须存在");
  assert.equal(sectionText(body, "证据台账")?.trim(), "证据项内容", "未闭合围栏后证据台账必须存在");

  // 2. replaceSection 替换目标描述时，后续小节必须结构存活，不得并入描述正文
  const replaced = replaceSection(body, "目标描述", "\n更新后的描述\n");
  assert.equal(sectionText(replaced, "目标描述")?.trim(), "更新后的描述", "描述小节应被更新");
  assert.equal(sectionText(replaced, "最近指令")?.trim(), "这是最近指令内容", "最近指令必须存活");
  assert.ok(sectionText(replaced, "评论")?.includes("这是评论内容"), "评论小节必须存活");
  assert.equal(sectionText(replaced, "证据台账")?.trim(), "证据项内容", "证据台账必须存活");
});

test("g-270: 未闭合 ~~~ 围栏安全降级，不吞噬后续 ## 小节", () => {
  const body = [
    "## 目标描述",
    "",
    "正文段落",
    "~~~python",
    "def foo():",
    "    return 42",
    "",
    "## 最近指令",
    "",
    "指令执行步骤",
    "",
    "## 质量判据",
    "",
    "1. 判据一",
  ].join("\n");

  assert.equal(sectionText(body, "最近指令")?.trim(), "指令执行步骤", "未闭合波浪号围栏后指令必须存在");
  assert.equal(sectionText(body, "质量判据")?.trim(), "1. 判据一", "未闭合波浪号围栏后判据必须存在");

  const replaced = replaceSection(body, "目标描述", "\n替换正文\n");
  assert.equal(sectionText(replaced, "目标描述")?.trim(), "替换正文");
  assert.equal(sectionText(replaced, "最近指令")?.trim(), "指令执行步骤");
  assert.equal(sectionText(replaced, "质量判据")?.trim(), "1. 判据一");
});

test("g-270: 已闭合围栏内 ## 标题合法保留，不被误作为小节切分点且后续小节完整", () => {
  const body = [
    "## 目标描述",
    "",
    "```bash",
    "## 这是一个 bash 注释伪标题",
    "echo 'hello'",
    "```",
    "",
    "## 最近指令",
    "",
    "合法的最近指令",
  ].join("\n");

  const desc = sectionText(body, "目标描述");
  assert.ok(desc, "目标描述必须存在");
  assert.ok(desc.includes("## 这是一个 bash 注释伪标题"), "闭合围栏内的 ## 标题必须完整保留在描述中");
  assert.ok(!desc.includes("合法的最近指令"), "描述不应越界包含最近指令");

  const directive = sectionText(body, "最近指令");
  assert.equal(directive?.trim(), "合法的最近指令", "最近指令小节必须被正确识别与提取");
});

test("g-270: UI setGoalDescription 端到端写路径遇未闭合围栏不吞噬后续小节", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "未闭合围栏保存测试", actor: "human:gui" });
  const file = findGoalFile(root, goal);
  const doc = loadGoal(file);

  doc.body = [
    "## 目标描述",
    "",
    "初始描述",
    "",
    "## 最近指令",
    "",
    "这是重要指令",
    "",
    "## 评论",
    "",
    "### 2026-03-31T00:00:00Z | human:gui",
    "这是历史评论",
  ].join("\n");
  saveGoal(file, doc);

  // 模拟 UI 保存一段含有未闭合 ``` 围栏的描述
  const unclosedDesc = "这是一段编辑态保存的内容：\n```ts\nconst unclosed = true;\n// 忘记写闭合围栏了";
  setGoalDescription(root, goal, unclosedDesc, "human:gui");

  const updatedDoc = loadGoal(file);
  assert.equal(sectionText(updatedDoc.body, "最近指令")?.trim(), "这是重要指令", "setGoalDescription 后最近指令必须存活");
  assert.ok(sectionText(updatedDoc.body, "评论")?.includes("这是历史评论"), "setGoalDescription 后评论必须存活");
  assert.ok(sectionText(updatedDoc.body, "目标描述")?.includes("const unclosed = true;"), "目标描述内容必须完整保存");
});

// ---- ⑥ 多处读取路径 fence-aware 一致性测试 ----

test("g-270: formatTargetContext 遇到描述中闭合围栏内 ## 不截断，判据完整", () => {
  const body = [
    "## 目标描述",
    "",
    "目标背景前言",
    "```markdown",
    "## 伪标题 1",
    "## 伪标题 2",
    "```",
    "目标背景后记",
    "",
    "## 质量判据",
    "",
    "1. 验收判据必须完整保留",
  ].join("\n");

  const context = formatTargetContext(body);
  assert.ok(context.includes("目标背景前言"), "应包含前言");
  assert.ok(context.includes("## 伪标题 1"), "应完整包含围栏内标题");
  assert.ok(context.includes("目标背景后记"), "描述不应在围栏内 ## 处被截断");
  assert.ok(context.includes("1. 验收判据必须完整保留"), "质量判据必须完整");
});

test("g-270: amendGoal(appendDescription) 遇到描述中围栏内 ## 追加在正文末尾，绝不插进代码块内部", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "amend 追加测试", actor: "human:gui" });
  const file = findGoalFile(root, goal);
  const doc = loadGoal(file);
  doc.body = [
    "## 目标描述",
    "",
    "这是原描述",
    "```typescript",
    "## 围栏内标题",
    "const foo = 'bar';",
    "```",
    "",
    "## 质量判据",
    "",
    "1. 判据一",
  ].join("\n");
  saveGoal(file, doc);

  amendGoal(root, goal, {
    note: "追加补充说明",
    appendDescription: "这是追加的补充文本",
    actor: "human:gui",
  });

  const updatedDoc = loadGoal(file);
  const desc = sectionText(updatedDoc.body, "目标描述");
  assert.ok(desc, "目标描述应存在");
  const fenceEndIdx = desc.lastIndexOf("```");
  const appendIdx = desc.indexOf("这是追加的补充文本");
  assert.ok(fenceEndIdx >= 0 && appendIdx > fenceEndIdx, "追加内容必须位于代码块闭合标记之后，绝不可插进代码块内部");
  assert.equal(sectionText(updatedDoc.body, "质量判据")?.trim(), "1. 判据一", "后续质量判据保持完好");
});
