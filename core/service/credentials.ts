/**
 * g-623：本地服务**凭据**（MCP token + Web 会话秘密）的生成、落盘、校验与轮换。
 *
 * 安全口径（判据 3 / 4 / 5）：
 * - token 一律由 OS CSPRNG（`crypto.randomBytes`）生成，**≥256 bit**（32 字节），十六进制下发；
 *   不从 root、用户名、模型输出或任何固定默认值派生。
 * - 私有凭据文件权限受限：Linux/macOS 目录 `0700`、文件 `0600`；权限无法限制 ⇒ 拒绝启动
 *   （`assertPrivateTree` fail-closed，不「先启动再修」）。
 * - token **不**进入 Git / `.dsh-graph` / 项目配置 / 日志 / URL query / prompt / tool args：
 *   本模块只写**服务自己的**状态目录（调用方给出），并且**从不**把 token 拼进任何 message。
 * - **MCP token 与 Web 会话分离**：Web 登录用同一个 bootstrap token 换一个短期 bearer，
 *   会话 bearer 存于内存（不落盘、不进 URL），重启即失效。会话 bearer **不是** MCP token，
 *   MCP 端点只接受真正的 MCP token。
 *
 * 轮换/撤销语义：`rotate()` 原子替换磁盘秘密并递增 `generation`（每次进程启动时
 * `generation = 1`），因此「旧 token」= 任何与当前值不相等者，**包括同一凭据文件中已被替换的历史值**；
 * 旧 Web 会话因 generation/secret 不匹配而立即失效。
 */
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** token 的最小熵（bit）。32 字节 = 256 bit。 */
export const MIN_TOKEN_BITS = 256;
export const TOKEN_BYTES = MIN_TOKEN_BITS / 8;

/** 凭据文件名（仅本服务自有状态目录内）。 */
export const TOKEN_FILE_NAME = "token";
export const WEB_SESSION_FILE_NAME = "web-session";

export class CredentialError extends Error {
  readonly code:
    | "entropy_too_low"
    | "permission_too_open"
    | "permission_unavailable"
    | "missing"
    | "malformed";
  constructor(code: CredentialError["code"], message: string) {
    super(message);
    this.name = "CredentialError";
    this.code = code;
  }
}

/** OS CSPRNG 生成至少 256 bit 的秘密（hex 表示）。 */
export function generateSecret(bytes: number = TOKEN_BYTES): string {
  if (!Number.isInteger(bytes) || bytes * 8 < MIN_TOKEN_BITS) {
    throw new CredentialError("entropy_too_low", `token 熵不足：要求至少 ${MIN_TOKEN_BITS} bit`);
  }
  return randomBytes(bytes).toString("hex");
}

/** 常量时间比较（长度不同直接返回 false，不泄露前缀信息给时序侧信道）。 */
export function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 日志/响应用的稳定指纹：只暴露短摘要，绝不暴露原文。 */
export function secretFingerprint(secret: string): string {
  return `sha256:${createHash("sha256").update(String(secret)).digest("hex").slice(0, 12)}`;
}

/** 是否为可接受的 secret 形态（hex，≥64 字符 = ≥256 bit）。 */
export function isWellFormedSecret(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64,}$/i.test(value);
}

const POSIX = process.platform !== "win32";

/** 创建（或复用）0700 私有目录；权限无法限制 ⇒ 抛错（拒绝启动）。 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!POSIX) return;
  let st;
  try {
    st = statSync(dir);
  } catch {
    throw new CredentialError("permission_unavailable", `私有目录不可 stat：${dir}`);
  }
  const mode = st.mode & 0o777;
  if (mode & 0o077) {
    // 已存在但宽权限：尝试收紧一次；仍失败或仍宽 ⇒ 拒绝（不静默继续）。
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* 交由下面的复检判定 */
    }
    const after = statSync(dir).mode & 0o777;
    if (after & 0o077) {
      throw new CredentialError("permission_too_open", `私有目录权限过宽（${(after & 0o777).toString(8)}），无法限制为 0700：${dir}`);
    }
  }
}

/** 原子写 0600 私有文件（temp + rename，同目录同文件系统）。 */
export function writePrivateFile(file: string, content: string): void {
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    if (POSIX) fchmodSync(fd, 0o600);
    writeSync(fd, Buffer.from(content, "utf8"));
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
  if (POSIX) {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) {
      throw new CredentialError("permission_too_open", `私有文件权限过宽（${mode.toString(8)}），要求 0600：${file}`);
    }
  }
}

