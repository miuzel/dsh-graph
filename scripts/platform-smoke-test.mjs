#!/usr/bin/env node
/**
 * dsh-graph 跨平台快速验收脚本（发布门禁执行件 · g-362）
 *
 * v0.17.0 起本文件是**唯一一份** macOS/Linux 门禁实现（g-359 的 `scripts/macos-smoke-test.mjs`
 * 已并入本件：其被取代的实现归档在 `scripts/archived/`，原路径只留一行转发 shim）。
 *
 * 背景：`scripts/win-smoke-test.mjs` 是 Windows 门禁执行件（也能在 macOS/Linux 上跑），但它在
 *   非 win32 平台会打印「T3–T5 只能证明脚本与代码可跑」—— 那是对 **Windows 真机结论** 的免责声明，
 *   却让 macOS/Linux 侧结论的**平台效力**无从表达。而 Linux/macOS 恰好是 agent 侧每版本都能自动
 *   跑的平台，故补一份对称的执行件。
 *
 * 为什么是**一份**实现：探针查的是「本机文件系统与环境语义」，平台差异只体现在**判定口径与平台
 *   标注**（如 APFS 大小写不敏感 vs ext4 敏感），不体现在两套并行代码里 —— 两份实现只会带来
 *   双份维护与漂移，故合并为一份。
 *
 * 本脚本只做两件事，**不复制** win-smoke-test.mjs 的任何检查逻辑：
 *   1. 转发 `--tarball / --spec / --path / --static-only / --self-test / --dsh / --dsh-home /
 *      --timeout / --port / --profile` 给 `scripts/win-smoke-test.mjs`，沿用其 T1–T5；
 *      在**原生 macOS / Linux** 上这些结论**对本平台具平台效力**（T3–T5 在本机真跑：建目标/CAS/
 *      实例启动/REST 都真的发生），并与 win 脚本那句「非 win32…」的免责声明明确区分。
 *   2. 跑六项平台无关的 FS/环境探针（P1–P6），每项输出 PASS|WARN|FAIL + 判读口径。
 *
 * 六项探针（M2 等价：都是平台无关的 FS/环境检查）：
 *   P1 大小写敏感性   在目标 FS 上造仅大小写不同的 `A`/`a`（文件 + 目录），检测是否互相别名。
 *   P2 软链 root 边界  自建软链目录 ⇒ 显式 root 必须被拒（`graph root symlink is not allowed`），
 *                     realpath 后的物理路径必须解析通过（FAIL 只留给「物理路径也被拒」这一真实缺陷）。
 *   P3 挂载类型识别   graph root 所在挂载点：ext4/xfs/btrfs/apfs/hfs… 与 overlayfs/tmpfs/网络挂载/
 *                     WSL drvfs(`/mnt/*`) 的识别与风险标注。
 *   P4 锁与原子写     目标 FS 上复用 T3 语义：并发 CAS（4 抢 1）+ 原子写（16 写者 + 轮询读者）。
 *   P5 跨 FS rename   rename(2) 跨文件系统返回 EXDEV 的行为探测（源保留 / 目标未落地 /
 *                     `replaceFileAtomic` 如实向上抛，不静默降级为拷贝）。
 *   P6 locale/编码    最小 locale（`LANG=C`）下建目标 → 写 CJK 正文 → 读回，断言 CJK 内容与
 *                     prompts 资产逐字节往返（locale 相关的静默 mojibake 是真实数据损坏）。
 *
 * **明确取消（v0.17.0 负责人收窄范围；理由写在这里，避免后来者再补一遍）**：
 *   - 旧 coreutils 退化构建路径（`BUILD_FORCE_TWO_RENAME=1` 强制走两次 rename，覆盖
 *     `mv -T --exchange` 缺失的旧 coreutils）：**取消理由 = 该风险面已由 M4 的「能力探测 + 回退」
 *     判定覆盖**（`build.sh` 里的 `mv --exchange --help` 探测 + 两次 rename 兜底正是被 M4 判为
 *     「已覆盖」的形态，真实 macOS 构建走的也是这条路径，故无需再在 Linux 上人为强制）。补充事实：
 *     本包是**纯 TypeScript 产物**（dist 里没有原生二进制），用户侧不跑我们的 `bash scripts/build.sh`
 *     ⇒ 这条路径只影响我们自己的构建机；构建机侧另有 `core/tests/g348-atomic-build.test.ts`、
 *     `g359-two-rename-fallback.test.ts` 守住原子发布与两次 rename 回退。**代码与测试用例均已删除**
 *     （只随 `scripts/archived/macos-smoke-test.mjs` 保留历史实现）。
 *   - GNU-only 假设审计（扫脚本里 `sha256sum` / `readlink -f` / `stat -c` / `flock` / `cp --reflink` /
 *     `realpath -m` / `sort -V` / `xargs -r` / `find -printf` 等 Linux 专有用法）：**取消理由 = 这与
 *     g-359 的 macOS M4 扫描是同一件事，保留两份必然漂移**。故不另写一份，而是把 **M4 原样并入本件**
 *     作为**平台无关**附加检查（见下方 §M4；它守的是发布脚本对 macOS/BSD 的可移植性，与在哪台机器上
 *     跑无关），并保持导出，供既有 `core/tests/g359-macos-gate.test.ts` 的 M4 用例继续导入 —— 用例零削减。
 *
 * M4（平台无关附加检查，承自 g-359）：扫描 `scripts/*.sh|*.mjs`（顶层）与 `core/tests/**` 里的
 *   Linux-only 假设（GNU/BSD 差异表），逐处判「已被能力探测+回退覆盖」或「隐患」；发布/测试路径里的
 *   隐患 ⇒ FAIL，`scripts/archived/**` 只列 INFO，模式定义表自身豁免（判别力由 `--self-test` 与
 *   `core/tests/g362-platform-gate.test.ts` 固化）。**被取代的 macOS 实现**（M1–M4）归档在
 *   `scripts/archived/macos-smoke-test.mjs`（内容一字未改），原路径 `scripts/macos-smoke-test.mjs`
 *   只留一行**转发 shim**；`scripts/linux-smoke-test.mjs` 不存在（不保留两份实现）。
 *
 * 用法（在仓库根目录；P4/P5/P6 需要已构建的 `dist/core/*.js`）：
 *   TMPDIR=$PWD/tmp/platform-gate node scripts/platform-smoke-test.mjs --static-only .   # 秒级：P1–P6 + 转发 T1
 *   TMPDIR=$PWD/tmp/platform-gate node scripts/platform-smoke-test.mjs --tarball ../dsh-graph-0.17.0.tgz
 *   TMPDIR=$PWD/tmp/platform-gate node scripts/platform-smoke-test.mjs --self-test        # 离线自检（本脚本 + win-smoke）
 *   node scripts/platform-smoke-test.mjs --skip-build --tarball <tgz>                     # 未构建时跳过依赖 dist 的 P4/P5/P6
 *
 * 结论边界（务必先读）：
 *   - 在**原生 macOS 或 Linux** 上运行时，转发的 T1–T5 结论**对本平台具平台效力**；
 *     `win-smoke-test.mjs` 自带的那句「非 win32 上 T3–T5 只能证明脚本与代码可跑」是**针对 Windows
 *     真机结论**的免责声明（发布红线 1）—— 它**不削弱**本机结论，但本机结论也**不能替代**
 *     Windows 真机门禁（那条红线必须在原生 Windows 上单独跑）。
 *   - 在其它平台（例如直接在本脚本下跑 win32）时，平台效力声明**不成立**，输出会明确声明；
 *     请勿把那种输出读成「macOS/Linux 已通过」。
 *   - 本脚本的结论**不是**发布放行：真机结论回填位置见 `docs/platform-gate.md`「回填表」。
 *
 * 退出码：0=无失败项且转发的执行件通过；1=有失败项；其余=转发执行件的退出码（2=用法错误）。
 * 设计约束：纯 Node（无第三方依赖）、**只写仓库内 tmp/**（沙盒只允许写工作区；且 FS 探针必须与
 *   graph root 同一文件系统才有意义）、不自动打开浏览器、失败也跑完剩余检查后再统一出结论。
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, statfsSync, symlinkSync, writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const IS_LINUX = process.platform === "linux";
const IS_DARWIN = process.platform === "darwin";
/** 只有这两个平台上的探针判定与「平台效力」声明才成立。 */
const IS_SUPPORTED = IS_LINUX || IS_DARWIN;
/** 人类可读的平台标注（PASS/WARN 文案与回填表都用它）。 */
const PLATFORM_LABEL = IS_LINUX ? "Linux" : IS_DARWIN ? "macOS" : `非支持平台(${process.platform})`;
/** 软链 root 被拒的权威文案（core/root.ts rejectSymlinkRoot）。 */
const SYMLINK_ROOT_MSG = "graph root symlink is not allowed";
const SELF_FILE = basename(fileURLToPath(import.meta.url));

const LEVEL_TAG = { PASS: "[ OK ]", FAIL: "[FAIL]", WARN: "[WARN]", INFO: "[info]", SKIP: "[skip]" };
/** 严重度（越小越严重）；INFO/SKIP 不参与「逐项判定」聚合。 */
const LEVEL_SEVERITY = { FAIL: 0, WARN: 1, PASS: 2, INFO: 3, SKIP: 4 };
const results = [];

function record(id, name, level, detail = "", criterion = "") {
  results.push({ id, name, level, detail, criterion });
  const tag = LEVEL_TAG[level];
  const line = `${tag} ${id} · ${name}${detail ? ` — ${detail}` : ""}`;
  (level === "FAIL" ? console.error : console.log)(line);
  if (criterion) console.log(`        判读口径：${criterion}`);
}

function head(text) {
  console.log(`\n${"=".repeat(72)}\n${text}\n${"=".repeat(72)}`);
}

function rel(from, to) {
  const r = to.startsWith(from) ? to.slice(from.length) : to;
  return r.replace(/^[\\/]/, "");
}

/** 某一项（P1…P6）的聚合判定：取该项下最严重的 PASS/WARN/FAIL（INFO/SKIP 不计）。 */
export function itemLevel(id) {
  const list = results.filter(
    (r) => r.id.split(".")[0] === id && (r.level === "PASS" || r.level === "WARN" || r.level === "FAIL"),
  );
  if (list.length === 0) return "SKIP";
  return list.slice().sort((a, b) => LEVEL_SEVERITY[a.level] - LEVEL_SEVERITY[b.level])[0].level;
}

// ---------------------------------------------------------------------------
// 沙箱根：必须在仓库内 tmp/（沙盒只允许写工作区；且 FS 探针必须与 graph root 同 FS）
// ---------------------------------------------------------------------------

/**
 * 解析探测沙箱根。**永不**默认落系统 /tmp：
 *   - 沙盒（workspace-write）只允许写工作区；
 *   - 宿主的 `core/root.ts` 会硬拒绝含软链的 root（`graph root symlink is not allowed`），
 *     而系统 /tmp 在 macOS 上是软链（`/tmp` → `/private/tmp`）、在本机 WSL2 上常是 tmpfs；
 *   - P1/P3 的大小写与挂载探针只有在**与 graph root 同一文件系统**上才有意义。
 * 故：显式 `--temp-root` > `$TMPDIR`（仅当它已在仓库内）> `<repo>/tmp/platform-gate`。
 */
