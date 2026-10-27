/** g-561：生产运行时输出里的**静态目标编号**扫描器（AST，不靠正则抠源码文本）。
 *
 * 为什么用 AST：项目历史极多 `g-NNN` 出现在**源码注释**里（允许保留，绝不进运行时输出）；
 * 只有字符串/模板字面量会被打进产物、被用户看到。注释在 AST 里根本不是节点 ⇒ 天然排除。
 *
 * 判据口径：
 *   · 命中 = 静态字符串正文含 `g-<数字>`；模板插值 `${…}` 内的动态值不参与；
 *   · **静态可求值拼接**（`"g-" + "507"`、`` `g-${"507"}` ``）会按常量折叠后的完整值命中；
 *     含动态操作数（`"g-" + seq`、`` `g-${seq}` ``）不折叠 ⇒ 不误拦动态真实目标 ID；
 *   · 正则字面量（`/^g-\d+$/`）不是字符串 ⇒ 不命中；
 *   · 命中附带**确定结构**（文件、完整字面值哈希、sink、变量声明名/kind/作用域、最近函数作用域与深度），
 *     白名单必须逐字段精确匹配，**不接受文本子串 + 文件子串**（g-561 复审 P1：子串白名单可被
 *     「同名/同前缀的新界面提示」冒充）。
 *
 * 边界（不做完整 JS 常量传播）：只折叠同一表达式内的字符串字面量/静态模板；不解析变量、常量、
 * 函数返回值或跨语句赋值。该取舍足以覆盖静态硬编码编号，又不会把动态真实 ID 误判为静态。
 *
 * 本模块**不是产品代码**（文件名以下划线开头、不匹配 `core/tests/*.test.ts`），只供测试使用。
 */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { posix } from "node:path";

/** 静态目标编号：g- 后跟至少一位数字（大小写不敏感；`g-` 后必须有数字）。 */
export const STATIC_GOAL_ID_RE = /\bg-\d+\b/i;

/**
 * **唯一路径规范化边界**：把「仓库根 + 任意文件路径」归一为仓库相对 POSIX 逻辑路径
 * （白名单规则统一用 `/`）。跨平台确定性来源：
 *   · 系统分隔符（`path.sep`，Windows 为 `\`）与历史上手工传入的 win32 反斜杠统一换成 `/`；
 *   · `path.win32.relative('C:\\repo','C:\\repo\\core\\ops.ts')` 得到 `core\ops.ts` ⇒ 本函数得
 *     `core/ops.ts`，于是 Win32 原生与 Linux 上命中同一套精确规则；
 *   · 不同盘符 / 跨根（`..`）/ 仓库根本身 / 绝对结果一律返回 null（**绝不**靠子串或 basename 归属）；
 *   · 规则匹配仍是 `files.includes(命中路径)` 全等，不做前缀/子串/大小写模糊。
 * 说明：这是**路径 API 模拟**的确定性，不等于原生 Windows 全栈验证；除盘符大小写外按逻辑路径逐字比较。
 *
 * @param root 仓库根（绝对路径，POSIX 或 win32 形态均可）
 * @param file 目标文件（绝对路径，POSIX 或 win32 形态均可）
 * @returns 仓库相对 POSIX 路径；无法证明在仓库内时返回 null
 */
