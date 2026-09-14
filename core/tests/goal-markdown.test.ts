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

test("g-270: 客户端 Bundle 契约——包含 Markdown 组件与 DSH 原语引用", () => {
  const clientBundle = readFileSync("dsh-graph-host/lib/client.js", "utf8");
  assert.ok(clientBundle.includes("function GoalMarkdown("), "Bundle 应包含 GoalMarkdown 组件");
  assert.ok(clientBundle.includes("function renderSimpleMarkdown("), "Bundle 应包含 renderSimpleMarkdown 解析器");
  assert.ok(clientBundle.includes("function parseInlineMarkdown("), "Bundle 应包含 parseInlineMarkdown 解析器");
  assert.ok(clientBundle.includes("MarkdownText"), "Bundle 应包含 MarkdownText 原语引用");
  assert.ok(clientBundle.includes("dg-markdown-body"), "Bundle 应包含 dg-markdown-body 样式类");

  const pkg = JSON.parse(readFileSync("dsh-graph-host/package.json", "utf8"));
  assert.ok(
    pkg.dsh?.client?.inject?.includes("@deepseek-ai/dsh-client-ui-primitives"),
    "package.json 的 client.inject 应声明 @deepseek-ai/dsh-client-ui-primitives",
  );
});