export function resolveTempRoot(repo, explicit) {
  if (explicit) return resolve(explicit);
  const repoAbs = resolve(repo);
  const envTmp = process.env.TMPDIR ? resolve(process.env.TMPDIR) : null;
  if (envTmp && (envTmp === repoAbs || envTmp.startsWith(repoAbs + sep))) return envTmp;
  return join(repoAbs, "tmp", "platform-gate");
}

// ---------------------------------------------------------------------------
// P1–P3：文件系统语义（跨平台同一份判定代码；平台差异只在判定口径与平台标注）
// ---------------------------------------------------------------------------

/**
 * 在 dir 内造仅大小写不同的 `A`/`a`（文件与目录各一对），检测是否互为别名。
 * 纯函数式副作用（只写 dir 内），便于离线自检。
 */
export function probeCaseAliasing(dir) {
  writeFileSync(join(dir, "A"), "UPPER", "utf8");
  writeFileSync(join(dir, "a"), "lower", "utf8");
  const fileAliased = readFileSync(join(dir, "A"), "utf8") === "lower";
  const sameInode = statSync(join(dir, "A")).ino === statSync(join(dir, "a")).ino;
  mkdirSync(join(dir, "A-dir"), { recursive: true });
  const dirAliased = existsSync(join(dir, "a-dir"));
  const entries = readdirSync(dir).sort();
  return { fileAliased, sameInode, dirAliased, aliased: fileAliased || sameInode || dirAliased, entries };
}

/** 挂载表里的八进制转义（空格写成 `\040`）——Linux `/proc/mounts` 与 BSD `mount(8)` 输出都有。 */
export function unescapeMount(s) {
  return s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

/**
 * 把 BSD/macOS `mount(8)` 的输出规范成与 `/proc/mounts` 同形的三列文本
 * （`source mountPoint fstype`），这样两种平台共用同一个 `findMountForPath` 解析器。
 * 形如：`/dev/disk3s1 on / (apfs, local, journaled)`、`map auto_home on /home (autofs, automounted)`。
 */
export function parseBsdMountTable(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^(.+?)\s+on\s+(.+?)\s+\(([^,)]+)/.exec(line.trim());
    if (!m) continue;
    out.push(`${m[1].replace(/ /g, "\\040")} ${m[2].replace(/ /g, "\\040")} ${m[3].trim()}`);
  }
  return out.join("\n");
}

/** 解析挂载表文本（三列），返回覆盖 target 的挂载点（最长前缀匹配）。 */
export function findMountForPath(target, mountsText) {
  const entries = [];
  for (const line of mountsText.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(" ");
    if (parts.length < 3) continue;
    const mountPoint = unescapeMount(parts[1]);
    if (!mountPoint.startsWith("/")) continue;
    entries.push({ source: parts[0], mountPoint, fstype: parts[2] });
  }
  const abs = resolve(target);
  let best = null;
  for (const e of entries) {
    const inside = abs === e.mountPoint || abs.startsWith(e.mountPoint === "/" ? "/" : e.mountPoint + "/");
    if (!inside) continue;
    if (!best || e.mountPoint.length > best.mountPoint.length) best = e;
  }
  return best;
}

/**
 * 读挂载表：Linux 用 `/proc/mounts`；macOS（无 /proc）用 `mount(8)` 输出。
 * 两者都被规范成同一形状 ⇒ 下游判定只有一份。
 */
export function readMountTable() {
  if (IS_LINUX) {
    try { return { text: readFileSync("/proc/mounts", "utf8"), via: "/proc/mounts" }; } catch { /* 落到 mount(8) */ }
  }
  try {
    const r = spawnSync("mount", [], { encoding: "utf8", timeout: 15_000 });
    if ((r.status ?? 1) === 0 && r.stdout) return { text: parseBsdMountTable(r.stdout), via: "mount(8)" };
  } catch { /* 不可用 */ }
  return { text: "", via: "unavailable" };
}

/** 网络/伪文件系统分类（决定 WARN 与影响说明）。 */
export const NETWORK_FS = new Set([
  "nfs", "nfs4", "cifs", "smb3", "smbfs", "afs", "ceph", "glusterfs", "davfs",
  "fuse.sshfs", "fuse.s3fs", "fuse.gcsfuse", "fuse.rclone",
]);
export const TMPFS_FS = new Set(["tmpfs", "ramfs"]);
export const OVERLAY_FS = new Set(["overlay", "overlayfs"]);
/** WSL 的 drvfs/9p 桥接盘（挂到 `/mnt/*`）。 */
export const DRVFS_FS = new Set(["drvfs", "9p"]);
/**
 * `statfs().f_type` 魔数 → 文件系统名（**只作交叉提示**：权威是挂载表的类型名）。
 * Linux 取值已在本机实证；Darwin 三个取值来自 XNU `sys/mount.h`，本机无 macOS ⇒ 未实证，标 `?`。
 */
export const FS_MAGIC = new Map([
  [0xef53, "ext2/3/4"], [0x1021994, "tmpfs"], [0x794c7630, "overlayfs"], [0x6969, "nfs"],
  [0xff534d42, "cifs"], [0x9fa0, "proc"], [0x1021997, "9p"], [0x58465342, "xfs"],
  [0x9123683e, "btrfs"], [0x1a, "apfs?"], [0x11, "hfs?"], [0xf, "nfs?"],
]);

/** `statfs` 魔数（POSIX；不可用时返回 null）。 */
export function fsMagic(path) {
  try {
    const s = statfsSync(path);
    const type = s.type >>> 0;
    return { type, hex: `0x${type.toString(16)}`, name: FS_MAGIC.get(type) ?? null };
  } catch {
    return null;
  }
}

/** 采集 graph root 所在 FS 的事实（P1/P3 共用；不写盘）。 */
function collectFsFacts(repo) {
  const table = readMountTable();
  const mount = findMountForPath(repo, table.text) || { source: "?", mountPoint: "?", fstype: "?" };
  const logicalRoot = resolve(repo);
  let physicalRoot = logicalRoot;
  try { physicalRoot = realpathSync(logicalRoot); } catch { /* 保持逻辑路径 */ }
  let wsl = false;
  try { wsl = /microsoft/i.test(readFileSync("/proc/version", "utf8")); } catch { /* 非 Linux */ }
  const fsType = mount.fstype;
  const magic = fsMagic(repo);
  return {
    via: table.via,
    logicalRoot,
    physicalRoot,
    symlinkedRoot: physicalRoot !== logicalRoot,
    fsType,
    mountPoint: mount.mountPoint,
    source: mount.source,
    network: NETWORK_FS.has(fsType),
    tmpfs: TMPFS_FS.has(fsType),
    overlay: OVERLAY_FS.has(fsType),
    drvfs: logicalRoot.startsWith("/mnt/") && DRVFS_FS.has(fsType),
    wsl,
    magic: magic ? `${magic.name ?? "unknown"}(${magic.hex})` : "unavailable",
  };
}

/**
 * P1 判定（纯函数）：只有**真实失败**才 FAIL；「大小写不敏感」给 WARN + 影响说明。
 * 平台差异只体现在**影响说明**里（APFS 默认不敏感 vs Linux 上的 vfat/ntfs/CIFS）。
 */
export function judgeCaseSensitivity(p) {
  if (!p.aliased) {
    return {
      level: "PASS",
      notes: [],
      detail: `fsType=${p.fsType} 大小写敏感=true（A/a 是两个不同实体）entries=${p.entries.join(",")}`,
    };
  }
  const platformHint = p.platform === "macOS"
    ? "APFS 默认大小写不敏感（磁盘工具可格式化为「APFS（区分大小写）」，但那是非默认配置）"
    : `非 POSIX 语义的文件系统（${p.fsType}）或挂载时指定了不敏感选项`;
  return {
    level: "WARN",
    notes: [{
      id: "case-insensitive",
      impact:
        `目标 FS 大小写不敏感（${platformHint}）：仅大小写不同的 goal id / version slug 会落到**同一实体**` +
        "（后写覆盖前者），`A`/`a` 目录也互相别名 ⇒ 看板可能静默串档；请勿只靠大小写区分实体。",
    }],
    detail: `fsType=${p.fsType} 大小写敏感=false fileAliased=${p.fileAliased} sameInode=${p.sameInode} dirAliased=${p.dirAliased}`,
  };
}

/**
 * P3 判定（纯函数）：识别挂载类型；网络/内存/WSL 桥接盘给 WARN + 影响说明。
 */
export function judgeMountType(p) {
  const notes = [];
  if (p.network) {
    notes.push({
      id: "network-mount",
      impact:
        `graph root 在网络挂载（${p.fsType}）上：本仓库的 advisory 锁（\`.lock.*\` + \`wx\` 独占创建）与 rename ` +
        "语义在 NFS/SMB 上不保证原子（NFSv3 无原子 rename、SMB 有写缓存）⇒ 并发 CAS 可能失效或假冲突、" +
        "原子写在读者侧可能看到半个文件。建议把 graph root 放在本地盘。",
    });
  }
  if (p.tmpfs) {
    notes.push({
      id: "tmpfs",
      impact: `graph root 在内存文件系统（${p.fsType}）上：重启即清空 ⇒ 看板/事件流**易失**；仅适合一次性探测。`,
    });
  }
  if (p.drvfs) {
    notes.push({
      id: "wsl-drvfs",
      impact:
        "graph root 在 WSL 的 drvfs/9p（`/mnt/*` 桥接 Windows 盘）上：大小写不敏感、无 POSIX 权限位、" +
        "跨设备 rename 受限、flock 不可靠 ⇒ 别名、锁失效、原子性下降会同时出现；请把工作区放在 ext4（`/home/...`）。",
    });
  }
  const detail =
    `fsType=${p.fsType} mount=${p.mountPoint} source=${p.source} magic=${p.magic} 表=${p.via} ` +
    `network=${p.network} tmpfs=${p.tmpfs} overlay=${p.overlay} drvfs=${p.drvfs} wsl=${p.wsl}`;
  return { level: notes.length > 0 ? "WARN" : "PASS", notes, detail };
}

/**
 * P2 判定（纯函数）：软链 root 必须被拒、物理路径必须通过。
 * FAIL 只留给真实缺陷：①软链 root **未被拒**（守卫失效）②**物理路径也被拒**（会话打不开看板）。
 */
export function judgeSymlinkRoot(p) {
  if (!p.engineLoaded) {
    return {
      level: "WARN",
      notes: [],
      detail: `未找到可载入的 dist/core/root.js ⇒ 未能实测（explicitSymlink=${p.explicitSymlink}）`,
    };
  }
  const basis = `logical(root)=${p.logicalRoot} physical(root)=${p.physicalRoot} repoPathSymlinked=${p.symlinkedRoot}`;
  if (!p.attempted) {
    return { level: "WARN", notes: [], detail: `${basis}；无法创建软链探测目录 ⇒ 该边界本机未实测` };
  }
  const detail =
    `软链root被拒=${p.explicitMessage !== null} 物理路径被拒=${p.physicalMessage !== null} ${basis}`;
  if (p.physicalMessage !== null) {
    return {
      level: "FAIL",
      notes: [],
      detail: `${detail}；物理路径也被拒（${p.physicalMessage}）`,
    };
  }
  if (p.explicitMessage !== SYMLINK_ROOT_MSG) {
    return {
      level: "FAIL",
      notes: [],
      detail:
        `${detail}；显式软链 root 未被正确拒绝（实际文案=${JSON.stringify(p.explicitMessage)}，` +
        `期望 ${JSON.stringify(SYMLINK_ROOT_MSG)}）`,
    };
  }
  return { level: "PASS", notes: [], detail };
}

