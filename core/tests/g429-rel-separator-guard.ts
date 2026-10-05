/**
 * core/tests/g429-rel-separator-guard.ts —— g-429 的**防复发结构守卫**（由 g429 测试套件消费）。
 *
 * 缺陷形态（真机实证，`docs/platform-gate.md` §7 / g-428 首跑）：
 *   `relative()` / `file.slice(root.length + 1)` 在 Windows 上产出 `\` 分隔路径；站点若对它的结果
 *   写裸 `split("/")` 或 `startsWith("x/")`，则 ① `split("/")` 只切出一整段 ⇒ 分类必抛；
 *   ② `startsWith("x/")` 永不命中 ⇒ 检查/对账**静默失效**（不报错、只是不检查）。
 *
 * 守卫口径（fail-closed，且**覆盖全部**同类写法而非抽样）：
 *   - 扫描面 = 产品源码 `core/**\/*.ts`（排除 `core/tests/**`，与 g-428 台账 `collectProductSourceFiles` 同口径；
 *     测试自身要写 `/` 字面量与反例样本，纳入扫描只会制造噪声）。
 *   - 扫描点 = 每个 `.split("/")` 与 `.startsWith(<实参含 "/">)`。**每个点都必须落入下列之一**，
 *     否则判红（`[unregistered]`）：这是本守卫的核心 —— 没有「悄悄新增一处」的路径。
 *       (a) 收口区间内：`core/ops.ts` 的 `g-429:rel-separator-surgery:begin/:end`（唯一分隔符手术出口）；
 *       (b) **非**相对路径派生值、且该值已被显式归一化（`.replace(/\\/g, "/")` / `normalizeRelPath(…)` /
 *           `.split(sep).join("/")`）—— 例：`core/review-policy.ts:regionOfPath` 的 git 路径；
 *       (c) 登记在 `SEPARATOR_SITES_ALLOWLIST` 里，带 `kind`（`rel-dual-separator` / `non-rel-string`）与**理由**。
 *   - 分类校验（防「登记成非相对路径来绕过收口」）：`non-rel-string` 的登记点**不得**是相对路径派生值；
 *     `rel-dual-separator` 的登记点必须**是**相对路径派生值，且命中行必须自带 `\` 对照（裸 POSIX 写法不得进清单）。
 *   - 相对路径派生（保守判定，只认一跳，避免把普通字符串误判为路径而制造噪声）：
 *     绑定的 RHS 直接含 `relative(` 或 `.slice(<x>.length + 1)`。
 *   - 陈旧条目（登记了却无对应命中）判红；理由过短（< 20 字符）判红。
 *
 * 该模块只导出纯函数 ⇒「造一个违规样本 ⇒ 必红」可**实拍**（见 g429 测试套件的负向对照），
 * 无需把违规代码真的写进产品源码。
 */

export interface SourceFile {
  path: string;
  text: string;
}

export interface SeparatorSite {
  file: string;
  /** 1-based 行号 */
  line: number;
  /** 最近的顶层函数/箭头函数名（诊断与允许清单键；不在收口区间且未登记即判红） */
  symbol: string;
  /** 被操作的对象；内联表达式（`…slice(root.length+1).split("/")`）为 `<inline>` */
  receiver: string;
  op: "split" | "startsWith";
  /** split 恒为 `"/"`；startsWith 为实参原文（已 trim） */
  arg: string;
  /** 该值是否由相对路径派生（`relative()` / `.slice(<x>.length + 1)` 直接绑定） */
  relDerived: boolean;
  /** 该值是否已被显式归一化（`.replace(/\\/g,"/")` / `normalizeRelPath(...)` / `.split(sep).join("/")`） */
  normalized: boolean;
  /** 命中行原文 */
  text: string;
}

export type AllowKind = "rel-dual-separator" | "non-rel-string";

export interface SiteAllowEntry {
  file: string;
  symbol: string;
  op: SeparatorSite["op"];
  arg: string;
  kind: AllowKind;
  /** 允许理由（必填、不得过短；「允许清单必须带理由」由断言强制执行） */
  reason: string;
}

