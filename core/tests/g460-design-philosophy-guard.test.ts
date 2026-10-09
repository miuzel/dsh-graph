/**
 * core/tests/g460-design-philosophy-guard.test.ts
 *
 * g-460（v0.20.0 泳道，S0）设计哲学双语文档的**轻量结构守卫**。
 *
 * 判据 6 原文：「新增用例断言 zh/en 标题集合一致 且 文中引用的真源路径真实存在；
 * 删掉一节或写错一个引用路径 ⇒ 必红；恢复后绿」。
 *
 * 三条断言（全部打在**源文档**上，不是副本、不是渲染产物）：
 *  ① zh/en 的**小节锚点序列**逐字一致 —— 锚点是每节标题下方的 `<!-- sec: <slug> -->`
 *     标记，语言中立（两种语言的标题文本本来就不同，不能直接比标题字符串）。
 *     同时钉住「`## ` 标题数 ≡ 锚点数」与「`### ` 子节数相等」，防止新增一节却漏写锚点。
 *  ② 文档中出现的**仓库相对真源路径**（反引号包裹、带已知扩展名、含 `/` 或为根级 AGENTS.md）
 *     必须实际存在。引用为**文件级路径**（不带行号，避免随代码变动腐烂）；守卫校验路径存在性。
 *     裸文件名（`goal.md`、`kanban.js` …）与数据目录（`.dsh-graph/...`）不是仓库源文件路径，
 *     刻意不纳入（否则会要求 `project.yaml` 这类运行期数据文件存在）。
 *  ③ 打包面 README 的**中英各一处指针**仍在（可发现入口，判据 5）。
 *  ④ 真源引用**不得带位置后缀**（`:123` / `:123-456`）：g-460 att-003（负责人第四轮）起文档只锚定
 *     文件级 —— 位置随代码变动会腐烂、需要人肉同步，故守卫反向判红并点名文件与位置。
 *
 * 反自我满足设计：
 *  - `checkDocs` / `referencedPaths` 是纯函数（文本进、判定出），因此负向对照可以在**内存副本**
 *    上定点破坏后重放检查器，真实文件逐字节不变（hermetic，不污染工作树）；
 *  - 断言「实际校验到的路径数 ≥ 10」与「锚点数 ≥ 10」，防止检查器因正则退化而**空跑变绿**；
 *  - 负向对照覆盖四种破坏：删一节 / 改错一个引用路径 / 删一个子节 / 塞回一处位置后缀 —— 破坏后必须
 *    报出问题，且未破坏的原文重新检查必须回到全绿（判据 6 的「恢复后绿」）。
 *
 * 边界：本文件只读文件、不做任何写入；不改产品代码。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

const repoRoot = join(import.meta.dirname, "../..");
const ZH_DOC = join(repoRoot, "docs/design-philosophy.zh.md");
const EN_DOC = join(repoRoot, "docs/design-philosophy.en.md");
const README = join(repoRoot, "dsh-graph-host/README.md");

const ZH_DOC_REL = "docs/design-philosophy.zh.md";
const EN_DOC_REL = "docs/design-philosophy.en.md";

/** 已知的仓库源文件扩展名（用于识别「真源路径」引用）。 */
// g-462：补入 png/html/svg —— 设计哲学文档新增的图产物引用（`.png` 静态预览 / `.html` 交互版）
// 此前不在白名单里，故「引用一张并不存在的图」不会被这条守卫发现（g-460 遗留覆盖缺口）。
const SOURCE_EXT = ["ts", "md", "js", "sh", "json", "mjs", "yml", "yaml", "png", "html", "svg"] as const;

/**
 * 引号包裹的真源路径。容忍残留的位置后缀（存在性照常校验），残留本身由 `lineSuffixedRefs` 反向判红。
 */
const PATH_REF = new RegExp(
  "`([A-Za-z0-9_][A-Za-z0-9_./-]*\\.(?:" +
    SOURCE_EXT.join("|") +
    "))(?::[0-9]+(?:-[0-9]+)?)?`",
  "g",
);