const P1_CRITERION =
  "PASS = 目标 FS 大小写敏感（`A`/`a` 文件与目录都不互相别名）；" +
  "WARN = 大小写不敏感（**必须附影响说明**：仅大小写不同的 goal id / version slug 会互相别名、后写覆盖前者）" +
  "—— macOS 的 APFS 默认如此，Linux 上的 vfat/exfat/ntfs/CIFS 亦然；" +
  "FAIL = 探针自身异常（无法判定）。本项只报告风险，是否改引擎行为由负责人另行决策。";

const P2_CRITERION =
  "PASS = 自建软链目录（保证两个平台都能实测，不依赖 `/tmp` 是否软链）上的显式 root 被拒且报 " +
  "`graph root symlink is not allowed`，同时 realpath 后的物理路径解析通过；" +
  "WARN = 未构建 dist（载入不了真实 `resolveRoot`）或无法创建软链 ⇒ 该边界本机未实测；" +
  "FAIL = 软链 root **未被拒**（守卫失效）或**物理路径也被拒**（真实缺陷，会让本机会话完全打不开看板）。";

const P3_CRITERION =
  "PASS = 目标挂载点是本地盘（ext4/xfs/btrfs/apfs/hfs…），非网络挂载、非内存 FS、非 WSL drvfs；" +
  "WARN = 网络挂载 / tmpfs / WSL drvfs（**必须附影响说明**）；FAIL = 探针自身异常（无法判定）。" +
  "挂载表在 Linux 读 `/proc/mounts`、在 macOS 读 `mount(8)`（规范成同一形状，判定只有一份）。";

function checkCaseSensitivity(opt, repo, tmpRoot) {
  const id = "P1";
  const name = "大小写敏感性（建 A / a 是否互相别名，文件 + 目录）";
  let fs;
  try {
    fs = collectFsFacts(repo);
  } catch (e) {
    record(id, name, "FAIL", `探针异常：${String(e?.message ?? e)}`, P1_CRITERION);
    return;
  }
  let probe;
  try {
    const dir = mkdtempSync(join(tmpRoot, "case-probe-"));
    probe = probeCaseAliasing(dir);
  } catch (e) {
    record(id, name, "FAIL", `探针异常：${String(e?.message ?? e)}`, P1_CRITERION);
    return;
  }
  const verdict = judgeCaseSensitivity({ ...probe, fsType: fs.fsType, platform: PLATFORM_LABEL });
  record(id, name, verdict.level, verdict.detail, P1_CRITERION);
  for (const n of verdict.notes) console.log(`        · 影响 [${n.id}] ${n.impact}`);
}

/** 载入发布物里的真实实现（不复制其逻辑）；不可用时返回 null。 */
async function loadResolveRoot(repo) {
  const p = join(repo, "dist", "core", "root.js");
  if (!existsSync(p)) return null;
  try {
    const mod = await import(pathToFileURL(p).href);
    return typeof mod.resolveRoot === "function" ? mod.resolveRoot : null;
  } catch {
    return null;
  }
}

async function checkSymlinkRootBoundary(opt, repo, tmpRoot) {
  const id = "P2";
  const name = "软链 root 边界（显式软链 root 必须被拒 + 物理路径必须通过）";
  const logicalRoot = resolve(repo);
  let physicalRoot = logicalRoot;
  try { physicalRoot = realpathSync(logicalRoot); } catch { /* 保持逻辑路径 */ }
  const base = { logicalRoot, physicalRoot, symlinkedRoot: physicalRoot !== logicalRoot };
  const resolveRoot = await loadResolveRoot(repo);
  if (!resolveRoot) {
    const v = judgeSymlinkRoot({ ...base, engineLoaded: false, explicitSymlink: "(未构建 dist)" });
    record(id, name, "WARN", v.detail, P2_CRITERION);
    return;
  }
  let facts;
  try {
    const dir = mkdtempSync(join(tmpRoot, "root-probe-"));
    const realDir = join(dir, "real");
    mkdirSync(join(realDir, "graph"), { recursive: true });
    const linkDir = join(dir, "link");
    symlinkSync(realDir, linkDir, "dir");
    // 物理分支用 realpath 后的基准目录 ⇒ 该路径按构造不含软链
    const physicalBase = realpathSync(dir);
    facts = {
      ...base,
      engineLoaded: true,
      attempted: true,
      explicitSymlink: join(linkDir, "graph"),
      physical: join(physicalBase, "real", "graph"),
      explicitMessage: null,
      physicalMessage: null,
    };
    try { resolveRoot(null, facts.explicitSymlink); } catch (e) { facts.explicitMessage = String(e?.message ?? e); }
    try { resolveRoot(null, facts.physical); } catch (e) { facts.physicalMessage = String(e?.message ?? e); }
  } catch (e) {
    const v = judgeSymlinkRoot({ ...base, engineLoaded: true, attempted: false, explicitSymlink: `(创建失败：${String(e?.message ?? e)})` });
    record(id, name, "WARN", v.detail, P2_CRITERION);
    return;
  }
  const verdict = judgeSymlinkRoot(facts);
  record(id, name, verdict.level, verdict.detail, P2_CRITERION);
  for (const n of verdict.notes ?? []) console.log(`        · 影响 [${n.id}] ${n.impact}`);
}

function checkMountType(opt, repo) {
  const id = "P3";
  const name = "挂载类型识别（ext4/xfs/btrfs/apfs/hfs… vs overlayfs/tmpfs/网络挂载/WSL drvfs）";
  let fs;
  try {
    fs = collectFsFacts(repo);
  } catch (e) {
    record(id, name, "FAIL", `探针异常：${String(e?.message ?? e)}`, P3_CRITERION);
    return;
  }
  const verdict = judgeMountType(fs);
  record(id, name, verdict.level, verdict.detail, P3_CRITERION);
  for (const n of verdict.notes) console.log(`        · 影响 [${n.id}] ${n.impact}`);
}

// ---------------------------------------------------------------------------
// P6：locale / 编码（LANG=C 下 CJK 逐字节往返 + prompts 资产可读）
// ---------------------------------------------------------------------------

const P6_CHILD_SRC = `
import { pathToFileURL } from "node:url";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const [opsPath, root, promptsDir] = process.argv.slice(2);
const TITLE = "中文标题 · 跨平台门禁 P6（全角标点，、。！？）";
const BODY = "正文：汉字与全角标点，、。！？；：「」\\n第二行 ascii tail";
const out = { steps: [], ok: false, locale: process.env.LC_ALL || process.env.LANG || "(unset)" };
const step = (n, fn) => {
  try { const v = fn(); out.steps.push({ n, ok: true }); return v; }
  catch (e) { out.steps.push({ n, ok: false, err: String((e && e.message) || e) }); throw e; }
};
try {
  const ops = await import(pathToFileURL(opsPath).href);
  ops.init(root);
  const id = step("createGoal(CJK 标题)", () =>
    ops.createGoal(root, { title: TITLE, version: "v-l3-smoke", actor: "linux-smoke-l3" }));
  out.goal = id;
  step("setGoalDescription(CJK 正文)", () => ops.setGoalDescription(root, id, BODY, "linux-smoke-l3"));
  const file = step("findGoalFile", () => ops.findGoalFile(root, id));
  const raw = step("readFileSync(goal.md)", () => readFileSync(file));
  out.titleByteExact = raw.includes(Buffer.from(TITLE, "utf8"));
  out.bodyByteExact = raw.includes(Buffer.from(BODY, "utf8"));
  out.fileUtf8RoundTrip = Buffer.from(raw.toString("utf8"), "utf8").equals(raw);
  out.fileSha256 = createHash("sha256").update(raw).digest("hex");
  const names = readdirSync(promptsDir).filter((n) => statSync(join(promptsDir, n)).isFile());
  out.prompts = names.length;
  out.promptsByteExact = names.every((n) => {
    const b = readFileSync(join(promptsDir, n));
    return Buffer.from(b.toString("utf8"), "utf8").equals(b);
  });
  out.promptsNonAscii = names.filter((n) => /[^\\x00-\\x7f]/.test(readFileSync(join(promptsDir, n), "utf8"))).length;
  out.ok = out.titleByteExact && out.bodyByteExact && out.fileUtf8RoundTrip &&
    out.promptsByteExact && out.prompts > 0 && out.promptsNonAscii > 0;
  if (!out.ok) out.err = "字节往返断言未全部成立";
} catch (e) {
  out.ok = false;
  out.err = out.err || String((e && e.message) || e);
}
process.stdout.write("DSH_GATE_JSON:" + JSON.stringify(out) + "\\n");
`;

/** 解析子进程产出的 L3 结果行。 */
export function parseLocaleJson(out) {
  const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith("DSH_GATE_JSON:"));
  if (!line) return null;
  try { return JSON.parse(line.slice("DSH_GATE_JSON:".length)); } catch { return null; }
}

/** L3 判定（纯函数）。 */
export function judgeLocaleRoundTrip(p) {
  const problems = [];
  if (!p) return { level: "FAIL", problems: ["子进程未产出结果"], detail: "" };
  const failed = (p.steps ?? []).filter((s) => !s.ok);
  if (failed.length > 0) problems.push(failed.map((s) => `${s.n}: ${s.err}`).join(" | "));
  if (!p.titleByteExact) problems.push("CJK 标题在 goal.md 里不是逐字节往返");
  if (!p.bodyByteExact) problems.push("CJK 正文在 goal.md 里不是逐字节往返");
  if (!p.fileUtf8RoundTrip) problems.push("goal.md 整体 utf8 解码→再编码与原始字节不一致");
  if (!p.promptsByteExact) problems.push("prompts 资产在最小 locale 下不是逐字节可读");
  if (!(p.prompts > 0)) problems.push("prompts 目录为空（无法证明资产可读）");
  if (!(p.promptsNonAscii > 0)) problems.push("prompts 资产里未发现非 ASCII 内容（判别力不足）");
  return {
    level: problems.length > 0 ? "FAIL" : "PASS",
    problems,
    detail:
      `locale=${p.locale} goal=${p.goal ?? "-"} 标题逐字节=${p.titleByteExact} 正文逐字节=${p.bodyByteExact} ` +
      `goal.md往返=${p.fileUtf8RoundTrip} prompts=${p.prompts}(非ASCII ${p.promptsNonAscii}) prompts逐字节=${p.promptsByteExact}`,
    sha256: p.fileSha256,
  };
}

const P6_CRITERION =
  "PASS = 在 LANG=C/LC_ALL=C（最小 locale）下：`createGoal`(CJK 标题) + `setGoalDescription`(CJK 正文) + " +
  "读回 goal.md，标题与正文**逐字节**出现在文件里、整文件 utf8 往返无损、prompts 资产逐字节可读且含非 ASCII；" +
  "任一不满足即 FAIL（locale 相关的静默 mojibake 是真实数据损坏）。平台差异只在 locale 名（本机是 C；" +
  "macOS 上同名的 C locale 也是最小 locale），判定代码只有一份。";

