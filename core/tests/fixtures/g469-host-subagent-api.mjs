#!/usr/bin/env node
/**
 * g-469：真实宿主包 subagent 派发 API 契约夹具的**生成器**（离线、确定性）。
 *
 * 用法：
 *   node core/tests/fixtures/g469-host-subagent-api.mjs <a.tgz> [b.tgz ...] > out.json
 *
 * 输入是 `npm pack` 出来的真实宿主包（`@deepseek-ai/dsh-subagent`），脚本用系统 `tar` 只读
 * 解出 `package/lib/index.js`、`package/lib/typert.host.js` 与相关 manager 模块，提取
 *   · 服务方法名集合（typert 模型里的 `"kind": "method"` 条目）
 *   · `startContinuable` / `startActivation` 的**逐字方法体**（花括号配平）
 *   · 我方 spec 实际读取的字段集合（`spec.<field>` 记号）
 *   · receipt 对象字面量的键集合
 *   · provider 能力名（`prepareContinuable`）与 `startActivation` 内部的能力分流表达式
 * 并把每个来源文件的 sha256 一并记下。
 *
 * **确定性**：输出按键排序、无时间戳、无网络、无随机；同一批 tarball 必得同一字节串。
 * 消费方是 `core/tests/g469-host-subagent-api-compat.test.ts`（只读夹具 JSON，**不需要** tarball）。
 * 重新冻结：拿到新宿主 tarball 后重跑本脚本覆盖 `g469-host-subagent-api.json`。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const DISPATCH_METHODS = ["startActivation", "startContinuable"];
const PROVIDER_CAPABILITY = "prepareContinuable";

/** tarball 内单文件读取（只读，不落盘）：tar -xzOf <tgz> <path>。 */
function readMember(tgz, member) {
  return execFileSync("tar", ["-xzOf", tgz, member], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** 尝试读取 tarball 内某成员；不存在时返回 null（不同版本模块布局不同）。 */
function tryReadMember(tgz, member) {
  try {
    return readMember(tgz, member);
  } catch {
    return null;
  }
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** 取出 `async NAME(spec) {` 或 `NAME(spec) {` 的逐字方法体（含声明行），花括号配平。 */
function extractMethodBody(source, name) {
  const re = new RegExp(`(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = re.exec(source);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(m.index, i + 1);
    }
  }
  return null;
}

/** 源码文本里出现过的 `spec.<field>` 字段名（排序去重）。 */
function specFields(text) {
  if (!text) return [];
  return [...new Set([...text.matchAll(/\bspec\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))].sort();
}

/** 从对象字面量文本里取键名，兼容 `{ a, b }` 简写与 `{ a: x, b: y }` 两种形态。 */
function objectLiteralKeys(literal) {
  const inner = literal.slice(literal.indexOf("{") + 1, literal.lastIndexOf("}"));
  const keys = [];
  let depth = 0;
  let current = "";
  for (const ch of inner) {
    if ("{([".includes(ch)) depth++;
    else if ("})]".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      keys.push(current);
      current = "";
    } else current += ch;
  }
  keys.push(current);
  return keys
    .map((part) => {
      const m = /^\s*(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*:/.exec(part);
      if (m) return m[1];
      const shorthand = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(part);
      return shorthand ? shorthand[1] : null;
    })
    .filter(Boolean);
}

/** 取出 `[export] interface NAME {` 的逐字声明体（花括号配平）；不存在返回 null。 */
function extractInterface(source, name) {
  const re = new RegExp(`(?:export\\s+)?interface\\s+${name}\\s*\\{`);
  const m = re.exec(source);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(m.index, i + 1);
    }
  }
  return null;
}

/** 宿主 typert 模型里 `"kind": "method"` 的服务方法名（保序去重）。 */
function typertMethodNames(typert) {
  const names = [...typert.matchAll(/"kind": "method",\s*"name": "([^"]+)"/g)].map((m) => m[1]);
  return [...new Set(names)];
}

function describeTarball(tgz) {
  const pkg = JSON.parse(readMember(tgz, "package/package.json"));
  const entry = readMember(tgz, "package/lib/index.js");
  const typert = readMember(tgz, "package/lib/typert.host.js");
  // 版本相关模块布局：新版 orchestration 在 types/manager.js，旧版在 types/continuation.js。
  const manager = tryReadMember(tgz, "package/lib/types/manager.js");
  const continuation = tryReadMember(tgz, "package/lib/types/continuation.js");
  // 已声明的类型契约（.d.ts）：spec 字段表与 receipt 字段表（比运行时读取更权威的「形状」真源）。
  const typesDts = tryReadMember(tgz, "package/lib/types/types.d.ts");
  const declaredTypes = {};
  for (const name of ["ContinuableStartSpec", "ContinuableStart", "SubagentActivationSpec", "SubagentActivation"]) {
    const body = typesDts === null ? null : extractInterface(typesDts, name);
    if (body === null) continue;
    const fields = [...body.matchAll(/readonly\s+([A-Za-z_$][\w$]*)(\?)?\s*:/g)]
      .map((m) => ({ name: m[1], optional: m[2] === "?" }));
    declaredTypes[name] = { sha256: sha256(body), fields, source: body };
  }

  const methodNames = typertMethodNames(typert);
  const present = Object.fromEntries(DISPATCH_METHODS.map((n) => [n, methodNames.includes(n)]));

  // 服务门面（index.js）里的派发方法体 + 其委派的 manager 方法体：spec 字段来源。
  const facadeBodies = {};
  for (const n of DISPATCH_METHODS) facadeBodies[n] = extractMethodBody(entry, n);
  const managerBodies = {};
  for (const n of ["startLocal", "startExternal", "startContinuable"]) {
    managerBodies[n] = extractMethodBody(manager ?? "", n) ?? extractMethodBody(continuation ?? "", n);
  }

  // receipt：新版是 manager.receipt(activation) 内联返回对象；旧版是 `return { childId, messageId };`
  let receiptKeys = [];
  const receiptBody = extractMethodBody(manager ?? "", "receipt");
  if (receiptBody) {
    const ret = /\breturn\s*(\{[\s\S]*?\})\s*;/g.exec(receiptBody);
    if (ret) receiptKeys = objectLiteralKeys(ret[1]);
  }
  if (receiptKeys.length === 0 && continuation) {
    const ret = [...continuation.matchAll(/\breturn\s*(\{[^}]*\})\s*;/g)].map((m) => objectLiteralKeys(m[1]));
    const hit = ret.find((keys) => keys.includes("childId"));
    if (hit) receiptKeys = hit;
  }

  const dispatchImplName = DISPATCH_METHODS.find((n) => present[n]);
  const dispatchImpl = facadeBodies[dispatchImplName] ?? null;
  // 真正建 child 的实现体（旧版在 continuation.js 的 startContinuable，新版在 manager.js 的 startLocal）。
  const managerImplName = ["startContinuable", "startLocal"].find((n) => managerBodies[n]);
  const managerImpl = managerImplName ? managerBodies[managerImplName] : null;

  const specFieldSet = new Set([
    ...specFields(dispatchImpl),
    ...Object.values(managerBodies).flatMap((b) => specFields(b)),
  ]);

  const capabilitySwitch = new RegExp(
    `${PROVIDER_CAPABILITY}\\s*===\\s*void 0\\s*\\?\\s*manager\\.startExternal\\(spec\\)\\s*:\\s*manager\\.startLocal\\(spec\\)`,
  ).test(entry);

  // 新版 `SubagentActivationSpec` 声明 `delivery` 必填，但运行时把它默认成 'parent'
  // （`delivery: inputs.delivery ?? 'parent'`）⇒ 我方沿用旧调用形态（不传 delivery）时
  // 仍是「parent 交付 / 建目录 child」，与旧版 `startContinuable` 的行为一致。
  const deliveryDefault = manager === null
    ? null
    : /delivery:\s*inputs\.delivery\s*\?\?\s*'parent'/.test(manager)
      ? "parent"
      : null;

  return {
    host_version: pkg.version,
    tarball: tgz.split("/").pop(),
    tarball_sha256: sha256(readFileSync(tgz)),
    entry_sha256: sha256(entry),
    typert_sha256: sha256(typert),
    methods: present,
    service_method_names: methodNames,
    dispatch_impl: dispatchImpl === null ? null : {
      name: dispatchImplName,
      sha256: sha256(dispatchImpl),
      source: dispatchImpl,
    },
    manager_impl: managerImpl === null ? null : {
      name: managerImplName,
      sha256: sha256(managerImpl),
      source: managerImpl,
    },
    spec_fields: [...specFieldSet].sort(),
    receipt_keys: receiptKeys.slice().sort(),
    // 新版声明的必填字段 `delivery` 的运行时默认值（null = 该版没有该字段/无法确认）。
    optional_field_defaults: { delivery: deliveryDefault },
    // 该版声明的 spec / receipt 类型（verbatim 片段 + 字段表；键名即类型名）
    declared_types: declaredTypes,
    provider_capability: {
      name: PROVIDER_CAPABILITY,
      // 两版都在：能力探测名不得随派发方法改名而变（我方 4 处能力探测依赖它）。
      present_in_entry: entry.includes(PROVIDER_CAPABILITY),
      // 各版本的「真正建 child」实现里都按该能力分流本地/外部后端（新旧同形）。
      present_in_manager_impls: Object.entries(managerBodies)
        .filter(([, body]) => body)
        .map(([name, body]) => ({ method: name, has_capability: body.includes(PROVIDER_CAPABILITY) })),
      capability_switch_expression: capabilitySwitch,
    },
  };
}

const tarballs = process.argv.slice(2);
if (tarballs.length === 0) {
  process.stderr.write("用法: node core/tests/fixtures/g469-host-subagent-api.mjs <tarball.tgz> [...]\n");
  process.exit(2);
}

const fixture = {
  schema: "g469-host-subagent-api/v1",
  generator: "core/tests/fixtures/g469-host-subagent-api.mjs",
  probe_contract: {
    provider_capability: PROVIDER_CAPABILITY,
    dispatch_methods: DISPATCH_METHODS,
    // 我方调用形态：这些 spec 字段逐字使用；返回读取 `childId`（`parentSessionId` 缺失时 ??: null 兜底）
    call_spec_fields: ["provider", "label", "request", "signal"],
    receipt_field: "childId",
    optional_receipt_field: "parentSessionId",
  },
  versions: tarballs.map(describeTarball).sort((a, b) => (a.host_version < b.host_version ? -1 : a.host_version > b.host_version ? 1 : 0)),
};

process.stdout.write(JSON.stringify(fixture, null, 2) + "\n");
