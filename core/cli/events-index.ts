/**
 * 事件流**增量索引**（g-630）：让 `dsh-graph status` 在大看板上不再逐行线性扫描 events.jsonl。
 *
 * ## 为什么能省，省的是什么
 * 旧实现（g-314 `summarizeEventsFast`）每次都对整档做 `readFileSync` 全文解码 + `split("\n")`
 * + 逐行 `JSON.parse`：18404 事件实测 ≈ 36ms（16.9MB 解码 ≈ 23ms 占大头），且随事件流**线性增长**。
 * 本模块把它换成 **O(1) 字节探测**：`open`→`fstat`→读头部定长前缀→读尾部定长窗口。
 *
 * ## 索引只存「事件流的派生物」
 * 索引里只有 `eventCount` / `lastEvent` / `lastEventTs` —— **全部可由事件流纯函数推出**（判据 5：
 * 不另立第二套解析真源；语义仍以 core `readEvents` 为准）。目标数、规则库版本、project.yaml 状态
 * 与文件探针**不在**本索引里（各有自身真源，见 `diagnostics.ts`）。
 *
 * ## 一致性校验：只认「逐字节可证的增量」
 * 索引记录 `size` / `dev` / `ino` / `headSha`（定长头部的 sha256）；命中判定取本次 `fstat`：
 *
 * | 场景 | 判定 | 处置 |
 * | --- | --- | --- |
 * | size 变小 | 截断 | 回退全量校验（并改写索引） |
 * | dev / ino 变化 | 被替换 | 回退全量校验 |
 * | size 相等且 headSha 相同 | 未变 | 命中原值 |
 * | size 变大且 headSha 相同 | **纯追加**（Windows 无稳定 ino 时也认这条） | 只扫新增的完整行 |
 * | size 变大但 headSha 不同 | 非纯追加（改写/替换） | 回退全量校验 |
 *
 * 头部长度的选取（`HEAD_PREFIX_BYTES`）是一致性论证的关键：**既有的头部内容不可能改变**
 * 时，才可只信 `headSha` 判「纯追加」。`appendEvent` 以 `O_APPEND` 单次写入
 * `JSON.stringify(rec) + "\n"`，而单条事件实测均 < 4KB；`writeSync` 对普通文件**不截断到短写**
 * （Node 文档明示），故一条事件要么整行写入，要么抛错——**不存在**「先覆盖 4KB 前缀再补尾部」
 * 的合法写入路径。因此头部 4KB 被改写只能来自外部破坏（就地编辑/重写文件），此时 headSha 必变。
 *
 * ## fail-safe：任何不确定都不给数
 * 索引缺失 / JSON 损坏 / 字段非法 / 版本不匹配 / 结构校验不过 / 探测异常 / 快路径自身发现可疑
 * ⇒ 一律 `fallback=true`，由调用方用 core `readEvents` 做**权威全量校验**并给出**可读告警**；
 * **绝不**静默返回空或部分聚合（判据 3）。
 *
 * ## 存放位置
 * 索引**不进** `.dsh-graph/`（那是事件流真源所在目录，写入会污染既有语义与格式，判据 4），
 * 也**不进**源码树。默认落 `$XDG_CACHE_HOME/dsh-graph`（缺省 `~/.cache/dsh-graph`），
 * 可按 `DSH_GRAPH_CACHE_HOME` 覆盖（隔离实例/测试用）。文件名由 **graph root 的 sha256**
 * 派生 ⇒ 不同看板互不干扰，索引也**不含**任何看板内容（只有计数与头部哈希）。
 * 索引是**纯缓存**：可随时删除，删掉只会退化为全量校验（不会错误、只会慢一次）。
 */
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readEvents, type GraphEvent } from "../events.ts";
// 复用 core 的跨平台原子替换（POSIX rename / Windows 备份-替换-回滚），不自行实现第二套。
import { replaceFileAtomic, syncDirectorySafely } from "../platform.ts";