function checkLocaleEncoding(opt, repo, tmpRoot) {
  const id = "P6";
  const name = "locale/编码（LANG=C 下 CJK 正文与 prompts 资产逐字节往返）";
  const opsPath = join(repo, "dist", "core", "ops.js");
  const promptsDir = join(repo, "dist", "prompts");
  if (!existsSync(opsPath) || !existsSync(promptsDir)) {
    record(id, name, "WARN", `未找到 ${opsPath} / ${promptsDir}：请先 \`pnpm build\``, P6_CRITERION);
    return;
  }
  const dir = join(tmpRoot, "l3");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "l3-locale.mjs");
  writeFileSync(script, P6_CHILD_SRC, "utf8");
  const graphRoot = join(dir, "graph");
  mkdirSync(graphRoot, { recursive: true });
  const r = spawnSync(process.execPath, [script, opsPath, graphRoot, promptsDir], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, LANG: "C", LC_ALL: "C", TMPDIR: dir },
  });
  const parsed = parseLocaleJson(r.stdout ?? "");
  const verdict = judgeLocaleRoundTrip(parsed);
  if (verdict.level === "FAIL") {
    const errTail = (r.stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" / ");
    record(id, name, "FAIL", `${verdict.problems.join(" / ")}${errTail ? ` :: ${errTail}` : ""}`, P6_CRITERION);
    return;
  }
  record(id, name, "PASS", `${verdict.detail} sha256=${verdict.sha256.slice(0, 16)}…`, P6_CRITERION);
}

// ---------------------------------------------------------------------------
// P4/P5：锁与原子写（并发 CAS + 原子写 + 跨 FS rename EXDEV）
// ---------------------------------------------------------------------------

const P4_CAS_SRC = `
import { pathToFileURL } from "node:url";
const [opsPath, root, mode, goal, tag] = process.argv.slice(2);
const ops = await import(pathToFileURL(opsPath).href);
if (mode === "setup") {
  try {
    ops.init(root);
    const id = ops.createGoal(root, { title: "linux smoke L4", version: "v-l4-smoke", actor: "linux-smoke" });
    ops.setGoalTags(root, id, { tags: [], force: true, actor: "linux-smoke" });
    process.stdout.write("L4_SETUP:" + JSON.stringify({ ok: true, goal: id }) + "\\n");
  } catch (e) {
    process.stdout.write("L4_SETUP:" + JSON.stringify({ ok: false, err: String((e && e.message) || e) }) + "\\n");
  }
} else {
  try {
    ops.setGoalTags(root, goal, { tags: [tag], base_tags: [], actor: "linux-smoke-" + tag });
    process.stdout.write("L4_TAG_OK\\n");
  } catch (e) {
    const msg = String((e && e.message) || e);
    const conflict = e?.name === "GraphConflictError" || e?.constructor?.name === "GraphConflictError" ||
      /已被其他人修改|已被外部|冲突|conflict|CAS|刷新后重试/i.test(msg);
    process.stdout.write((conflict ? "L4_TAG_CONFLICT" : "L4_TAG_ERROR") + ":" + msg + "\\n");
  }
}
`;

const P4_ATOMIC_SRC = `
import { pathToFileURL } from "node:url";
const [txPath, target, idx] = process.argv.slice(2);
const tx = await import(pathToFileURL(txPath).href);
const payload = "W" + idx + ":" + "x".repeat(4096) + ":" + idx + "\\n";
tx.atomicWrite(target, payload);
process.stdout.write("L4_ATOMIC_OK:" + idx + "\\n");
`;

/** 一次读取到的内容是否是**完整**的一次原子写产物（不是半个/交错内容）。 */
export function isCompleteAtomicPayload(s) {
  const m = /^W(\d+):(x+):(\d+)\n$/.exec(s);
  if (!m) return false;
  return m[1] === m[3] && m[2].length === 4096;
}

/** L4.1 并发 CAS 判定（纯函数）：4 抢 1 必须恰好 1 成功 3 冲突。 */
export function judgeConcurrentCas(p) {
  const problems = [];
  if (!(p.ok === 1) || !(p.conflict === 3) || !(p.error === 0)) {
    problems.push(`期望 成功=1 冲突=3 异常=0，实际 成功=${p.ok} 冲突=${p.conflict} 异常=${p.error}` +
      (p.errors?.length ? ` :: ${p.errors.slice(0, 2).join(" | ")}` : ""));
  }
  return {
    level: problems.length > 0 ? "FAIL" : "PASS",
    problems,
    detail: `成功=${p.ok} 冲突=${p.conflict} 异常=${p.error}`,
  };
}

/**
 * L4.2 原子写判定（纯函数）：16 个写者并发写同一目标、同时轮询读者
 * ⇒ 读者**永远**不能看到半个/交错内容（torn read），且最终内容必须是完整产物、无 `.tmp.` 残留。
 */
export function judgeAtomicWrite(p) {
  const problems = [];
  if (!(p.writersOk === p.writers)) problems.push(`写者成功 ${p.writersOk}/${p.writers}`);
  if (p.torn > 0) problems.push(`观察到 ${p.torn} 次**撕裂读**（读者看到了非完整内容 ⇒ 原子性被破坏）`);
  if (!p.finalComplete) problems.push(`最终内容不是完整产物（长度 ${p.finalLength}）`);
  if (p.leftovers.length > 0) problems.push(`残留临时文件 ${p.leftovers.join(",")}`);
  if (!(p.reads > 0)) problems.push("轮询读者一次都没读到内容（判别力不足）");
  return {
    level: problems.length > 0 ? "FAIL" : "PASS",
    problems,
    detail: `写者=${p.writersOk}/${p.writers} 读次数=${p.reads} 撕裂读=${p.torn} 最终完整=${p.finalComplete} 残留=${p.leftovers.length}`,
  };
}

/** L4.3 跨文件系统 rename(EXDEV) 判定（纯函数）。 */
export function judgeExdev(p) {
  if (!p.attempted) {
    return {
      level: "WARN",
      problems: [],
      detail: `未找到可写的第二文件系统（候选：${(p.candidates ?? []).join(", ") || "无"}）`,
      impact:
        "跨 FS rename(EXDEV) 未在本机实测。代码侧缓解：`atomicWrite` 的临时文件与目标**同目录**" +
        "（`<dest>.tmp.<pid>`）⇒ 正常写路径不会跨设备；但若 graph root 本身在网络/挂载 FS 上，" +
        "原子性仍取决于该 FS 的 rename 语义（见 L2）。",
    };
  }
  if (p.renameCode === null) {
    return {
      level: "WARN",
      problems: [],
      detail: `跨设备 rename 竟然成功（dev ${p.srcDev}→${p.dstDev}，secondFs=${p.secondFs}）`,
      impact: "设备号不同却未返回 EXDEV ⇒ 可能是同一文件系统的 bind mount；不能据此判定跨 FS 行为，建议人工确认。",
    };
  }
  if (p.renameCode !== "EXDEV") {
    return {
      level: "WARN",
      problems: [],
      detail: `跨设备 rename 返回 ${p.renameCode}（非 EXDEV，secondFs=${p.secondFs}）`,
      impact: `非 EXDEV 的失败码（如 EACCES/EPERM）通常来自沙盒/挂载权限，而非设备边界 ⇒ 跨 FS 行为仍未证实。`,
    };
  }
  const problems = [];
  if (!p.srcIntact) problems.push("EXDEV 后源文件消失（数据丢失风险）");
  if (p.dstExists) problems.push("EXDEV 后目标文件竟存在（语义异常）");
  if (!p.codePropagates) problems.push("`dist/core/platform.js` 的 replaceFileAtomic 未向上抛 EXDEV（可能静默降级为拷贝 ⇒ 原子性丧失）");
  return {
    level: problems.length > 0 ? "FAIL" : "PASS",
    problems,
    detail:
      `secondFs=${p.secondFs}(${p.secondFsType}) dev ${p.srcDev}→${p.dstDev} rename=${p.renameCode} ` +
      `源保留=${p.srcIntact} 目标未落地=${!p.dstExists} replaceFileAtomic 抛出=${p.codePropagates}`,
  };
}

const P4_CRITERION =
  "P4/P5 分三项：**P4.a 并发 CAS** PASS = 4 个独立进程以同一 base_tags 抢写、恰好 1 成功 3 冲突 0 异常；" +
  "**P4.b 原子写** PASS = 16 并发写者全部成功、轮询读者 0 次撕裂读、最终内容是完整产物、无 `.tmp.` 残留；" +
  "**P5 跨 FS rename(EXDEV)** PASS = 对可写的第二文件系统实测 rename 返回 EXDEV、源文件保留、目标未落地，" +
  "且发布物 `dist/core/platform.js` 的 `replaceFileAtomic` 如实向上抛（不静默降级为拷贝）；" +
  "无可写第二 FS ⇒ WARN + 影响说明（跨 FS 行为未实测，代码侧靠「临时文件与目标同目录」规避）；" +
  "撕裂读/静默降级/数据丢失 ⇒ FAIL。三项都在**目标 FS 上**实测，与平台无关。";

