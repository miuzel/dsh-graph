#!/usr/bin/env node
/**
 * scripts/run-tests.mjs —— 「整套件真的跑了」的**自证闸门**（g-350，源自 g-407 R1）。
 *
 * 缺陷（g-407 R1，执行者与复核者独立复现）：
 *   NODE_TEST_CONTEXT=child-v8 node --test core/tests/*.test.ts
 * 以**顶层注入**形态启动整套件时，`node --test` 打印 `skipping running files`、
 * **不加载任何测试文件**、零汇总输出并 `exit 0`。此时仓内不存在任何可自检的位置
 * （根本没有测试文件被加载）⇒「全套绿」可能是假的（false green）。
 *
 * 本闸门是**跨平台**（纯 Node，不依赖 `env -u`、不依赖 shell 展开 glob）的统一入口：
 *   ① 自己展开测试文件清单（Windows cmd / PowerShell 下 `*.test.ts` 不会被 shell 展开）；
 *   ② 派生 runner 前经 `core/tests/fixtures/nested-runner.ts` 的 `cleanTestEnv()` 摘除
 *      `NODE_TEST_CONTEXT` / `NODE_TEST_WORKER_ID`（全仓唯一实现，不各写一份）；
 *   ③ 用同一 helper 的 `assertNestedSuiteRan()` **自证**：无 `skipping running files` 标记、
 *      有汇总行、`tests > 0`；再追加 `fail === 0 && skipped === 0`；
 *   ④ 退出码 0 ⇔「确实跑了 tests>0 且 skipped==0 且 fail==0」，并把汇总逐字回显在 stdout。
 *
 * 为什么选本方案（取舍说明）：
 *   - 「测试引导处断言 `NODE_TEST_CONTEXT` 未设置」对**顶层注入**无效：注入已经发生，
 *     且没有任何测试文件被加载，断言无处执行（对「测试内再启动」形态仍由 g-407 覆盖）；
 *   - 「把文档命令整体换成统一入口」会与大量把 `node --test core/tests/*.test.ts` 当字面锚的
 *     守卫（g-335 / g-407 / 指南）分叉；本闸门**不改**既有文档命令，只在其之上叠加可自证入口，
 *     并以 `TEST_GLOB` 常量与文档共享同一字面量（守卫测试钉住，见 core/tests/g350-test-hygiene.test.ts）。
 *
 * 用法：node scripts/run-tests.mjs [测试文件…]     （缺省 = TEST_GLOB）
 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 文档里那一条命令的 glob：与 AGENTS.md / 指南共用同一字面量，避免入口分叉。 */
export const TEST_GLOB = "core/tests/*.test.ts";

// 唯一实现复用：绝不在此另写一份注入变量摘除（`NODE_TEST_CONTEXT` 的清理只能来自该 helper，g-407 判据 2）。
const { cleanTestEnv, parseTestSummary, assertNestedSuiteRan } = await import(
  pathToFileURL(join(repoRoot, "core/tests/fixtures/nested-runner.ts")).href
);

/** 只支持 `<dir>/*<suffix>` 形态（本仓唯一用到的形态）；其余形态显式报错，不静默判绿。 */
function expandGlob(glob) {
  const m = /^([^*]+)\/(\*[^/]*)$/.exec(glob);
  if (!m) throw new Error(`不支持的 glob 形态（只支持 <dir>/*<suffix>）：${glob}`);
  const [, dir, pattern] = m;
  const suffix = pattern.slice(1);
  return readdirSync(join(repoRoot, dir))
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => `${dir}/${name}`);
}

const argv = process.argv.slice(2);
const targets = argv.length > 0 ? argv : expandGlob(TEST_GLOB);
if (targets.length === 0) {
  console.error(`[run-tests] 未展开到任何测试文件（glob=${TEST_GLOB}）⇒ 不得判绿`);
  process.exit(2);
}

const started = Date.now();
const child = spawn(process.execPath, ["--test", ...targets], {
  cwd: repoRoot,
  env: cleanTestEnv(), // ← 自证的前提：注入变量在此被摘除（唯一实现）
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
let err = "";
child.stdout.on("data", (chunk) => { out += chunk; });
child.stderr.on("data", (chunk) => { err += chunk; });
child.on("error", (e) => {
  console.error(`[run-tests] 无法启动测试 runner：${e?.message ?? e}`);
  process.exit(2);
});

child.on("close", (code) => {
  process.stdout.write(out);
  process.stderr.write(err);
  const summary = parseTestSummary(out, err);
  const run = {
    code,
    out,
    err,
    summary,
    command: `${process.execPath} --test ${targets.join(" ")}`,
  };
  try {
    assertNestedSuiteRan(run, "整套件自证闸门");
    if (summary.fail !== 0) throw new Error(`整套件自证闸门：不得有失败用例（fail=${summary.fail}）`);
    if (summary.skipped !== 0) throw new Error(`整套件自证闸门：不得有用例被跳过（skipped=${summary.skipped}）`);
  } catch (e) {
    console.error(`\n[run-tests] ✖ 自证失败：${e?.message ?? e}`);
    process.exit(1);
  }
  console.log(
    `\n[run-tests] ✔ 自证通过：tests=${summary.tests} (>0) skipped=${summary.skipped} fail=${summary.fail} ` +
      `pass=${summary.pass} ms=${Date.now() - started} glob=${TEST_GLOB}`,
  );
  process.exit(0);
});
