/** g-561：生产运行时输出里的**静态目标编号**扫描器（AST，不靠正则抠源码文本）。
 *
 * 为什么用 AST：项目历史极多 `g-NNN` 出现在**源码注释**里（允许保留，绝不进运行时输出）；
 * 只有字符串/模板字面量会被打进产物、被用户看到。注释在 AST 里根本不是节点 ⇒ 天然排除。
 *
 * 判据口径：
 *   · 命中 = 字符串/模板字面量的**静态正文**含 `g-<数字>`（模板插值 `${…}` 不算静态正文）；
 *   · 动态真实目标 ID（`"g-" + seq`、`` `g-${seq}` ``、`${goal.id}`）**不会**命中 ⇒ 不误拦业务 ID；
 *   · 正则字面量（`/^g-\d+$/`）不是字符串 ⇒ 不命中；
 *   · 该扫描器只回答「这个字面量长什么样」，是否允许由调用方按**显式白名单 + 输出面判定**决定。
 *
 * 本模块**不是产品代码**（文件名以下划线开头、不匹配 `core/tests/*.test.ts`），只供测试使用。
 */
import ts from "typescript";
import { readFileSync } from "node:fs";

/** 静态目标编号：g- 后跟至少一位数字（大小写不敏感；`g-` 后必须有数字）。 */
export const STATIC_GOAL_ID_RE = /\bg-\d+\b/i;

export interface GoalIdLiteralHit {
  /** 传给扫描器的展示路径。 */
  file: string;
  /** 1-based 行号。 */
  line: number;
  /** 最近的调用/属性/变量上下文（便于人工判断这是日志、Error 还是 UI 文案）。 */
  sink: string;
  /** 字面量原文（保留空白；展示时自行压缩）。 */
  text: string;
}

/** 判断某个 sink 是否属于「用户可见运行时输出」面（日志 / 控制台 / Error / HTTP JSON）。 */
export const OUTPUT_SINK_RE = /^(call:(process\.(stderr|stdout)\.write|console\.\w+|json)|new:(Error|GraphError|TypeError))/;

function scriptKindOf(file: string): ts.ScriptKind {
  if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `\${...}${span.literal.text}`).join("");
  }
  return null;
}

function sinkOf(node: ts.Node, parents: ts.Node[], sf: ts.SourceFile): string {
  // 先找**调用/构造**（日志、Error、HTTP JSON 等真正的输出面）；分行拼接时字面量的最近祖先
  // 是 BinaryExpression，不能让它遮住外层 `process.stderr.write(...)`。
  for (let i = parents.length - 1; i >= 0; i--) {
    const parent = parents[i];
    if (ts.isCallExpression(parent)) {
      return `call:${parent.expression.getText(sf).replace(/\s+/g, " ").slice(0, 80)}`;
    }
    if (ts.isNewExpression(parent)) return `new:${parent.expression.getText(sf).slice(0, 60)}`;
  }
  for (let i = parents.length - 1; i >= 0; i--) {
    const parent = parents[i];
    if (ts.isPropertyAssignment(parent)) return `prop:${parent.name.getText(sf).slice(0, 60)}`;
    if (ts.isVariableDeclaration(parent)) return `var:${parent.name.getText(sf).slice(0, 40)}`;
  }
  for (let i = parents.length - 1; i >= 0; i--) {
    const parent = parents[i];
    if (ts.isThrowStatement(parent)) return "throw";
    if (ts.isReturnStatement(parent)) return "return";
    if (ts.isBinaryExpression(parent)) return "binary";
  }
  return "";
}

/**
 * 扫描单个文件里的静态目标编号字面量。
 * @param filePath 磁盘路径
 * @param displayPath 报告里显示的路径（默认同 filePath）
 */
export function scanGoalIdLiterals(filePath: string, displayPath: string = filePath): GoalIdLiteralHit[] {
  const text = readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindOf(filePath));
  const hits: GoalIdLiteralHit[] = [];

  const walk = (node: ts.Node, parents: ts.Node[]): void => {
    const value = literalText(node);
    if (value !== null && STATIC_GOAL_ID_RE.test(value)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push({ file: displayPath, line: line + 1, sink: sinkOf(node, parents, sf), text: value });
    }
    parents.push(node);
    ts.forEachChild(node, (child) => walk(child, parents));
    parents.pop();
  };

  walk(sf, []);
  return hits;
}

/** 白名单：**非运行时输出**的注释型字面量（必须逐条给出理由，且不得落在输出面）。 */
export interface AllowedGoalIdLiteral {
  /** 字面量正文必须包含的片段（精确到足以唯一识别）。 */
  textIncludes: string;
  /** 允许出现的文件（子串匹配；字符串或列表；省略 = 任意文件，不推荐）。 */
  fileIncludes?: string | string[];
  reason: string;
}

export function allowedFileMatches(rule: AllowedGoalIdLiteral, file: string): boolean {
  if (rule.fileIncludes === undefined) return true;
  const patterns = Array.isArray(rule.fileIncludes) ? rule.fileIncludes : [rule.fileIncludes];
  return patterns.some((pattern) => file.includes(pattern));
}

/** 按 `fileIncludes` + `textIncludes` 把命中拆成「已登记的非输出字面量」与「未登记的回归嫌疑」。 */
export function partitionGoalIdHits(hits: GoalIdLiteralHit[], allowlist: AllowedGoalIdLiteral[]) {
  const allowed: Array<{ hit: GoalIdLiteralHit; rule: AllowedGoalIdLiteral }> = [];
  const unexpected: GoalIdLiteralHit[] = [];
  for (const hit of hits) {
    const rule = allowlist.find(
      (entry) => hit.text.includes(entry.textIncludes) && allowedFileMatches(entry, hit.file),
    );
    if (rule) allowed.push({ hit, rule });
    else unexpected.push(hit);
  }
  return { allowed, unexpected };
}

/** 便于失败信息：把命中压成一行（文件:行 + sink + 前 120 字符）。 */
export function formatGoalIdHit(hit: GoalIdLiteralHit): string {
  return `${hit.file}:${hit.line} [${hit.sink}] ${hit.text.replace(/\s+/g, " ").slice(0, 120)}`;
}
