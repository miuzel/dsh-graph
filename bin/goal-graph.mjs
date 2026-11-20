#!/usr/bin/env node
/**
 * goal-graph 可执行入口（g-314 / g-634）。
 *
 * 两个入口形态（判据 1：全局 + 项目本地，零常驻服务、零网络、零第三方 CLI 框架）：
 *
 * 1. **发布形态**：`dist/bin/goal-graph.mjs` —— 由 build.sh 从本文件复制，`package.json` 的
 *    `bin.goal-graph` 指向它；它加载同目录的编译产物 `../core/cli/main.js`（纯 JS，无需 type-strip）。
 * 2. **源码形态**：仓库根 `bin/goal-graph.mjs` —— 直接 `node bin/goal-graph.mjs`，加载 `core/cli/main.ts`
 *    （Node ≥ 22.6 原生 type-stripping；node_modules 之外的 .ts 可加载）。
 *
 * 解析顺序：先找同目录 `../core/cli/main.js`（发布形态），再退回 `../core/cli/main.ts`（源码形态）。
 * 两者都缺失时报可读错误并非零退出（绝不静默成功）。
 *
 * 冷启动纪律：本文件**不**引入 `yaml` 等第三方模块，只依赖 Node 内置 + core 的零重依赖模块；
 * 目标是在同机实测 <100ms。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** 候选入口模块（相对本文件）。 */
const CANDIDATES = [
  join(here, "..", "core", "cli", "main.js"), // 发布形态：dist/bin → dist/core/cli/main.js
  join(here, "..", "core", "cli", "main.ts"), // 源码形态：bin → core/cli/main.ts
];

async function main() {
  let mod = null;
  let lastError = null;
  for (const candidate of CANDIDATES) {
    if (!existsSync(candidate)) continue;
    try {
      mod = await import(pathToFileURL(candidate).href);
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!mod) {
    const hint = lastError ? `（加载失败：${lastError.message}）` : "";
    process.stderr.write(
      `goal-graph: 找不到可执行核心模块${hint}\n` +
        `  期望其一存在：${CANDIDATES.join(" 或 ")}\n` +
        `  发布形态请先运行 bash scripts/build.sh；源码形态请在仓库根运行 node bin/goal-graph.mjs\n`,
    );
    process.exitCode = 1;
    return;
  }

  const version = await readPackageVersion();
  // runAndPrint 是 async（命令按需惰性加载 diagnostics）⇒ 必须 await，否则把 Promise
  // 直接赋给 process.exitCode 会抛 ERR_INVALID_ARG_TYPE 并让「成功」命令退出 1。
  const exitCode = await mod.runAndPrint(process.argv.slice(2), { version });
  process.exitCode = exitCode;
}

/** 版本来源：发布形态读 dist/package.json，源码形态读 dsh-graph-host/package.json。 */
async function readPackageVersion() {
  const { readFileSync } = await import("node:fs");
  for (const rel of [join(here, "..", "package.json"), join(here, "..", "..", "dsh-graph-host", "package.json")]) {
    if (!existsSync(rel)) continue;
    try {
      const pkg = JSON.parse(readFileSync(rel, "utf8"));
      if (typeof pkg?.version === "string" && pkg.version) return pkg.version;
    } catch {
      /* 忽略，继续下一个候选 */
    }
  }
  return "0.0.0-unknown";
}

await main();
