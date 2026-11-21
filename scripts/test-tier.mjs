#!/usr/bin/env node
/**
 * scripts/test-tier.mjs —— g-629 测试**分层入口**：只负责「集合展开」，判定全部继承。
 *
 * 设计红线（违反即返工）：
 *  ① `scripts/run-tests.mjs` 的 `TEST_GLOB` 与**无参行为**完全不变 —— 无参 `node scripts/run-tests.mjs`
 *     仍是发布门禁（= 磁盘全集）。本文件**不修改**也不绕过它。
 *  ② 本文件只把**显式文件路径**原样交给 run-tests.mjs（spawn）。**绝不复制**其计数通道、三方交叉校验、
 *     逐文件覆盖断言、空集 exit 2、NODE_OPTIONS 选集拒绝等逻辑 —— 全部由 run-tests.mjs 继承执行。
 *  ③ 本文件自身对**空集合**也必须失败（不因 run-tests 会 exit 2 就少写自己那一道）。
 *
 * 两条**正交**的分类轴（唯一真源 `core/tests/tier-manifest.json`）：
 *
 *  ① 日常回归梯度 `tiers`（按 include 派生，相邻层严格递增，守卫钉住）：
 *       shakedown ⊊ integration ⊊ full ⊊ (full ∪ microTests) = everything
 *     - 每层 `files` 是**本层新增**；实际集合 = include 链并集。
 *     - `everything` = 磁盘 `core/tests/*.test.ts` 全集（按磁盘展开，不登记进 manifest）。
 *     - `full` 是「值得按需完整回归」的边界；`microTests`（细小低风险、舍不得删）只挂 everything。
 *
 *  ② `focused` = **关键目标专题集合**（按需调用，不是层级、不被任何层 include）：
 *       focused: { topics: { "<topic>": { description, files[], ... } } }
 *     专题内容可与层级文件**重叠**：专题是「必要时单独被调用的一系列测试」，
 *     层级是「日常回归梯度」。二者不是同一维度的东西。
 *
 * 用法：
 *   node scripts/test-tier.mjs shakedown               # 日常推荐层
 *   node scripts/test-tier.mjs integration             # 主流程 + DSH 宿主集成
 *   node scripts/test-tier.mjs full                    # 完整回归（不含 microTests）
 *   node scripts/test-tier.mjs everything              # 磁盘全集（与无参闸门同一文件集合）
 *   node scripts/test-tier.mjs focused                 # 跑**全部**专题（并集）
 *   node scripts/test-tier.mjs focused/gate-integrity  # 只跑单个专题
 *   node scripts/test-tier.mjs full --labels perf      # 层 ∩ 标签（交，不是并）
 *   node scripts/test-tier.mjs --list                  # 列出层级 / 专题 / 标签规模，不运行
 *   node scripts/test-tier.mjs focused --list          # 只打印专题清单（每个专题的文件数）
 *   node scripts/test-tier.mjs focused/<topic> --list  # 打印该专题的文件清单，不运行
 *
 * 注意：`everything` 是「同一文件集合」的另一种选择方式，**不等于** `scripts/run-tests.mjs` 无参
 * 这一发布门禁的角色（后者是权威入口）。输出会明确打印选中的集合名、文件数与 manifest hash。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// 被 `| head` 等下游提前关闭管道时不要以未捕获异常崩溃（列表输出是纯文本，被截断属正常用法）。
process.stdout.on("error", (e) => {
  if (e?.code === "EPIPE") process.exit(0);
  throw e;
});

const MANIFEST_REL = "core/tests/tier-manifest.json";
// 守卫测试要用**真实进程**跑入口跑变异副本（不能只测函数）：`TEST_TIER_MANIFEST` 只换清单路径，
// 不改变任何选择/判定语义；缺省就是仓库里那份唯一真源。
const MANIFEST_PATH = process.env.TEST_TIER_MANIFEST
  ? resolve(process.env.TEST_TIER_MANIFEST)
  : join(repoRoot, MANIFEST_REL);
const TESTS_DIR = "core/tests";
const GATE = join(repoRoot, "scripts", "run-tests.mjs");
const FOCUSED_PREFIX = "focused/";

/** 与 run-tests.mjs 同一 glob 语义的**只读**磁盘展开（everything 的真源）。 */
const DISK_GLOB_SUFFIX = ".test.ts";

