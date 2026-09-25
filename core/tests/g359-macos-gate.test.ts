/**
 * core/tests/g359-macos-gate.test.ts
 *
 * g-359 质量判据 1/2 的自动化守卫。**v0.16.1（g-362）起 import 指向合并后的跨平台执行件**
 * `scripts/platform-smoke-test.mjs`：macOS 与 Linux 门禁已合并为一份实现，原
 * `scripts/macos-smoke-test.mjs` 降为转发 shim（其被取代的实现归档在 `scripts/archived/`）。
 *   - `buildForwardArgs` / `probeCaseAliasing` / `collectScanFiles` / `LINUX_ONLY_PATTERNS` /
 *     `scanLinuxOnlyAssumptions` 全部由**新件**导出（M4 作为平台无关检查在新件里保持存活）。
 *   - 本文件的 5 个用例与断言**一条未删**：只改了 import 来源与执行件路径。
 *
 * g-359 判据 1/2 的要求仍然成立：执行件必须
 *   ① 把 `--tarball/--spec/--path/--static-only/--self-test` 原样转发给既有执行件
 *      `scripts/win-smoke-test.mjs`（不复制其逻辑）；
 *   ② 自带 macOS/Linux 专检，且其中"M4 Linux-only 假设扫描"的判定
 *      **有判别力**（真隐患必红、已覆盖不误报）。
 *
 * 为什么需要：
 *   - M4 的判定表如果退化成恒真（任何命中都判"已覆盖"），这道门禁就毫无意义；
 *     所以这里用合成样本把"隐患必红 / 已覆盖不误报"两侧都钉住，并对**真实仓库**
 *     断言发布/测试路径零隐患 —— 有人往 scripts 顶层塞 `sha256sum` 就会在 Linux 上也变红。
 *   - 转发参数是纯函数，直接断言它，比跑一次完整门禁（要装插件、起实例）快得多。
 *
 * 说明（平台边界）：`probeCaseAliasing` 的**正向**结论（APFS 大小写不敏感 ⇒ 别名）无法在
 *   Linux 上合成 —— 那需要真的大小写不敏感卷。故本测试只断言探针返回值自洽且可复现，
 *   正向判定留给 macOS 真机（`docs/platform-gate.md`）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildForwardArgs,
  collectScanFiles,
  LINUX_ONLY_PATTERNS,
  probeCaseAliasing,
  scanLinuxOnlyAssumptions,
} from "../../scripts/platform-smoke-test.mjs";

const repoRoot = join(import.meta.dirname, "../..");
const SCRIPT = join(repoRoot, "scripts", "platform-smoke-test.mjs");

// ============================================================================
// ① 转发：五个规定选项原样转发给 win-smoke-test.mjs
// ============================================================================

test("g-359 判据 1：macOS 执行件把五个规定选项原样转发给既有执行件", () => {
  // 互斥选项不会被真实 CLI 同时放行，但转发函数必须逐项原样、成对输出。
  assert.deepEqual(buildForwardArgs({ tarball: "/tmp/dsh-graph-0.16.0.tgz" }), ["--tarball", "/tmp/dsh-graph-0.16.0.tgz"]);
  assert.deepEqual(buildForwardArgs({ spec: "dsh-graph@0.16.0" }), ["--spec", "dsh-graph@0.16.0"]);
  assert.deepEqual(buildForwardArgs({ path: "/src/dsh-graph" }), ["--path", "/src/dsh-graph"]);
  assert.deepEqual(buildForwardArgs({ staticOnly: "/src/dsh-graph" }), ["--static-only", "/src/dsh-graph"]);
  assert.deepEqual(buildForwardArgs({ selfTest: true }), ["--self-test"], "--self-test 必须原样转发");

  const all = buildForwardArgs({
    tarball: "/tmp/a.tgz", spec: "dsh-graph@0.16.0", path: "/src/dsh-graph", staticOnly: "/src/dsh-graph",
    selfTest: true, port: "3099", profile: "mac-smoke", dshHome: "/tmp/home", dsh: "npx -y @deepseek-ai/dsh", timeout: "30",
  });
  for (const flag of ["--tarball", "--spec", "--path", "--static-only", "--self-test", "--port", "--profile", "--dsh-home", "--dsh", "--timeout"]) {
    assert.ok(all.includes(flag), `缺少转发参数 ${flag}：${all.join(" ")}`);
  }
  assert.deepEqual(buildForwardArgs({}), [], "无参数时不得产生转发参数");
});

// ============================================================================
// ② M4 扫描器的判别力（合成样本：两侧都钉住）
// ============================================================================

test("g-359 判据 2：M4 扫描器对 Linux-only 假设两侧都有判别力", () => {
  const hits = (text: string, path = "probe.sh") =>
    scanLinuxOnlyAssumptions([{ path, fileClass: "release", text }]);

  // 隐患侧：每个模式都必须被判为未覆盖（否则这道门禁就是恒真断言）。
  // 下面是**有意样本**（只做字符串比较，从不执行）——用标记区域声明，否则 M4 扫描会把
  // 本文件自己的样本当成真隐患（这正是该标记存在的理由）。
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
    ["mv-exchange", "mv -T a b\n"],
  ];
  // dsh-macos-gate:end-ignore-linux-only-probes
  for (const [id, text] of riskSamples) {
    const got = hits(text);
    assert.equal(got.length, 1, `样本 ${JSON.stringify(text)} 应恰好命中 1 处，实际 ${got.length}`);
    assert.equal(got[0].id, id);
    assert.equal(got[0].covered, false, `${id} 必须被判为隐患（未覆盖），否则门禁失去判别力`);
  }
  assert.ok(
    LINUX_ONLY_PATTERNS.length >= riskSamples.length,
    `判定表应覆盖全部样本模式（表 ${LINUX_ONLY_PATTERNS.length} 项 / 样本 ${riskSamples.length} 项）`,
  );

  // 已覆盖侧：特性探测/回退与注释不得误报。
  // dsh-macos-gate:ignore-linux-only-probes
  const covered = hits("elif mv --exchange --help >/dev/null 2>&1; then\n  mv -T --exchange a b\nfi\n", "build.sh");
  assert.equal(covered.length, 2);
  assert.ok(covered.every((h) => h.covered), "同文件含 mv --exchange 能力探测时必须判为已覆盖");
  assert.ok(hits("# 用 renameat2 做原子互换\n").every((h) => h.covered), "注释里的 renameat2 应判为已覆盖");
  assert.equal(hits('T=$(mktemp -d "${TMPDIR:-/tmp}/x.XXXXXX")\n').length, 0, "带模板的 mktemp -d 不得误报");
  assert.equal(hits("sed -i.bak 's/a/b/' f\n").length, 0, "带 backup 后缀的 sed -i 不得误报");
  assert.equal(hits("grep -E 'x' f\n").length, 0, "grep -E 不得误报");
  assert.equal(hits("stat -f %z f\n").length, 0, "BSD 形式 stat -f 不得误报");
  // dsh-macos-gate:end-ignore-linux-only-probes
});

test("g-359 判据 2：真实仓库的发布/测试路径零 Linux-only 隐患（archived 仅 INFO）", () => {
  const { gated, archived } = collectScanFiles(repoRoot);
  assert.ok(gated.length > 0, `扫描目标不得为空（scripts 顶层 + core/tests）`);
  assert.ok(
    gated.some((f) => f.path === "scripts/build.sh"),
    "扫描目标必须包含 scripts/build.sh（发布路径）",
  );
  assert.ok(
    gated.some((f) => f.path === "scripts/win-smoke-test.mjs"),
    "扫描目标必须包含 scripts/win-smoke-test.mjs（另一个发布执行件）",
  );
  const risks = scanLinuxOnlyAssumptions(gated).filter((h) => !h.covered);
  assert.deepEqual(
    risks.map((h) => `${h.file}:${h.line} [${h.id}]`),
    [],
    "发布/测试路径不得存在 Linux-only 隐患 —— 请按判读口径里的建议改掉，或补能力探测+回退后同步判定表",
  );
  // archived 脚本允许有隐患，但必须被归到 archived 类（不计门禁），而不是被漏掉。
  assert.ok(
    archived.every((f) => f.fileClass === "archived"),
    "scripts/archived/** 必须归为 archived 类（仅 INFO，不计门禁）",
  );
});

// ============================================================================
// ③ M2 探针可复现；--self-test 端到端可用
// ============================================================================

test("g-359 判据 2：大小写探针返回值自洽且可复现（正向判定留给 macOS 真机）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g359-case-"));
  try {
    const first = probeCaseAliasing(dir);
    for (const key of ["fileAliased", "sameInode", "dirAliased", "aliased"] as const) {
      assert.equal(typeof first[key], "boolean", `${key} 必须是布尔量`);
    }
    assert.equal(
      first.aliased,
      first.fileAliased || first.sameInode || first.dirAliased,
      "aliased 必须是三个子判据的逻辑或",
    );
    // 同一目录上重复探测必须得到同一结论（探针不得依赖残留状态）
    const second = probeCaseAliasing(dir);
    assert.deepEqual(second, first, "同一目录上重复探测结论必须一致");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-359 判据 1/2：--self-test 离线自检端到端通过（本脚本 + win-smoke）", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--self-test"], { cwd: repoRoot, encoding: "utf8", timeout: 300_000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  assert.equal(r.status, 0, `--self-test 应 exit 0，实际 ${r.status}\n${out.slice(-2000)}`);
  assert.match(out, /本脚本自检全部通过。/, "本脚本自检必须全绿");
  assert.match(out, /自检全部通过。/, "转发的 win-smoke-test.mjs 自检也必须全绿");
  assert.doesNotMatch(out, /自检失败/, "--self-test 不得出现失败项");
});