/**
 * 启动前权限自检：凭据**目录**必须是本进程可独占的私有目录，且不是 symlink。
 * Windows 用当前用户 ACL（本实现依赖用户 profile 目录的既有 ACL；无法验证时**不**宣称已限制）。
 */
export function assertPrivateTree(dir: string): void {
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) {
    throw new CredentialError("permission_too_open", `私有状态目录不允许是 symlink：${dir}`);
  }
  if (!st.isDirectory()) throw new CredentialError("permission_unavailable", `私有状态路径不是目录：${dir}`);
  if (!POSIX) return;
  const mode = st.mode & 0o777;
  if (mode & 0o077) {
    throw new CredentialError("permission_too_open", `私有状态目录权限过宽（${mode.toString(8)}），要求 0700：${dir}`);
  }
}

/** 已存在凭据文件的权限自检（POSIX：必须 0600；宽权限 ⇒ 拒绝，不静默沿用）。 */
export function assertPrivateFile(file: string): void {
  const st = lstatSync(file);
  if (st.isSymbolicLink()) {
    throw new CredentialError("permission_too_open", `凭据文件不允许是 symlink：${file}`);
  }
  if (!POSIX) return;
  const mode = st.mode & 0o777;
  if (mode & 0o077) {
    throw new CredentialError("permission_too_open", `凭据文件权限过宽（${mode.toString(8)}），要求 0600：${file}`);
  }
}

export interface CredentialStoreOptions {
  /** 服务自有的状态目录（**不是** graphRoot，**不是** executionWorkspace）。 */
  stateDir: string;
  /** 注入的随机源（测试可注入确定性实现；默认 OS CSPRNG）。 */
  secretFactory?: (bytes: number) => string;
}

/** 磁盘/内存中的活动秘密。`generation` 每次（重新）生成/轮换 +1。 */
export interface ActiveSecret {
  value: string;
  generation: number;
  createdAt: string;
}

/**
 * 服务主秘密（MCP token 的载体）。**只**在服务内存中解析为明文；
 * 对外只允许 `fingerprint()`。轮换后旧值**不保留**（无宽限期，见设计 §3）。
 */
export class CredentialStore {
  readonly stateDir: string;
  readonly tokenFile: string;
  private readonly factory: (bytes: number) => string;
  private active: ActiveSecret | null = null;
  private revoked = new Set<string>();

  constructor(opts: CredentialStoreOptions) {
    this.stateDir = opts.stateDir;
    this.tokenFile = join(opts.stateDir, TOKEN_FILE_NAME);
    this.factory = opts.secretFactory ?? ((bytes) => generateSecret(bytes));
  }

  /**
   * 首次显式初始化：目录不存在或其中无 token ⇒ 生成一个新 token。返回是否新生成。
   *
   * 顺序很重要（判据 3「权限无法限制则拒绝启动」）：
   *   ① **先**对**已存在**的状态目录与凭据文件做权限自检（宽权限 ⇒ 直接拒绝，不「先收紧再当没事」）；
   *   ② 只有自检通过才创建/补建目录与凭据。
   */
  initialize(): { created: boolean; fingerprint: string; generation: number } {
    if (existsSync(this.stateDir)) {
      assertPrivateTree(this.stateDir);
      if (existsSync(this.tokenFile)) assertPrivateFile(this.tokenFile);
    }
    ensurePrivateDir(this.stateDir);
    assertPrivateTree(this.stateDir);
    if (existsSync(this.tokenFile)) {
      const existing = this.read();
      this.active = { value: existing, generation: 1, createdAt: new Date().toISOString() };
      return { created: false, fingerprint: secretFingerprint(existing), generation: 1 };
    }
    const secret = this.factory(TOKEN_BYTES);
    if (!isWellFormedSecret(secret)) {
      throw new CredentialError("entropy_too_low", "生成的 token 熵不足（要求 ≥256 bit 的 hex 秘密）");
    }
    writePrivateFile(this.tokenFile, `${secret}\n`);
    this.active = { value: secret, generation: 1, createdAt: new Date().toISOString() };
    return { created: true, fingerprint: secretFingerprint(secret), generation: 1 };
  }

