/** g-561：**用户可见运行时输出零静态目标编号**的通用结构守卫 + 负向对照。
 *
 * 负责人裁定（2026-10-28 扩大范围）：最终产物里所有**运行时日志 / 错误 / 界面文案**中的硬编码
 * 历史目标编号（`g-NNN`）都必须换成准确的中性功能描述；**源码注释与文档保留**；**业务动态目标 ID
 * 必须保留**。故本守卫不是「全仓替换 g-」的文本 grep，而是：
 *   1. 用 AST 只取字符串/模板字面量（注释天然排除）⇒ 注释里的历史编号不会误伤；
 *   2. 只拦**静态正文**里的 `g-<数字>`；动态真实 ID（`"g-" + seq`、`` `g-${seq}` ``）不命中；
 *      静态可求值拼接（`"g-" + "507"`）按折叠值命中；
 *   3. 对生产源码与**真实构建的 dist 运行时产物**（host index / 编译 core / 客户端 bundle）双向扫描；
 *   4. 非输出的注释型字面量必须登记白名单，且白名单绑**精确文件 + 完整字面值 sha256 + 精确 sink +
 *      变量声明名/kind/作用域或函数作用域**——不接受子串匹配（复审 P1：子串白名单可被同前缀新文案冒充）；
 *   5. 负向对照证明：新 UI 提示 / 改名冒充 / 同名异作用域 / 换文件 / 换函数注入 / 静态拼接 都会判红，
 *      而动态真实目标 ID 不会被误拦。
 *
 * 诚实边界：本守卫只覆盖**运行时代码的字符串字面量**（含同一表达式内的静态 `+`/模板折叠）；
 * 不解析变量、常量、函数返回值或跨语句赋值（不做完整 JS 常量传播）。dist 内文档类资产
 * （prompts/*.md、README、schema、diagrams）与源码/测试注释按裁定保留历史编号，不在此断言范围。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import {
  STATIC_GOAL_ID_RE,
  OUTPUT_SINK_RE,
  sha256Hex,
  scanGoalIdLiterals,
  matchesAllowed,
  partitionGoalIdHits,
  formatGoalIdHit,
  toRepoRelativePosix,
  type AllowedGoalIdLiteral,
  type GoalIdLiteralHit,
} from "./_runtime-goal-id-scan.ts";

const ROOT = process.cwd();

/**
 * 白名单：只允许「非运行时输出」的注释型字面量（历史编号保留，不渲染、不写日志）。
 * 每条绑死：精确文件 / 完整字面值 sha256 / 精确 sink / 声明结构或函数作用域。
 * 源文件与 dist 产物分别登记（bundle 的 HOVER_CSS 在 factory 直接体内，源文件在顶层）。
 */
const ALLOWED: AllowedGoalIdLiteral[] = [
  {
    files: ["core/ops.ts", "dist/core/ops.js"],
    literalSha256: "9c12b60ee5f6e595ac6c6bf19db447b5f4273395926b11d74d2dde38fcef9287",
    sink: "call:lines.push",
    functionScope: "renderRelationSection",
    reason: "写入 goal.md 的 HTML 注释标记（文档注释，不渲染、不是运行时日志）",
  },
  {
    files: ["core/ops.ts", "dist/core/ops.js"],
    literalSha256: "3d44c9279c4b488887834bb7448c4f541b6909cdcc8ba6d789458f24745e1f31",
    sink: "var:FANOUT_GUARD_BLOCK_BEGIN",
    declaration: { name: "FANOUT_GUARD_BLOCK_BEGIN", kind: "const", scope: "top-level" },
    reason: "源码块定界标记常量 begin（供测试抽取，不面向用户、不写日志）",
  },
  {
    files: ["core/ops.ts", "dist/core/ops.js"],
    literalSha256: "f25ef3f309d4a2334ba12fb45c1734880974932327fa5a9131caf9d86ce9ed67",
    sink: "var:FANOUT_GUARD_BLOCK_END",
    declaration: { name: "FANOUT_GUARD_BLOCK_END", kind: "const", scope: "top-level" },
    reason: "源码块定界标记常量 end（供测试抽取，不面向用户、不写日志）",
  },
  {
    files: ["dsh-graph-host/lib/client/constants.js"],
    literalSha256: "7ec455d3cc825b9a775c9d09822ed7d70889a877d7e9bb42863b11a93239456c",
    sink: "var:HOVER_CSS",
    declaration: { name: "HOVER_CSS", kind: "const", scope: "top-level" },
    reason: "HOVER_CSS 字符串内嵌的 CSS 注释（源文件顶层唯一声明，浏览器不渲染）",
  },
  {
    files: ["dist/lib/client.js"],
    literalSha256: "7ec455d3cc825b9a775c9d09822ed7d70889a877d7e9bb42863b11a93239456c",
    sink: "var:HOVER_CSS",
    declaration: { name: "HOVER_CSS", kind: "const", scope: "factory-body" },
    reason: "HOVER_CSS 字符串内嵌的 CSS 注释（bundle 中为 factory 直接体内唯一声明，不渲染）",
  },
];