const USAGE =
  "用法：node scripts/test-tier.mjs <shakedown|integration|full|everything|focused|focused/<专题>> " +
  "[--labels perf,variant] [--list]";

function fail(message, code = 2) {
  // 只设 exitCode（不 process.exit），与本仓 g-415 的 flush 纪律一致；此处输出极小但保持一致。
  process.stderr.write(`[test-tier] ✖ ${message}\n`);
  process.exitCode = code;
}

function loadManifest() {
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(raw);
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  const problems = focusedMisuse(manifest);
  if (problems.length > 0) {
    throw new Error(`manifest 违规（focused 被当成层级/层成分）⇒ fail-closed：\n  - ${problems.join("\n  - ")}`);
  }
  return { manifest, hash };
}

/**
 * 入口侧的**清单完整性**自检（与守卫测试 `manifestProblems` 同口径、但**独立实现** —— 入口必须能自证，
 * 不能只靠守卫文件跑绿）。问题顺序固定为「层内登记了磁盘不存在的文件 → 磁盘未分类 → 层为空」：
 *
 *  - **层内缺失**优先于**未分类**：删掉某层的登记会让该文件**同时**变成「未分类」与「层内缺失」，
 *    若先报未分类，真实红因会被「未分类」掩盖（评审实测：变异①被误判成未分类）。
 *  - 只核 `tiers`（登记成员必须是磁盘上真实存在的测试文件）；专题与标签的成员存在性由守卫核。
 */
function tierIntegrityProblems(manifest, disk) {
  const diskSet = new Set(disk);
  const missing = [];
  const empty = [];
  for (const [tier, def] of Object.entries(manifest.tiers ?? {})) {
    const declared = [...new Set((def?.files ?? []).map(asPath))].sort();
    for (const file of declared) {
      if (!diskSet.has(file)) missing.push(`层级「${tier}」登记了磁盘上不存在的文件：${file.split("/").pop()}`);
    }
    if (tier !== "everything" && declared.length === 0) empty.push(tier);
  }
  const registered = new Set(
    Object.values(manifest.tiers ?? {}).flatMap((def) => (def?.files ?? []).map(asPath)),
  );
  const micro = (manifest.microTests?.files ?? []).map((e) => asPath(e?.file ?? ""));
  for (const file of micro) {
    if (!diskSet.has(file)) missing.push(`microTests 登记了磁盘上不存在的文件：${file.split("/").pop()}`);
  }
  const unclassified = disk.filter((f) => !registered.has(f) && !micro.includes(f));
  return { missing, unclassified, empty };
}

/** manifest 把文件名归一成 `core/tests/<name>` 路径（专题/标签/层级三种成员共用）。 */
function asPath(name) {
  return name.startsWith(`${TESTS_DIR}/`) ? name : `${TESTS_DIR}/${name}`;
}

/**
 * `focused` 是**专题集合**，不是层级 —— 入口侧 fail-closed 自检（守卫测试另有同款判据，
 * 两者**互相独立**：manifest 被改成「focused 当层」时，入口必须自己判红，而不是靠后续
 * 「未知层级 / 层为空」之类的巧合拒绝 ⇒ 否则 tiers.focused 会被当普通层跑绿）。
 *
 * 判红条件（逐条点名）：
 *  ① `manifest.tiers.focused` 存在（把专题误登记成日常层）；
 *  ② 任一层（含 `everything` 与未知层名）的 `include` 里出现 `focused` 或以 `focused` 开头；
 *  ③ 任一层 / 任一张专题的 `files` 里出现 `focused` 或以 `focused` 开头的**成员名**
 *     （专题只有 `focused.topics` 一个真源，不得被别的集合 include）。
 */