/**
 * 真源引用里**残留的位置后缀**（`:123` / `:123-456`）。
 * g-460 att-003（负责人第四轮）：文档只锚定**文件级**路径 —— 位置会随代码变动腐烂、需要人肉同步，
 * 故引用一律不带位置；命中即判红并点名「文件 + 位置」。
 */
const LINE_SUFFIX_REF = new RegExp(
  "`([A-Za-z0-9_][A-Za-z0-9_./-]*\\.(?:" +
    SOURCE_EXT.join("|") +
    "))(:[0-9]+(?:-[0-9]+)?)`",
  "g",
);

/** 文档中带位置后缀的真源引用；返回 `路径:位置` 原文（空数组＝全部为文件级）。 */
export function lineSuffixedRefs(text: string): string[] {
  return [...text.matchAll(LINE_SUFFIX_REF)].map((m) => `${m[1]}${m[2]}`);
}

/** 小节锚点；语言中立，故 zh/en 必须逐字一致。 */
const SECTION_ANCHOR = /<!--\s*sec:\s*([A-Za-z0-9._-]+)\s*-->/g;

/** 锚点序列（保持出现顺序）。 */
export function sectionAnchors(text: string): string[] {
  return [...text.matchAll(SECTION_ANCHOR)].map((m) => m[1]!);
}

/** 各级标题数量（只数行首的 `## ` / `### `）。 */
function headingCount(text: string, level: 2 | 3): number {
  const marker = "#".repeat(level) + " ";
  return text.split("\n").filter((line) => line.startsWith(marker)).length;
}

/**
 * 文档中引用的**仓库相对真源路径**（去重、排序）。
 * 只接受含 `/` 的路径，外加根级 `AGENTS.md`；`.dsh-graph/...` 等数据目录与裸文件名不纳入。
 */
export function referencedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(PATH_REF)) {
    const p = m[1]!;
    if (p.startsWith(".")) continue; // 运行期数据目录，不是仓库源文件
    if (!p.includes("/") && p !== "AGENTS.md") continue; // 裸文件名/占位名不校验
    found.add(p);
  }
  return [...found].sort();
}

/**
 * g-462 补齐 g-460 遗留缺口：文档里以 **Markdown 图片/链接** 形式内联的图产物引用（相对 `docs/` 解析）。
 * 设计哲学文档的 `.png` 静态预览与 `.html` 交互版正是这种形态（不是反引号真源路径），
 * 旧守卫的 `SOURCE_EXT` 白名单根本看不到它们 ⇒ 引用一张并不存在的图也能全绿。
 * 这里把「资源类扩展名」的 Markdown 目标也纳入存在性校验。
 */
const DOC_ASSET_EXT = ["png", "html", "svg", "jpg", "jpeg", "webp", "gif"] as const;
const MD_LINK = /!?\[[^\]]*\]\(([^)\s]+)\)/g;
const DOC_ASSET_RE = new RegExp("\\.(?:" + DOC_ASSET_EXT.join("|") + ")$");

/** Markdown 引用中指向**仓库内**的资源文件（相对文档所在目录 `docs/`），解析为仓库相对路径。 */
export function referencedDocAssets(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(MD_LINK)) {
    const target = m[1]!;
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(target) || target.startsWith("#") || target.startsWith("/")) continue;
    const bare = target.split("#")[0]!.split("?")[0]!;
    if (!DOC_ASSET_RE.test(bare)) continue;
    found.add(posix.normalize(posix.join("docs", bare)));
  }
  return [...found].sort();
}

export interface DocProblems {
  problems: string[];
  pathCount: number;
  anchorCount: number;
  assetCount: number;
}

/**
 * 纯函数守卫：zh/en 锚点序列一致 + 标题/锚点数自洽 + 引用路径存在。
 * `exists` 可注入，便于负向对照在不触碰文件系统语义的前提下复现。
 */