/** 索引格式版本：格式或语义任何变化都必须 bump（旧索引据此 fail-safe 回退，不兼容读取）。 */
export const EVENTS_INDEX_VERSION = 1;

/** 头部定长前缀：用于证明「既有内容未被改写」（见模块注释的一致性论证）。 */
export const HEAD_PREFIX_BYTES = 4096;

/** 追加时最多向下扫描的字节窗口（必须 ≥ 单条事件的正常体量；不够就回退全量）。 */
export const APPEND_WINDOW_BYTES = 1024 * 1024;

/** 索引落盘目录（可在运行时覆盖，仅测试/隔离实例使用）。 */
const CACHE_DIR_ENV = "DSH_GRAPH_CACHE_HOME";
let cacheDirOverride: string | null = null;

/**
 * 覆盖索引目录（**仅**在 `node:test` 子进程内生效，与 `cache-state.ts` 的
 * `__setWatcherIdleCloseMsForTests` 同一纪律）。生产进程调用是 no-op ⇒ 不存在「生产
 * 可通过本函数把索引写歪」的配置面。传 null 取消覆盖。
 */
export function __setEventsIndexDirForTests(dir: string | null): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  cacheDirOverride = dir;
}

function cacheDir(): string {
  if (cacheDirOverride) return cacheDirOverride;
  const fromEnv = process.env[CACHE_DIR_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return resolve(fromEnv.trim());
  const xdg = process.env.XDG_CACHE_HOME;
  const base = typeof xdg === "string" && xdg.trim() !== "" ? resolve(xdg.trim()) : join(homedir(), ".cache");
  return join(base, "dsh-graph");
}

/** 索引文件路径：由 canonical graph root 的 sha256 派生（不泄漏路径到文件名语义之外）。 */
export function eventsIndexPath(root: string): string {
  const key = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 32);
  return join(cacheDir(), `events-index-v${EVENTS_INDEX_VERSION}-${key}.json`);
}

/** 索引里记录的事件流派生物（全部可由事件流纯函数推出）。 */
export interface EventsIndexEntry {
  version: number;
  /** 事件流绝对路径（防止 root 复用同一路径时串味）。 */
  file: string;
  /** 上次全量校验时的事件流字节数。 */
  size: number;
  /** 上次全量校验时的事件流 inode 标识（posix: dev:ino；无 ino 平台为 ""）。 */
  ino: string;
  /**
   * 头部长度的**实际取值** = min(HEAD_PREFIX_BYTES, 记录时 size)。
   *
   * 为什么必须记下它（实测 bug）：小文件（不足 4KB）的「头部前缀」就是整个文件，
   * 后续追加的字节会**进入**这个前缀。若每次都用 `min(4096, size)` 现算长度，
   * 追加后哈希覆盖的字节变多 ⇒ headSha 必然不同 ⇒ 把正常追加误判成「非纯追加」。
   * 记下长度后，哈希恒覆盖「记录时的那前 headLen 个字节」，语义才稳定。
   */
  headLen: number;
  /** 前 headLen 字节的 sha256（空文件为 ""）。 */
  headSha: string;
  /** 已确认的事件条数（= core `readEvents` 的 length）。 */
  eventCount: number;
  /** 末事件名（无事件为 null）。 */
  lastEvent: string | null;
  /** 末事件时间戳（无 / 非字符串为 null）。 */
  lastEventTs: string | null;
  /** 上次写入时间（仅供人看，不参与一致性判定）。 */
  updatedAt: string;
}

/** 一次解析的结论：要么命中索引（原值或追加后新值），要么要求回退全量校验。 */
export interface EventsSummary {
  /** 是否走了索引快路径（false ⇒ 调用方**必须**用 core readEvents 全量校验）。 */
  indexed: boolean;
  eventCount: number;
  lastEvent: string | null;
  lastEventTs: string | null;
  /** 快路径自身的可读告警（回退原因 / 索引失效原因）。索引命中且无异常时为 null。 */
  warning: string | null;
}

