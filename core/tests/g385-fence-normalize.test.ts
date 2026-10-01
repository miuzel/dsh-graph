/**
 * g-385（v0.18.0 审查 C4，P2）：目标描述 Markdown 围栏识别口径修复回归测试
 *
 * 缺陷：normalizeDescriptionHeadings / normalizeAppend 对任意 ≥3 反引号/波浪号的行**朴素 toggle**，
 *      既不校验围栏字符类型也不校验闭合长度。于是「四反引号围栏内含三反引号示例」这类合法文档中，
 *      代码内部的 `##` 被改写为 `###`（破坏代码内容）、围栏外 `##` 又未降级，
 *      sectionText 读回「目标描述」被截断，代码片段漏进派发 prompt。
 *
 * 修复口径：写侧与读侧（sectionText / findSectionBounds）**共用 computeClosedFenceMask**；
 *          创建（createGoal）与编辑（setGoalDescription / amendGoal→normalizeAppend）同一口径。
 *          不引入 Markdown AST 框架，保留「围栏外 h1/h2 降级为 h3、h3 及更深不动、无反斜杠转义」语义。
 *
 * 覆盖输入：普通 ```、四反引号内含三反引号示例、```/~~~ 混用、3 空格缩进、未闭合围栏、
 *          闭合长度 ≥ 开启长度（算闭合）与 < 开启长度（不算闭合）。
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
  amendGoal,
  normalizeDescriptionHeadings,
  normalizeAppend,
  extractGoalDescription,
  formatTargetContext,
  findGoalFile,
  loadGoal,
} from "../ops.ts";
import { sectionText } from "../model.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g385-fence-"));
  init(dir);
  return dir;
}

/** 规范化整段文本并返回按行结果（便于逐行精确断言）。 */
function normLines(lines: string[]): string[] {
  return normalizeDescriptionHeadings(lines.join("\n")).split("\n");
}

/** 从拼接前的 client 源模块里精确抠出一个具名 function 声明（花括号配平；与 g273 测试同法）。 */
function extractFunction(source: string, name: string): string {
  return extractBalanced(source, `function ${name}(`);
}

/** 抠出一段以 marker 开头、花括号配平的声明文本（含模板串 ${…} 也按配平处理）。 */
function extractBalanced(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `源模块中存在 ${marker}`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${marker} 花括号无法配平`);
}

// ---- ① 围栏识别口径：字符类型 / 开启长度 / 闭合长度 ----

test("g-385: 四反引号围栏内含三反引号示例——代码内 ## 逐字保留，围栏外 ## 降级（C4 原复现）", () => {
  const lines = ["````markdown", "```ts", "## literal code heading", "````", "## actual heading"];
  const out = normLines(lines);
  assert.deepEqual(out, [
    "````markdown",
    "```ts",
    "## literal code heading",
    "````",
    "### actual heading",
  ], "四反引号围栏内的三反引号示例必须逐字保留，围栏外 h2 必须降级");
  assert.ok(!out.join("\n").includes("### literal"), "代码内的 ## 绝不可被改写为 ###");
  assert.ok(!out.join("\n").includes("\\#"), "不应引入反斜杠转义");
});

test("g-385: 普通 ``` 围栏与 ~~~ 混用——不同字符不互相闭合", () => {
  const lines = [
    "```markdown",
    "~~~",
    "## 波浪号行仍在 ``` 围栏内",
    "~~~",
    "```",
    "## 围栏外标题",
    "~~~bash",
    "## 波浪号围栏内标题",
    "~~~",
  ];
  const out = normLines(lines);
  assert.equal(out[2], "## 波浪号行仍在 ``` 围栏内", "``` 围栏内的 ~~~ 行不得关闭该围栏");
  assert.equal(out[5], "### 围栏外标题", "围栏外 h2 应降级");
  assert.equal(out[7], "## 波浪号围栏内标题", "~~~ 围栏内 h2 应逐字保留");
});