export function toRepoRelativePosix(root: string, file: string): string | null {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const rootNorm = normalize(root);
  const fileNorm = normalize(file);
  if (!rootNorm || !fileNorm) return null;

  const driveOf = (value: string): string | null => {
    const match = /^([A-Za-z]):\//.exec(value);
    return match ? match[1].toLowerCase() : null;
  };
  const rootDrive = driveOf(rootNorm);
  const fileDrive = driveOf(fileNorm);
  if (rootDrive !== null || fileDrive !== null) {
    // 任一侧带盘符时必须两侧同盘（不同盘绝不归属同一仓库）。
    if (rootDrive === null || fileDrive === null || rootDrive !== fileDrive) return null;
  }
  const isAbsolute = (value: string) => value.startsWith("/") || /^[A-Za-z]:\//.test(value);
  if (isAbsolute(rootNorm) !== isAbsolute(fileNorm)) return null;

  const rel = posix.relative(rootNorm, fileNorm);
  if (!rel || rel === ".") return null;
  if (isAbsolute(rel) || /^[A-Za-z]:\//.test(rel)) return null;
  if (rel.split("/").some((segment) => segment === "..")) return null;
  return rel.startsWith("./") ? rel.slice(2) : rel;
}

/** 变量声明作用域：源文件顶层 / 客户端 bundle 的外层 factory 直接函数体 / 其它函数体。 */
export type DeclarationScope = "top-level" | "factory-body" | "function-body";

export interface GoalIdDeclaration {
  name: string;
  kind: "const" | "let" | "var";
  scope: DeclarationScope;
}

export interface GoalIdLiteralHit {
  /** 传给扫描器的展示路径。 */
  file: string;
  /** 1-based 行号。 */
  line: number;
  /** 最近的调用/属性/变量上下文（便于人工判断这是日志、Error 还是 UI 文案）。 */
  sink: string;
  /** 字面量原文（保留空白；展示时自行压缩）。静态拼接时为折叠后的完整值。 */
  text: string;
  /** 若字面量是变量声明的直接初始化器，记录声明结构；否则 null。 */
  declaration: GoalIdDeclaration | null;
  /** 最近的函数作用域名（源文件顶层为 null）。 */
  functionScope: string | null;
  /** 函数嵌套深度（顶层 0；factory 直接体 1）。 */
  functionDepth: number;
}

/** 精确字面值身份：白名单只认完整值的 sha256，不做子串匹配。 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 判断某个 sink 是否属于「用户可见运行时输出」面（日志 / 控制台 / Error / HTTP JSON）。 */
export const OUTPUT_SINK_RE = /^(call:(process\.(stderr|stdout)\.write|console\.\w+|json)|new:(Error|GraphError|TypeError))/;

function scriptKindOf(file: string): ts.ScriptKind {
  if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

function directFunctionName(node: ts.Node): string {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return node.name ? node.name.getText() : "(anonymous)";
  }
  if (ts.isFunctionExpression(node) && node.name) return node.name.text;
  return "(anonymous)";
}

function functionNameOf(node: ts.Node, parents: ts.Node[]): string {
  const direct = directFunctionName(node);
  if (direct !== "(anonymous)") return direct;
  const parent = parents[parents.length - 1];
  if (parent) {
    if (ts.isVariableDeclaration(parent) && parent.initializer === node) return parent.name.getText();
    if (ts.isPropertyAssignment(parent) && parent.initializer === node) return parent.name.getText();
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node) {
      return parent.left.getText();
    }
  }
  return "(anonymous)";
}

function declarationOf(node: ts.Node, parents: ts.Node[], fnStack: ts.Node[]): GoalIdDeclaration | null {
  const parent = parents[parents.length - 1];
  if (!parent || !ts.isVariableDeclaration(parent) || parent.initializer !== node) return null;
  const list = parent.parent;
  if (!list || !ts.isVariableDeclarationList(list)) return null;
  const kind: GoalIdDeclaration["kind"] = (list.flags & ts.NodeFlags.Const) !== 0
    ? "const"
    : (list.flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";
  const statement = list.parent;
  let scope: DeclarationScope = "function-body";
  if (statement && ts.isSourceFile(statement.parent)) {
    scope = "top-level";
  } else if (statement && ts.isBlock(statement.parent)) {
    const owner = statement.parent.parent;
    // 客户端 bundle：所有模块拼接在 `factory(require) { … }` 的直接函数体内。
    if (owner && isFunctionLike(owner) && directFunctionName(owner) === "factory" && fnStack.length === 1) {
      scope = "factory-body";
    }
  }
  return { name: parent.name.getText(), kind, scope };
}

function sinkOf(node: ts.Node, parents: ts.Node[], sf: ts.SourceFile): string {
  // ① 变量声明的**直接初始化器**优先记为 `var:<name>`：声明结构比外层调用（如客户端 bundle 的
  //    `window.__ModuleLoader__.load({ factory(){…} })`）更能唯一确定字面量身份。
  const immediate = parents[parents.length - 1];
  if (immediate && ts.isVariableDeclaration(immediate) && immediate.initializer === node) {
    return `var:${immediate.name.getText(sf).slice(0, 40)}`;
  }
  // ② 其次找**调用/构造**（日志、Error、HTTP JSON 等真正的输出面）；分行拼接时字面量的最近祖先
  //    是 BinaryExpression，不能让它遮住外层 `process.stderr.write(...)`。
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
 * 静态可求值的字符串表达式（仅同一表达式内的字面量/静态模板 + `+`）。
 * 含任何动态操作数（标识符、调用、`${expr}`）即返回 null —— 动态真实目标 ID 不参与判定。
 */
export function staticStringValue(node: ts.Node): string | null {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const value = staticStringValue(span.expression);
      if (value === null) return null;
      out += value + span.literal.text;
    }
    return out;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(node.left);
    if (left === null) return null;
    const right = staticStringValue(node.right);
    if (right === null) return null;
    return left + right;
  }
  return null;
}

function pushHit(
  hits: GoalIdLiteralHit[],
  node: ts.Node,
  text: string,
  parents: ts.Node[],
  fnStack: ts.Node[],
  sf: ts.SourceFile,
  displayPath: string,
): void {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  hits.push({
    file: displayPath,
    line: line + 1,
    sink: sinkOf(node, parents, sf),
    text,
    declaration: declarationOf(node, parents, fnStack),
    functionScope: fnStack.length ? functionNameOf(fnStack[fnStack.length - 1], parents) : null,
    functionDepth: fnStack.length,
  });
}

/**
 * 扫描单个文件里的静态目标编号。
 * @param filePath 磁盘路径
 * @param displayPath 报告里显示的路径（默认同 filePath）
 */
