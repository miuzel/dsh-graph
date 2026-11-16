/**
 * g-623：独立本地服务的**请求边界策略**（纯函数，零 I/O、零 store 访问）。
 *
 * 设计口径（设计文档 `docs/g622-local-web-mcp-design.md` §2 与安全负向矩阵）：
 * - 只绑定**数值 loopback** `127.0.0.1`；`0.0.0.0` / `::` / LAN 地址 / 任何主机名一律启动前拒绝，
 *   且**不存在**「绑定失败后回退通配」的路径（调用方拿不到「试一个再换一个」的接口）。
 * - 每个请求校验**实际 socket peer** 为 loopback；不信任 `X-Forwarded-*` 等代理头。
 * - 校验 `Host` 头为「本服务实际监听端口」的本地 allowlist ⇒ 关闭 DNS rebinding。
 * - 浏览器跨站防护：**带 Origin 的请求**必须显式本地 allowlist（同 origin），否则拒绝；
 *   不带 Origin 的 CLI 请求仍需 peer + token（只监听 loopback 不能代替浏览器跨站防护）。
 *
 * 本模块的所有判定都返回 `{ok:true}` 或 `{ok:false, code, message}`，**不做任何副作用**：
 * 调用方必须在任何业务解析、store 访问之前调用它们（fail-closed）。
 */

/** 服务唯一允许的绑定地址（数值回环）。IPv6 未开放（需显式决策，见设计 §2）。 */
export const ALLOWED_BIND_HOST = "127.0.0.1";

/** 被明确拒绝的绑定输入 ⇒ 中文红因（启动前拒绝，不留监听）。 */
export type BindPolicyReason =
  | "wildcard-v4"
  | "wildcard-v6"
  | "name"
  | "lan"
  | "empty"
  | "ipv6";

export type BindPolicyResult =
  | { ok: true; host: string }
  | { ok: false; reason: BindPolicyReason; message: string };

function isIPv4Literal(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  return m.slice(1).every((part) => {
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === String(Number(part));
  });
}

/**
 * peer 回环判定：**只**接受 IPv4 回环网段及其 IPv4-mapped 形态
 * （`::ffff:127.x.y.z`，Node 在 v4 监听上见到 v4 客户端时的双栈表示）。
 *
 * `::1` **不**接受：本服务只绑定 `127.0.0.1`（v4-only），不存在合法的 IPv6 客户端路径；
 * 接受 `::1` 等于为「IPv6 回环」开一条未经决策的入口（设计 §2 明确 v6 需另行显式决策）。
 */
export function isLoopbackAddress(addr: string | null | undefined): boolean {
  const s = String(addr ?? "");
  if (isLoopbackV4(s)) return true;
  return /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.test(s) && isLoopbackV4(s.slice(7));
}

/**
 * 校验一个**IPv4 字面量**是否属于回环网段 `127.0.0.0/8`（peer 地址判定用）。
 * 只接受数值字面量 —— 主机名/DNS 结果**不**参与，避免「解析结果恰好是 loopback」的伪证明。
 */
export function isLoopbackV4(addr: string | null | undefined): boolean {
  const s = String(addr ?? "");
  if (!isIPv4Literal(s)) return false;
  return s.split(".")[0] === "127";
}

/**
 * 启动前校验绑定主机：**只**接受数值 loopback `127.0.0.1`。
 *
 * 为什么按类别分别拒绝（而不是一句「非法」）：安全负向矩阵要求逐项可观测地证明
 * 「通配 / LAN / 主机名 / IPv6」都不是靠字符串巧合被拦下。
 */
export function validateBindHost(host: string | null | undefined): BindPolicyResult {
  const raw = String(host ?? "").trim();
  if (raw === "") return { ok: false, reason: "empty", message: "绑定地址不能为空（只允许 127.0.0.1）" };
  if (raw === ALLOWED_BIND_HOST) return { ok: true, host: ALLOWED_BIND_HOST };
  if (raw === "0.0.0.0") {
    return { ok: false, reason: "wildcard-v4", message: "拒绝绑定 0.0.0.0（通配地址会对外暴露服务）；只允许 127.0.0.1" };
  }
  if (raw === "::" || raw === "[::]" || raw === "::0") {
    return { ok: false, reason: "wildcard-v6", message: "拒绝绑定 ::（IPv6 通配，含 dual-stack 外放风险）；只允许 127.0.0.1" };
  }
  // 任何非数值字面量（localhost、机器名、DNS 名）都不接受：别名不构成回环证明。
  if (!isIPv4Literal(raw) && !raw.includes(":")) {
    return { ok: false, reason: "name", message: `拒绝绑定主机名「${raw}」（只接受数值回环 127.0.0.1，别名解析结果不作证明）` };
  }
  if (raw.includes(":")) {
    return { ok: false, reason: "ipv6", message: `拒绝绑定 IPv6 地址「${raw}」（本服务不开放 IPv6，需另行显式决策）` };
  }
  // 剩余情形：合法数值 IPv4 但不是 127.0.0.1 ⇒ 回环以外（LAN/公网/127.x 的其他值）。
  if (isLoopbackV4(raw)) {
    return { ok: false, reason: "lan", message: `拒绝绑定「${raw}」（只接受精确 127.0.0.1）` };
  }
  return { ok: false, reason: "lan", message: `拒绝绑定非回环地址「${raw}」（LAN/公网地址一律拒绝）` };
}