test("g-385: 3 空格缩进围栏同样被识别（含长围栏嵌套短围栏）", () => {
  const simple = normLines(["   ```ts", "   ## 缩进围栏内标题", "   ```", "## 外部标题"]);
  assert.equal(simple[1], "   ## 缩进围栏内标题", "缩进 ``` 围栏内 h2 应保留");
  assert.equal(simple[3], "### 外部标题", "缩进围栏之外的 h2 应降级");

  const nested = normLines([
    "   ````markdown",
    "   ```",
    "   ## 缩进长围栏内标题",
    "   ```",
    "   ````",
    "## 外部标题",
  ]);
  assert.equal(nested[2], "   ## 缩进长围栏内标题", "缩进四反引号围栏内的三反引号示例应逐字保留");
  assert.equal(nested[5], "### 外部标题", "围栏外 h2 应降级");
});

test("g-385: 未闭合围栏退化为普通文本行（与读侧同口径，不吞噬后续内容）", () => {
  const out = normLines(["```ts", "## 未闭合围栏内的标题", "const x = 1;", "## 更后面的标题"]);
  assert.deepEqual(out, [
    "```ts",
    "### 未闭合围栏内的标题",
    "const x = 1;",
    "### 更后面的标题",
  ], "未闭合围栏按普通文本处理（否则读侧会把围栏内 ## 当小节边界而截断描述）");
});

test("g-385: 闭合长度 ≥ 开启长度才算闭合；< 开启长度不算闭合", () => {
  // 四反引号开启，中间的 ``` 长度不足，不构成闭合 ⇒ 直到 ```` 才闭合，其间内容全部保留
  const shortClose = normLines([
    "````markdown",
    "```ts",
    "## 代码内标题",
    "```",
    "## 仍在围栏内（短闭合不算数）",
    "````",
    "## 真正的围栏外标题",
  ]);
  assert.equal(shortClose[2], "## 代码内标题", "短闭合标记不得关闭长围栏（代码内 ## 保留）");
  assert.equal(shortClose[4], "## 仍在围栏内（短闭合不算数）", "围栏直到真正的 ```` 才闭合");
  assert.equal(shortClose[6], "### 真正的围栏外标题", "真闭合之后的 h2 应降级");

  // 更长的闭合标记同样有效
  const longClose = normLines(["```ts", "## 代码内标题", "`````", "## 围栏外标题"]);
  assert.equal(longClose[1], "## 代码内标题", "更长的闭合标记应正常闭合");
  assert.equal(longClose[3], "### 围栏外标题", "闭合后的 h2 应降级");
});

// ---- ② 写入 → 读回：描述与派发内联全文不截断，质量判据不受影响 ----

test("g-385: setGoalDescription 后 sectionText/extractGoalDescription 读回目标描述完整不截断", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "围栏口径", version: "v-t", actor: "test" });
  const desc = [
    "````markdown",
    "```ts",
    "## literal code heading",
    "````",
    "## actual heading",
    "描述正文结尾——这段文字在修复前会被截断丢弃",
  ].join("\n");

  setGoalDescription(root, goal, desc, "test");
  const body = loadGoal(findGoalFile(root, goal)).body;
  const stored = sectionText(body, "目标描述");
  assert.ok(stored, "目标描述小节必须存在");

  // 代码逐字保留（含围栏标记本身）
  assert.ok(stored!.includes("````markdown\n```ts\n## literal code heading\n````"), "四反引号围栏与内层示例必须逐字保留");
  assert.ok(!stored!.includes("### literal"), "代码内 ## 不得被改写");
  // 围栏外 h1/h2 降级、h3 不动、无反斜杠
  assert.ok(stored!.includes("### actual heading"), "围栏外 h2 应降级为 h3");
  assert.ok(!stored!.includes("\n## actual heading"), "不得残留未降级的围栏外 ##");
  assert.ok(!stored!.includes("\\#"), "不得引入反斜杠转义");
  // 全文不截断：规范化结果与读回逐字一致
  assert.equal(extractGoalDescription(body), normalizeDescriptionHeadings(desc), "读回的目标描述应与规范化结果逐字一致（无截断）");
  assert.ok(stored!.includes("描述正文结尾——这段文字在修复前会被截断丢弃"), "尾部正文必须留在描述小节内");

  // 质量判据小节不受影响
  assert.ok(sectionText(body, "质量判据") !== null, "质量判据小节必须完好可见");
});