export function scanGoalIdLiterals(filePath: string, displayPath: string = filePath): GoalIdLiteralHit[] {
  const text = readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindOf(filePath));
  const hits: GoalIdLiteralHit[] = [];
  const seen = new Set<string>();

  const walk = (node: ts.Node, parents: ts.Node[], fnStack: ts.Node[]): void => {
    const add = (target: ts.Node, value: string) => {
      const key = `${target.getStart(sf)}|${value}`;
      if (seen.has(key)) return;
      seen.add(key);
      pushHit(hits, target, value, parents, fnStack, sf, displayPath);
    };

    // ① 普通字符串 / 无插值模板：整个字面量就是静态值。
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (STATIC_GOAL_ID_RE.test(node.text)) add(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      // ② 模板：逐段检查静态正文（动态插值不参与）；整段静态时按折叠值判定。
      const folded = staticStringValue(node);
      if (folded !== null) {
        if (STATIC_GOAL_ID_RE.test(folded)) add(node, folded);
      } else {
        if (STATIC_GOAL_ID_RE.test(node.head.text)) add(node, node.head.text);
        for (const span of node.templateSpans) {
          if (STATIC_GOAL_ID_RE.test(span.literal.text)) add(node, span.literal.text);
        }
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      // ③ 仅 `+` 拼接：常量折叠后判定（"g-" + "507" 命中；"g-" + seq 不命中）。
      //    只报**最外层**静态拼接，避免 `"g-" + "5" + "07"` 额外产出一个半截 `g-5` 命中。
      const parent = parents[parents.length - 1];
      const parentIsStaticConcat = parent
        && ts.isBinaryExpression(parent)
        && parent.operatorToken.kind === ts.SyntaxKind.PlusToken
        && staticStringValue(parent) !== null;
      const folded = staticStringValue(node);
      if (!parentIsStaticConcat && folded !== null && STATIC_GOAL_ID_RE.test(folded)) add(node, folded);
    }

    const isFn = isFunctionLike(node);
    if (isFn) fnStack.push(node);
    ts.forEachChild(node, (child) => walk(child, [...parents, node], fnStack));
    if (isFn) fnStack.pop();
  };

  walk(sf, [], []);
  return hits;
}

/** 白名单：**非运行时输出**的注释型字面量（逐字段精确匹配，不接受子串）。 */
export interface AllowedGoalIdLiteral {
  /** 精确文件（展示路径全等；源与产物各自登记）。 */
  files: string[];
  /** 完整字面值的 sha256（精确身份，杜绝“同前缀的新文案”冒充）。 */
  literalSha256: string;
  /** 精确 sink（如 `var:HOVER_CSS` / `call:lines.push`）。 */
  sink: string;
  /** 变量声明结构（只允许指定名字/kind/作用域）。 */
  declaration?: GoalIdDeclaration;
  /** 要求的最近函数作用域（用于注入点绑定）。 */
  functionScope?: string;
  reason: string;
}

/** 命中是否与白名单条目**逐字段**一致。 */
export function matchesAllowed(hit: GoalIdLiteralHit, rule: AllowedGoalIdLiteral): boolean {
  if (!rule.files.includes(hit.file)) return false;
  if (sha256Hex(hit.text) !== rule.literalSha256) return false;
  if (hit.sink !== rule.sink) return false;
  if (rule.declaration) {
    if (!hit.declaration) return false;
    if (hit.declaration.name !== rule.declaration.name) return false;
    if (hit.declaration.kind !== rule.declaration.kind) return false;
    if (hit.declaration.scope !== rule.declaration.scope) return false;
  } else if (hit.declaration) {
    return false;
  }
  if (rule.functionScope !== undefined && hit.functionScope !== rule.functionScope) return false;
  return true;
}

/** 按精确白名单把命中拆成「已登记的非输出字面量」与「未登记的回归嫌疑」。 */
export function partitionGoalIdHits(hits: GoalIdLiteralHit[], allowlist: AllowedGoalIdLiteral[]) {
  const allowed: Array<{ hit: GoalIdLiteralHit; rule: AllowedGoalIdLiteral }> = [];
  const unexpected: GoalIdLiteralHit[] = [];
  for (const hit of hits) {
    const rule = allowlist.find((entry) => matchesAllowed(hit, entry));
    if (rule) allowed.push({ hit, rule });
    else unexpected.push(hit);
  }
  return { allowed, unexpected };
}

/** 便于失败信息：把命中压成一行（文件:行 + sink + 结构 + 前 120 字符）。 */
export function formatGoalIdHit(hit: GoalIdLiteralHit): string {
  const decl = hit.declaration
    ? `${hit.declaration.kind} ${hit.declaration.name}@${hit.declaration.scope}`
    : `no-decl fn=${hit.functionScope ?? "-"}#${hit.functionDepth}`;
  return `${hit.file}:${hit.line} [${hit.sink}] {${decl}} ${hit.text.replace(/\s+/g, " ").slice(0, 120)}`;
}