function filesIn(relDir: string, suffix: string): string[] {
  const dir = join(ROOT, relDir);
  return readdirSync(dir).filter((name) => name.endsWith(suffix)).sort().map((name) => join(dir, name));
}

function displayPath(file: string): string {
  // 唯一规范化边界：所有扫描命中都用「仓库相对 POSIX 逻辑路径」，与白名单的 `/` 规则同口径。
  // 绝不在规则侧做反斜杠/子串兜底 —— 无法证明在仓库内（跨盘/跨根/..）时直接拒绝归属。
  const normalized = toRepoRelativePosix(ROOT, file);
  assert.ok(normalized, `无法把 ${file} 归一到仓库相对 POSIX 路径（拒绝模糊归属）`);
  return normalized;
}

function scanAll(files: string[]): GoalIdLiteralHit[] {
  return files.flatMap((file) => scanGoalIdLiterals(file, displayPath(file)));
}

/** 生产源码（进入构建的运行时字符串的唯一来源）。 */
function productionSourceFiles(): string[] {
  return [
    join(ROOT, "dsh-graph-host", "index.js"),
    join(ROOT, "dsh-graph-host", "lib", "server-i18n.js"),
    ...filesIn(join("dsh-graph-host", "lib", "client"), ".js"),
    ...filesIn("core", ".ts"),
  ];
}

/** 隔离构建后的最终 dist 运行时代码（含从源码模块拼成的客户端 bundle）。 */
function distRuntimeFiles(): string[] {
  const fixed = [
    join(ROOT, "dist", "index.js"),
    join(ROOT, "dist", "lib", "client.js"),
    join(ROOT, "dist", "lib", "server-i18n.js"),
  ];
  for (const file of fixed) {
    assert.ok(
      existsSync(file),
      `缺少构建产物 ${displayPath(file)}：本守卫必须在隔离构建后运行（bash scripts/build.sh）`,
    );
  }
  const core = filesIn(join("dist", "core"), ".js");
  assert.ok(core.length > 0, "dist/core/*.js 为空：构建产物不完整");
  return [...fixed, ...core];
}

function unexpectedLines(hits: GoalIdLiteralHit[]): string[] {
  return hits.map(formatGoalIdHit);
}

test("g-561 S1：生产源码的静态字符串不含未登记目标编号（注释天然排除）", () => {
  const hits = scanAll(productionSourceFiles());
  const { allowed, unexpected } = partitionGoalIdHits(hits, ALLOWED);
  assert.deepEqual(unexpectedLines(unexpected), [], "生产源码出现未登记的静态目标编号（请改成中性功能描述或登记精确白名单）");
  assert.equal(allowed.length, 4, `源码仅允许 4 条非输出注释型字面量（实得 ${allowed.length}）`);
});

test("g-561 S2：隔离构建的最终 dist 运行时产物零未登记目标编号（含客户端 bundle）", () => {
  const hits = scanAll(distRuntimeFiles());
  const { allowed, unexpected } = partitionGoalIdHits(hits, ALLOWED);
  assert.deepEqual(unexpectedLines(unexpected), [], "dist 运行时代码出现未登记的静态目标编号（源码修了但产物没构建对齐？）");
  assert.equal(allowed.length, 4, `dist 仅允许 4 条非输出注释型字面量（实得 ${allowed.length}）`);
});