test("g-385: formatTargetContext（派发内联目标背景）不截断且判据完整", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "派发内联", version: "v-t", actor: "test" });
  const desc = [
    "````markdown",
    "```ts",
    "## literal code heading",
    "````",
    "## actual heading",
    "派发内联尾部正文",
  ].join("\n");
  setGoalDescription(root, goal, desc, "test");
  const body = loadGoal(findGoalFile(root, goal)).body;
  const context = formatTargetContext(body, { maxDescChars: 4000 });

  assert.ok(context.includes("## literal code heading"), "内联背景必须完整包含围栏内标题");
  assert.ok(context.includes("派发内联尾部正文"), "内联背景不得在围栏内的 ## 处截断");
  assert.ok(!context.includes("目标描述超出预算已截断"), "未超预算时不得触发截断提示");
  assert.ok(context.includes("## 质量判据"), "内联背景必须包含质量判据小节");
});

// ---- ③ 创建与编辑同口径 ----

test("g-385: createGoal 初始描述与 setGoalDescription 编辑走同一围栏识别口径", () => {
  const root = tmpRoot();
  const desc = [
    "````markdown",
    "```ts",
    "## literal code heading",
    "````",
    "## actual heading",
  ].join("\n");

  const created = createGoal(root, { title: "创建路径", version: "v-t", actor: "test", description: desc });
  const edited = createGoal(root, { title: "编辑路径", version: "v-t", actor: "test" });
  setGoalDescription(root, edited, desc, "test");

  const createdDesc = extractGoalDescription(loadGoal(findGoalFile(root, created)).body);
  const editedDesc = extractGoalDescription(loadGoal(findGoalFile(root, edited)).body);

  assert.equal(createdDesc, editedDesc, "创建与编辑必须产出同一规范化结果");
  assert.equal(createdDesc, normalizeDescriptionHeadings(desc), "两条路径均应是围栏感知规范化结果");
  assert.ok(!createdDesc.includes("\n## actual heading"), "创建路径的围栏外 ## 必须同样被降级");
  assert.ok(createdDesc.includes("## literal code heading"), "创建路径的围栏内代码必须逐字保留");

  // 创建路径前置于质量的判据小节必须存活（描述若含裸 ## 会把它截断）
  assert.ok(sectionText(loadGoal(findGoalFile(root, created)).body, "质量判据") !== null, "创建后质量判据小节必须存活");
});

test("g-385: normalizeAppend（amendGoal 追加）与 normalizeDescriptionHeadings 同口径", () => {
  const raw = ["正文", "", "````markdown", "```ts", "## literal code heading", "````", "", "## outer heading"].join("\n");
  const r = normalizeAppend(raw);
  assert.equal(r.normalized, true, "围栏外 h2 被降级应置 normalized=true");
  assert.ok(r.text.includes("````markdown\n```ts\n## literal code heading\n````"), "围栏内代码必须逐字保留");
  assert.ok(!r.text.includes("### literal"), "代码内 ## 不得被改写");
  assert.ok(r.text.includes("### outer heading"), "围栏外 h2 应降级为 h3");

  // 未闭合围栏（与归一化口径一致）
  const unclosed = normalizeAppend("```ts\n## 未闭合内的标题\nconst a = 1;");
  assert.ok(unclosed.text.includes("### 未闭合内的标题"), "未闭合围栏按普通文本降级（与读侧同口径）");

  // 端到端：amendGoal 追加后目标描述完整可读
  const root = tmpRoot();
  const goal = createGoal(root, { title: "追加口径", version: "v-t", actor: "test" });
  amendGoal(root, goal, { note: "追加", appendDescription: raw, actor: "test" });
  const body = loadGoal(findGoalFile(root, goal)).body;
  assert.ok(extractGoalDescription(body).includes("## literal code heading"), "追加后描述应完整可读");
  assert.ok(sectionText(body, "质量判据") !== null, "追加后质量判据小节必须存活");
});

