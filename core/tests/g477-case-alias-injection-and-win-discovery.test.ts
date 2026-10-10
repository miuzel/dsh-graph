/**
 * core/tests/g477-case-alias-injection-and-win-discovery.test.ts
 *
 * g-477：**Windows 真机 Round A 才暴露的两处缺陷**的机器化守卫。
 *
 * 发现 1（产品缺陷，`core/platform.ts`）：`resolveExistingEntry` 只处理 `caseInsensitiveVolumeOverride === true`，
 *   对 `=== false`（注入「大小写敏感卷」）**没有分支** ⇒ 落到真实 FS 的 `lstatSync` 探测；在 NTFS/APFS 等
 *   真实不敏感卷上该探测**大小写不敏感地成功** ⇒ 仍返回 `aliased: true` —— **注入语义失效**。
 *   Linux 之所以「绿」是因为 ext4 上 `lstat('a.txt')` 恰好 ENOENT（用的是真实卷语义，不是注入语义）。
 *
 *   为什么必须靠**纯函数 + 穷尽决策表**而不是「跑一遍探针」：在 ext4 上新旧实现在探针形态下**返回同一个
 *   null**（无可区分性）⇒ 只有把 `present`（真实 FS 是否命中）从判定中**显式抽出来**，才能在 Linux 上把
 *   「注入敏感 + 真实不敏感」这一 Windows 真机形态钉死。故本套件：
 *     A. 对纯函数 `decideCaseAliasEntry` 做**穷尽三态决策表**（含 Windows 真机形态）；
 *     B. 薄 FS 包装 `resolveExistingEntry` 与纯函数**逐字一致**（生产路径零行为变更），注入三态下**不咨询
 *        真实 FS**（在「别名会命中」的真实卷形态下也必须返回 null）；
 *     C. **负向对照**：旧实现（`false` 无分支）在同一决策表上必然给出 `aliased: true` ⇒ 回退修复即红；
 *        另有**结构守卫**钉住「`false` 短路存在」与「`lstat` 只在 `override === null` 分支」；
 *     D. 旁证：`core/ops.ts` 附件链路在注入敏感卷时整体结论自洽（不得把 `a.txt` 别名到 `A.txt`）。
 *
 * 平台边界（如实标注）：本套件在 Linux/WSL2 的 **ext4** 上运行；真实不敏感卷（NTFS/APFS）行为全部由
 *   **纯函数输入**与**注入**复现，**原生 Windows / macOS 真机结论仍待负责人重跑 Round A 回传**
 *   （见 `docs/platform-gate.md` §3.5 与 §7 预留位）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  attachmentsDir,
  init,
  isCaseInsensitiveVolumeInjected,
  listAttachments,
  resolveExistingEntry,
  storeAttachment,
  withCaseInsensitiveVolumeForTesting,
} from "../ops.ts";
import { decideCaseAliasEntry, foldEntryName } from "../platform.ts";
import {
  HARNESS_COMPOSITION_HINT,
  collectCompositionFiles,
  discoverDshRoots,
  dshRootCandidates,
  npmGlobalRootInvocation,
  npmGlobalRootInvocationProblems,
  queryNpmGlobalRoot,
} from "../../scripts/win-smoke-test.mjs";

const repoRoot = join(import.meta.dirname, "..", "..");

type Entry = { actual: string; aliased: boolean } | null;

function tmpRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  init(dir);
  return dir;
}

/** 真实卷是否大小写不敏感：同目录里 `A.txt` 存在时 `lstat('a.txt')` 是否成功。 */
function realVolumeInsensitive(dir: string): boolean {
  try {
    lstatSync(join(dir, "a.txt"));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// A. 纯决策表：注入三态 × present × 拼写 —— 穷尽
// ---------------------------------------------------------------------------

interface Case {
  name: string;
  entries: string[];
  requested: string;
  present: boolean;
  override: boolean | null;
  want: Entry;
}

const DECISION_TABLE: Case[] = [
  // —— 注入「敏感卷」（override=false）：只认逐字节同名；present 对判定**无影响** ——
  {
    name: "false ∧ present=true ∧ 拼写不同 ⇒ null（**Windows 真机形态**）",
    entries: ["A.txt"], requested: "a.txt", present: true, override: false, want: null,
  },
  {
    name: "false ∧ present=false ∧ 拼写不同 ⇒ null",
    entries: ["A.txt"], requested: "a.txt", present: false, override: false, want: null,
  },
  {
    name: "false ∧ present=true ∧ 逐字节同名 ⇒ 精确名",
    entries: ["a.txt"], requested: "a.txt", present: true, override: false,
    want: { actual: "a.txt", aliased: false },
  },
  {
    name: "false ∧ present=true ∧ 无折叠条目 ⇒ null（不得回落到 lstat 的 present）",
    entries: ["B.txt"], requested: "a.txt", present: true, override: false, want: null,
  },
  {
    name: "false ∧ present=false ∧ 无折叠条目 ⇒ null",
    entries: ["B.txt"], requested: "a.txt", present: false, override: false, want: null,
  },
  {
    name: "false ∧ 空目录 ⇒ null",
    entries: [], requested: "a.txt", present: false, override: false, want: null,
  },
  // —— 注入「不敏感卷」（override=true）：折叠即别名命中，present 无关 ——
  {
    name: "true ∧ 拼写不同 ⇒ 别名命中（present=false 也照样命中）",
    entries: ["A.txt"], requested: "a.txt", present: false, override: true,
    want: { actual: "A.txt", aliased: true },
  },
  {
    name: "true ∧ 拼写不同 ∧ present=true ⇒ 别名命中",
    entries: ["A.txt"], requested: "a.txt", present: true, override: true,
    want: { actual: "A.txt", aliased: true },
  },
  {
    name: "true ∧ 无折叠条目 ⇒ null",
    entries: ["B.txt"], requested: "a.txt", present: true, override: true, want: null,
  },
  {
    name: "true ∧ 逐字节同名 ⇒ 精确名（精确名优先，绝不被判为别名）",
    entries: ["a.txt", "A.txt"], requested: "a.txt", present: true, override: true,
    want: { actual: "a.txt", aliased: false },
  },
  // —— 生产 / 未注入（override=null）：**唯一**咨询真实 FS 的一态 ——
  {
    name: "null ∧ present=false ∧ 拼写不同 ⇒ null（真实敏感卷）",
    entries: ["A.txt"], requested: "a.txt", present: false, override: null, want: null,
  },
  {
    name: "null ∧ present=true ∧ 拼写不同 ⇒ 别名命中（真实不敏感卷；**不得被 false 规则吞掉**）",
    entries: ["A.txt"], requested: "a.txt", present: true, override: null,
    want: { actual: "A.txt", aliased: true },
  },
  {
    name: "null ∧ present=true ∧ 逐字节同名 ⇒ 精确名",
    entries: ["a.txt"], requested: "a.txt", present: true, override: null,
    want: { actual: "a.txt", aliased: false },
  },
  {
    name: "null ∧ present=true ∧ 无折叠条目 ⇒ 请求名（真实卷认它存在，但不是折叠来的）",
    entries: ["B.txt"], requested: "a.txt", present: true, override: null,
    want: { actual: "a.txt", aliased: false },
  },
  {
    name: "null ∧ present=false ∧ 无折叠条目 ⇒ null",
    entries: ["B.txt"], requested: "a.txt", present: false, override: null, want: null,
  },
  // —— Unicode 规范化（macOS 磁盘名常为 NFD，请求名常为 NFC）也走同一三态 ——
  {
    name: "null ∧ NFD 请求命中 NFC 条目 ∧ present=true ⇒ 别名命中",
    entries: ["caf\u00e9.md"], requested: "cafe\u0301.md", present: true, override: null,
    want: { actual: "caf\u00e9.md", aliased: true },
  },
  {
    name: "false ∧ NFD 请求 + NFC 条目 ⇒ null（注入敏感卷下不得靠折叠命中）",
    entries: ["caf\u00e9.md"], requested: "cafe\u0301.md", present: true, override: false, want: null,
  },
];

test("g477 ②：纯决策表穷尽三态（含 Windows 真机形态 false∧present∧拼写不同 ⇒ null）", () => {
  for (const c of DECISION_TABLE) {
    const got = decideCaseAliasEntry(c.entries, c.requested, c.present, c.override);
    assert.deepEqual(got, c.want, `决策表用例判红：${c.name}（实际 ${JSON.stringify(got)}）`);
  }
  // 判别力自证：表中必须同时存在「两侧都非平凡」的用例 —— 否则表可能整体退化为恒真
  assert.ok(DECISION_TABLE.some((c) => c.want === null && c.override === false && c.present === true),
    "表里必须保留 Windows 真机形态（false ∧ present=true ∧ 拼写不同 ⇒ null）");
  assert.ok(DECISION_TABLE.some((c) => c.want?.aliased === true && c.override === null && c.present === true),
    "表里必须保留真实不敏感卷形态（null ∧ present=true ∧ 拼写不同 ⇒ 别名命中）");
});

test("g477 ②：决策表覆盖三态 × present × 折叠命中性的全部组合（穷尽性自证）", () => {
  const seen = new Set(DECISION_TABLE.map((c) => `${c.override}|${c.present}|${c.entries.includes(c.requested)}|${c.want === null ? "null" : c.want.aliased}`));
  // 2（present）× 3（override）= 6 个「present × override」格必须全部出现
  for (const present of [true, false]) {
    for (const override of [false, true, null]) {
      assert.ok([...seen].some((k) => k.startsWith(`${override}|${present}|`)),
        `决策表缺格：override=${override} ∧ present=${present}`);
    }
  }
  // 别名命中 / 精确名 / null 三种结局都必须出现
  for (const outcome of ["null", "true", "false"]) {
    assert.ok([...seen].some((k) => k.endsWith(`|${outcome}`)), `决策表缺结局：${outcome}`);
  }
});

test("g477 ②：输入数组不被改动；多折叠条目按名排序取首个（判定确定性）", () => {
  const entries = ["b.txt", "A.TXT", "a.txt"];
  const snapshot = [...entries];
  assert.deepEqual(decideCaseAliasEntry(entries, "a.txt", true, true), { actual: "a.txt", aliased: false });
  assert.deepEqual(entries, snapshot, "纯函数不得就地排序/改动调用方数组");
  // 无逐字节同名、两个条目折叠同名 ⇒ 排序后取首个（不依赖调用方传入顺序）
  assert.deepEqual(decideCaseAliasEntry(["b.TXT", "B.txt"], "b.txt", false, true), { actual: "B.txt", aliased: true });
  assert.deepEqual(decideCaseAliasEntry(["B.txt", "b.TXT"], "b.txt", false, true), { actual: "B.txt", aliased: true });
  assert.deepEqual(foldEntryName("A\u0301.txt"), foldEntryName("\u00c1.txt"), "折叠键须做 NFC 规范化");
});

// ---------------------------------------------------------------------------
// B. 薄 FS 包装：生产与纯函数逐字一致；注入三态不咨询真实 FS
// ---------------------------------------------------------------------------

test("g477 ①：生产路径（override=null）与纯函数逐字一致 —— 零行为变更（真实卷无关）", () => {
  const dir = mkdtempSync(join(tmpdir(), "g477-prod-"));
  try {
    writeFileSync(join(dir, "A.txt"), "1", "utf8");
    writeFileSync(join(dir, "b.txt"), "2", "utf8");
    // 独立采集 present（与实现同口径），据此推出期望值 ⇒ 断言在敏感卷与不敏感卷上同结论
    const present = (() => { try { lstatSync(join(dir, "a.txt")); return true; } catch { return false; } })();
    assert.deepEqual(
      resolveExistingEntry(dir, "a.txt"),
      decideCaseAliasEntry(["A.txt", "b.txt"], "a.txt", present, null),
      "生产路径必须逐字等价于纯函数在 present（真实 FS 命中）下的判定",
    );
    // 逐字节同名永远是精确名（真实卷无关）
    assert.deepEqual(resolveExistingEntry(dir, "b.txt"), { actual: "b.txt", aliased: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g477 ①：注入三态不咨询真实 FS —— 敏感注入在「别名会命中」的卷形态下一律 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "g477-inject-"));
  try {
    writeFileSync(join(dir, "A.txt"), "1", "utf8");
    const insensitive = realVolumeInsensitive(dir); // 真机 NTFS/APFS 上为 true，ext4 上为 false
    // 不敏感注入：折叠即别名（与真实卷无关，跨平台同结论）
    assert.deepEqual(
      withCaseInsensitiveVolumeForTesting(true, () => resolveExistingEntry(dir, "a.txt")),
      { actual: "A.txt", aliased: true },
    );
    // **敏感注入：无论真实卷如何，都必须 null**（修复前在 insensitive=true 的卷上会返回 A.txt）
    assert.equal(
      withCaseInsensitiveVolumeForTesting(false, () => resolveExistingEntry(dir, "a.txt")),
      null,
      `注入敏感卷时必须 null（真实卷 insensitive=${insensitive}）——这正是 Windows 真机缺陷形态`,
    );
    // 敏感注入下逐字节同名照常是精确名
    assert.deepEqual(
      withCaseInsensitiveVolumeForTesting(false, () => resolveExistingEntry(dir, "A.txt")),
      { actual: "A.txt", aliased: false },
    );
    // 未注入（生产）时仍然咨询真实卷 —— 修复不得把生产路径也短路成 null
    const prod = resolveExistingEntry(dir, "a.txt");
    assert.deepEqual(prod, insensitive ? { actual: "A.txt", aliased: true } : null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C. 负向对照：旧实现（false 无分支）在同一决策表上必红 + 结构守卫
// ---------------------------------------------------------------------------

/**
 * 修复前语义的**逐字复刻**（`false` 无分支 ⇒ 落到真实 FS 探测）：仅用于负向对照。
 * 与 g-364 的对照手法一致：把旧语义钉在同一组输入上，证明新用例**真的在守 false 分支**。
 */
function legacyDecideCaseAliasEntry(
  entries: readonly string[],
  requested: string,
  present: boolean,
  override: boolean | null,
): Entry {
  const sorted = [...entries].sort();
  if (sorted.includes(requested)) return { actual: requested, aliased: false };
  const folded = sorted.find((e) => foldEntryName(e) === foldEntryName(requested));
  if (override === true) return folded ? { actual: folded, aliased: true } : null;
  if (!present) return null;
  return folded ? { actual: folded, aliased: true } : { actual: requested, aliased: false };
}

test("g477 ③：负向对照 —— 旧实现（false 无分支）必让决策表首条判红", () => {
  const winForm: Case | undefined = DECISION_TABLE.find(
    (c) => c.override === false && c.present === true && !c.entries.includes(c.requested),
  );
  assert.ok(winForm, "决策表必须含 Windows 真机形态用例");
  // 旧实现在该输入上把注入「敏感卷」重新别名 ⇒ 与期望的 null 相反
  const legacy = legacyDecideCaseAliasEntry(winForm!.entries, winForm!.requested, winForm!.present, winForm!.override);
  assert.deepEqual(legacy, { actual: winForm!.entries[0], aliased: true },
    "旧实现必须复现 Windows 真机缺陷（否则本对照没有鉴别力）");
  assert.equal(decideCaseAliasEntry(winForm!.entries, winForm!.requested, winForm!.present, winForm!.override), null,
    "新实现必须返回 null（回退旧实现 ⇒ 该断言判红）");
  // 旧实现在生产（null）一态上与新实现一致 —— 证明差异**只**在注入 false（零生产行为变更）
  for (const present of [true, false]) {
    assert.deepEqual(
      legacyDecideCaseAliasEntry(["A.txt"], "a.txt", present, null),
      decideCaseAliasEntry(["A.txt"], "a.txt", present, null),
    );
  }
});

test("g477 ③：结构守卫 —— false 短路必须存在，且 lstat 真实探测只在 override===null 分支", () => {
  const src = readFileSync(join(repoRoot, "core", "platform.ts"), "utf8");
  const pureStart = src.indexOf("export function decideCaseAliasEntry");
  const wrapperStart = src.indexOf("export function resolveExistingEntry");
  assert.ok(pureStart > 0 && wrapperStart > pureStart, "platform.ts 必须同时含纯函数与薄包装");
  const pure = src.slice(pureStart, wrapperStart);
  assert.match(pure, /if \(override === false\) return null;/, "纯函数必须保留 `false` 短路（回退即判红）");
  const wrapper = src.slice(wrapperStart);
  const guard = wrapper.indexOf("caseInsensitiveVolumeOverride === null");
  const probe = wrapper.indexOf("lstatSync(join(parentDir, requested))");
  assert.ok(guard > 0 && probe > 0, "包装里必须同时有 null 守卫与 lstat 探测");
  assert.ok(guard < probe, "lstat 真实探测必须**在** override===null 守卫之内（注入三态不得咨询真实 FS）");
});

// ---------------------------------------------------------------------------
// D. 旁证：附件链路在注入敏感卷时整体自洽
// ---------------------------------------------------------------------------

test("g477 ③：旁证 —— 注入敏感卷时附件链路不把 a.txt 别名到 A.txt（不敏感注入回归不变）", () => {
  const root = tmpRoot("g477-att-");
  try {
    // 不敏感注入：g-364 既有语义（同内容幂等复用磁盘实际名）—— 本修复不得改变它
    withCaseInsensitiveVolumeForTesting(true, () => {
      assert.equal(storeAttachment(root, { name: "A.txt", content: "1", actor: "t" }), "A.txt");
      assert.equal(storeAttachment(root, { name: "a.txt", content: "1", actor: "t" }), "A.txt");
    });
    assert.deepEqual(listAttachments(root), ["A.txt"]);
    // 敏感注入：`a.txt` 是**另一个**文件（真机 NTFS 上修复前会别名回 A.txt）
    const realInsensitive = realVolumeInsensitive(attachmentsDir(root));
    const stored = withCaseInsensitiveVolumeForTesting(false, () => {
      assert.equal(isCaseInsensitiveVolumeInjected(), false, "访问器只回答「是否注入不敏感」（注入敏感时为 false）");
      return storeAttachment(root, { name: "a.txt", content: "2", actor: "t" });
    });
    assert.notEqual(stored, "A.txt", "注入敏感卷时不得把 a.txt 别名到 A.txt（Windows 真机形态）");
    assert.equal(readFileSync(join(attachmentsDir(root), "A.txt"), "utf8"), "1", "既有 A.txt 不得被覆盖");
    const after = listAttachments(root);
    assert.ok(after.some((n) => n !== "A.txt" && readFileSync(join(attachmentsDir(root), n), "utf8") === "2"),
      "内容 '2' 必须落在独立条目上（别名到 A.txt 会被覆盖 ⇒ 判红）");
    if (!realInsensitive) {
      // 真实敏感卷（ext4）：注入语义与真实卷一致 ⇒ 就是请求拼写本身
      assert.equal(stored, "a.txt");
      assert.deepEqual(after.sort(), ["A.txt", "a.txt"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E. 发现 2（门禁缺陷）：H1/H2 的 DSH 组合声明发现在 Windows 形态下可用
//    —— 命令构造跨平台 + 候选面补齐 + WARN 文案（注入 env/execPath/spawnSync 做离线夹具）
// ---------------------------------------------------------------------------

/** 伪造一个「含 @deepseek-ai/dsh + presets/*.patch.yml」的安装树。 */
function mkDshTree(dir: string, preset: string): void {
  const pkg = join(dir, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(join(pkg, "presets"), { recursive: true });
  writeFileSync(join(pkg, "presets", preset), "plugins:\n  '@deepseek-ai/dsh-tool-bash': {}\n", "utf8");
}

test("g477 ④：npm 回退命令构造在 Windows 上走 npm.cmd + shell（不再裸 spawn npm）", () => {
  const execPath = join("/fake", "nodejs", "node.exe");
  const win = npmGlobalRootInvocation({ platform: "win32", execPath });
  assert.equal(win.file, join("/fake", "nodejs", "npm.cmd"), "必须指向与 node 同目录的 npm.cmd");
  assert.equal(win.shell, true, "Windows 上 .cmd 包装必须经 shell 启动");
  assert.equal(win.commandLine, `${win.file} root -g`, "shell 形态只传完整命令行字符串（DEP0190）");
  assert.deepEqual(npmGlobalRootInvocationProblems(win, "win32"), []);
  const posix = npmGlobalRootInvocation({ platform: "linux", execPath: "/usr/bin/node" });
  assert.equal(posix.file, "npm");
  assert.equal(posix.shell, false);
  assert.deepEqual(posix.args, ["root", "-g"]);
  assert.deepEqual(npmGlobalRootInvocationProblems(posix, "linux"), []);
  // 形状判定本身不得恒真：POSIX 上不该经 shell、Windows 上不该裸 npm
  assert.ok(npmGlobalRootInvocationProblems({ ...posix, shell: true }, "linux").length > 0);
});

test("g477 ④（负向对照）：裸 `spawnSync(\"npm\")` 形态在 win32 上被拒且**不启动进程**", () => {
  const bare = { file: "npm", args: ["root", "-g"], shell: false, commandLine: "npm root -g" };
  assert.ok(npmGlobalRootInvocationProblems(bare, "win32").length > 0,
    "旧形态（裸 npm + shell:false）在 Windows 上必须被判为不可用 —— 否则该守卫没有鉴别力");
  const calls: unknown[] = [];
  const root = queryNpmGlobalRoot({
    platform: "win32", invocation: bare,
    spawnSync: (...args: unknown[]) => { calls.push(args); return { status: 0, stdout: "/nope\n" }; },
  });
  assert.equal(root, null);
  assert.equal(calls.length, 0, "不可用形态必须 fail-closed：连进程都不许启动");
});

test("g477 ④：候选面补齐 %APPDATA%\\npm\\node_modules / _npx\\**\\node_modules / ~/.dsh/profiles/**（夹具）", () => {
  const tree = mkdtempSync(join(tmpdir(), "g477-disc-"));
  try {
    const appData = join(tree, "AppData", "Roaming");
    const localAppData = join(tree, "AppData", "Local");
    const npxBase = join(localAppData, "npm-cache", "_npx");
    const home = join(tree, "home");
    const repo = join(tree, "repo");
    mkDshTree(join(appData, "npm"), "appdata.patch.yml");
    mkDshTree(join(npxBase, "abc123"), "npx.patch.yml");
    mkDshTree(join(home, ".dsh", "profiles", "win-smoke"), "profile.patch.yml");
    mkDshTree(join(tree, "npm-global"), "npm-global.patch.yml");
    const env = { APPDATA: appData, LOCALAPPDATA: localAppData, USERPROFILE: home, HOME: home };
    const base = {
      env, platform: "win32", repo, cwd: repo,
      execPath: join(tree, "nodejs", "node.exe"), spawnSync: () => ({ status: 1, stdout: "" }),
    };
    const want = [
      join(appData, "npm", "node_modules"),
      join(npxBase, "abc123", "node_modules"),
      join(home, ".dsh", "profiles", "win-smoke", "node_modules"),
    ].map((p) => resolve(p));
    const found = discoverDshRoots(repo, [], base);
    for (const w of want) assert.ok(found.includes(w), `候选面必须命中：${w}（实际 ${JSON.stringify(found)}）`);
    assert.deepEqual(dshRootCandidates(base).filter((p) => want.includes(p)).length, want.length);
    const files = collectCompositionFiles(found).map((f) => f.path);
    for (const preset of ["appdata.patch.yml", "npx.patch.yml", "profile.patch.yml"]) {
      assert.ok(files.some((p) => p.endsWith(`presets/${preset}`)), `必须真的扫出 ${preset}`);
    }
    // 显式指定（DSH_GATE_DSH_ROOT）仍最优先且不依赖任何通配枚举
    const explicit = discoverDshRoots(repo, [], { ...base, env: { ...env, DSH_GATE_DSH_ROOT: join(tree, "npm-global") } });
    assert.ok(explicit.includes(resolve(join(tree, "npm-global"))));
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("g477 ④：npm root -g 回退被真正消费（win32 经单条 shell 命令行，Windows 形态可跑）", () => {
  const tree = mkdtempSync(join(tmpdir(), "g477-npmroot-"));
  try {
    const npmRoot = join(tree, "npm-global");
    mkDshTree(npmRoot, "npm-global.patch.yml");
    const calls: Array<{ cmd: unknown; opts: Record<string, unknown> | undefined }> = [];
    const found = discoverDshRoots(join(tree, "repo"), [], {
      env: { USERPROFILE: join(tree, "home"), HOME: join(tree, "home") },
      platform: "win32", execPath: join(tree, "nodejs", "node.exe"),
      spawnSync: (cmd: unknown, opts: Record<string, unknown>) => {
        calls.push({ cmd, opts });
        return { status: 0, stdout: `${npmRoot}\n` };
      },
    });
    assert.ok(found.includes(resolve(npmRoot)), "回退结果必须进入候选根（Windows 上旧实现恒失效）");
    assert.ok(collectCompositionFiles(found).some((f) => f.path.endsWith("presets/npm-global.patch.yml")));
    assert.equal(calls.length, 1);
    assert.equal(typeof calls[0].cmd, "string", "shell 形态必须传单条命令行字符串（不得同时传 args 数组）");
    assert.match(String(calls[0].cmd), /npm\.cmd/);
    assert.equal(calls[0].opts?.shell, true);
    assert.equal(calls[0].opts?.args, undefined);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("g477 ⑤：WARN 文案给出可直接复制的定位命令（Windows PowerShell + POSIX），仍是单行", () => {
  assert.match(HARNESS_COMPOSITION_HINT, /Get-ChildItem/, "Windows 侧定位命令缺失");
  assert.match(HARNESS_COMPOSITION_HINT, /where\.exe dsh/);
  assert.match(HARNESS_COMPOSITION_HINT, /npm root -g/);
  assert.match(HARNESS_COMPOSITION_HINT, /ls ~\/\.dsh\/profiles/, "POSIX 侧定位命令缺失");
  assert.match(HARNESS_COMPOSITION_HINT, /DSH_GATE_DSH_ROOT/);
  assert.doesNotMatch(HARNESS_COMPOSITION_HINT, /[\r\n]/, "WARN 详情与回传报告按单行渲染，禁止多行");
});