/** 标记区间：`core/ops.ts` 内唯一允许做相对路径分隔符手术的地方（收口出口）。 */
export const SURGERY_BEGIN = "g-429:rel-separator-surgery:begin";
export const SURGERY_END = "g-429:rel-separator-surgery:end";

const DUAL_SEPARATOR_REASON =
  "g-429 之前的局部正确范式：同时对 `\\` 与 `/` 判定（`startsWith(\"backlog/\") || startsWith(\"backlog\\\\\")`），" +
  "语义等价于归一化后判定；保留作**正确范式对照**，是本清单里唯一允许的 rel 例外。新增同类写法必须改走 " +
  "core/ops.ts 的 g-429 helper（normalizeRelPath/relPathSegments/classifyGoalRel…）而不是再抄一份双分隔符判定。";

/**
 * 允许清单（逐条带理由）。当前全部落在 `core/ops.ts`：
 *  - `non-rel-string`：`@att/name` 附件**逻辑**路径（契约本就 POSIX，反斜杠已被 sanitizeAttachmentPath 拒绝）
 *    与 `reused_by` 的「目标/attempt id」（非文件系统路径）—— 均非 `relative()` 产物；
 *  - `rel-dual-separator`：`isBacklogFile` 的双分隔符写法（正确范式对照）。
 */
export const SEPARATOR_SITES_ALLOWLIST: SiteAllowEntry[] = [
  {
    file: "core/ops.ts",
    symbol: "isBacklogFile",
    op: "startsWith",
    arg: '"backlog/"',
    kind: "rel-dual-separator",
    reason: DUAL_SEPARATOR_REASON,
  },
  {
    file: "core/ops.ts",
    symbol: "isBacklogFile",
    op: "startsWith",
    arg: '"backlog\\\\"',
    kind: "rel-dual-separator",
    reason: DUAL_SEPARATOR_REASON,
  },
  {
    file: "core/ops.ts",
    symbol: "sanitizeAttachmentPath",
    op: "split",
    arg: '"/"',
    kind: "non-rel-string",
    reason:
      "切分的是附件**逻辑**路径 `@att/<name>`（契约本就 POSIX 式）：同函数开头已显式拒绝反斜杠与冒号" +
      "（`s.includes(\"\\\\\")` ⇒ 抛错），故不存在 Windows 反斜杠形态；非 relative() 产物。",
  },
  {
    file: "core/ops.ts",
    symbol: "resolveAttachmentPath",
    op: "split",
    arg: '"/"',
    kind: "non-rel-string",
    reason:
      "输入由 `sanitizeAttachmentPath(relPath)` 先行校验并规范（同上，反斜杠/冒号/`..` 均被拒绝），" +
      "此处只是把已规范化的逻辑路径切成目录段；非 relative() 产物。",
  },
  {
    file: "core/ops.ts",
    symbol: "goalItem",
    op: "split",
    arg: '"/"',
    kind: "non-rel-string",
    reason:
      "切分的是 `attempt.reused` 事件里 `reused_by` 的「目标/attempt id」（形如 `g-1/att-001`），" +
      "非文件系统路径，与平台分隔符无关。",
  },
];

export function allowEntryKey(e: Pick<SiteAllowEntry, "file" | "symbol" | "op" | "arg">): string {
  return `${e.file}#${e.symbol}#${e.op}#${e.arg}`;
}

export function siteKey(s: Pick<SeparatorSite, "file" | "symbol" | "op" | "arg">): string {
  return `${s.file}#${s.symbol}#${s.op}#${s.arg}`;
}

/** 剥掉注释（行注释 + 块注释），逐行返回代码文本；块注释内的行返回空串。 */
export function stripComments(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    let code = "";
    let i = 0;
    while (i < raw.length) {
      if (inBlock) {
        const end = raw.indexOf("*/", i);
        if (end === -1) { i = raw.length; break; }
        inBlock = false; i = end + 2; continue;
      }
      const two = raw.slice(i, i + 2);
      if (two === "//") { i = raw.length; break; }        // 行注释：其后全部丢弃
      if (two === "/*") { inBlock = true; i += 2; continue; }
      code += raw[i]; i += 1;
    }
    out.push(code);
  }
  return out;
}

