#!/usr/bin/env node
/**
 * ⚠️ SUPERSEDED（v0.17.0 / g-362）：本执行件已被取代 —— 不再维护第二份实现。
 *
 * macOS 与 Linux 门禁已**合并为一份跨平台实现**：`scripts/platform-smoke-test.mjs`
 *   （同一份代码同时支持 macOS/Linux，平台差异只体现在探针的判定口径与平台标注）。
 *
 * 本文件现在只做一件事：打印取代提示 + 把 argv 原样转发给新件（零重复逻辑）。
 *   - 被取代的实现（M1 旧 coreutils 退化构建路径 / M2 大小写探针 / M3 软链 root 边界 /
 *     M4 Linux-only 假设扫描）已归档到 `scripts/archived/macos-smoke-test.mjs`（内容一字未改）；
 *   - 其中 **M4 作为平台无关检查在新件里保持存活并导出**（它守的是发布脚本对 macOS/BSD 的
 *     可移植性，在合并后的跨平台门禁里依然成立）；只有已取消的 M1 随实现一起只留归档。
 *   - 新用法：`node scripts/platform-smoke-test.mjs …`；运行手册见 `docs/platform-gate.md`。
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** 取代后的唯一实现（转发目标）。 */
export const TARGET = join(import.meta.dirname, "platform-smoke-test.mjs");

/** 取代提示（打印到 stderr，保持 stdout 是纯转发流）。 */
export const NOTICE = [
  "⚠️  本执行件已被取代（SUPERSEDED，v0.17.0 / g-362）：macOS 与 Linux 门禁已合并为一份跨平台实现。",
  "    新件：scripts/platform-smoke-test.mjs      运行手册：docs/platform-gate.md",
  "    被取代的实现（M1–M4）归档在 scripts/archived/macos-smoke-test.mjs；M4 已作为平台无关检查并入新件。",
  "    本次调用原样转发给新件（以下为它自己的输出）。",
].join("\n");

const invokedDirectly = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(argv1)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  console.error(`${NOTICE}\n`);
  const r = spawnSync(process.execPath, [TARGET, ...process.argv.slice(2)], { stdio: "inherit" });
  if (r.error) {
    console.error(`转发失败：${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}