function focusedMisuse(manifest) {
  const problems = [];
  if (manifest.tiers && Object.hasOwn(manifest.tiers, "focused")) {
    problems.push("manifest.tiers.focused 存在 ⇒ focused 是专题集合、不是层级，不得登记为日常层");
  }
  for (const [tier, def] of Object.entries(manifest.tiers ?? {})) {
    for (const parent of def?.include ?? []) {
      if (typeof parent === "string" && (parent === "focused" || parent.startsWith("focused"))) {
        problems.push(`层级「${tier}」的 include 含「${parent}」⇒ focused 专题不得作任何层的成分`);
      }
    }
    for (const member of def?.files ?? []) {
      const name = typeof member === "string" ? member : member?.file;
      if (typeof name === "string" && (name === "focused" || name.startsWith(FOCUSED_PREFIX))) {
        problems.push(`层级「${tier}」的 files 含专题成员「${name}」⇒ 专题与层级是正交两轴`);
      }
    }
  }
  for (const [topic, def] of Object.entries(manifest.focused?.topics ?? {})) {
    for (const member of def?.files ?? []) {
      if (typeof member === "string" && (member === "focused" || member.startsWith(FOCUSED_PREFIX))) {
        problems.push(`专题「focused/${topic}」的 files 含「${member}」⇒ 专题成员必须是测试文件路径`);
      }
    }
  }
  return problems;
}

function diskFiles() {
  return readdirSync(join(repoRoot, TESTS_DIR))
    .filter((name) => name.endsWith(DISK_GLOB_SUFFIX))
    .sort()
    .map((name) => `${TESTS_DIR}/${name}`);
}

/**
 * 展开某层**并集语义**的完整集合：沿 include 链递归合并 `files`，返回排序后的
 * `core/tests/<name>` 路径。
 *
 * `everything` = 磁盘全集。按契约**不**登记进 manifest；但若有人显式登记了 `everything`
 * （如在 manifest 里手写一个「全集」层），我们**不静默忽略**：与磁盘做双向比对，
 * 多登记（幽灵）或漏登记（未分类）都抛错 —— 本入口是 fail-closed，不做「差不多就对」。
 */
function expandTier(manifest, tier, chain = []) {
  if (tier === "everything") {
    const disk = diskFiles();
    const declared = manifest.tiers?.everything;
    if (!declared) return disk;
    const registered = new Set(expandDeclared(manifest, "everything", chain));
    const unclassified = disk.filter((f) => !registered.has(f));
    const phantom = [...registered].filter((f) => !disk.includes(f));
    if (unclassified.length > 0 || phantom.length > 0) {
      const parts = [];
      if (unclassified.length > 0) parts.push(`磁盘未分类：${unclassified.join("、")}`);
      if (phantom.length > 0) parts.push(`幽灵项：${phantom.join("、")}`);
      throw new Error(`manifest.tiers.everything 与磁盘不一致 ⇒ ${parts.join("；")}`);
    }
    return disk;
  }
  return expandDeclared(manifest, tier, chain);
}

/** 沿 include 链展开**登记在 manifest 里**的层（不特判 everything）。 */
function expandDeclared(manifest, tier, chain = []) {
  const def = manifest.tiers?.[tier];
  if (!def) throw new Error(`未知层级：${tier}`);
  if (chain.includes(tier)) throw new Error(`层级 include 出现环：${[...chain, tier].join(" → ")}`);
  const nextChain = [...chain, tier];
  const out = new Set();
  for (const parent of def.include ?? []) {
    for (const f of expandDeclared(manifest, parent, nextChain)) out.add(f);
  }
  for (const name of def.files ?? []) out.add(asPath(name));
  return [...out].sort();
}

function topicNames(manifest) {
  return Object.keys(manifest.focused?.topics ?? {});
}

/** 单个专题的集合（专题**不**沿 include 链派生，它就是自己那一串文件）。 */
function expandTopic(manifest, topic) {
  const def = manifest.focused?.topics?.[topic];
  if (!def) {
    const known = topicNames(manifest);
    throw new Error(
      `未知专题：focused/${topic}${known.length > 0 ? `（已有：${known.join("、")}）` : ""}`,
    );
  }
  return [...new Set((def.files ?? []).map(asPath))].sort();
}