/** 相对路径派生（一跳：RHS 直接含 `relative(` 或 `.slice(<x>.length + 1)`）。 */
const REL_DERIVE_RE = /relative\s*\(|\.slice\([^)]*\.length\s*\+\s*1\s*\)/;
/** 显式归一化标记（与 g-429 helper / g-363 既有写法同源）。 */
function isNormalizedExpr(src: string): boolean {
  return (
    src.includes('.replace(/\\\\/g, "/")') ||
    src.includes("normalizeRelPath(") ||
    src.includes("relPathSegments(") ||
    src.includes("relPathStartsWithSegments(") ||
    src.includes('.split(sep).join("/")')
  );
}

/** 站点参数是否含分隔符字面量：`/` 一律算；`\` 只在同一行也出现「含 `/` 的实参」时算
 *  （即双分隔符对照写法，避免把 `startsWith("\\n")` 这类非路径转义误当站点）。 */
export function startsWithArgsToCheck(args: string[]): string[] {
  const hasSlashArg = args.some((a) => a.includes("/"));
  return args.filter((a) => a.includes("/") || (hasSlashArg && a.includes("\\")));
}

const DECL_RE = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?!=)(.*)$/;
const ASSIGN_RE = /^\s*([A-Za-z_$][\w$]*)\s*=\s*(?!=)(.*)$/;
const SPLIT_RE = /(?:([A-Za-z_$][\w$]*)\s*)?\.split\(\s*"\/"\s*\)/g;
const STARTSWITH_RE = /(?:([A-Za-z_$][\w$]*)\s*)?\.startsWith\(([^)]*)\)/g;
const TOP_FN_RE = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
const TOP_ARROW_RE = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/;

interface BindingInfo {
  relDerived: boolean;
  normalized: boolean;
}

/** 扫描产品源码，返回全部同类站点（含收口区间内的点；区间信息由 judge 处理）。 */
export function scanSeparatorSites(files: SourceFile[]): Array<SeparatorSite & { inSurgery: boolean }> {
  const sites: Array<SeparatorSite & { inSurgery: boolean }> = [];
  for (const file of files) {
    const rawLines = file.text.split(/\r?\n/);
    const lines = stripComments(file.text);
    const bindings = new Map<string, BindingInfo>();
    let inSurgery = false;
    let symbol = "<module>";
    for (let idx = 0; idx < lines.length; idx += 1) {
      const code = lines[idx];
      // 标记本身写在注释里 ⇒ 必须用**原文**判定区间边界
      if (rawLines[idx]?.includes(SURGERY_BEGIN)) { inSurgery = true; continue; }
      if (rawLines[idx]?.includes(SURGERY_END)) { inSurgery = false; continue; }
      const fn = TOP_FN_RE.exec(code) ?? TOP_ARROW_RE.exec(code);
      if (fn) symbol = fn[1];
      const bind = DECL_RE.exec(code) ?? ASSIGN_RE.exec(code);
      if (bind) {
        const [, name, rhs] = bind;
        bindings.set(name, { relDerived: REL_DERIVE_RE.test(rhs), normalized: isNormalizedExpr(rhs) });
      }
      const emit = (receiver: string | undefined, op: SeparatorSite["op"], arg: string) => {
        const info = receiver ? bindings.get(receiver) : undefined;
        // 内联表达式：整行即表达式（如 `file.slice(root.length + 1).split("/")`）
        const relDerived = receiver ? Boolean(info?.relDerived) : REL_DERIVE_RE.test(code);
        const normalized = receiver ? Boolean(info?.normalized) : isNormalizedExpr(code);
        sites.push({
          file: file.path, line: idx + 1, symbol,
          receiver: receiver ?? "<inline>", op, arg,
          relDerived, normalized, inSurgery, text: code.trim(),
        });
      };
      for (const m of code.matchAll(SPLIT_RE)) emit(m[1], "split", '"/"');
      const swMatches = [...code.matchAll(STARTSWITH_RE)];
      const swArgs = startsWithArgsToCheck(swMatches.map((m) => m[2]));
      for (const m of swMatches) {
        if (swArgs.includes(m[2])) emit(m[1], "startsWith", m[2].trim());
      }
    }
  }
  return sites;
}

