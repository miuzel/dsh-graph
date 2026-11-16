#!/usr/bin/env node
/**
 * dsh-graph-skills 安装脚本（g-631）。
 *
 * 把包内 `skills/<name>/` 复制到目标技能目录。**只写目标目录，绝不改动用户既有技能内容**：
 *   - 已存在同名技能 ⇒ 默认跳过并提示（不覆盖用户可能的本地修改）；
 *   - `--force` 才覆盖；
 *   - 写入前先写到临时目录再整体 rename，避免半截技能目录。
 *
 * 零依赖：只用 Node 内置。用法：
 *   node install.mjs [--target <dir>] [--force]
 * 默认目标：`<DSH_HOME 或 ~/.dsh>/skills`（与 DSH 技能目录约定一致）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(fileURLToPath(import.meta.url));
const skillsSrc = join(pkgRoot, "skills");

export function defaultSkillTarget(env = process.env) {
  const dshHome = env.DSH_HOME ? resolve(env.DSH_HOME) : join(homedir(), ".dsh");
  return join(dshHome, "skills");
}

export function installSkills({ target = defaultSkillTarget(), force = false } = {}) {
  if (!existsSync(skillsSrc)) throw new Error(`包内缺少 skills/ 目录：${skillsSrc}`);
  const names = readdirSync(skillsSrc, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (names.length === 0) throw new Error("包内 skills/ 为空，拒绝安装（绝不静默成功）");
  mkdirSync(target, { recursive: true });
  const installed = [];
  const skipped = [];
  for (const name of names) {
    const dest = join(target, name);
    if (existsSync(dest) && !force) {
      skipped.push(name);
      continue;
    }
    const tmp = join(target, `.${name}.tmp-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    cpSync(join(skillsSrc, name), tmp, { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
    installed.push(name);
  }
  return { target, installed, skipped };
}

export function uninstallSkills({ target = defaultSkillTarget() } = {}) {
  const removed = [];
  for (const name of ["dsh-graph", "dsh-graph-supervisor"]) {
    const dest = join(target, name);
    if (existsSync(dest)) {
      rmSync(dest, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return { target, removed };
}

export function main(argv) {
  const force = argv.includes("--force");
  const i = argv.indexOf("--target");
  const target = i >= 0 ? resolve(argv[i + 1] ?? "") : defaultSkillTarget();
  if (argv.includes("--uninstall")) {
    const r = uninstallSkills({ target });
    if (r.removed.length === 0) {
      console.log(`未找到已安装的 dsh-graph 技能（目标：${r.target}）`);
      return 0;
    }
    console.log(`✅ 已卸载：${r.removed.join(", ")}（目标：${r.target}）`);
    return 0;
  }
  const r = installSkills({ target, force });
  console.log(`✅ 技能安装目标：${r.target}`);
  if (r.installed.length) console.log(`   已安装：${r.installed.join(", ")}`);
  if (r.skipped.length) {
    console.log(`   已跳过（已存在，加 --force 覆盖）：${r.skipped.join(", ")}`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`dsh-graph-skills: ${e.message}\n`);
    process.exitCode = 1;
  }
}