/** 请求边界判定的稳定错误码（对客户端可见；不含任何 secret）。 */
export type BoundaryCode =
  | "peer_not_loopback"
  | "host_missing"
  | "host_not_allowed"
  | "origin_not_allowed";

export interface BoundaryOptions {
  /** 服务实际监听端口（Host 头的 expected 端口；必须来自实际 `server.address()`）。 */
  port: number;
  /** 实际 socket 的远端地址（`socket.remoteAddress`）。 */
  peerAddress?: string | null;
  /**
   * 是否信任代理头：**当前实现永远为 false**，此开关只为把「不信代理」写成可被负向矩阵观测的
   * 显式策略（任何伪造 `X-Forwarded-For`/`X-Real-IP` 都不会改变判定结果）。
   */
  trustProxyHeaders?: false;
}

/**
 * 校验 Host 头：必须精确等于 `127.0.0.1:<port>` 或 `localhost:<port>`（端口取实际监听端口）。
 * 拒绝：缺失、其他端口、其他主机名、任意绑定的 `0.0.0.0` 形态、以及 IPv6 字面量。
 */
export function isAllowedHostHeader(hostHeader: string | null | undefined, port: number): boolean {
  const raw = String(hostHeader ?? "").trim();
  if (raw === "") return false;
  const m = /^([^:/[\]]+):(\d{1,5})$/.exec(raw);
  if (!m) return false; // 无端口（默认端口）、IPv6 字面量、带路径等一律拒绝
  const hostPart = m[1].toLowerCase();
  if (Number(m[2]) !== port) return false;
  return hostPart === ALLOWED_BIND_HOST || hostPart === "localhost";
}

/** 合法的 Origin 集合：本服务同 origin（`http://127.0.0.1:<port>` / `http://localhost:<port>`）。 */
export function allowedOrigins(port: number): string[] {
  return [`http://${ALLOWED_BIND_HOST}:${port}`, `http://localhost:${port}`];
}

export function isAllowedOrigin(origin: string | null | undefined, port: number): boolean {
  const raw = String(origin ?? "").trim();
  if (raw === "") return false;
  return allowedOrigins(port).includes(raw.toLowerCase());
}

/**
 * 请求级边界判定（peer → Host → Origin，顺序固定：先证明「对端是本机」，再证明「Host 是本站」，
 * 最后证明「浏览器来源是同 origin」）。全部失败即 fail-closed，调用方**必须在**任何业务解析之前调用。
 */
export function checkRequestBoundary(
  req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string | null } | null; peerAddress?: string | null },
  opts: BoundaryOptions,
): { ok: true } | { ok: false; code: BoundaryCode; message: string } {
  const peer = opts.peerAddress ?? req.peerAddress ?? req.socket?.remoteAddress ?? null;
  if (!isLoopbackAddress(peer)) {
    return { ok: false, code: "peer_not_loopback", message: `拒绝非回环 peer「${String(peer)}」（只接受 127.0.0.1）` };
  }
  const hostHeader = headerValue(req.headers, "host");
  if (hostHeader === null || hostHeader.trim() === "") {
    return { ok: false, code: "host_missing", message: "拒绝缺少 Host 头的请求（无法排除 DNS rebinding）" };
  }
  if (!isAllowedHostHeader(hostHeader, opts.port)) {
    return { ok: false, code: "host_not_allowed", message: `拒绝非法 Host「${hostHeader}」（只接受 127.0.0.1:${opts.port} / localhost:${opts.port}）` };
  }
  const origin = headerValue(req.headers, "origin");
  if (origin !== null && origin.trim() !== "" && !isAllowedOrigin(origin, opts.port)) {
    return { ok: false, code: "origin_not_allowed", message: `拒绝外站 Origin「${origin}」（只接受同 origin 的本地页面）` };
  }
  return { ok: true };
}

/** 取单值头（Node 会把重复头合并成数组；这里取第一个，且不做任何规范化猜测）。 */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== lower) continue;
    const v = headers[key];
    if (Array.isArray(v)) return v.length > 0 ? String(v[0]) : null;
    return v === undefined ? null : String(v);
  }
  return null;
}

/**
 * 判断一个 Host/peer 组合是否属于「被伪造代理头试图冒充」的形态（仅用于测试断言命名，
 * 产品逻辑**不读**任何代理头）。
 */
export const PROXY_HEADERS_IGNORED = Object.freeze([
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
]);