export interface GuardVerdict {
  /** 收口区间**之外**的全部站点 */
  sites: SeparatorSite[];
  allowed: SeparatorSite[];
  /** 既未收口、也未归一化、也未登记 ⇒ 判红的站点 */
  unallowed: SeparatorSite[];
  /** 问题清单（空 = 通过） */
  problems: string[];
}

/** 判定：未归类站点 / 分类错挂 / 裸 POSIX 进清单 / 理由过短 / 陈旧条目 一律判红。 */
export function judgeRelSeparatorGuard(
  files: SourceFile[],
  allowlist: SiteAllowEntry[] = SEPARATOR_SITES_ALLOWLIST,
): GuardVerdict {
  const problems: string[] = [];
  const byKey = new Map(allowlist.map((e) => [allowEntryKey(e), e]));
  const matched = new Set<string>();
  const sites: SeparatorSite[] = [];
  const allowed: SeparatorSite[] = [];
  const unallowed: SeparatorSite[] = [];

  for (const e of allowlist) {
    if (e.reason.trim().length < 20) problems.push(`允许清单理由过短（必须写明为什么可以例外）：${allowEntryKey(e)}`);
    if (e.kind !== "rel-dual-separator" && e.kind !== "non-rel-string") {
      problems.push(`允许清单 kind 非法（只允许 rel-dual-separator / non-rel-string）：${allowEntryKey(e)}`);
    }
  }

  for (const scanned of scanSeparatorSites(files)) {
    const { inSurgery, ...site } = scanned;
    if (inSurgery) continue;               // (a) 收口出口
    sites.push(site);
    const entry = byKey.get(siteKey(site));
    if (!entry) {
      // (b) 非相对路径派生 + 已显式归一化 ⇒ 放行
      if (!site.relDerived && site.normalized) continue;
      unallowed.push(site);
      const shape = site.op === "split" ? 'split("/")' : `startsWith(${site.arg})`;
      problems.push(
        `[unregistered] ${site.file}:${site.line} ${site.symbol} 对 ${site.receiver} 使用裸 ${shape}` +
        `（relDerived=${site.relDerived} normalized=${site.normalized}）—— 必须改走 core/ops.ts 的 g-429 归一化 helper，` +
        `或（仅限非相对路径的字符串）先显式归一化，或在允许清单登记并写明理由`,
      );
      continue;
    }
    matched.add(allowEntryKey(entry));
    allowed.push(site);
    if (entry.kind === "non-rel-string" && site.relDerived) {
      problems.push(
        `[misclassified-non-rel] ${site.file}:${site.line} 登记为 non-rel-string，但该值实为相对路径派生` +
        `（relative()/slice(root.length+1)）—— 不得用「非相对路径」的名义绕过收口`,
      );
    }
    if (entry.kind === "rel-dual-separator") {
      if (!site.relDerived) {
        problems.push(
          `[misclassified-rel] ${site.file}:${site.line} 登记为 rel-dual-separator，但该值并非相对路径派生`,
        );
      }
      if (!site.text.includes(String.raw`\\`)) {
        problems.push(
          `[allowlist-without-backslash] ${site.file}:${site.line} 缺少反斜杠对照（裸 POSIX 写法不得登记为正确范式）：${site.text}`,
        );
      }
    }
  }

  for (const e of allowlist) {
    if (!matched.has(allowEntryKey(e))) {
      problems.push(`[stale-allowlist] ${allowEntryKey(e)} 已无对应命中（清单与实现漂移），请删除该条目`);
    }
  }
  return { sites, allowed, unallowed, problems };
}
