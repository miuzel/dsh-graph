/**
 * core/platform.ts
 *
 * g-284: 平台适配层，收敛操作系统差异（Windows / POSIX）：
 * - 平台检测与测试注入（单一注入点，避免业务逻辑散落 process.platform 判断）
 * - 平台无关 FS 常量能力探测与安全导出（避免 node:constants POSIX 专有具名导入在 Windows 下抛 SyntaxError）
 * - 跨平台文件锁（Windows 下 mkdir 互斥 + wx owner 文件，不把目录当 fd 打开）
 * - 跨平台原子写（wx 语义创建、rename 替换与失败清理）
 * - 跨平台文件同一性校验（POSIX dev+ino / Windows 内容哈希+size+mtimeMs）
 * - g-364: 卷「大小写别名」语义（请求名 → 磁盘实际条目名）与测试注入
 */

import * as C from "node:constants";
import {
  existsSync,
  lstatSync,
  fstatSync,
  openSync,
  closeSync,
  fsyncSync,
  fchmodSync,
  chmodSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

/**
 * 平台判定单一注入点：
 * 默认读取 process.env.DSH_PLATFORM_OVERRIDE ?? process.platform，
 * 测试中可通过 setPlatformForTesting / withPlatformForTesting 动态注入模拟。
 */
let platformOverride: string | null = null;

export function getPlatform(): string {
  return platformOverride ?? process.env.DSH_PLATFORM_OVERRIDE ?? process.platform;
}

export function isWindows(): boolean {
  return getPlatform() === "win32";
}

export function setPlatformForTesting(platform: string | null): void {
  platformOverride = platform;
}

export function withPlatformForTesting<T>(platform: string, fn: () => T): T {
  const prev = platformOverride;
  platformOverride = platform;
  try {
    return fn();
  } finally {
    platformOverride = prev;
  }
}

/**
 * g-364：卷「大小写别名」语义（单一注入点，与平台判定同层）。
 *
 * 背景：大小写不敏感卷（APFS 默认、WSL 的 drvfs `/mnt/*`、部分网络挂载）把**仅大小写不同**
 * 的名字折叠到同一实体。名字入口（附件相对路径、版本泳道 slug）若按请求拼写读写与返回，
 * 在真实不敏感卷上会：返回一个磁盘上并不存在的拼写（引用在大小写敏感卷上悬空）、或静默复用
 * 既有的别名实体（事件/元数据记错名字）。产品侧因此需要在**复用既有实体之前**解析出磁盘实际
 * 条目名，并据此拒绝或回填真实名。
 *
 * 注入语义：默认 `null` = **不注入**，判定完全来自真实文件系统——
 *   - `readdirSync` 是「磁盘实际拼写」的权威；
 *   - `lstat` 是「该卷是否认为此名存在」的权威。
 * 测试可注入 `true`，在**大小写敏感的开发卷**上复现不敏感卷的别名行为（不依赖真实挂载、
 * 不往生产看板写探针）。注入不改变「精确名优先」：逐字节同名永远是精确名，绝不被判为别名。
 */
let caseInsensitiveVolumeOverride: boolean | null = null;

/** 是否处于「注入的大小写不敏感卷」模式（生产路径恒为 false：不注入）。 */
export function isCaseInsensitiveVolumeInjected(): boolean {
  return caseInsensitiveVolumeOverride === true;
}

export function setCaseInsensitiveVolumeForTesting(mode: boolean | null): void {
  caseInsensitiveVolumeOverride = mode;
}

export function withCaseInsensitiveVolumeForTesting<T>(mode: boolean | null, fn: () => T): T {
  const prev = caseInsensitiveVolumeOverride;
  caseInsensitiveVolumeOverride = mode;
  try {
    return fn();
  } finally {
    caseInsensitiveVolumeOverride = prev;
  }
}

/** 条目名折叠键：Unicode 规范化（macOS 磁盘名常为 NFD，请求名常为 NFC）+ 大小写不敏感。 */
export function foldEntryName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * 在父目录的**真实条目**中定位请求名，返回磁盘实际拼写：
 *   - 逐字节同名 ⇒ `{ actual: 请求名, aliased: false }`（**精确名优先**，永不被判为别名）；
 *   - 只有折叠同名的条目（大小写/规范化差异）：仅当**注入不敏感语义**、或 `lstat` 命中
 *     （真实不敏感卷上该请求名确实解析到既有条目）⇒ `{ actual: 磁盘条目, aliased: true }`；
 *   - 其余（含**大小写敏感卷上只有异名条目**）⇒ `null`：调用方按「不存在」新建，
 *     **不产生假别名**（这正是「大小写敏感卷 + 精确名不得误伤」的保障）。
 *
 * 不抛错：父目录不存在/不可读、条目为悬空软链等一律按无法判定处理（保守返回 null 或原名）。
 * 多条目折叠同名（人为构造的矛盾状态）时按名字排序取首个，保证判定确定性。
 */
export function resolveExistingEntry(
  parentDir: string,
  requested: string,
): { actual: string; aliased: boolean } | null {
  let entries: string[];
  try {
    entries = readdirSync(parentDir).sort();
  } catch {
    return null;
  }
  if (entries.includes(requested)) return { actual: requested, aliased: false };
  const folded = entries.find((e) => foldEntryName(e) === foldEntryName(requested));
  if (caseInsensitiveVolumeOverride === true) {
    return folded ? { actual: folded, aliased: true } : null;
  }
  let present = false;
  try {
    lstatSync(join(parentDir, requested));
    present = true;
  } catch {
    present = false;
  }
  if (!present) return null;
  // 请求名在真实卷上确实命中，但磁盘拼写不是逐字节同名 ⇒ 该卷把它折叠到了既有条目。
  return folded ? { actual: folded, aliased: true } : { actual: requested, aliased: false };
}

/**
 * 跨平台进程存活探测辅助：
 * - 进程存在且可发信号：alive = true
 * - 抛出 EPERM：进程存在但当前用户无权发信号（说明进程存活，尤其在 Windows 下对受限进程极为常见）→ alive = true
 * - 抛出 ESRCH：进程不存在 → alive = false
 * - 其他异常：向上抛出
 */
export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0 || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM") {
      // 进程活着但当前上下文无权发送信号
      return true;
    }
    throw error;
  }
}