/** 文件级探针：一次 open + fstat + 头尾两次 read，与事件体量无关。 */
interface Probe {
  size: number;
  inoKey: string;
  /** 本次实际参与哈希的头部长度（记录时 = min(HEAD_PREFIX_BYTES, size)）。 */
  headLen: number;
  headSha: string;
  /** 尾部窗口的第一个字节在文件内的偏移。 */
  tailStart: number;
  tail: Buffer;
}

function inoKeyOf(dev: number, ino: number): string {
  // Windows 上 ino 恒为 0（Node 不填），此时**不**认 ino —— 只靠 size + headSha。
  return ino ? `${dev}:${ino}` : "";
}

/** 只取文件大小（不存在返回 -1）。 */
function fileSize(file: string): number {
  try {
    return Number(statSync(file).size);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return -1;
    throw e;
  }
}

/**
 * 探测事件流：`tailBytes` 为尾窗期望字节数（不足文件长度时取全文）。
 * 返回 null 表示文件不存在；其它错误交由调用方转成回退。
 */
function probeFile(file: string, tailBytes: number, headLen: number | null = null): Probe | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const st = fstatSync(fd);
    const size = Number(st.size);
    const len = headLen === null ? Math.min(HEAD_PREFIX_BYTES, size) : Math.min(headLen, size);
    const head = Buffer.alloc(len);
    if (len > 0) readSync(fd, head, 0, len, 0);
    const tailLen = Math.min(Math.max(tailBytes, 0), size);
    const tailStart = size - tailLen;
    const tail = Buffer.alloc(tailLen);
    if (tailLen > 0) readSync(fd, tail, 0, tailLen, tailStart);
    const headSha = len === 0 ? "" : createHash("sha256").update(head).digest("hex");
    return { size, inoKey: inoKeyOf(Number(st.dev), Number(st.ino)), headLen: len, headSha, tailStart, tail };
  } finally {
    closeSync(fd);
  }
}

/** 与 core `readEvents` 同口径校验单行；合格返回解析对象，不合格返回 null（空行返回 undefined）。 */
function parseEventLine(line: string): GraphEvent | null | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  try {
    const rec = JSON.parse(trimmed);
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
    if (!rec.event || !rec.actor) return null;
    return rec as GraphEvent;
  } catch {
    return null;
  }
}

/** 索引条目结构校验（缺字段 / 类型不符 / 版本不匹配 / 自相矛盾 ⇒ 不可用）。 */
function isValidEntry(raw: unknown, file: string): raw is EventsIndexEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const e = raw as Record<string, unknown>;
  if (e.version !== EVENTS_INDEX_VERSION) return false;
  if (typeof e.file !== "string" || resolve(e.file) !== resolve(file)) return false;
  if (typeof e.size !== "number" || !Number.isInteger(e.size) || e.size < 0) return false;
  if (typeof e.ino !== "string" || typeof e.headSha !== "string") return false;
  if (typeof e.headLen !== "number" || !Number.isInteger(e.headLen) || e.headLen < 0) return false;
  // 头部长度不能超过记录时的大小，也不能超过前缀上限；空文件必须 ""、有内容必须非空。
  if (e.headLen > Math.min(HEAD_PREFIX_BYTES, e.size)) return false;
  if (e.size === 0 && e.headSha !== "") return false;
  if (e.size > 0 && e.headSha === "") return false;
  if (typeof e.eventCount !== "number" || !Number.isInteger(e.eventCount) || e.eventCount < 0) return false;
  if (!(e.lastEvent === null || typeof e.lastEvent === "string")) return false;
  if (!(e.lastEventTs === null || typeof e.lastEventTs === "string")) return false;
  if (typeof e.updatedAt !== "string") return false;
  // 自洽性（防「部分聚合」）：0 事件 ⇒ 末事件必须为空；有事件 ⇒ 末事件名必须在。
  if (e.eventCount === 0 && (e.lastEvent !== null || e.lastEventTs !== null)) return false;
  if (e.eventCount > 0 && typeof e.lastEvent !== "string") return false;
  // 0 字节文件必然 0 事件（否则索引来自另一份文件）。
  if (e.size === 0 && e.eventCount !== 0) return false;
  return true;
}