// ---- ④ 客户端读侧同口径（goal-modal 小节切分） ----

const clientRoot = join(import.meta.dirname, "../../dsh-graph-host");
const markdownSource = readFileSync(join(clientRoot, "lib/client/markdown.js"), "utf8");
const goalModalSource = readFileSync(join(clientRoot, "lib/client/goal-modal.js"), "utf8");

test("g-385: 客户端 computeClosedFenceMask 与 core 同口径（四反引号/短闭合/未闭合）", () => {
  const mask: (lines: string[]) => boolean[] = new Function(
    `${extractFunction(markdownSource, "computeClosedFenceMask")}\nreturn computeClosedFenceMask;`,
  )();

  const c4 = ["````markdown", "```ts", "## literal code heading", "````", "## actual heading"];
  assert.deepEqual(mask(c4), [true, true, true, true, false], "四反引号围栏内三反引号示例整体在围栏内");

  const shortClose = ["````markdown", "```ts", "## in", "```", "## still in", "````", "## out"];
  assert.deepEqual(mask(shortClose), [true, true, true, true, true, true, false], "闭合长度 < 开启长度不算闭合");

  const unclosed = ["```ts", "## in", "text"];
  assert.deepEqual(mask(unclosed), [false, false, false], "未闭合围栏退化为普通文本行");

  const indented = ["   ```ts", "   ## in", "   ```", "## out"];
  assert.deepEqual(mask(indented), [true, true, true, false], "缩进围栏同样识别");
});

test("g-385: goal-modal 小节切分复用共享围栏识别，不再朴素 toggle", () => {
  assert.ok(goalModalSource.includes("computeClosedFenceMask(lines)"), "goal-modal 必须复用共享围栏识别");
  assert.ok(!goalModalSource.includes("inFence = !inFence"), "不得残留朴素 toggle 实现");
  assert.ok(goalModalSource.includes("!fenceMask[i] && lines[i].trim() === head"), "小节起点判定必须跳过围栏内行");
  assert.ok(goalModalSource.includes('!fenceMask[i] && lines[i].startsWith("## ")'), "小节终点判定必须跳过围栏内行");
});

test("g-385: goal-modal 真实 section() 在四反引号围栏文档上完整取回描述与质量判据", () => {
  // 直接求值 goal-modal.js 里的真实 section 实现（配合 markdown.js 的真实共享围栏识别），
  // 不复制逻辑：修复前该实现会让 `## 质量判据` 被误判为仍在围栏内，整节返回 null。
  const sectionFn: any = new Function(
    `${extractFunction(markdownSource, "computeClosedFenceMask")}\n` +
    `${extractBalanced(goalModalSource, "const section = (body, name) =>")}\n` +
    `return section;`,
  )();

  const body = [
    "## 目标描述",
    "",
    "````markdown",
    "```ts",
    "## literal code heading",
    "````",
    "### actual heading",
    "",
    "## 质量判据",
    "",
    "1. 判据一",
    "",
  ].join("\n");

  const desc = sectionFn(body, "目标描述");
  assert.ok(desc.includes("````markdown\n```ts\n## literal code heading\n````"), "客户端必须逐字取回围栏内的代码示例");
  assert.ok(desc.includes("### actual heading"), "客户端必须取回围栏外的正文标题");
  assert.equal(sectionFn(body, "质量判据")?.trim(), "1. 判据一", "质量判据小节不得因围栏识别错位而失踪");
});
