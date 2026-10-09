#!/usr/bin/env node
/**
 * g-464：composed effective-config（`dsh web --dump-config` 的 YAML 树）里**真实 bundle 条目**的
 * 结构化判据 —— 取代原先的「全文件子串匹配」`grep -q "dsh-graph"`。
 *
 * 为什么不能用子串匹配（真机缺陷，g-463 独立验证踩到、g-464 复现）：
 * composed tree 里带**注释**形式的补丁来源标注：
 *
 *     # == @deepseek-ai/dsh-web-app, patched by /home/…/dsh-graph/tmp/dsh-test/0.2.1/home/profiles/web/cordis.patch.yml
 *
 * 注释里的**仓库绝对路径本身含 `dsh-graph`** ⇒ 即使插件的 profile bundle 在启动期被静默跳过
 * （`dsh: skipping profile bundle "dsh-graph": …`），`grep` 仍命中 ⇒ 测试实例「插件完全缺席」却被判为
 * 启动成功，后续一切基于该实例的验证全部失真。
 *
 * 本判据只认**结构**：在 YAML 树的条目（`- id: … / name: …` 这类映射项）里，按**精确字符串相等**匹配
 * 插件的 bundle 名。整行注释（`^\s*#`）在扫描前剔除，因此注释里的路径、任意子串命中都不构成条目。
 *
 * 用法：`node effective-config-bundle-entry.mjs <config> <bundle-name> [plugin-id]`
 *   0 = 命中真实条目（stdout 打印命中行）
 *   1 = 未命中（stderr 打印原因；注释命中数会如实点出，便于区分「只被注释命中」）
 *   2 = 用法/读取错误
 *
 * 依赖：只用 node 内置模块（脚本必须在无网络、纯 bash+node 环境可用）。
 */
import { readFileSync } from "node:fs";

/** 一个 YAML 映射项的**自身**键值（不代表缩进更深的嵌套子键）。 */
const ITEM_START = /^([ \t]*)-([ \t]+)([A-Za-z0-9_.$-]+)[ \t]*:[ \t]*(.*)$/;
const KEY_VALUE = /^([ \t]*)([A-Za-z0-9_.$-]+)[ \t]*:[ \t]*(.*)$/;

/** 剥掉 YAML 标量的引号与行尾注释，得到用于**精确相等**比较的字面值。 */
export function scalarOf(raw) {
  const value = String(raw).trim();
  if (value.startsWith("'")) {
    // 单引号标量：内部 '' 是转义的单引号；YAML 不把 # 当注释。
    const end = value.indexOf("'", 1);
    if (end > 0) return value.slice(1, end).replace(/''/g, "'");
    return value.slice(1);
  }
  if (value.startsWith('"')) {
    const end = value.lastIndexOf('"');
    if (end > 0) {
      try {
        return JSON.parse(value.slice(0, end + 1));
      } catch {
        return value.slice(1, end);
      }
    }
    return value.slice(1);
  }
  // 裸标量：` #` 起注释（YAML 规定 # 前需空白才算注释）。
  const hash = value.search(/[ \t]#/);
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

/**
 * 收集 YAML 树里每个映射项的**自身**键值对。
 *
 * 只接受与项标记**同级**的键（`- id: x` 之后缩进相同的 `name: y`），因此 `config:` 之类子块里的
 * 同名键不会被误当成条目自身的键；缩进回到项一级之前即结束当前项。
 *
 * @param {string} text composed effective-config 全文
 * @returns {{ line: number, keys: Map<string, string> }[]} 每项一行号 + 一张「自身键 → 字面值」表
 */
export function parseEntryItems(text) {
  /** @type {{ line: number, keys: Map<string, string> }[]} */
  const items = [];
  /** @type {{ line: number, keys: Map<string, string> } | null} */
  let current = null;
  let keyIndent = -1;
  String(text)
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = raw.replace(/[ \t]+$/, "");
      if (line.trim() === "") return;
      if (/^[ \t]*#/.test(line)) return; // 整行注释：注释里的路径/名字永不构成条目
      const item = ITEM_START.exec(line);
      if (item) {
        current = { line: index + 1, keys: new Map() };
        items.push(current);
        keyIndent = item[1].length + 1 + item[2].length;
        current.keys.set(item[3], scalarOf(item[4]));
        return;
      }
      const pair = KEY_VALUE.exec(line);
      if (!pair) return; // 标量/列表续行：不是键，忽略
      if (current !== null && pair[1].length === keyIndent) current.keys.set(pair[2], scalarOf(pair[3]));
      else if (current !== null && pair[1].length < keyIndent) current = null; // 已离开该项
    });
  return items;
}

/**
 * 找出插件的**真实 bundle 条目**：某个项声明 `name` 与插件 bundle 名**精确相等**；若调用方给了
 * 期望的插件 id 且该项也声明了 `id`，则 id 也必须精确相等。
 *
 * 身份用 `name`（npm 包名，即宿主 `skipping profile bundle "dsh-graph"` 里报的同一个名字）而不是 id：
 * 用户层 patch 可以只按 `id: dsh-graph-host` 覆盖 config 而**不**声明 name —— 那种项在 bundle 被跳过时
 * 依然存在，若用 id 单独判定就会重新引入假阳性。
 *
 * @param {string} text composed effective-config 全文
 * @param {{ name: string, id?: string }} expected
 * @returns {{ name: string, id: string | undefined, line: number } | undefined}
 */
export function findBundleEntry(text, expected) {
  for (const item of parseEntryItems(text)) {
    const name = item.keys.get("name");
    if (name !== expected.name) continue;
    const declaredId = item.keys.get("id");
    if (expected.id !== undefined && declaredId !== undefined && declaredId !== expected.id) continue;
    return { name, id: declaredId, line: item.line };
  }
  return undefined;
}

/** 注释行里出现 bundle 名的次数（只为诊断文案：区分「只被注释命中」）。 */
export function commentHits(text, needle) {
  let hits = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^[ \t]*#/.test(line) && line.includes(needle)) hits += 1;
  }
  return hits;
}

function main(argv) {
  const [configPath, bundleName, pluginId] = argv;
  if (!configPath || !bundleName) {
    process.stderr.write("用法：effective-config-bundle-entry.mjs <config> <bundle-name> [plugin-id]\n");
    return 2;
  }
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    process.stderr.write(
      `无法读取 composed effective-config：${configPath}（${error instanceof Error ? error.message : String(error)}）\n`,
    );
    return 2;
  }
  const found = findBundleEntry(text, pluginId === undefined ? { name: bundleName } : { name: bundleName, id: pluginId });
  if (found) {
    const id = found.id === undefined ? "（未声明 id）" : found.id;
    process.stdout.write(`命中真实 bundle 条目：name=${found.name} id=${id}（composed config 第 ${found.line} 行）\n`);
    return 0;
  }
  process.stderr.write(
    `composed effective-config 里没有 name=${JSON.stringify(bundleName)} 的真实 bundle 条目` +
      `（已剔除整行注释；全文件子串命中 ${commentHits(text, bundleName)} 处，全部落在注释里，不构成条目）\n`,
  );
  return 1;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("effective-config-bundle-entry.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