function expandLabel(manifest, label) {
  const def = manifest.labels?.[label];
  if (!def) throw new Error(`未知标签：${label}（已有：${Object.keys(manifest.labels ?? {}).join("、")}）`);
  return new Set((def.files ?? []).map(asPath));
}

function parseArgs(argv) {
  const tiers = [];
  const labels = [];
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--list" || arg === "-l") list = true;
    else if (arg === "--labels" || arg === "--label") {
      const value = argv[++i];
      if (!value) throw new Error("--labels 需要一个值（perf / variant）");
      labels.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (arg.startsWith("--labels=")) {
      labels.push(...arg.slice("--labels=".length).split(",").map((s) => s.trim()).filter(Boolean));
    } else if (arg.startsWith("-")) throw new Error(`未知开关：${arg}`);
    else tiers.push(arg);
  }
  return { tiers, labels, list };
}

/** 单个选择项（层名 / `focused` / `focused/<topic>`）⇒ 文件集合。 */
function expandSelector(manifest, selector) {
  if (selector === "focused") {
    const topics = topicNames(manifest);
    if (topics.length === 0) throw new Error("focused 没有任何专题 ⇒ 专题集合为空，不得判绿");
    const out = new Set();
    for (const topic of topics) for (const f of expandTopic(manifest, topic)) out.add(f);
    return [...out].sort();
  }
  if (selector.startsWith(FOCUSED_PREFIX)) {
    const topic = selector.slice(FOCUSED_PREFIX.length).trim();
    if (!topic) throw new Error("focused/ 后必须给出专题名（如 focused/gate-integrity）");
    return expandTopic(manifest, topic);
  }
  return expandTier(manifest, selector);
}

/** 选择项（可多个 ⇒ 并集）+ 标签（可多个 ⇒ 并集，再与选择项取交）⇒ 最终文件集合。 */
function resolveSelection(manifest, parsed) {
  const selectors = parsed.selectors.length > 0 ? parsed.selectors : ["everything"];
  const union = new Set();
  for (const selector of selectors) {
    for (const f of expandSelector(manifest, selector)) union.add(f);
  }
  let labelUnion = null;
  const parts = [...selectors];
  if (parsed.labels.length > 0) {
    labelUnion = new Set();
    for (const label of parsed.labels) {
      for (const f of expandLabel(manifest, label)) labelUnion.add(f);
    }
    parts.push(...parsed.labels.map((l) => `@${l}`));
  }
  // 标签是**过滤维度**（与选择项取交），不是并集扩集：`full --labels perf` = full 里带 perf 的那部分。
  const files = [...union].filter((f) => labelUnion === null || labelUnion.has(f)).sort();
  return { files, title: parts.join("+") };
}

