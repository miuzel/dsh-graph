/** g-561：**用户可见运行时输出零静态目标编号**的通用结构守卫 + 负向对照。
 *
 * 负责人裁定（2026-10-28 扩大范围）：最终产物里所有**运行时日志 / 错误 / 界面文案**中的硬编码
 * 历史目标编号（`g-NNN`）都必须换成准确的中性功能描述；**源码注释与文档保留**；**业务动态目标 ID
 * 必须保留**。故本守卫不是「全仓替换 g-」的文本 grep，而是：
 *   1. 用 AST 只取字符串/模板字面量（注释天然排除）⇒ 注释里的历史编号不会误伤；
 *   2. 只拦**静态正文**里的 `g-<数字>`；模板插值 / `"g-" + seq` 等动态真实 ID 天然不命中；
 *   3. 对生产源码与**真实构建的 dist 运行时产物**（host index / 编译 core / 客户端 bundle）双向扫描；
 *   4. 非输出的注释型字面量必须**逐条登记白名单并给理由**，且证明每条在源码与 dist 都真实存在
 *      （白名单过期或被用来掩盖输出面回归都会判红）；
 *   5. 负向对照证明扫描器真的能抓到日志 / 路由 Error / UI 文案三类回归，且不会误拦动态 ID。
 *
 * 诚实边界：本守卫只覆盖**运行时代码的字符串字面量**。dist 内文档类资产（prompts/*.md、README、
 * schema/SCHEMA.md、diagrams）与源码/测试注释按裁定保留历史编号，不在此断言范围。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  STATIC_GOAL_ID_RE,
  OUTPUT_SINK_RE,
  allowedFileMatches,
  scanGoalIdLiterals,
  partitionGoalIdHits,
  formatGoalIdHit,
  type AllowedGoalIdLiteral,
  type GoalIdLiteralHit,
} from "./_runtime-goal-id-scan.ts";

const ROOT = process.cwd();

/**
 * 白名单：只允许「非运行时输出」的注释型字面量（历史编号保留，不渲染、不写日志）。
 * 每条都必须能解释**为什么不会被用户看到**，且 `fileIncludes` 限定在它真实所在的源/产物文件。
 */
const ALLOWED: AllowedGoalIdLiteral[] = [
  {
    textIncludes: "受管小节（g-379）",
    fileIncludes: ["ops.ts", "ops.js"],
    reason: "写入 goal.md 的 HTML 注释标记（文档注释，不渲染、不是运行时日志）",
  },
  {
    textIncludes: "g-440 fan-out independent-verification guard",
    fileIncludes: ["ops.ts", "ops.js"],
    reason: "源码块定界标记常量（供测试抽取，不面向用户、不写日志）",
  },
  {
    textIncludes: "g-352：",
    fileIncludes: ["constants.js", "dist/lib/client.js"],
    reason: "HOVER_CSS 字符串内嵌的 CSS 注释（浏览器不渲染，非运行时输出）",
  },
];

function filesIn(relDir: string, suffix: string): string[] {
  const dir = join(ROOT, relDir);
  return readdirSync(dir).filter((name) => name.endsWith(suffix)).sort().map((name) => join(dir, name));
}

function displayPath(file: string): string {
  return relative(ROOT, file);
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
  const { allowed, unexpected } = partitionGoalIdHits(scanAll(productionSourceFiles()), ALLOWED);
  assert.deepEqual(unexpectedLines(unexpected), [], "生产源码出现未登记的静态目标编号（请改成中性功能描述或登记白名单）");
  assert.ok(allowed.length >= ALLOWED.length, "白名单条目必须在源码中真实命中（不允许空挂）");
  for (const { hit } of allowed) {
    assert.doesNotMatch(hit.sink, OUTPUT_SINK_RE, `注释型白名单字面量绝不能落在日志/Error 输出面：${hit.file}:${hit.line}`);
  }
});

test("g-561 S2：隔离构建的最终 dist 运行时产物零未登记目标编号（含客户端 bundle）", () => {
  const { allowed, unexpected } = partitionGoalIdHits(scanAll(distRuntimeFiles()), ALLOWED);
  assert.deepEqual(unexpectedLines(unexpected), [], "dist 运行时代码出现未登记的静态目标编号（源码修了但产物没构建对齐？）");
  assert.ok(allowed.length >= ALLOWED.length, "白名单条目必须在 dist 中真实命中（产物与源码一致）");
});

test("g-561 S3：白名单逐条可追溯 —— 源码与 dist 都存在，且只覆盖非输出注释型字面量", () => {
  const sourceHits = scanAll(productionSourceFiles());
  const distHits = scanAll(distRuntimeFiles());
  for (const rule of ALLOWED) {
    const matches = (hits: GoalIdLiteralHit[]) =>
      hits.filter((hit) => hit.text.includes(rule.textIncludes) && allowedFileMatches(rule, hit.file));
    assert.ok(matches(sourceHits).length > 0, `白名单条目在源码中已不存在（过期应删除）：${rule.textIncludes}`);
    assert.ok(matches(distHits).length > 0, `白名单条目在 dist 中不存在（构建未对齐或条目过期）：${rule.textIncludes}`);
    for (const hit of matches(distHits)) {
      assert.doesNotMatch(hit.sink, OUTPUT_SINK_RE, `白名单不得掩盖输出面回归：${formatGoalIdHit(hit)}`);
    }
  }
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