async function checkLockAndAtomic(opt, repo, tmpRoot) {
  const opsPath = join(repo, "dist", "core", "ops.js");
  const txPath = join(repo, "dist", "core", "transaction.js");
  const platformPath = join(repo, "dist", "core", "platform.js");
  if (!existsSync(opsPath) || !existsSync(txPath)) {
    record("P4.a", "并发 CAS（4 抢 1）", "WARN", `未找到 ${opsPath} / ${txPath}：请先 \`pnpm build\``, P4_CRITERION);
    record("P4.b", "原子写（并发写者 + 轮询读者）", "WARN", "同上（需 dist/core/*.js）", P4_CRITERION);
    record("P5", "跨 FS rename(EXDEV)", "WARN", "同上（需 dist/core/*.js）", P4_CRITERION);
    return;
  }

  const dir = join(tmpRoot, "l4");
  mkdirSync(dir, { recursive: true });
  const casScript = join(dir, "l4-cas.mjs");
  const atomicScript = join(dir, "l4-atomic.mjs");
  writeFileSync(casScript, P4_CAS_SRC, "utf8");
  writeFileSync(atomicScript, P4_ATOMIC_SRC, "utf8");
  const graphRoot = join(dir, "graph");
  mkdirSync(graphRoot, { recursive: true });

  // ---- L4.1 并发 CAS ----
  const setup = spawnSync(process.execPath, [casScript, opsPath, graphRoot, "setup"], { encoding: "utf8", timeout: 120_000 });
  let setupJson = null;
  for (const line of (setup.stdout ?? "").split(/\r?\n/)) {
    if (line.startsWith("L4_SETUP:")) { try { setupJson = JSON.parse(line.slice("L4_SETUP:".length)); } catch { /* 忽略 */ } }
  }
  if (!setupJson?.ok) {
    record("P4.a", "并发 CAS（4 抢 1）", "FAIL",
      `建目标失败，无法进行并发 CAS：${setupJson?.err ?? (setup.stderr ?? "").trim().split(/\r?\n/)[0] ?? `exit=${setup.status}`}`,
      P4_CRITERION);
  } else {
    const settled = await Promise.all([0, 1, 2, 3].map((i) => new Promise((res) => {
      const c = spawn(process.execPath, [casScript, opsPath, graphRoot, "race", setupJson.goal, `w${i}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "", err = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (err += d));
      c.on("close", () => res({ out, err }));
    })));
    const ok = settled.filter((s) => s.out.includes("L4_TAG_OK")).length;
    const conflict = settled.filter((s) => s.out.includes("L4_TAG_CONFLICT")).length;
    const errors = settled.filter((s) => s.out.includes("L4_TAG_ERROR") || !s.out.trim());
    const verdict = judgeConcurrentCas({
      ok, conflict, error: errors.length,
      errors: errors.map((e) => (e.out + e.err).trim().split(/\r?\n/)[0]),
    });
    record("P4.a", "并发 CAS（4 抢 1）", verdict.level, verdict.problems.join(" / ") || verdict.detail, P4_CRITERION);
  }

  // ---- L4.2 原子写 ----
  const target = join(dir, "atomic-target.txt");
  const WRITERS = 16;
  const writers = [];
  let writersOk = 0;
  const writerSettled = Promise.all(Array.from({ length: WRITERS }, (_, i) => new Promise((res) => {
    const c = spawn(process.execPath, [atomicScript, txPath, target, String(i)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => { if (out.includes("L4_ATOMIC_OK")) writersOk++; res(); });
  })));
  let reads = 0, torn = 0, last = "";
  let writersSettled = false;
  writerSettled.then(() => { writersSettled = true; });
  while (!writersSettled) {
    if (existsSync(target)) {
      try {
        const s = readFileSync(target, "utf8");
        last = s;
        reads++;
        if (!isCompleteAtomicPayload(s)) torn++;
      } catch { /* 读取瞬态：忽略 */ }
    }
    await sleep(1);
  }
  await writerSettled;
  const finalText = existsSync(target) ? readFileSync(target, "utf8") : "";
  const leftovers = readdirSync(dir).filter((n) => n.includes(".tmp.")).sort();
  const atomicVerdict = judgeAtomicWrite({
    writers: WRITERS,
    writersOk,
    reads,
    torn,
    finalComplete: isCompleteAtomicPayload(finalText) || isCompleteAtomicPayload(last),
    finalLength: finalText.length,
    leftovers,
  });
  record("P4.b", "原子写（并发写者 + 轮询读者）", atomicVerdict.level,
    atomicVerdict.problems.join(" / ") || atomicVerdict.detail, P4_CRITERION);

  // ---- L4.3 跨 FS rename(EXDEV) ----
  const exdev = probeExdev(dir, platformPath);
  const exdevVerdict = judgeExdev(exdev);
  record("P5", "跨 FS rename(EXDEV)", exdevVerdict.level,
    exdevVerdict.problems.join(" / ") || exdevVerdict.detail, P4_CRITERION);
  if (exdevVerdict.impact) console.log(`        · 影响 ${exdevVerdict.impact}`);
}

// 供 L4.2 的轮询循环使用的小工具。
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 显式探测跨文件系统 rename：找一个**可写的第二文件系统**（与 graph root 不同 dev），
 * 实测 rename 是否抛 EXDEV，并断言发布物的 `replaceFileAtomic` **如实向上抛**（不静默降级为拷贝）。
 */
function probeExdev(dir, platformPath) {
  const candidates = ["/dev/shm", "/tmp", process.env.XDG_RUNTIME_DIR, "/var/tmp"].filter(Boolean);
  const srcDir = join(dir, "exdev-src");
  mkdirSync(srcDir, { recursive: true });
  const srcDev = statSync(srcDir).dev;
  for (const cand of candidates) {
    let st;
    try { st = statSync(cand); } catch { continue; }
    if (!st.isDirectory() || st.dev === srcDev) continue;
    let probeDir;
    try { probeDir = mkdtempSync(join(cand, "dsh-graph-exdev-")); } catch { continue; }
    try {
      const src = join(srcDir, "payload.txt");
      writeFileSync(src, "exdev-probe", "utf8");
      const dst = join(probeDir, "payload.txt");
      let renameCode = null;
      try { renameSync(src, dst); } catch (e) { renameCode = e?.code ?? "UNKNOWN"; }
      const srcIntact = existsSync(src);
      const dstExists = existsSync(dst);
      let codePropagates = false;
      if (renameCode === "EXDEV" && platformPath && existsSync(platformPath)) {
        // 再走一遍发布物里的原子替换实现：它必须把 EXDEV 抛出来（否则原子写会静默退化成拷贝）
        writeFileSync(src, "exdev-probe-2", "utf8");
        codePropagates = spawnSync(process.execPath, [
          "--input-type=module", "-e",
          `const m = await import(${JSON.stringify(pathToFileURL(platformPath).href)});` +
          `try { m.replaceFileAtomic(${JSON.stringify(src)}, ${JSON.stringify(dst)}); process.stdout.write("OK_COPY"); }` +
          `catch (e) { process.stdout.write("THREW:" + (e && e.code)); }`,
        ], { encoding: "utf8", timeout: 60_000 }).stdout?.includes("THREW:EXDEV") === true;
      }
      return {
        attempted: true,
        candidates,
        secondFs: cand,
        secondFsType: (findMountForPath(cand, safeRead("/proc/mounts")) ?? {}).fstype ?? "?",
        srcDev, dstDev: st.dev,
        renameCode, srcIntact, dstExists, codePropagates,
      };
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  }
  return { attempted: false, candidates, srcDev };
}

function safeRead(file) {
  try { return readFileSync(file, "utf8"); } catch { return ""; }
}

// ---------------------------------------------------------------------------
// M4：Linux-only 假设扫描
// ---------------------------------------------------------------------------

/** 行是否整行注释（`#` / `//` / `*` / `/*` 起始）。 */
export function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("#") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * 「有意样本」区域标记：区域内出现的 Linux-only 字面量是**测试样本**（只做字符串比较，
 * 不执行），不应计入隐患。理由：M4 自身的判别力测试必然要写出这些字面量，否则无从证明
 * 「真隐患必红」。标记在任意文件生效、必须成对出现，且扫描会打印被忽略的处数 —— 不是隐形豁免。
 */
const SCAN_IGNORE_BEGIN = "dsh-macos-gate:ignore-linux-only-probes";
const SCAN_IGNORE_END = "dsh-macos-gate:end-ignore-linux-only-probes";

/** 逐行标记：true = 落在 ignore 区域内（含标记行自身）。 */
export function ignoredLineMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(SCAN_IGNORE_BEGIN)) depth++;
    mask[i] = depth > 0;
    if (lines[i].includes(SCAN_IGNORE_END)) depth = Math.max(0, depth - 1);
  }
  return mask;
}

/**
 * 已由「能力探测 + 回退」覆盖：同文件里含 `mv --exchange --help` 探测。
 * （build.sh 正是这个形态；测试里出现该字面量则表示在断言/复刻该探测。）
 */
function coveredByExchangeProbe(hit) {
  if (/--exchange\s+--help/.test(hit.fileText)) {
    return {
      covered: true,
      why: "同文件含 `mv --exchange --help` 能力探测（不假定 mv 支持该选项），并有两次 rename 回退",
    };
  }
  return {
    covered: false,
    why: "使用 GNU coreutils 专有的 mv 选项，同文件没有能力探测/回退",
    advice: "加 `mv --exchange --help` 探测 + 两次 rename 兜底（build.sh 的现成形态）",
  };
}

/** Linux-only 假设表：检测正则 + 判定函数（返回 { covered, why, advice? }）。 */
export const LINUX_ONLY_PATTERNS = [
  {
    id: "renameat2",
    label: "renameat2(RENAME_EXCHANGE) 系统调用",
    re: /\brenameat2\b/,
    judge: coveredByExchangeProbe,
  },
  {
    id: "mv-exchange",
    label: "GNU mv 专有选项（--exchange / -T）",
    re: /\bmv\s+(?:-T\s+)?--exchange\b|\bmv\s+-T\b/,
    judge: coveredByExchangeProbe,
  },
  {
    id: "readlink-f",
    label: "readlink -f",
    re: /\breadlink\b[^\n]*\s-f\b/,
    judge: () => ({
      covered: false,
      why: "macOS/BSD 的 readlink 没有 -f（GNU 专有）",
      advice: "改用 realpath，或 `cd <dir> && pwd -P`",
    }),
  },
  {
    id: "stat-c",
    label: "stat -c",
    re: /\bstat\b[^\n]*(?:\s|^)-c\b/,
    judge: () => ({
      covered: false,
      why: "macOS/BSD 的 stat 用 -f，不认 GNU 的 -c",
      advice: "改用 stat -f，或统一走 Node fs.statSync",
    }),
  },
  {
    id: "md5sum",
    label: "md5sum",
    re: /\bmd5sum\b/,
    judge: () => ({
      covered: false,
      why: "macOS 没有 md5sum",
      advice: "改用 `md5 -r`，或 Node crypto",
    }),
  },
  {
    id: "sha256sum",
    label: "sha256sum",
    re: /\bsha256sum\b/,
    judge: () => ({
      covered: false,
      why: "macOS 没有 sha256sum（BSD 系只有 shasum / openssl）",
      advice: "改用 `shasum -a 256`，或 Node crypto（win-smoke-test.mjs 就是 Node 实现）",
    }),
  },
  {
    id: "sed-i-no-backup",
    label: "sed -i（未给 backup 后缀）",
    re: /\bsed\b[^\n]*(?:\s|^)-i(?![\w.'"])/,
    judge: () => ({
      covered: false,
      why: "BSD/macOS 的 `sed -i` 必须带 backup 后缀参数，否则直接报错",
      advice: "写成 `sed -i '' 's/x/y/'`，或用临时文件 + mv",
    }),
  },
  {
    id: "grep-P",
    label: "grep -P（PCRE）",
    re: /\bgrep\b[^\n]*\s-[a-zA-Z]*P[a-zA-Z]*\b/,
    judge: () => ({
      covered: false,
      why: "BSD/macOS 的 grep 没有 -P",
      advice: "改用 grep -E，或 Node 正则",
    }),
  },
  {
    id: "date-d",
    label: "date -d",
    re: /\bdate\b[^\n]*(?:\s|^)-d\b/,
    judge: () => ({
      covered: false,
      why: "macOS/BSD 的 date 用 `-j -f` 解析日期，没有 GNU 的 -d",
      advice: "改用 BSD 形式，或 Node Date",
    }),
  },
  {
    id: "cp-reflink",
    label: "cp --reflink",
    re: /\bcp\b[^\n]*--reflink\b/,
    judge: () => ({
      covered: false,
      why: "macOS/BSD 的 cp 没有 --reflink（GNU 专有）",
      advice: "去掉该选项（macOS 可用 clonefile 语义工具，但非本仓库依赖）",
    }),
  },
  {
    id: "mktemp-d-no-template",
    label: "mktemp -d（未给模板）",
    re: /\bmktemp\s+-[a-zA-Z]*d[a-zA-Z]*(?=\s*(?:[;&|)]|$))/,
    judge: () => ({
      covered: false,
      why: "省略模板时默认目录/行为在 GNU 与 BSD/macOS 之间不保证一致",
      advice: '显式写模板：`mktemp -d "${TMPDIR:-/tmp}/xxx.XXXXXX"`',
    }),
  },
];

/**
 * 扫描一批文件，返回全部命中（含判定）。
 * files: [{ path, fileClass: "release"|"test"|"archived", text }]
 * 落在 `dsh-macos-gate:ignore-linux-only-probes` 标记区域内的行被跳过（有意样本，见 ignoredLineMask）。
 */
export function scanLinuxOnlyAssumptions(files) {
  const hits = [];
  for (const f of files) {
    const lines = f.text.split(/\r?\n/);
    const ignored = ignoredLineMask(lines);
    for (const def of LINUX_ONLY_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (ignored[i]) continue;
        const text = lines[i];
        if (!def.re.test(text)) continue;
        const hit = {
          id: def.id,
          label: def.label,
          file: f.path,
          fileClass: f.fileClass,
          line: i + 1,
          text: text.trim(),
          comment: isCommentLine(text),
          fileText: f.text,
        };
        // 统一前置：注释/说明文案不可执行，一律判「已覆盖」（模式表无需各自重复这条规则）。
        const verdict = hit.comment
          ? { covered: true, why: "仅出现在注释/说明文案里，不是可执行调用" }
          : def.judge(hit);
        hits.push({ ...hit, covered: verdict.covered, why: verdict.why, advice: verdict.advice ?? "" });
      }
    }
  }
  return hits;
}

/** 收集扫描目标：scripts/*.sh、scripts/*.mjs（顶层）与 core/tests/**（递归）；archived 另列。 */
export function collectScanFiles(repo) {
  const gated = [];
  const archived = [];
  const readAt = (abs, fileClass) => {
    try {
      return { path: rel(repo, abs), fileClass, text: readFileSync(abs, "utf8") };
    } catch {
      return null;
    }
  };
  const scriptsDir = join(repo, "scripts");
  if (existsSync(scriptsDir)) {
    for (const name of readdirSync(scriptsDir)) {
      const abs = join(scriptsDir, name);
      if (!statSync(abs).isFile()) continue;
      if (name === SELF_FILE) continue; // 豁免：模式定义表自身必然含这些字面量（判别力由 --self-test 固化）
      if (!name.endsWith(".sh") && !name.endsWith(".mjs")) continue;
      const f = readAt(abs, "release");
      if (f) gated.push(f);
    }
  }
  const walk = (dir, fileClass, sink) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, fileClass, sink);
      else {
        const f = readAt(abs, fileClass);
        if (f) sink.push(f);
      }
    }
  };
  walk(join(repo, "core", "tests"), "test", gated);
  walk(join(repo, "scripts", "archived"), "archived", archived);
  return { gated, archived };
}

const M4_CRITERION =
  "每命中判「已被回退覆盖」或「隐患」：发布/测试路径（scripts 顶层 + core/tests）里的隐患 ⇒ FAIL；" +
  "archived 脚本只列 INFO（非发布路径，不计门禁）；全为已覆盖 ⇒ PASS。" +
  ` 唯一豁免 ${SELF_FILE} 自身（其模式定义表必然含这些字面量，判别力由 --self-test 固化）。`;

function checkLinuxOnlyAssumptions(repo) {
  const id = "M4";
  const name = "Linux-only 假设扫描";
  const { gated, archived } = collectScanFiles(repo);
  const gatedHits = scanLinuxOnlyAssumptions(gated);
  const archivedHits = scanLinuxOnlyAssumptions(archived);
  const risks = gatedHits.filter((h) => !h.covered);
  const covered = gatedHits.filter((h) => h.covered);

  console.log(`        扫描 ${gated.length} 个文件（scripts 顶层 + core/tests）⇒ 命中 ${gatedHits.length} 处` +
    `（已覆盖 ${covered.length} / 隐患 ${risks.length}）`);
  const ignoredLines = [...gated, ...archived].reduce(
    (n, f) => n + ignoredLineMask(f.text.split(/\r?\n/)).filter(Boolean).length,
    0,
  );
  if (ignoredLines > 0) {
    console.log(`        有意样本区域：跳过 ${ignoredLines} 行（标记 ${SCAN_IGNORE_BEGIN} … ${SCAN_IGNORE_END}）`);
  }
  for (const h of covered) {
    console.log(`        · 已覆盖 ${h.file}:${h.line} [${h.id}] — ${h.why}`);
  }
  for (const h of risks) {
    console.log(`        · 隐患   ${h.file}:${h.line} [${h.id}] — ${h.why}${h.advice ? ` ⇒ ${h.advice}` : ""}`);
  }
  for (const h of archivedHits) {
    console.log(
      `        · archived(不计门禁) ${h.file}:${h.line} [${h.id}] — ${h.covered ? "已覆盖" : "隐患"}：${h.why}` +
        `${!h.covered && h.advice ? ` ⇒ ${h.advice}` : ""}`,
    );
  }

  if (risks.length > 0) {
    record(id, name, "FAIL", `${risks.length} 处隐患（发布/测试路径）：${risks.map((h) => `${h.file}:${h.line} [${h.id}]`).join("; ")}`, M4_CRITERION);
    return;
  }
  if (gatedHits.length === 0) {
    record(id, name, "PASS", `扫描 ${gated.length} 个文件：零命中`, M4_CRITERION);
    return;
  }
  record(
    id,
    name,
    "PASS",
    `命中 ${gatedHits.length} 处全部已被特性探测/回退覆盖（${[...new Set(covered.map((h) => h.id))].join(", ")}）` +
      (archivedHits.length ? `；archived 另 ${archivedHits.length} 处仅列 INFO` : ""),
    M4_CRITERION,
  );
}

// ---------------------------------------------------------------------------
// 转发给 win-smoke-test.mjs（不复制其逻辑）
// ---------------------------------------------------------------------------

/** 把本脚本收到的门禁参数原样转成 win-smoke-test.mjs 的 argv（顺序稳定，便于自检）。 */
export function buildForwardArgs(opt) {
  const args = [];
  const push = (flag, value) => {
    if (value !== undefined && value !== null) args.push(flag, String(value));
  };
  push("--tarball", opt.tarball);
  push("--spec", opt.spec);
  push("--path", opt.path);
  push("--static-only", opt.staticOnly);
  if (opt.selfTest) args.push("--self-test");
  push("--port", opt.port);
  push("--profile", opt.profile);
  push("--dsh-home", opt.dshHome);
  push("--dsh", opt.dsh);
  push("--timeout", opt.timeout);
  return args;
}

/**
 * 用户是否**显式要求**转发：只有指定了安装来源/静态目录/自检才转发。
 * （`--profile`/`--dsh-home` 有默认值，不能用来判定「用户想跑 T1–T5」——否则不带任何参数
 * 运行时也会去 registry 装一次插件。）
 */
export function forwardRequested(opt) {
  return Boolean(opt.tarball || opt.spec || opt.path || opt.staticOnly || opt.selfTest);
}

/**
 * 转发子进程的环境：`npm_config_cache` 与 `TMPDIR` 一律落仓库内 tmp/。
 * 原因：沙盒只允许写工作区；`npx`/`npm pack`/`pnpm plugin add` 会写缓存与临时目录，
 * 落到系统 /tmp 会在受限环境里失败（或被静默拒绝）。
 */
export function forwardEnv(repo, base = process.env) {
  const env = { ...base };
  const repoAbs = resolve(repo);
  if (!env.npm_config_cache) env.npm_config_cache = join(repoAbs, "tmp", "npm-cache");
  const envTmp = env.TMPDIR ? resolve(env.TMPDIR) : null;
  if (!envTmp || !(envTmp === repoAbs || envTmp.startsWith(repoAbs + sep))) {
    env.TMPDIR = join(repoAbs, "tmp", "platform-gate", "forward-tmp");
  }
  return env;
}

function forwardSmoke(opt, repo) {
  const args = buildForwardArgs(opt);
  const script = join(repo, "scripts", "win-smoke-test.mjs");
  if (!existsSync(script)) {
    record("T*", "转发 win-smoke-test.mjs", "WARN", `未找到 ${script}`, "转发失败不改变 P1–P6/M4 的结论。");
    return null;
  }
  if (!forwardRequested(opt) || args.length === 0) {
    record("T*", "转发 win-smoke-test.mjs", "SKIP",
      "未提供 --tarball/--spec/--path/--static-only/--self-test（本次只跑平台探针 P1–P6 + M4）",
      "完整门禁请加 `--tarball <path>/dsh-graph-<version>.tgz`（或先 `--static-only .` 做秒级预检）；" +
      "只给 --dsh-home/--profile 不会触发转发。");
    return null;
  }
  head(`转发：node scripts/win-smoke-test.mjs ${args.join(" ")}`);
  const env = forwardEnv(repo);
  const r = spawnSync(process.execPath, [script, ...args], { cwd: repo, stdio: "inherit", env });
  const status = r.status ?? 1;
  console.log("");
  printPlatformValidity();
  record("T*", `转发 win-smoke-test.mjs（${args.join(" ")}）`, status === 0 ? "PASS" : "FAIL", `exit=${status}`,
    IS_SUPPORTED
      ? `结论对 **${PLATFORM_LABEL}** 具平台效力（本机原生 ${PLATFORM_LABEL}，T3–T5 真跑）；『非 win32…』免责声明只针对 Windows 真机结论。`
      : `本机平台 ${process.platform} 非 macOS/Linux ⇒ 平台效力声明不成立，请在原生 macOS 或 Linux 上重跑。`);
  return status;
}

// ---------------------------------------------------------------------------
// --self-test：离线自检（无需网络 / 无需已构建 dist）
// ---------------------------------------------------------------------------

export function selfCheck() {
  head("自检（本脚本自身的探针、判定与转发参数）");
  let bad = 0;
  const check = (name, cond) => {
    if (cond) console.log(`[ OK ] ${name}`);
    else { bad++; console.error(`[FAIL] ${name}`); }
  };

  // 沙箱根：永不默认落系统 /tmp（沙盒只允许写工作区；且 FS 探针要与 graph root 同 FS）
  const prevTmp = process.env.TMPDIR;
  try {
    delete process.env.TMPDIR;
    check("沙箱根默认落仓库内 tmp/platform-gate", resolveTempRoot("/repo/x", null) === join("/repo/x", "tmp", "platform-gate"));
    process.env.TMPDIR = "/tmp";
    check("系统 /tmp 被忽略（绝不落系统临时目录）", resolveTempRoot("/repo/x", null) === join("/repo/x", "tmp", "platform-gate"));
    process.env.TMPDIR = "/repo/x/tmp/platform-gate";
    check("仓库内 TMPDIR 被沿用（不重复拼接）", resolveTempRoot("/repo/x", null) === "/repo/x/tmp/platform-gate");
    check("--temp-root 优先", resolveTempRoot("/repo/x", "/custom") === "/custom");
  } finally {
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
  }

  // P1 大小写：两侧都可判别
  const caseOk = judgeCaseSensitivity({ aliased: false, fsType: "ext4", platform: "Linux", entries: ["A", "a"] });
  check("P1：大小写敏感判 PASS", caseOk.level === "PASS" && caseOk.notes.length === 0);
  const caseBad = judgeCaseSensitivity({ aliased: true, fileAliased: true, fsType: "apfs", platform: "macOS", entries: ["A"] });
  check("P1：大小写不敏感判 WARN 且附影响说明", caseBad.level === "WARN" && caseBad.notes[0].impact.length > 30);
  check("P1：macOS 的影响说明点出 APFS 默认不敏感", /APFS/.test(caseBad.notes[0].impact));
  const caseBadLinux = judgeCaseSensitivity({ aliased: true, fsType: "vfat", platform: "Linux", entries: ["A"] });
  check("P1：Linux 上的不敏感 FS 影响说明点出非 POSIX 语义", /非 POSIX/.test(caseBadLinux.notes[0].impact));

  // P2 软链 root 边界：三态
  const symPass = judgeSymlinkRoot({
    engineLoaded: true, attempted: true, explicitMessage: SYMLINK_ROOT_MSG, physicalMessage: null,
    logicalRoot: "/a", physicalRoot: "/a", symlinkedRoot: false,
  });
  check("P2：被拒 + 物理路径通过 ⇒ PASS", symPass.level === "PASS");
  const symNoReject = judgeSymlinkRoot({
    engineLoaded: true, attempted: true, explicitMessage: null, physicalMessage: null,
    logicalRoot: "/a", physicalRoot: "/a", symlinkedRoot: false,
  });
  check("P2：软链 root 未被拒 ⇒ FAIL（守卫失效）", symNoReject.level === "FAIL");
  const symPhys = judgeSymlinkRoot({
    engineLoaded: true, attempted: true, explicitMessage: SYMLINK_ROOT_MSG, physicalMessage: SYMLINK_ROOT_MSG,
    logicalRoot: "/a", physicalRoot: "/a", symlinkedRoot: false,
  });
  check("P2：物理路径也被拒 ⇒ FAIL（真实缺陷）", symPhys.level === "FAIL");
  check("P2：未构建 dist ⇒ WARN（未实测，不冒充通过）",
    judgeSymlinkRoot({ engineLoaded: false, explicitSymlink: "x", logicalRoot: "/a", physicalRoot: "/a", symlinkedRoot: false }).level === "WARN");

  // P3 挂载表解析 + 判定两侧（含 macOS `mount(8)` 形态）
  const procMounts = "/dev/sda1 / ext4 rw 0 0\ntmpfs /tmp tmpfs rw 0 0\n//srv/share /mnt/share cifs rw 0 0\n/dev/sdb1 /mnt/share/deep ext4 rw 0 0";
  check("挂载表：最长前缀优先", findMountForPath("/mnt/share/deep/f", procMounts).mountPoint === "/mnt/share/deep");
  check("挂载表：/tmp 命中 tmpfs", findMountForPath("/tmp/x", procMounts).fstype === "tmpfs");
  check("挂载表：网络挂载识别", findMountForPath("/mnt/share/other", procMounts).fstype === "cifs");
  check("挂载表：八进制转义还原", unescapeMount("/mnt/my\\040share") === "/mnt/my share");
  const bsd = parseBsdMountTable("/dev/disk3s1 on / (apfs, local, journaled)\nmap auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)");
  check("mount(8) 输出规范化成三列", bsd.split("\n").length === 2 && bsd.split("\n")[0].includes("apfs"));
  check("mount(8)：macOS 形态可被同一解析器命中", findMountForPath("/", bsd).fstype === "apfs");
  const mountOk = judgeMountType({ fsType: "ext4", mountPoint: "/", source: "/dev/sda1", magic: "ext2/3/4(0xef53)", via: "/proc/mounts", network: false, tmpfs: false, overlay: false, drvfs: false, wsl: true });
  check("P3：本地盘判 PASS", mountOk.level === "PASS" && mountOk.notes.length === 0);
  for (const [field, id] of [["network", "network-mount"], ["tmpfs", "tmpfs"], ["drvfs", "wsl-drvfs"]]) {
    const v = judgeMountType({ fsType: field, mountPoint: "/m", source: "s", magic: "x", via: "v", network: false, tmpfs: false, overlay: false, drvfs: false, wsl: false, [field]: true });
    check(`P3：${field} 判 WARN 且附影响说明`, v.level === "WARN" && v.notes[0].id === id && v.notes[0].impact.length > 30);
  }
  check("P3：overlayfs 只报告不单独触发 WARN",
    judgeMountType({ fsType: "overlay", mountPoint: "/", source: "overlay", magic: "overlayfs(0x794c7630)", via: "/proc/mounts", network: false, tmpfs: false, overlay: true, drvfs: false, wsl: false }).level === "PASS");

  // P4/P5：锁与原子写判定两侧
  check("P4.a：恰好 1 成功 3 冲突 ⇒ PASS",
    judgeConcurrentCas({ ok: 1, conflict: 3, error: 0 }).level === "PASS");
  for (const p of [{ ok: 2, conflict: 2, error: 0 }, { ok: 0, conflict: 4, error: 0 }, { ok: 1, conflict: 2, error: 1 }]) {
    check(`P4.a：${JSON.stringify(p)} ⇒ FAIL`, judgeConcurrentCas(p).level === "FAIL");
  }
  const atomicGood = { writers: 16, writersOk: 16, reads: 40, torn: 0, finalComplete: true, finalLength: 4101, leftovers: [] };
  check("P4.b：全绿样本 ⇒ PASS", judgeAtomicWrite(atomicGood).level === "PASS");
  for (const [field, value] of [["torn", 1], ["finalComplete", false], ["writersOk", 15], ["leftovers", ["x.tmp.1"]], ["reads", 0]]) {
    check(`P4.b：把 ${field} 改坏 ⇒ FAIL`, judgeAtomicWrite({ ...atomicGood, [field]: value }).level === "FAIL");
  }
  check("P4.b：载荷完整性判定有判别力",
    isCompleteAtomicPayload("W7:" + "x".repeat(4096) + ":7\n") === true &&
    isCompleteAtomicPayload("W7:" + "x".repeat(4095) + ":7\n") === false &&
    isCompleteAtomicPayload("") === false);
  const exdevGood = {
    attempted: true, candidates: ["/dev/shm"], secondFs: "/dev/shm", secondFsType: "tmpfs",
    srcDev: 1, dstDev: 2, renameCode: "EXDEV", srcIntact: true, dstExists: false, codePropagates: true,
  };
  check("P5：EXDEV 且如实上抛 ⇒ PASS", judgeExdev(exdevGood).level === "PASS");
  check("P5：静默降级为拷贝 ⇒ FAIL", judgeExdev({ ...exdevGood, codePropagates: false }).level === "FAIL");
  check("P5：EXDEV 后源文件丢失 ⇒ FAIL", judgeExdev({ ...exdevGood, srcIntact: false }).level === "FAIL");
  const exdevNone = judgeExdev({ attempted: false, candidates: ["/tmp"] });
  check("P5：无可写第二 FS ⇒ WARN 且附影响说明", exdevNone.level === "WARN" && exdevNone.impact.length > 30);

  // P6：locale/编码判定两侧
  const l3Good = {
    steps: [{ n: "createGoal", ok: true }], locale: "C", goal: "g-001",
    titleByteExact: true, bodyByteExact: true, fileUtf8RoundTrip: true,
    prompts: 14, promptsByteExact: true, promptsNonAscii: 14, fileSha256: "a".repeat(64),
  };
  check("P6：CJK 逐字节往返全绿 ⇒ PASS", judgeLocaleRoundTrip(l3Good).level === "PASS");
  for (const [field, value] of [["titleByteExact", false], ["bodyByteExact", false], ["fileUtf8RoundTrip", false], ["promptsByteExact", false], ["promptsNonAscii", 0]]) {
    check(`P6：把 ${field} 改坏 ⇒ FAIL`, judgeLocaleRoundTrip({ ...l3Good, [field]: value }).level === "FAIL");
  }
  check("P6：子进程无产出 ⇒ FAIL（不是静默跳过）", judgeLocaleRoundTrip(null).level === "FAIL");
  check("P6：子进程 JSON 可解析", parseLocaleJson('noise\nDSH_GATE_JSON:{"ok":true}\n')?.ok === true && parseLocaleJson("noise") === null);

  // M4（平台无关：守发布脚本对 macOS/BSD 的可移植性；承自 g-359）
  const m4Hits = (text, path = "probe.sh") => scanLinuxOnlyAssumptions([{ path, fileClass: "release", text }]);
  check("M4：模式表非空且每条都有判定函数",
    LINUX_ONLY_PATTERNS.length >= 10 && LINUX_ONLY_PATTERNS.every((d) => d.re instanceof RegExp && typeof d.judge === "function"));
  check("M4：真隐患（无探测/回退）判未覆盖", m4Hits("sha256sum f\n")[0]?.covered === false);
  check("M4：注释里的字面量判已覆盖", m4Hits("# 用 sha256sum 校验\n")[0]?.covered === true);
  check("M4：同文件含 mv --exchange --help 探测判已覆盖",
    m4Hits("elif mv --exchange --help >/dev/null 2>&1; then\n  mv -T --exchange a b\nfi\n", "build.sh").every((h) => h.covered));
  check("M4：BSD 形式 stat -f 不误报", m4Hits("stat -f %z f\n").length === 0);
  check("M4：grep -E 不误报", m4Hits("grep -E 'x' f\n").length === 0);
  check("M4：带模板的 mktemp -d 不误报", m4Hits('T=$(mktemp -d "${TMPDIR:-/tmp}/x.XXXXXX")\n').length === 0);
  check("M4：带 backup 后缀的 sed -i 不误报", m4Hits("sed -i.bak 's/a/b/' f\n").length === 0);
  check("M4：注释行判定", isCommentLine("  # x") && isCommentLine("// y") && !isCommentLine("echo hi"));
  {
    // 标记行自身算在区域内（有意样本区域）
    const mask = ignoredLineMask(["a", SCAN_IGNORE_BEGIN, "b", SCAN_IGNORE_END, "c"]);
    check("M4：有意样本区域成对解析（含标记行自身）", !mask[0] && mask[1] && mask[2] && mask[3] && !mask[4]);
  }

  // 转发参数：只转发规定选项，默认值不得触发转发
  check("转发：五个规定来源选项原样转发",
    buildForwardArgs({ staticOnly: "/s" }).join(" ") === "--static-only /s" &&
    buildForwardArgs({ selfTest: true }).join(" ") === "--self-test");
  check("转发：无来源参数时不转发（否则会去 registry 装插件）", forwardRequested({ profile: "p", dshHome: "/h" }) === false);

  // 逐项聚合
  check("聚合：未运行过的项是 SKIP（不冒充 PASS）", itemLevel("P9") === "SKIP");

  console.log("");
  if (bad === 0) {
    console.log("本脚本自检全部通过。");
  } else {
    console.error(`本脚本自检失败 ${bad} 项。`);
  }
  return bad;
}

// ---------------------------------------------------------------------------
// CLI / 主流程
// ---------------------------------------------------------------------------

function usage(msg) {
  if (msg) console.error(`\n参数错误：${msg}`);
  console.error(
    "\n用法：node scripts/platform-smoke-test.mjs [选项]\n\n" +
    "转发给 win-smoke-test.mjs（沿用其 T1–T5；在原生 macOS/Linux 上这些结论对本平台具平台效力）：\n" +
    "  --tarball <file>     直接验证现成 .tgz（推荐；无需仓库/分支）\n" +
    "  --spec <spec>        从 npm registry 安装并验证\n" +
    "  --path <dir>         从本地源码目录打包后验证\n" +
    "  --static-only <dir>  只跑 T1 静态门禁\n" +
    "  --self-test          离线自检（本脚本 + win-smoke-test.mjs）\n" +
    "  --port/--profile/--dsh-home/--dsh/--timeout   一并转发\n\n" +
    "平台探针（P1–P6，平台差异只在判定口径）：\n" +
    "  --repo <dir>         仓库根（默认本脚本所在目录的上一级）\n" +
    "  --temp-root <dir>    探测沙箱根（默认 <repo>/tmp/platform-gate —— 必须与 graph root 同一 FS）\n" +
    "  --skip-build         跳过依赖已构建 dist 的 P4/P5/P6（未 `pnpm build` 时）\n" +
    "  --keep-temp          保留探针临时目录\n" +
    "  --json               额外打印机器可读结果\n\n" +
    "平台无关附加检查：M4 发布脚本可移植性审计（承自 g-359；扫 Linux-only 假设）。\n\n" +
    "提示：TMPDIR 与 --dsh-home 一律落仓库内 tmp/（沙盒只允许写工作区）；\n" +
    "     npm/npx 缓存自动指向 <repo>/tmp/npm-cache。\n",
  );
  process.exit(2);
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        tarball: { type: "string" },
        spec: { type: "string" },
        path: { type: "string" },
        "static-only": { type: "string" },
        "self-test": { type: "boolean", default: false },
        port: { type: "string" },
        profile: { type: "string" },
        "dsh-home": { type: "string" },
        dsh: { type: "string" },
        timeout: { type: "string" },
        repo: { type: "string" },
        "temp-root": { type: "string" },
        "skip-build": { type: "boolean", default: false },
        "keep-temp": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
  } catch (e) {
    usage(e.message);
  }
  const v = parsed.values;
  if (v.help) usage();
  const sources = [v.path && "--path", v.tarball && "--tarball", v.spec && "--spec", v["static-only"] && "--static-only"]
    .filter(Boolean);
  if (sources.length > 1) usage(`${sources.join(" 与 ")} 互斥，只能选一个来源（--self-test 可与它们并存）`);
  const repo = v.repo ? resolve(v.repo) : join(import.meta.dirname, "..");
  return {
    tarball: v.tarball ? resolve(v.tarball) : undefined,
    spec: v.spec,
    path: v.path ? resolve(v.path) : undefined,
    staticOnly: v["static-only"] ? resolve(v["static-only"]) : undefined,
    selfTest: v["self-test"],
    port: v.port,
    profile: v.profile ?? "platform-smoke",
    // --dsh-home 默认落仓库内 tmp/（带时间戳 ⇒ 每次都是一次「全新隔离安装」）：
    // win-smoke-test.mjs 默认用 os.tmpdir()，在受限沙盒下会写工作区外（且 WSL2 的 /tmp 常是 tmpfs）。
    dshHome: v["dsh-home"] ? resolve(v["dsh-home"]) : join(repo, "tmp", "platform-gate", `dsh-home-${Date.now()}`),
    dsh: v.dsh,
    timeout: v.timeout,
    repo,
    tempRoot: v["temp-root"] ? resolve(v["temp-root"]) : undefined,
    skipBuild: v["skip-build"],
    keepTemp: v["keep-temp"],
    json: v.json,
  };
}

function printPreamble(repo, tempRoot) {
  head(`dsh-graph 平台门禁（g-362 · ${PLATFORM_LABEL}）`);
  console.log(`平台：${process.platform} ${process.arch}    Node：${process.version}    ${new Date().toISOString()}`);
  console.log(`仓库：${repo}`);
  console.log(`执行件：scripts/${SELF_FILE}（Node 实现，纯 Node 无第三方依赖、单文件可拷贝）`);
  console.log(`探测沙箱：${tempRoot}`);
  console.log("  为什么必须落仓库内 tmp/：沙盒（workspace-write）只允许写工作区；且 P1/P3 的大小写与挂载探针");
  console.log("  只有与 graph root 在**同一文件系统**上才有意义；系统 /tmp 在 macOS 上是软链、在本机常是 tmpfs。");
  console.log("");
  console.log("结论边界（务必先读）：");
  if (IS_SUPPORTED) {
    console.log(`  - 本机是**原生 ${PLATFORM_LABEL}** ⇒ 转发的 T1–T5 结论**对 ${PLATFORM_LABEL} 具平台效力**（T3–T5 在本机真跑）。`);
    console.log("    win-smoke-test.mjs 自带的『非 win32 上 T3–T5 只能证明脚本与代码可跑』只针对 **Windows 真机结论**");
    console.log("    （发布红线 1）；它不削弱本机结论，本机结论也不能替代 Windows 真机门禁。");
  } else {
    console.log(`  - 本机平台是 ${process.platform}（**非 macOS/Linux**）⇒「平台效力」声明**不成立**；`);
    console.log("    P1/P2/P3 中依赖本机 FS 语义的判定同样不成立，请在原生 macOS 或 Linux 上重跑。");
  }
  console.log(`  - P1–P6 为平台探针（判定口径随平台标注）；M4 为平台无关附加检查。`);
  console.log("  - 真机结论回填位置：docs/platform-gate.md「回填表」。");
}

/** 「平台效力」声明：明确区分「本机结论」与「win 脚本针对 Windows 的免责声明」。 */
function printPlatformValidity(stream = console.log, forwarded = true) {
  stream("──────────────── 平台结论归属（务必先读）────────────────");
  if (!IS_SUPPORTED) {
    stream(`本机平台是 ${process.platform}（**非 macOS/Linux**）⇒「对 macOS/Linux 具平台效力」的声明**不成立**，`);
    stream("P1–P6 中依赖本机 FS/locale 语义的判定同样不成立；请在原生 macOS 或 Linux 上重跑本脚本。");
  } else if (forwarded) {
    stream(`本机是**原生 ${PLATFORM_LABEL}** ⇒ 上面转发的 T1–T5 结论**对 ${PLATFORM_LABEL} 具平台效力**：`);
    stream("  T3/T4/T5 是在本机真实的 POSIX 语义下真跑出来的（建目标/CAS/实例启动/REST 都真的发生）。");
    stream("上面 win-smoke-test.mjs 打印的『非 win32 上 T3–T5 只能证明脚本与代码可跑』是**针对 Windows 真机");
    stream("结论**的免责声明（发布红线 1）——它不削弱本机结论，但也不能替代 Windows 真机门禁。");
  } else {
    stream(`本机是**原生 ${PLATFORM_LABEL}**；本次**未运行**转发的 T1–T5（未给 --tarball/--spec/--path/--static-only/--self-test）`);
    stream(`  ⇒ 一旦转发，其 T1–T5 结论对 ${PLATFORM_LABEL} 具平台效力（T3–T5 会在本机真跑）。`);
    stream("  win-smoke-test.mjs 的『非 win32…不能替代 Windows 真机结论』只针对 Windows 结论（发布红线 1）。");
  }
  stream("─────────────────────────────────────────────────────────");
}

function summarize(opt, forwardStatus) {
  head("结论");
  const fails = results.filter((r) => r.level === "FAIL");
  const warns = results.filter((r) => r.level === "WARN");
  const passes = results.filter((r) => r.level === "PASS");
  const probes = ["P1", "P2", "P3", "P4", "P5", "P6"].map((k) => `${k}=${itemLevel(k)}`);
  console.log(`逐项判定（六项平台探针）：${probes.join("  ")}`);
  console.log(`平台无关附加检查：M4=${itemLevel("M4")}（发布脚本可移植性审计，承自 g-359）`);
  console.log(`通过 ${passes.length} 项，失败 ${fails.length} 项，告警 ${warns.length} 项。`);
  for (const group of [["失败项", fails], ["告警项", warns]]) {
    const [label, list] = group;
    if (list.length === 0) continue;
    console.log(`\n${label}：`);
    for (const r of list) console.log(`  - ${r.id} · ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  const ownPass = fails.length === 0;
  const pass = ownPass && (forwardStatus === null || forwardStatus === 0);
  const ran = [...["P1", "P2", "P3", "P4", "P5", "P6"], ...["M4"]].filter((k) => itemLevel(k) !== "SKIP");
  const ranText = ran.length > 0 ? ran.join("/") : "未跑探针";
  console.log(`\n平台专检判定：${ownPass ? "PASS ✅" : "FAIL ❌"}` +
    (ran.length === 0 ? "（--self-test 模式，未跑探针）" : "") +
    (forwardStatus === null ? "（未运行转发的门禁）" : `；转发执行件 exit=${forwardStatus}`));
  printPlatformValidity(console.log, forwardStatus !== null);
  if (pass && IS_SUPPORTED) {
    console.log(forwardStatus === null
      ? `注意：本次 PASS 只覆盖 ${ranText}（未运行转发的 T1–T5）；Windows 真机门禁仍需单独执行。`
      : `注意：本次 PASS 覆盖 ${ranText} 与转发的 T1–T5（对 ${PLATFORM_LABEL} 有效）；Windows 真机门禁仍需单独执行。`);
  }
  if (!pass && ran.length === 0) {
    console.log("注意：本次是 --self-test，**没有**跑任何平台探针 ⇒ 不能读成「本机平台已通过」。");
  }

  console.log("\n----- 可复制回传的报告 -----");
  console.log(`dsh-graph 平台门禁 | 平台=${process.platform}/${process.arch} node=${process.version} 标注=${PLATFORM_LABEL}`);
  console.log(`仓库=${opt.repo}`);
  console.log(`逐项=${probes.join(" ")} M4=${itemLevel("M4")}`);
  console.log(`结果=${pass ? "PASS" : "FAIL"} 通过${passes.length}/失败${fails.length}/告警${warns.length}` +
    (forwardStatus === null ? "" : ` 转发exit=${forwardStatus}`));
  for (const r of results.filter((x) => x.level === "FAIL" || x.level === "WARN")) {
    console.log(`  ${r.level} ${r.id} ${r.name}${r.detail ? " :: " + r.detail.slice(0, 300) : ""}`);
  }
  console.log("---------------------------");
  if (opt.json) console.log("\n" + JSON.stringify({ pass, platform: process.platform, forwardStatus, probes, m4: itemLevel("M4"), results }, null, 2));
  return { pass, ownPass, fails: fails.length };
}

async function main() {
  const opt = parseCli();
  const tempRootBase = resolveTempRoot(opt.repo, opt.tempRoot);
  printPreamble(opt.repo, tempRootBase);

  let selfCheckFailures = 0;
  if (opt.selfTest) selfCheckFailures = selfCheck();

  mkdirSync(tempRootBase, { recursive: true });
  const tmpRoot = mkdtempSync(join(tempRootBase, "run-"));
  try {
    if (!opt.selfTest) {
      checkCaseSensitivity(opt, opt.repo, tmpRoot);          // P1
      await checkSymlinkRootBoundary(opt, opt.repo, tmpRoot); // P2
      checkMountType(opt, opt.repo);                          // P3
      if (opt.skipBuild) {
        const why = "已用 --skip-build 跳过（依赖已构建的 dist/core/*.js）";
        record("P4.a", "并发 CAS（4 抢 1）", "WARN", why);
        record("P4.b", "原子写（并发写者 + 轮询读者）", "WARN", why);
        record("P5", "跨 FS rename(EXDEV)", "WARN", why);
        record("P6", "locale/编码（LANG=C 下 CJK 逐字节往返）", "WARN", why);
      } else {
        await checkLockAndAtomic(opt, opt.repo, tmpRoot);     // P4.a / P4.b / P5
        checkLocaleEncoding(opt, opt.repo, tmpRoot);          // P6
      }
      checkLinuxOnlyAssumptions(opt.repo);                    // M4（平台无关）
    }
  } finally {
    if (opt.keepTemp) console.log(`\n保留探针临时目录：${tmpRoot}（--keep-temp）`);
    else rmSync(tmpRoot, { recursive: true, force: true });
  }

  const forwardStatus = forwardSmoke(opt, opt.repo);
  const summary = summarize(opt, forwardStatus);

  if (selfCheckFailures > 0) {
    console.error(`\n本脚本 --self-test 失败 ${selfCheckFailures} 项。`);
    process.exitCode = 1;
    return;
  }
  if (summary.fails > 0) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = forwardStatus === null ? 0 : forwardStatus;
}

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
  main().catch((e) => {
    console.error("\n脚本自身异常：" + (e?.stack || e));
    process.exit(1);
  });
}