/**
 * 校验两个 stat 对象在同一性上是否匹配：
 * - POSIX: 严格比对 dev 与 ino；
 * - Windows: 无法依赖 ino，返回 true（调用方结合 token/内容进一步校验）。
 */
export function areSameStat(statA: any, statB: any): boolean {
  if (isWindows()) return true;
  if (!statA || !statB) return false;
  return statA.dev === statB.dev && statA.ino === statB.ino;
}

/**
 * 平台无关 FS 常量集合：
 * 经由 import * as C from "node:constants" 命名空间导入并进行能力探测/默认回退，
 * 在 Windows 上缺失 O_DIRECTORY / O_NOFOLLOW 等 POSIX 专有导出时安全退化为 0，
 * 绝不在模块顶层具名解构不存在的常量。
 */
export const FS_CONSTANTS = {
  O_RDONLY: C.O_RDONLY ?? 0,
  O_WRONLY: C.O_WRONLY ?? 1,
  O_RDWR: C.O_RDWR ?? 2,
  O_CREAT: C.O_CREAT ?? 0o100,
  O_EXCL: C.O_EXCL ?? 0o200,
  O_DIRECTORY: C.O_DIRECTORY ?? 0,
  O_NOFOLLOW: C.O_NOFOLLOW ?? 0,
};

/**
 * 跨平台原子替换文件：
 * - POSIX 下直接使用 renameSync（单系统调用原子替换）；
 * - Windows 下首先尝试 renameSync（NTFS 支持 MOVEFILE_REPLACE_EXISTING 替换已存在文件）；
 *   若遇到 EEXIST / EPERM / EBUSY 等平台异常，采用安全备份-替换-删除备份策略，
 *   失败时自动恢复备份，避免目标损坏且不留半文件。
 */
export function replaceFileAtomic(src: string, dest: string): void {
  if (!isWindows()) {
    renameSync(src, dest);
    return;
  }

  try {
    renameSync(src, dest);
  } catch (err: any) {
    if (err?.code === "EEXIST" || err?.code === "EPERM" || err?.code === "EBUSY") {
      const backup = `${dest}.bak-${process.pid}-${randomUUID()}`;
      let backedUp = false;
      try {
        if (existsSync(dest)) {
          renameSync(dest, backup);
          backedUp = true;
        }
        renameSync(src, dest);
        if (backedUp) {
          try { unlinkSync(backup); } catch { /* 忽略清理失败 */ }
        }
      } catch (fallbackErr) {
        if (backedUp && existsSync(backup)) {
          try { renameSync(backup, dest); } catch { /* 尽最大努力恢复 */ }
        }
        throw fallbackErr;
      }
    } else {
      throw err;
    }
  }
}