  /** 读取磁盘 token（缺失/畸形 fail-closed）。 */
  read(): string {
    if (!existsSync(this.tokenFile)) {
      throw new CredentialError("missing", `凭据文件不存在：${this.tokenFile}（请先显式初始化本服务）`);
    }
    const raw = readFileSync(this.tokenFile, "utf8").trim();
    if (!isWellFormedSecret(raw)) {
      throw new CredentialError("malformed", "凭据文件内容不是合法的 ≥256 bit 秘密");
    }
    return raw;
  }

  /** 启动序列：初始化 + 权限自检（任一失败 ⇒ 拒绝启动）。 */
  open(): { created: boolean; fingerprint: string; generation: number } {
    return this.initialize();
  }

  /** 当前秘密的指纹（只读、可安全展示）。 */
  fingerprint(): string {
    return this.active ? secretFingerprint(this.active.value) : "";
  }

  get generation(): number {
    return this.active?.generation ?? 0;
  }

  /** 校验一个候选 MCP token。失败返回 false，**不**区分「错误」与「已轮换」（不泄露状态机）。 */
  verify(candidate: string | null | undefined): boolean {
    const cur = this.active;
    if (!cur) return false;
    const value = String(candidate ?? "");
    if (value === "") return false;
    if (this.revoked.has(value)) return false;
    return secretsEqual(value, cur.value);
  }

  /**
   * 轮换：生成新秘密原子替换磁盘文件，旧值立即失效（加入 revoked 以免任何缓存路径复活它）。
   * 失败时**不**部分更新：只有磁盘写成功才切换内存态。
   */
  rotate(): { fingerprint: string; generation: number } {
    if (!this.active) throw new CredentialError("missing", "服务尚未初始化，无法轮换");
    const previous = this.active.value;
    const next = this.factory(TOKEN_BYTES);
    if (!isWellFormedSecret(next)) {
      throw new CredentialError("entropy_too_low", "轮换生成的 token 熵不足");
    }
    writePrivateFile(this.tokenFile, `${next}\n`);
    this.revoked.add(previous);
    this.active = { value: next, generation: this.active.generation + 1, createdAt: new Date().toISOString() };
    return { fingerprint: secretFingerprint(next), generation: this.active.generation };
  }

  /** 撤销：删除凭据文件并作废内存秘密（之后一切校验失败）。 */
  revoke(): void {
    if (this.active) this.revoked.add(this.active.value);
    this.active = null;
    try { rmSync(this.tokenFile, { force: true }); } catch { /* 已不存在 */ }
  }
}

/** Web 会话（短期 bearer、内存态、与 MCP token 分离）。 */
export interface WebSession {
  id: string;
  /** 会话 bearer：只在 HttpOnly Cookie 中传递，永不进入 URL/响应体/日志。 */
  secret: string;
  /** 签发时的秘密代际：轮换/撤销后旧会话必须失效。 */
  generation: number;
  createdAt: number;
  lastSeenAt: number;
}

export const DEFAULT_WEB_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Web 会话池。**只在内存**：重启不恢复旧会话（设计 §3「失效」）。
 * 每个会话绑定签发时的 secret 代际；主秘密轮换/撤销后 `verify()` 立即拒绝。
 */
export class WebSessionStore {
  private sessions = new Map<string, WebSession>();
  private readonly ttlMs: number;
  private readonly factory: (bytes: number) => string;
  constructor(opts: { ttlMs?: number; secretFactory?: (bytes: number) => string } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_WEB_SESSION_TTL_MS;
    this.factory = opts.secretFactory ?? ((bytes) => generateSecret(bytes));
  }

  create(generation: number, now = Date.now()): WebSession {
    const session: WebSession = {
      id: this.factory(TOKEN_BYTES).slice(0, 16),
      secret: this.factory(TOKEN_BYTES),
      generation,
      createdAt: now,
      lastSeenAt: now,
    };
    this.sessions.set(session.secret, session);
    return session;
  }

  /** 校验会话 bearer：存在、未过期、且代际仍与当前主秘密代际一致。 */
  verify(secret: string | null | undefined, currentGeneration: number, now = Date.now()): WebSession | null {
    const value = String(secret ?? "");
    if (value === "") return null;
    const s = this.sessions.get(value);
    if (!s) return null;
    if (s.generation !== currentGeneration) {
      this.sessions.delete(value);
      return null;
    }
    if (now - s.lastSeenAt > this.ttlMs) {
      this.sessions.delete(value);
      return null;
    }
    s.lastSeenAt = now;
    return s;
  }

  /** 撤销全部会话（轮换/撤销/停止服务时）。 */
  revokeAll(): void {
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}