export function checkDocs(
  zhText: string,
  enText: string,
  exists: (relPath: string) => boolean = (rel) => existsSync(join(repoRoot, rel)),
): DocProblems {
  const problems: string[] = [];
  const zhAnchors = sectionAnchors(zhText);
  const enAnchors = sectionAnchors(enText);

  if (zhAnchors.length !== enAnchors.length) {
    problems.push(
      `锚点数量不一致：${ZH_DOC_REL}=${zhAnchors.length} vs ${EN_DOC_REL}=${enAnchors.length}`,
    );
  }
  const shared = Math.min(zhAnchors.length, enAnchors.length);
  for (let i = 0; i < shared; i++) {
    if (zhAnchors[i] !== enAnchors[i]) {
      problems.push(
        `第 ${i + 1} 个锚点不一致：zh=${zhAnchors[i]} vs en=${enAnchors[i]}（顺序必须相同）`,
      );
    }
  }
  const extraZh = zhAnchors.slice(shared);
  const extraEn = enAnchors.slice(shared);
  if (extraZh.length) problems.push(`${ZH_DOC_REL} 多出锚点：${extraZh.join(", ")}`);
  if (extraEn.length) problems.push(`${EN_DOC_REL} 多出锚点：${extraEn.join(", ")}`);

  for (const [label, text, anchors] of [
    [ZH_DOC_REL, zhText, zhAnchors],
    [EN_DOC_REL, enText, enAnchors],
  ] as const) {
    const h2 = headingCount(text, 2);
    if (h2 !== anchors.length) {
      problems.push(`${label} 的 ## 标题数(${h2}) 与锚点数(${anchors.length}) 不一致——每节必须带 <!-- sec: … -->`);
    }
  }
  const zhH3 = headingCount(zhText, 3);
  const enH3 = headingCount(enText, 3);
  if (zhH3 !== enH3) {
    problems.push(`### 子节数不一致：${ZH_DOC_REL}=${zhH3} vs ${EN_DOC_REL}=${enH3}`);
  }

  const paths = new Set<string>([
    ...referencedPaths(zhText),
    ...referencedPaths(enText),
  ]);
  for (const rel of [...paths].sort()) {
    if (!exists(rel)) problems.push(`引用的真源路径不存在：${rel}`);
  }

  // g-462：文档内联的图产物引用（Markdown 图片/链接，相对 `docs/`）同样必须真实存在。
  const assets = new Set<string>([
    ...referencedDocAssets(zhText),
    ...referencedDocAssets(enText),
  ]);
  for (const rel of [...assets].sort()) {
    if (!exists(rel)) problems.push(`引用的文档资源不存在：${rel}`);
  }

  return { problems, pathCount: paths.size, anchorCount: shared, assetCount: assets.size };
}

function readDoc(file: string, label: string): string {
  assert.ok(existsSync(file), `文档缺失：${label}（g-460 S0 交付物）`);
  return readFileSync(file, "utf8");
}

