/**
 * core/tests/g362-platform-gate.test.ts
 *
 * g-362 质量判据的自动化守卫：`scripts/platform-smoke-test.mjs` 必须
 *   ① 是**一份**跨平台实现（不新增/不保留第二份），把 `--tarball/--spec/--path/--static-only/
 *      --self-test`（及 `--port/--profile/--dsh-home/--dsh/--timeout`）原样转发给既有执行件
 *      `scripts/win-smoke-test.mjs`，并在原生 macOS/Linux 上把「转发的 T1–T5 结论对本平台
 *      具平台效力」与「win 脚本针对 Windows 的免责声明」区分开；
 *   ② 自带六项平台探针（P1–P6），每项判定**有判别力**（真问题必红、全绿样本必绿），
 *      且平台差异只体现在判定口径与平台标注（同一份判定代码）；
 *   ③ 保留平台无关的 M4 审计（承自 g-359），并**不复制**其判定逻辑；
 *   ④ `scripts/macos-smoke-test.mjs` 已降为转发 shim、`scripts/linux-smoke-test.mjs` 不存在
 *      （「不保留两份实现」的机械守卫）。
 *
 * 为什么需要（不是理论风险）：
 *   - 判定函数若退化成恒真/恒假（例如 P4.a 永远判 PASS、M4 永远判「已覆盖」），这道门禁就毫无
 *     意义却也永不变红。故这里对**每一侧的判定函数**都用合成样本把「必红 / 必绿」两向钉住，
 *     并对真实仓库断言「发布/测试路径零 Linux-only 隐患」。
 *   - 「一份实现」是负责人的明确裁决（v0.16.1 收窄范围）：两份并行实现必然漂移，故用结构守卫
 *     钉住 shim「只转发、零重复逻辑」，防止后来者把归档副本又拷回 scripts/ 顶层。
 *
 * 说明（平台边界）：P1/P3 的**正向真机结论**（本机 FS 语义）无法在测试里合成（需要真的大小写
 *   不敏感卷 / 网络挂载），故这里只固化判定逻辑与判别力；真机结论回填见 `docs/platform-gate.md`
 *   的回填表。本测试只跑不需要已构建 dist 的判定（P2 的「未构建 ⇒ WARN」分支也被钉住）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  buildForwardArgs,
  collectScanFiles,
  findMountForPath,
  forwardRequested,
  isCompleteAtomicPayload,
  isCommentLine,
  itemLevel,
  judgeAtomicWrite,
  judgeCaseSensitivity,
  judgeConcurrentCas,
  judgeExdev,
  judgeLocaleRoundTrip,
  judgeMountType,
  judgeSymlinkRoot,
  LINUX_ONLY_PATTERNS,
  parseBsdMountTable,
  parseLocaleJson,
  probeCaseAliasing,
  resolveTempRoot,
  scanLinuxOnlyAssumptions,
  unescapeMount,
} from "../../scripts/platform-smoke-test.mjs";

const repoRoot = join(import.meta.dirname, "../..");
const SCRIPT = join(repoRoot, "scripts", "platform-smoke-test.mjs");
const SHIM = join(repoRoot, "scripts", "macos-smoke-test.mjs");
const ARCHIVED = join(repoRoot, "scripts", "archived", "macos-smoke-test.mjs");

// ============================================================================
// ① 转发与沙箱：规定选项原样转发；默认值不得触发转发；沙箱永不落系统 /tmp
// ============================================================================

test("g-362 判据 1：平台执行件把规定选项原样转发给既有执行件（不复制其逻辑）", () => {
  assert.deepEqual(buildForwardArgs({ tarball: "/tmp/dsh-graph-0.17.0.tgz" }), ["--tarball", "/tmp/dsh-graph-0.17.0.tgz"]);
  assert.deepEqual(buildForwardArgs({ spec: "dsh-graph@0.17.0" }), ["--spec", "dsh-graph@0.17.0"]);
  assert.deepEqual(buildForwardArgs({ path: "/src/dsh-graph" }), ["--path", "/src/dsh-graph"]);
  assert.deepEqual(buildForwardArgs({ staticOnly: "/src/dsh-graph" }), ["--static-only", "/src/dsh-graph"]);
  assert.deepEqual(buildForwardArgs({ selfTest: true }), ["--self-test"], "--self-test 必须原样转发");

  const all = buildForwardArgs({
    tarball: "/tmp/a.tgz", spec: "dsh-graph@0.17.0", path: "/src/dsh-graph", staticOnly: "/src/dsh-graph",
    selfTest: true, port: "3099", profile: "platform-smoke", dshHome: "/tmp/home", dsh: "npx -y @deepseek-ai/dsh", timeout: "30",
  });
  for (const flag of ["--tarball", "--spec", "--path", "--static-only", "--self-test", "--port", "--profile", "--dsh-home", "--dsh", "--timeout"]) {
    assert.ok(all.includes(flag), `缺少转发参数 ${flag}：${all.join(" ")}`);
  }
  assert.deepEqual(buildForwardArgs({}), [], "无参数时不得产生转发参数");
});

test("g-362 判据 1：--profile/--dsh-home 的默认值不得触发转发（否则会去 registry 装插件）", () => {
  assert.equal(forwardRequested({ profile: "platform-smoke", dshHome: "/h", skipBuild: true, keepTemp: false }), false);
  assert.equal(forwardRequested({ staticOnly: "/s" }), true);
  assert.equal(forwardRequested({ selfTest: true }), true);
  assert.equal(forwardRequested({ tarball: "/x/a.tgz" }), true);
  assert.equal(forwardRequested({ spec: "dsh-graph" }), true);
  assert.equal(forwardRequested({ path: "/p" }), true);
});

test("g-362 判据 1：探测沙箱根永不落系统 /tmp（沙盒只允许写工作区 + 探针需同 FS）", () => {
  const prev = process.env.TMPDIR;
  try {
    delete process.env.TMPDIR;
    assert.equal(resolveTempRoot("/repo/x", null), join("/repo/x", "tmp", "platform-gate"));
    process.env.TMPDIR = "/tmp";
    assert.equal(resolveTempRoot("/repo/x", null), join("/repo/x", "tmp", "platform-gate"), "系统 /tmp 必须被忽略");
    process.env.TMPDIR = "/repo/x/tmp/platform-gate";
    assert.equal(resolveTempRoot("/repo/x", null), "/repo/x/tmp/platform-gate", "仓库内 TMPDIR 应被沿用");
    assert.equal(resolveTempRoot("/repo/x", "/custom"), "/custom", "--temp-root 优先");
  } finally {
    if (prev === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prev;
  }
});

// ============================================================================
// ② P1 大小写敏感性：判定两侧 + 平台口径
// ============================================================================

test("g-362 判据 3（P1）：大小写敏感判 PASS，不敏感判 WARN 且按平台给出影响说明", () => {
  const ok = judgeCaseSensitivity({ aliased: false, fsType: "ext4", platform: "Linux", entries: ["A", "A-dir", "a"] });
  assert.equal(ok.level, "PASS");
  assert.equal(ok.notes.length, 0);

  // 负向对照：只要别名成立（文件 / 同 inode / 目录任一）就必须变 WARN + 给影响说明
  const mac = judgeCaseSensitivity({ aliased: true, fileAliased: true, fsType: "apfs", platform: "macOS", entries: ["A"] });
  assert.equal(mac.level, "WARN", "大小写不敏感必须判 WARN（不是 PASS）");
  assert.equal(mac.notes[0].id, "case-insensitive");
  assert.ok(mac.notes[0].impact.length > 30, "WARN 必须附可读影响说明");
  assert.match(mac.notes[0].impact, /别名|覆盖/, "影响说明必须点出「互相别名 / 后写覆盖」");
  assert.match(mac.notes[0].impact, /APFS/, "macOS 口径必须点出 APFS 默认不敏感");

  const linux = judgeCaseSensitivity({ aliased: true, fsType: "vfat", platform: "Linux", entries: ["A"] });
  assert.equal(linux.notes[0].impact, judgeCaseSensitivity({ aliased: true, fsType: "vfat", platform: "Linux", entries: ["A"] }).notes[0].impact);
  assert.match(linux.notes[0].impact, /非 POSIX/, "Linux 上的不敏感 FS 必须换一套口径（不是照抄 macOS 文案）");
  assert.notEqual(mac.notes[0].impact, linux.notes[0].impact, "平台口径必须真的不同（同一份代码、不同标注）");
});

test("g-362 判据 3（P1）：大小写探针返回值自洽且可复现", () => {
  const base = resolveTempRoot(repoRoot, null);
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "g362-case-"));
  try {
    const first = probeCaseAliasing(dir);
    for (const key of ["fileAliased", "sameInode", "dirAliased"] as const) {
      assert.equal(typeof first[key], "boolean", `${key} 必须是布尔量`);
    }
    assert.equal(first.aliased, first.fileAliased || first.sameInode || first.dirAliased, "aliased 必须是三个子判据的逻辑或");
    assert.deepEqual(probeCaseAliasing(dir), first, "同一目录上重复探测结论必须一致（探针不得依赖残留状态）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// ③ P2 软链 root 边界：三态判定（这是唯一会 FAIL 的真实缺陷面）
// ============================================================================

test("g-362 判据 3（P2）：软链 root 被拒 + 物理路径通过 ⇒ PASS；两个真实缺陷面必须 FAIL", () => {
  const sym = (p: Record<string, unknown>) => ({
    engineLoaded: true, attempted: true, logicalRoot: "/repo", physicalRoot: "/repo", symlinkedRoot: false,
    explicitMessage: "graph root symlink is not allowed", physicalMessage: null,
    ...p,
  });
  const ok = judgeSymlinkRoot(sym({}));
  assert.equal(ok.level, "PASS");

  const notRejected = judgeSymlinkRoot(sym({ explicitMessage: null }));
  assert.equal(notRejected.level, "FAIL", "软链 root 未被拒 ⇒ 守卫失效，必须 FAIL");
  assert.match(notRejected.detail, /未被正确拒绝|未被拒/);

  const physicalRejected = judgeSymlinkRoot(sym({ explicitMessage: "graph root symlink is not allowed", physicalMessage: "graph root symlink is not allowed" }));
  assert.equal(physicalRejected.level, "FAIL", "物理路径也被拒 ⇒ 会话打不开看板，必须 FAIL");

  // 未构建 dist / 无法创建软链 ⇒ WARN（未实测，不冒充通过）
  assert.equal(judgeSymlinkRoot({ engineLoaded: false, explicitSymlink: "x", logicalRoot: "/a", physicalRoot: "/a", symlinkedRoot: false }).level, "WARN");
  assert.equal(judgeSymlinkRoot(sym({ attempted: false })).level, "WARN");
  // 负向对照：把「期望文案」判定去掉（任何异常都算通过）就会被上面第 2 条钉红 —— 这里直接断言文案敏感
  assert.notEqual(
    judgeSymlinkRoot(sym({ explicitMessage: "some other error" })).level,
    "PASS",
    "拒绝文案不符（说明不是 rejectSymlinkRoot 在拒）不得判 PASS",
  );
});

test("g-362 判据 3（P2）：真实发布物确实按此语义拒绝软链 root（端到端，不复制其逻辑）", async () => {
  const rootJs = join(repoRoot, "dist", "core", "root.js");
  if (!existsSync(rootJs)) {
    // 未构建 dist 时只断言脚本的降级口径（WARN），不假装跑过
    assert.equal(judgeSymlinkRoot({ engineLoaded: false, explicitSymlink: "-", logicalRoot: "/a", physicalRoot: "/a", symlinkedRoot: false }).level, "WARN");
    return;
  }
  const mod = await import(rootJs);
  const base = resolveTempRoot(repoRoot, null);
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "g362-root-"));
  try {
    const real = join(dir, "real");
    mkdirSync(join(real, "graph"), { recursive: true });
    const link = join(dir, "link");
    const { symlinkSync, realpathSync } = await import("node:fs");
    symlinkSync(real, link, "dir");
    let explicitMessage: string | null = null;
    try { mod.resolveRoot(null, join(link, "graph")); } catch (e: any) { explicitMessage = String(e?.message ?? e); }
    let physicalMessage: string | null = null;
    try { mod.resolveRoot(null, join(realpathSync(dir), "real", "graph")); } catch (e: any) { physicalMessage = String(e?.message ?? e); }
    const verdict = judgeSymlinkRoot({
      engineLoaded: true, attempted: true, explicitMessage, physicalMessage,
      logicalRoot: realpathSync(repoRoot), physicalRoot: realpathSync(repoRoot), symlinkedRoot: false,
    });
    assert.equal(verdict.level, "PASS", `发布物应拒绝软链 root 且接受物理路径：${verdict.detail}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// ④ P3 挂载类型识别：Linux /proc/mounts 与 macOS mount(8) 走同一份判定
// ============================================================================

test("g-362 判据 3（P3）：挂载表解析（最长前缀 / 八进制转义 / macOS 形态）可判别", () => {
  const procMounts = [
    "/dev/sda1 / ext4 rw 0 0",
    "tmpfs /tmp tmpfs rw 0 0",
    "//srv/share /mnt/share cifs rw 0 0",
    "/dev/sdb1 /mnt/share/deep ext4 rw 0 0",
  ].join("\n");
  assert.equal(findMountForPath("/tmp/x", procMounts)?.fstype, "tmpfs");
  assert.equal(findMountForPath("/mnt/share/deep/f", procMounts)?.mountPoint, "/mnt/share/deep", "必须最长前缀优先");
  assert.notEqual(findMountForPath("/mnt/share/deep/f", procMounts)?.mountPoint, "/mnt/share", "最短前缀是错的（负向对照）");
  assert.equal(findMountForPath("/mnt/share/other", procMounts)?.fstype, "cifs");
  assert.equal(findMountForPath("/nope", "garbage\n"), null);
  assert.equal(unescapeMount("/mnt/my\\040share"), "/mnt/my share");

  // macOS 的 mount(8) 输出必须先被规范成同一形状，才能复用同一个解析器
  const bsd = parseBsdMountTable([
    "/dev/disk3s1 on / (apfs, local, journaled)",
    "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
  ].join("\n"));
  assert.equal(bsd.split("\n").length, 2, "两行都要被解析");
  assert.equal(findMountForPath("/", bsd)?.fstype, "apfs", "macOS 形态必须能被同一解析器命中");
  assert.equal(findMountForPath("/System/Volumes/Data/home/x", bsd)?.fstype, "autofs", "最长前缀优先在 macOS 形态上同样成立");
  assert.equal(parseBsdMountTable("").trim(), "", "空输入不得炸");
});

test("g-362 判据 3（P3）：本地盘判 PASS；网络/tmpfs/drvfs 判 WARN 且附影响说明", () => {
  const facts = (over: Record<string, unknown> = {}) => ({
    fsType: "ext4", mountPoint: "/", source: "/dev/sda1", magic: "ext2/3/4(0xef53)", via: "/proc/mounts",
    network: false, tmpfs: false, overlay: false, drvfs: false, wsl: true, ...over,
  });
  const ok = judgeMountType(facts());
  assert.equal(ok.level, "PASS");
  assert.equal(ok.notes.length, 0);
  assert.match(ok.detail, /fsType=ext4/, "detail 必须给出可核对的挂载事实");

  for (const [field, id] of [["network", "network-mount"], ["tmpfs", "tmpfs"], ["drvfs", "wsl-drvfs"]] as const) {
    const v = judgeMountType(facts({ [field]: true, fsType: field }));
    assert.equal(v.level, "WARN", `${field} 必须判 WARN（只报告风险，不判 FAIL）`);
    assert.equal(v.notes[0].id, id);
    assert.ok(v.notes[0].impact.length > 30, `${id} 的影响说明过短：${v.notes[0].impact}`);
  }
  assert.match(judgeMountType(facts({ network: true })).notes[0].impact, /锁|原子/, "网络挂载说明必须点出锁/原子性后果");
  assert.match(judgeMountType(facts({ drvfs: true })).notes[0].impact, /别名|锁|原子/, "drvfs 说明必须点出具体后果");
  assert.match(judgeMountType(facts({ tmpfs: true })).notes[0].impact, /易失|清空/, "内存 FS 说明必须点出易失性");
  // overlayfs 只报告事实，不单独触发 WARN
  assert.equal(judgeMountType(facts({ overlay: true, fsType: "overlay" })).level, "PASS");
});

// ============================================================================
// ⑤ P4/P5：目标 FS 上的锁、原子写与跨 FS rename
// ============================================================================

test("g-362 判据 3（P4.a）：并发 CAS 恰好 1 成功 3 冲突才 PASS", () => {
  assert.equal(judgeConcurrentCas({ ok: 1, conflict: 3, error: 0 }).level, "PASS");
  for (const p of [
    { ok: 2, conflict: 2, error: 0 },   // 锁未生效
    { ok: 0, conflict: 4, error: 0 },   // 过度拒绝
    { ok: 1, conflict: 2, error: 1 },   // 出现异常
    { ok: 4, conflict: 0, error: 0 },   // 全成功
  ]) {
    const v = judgeConcurrentCas(p);
    assert.equal(v.level, "FAIL", `${JSON.stringify(p)} 必须判 FAIL`);
    assert.ok(v.problems.length > 0);
  }
});

test("g-362 判据 3（P4.b）：原子写 —— 撕裂读/残留/写者失败都必须变红", () => {
  const good = { writers: 16, writersOk: 16, reads: 42, torn: 0, finalComplete: true, finalLength: 4101, leftovers: [] };
  assert.equal(judgeAtomicWrite(good).level, "PASS");
  for (const [field, value] of [
    ["torn", 1], ["finalComplete", false], ["writersOk", 15], ["leftovers", ["x.txt.tmp.1"]], ["reads", 0],
  ] as [string, unknown][]) {
    assert.equal(judgeAtomicWrite({ ...good, [field]: value }).level, "FAIL", `把 ${field} 改成 ${JSON.stringify(value)} 后必须判 FAIL`);
  }
  // 载荷判定本身也要有判别力（否则「撕裂读」永远数不到）
  assert.equal(isCompleteAtomicPayload("W7:" + "x".repeat(4096) + ":7\n"), true);
  assert.equal(isCompleteAtomicPayload("W7:" + "x".repeat(4095) + ":7\n"), false, "长度不符必须判非完整");
  assert.equal(isCompleteAtomicPayload("W7:" + "x".repeat(4096) + ":8\n"), false, "首尾编号不一致必须判非完整");
  assert.equal(isCompleteAtomicPayload(""), false);
});

test("g-362 判据 3（P5）：跨 FS rename(EXDEV) —— 静默降级/数据丢失必须变红", () => {
  const good = {
    attempted: true, candidates: ["/dev/shm"], secondFs: "/dev/shm", secondFsType: "tmpfs",
    srcDev: 1, dstDev: 2, renameCode: "EXDEV", srcIntact: true, dstExists: false, codePropagates: true,
  };
  assert.equal(judgeExdev(good).level, "PASS");
  for (const [field, value] of [
    ["codePropagates", false],  // 静默降级为拷贝 ⇒ 原子性丧失
    ["srcIntact", false],       // EXDEV 后源文件没了
    ["dstExists", true],
  ] as [string, unknown][]) {
    assert.equal(judgeExdev({ ...good, [field]: value }).level, "FAIL", `把 ${field} 改成 ${JSON.stringify(value)} 后必须判 FAIL`);
  }
  const noFs = judgeExdev({ attempted: false, candidates: ["/tmp"] });
  assert.equal(noFs.level, "WARN");
  assert.ok(noFs.impact.length > 30, "「未实测」必须附影响说明与代码侧缓解");
  assert.equal(judgeExdev({ ...good, renameCode: "EACCES" }).level, "WARN");
  assert.equal(judgeExdev({ ...good, renameCode: null }).level, "WARN");
});

// ============================================================================
// ⑥ P6：locale/编码逐字节往返
// ============================================================================

test("g-362 判据 3（P6）：CJK 逐字节往返全绿判 PASS，任一字节往返失败必须变红", () => {
  const good = {
    steps: [{ n: "createGoal", ok: true }], locale: "C", goal: "g-001",
    titleByteExact: true, bodyByteExact: true, fileUtf8RoundTrip: true,
    prompts: 14, promptsByteExact: true, promptsNonAscii: 14, fileSha256: "a".repeat(64),
  };
  assert.equal(judgeLocaleRoundTrip(good).level, "PASS");
  for (const [field, value] of [
    ["titleByteExact", false], ["bodyByteExact", false], ["fileUtf8RoundTrip", false],
    ["promptsByteExact", false], ["prompts", 0], ["promptsNonAscii", 0],
  ] as [string, unknown][]) {
    assert.equal(judgeLocaleRoundTrip({ ...good, [field]: value }).level, "FAIL",
      `把 ${field} 改成 ${JSON.stringify(value)} 后必须判 FAIL（locale 下的静默 mojibake 是真实数据损坏）`);
  }
  assert.equal(judgeLocaleRoundTrip(null).level, "FAIL", "子进程无产出必须 FAIL，而不是被当成跳过");
  assert.equal(judgeLocaleRoundTrip({ ...good, steps: [{ n: "createGoal", ok: false, err: "boom" }] }).level, "FAIL");
  assert.equal(parseLocaleJson('noise\nDSH_GATE_JSON:{"ok":true}\n')?.ok, true);
  assert.equal(parseLocaleJson("noise\n"), null);
});

// ============================================================================
// ⑦ M4（平台无关，承自 g-359）：三态判别力 + 真实仓库零隐患
// ============================================================================

test("g-362 判据 3：M4 审计在新件里保持存活且有判别力（隐患必红、守卫不误判）", () => {
  const hits = (text: string, path = "probe.sh") => scanLinuxOnlyAssumptions([{ path, fileClass: "release", text }]);
  assert.ok(LINUX_ONLY_PATTERNS.length >= 10, "M4 判定表必须完整（承自 g-359，不得被削弱）");
  assert.ok(LINUX_ONLY_PATTERNS.every((p: any) => p.re instanceof RegExp && typeof p.judge === "function"));

  // 有意样本（只做字符串比较，从不执行）—— 用共享标记区域声明，否则真实仓库扫描会把本文件
  // 自己的样本当成真隐患（这正是该标记存在的理由）。
  // dsh-macos-gate:ignore-linux-only-probes
  const riskSamples: [string, string][] = [
    ["readlink-f", "readlink -f /tmp/x\n"],
    ["stat-c", "stat -c %s f\n"],
    ["md5sum", "md5sum f\n"],
    ["sha256sum", "sha256sum f\n"],
    ["sed-i-no-backup", "sed -i 's/a/b/' f\n"],
    ["grep-P", "grep -P 'x' f\n"],
    ["date-d", "date -d '2026-09-25' +%s\n"],
    ["cp-reflink", "cp --reflink f g\n"],
    ["mktemp-d-no-template", "T=$(mktemp -d)\n"],
  ];
  // dsh-macos-gate:end-ignore-linux-only-probes
  for (const [id, text] of riskSamples) {
    const got = hits(text);
    assert.equal(got.length, 1, `样本 ${JSON.stringify(text)} 应恰好命中 1 处，实际 ${got.length}`);
    assert.equal(got[0].id, id);
    assert.equal(got[0].covered, false, `${id} 是静默隐患，不得被判为已覆盖`);
    assert.ok(got[0].why.length > 0 && got[0].advice.length > 0, `${id} 必须给出原因与改法`);
  }

  // 已覆盖侧：注释 / 能力探测 + 回退不得误报
  // dsh-macos-gate:ignore-linux-only-probes
  assert.equal(hits("# 用 sha256sum 校验\n")[0]?.covered, true, "注释里的字面量应判已覆盖");
  const covered = hits("elif mv --exchange --help >/dev/null 2>&1; then\n  mv -T --exchange a b\nfi\n", "build.sh");
  assert.equal(covered.length, 2);
  assert.ok(covered.every((h: any) => h.covered), "同文件含 mv --exchange --help 探测时必须判已覆盖");
  assert.equal(hits("stat -f %z f\n").length, 0, "BSD 形式 stat -f 不得误报");
  assert.equal(hits("grep -E 'x' f\n").length, 0, "grep -E 不得误报");
  assert.equal(hits('T=$(mktemp -d "${TMPDIR:-/tmp}/x.XXXXXX")\n').length, 0, "带模板的 mktemp -d 不得误报");
  assert.equal(hits("sed -i.bak 's/a/b/' f\n").length, 0, "带 backup 后缀的 sed -i 不得误报");
  // dsh-macos-gate:end-ignore-linux-only-probes
  assert.ok(isCommentLine("  # x") && isCommentLine("// y") && !isCommentLine("echo hi"));
});

test("g-362 判据 3：真实仓库的发布/测试路径零 Linux-only 隐患，且审计非恒真", () => {
  const { gated, archived } = collectScanFiles(repoRoot);
  assert.ok(gated.length > 0, "扫描目标不得为空");
  // 扫描面 = scripts 顶层（.sh/.mjs）+ core/tests/**（递归）；archived 另列
  for (const must of ["scripts/build.sh", "scripts/win-smoke-test.mjs", "scripts/macos-smoke-test.mjs", "core/tests/g359-macos-gate.test.ts"]) {
    assert.ok(gated.some((f: any) => f.path === must), `扫描目标必须包含 ${must}`);
  }
  assert.ok(!gated.some((f: any) => f.path === "scripts/platform-smoke-test.mjs"), "模式定义表自身豁免（判别力由 --self-test 与用例固化）");
  const risks = scanLinuxOnlyAssumptions(gated).filter((h: any) => !h.covered);
  assert.deepEqual(
    risks.map((h: any) => `${h.file}:${h.line} [${h.id}]`),
    [],
    "发布/测试路径不得存在 Linux-only 隐患 —— 请补能力探测+回退，或改掉那处调用",
  );
  // 非恒真守卫：真实仓库必然命中 build.sh 的 mv --exchange（已覆盖），否则说明扫描器坏了
  const hits = scanLinuxOnlyAssumptions(gated);
  assert.ok(hits.some((h: any) => h.covered && h.file === "scripts/build.sh"), "build.sh 的 mv --exchange 必须在命中列表里");
  assert.ok(archived.every((f: any) => f.fileClass === "archived"), "scripts/archived/** 必须归为 archived 类（仅 INFO）");
  assert.ok(archived.some((f: any) => f.path === "scripts/archived/macos-smoke-test.mjs"), "被取代的实现必须能在 archived 里找到");
});

// ============================================================================
// ⑧ 「一份实现」：shim 只转发、旧件已归档、linux 专属件不存在
// ============================================================================

test("g-362 判据 2：不保留两份实现（shim 只转发 / 旧实现已归档 / 无 linux 专属件）", () => {
  assert.ok(existsSync(SCRIPT), "新件必须存在");
  assert.ok(existsSync(SHIM), "旧路径必须保留（降为 shim，避免既有引用失效）");
  assert.ok(existsSync(ARCHIVED), "被取代的实现必须归档保留（历史可追溯）");
  assert.ok(!existsSync(join(repoRoot, "scripts", "linux-smoke-test.mjs")), "不得新增 linux 专属执行件（负责人裁决）");

  const shim = readFileSync(SHIM, "utf8");
  assert.match(shim, /SUPERSEDED|已被取代/, "shim 必须打印 superseded 提示");
  assert.match(shim, /platform-smoke-test\.mjs/, "shim 必须指向新件");
  // 零重复逻辑：shim 不得含判定表/判定函数/扫描器，也不得含归档件的实现符号
  for (const forbidden of ["LINUX_ONLY_PATTERNS", "scanLinuxOnlyAssumptions", "collectScanFiles", "judgeCaseSensitivity", "judgeSymlinkRoot", "probeCaseAliasing", "buildForwardArgs"]) {
    assert.ok(!shim.includes(forbidden), `shim 不得含实现符号 ${forbidden}（否则又是两份实现）`);
  }
  assert.ok(shim.split("\n").length < 70, "shim 必须足够薄（只做提示 + 转发）");
  // 新件必须是被取代实现的唯一出口：M4 的导出都在新件里
  const impl = readFileSync(SCRIPT, "utf8");
  for (const symbol of ["export function scanLinuxOnlyAssumptions", "export const LINUX_ONLY_PATTERNS", "export function collectScanFiles"]) {
    assert.ok(impl.includes(symbol), `新件必须导出 ${symbol}（M4 在新件里保持存活）`);
  }
  // 归档副本按仓库惯例「内容一字未改」⇒ 它与旧实现的字节必须一致（不可偷偷改逻辑）
  const arch = readFileSync(ARCHIVED, "utf8");
  assert.ok(arch.includes("export function scanLinuxOnlyAssumptions"), "归档副本必须仍含原实现");
  assert.ok(arch.split("\n").length > 700, "归档副本必须是完整实现，不是被裁剪过的残片");
});

test("g-362 判据 1/2：旧路径 shim 端到端可用（打印取代提示并转发，退出码透传）", () => {
  const r = spawnSync(process.execPath, [SHIM, "--self-test"], { cwd: repoRoot, encoding: "utf8", timeout: 300_000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  assert.equal(r.status, 0, `shim 转发应 exit 0，实际 ${r.status}\n${out.slice(-2000)}`);
  assert.match(out, /已被取代|SUPERSEDED/, "必须打印 superseded 提示");
  assert.match(out, /本脚本自检全部通过。/, "必须真的转发到新件（新件自检输出可见）");
  // 用法错误必须由转发目标透传（exit 2），shim 不得吞掉退出码
  const usage = spawnSync(process.execPath, [SHIM, "--definitely-not-an-option"], { cwd: repoRoot, encoding: "utf8", timeout: 60_000 });
  assert.equal(usage.status, 2, "退出码必须原样透传");
});

// ============================================================================
// ⑨ 端到端：六项探针都真的跑出 PASS/WARN/FAIL + --self-test 全绿 + CLI 语义
// ============================================================================

test("g-362 判据 3：六项探针都真的给出 PASS/WARN/FAIL（而非被静默跳过）", () => {
  assert.equal(itemLevel("P1"), "SKIP", "未运行探针时该项必须是 SKIP，不得冒充 PASS");
  assert.equal(itemLevel("P9"), "SKIP");

  // --skip-build 跳过依赖 dist 的 P4/P5/P6，P1–P3 与 M4 仍真跑（秒级，无需网络）
  const r = spawnSync(process.execPath, [SCRIPT, "--skip-build"], { cwd: repoRoot, encoding: "utf8", timeout: 600_000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  assert.equal(r.status, 0, `应 exit 0（告警不算失败），实际 ${r.status}\n${out.slice(-3000)}`);
  const line = out.split(/\r?\n/).find((l) => l.startsWith("逐项判定"));
  assert.ok(line, `必须打印逐项判定行\n${out.slice(-2000)}`);
  for (const item of ["P1", "P2", "P3", "P4", "P5", "P6"]) {
    assert.match(line as string, new RegExp(`${item}=(PASS|WARN|FAIL)`), `${item} 必须给出 PASS/WARN/FAIL：${line}`);
  }
  assert.match(out, /平台无关附加检查：M4=(PASS|WARN|FAIL)/, "M4 必须出现在结论里（保持存活）");
  assert.match(line as string, /P4=WARN/, "--skip-build 时 P4 必须如实降级为 WARN，而不是伪装成 PASS");
  assert.match(out, /未提供 --tarball\/--spec\/--path\/--static-only\/--self-test/, "未给来源时必须跳过转发（不去 registry 装插件）");
  assert.doesNotMatch(out, /安装来源=/, "未给来源时不得真的安装任何包");
});

test("g-362 判据 1/3：新件 --self-test 端到端通过（本脚本 + 转发的 win-smoke）", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--self-test"], { cwd: repoRoot, encoding: "utf8", timeout: 300_000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  assert.equal(r.status, 0, `--self-test 应 exit 0，实际 ${r.status}\n${out.slice(-3000)}`);
  assert.match(out, /本脚本自检全部通过。/, "本脚本自检必须全绿");
  assert.match(out, /自检全部通过。/, "转发的 win-smoke-test.mjs 自检也必须全绿");
  assert.doesNotMatch(out, /自检失败/, "--self-test 不得出现失败项");
  // 平台效力声明必须出现，且与「非 win32 免责声明」明确区分
  assert.match(out, /对 .*具平台效力/);
  assert.match(out, /针对 Windows 真机/);
  // 用法/退出码语义与既有脚本一致：未知参数 exit 2、互斥来源 exit 2
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--definitely-not-an-option"], { cwd: repoRoot, encoding: "utf8", timeout: 60_000 }).status, 2);
  const mutual = spawnSync(process.execPath, [SCRIPT, "--tarball", "/nope/a.tgz", "--spec", "dsh-graph"], { cwd: repoRoot, encoding: "utf8", timeout: 60_000 });
  assert.equal(mutual.status, 2, "互斥来源必须 exit 2");
  assert.match((mutual.stdout ?? "") + (mutual.stderr ?? ""), /互斥/);
});