/**
 * 跨平台目录 fsync 安全辅助：
 * - POSIX 下以 O_RDONLY 打开目录并 fsyncSync，保证元数据落盘；
 * - Windows 下禁止对目录执行 openSync（会报 EISDIR/EPERM），直接安全静默跳过。
 */
export function syncDirectorySafely(dirPath: string): void {
  if (isWindows()) return;
  try {
    const dfd = openSync(dirPath, FS_CONSTANTS.O_RDONLY);
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // 目录 fsync 失败不致命
  }
}

/**
 * 跨平台模式/权限应用辅助：
 * - POSIX 下执行 fchmodSync / chmodSync；
 * - Windows 下跳过或安全降级（Windows 仅支持只读位，无 POSIX 权限位）。
 */
export function applyModeSafely(fdOrPath: number | string, mode: number): void {
  if (isWindows()) return;
  try {
    if (typeof fdOrPath === "number") {
      fchmodSync(fdOrPath, mode);
    } else {
      chmodSync(fdOrPath, mode);
    }
  } catch {
    // 忽略权限设置异常
  }
}

/**
 * 文件同一性快照结构体：
 * - POSIX 分支记录 dev + ino；
 * - Windows 分支记录内容哈希 (sha256) + size + mtimeMs（ino 不可靠时不依赖 ino）。
 */
export interface FileIdentitySnapshot {
  path: string;
  size: number;
  mtimeMs: number;
  hash: string;
  dev?: number;
  ino?: number;
  isWindows: boolean;
}

/**
 * 获取文件当前同一性快照。
 */
export function takeFileIdentity(filePath: string, content?: string): FileIdentitySnapshot {
  const win = isWindows();
  const st = lstatSync(filePath);
  const text = content ?? readFileSync(filePath, "utf8");
  const hash = createHash("sha256").update(text).digest("hex");
  return {
    path: filePath,
    size: st.size,
    mtimeMs: st.mtimeMs,
    hash,
    dev: win ? undefined : st.dev,
    ino: win ? undefined : st.ino,
    isWindows: win,
  };
}

/**
 * 校验文件同一性：
 * 用于事件写入失败时的回滚保护（拒绝把外部替换或删除的文件当自己写的进行回滚）。
 * - POSIX: 严格比对 dev 与 ino，若传入 fd 则进一步验证 fstat(fd)；
 * - Windows: 严格比对存在性、普通文件属性、文件 size 与内容哈希 sha256，
 *   外部篡改或删除时稳健拒绝回滚，正常写入不发生误判。
 */
export function verifyFileIdentity(
  filePath: string,
  expected: FileIdentitySnapshot,
  fd?: number,
): { valid: boolean; reason?: string } {
  if (!existsSync(filePath)) {
    return { valid: false, reason: "目标文件已被外部替换或删除，拒绝回滚" };
  }
  let pathStat;
  try {
    pathStat = lstatSync(filePath);
  } catch {
    return { valid: false, reason: "目标文件已被外部替换或删除，拒绝回滚" };
  }
  if (!pathStat.isFile()) {
    return { valid: false, reason: "目标文件已被外部替换或删除，拒绝回滚" };
  }

  if (!expected.isWindows && expected.ino !== undefined && expected.dev !== undefined) {
    if (pathStat.dev !== expected.dev || pathStat.ino !== expected.ino) {
      return { valid: false, reason: "目标文件已被外部替换或删除，拒绝回滚" };
    }
    if (fd !== undefined && fd >= 0) {
      try {
        const current = fstatSync(fd);
        if (current.dev !== expected.dev || current.ino !== expected.ino) {
          return { valid: false, reason: "目标文件 inode 校验失败" };
        }
      } catch {
        return { valid: false, reason: "目标文件 inode 校验失败" };
      }
    }
    return { valid: true };
  }

  // Windows 分支：基于内容哈希 + size 校验（不依赖 dev/ino）
  if (pathStat.size !== expected.size) {
    return { valid: false, reason: "目标文件已被外部替换或删除，拒绝回滚" };
  }
  let currentContent = "";
  try {
    currentContent = readFileSync(filePath, "utf8");
  } catch {
    return { valid: false, reason: "目标文件已被外部替换或删除，拒绝回滚" };
  }
  const currentHash = createHash("sha256").update(currentContent).digest("hex");
  if (currentHash !== expected.hash) {
    return { valid: false, reason: "目标文件已被外部替换或删除，拒绝回滚" };
  }

  return { valid: true };
}