function readIndexFile(root: string, file: string): { entry: EventsIndexEntry | null; warning: string | null } {
  const idx = eventsIndexPath(root);
  if (!existsSync(idx)) return { entry: null, warning: null };
  let text: string;
  try {
    text = readFileSync(idx, "utf8");
  } catch (e) {
    return { entry: null, warning: `事件索引不可读（已退回全量校验）：${(e as Error).message}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { entry: null, warning: `事件索引已损坏（已退回全量校验）：${idx} 不是合法 JSON` };
  }
  const seen = raw && typeof raw === "object" ? (raw as Record<string, unknown>).version : undefined;
  if (seen !== EVENTS_INDEX_VERSION) {
    return {
      entry: null,
      warning: `事件索引版本不匹配（已退回全量校验）：期望 v${EVENTS_INDEX_VERSION}，实际 ${String(seen)}`,
    };
  }
  if (!isValidEntry(raw, file)) {
    return { entry: null, warning: `事件索引结构非法（已退回全量校验）：${idx}` };
  }
  return { entry: raw, warning: null };
}

/** 原子写索引：temp + fsync + rename。任何失败都**静默放弃**（纯缓存，不得影响正确性）。 */
function writeIndexFile(root: string, entry: EventsIndexEntry): void {
  const idx = eventsIndexPath(root);
  const tmp = `${idx}.tmp-${process.pid}-${Date.now()}`;
  let fd = -1;
  try {
    mkdirSync(join(idx, ".."), { recursive: true });
    fd = openSync(tmp, "w");
    writeSync(fd, JSON.stringify(entry, null, 2) + "\n", undefined, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    // 跨平台原子就位（Windows 上 rename 到已存在文件需备份-替换；core 已收口该差异）。
    replaceFileAtomic(tmp, idx);
    try {
      syncDirectorySafely(join(idx, ".."));
    } catch {
      /* 目录 fsync 是落盘加固，失败不影响正确性 */
    }
  } catch {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* 忽略 */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* 忽略 */
    }
  }
}

/** 由事件数组构造索引条目（写入点唯一入口 ⇒ 索引恒由 core 真值派生）。 */
function entryFromEvents(file: string, probe: Probe, events: GraphEvent[]): EventsIndexEntry {
  const last = events.length > 0 ? events[events.length - 1] : null;
  return {
    version: EVENTS_INDEX_VERSION,
    file: resolve(file),
    size: probe.size,
    ino: probe.inoKey,
    headLen: probe.headLen,
    headSha: probe.headSha,
    eventCount: events.length,
    lastEvent: last ? String(last.event) : null,
    lastEventTs: last && typeof last.ts === "string" ? last.ts : null,
    updatedAt: new Date().toISOString(),
  };
}

/** 尾窗里「最后一条非空行」的解析结果：null=末行非法，undefined=尾窗内无可计行。 */
function lastEventFromTail(probe: Probe): { ok: boolean; event: string | null; ts: string | null } {
  const lines = probe.tail.toString("utf8").split("\n");
  // 尾窗未覆盖文件头时，第一段是残缺行 —— 丢弃它（只有完整行才算）。
  if (probe.tailStart > 0) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const rec = parseEventLine(lines[i]);
    if (rec === undefined) continue;
    if (rec === null) return { ok: false, event: null, ts: null };
    return { ok: true, event: String(rec.event), ts: typeof rec.ts === "string" ? rec.ts : null };
  }
  return { ok: true, event: null, ts: null };
}

/**
 * 纯追加的增量结论：只解析 `[prevSize, size)` 区间内的完整行。
 * 任何「无法逐行确证」的情形都返回 null ⇒ 调用方回退全量校验。
 */
function applyAppend(
  probe: Probe,
  prevSize: number,
  entry: EventsIndexEntry,
): { count: number; lastEvent: string | null; lastEventTs: string | null } | null {
  const offsetInTail = prevSize - probe.tailStart;
  // 新增区间必须完整落在尾窗内（含其起点：起点之前一个字节必须是 "\n"，即 prevSize 落在行边界上）。
  if (offsetInTail < 1) return null;
  if (probe.tail[offsetInTail - 1] !== 0x0a) return null; // 上次记录的不是整行边界
  const added = probe.tail.subarray(offsetInTail);
  if (added.length === 0) return null;
  if (added[added.length - 1] !== 0x0a) return null; // 半行（写者未落盘完整）⇒ 不能算已提交事件
  const lines = added.toString("utf8").split("\n");
  lines.pop(); // 末空串
  let count = entry.eventCount;
  let lastEvent = entry.lastEvent;
  let lastEventTs = entry.lastEventTs;
  for (const line of lines) {
    const rec = parseEventLine(line);
    if (rec === undefined) continue;
    if (rec === null) return null; // 新增行不合法 ⇒ 交给 core 报准确行号
    count++;
    lastEvent = String(rec.event);
    lastEventTs = typeof rec.ts === "string" ? rec.ts : null;
  }
  return { count, lastEvent, lastEventTs };
}

/** 统一回退出口：不返回任何数字，调用方必须用 core `readEvents` 全量校验。 */
function fallback(warning: string | null): EventsSummary {
  return { indexed: false, eventCount: 0, lastEvent: null, lastEventTs: null, warning };
}

/**
 * 计算事件流摘要（判据 1/2/3 的唯一入口）。
 *
 * - `indexed: true` ⇒ 结论由索引 + O(1) 探测共同确证（未变或**逐字节可证的纯追加**）。
 * - `indexed: false` ⇒ 调用方**必须**调用 core `readEvents` 全量校验；`warning` 给出可读原因
 *   （首次无索引时为 null —— 那是正常冷启动，不是异常）。
 */
export function summarizeEvents(root: string): EventsSummary {
  const file = join(root, "events.jsonl");
  const { entry, warning: loadWarning } = readIndexFile(root, file);
  if (loadWarning) return fallback(loadWarning);
  if (!entry) return fallback(null); // 首次使用：无索引 ⇒ 静默回退（正常路径）

  let probe: Probe;
  try {
    // 先取一次大小以决定尾窗（避免为「只追加了几行」白读 1MB 尾窗）。
    const size = fileSize(file);
    if (size < 0) return fallback("事件索引与事件流不一致（事件流已不存在，已退回全量校验）");
    if (size < entry.size) {
      return fallback(`事件流被截断（${entry.size} → ${size} 字节，已退回全量校验）`);
    }
    const added = size - entry.size;
    const tailBytes = Math.min(added + 8192, APPEND_WINDOW_BYTES);
    // 用**记录时的 headLen** 取头部（小文件的追加会进入前缀区，长度必须固定）。
    const probed = probeFile(file, tailBytes, entry.headLen);
    if (!probed) return fallback("事件索引与事件流不一致（事件流已不存在，已退回全量校验）");
    if (probed.size !== size) return fallback("事件流在探测期间发生变化（已退回全量校验）");
    probe = probed;
  } catch (e) {
    return fallback(`事件流探测失败（已退回全量校验）：${(e as Error).message}`);
  }

  if (entry.ino !== "" && probe.inoKey !== "" && entry.ino !== probe.inoKey) {
    // 即使内容等价也无法证明中间部分未变 ⇒ 判据 2「被替换不得返回错误聚合」。
    return fallback("事件流文件被替换（inode 变化，已退回全量校验）");
  }
  const headChanged = entry.headSha !== probe.headSha;

  if (probe.size === entry.size) {
    if (headChanged) return fallback("事件流被就地改写（头部指纹变化，已退回全量校验）");
    return {
      indexed: true,
      eventCount: entry.eventCount,
      lastEvent: entry.lastEvent,
      lastEventTs: entry.lastEventTs,
      warning: null,
    };
  }

  // 变大：只有头部指纹不变才可认作「纯追加」（见模块注释的一致性论证）。
  if (headChanged) return fallback("事件流非纯追加变更（头部指纹变化，已退回全量校验）");
  const appended = applyAppend(probe, entry.size, entry);
  if (appended === null) return fallback("事件流新增区间无法逐行确证（已退回全量校验）");
  // 交叉校验：追加后的末事件必须与「文件末行」一致（防增量区间与真实结尾漂移）。
  const tailLast = lastEventFromTail(probe);
  if (!tailLast.ok) return fallback("事件流末行不可解析（已退回全量校验）");
  if (tailLast.event !== appended.lastEvent) {
    return fallback("事件流追加后末事件与新增区间不一致（已退回全量校验）");
  }
  return {
    indexed: true,
    eventCount: appended.count,
    lastEvent: appended.lastEvent,
    lastEventTs: appended.lastEventTs,
    warning: null,
  };
}

/**
 * 全量校验（**唯一**权威路径：复用 core `readEvents`，不复制事件解析逻辑）并把结果写成索引。
 * 事件流不存在时 core 返回空数组（与既有语义一致），此时不写索引（无文件可锚定）。
 * 索引写入失败**不影响**返回值。
 */
export function fullScanAndIndex(root: string): {
  eventCount: number;
  lastEvent: string | null;
  lastEventTs: string | null;
} {
  const file = join(root, "events.jsonl");
  const events = readEvents(root);
  const last = events.length > 0 ? events[events.length - 1] : null;
  const result = {
    eventCount: events.length,
    lastEvent: last ? String(last.event) : null,
    lastEventTs: last && typeof last.ts === "string" ? last.ts : null,
  };
  try {
    const probe = probeFile(file, 0);
    if (probe) writeIndexFile(root, entryFromEvents(file, probe, events));
  } catch {
    /* 索引是纯缓存：写入失败只影响下次速度 */
  }
  return result;
}

/**
 * `collectStatus` 的唯一事件流入口：先试增量索引，不可信就 fail-safe 回退全量校验。
 * 回退原因作为**可读告警**返回（调用方并入 problems），绝不静默返回空或部分聚合。
 */
export function readEventsSummary(root: string): {
  eventCount: number;
  lastEvent: string | null;
  lastEventTs: string | null;
  problems: string[];
  /** 本次是否走了索引快路径（供测试与诊断观察，不改变判定）。 */
  indexed: boolean;
  /** 告警级说明（索引失效但已回退成功）：面向人类**提示**，不参与「看板损坏」判定。 */
  notices: string[];
} {
  const problems: string[] = [];
  const notices: string[] = [];
  const fast = summarizeEvents(root);
  if (fast.indexed) {
    return {
      eventCount: fast.eventCount,
      lastEvent: fast.lastEvent,
      lastEventTs: fast.lastEventTs,
      problems,
      indexed: true,
      notices,
    };
  }
  // 回退原因是「索引层面的告警」——回退本身已经给出权威结论，故记 notices 而非 problems
  // （problems 非空会让 status 退出 1，而索引失效不等于看板损坏）。**绝不只是静默吞掉**。
  if (fast.warning) notices.push(fast.warning);
  try {
    const full = fullScanAndIndex(root);
    return { ...full, problems, indexed: false, notices };
  } catch (e) {
    // 真损坏（core 全量校验也失败）⇒ 这才是 problems / 非零退出。
    problems.push(`事件流不可解析：${(e as Error).message}`);
    return { eventCount: 0, lastEvent: null, lastEventTs: null, problems, indexed: false, notices };
  }
}