/** 删掉一个 `## ` 小节（含其标题、锚点与全部 `###` 子节，直到下一个 `## `）。 */
function removeSection(text: string, headingPrefix: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(headingPrefix));
  assert.notEqual(start, -1, `负向对照：找不到小节 ${headingPrefix}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

test("g-460 判据 6①：zh/en 设计哲学文档的小节锚点逐字一致、标题/锚点数自洽", () => {
  const zh = readDoc(ZH_DOC, ZH_DOC_REL);
  const en = readDoc(EN_DOC, EN_DOC_REL);
  const { problems, anchorCount } = checkDocs(zh, en);
  assert.deepEqual(problems, [], `结构守卫必须全绿，实际：\n${problems.join("\n")}`);
  // 防「检查器空转变绿」：锚点必须真的被解析出来。
  assert.ok(anchorCount >= 10, `解析到的锚点过少（${anchorCount}），守卫可能已退化`);
  assert.ok(sectionAnchors(zh).includes("lifecycle"), "缺少 lifecycle 锚点");
  assert.ok(sectionAnchors(en).includes("roadmap"), "缺少 roadmap 锚点");
});

test("g-460 判据 6②：文档引用的真源路径全部真实存在，且覆盖面非空", () => {
  const zh = readDoc(ZH_DOC, ZH_DOC_REL);
  const en = readDoc(EN_DOC, EN_DOC_REL);
  const { problems, pathCount } = checkDocs(zh, en);
  assert.deepEqual(problems, [], `引用路径必须全部存在，实际：\n${problems.join("\n")}`);
  // 防「一条路径都没解析到」的假绿。
  assert.ok(pathCount >= 10, `解析到的真源路径过少（${pathCount}），守卫可能已退化`);
  for (const required of ["core/machine.ts", "core/ops.ts", "core/worktree.ts"]) {
    assert.ok(referencedPaths(zh).includes(required), `zh 文档必须引用 ${required}`);
    assert.ok(referencedPaths(en).includes(required), `en 文档必须引用 ${required}`);
  }
});

test("g-462 补齐 g-460 判据 6③：文档内联的图产物引用（.svg/.html）必须真实存在，缺失即必红", () => {
  const zh = readDoc(ZH_DOC, ZH_DOC_REL);
  const en = readDoc(EN_DOC, EN_DOC_REL);
  const { problems, assetCount } = checkDocs(zh, en);
  assert.deepEqual(problems, [], `基线必须为绿，实际：\n${problems.join("\n")}`);

  // 防「资源引用一条都没解析到」的假绿：两张图各有明/暗两个 chrome-free SVG 规范导出，
  // 外加交互版 HTML（.html），zh/en 各 6 条、并集 6 条。
  const expected = [
    "docs/assets/design-philosophy.lifecycle.light.svg",
    "docs/assets/design-philosophy.lifecycle.dark.svg",
    "docs/assets/design-philosophy.workflow.light.svg",
    "docs/assets/design-philosophy.workflow.dark.svg",
    "dsh-graph-host/diagrams/design-philosophy.lifecycle.html",
    "dsh-graph-host/diagrams/design-philosophy.workflow.html",
  ];
  assert.ok(assetCount >= 6, `解析到的文档资源过少（${assetCount}），守卫可能已退化`);
  for (const rel of expected) {
    assert.ok(referencedDocAssets(zh).includes(rel), `zh 文档必须内联引用 ${rel}`);
    assert.ok(referencedDocAssets(en).includes(rel), `en 文档必须内联引用 ${rel}`);
    assert.ok(existsSync(join(repoRoot, rel)), `图产物必须随仓存在：${rel}`);
  }

  // 负向对照：把图产物「当作不存在」（注入 exists 只对这些资源返回 false）⇒ 守卫必须点名该资源；
  // 恢复真实 exists 后必须重新全绿。这是 g-460 旧守卫看不到的那一族（扩展名白名单此前无 svg/html）。
  const missing = new Set(expected);
  const gone = checkDocs(zh, en, (rel) => (missing.has(rel) ? false : existsSync(join(repoRoot, rel))));
  for (const rel of expected) {
    assert.ok(
      gone.problems.includes(`引用的文档资源不存在：${rel}`),
      `删/改名图产物后必须点名 ${rel}，实际：${JSON.stringify(gone.problems)}`,
    );
  }
  assert.deepEqual(checkDocs(zh, en).problems, [], "恢复图产物后必须重新全绿");
});

test("g-460 判据 6④：真源引用一律文件级——残留位置后缀（`:行号`）必红；塞回一处 ⇒ 红，移除 ⇒ 绿", () => {
  const zh = readDoc(ZH_DOC, ZH_DOC_REL);
  const en = readDoc(EN_DOC, EN_DOC_REL);
  const readme = readFileSync(README, "utf8");

  // 基线：三份用户可见文本都不带位置后缀，且路径引用面非空（防检查器正则退化后空跑变绿）。
  assert.deepEqual(lineSuffixedRefs(zh), [], `${ZH_DOC_REL} 的真源引用必须只到文件级`);
  assert.deepEqual(lineSuffixedRefs(en), [], `${EN_DOC_REL} 的真源引用必须只到文件级`);
  assert.deepEqual(lineSuffixedRefs(readme), [], "README 的真源引用必须只到文件级");
  assert.ok(referencedPaths(zh).length >= 10, `zh 解析到的真源路径过少（${referencedPaths(zh).length}）`);
  assert.ok(referencedPaths(en).length >= 10, `en 解析到的真源路径过少（${referencedPaths(en).length}）`);

  // 负向对照（内存副本，真实文件逐字节不变）：塞回一处位置后缀 ⇒ 必红并点名「文件 + 位置」；
  // 移除后同一检查器必须重新全绿。
  const injected = zh.replace("`core/machine.ts`", "`core/machine.ts:123`");
  assert.notEqual(injected, zh, "负向对照未能命中目标引用 `core/machine.ts`");
  assert.deepEqual(
    lineSuffixedRefs(injected),
    ["core/machine.ts:123"],
    "塞回位置后缀必须被判红并点名文件与位置",
  );
  assert.deepEqual(lineSuffixedRefs(zh), [], "移除位置后缀后必须重新全绿");
  // `:起-止` 形态同样被拦。
  assert.deepEqual(
    lineSuffixedRefs(zh.replace("`core/ops.ts`", "`core/ops.ts:100-120`")),
    ["core/ops.ts:100-120"],
    "`:起-止` 形态必须同样被判红",
  );
});

test("g-460 判据 6（负向对照）：删一节 / 删子节 / 写错引用路径 ⇒ 必红；恢复后绿", () => {
  const zh = readDoc(ZH_DOC, ZH_DOC_REL);
  const en = readDoc(EN_DOC, EN_DOC_REL);
  const baseline = checkDocs(zh, en);
  assert.deepEqual(baseline.problems, [], "基线必须为绿");

  // ① 删掉 zh 的一整节（标题 + 锚点 + 子节）⇒ 锚点序列漂移。
  const removedSection = removeSection(zh, "## 6. 独立复核");
  const afterRemove = checkDocs(removedSection, en);
  assert.ok(
    afterRemove.problems.some((p) => p.includes("锚点")),
    `删一节后必须报锚点问题，实际：${JSON.stringify(afterRemove.problems)}`,
  );

  // ② 删掉一个 `###` 子节并同步其锚点行 ⇒ 子节数不一致。
  const removedSub = zh.replace("### 2.4 状态是投影，不是真源\n", "");
  assert.notEqual(removedSub, zh, "负向对照 ② 未能命中目标子节标题");
  const afterSub = checkDocs(removedSub, en);
  assert.ok(
    afterSub.problems.some((p) => p.includes("### 子节数不一致")),
    `删子节后必须报子节数问题，实际：${JSON.stringify(afterSub.problems)}`,
  );

  // ③ 写错一个引用路径 ⇒ 点名该路径（引用已是文件级，故破坏点也从文件级形态取）。
  const brokenPath = zh.replace("`core/machine.ts`", "`core/machines.ts`");
  assert.notEqual(brokenPath, zh, "负向对照 ③ 未能命中目标引用");
  const afterPath = checkDocs(brokenPath, en);
  assert.ok(
    afterPath.problems.includes("引用的真源路径不存在：core/machines.ts"),
    `写错路径后必须点名，实际：${JSON.stringify(afterPath.problems)}`,
  );

  // ④ 恢复后绿（同一检查器、同一原文）。
  const restored = checkDocs(zh, en);
  assert.deepEqual(restored.problems, [], "恢复原文后必须重新全绿");
});

test("g-460 判据 5：打包面 README 保留中英各一处指向设计哲学文档的指针", () => {
  const readme = readFileSync(README, "utf8");
  const zhPointer = "docs/design-philosophy.zh.md";
  const enPointer = "docs/design-philosophy.en.md";
  assert.ok(readme.includes(zhPointer), `README 缺少中文指针 → ${zhPointer}`);
  assert.ok(readme.includes(enPointer), `README 缺少英文指针 → ${enPointer}`);
  // README 进打包产物 ⇒ 指针必须是可在 GitHub 打开的绝对链接（相对路径在 tarball 内会断）。
  for (const pointer of [zhPointer, enPointer]) {
    assert.ok(
      readme.includes(`https://github.com/miuzel/dsh-graph/blob/main/${pointer}`),
      `README 指针必须是 GitHub 绝对链接：${pointer}`,
    );
  }
});