function printList(manifest, hash, parsed) {
  const names = [...Object.keys(manifest.tiers ?? {}), "everything"];
  const topics = topicNames(manifest);

  // `--list` 单独用 ⇒ 总览（层级 + 专题 + 标签）
  if (parsed.selectors.length === 0 && parsed.labels.length === 0) {
    process.stdout.write(`[test-tier] manifest=${MANIFEST_REL} hash=${hash}\n`);
    process.stdout.write("  日常回归梯度（按 include 派生）：\n");
    for (const name of names) {
      const files = expandTier(manifest, name);
      process.stdout.write(`    ${name.padEnd(12)} ${String(files.length).padStart(3)} 个文件\n`);
    }
    const micro = (manifest.microTests?.files ?? []).length;
    process.stdout.write(`    ${"microTests".padEnd(12)} ${String(micro).padStart(3)} 个文件（只挂 everything）\n`);
    process.stdout.write("  focused 专题集合（按需调用，不是层级）：\n");
    if (topics.length === 0) {
      process.stdout.write("    （空 —— 专题集合为空 ⇒ 判红）\n");
      process.exitCode = 2;
      return;
    }
    for (const topic of topics) {
      const files = expandTopic(manifest, topic);
      process.stdout.write(
        `    focused/${topic.padEnd(22)} ${String(files.length).padStart(3)} 个文件\n`,
      );
    }
    for (const label of Object.keys(manifest.labels ?? {})) {
      const files = expandLabel(manifest, label);
      process.stdout.write(`    @${label.padEnd(19)} ${String(files.size).padStart(3)} 个文件\n`);
    }
    process.exitCode = 0;
    return;
  }

  // 带选择项/标签的 `--list` ⇒ 只打印**该选择**的清单
  const { files, title } = resolveSelection(manifest, parsed);
  process.stdout.write(`[test-tier] 集合：${title} → ${files.length} 个文件\n`);
  for (const f of files) process.stdout.write(`${f}\n`);
  process.exitCode = files.length === 0 ? 2 : 0;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
    parsed.selectors = parsed.tiers;
  } catch (e) {
    return fail(`${e.message}\n${USAGE}`);
  }

  let manifest, hash;
  try {
    ({ manifest, hash } = loadManifest());
  } catch (e) {
    return fail(`分层清单 ${MANIFEST_REL} 不可用 ⇒ fail-closed：${e.message}`);
  }

  // ── 入口自身的清单完整性（不依赖下游、也不依赖守卫文件是否被选中）────────────
  // 顺序即优先级：层内缺失 → 磁盘未分类 → 层为空。绝不静默少跑（fail-closed）。
  const integrity = tierIntegrityProblems(manifest, diskFiles());
  if (integrity.missing.length > 0) {
    return fail(
      `清单登记了磁盘上不存在的文件（层内缺失）⇒ fail-closed，不得静默少跑：\n  - ${integrity.missing.join("\n  - ")}`,
    );
  }
  if (integrity.unclassified.length > 0) {
    return fail(
      `磁盘有未分类测试文件（不在任何 tiers 层、也不在 microTests）⇒ fail-closed 判红：\n  - ${integrity.unclassified.join("\n  - ")}`,
    );
  }
  if (integrity.empty.length > 0) {
    return fail(`层级为空（${integrity.empty.join("、")}）⇒ fail-closed 判红`);
  }

  if (parsed.list) {
    try {
      printList(manifest, hash, parsed);
    } catch (e) {
      return fail(e.message);
    }
    return;
  }

  // ── 解析选择项 × 标签 ──────────────────────────────────────────────────────
  let selection;
  try {
    selection = resolveSelection(manifest, parsed);
  } catch (e) {
    return fail(`${e.message}\n${USAGE}`);
  }
  const { files, title } = selection;

  // ③ 入口**自身**的防空集：即使 run-tests.mjs 也会 exit 2，这里必须独立判红（不得依赖下游）。
  if (files.length === 0) {
    return fail(`集合为空（${title}）⇒ 不得判绿；请检查 ${MANIFEST_REL} 或选择项名称`);
  }

  process.stdout.write(`[test-tier] 集合：${title}\n`);
  process.stdout.write(`[test-tier] 文件数：${files.length}　manifest hash：${hash}\n`);
  if (title.split("+").includes("everything")) {
    process.stdout.write(
      "[test-tier] 注意：everything 是「同一文件集合」的分层入口，**不是**发布门禁；" +
        "发布门禁仍是无参 `node scripts/run-tests.mjs`。\n",
    );
  }

  // ── ② 把**显式文件路径**原样交给 run-tests.mjs（判定全部继承，不复制任何逻辑）──
  const child = spawn(process.execPath, [GATE, ...files], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  child.on("error", (e) => {
    fail(`无法启动 ${GATE}：${e?.message ?? e}`);
  });
  child.on("close", (code, signal) => {
    if (signal) {
      fail(`run-tests.mjs 被信号终止（${signal}）⇒ 不得判绿`, 1);
      return;
    }
    // 原样透传退出码：判定与红因完全由 run-tests.mjs 产生，本入口不复述、不改写。
    process.stdout.write(
      `\n[test-tier] 结束：集合=${title} 文件数=${files.length} manifest=${hash} exit=${code}\n`,
    );
    process.exitCode = code ?? 1;
  });
}

main();