test("g-561 S3：白名单逐条可追溯 —— 精确文件/值/sink/结构，且仅覆盖非输出注释型字面量", () => {
  const sourceHits = scanAll(productionSourceFiles());
  const distHits = scanAll(distRuntimeFiles());
  const all = [...sourceHits, ...distHits];
  for (const rule of ALLOWED) {
    for (const file of rule.files) {
      const hit = all.find((candidate) => candidate.file === file && matchesAllowed(candidate, rule));
      assert.ok(hit, `白名单条目在 ${file} 未精确命中（条目过期、构建未对齐或结构不符）：${rule.reason}`);
      assert.doesNotMatch(hit!.sink, OUTPUT_SINK_RE, `白名单不得落在日志/Error 输出面：${formatGoalIdHit(hit!)}`);
    }
  }
  // HOVER_CSS 必须确为**注入 style 的样式表**（而不是同名变量承载的新界面提示）：
  // 源文件顶层唯一声明 + kanban 的 `h("style", null, HOVER_CSS)` 注入点，bundle 内同样成立。
  const constantsSrc = readFileSync(join(ROOT, "dsh-graph-host", "lib", "client", "constants.js"), "utf8");
  const kanbanSrc = readFileSync(join(ROOT, "dsh-graph-host", "lib", "client", "kanban.js"), "utf8");
  assert.equal(sourceHits.filter((hit) => hit.declaration?.name === "HOVER_CSS").length, 1, "源码 HOVER_CSS 必须恰好唯一声明");
  assert.match(constantsSrc, /const HOVER_CSS = `/, "HOVER_CSS 必须仍是模板字面量样式表");
  assert.ok(kanbanSrc.includes('h("style", null, HOVER_CSS)'), "HOVER_CSS 必须仍由 h(\"style\", …) 注入");
  const bundle = readFileSync(join(ROOT, "dist", "lib", "client.js"), "utf8");
  assert.ok(bundle.includes('h("style", null, HOVER_CSS)'), "dist bundle 必须仍包含 HOVER_CSS 的 style 注入点");
  assert.equal(distHits.filter((hit) => hit.declaration?.name === "HOVER_CSS").length, 1, "dist HOVER_CSS 必须恰好唯一声明");
});

test("g-561 S4：负向对照 —— 日志 / 路由 Error / UI 文案 / 分行拼接中的静态目标编号必被扫描判红", () => {
  const dir = mkdtempSync(join(tmpdir(), "g561-scan-negative-"));
  try {
    const cases = [
      {
        file: "log.ts",
        source: 'export const reject = (req: any) => {\n  process.stderr.write("[dsh-graph-host] g-507 拒绝 401 unauthenticated\\n");\n};\n',
        sink: /^call:process\.stderr\.write$/,
      },
      {
        file: "route.ts",
        source: "export const build = (defs: any) => {\n  throw new Error(`g-507: 非法路由定义 ${defs}`);\n};\n",
        sink: /^new:Error$/,
      },
      {
        file: "ui.ts",
        source: 'export const HINTS = { hint: "输入编号（如 g-380，大小写不限）" };\n',
        sink: /^prop:hint$/,
      },
      {
        file: "concat.ts",
        source: 'export const f = (msg: string) => {\n  process.stderr.write(\n    "[dsh-graph] g-436 评审结算失败: " +\n    msg,\n  );\n};\n',
        sink: /^call:process\.stderr\.write$/,
      },
    ];
    for (const item of cases) {
      const file = join(dir, item.file);
      writeFileSync(file, item.source, "utf8");
      const hits = scanGoalIdLiterals(file, item.file);
      assert.equal(hits.length, 1, `${item.file} 必须恰好命中 1 条静态目标编号（实得 ${hits.length}）`);
      assert.match(hits[0].sink, item.sink, `${item.file} 的 sink 判定必须落在用户可见输出面`);
      assert.match(hits[0].text, STATIC_GOAL_ID_RE);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-561 S5：动态真实目标 ID（模板插值 / 字符串拼接 / 正则 / 路由文本）不被误拦", () => {
  const dir = mkdtempSync(join(tmpdir(), "g561-scan-dynamic-"));
  try {
    const file = join(dir, "dynamic.ts");
    writeFileSync(file, [
      "export const report = (goalId: string, seq: number) => {",
      "  process.stderr.write(`[dsh-graph] 拒绝 ${goalId}（seq=${seq}）\\n`);",
      '  console.warn("标记旧 attempt " + goalId + " 失败");',
      '  const generated = "g-" + String(seq).padStart(3, "0");',
      "  const re = /^g-\\d+$/;",
      '  const routes = [{ path: "/api/dsh-graph", handler: () => {} }];',
      '  const hint = `目标 ${goalId} 的关系`;',
      "  return { generated, ok: re.test(generated), routes, hint };",
      "};",
      "",
    ].join("\n"), "utf8");
    assert.deepEqual(
      scanGoalIdLiterals(file, "dynamic.ts").map(formatGoalIdHit),
      [],
      "动态真实 goal ID / 正则 / 路由文本不得被误判为静态历史编号",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-561 S6：结构冒充负向对照 —— 新界面提示 / 改名 / 同名异作用域 / 换文件 / 换函数注入 必判红", () => {
  const realSourceHits = scanAll(productionSourceFiles());
  const hover = realSourceHits.find((hit) => hit.declaration?.name === "HOVER_CSS");
  const goalComment = realSourceHits.find((hit) => hit.functionScope === "renderRelationSection");
  const fanoutBegin = realSourceHits.find((hit) => hit.declaration?.name === "FANOUT_GUARD_BLOCK_BEGIN");
  assert.ok(hover && goalComment && fanoutBegin, "真实字面量必须存在（白名单前提）");

  const dir = mkdtempSync(join(tmpdir(), "g561-scan-spoof-"));
  try {
    const spoofs: Array<{ name: string; display: string; source: string }> = [
      {
        name: "新增同前缀界面提示（reviewer P1 最小变异）",
        display: "dsh-graph-host/lib/client/constants.js",
        source: 'export const __g561_tip = "g-352：这是界面提示文案";\n',
      },
      {
        name: "同一 HOVER_CSS 字面值改名冒充",
        display: "dsh-graph-host/lib/client/constants.js",
        source: `const __spoof = ${JSON.stringify(hover!.text)};\n`,
      },
      {
        name: "同名 HOVER_CSS 但出现在函数作用域",
        display: "dsh-graph-host/lib/client/constants.js",
        source: `function sneaky() {\n  const HOVER_CSS = ${JSON.stringify(hover!.text)};\n  return HOVER_CSS;\n}\n`,
      },
      {
        name: "同一 HOVER_CSS 字面值换到别的文件",
        display: "dsh-graph-host/lib/client/i18n.js",
        source: `const HOVER_CSS = ${JSON.stringify(hover!.text)};\n`,
      },
      {
        name: "受管小节注释从别的函数注入",
        display: "core/ops.ts",
        source: `function leak() {\n  const lines: string[] = [];\n  lines.push(${JSON.stringify(goalComment!.text)});\n  return lines;\n}\n`,
      },
      {
        name: "fanout 定界标记改名冒充",
        display: "core/ops.ts",
        source: `const __spoof = ${JSON.stringify(fanoutBegin!.text)};\n`,
      },
      {
        name: "新 UI 变量承载鉴权日志文案",
        display: "dsh-graph-host/lib/client/constants.js",
        source: 'const __tip = "g-507 拒绝 401 unauthenticated";\n',
      },
    ];
    for (const spoof of spoofs) {
      const file = join(dir, `${spoofs.indexOf(spoof)}.ts`);
      writeFileSync(file, spoof.source, "utf8");
      const hits = scanGoalIdLiterals(file, spoof.display);
      const { allowed, unexpected } = partitionGoalIdHits(hits, ALLOWED);
      assert.equal(allowed.length, 0, `${spoof.name}：绝不能命中白名单（子串/同名字面值冒充必须失败）`);
      assert.ok(unexpected.length >= 1, `${spoof.name}：必须被判定为未登记的目标编号`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-561 S7：静态可求值拼接必判红，动态拼接不误拦（并声明折叠边界）", () => {
  const dir = mkdtempSync(join(tmpdir(), "g561-scan-fold-"));
  try {
    const file = join(dir, "fold.ts");
    writeFileSync(file, [
      'export const a = "g-" + "507";',
      'export const b = `g-${"507"}`;',
      'export const g = "g-" + "5" + "07";',
      'const seq = 1; const PREFIX = "g-";',
      'export const c = "g-" + seq;',
      'export const d = `g-${seq}`;',
      'export const e = "g-" + PREFIX;',
      'export const f = ["g-", "507"].join(""); // 边界：不解析方法调用/跨语句常量',
      "",
    ].join("\n"), "utf8");
    const hits = scanGoalIdLiterals(file, "fold.ts");
    assert.equal(hits.length, 3, `静态拼接应恰好命中 3 条（a/b/g），实得 ${hits.length}`);
    for (const hit of hits) assert.equal(hit.text, "g-507", "折叠后的完整值必须是 g-507");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-561 S8：跨平台 displayPath 归一化 —— win32 反斜杠命中 POSIX 精确规则，错误路径不归属", () => {
  // ① 实际 win32 路径 API 锚点：Windows 原生 relative 返回反斜杠（这正是此前跨平台假红的来源）。
  assert.equal(win32.relative("C:\\repo", "C:\\repo\\core\\ops.ts"), "core\\ops.ts", "win32.relative 原生返回反斜杠");
  // ② 唯一规范化边界：同一输入变成仓库相对 POSIX 逻辑路径（白名单规则一律用 `/`）。
  assert.equal(toRepoRelativePosix("C:\\repo", "C:\\repo\\core\\ops.ts"), "core/ops.ts");
  assert.equal(toRepoRelativePosix("C:\\repo", "C:/repo/core/ops.ts"), "core/ops.ts", "混合分隔符同样归一");
  assert.equal(toRepoRelativePosix("C:\\repo\\", "C:\\repo\\core\\ops.ts"), "core/ops.ts", "尾部分隔符不影响");
  // ③ 用 win 派生 displayPath 扫描真实 ops.ts ⇒ 必须命中「受管小节」的精确规则（file/hash/sink/scope 全等）。
  const goalRule = ALLOWED.find((rule) => rule.functionScope === "renderRelationSection");
  assert.ok(goalRule, "受管小节白名单规则必须存在");
  const winDisplay = toRepoRelativePosix("C:\\repo", "C:\\repo\\core\\ops.ts");
  assert.equal(winDisplay, "core/ops.ts");
  const winHits = scanGoalIdLiterals(join(ROOT, "core", "ops.ts"), winDisplay!);
  assert.ok(winHits.some((hit) => matchesAllowed(hit, goalRule!)), "win32 反斜杠归一后必须命中预期精确规则");
  // ④ 错误文件/目录/同 basename 不得归属：规则匹配是 files.includes 全等，不是前缀/子串/basename。
  const wrongDir = toRepoRelativePosix("C:\\repo", "C:\\repo\\other\\core\\ops.ts");
  assert.equal(wrongDir, "other/core/ops.ts");
  const sameBasename = toRepoRelativePosix("C:\\repo", "C:\\repo\\vendor\\ops.ts");
  assert.equal(sameBasename, "vendor/ops.ts");
  const directory = toRepoRelativePosix("C:\\repo", "C:\\repo\\core");
  assert.equal(directory, "core");
  for (const candidate of [wrongDir, sameBasename, directory]) {
    assert.ok(candidate, "候选路径本身可归一");
    assert.equal(ALLOWED.some((rule) => rule.files.includes(candidate!)), false, `错误路径不得命中任何精确规则：${candidate}`);
    assert.equal(winHits.some((hit) => matchesAllowed(hit, { ...goalRule!, files: [candidate!] })), false,
      `同 basename/错误目录不得冒充精确文件：${candidate}`);
  }
  // ⑤ 跨根 / 跨盘 / 仓库根本身 一律拒绝归属（返回 null，绝不靠子串兜底）。
  assert.equal(toRepoRelativePosix("C:\\repo", "C:\\repo2\\core\\ops.ts"), null, "跨根（..）不得归属");
  assert.equal(toRepoRelativePosix("C:\\repo", "D:\\core\\ops.ts"), null, "跨盘不得归属");
  assert.equal(toRepoRelativePosix("C:\\repo", "C:\\repo"), null, "仓库根本身不是文件");
  // ⑥ 当前 Linux/POSIX 环境不回归：源与 dist 的真实路径归一结果与既有规则逐字一致。
  assert.equal(toRepoRelativePosix(ROOT, join(ROOT, "core", "ops.ts")), "core/ops.ts");
  assert.equal(toRepoRelativePosix(ROOT, join(ROOT, "dist", "core", "ops.js")), "dist/core/ops.js");
  assert.equal(toRepoRelativePosix(ROOT, join(ROOT, "dsh-graph-host", "lib", "client", "constants.js")),
    "dsh-graph-host/lib/client/constants.js");
  // ⑦ 规则表本身只允许 POSIX 逻辑路径（防止未来有人把反斜杠写进白名单形成模糊匹配）。
  for (const rule of ALLOWED) {
    for (const file of rule.files) assert.doesNotMatch(file, /\\/, `白名单文件必须是 POSIX 逻辑路径：${file}`);
  }
});
