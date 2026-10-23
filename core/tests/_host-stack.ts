/** g-507 B 层依赖解析：**可复现、可移植、不靠作者机器绝对路径**。
 *
 * 真实宿主栈需要 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-host-webserver`、
 * `@deepseek-ai/dsh-client-connection`（版本与 DSH 宿主一致；本仓库 **不** 声明这些运行时依赖，
 * 它们是宿主侧包）。解析顺序固定为：
 *
 *   ① `process.env.G507_HOST_STACK_DIR`（显式指定宿主 `node_modules/@deepseek-ai` 目录）—— 供 CI/离线显式接线；
 *   ② 已安装的 DSH 宿主：`node_modules/@deepseek-ai/dsh`（本仓库或被检 profile 的依赖树里）；
 *   ③ 仓库内**私有副本** `tmp/g507-host-stack/node_modules/@deepseek-ai`（安装缓存与包同在此目录，
 *      绝不写共享 `node_modules`，也绝不跑 pnpm）。
 *
 * 三者都拿不到 ⇒ **显式失败**（`G507HostStackMissing`），绝不静默跳过、绝不用 mock 顶替；
 * 缺失时的安装命令写在错误信息里（`npm install --no-save --prefix tmp/g507-host-stack …`），
 * 版本由本文件 `HOST_STACK_PINS` 固定，保证可复现。
 *
 * 真实宿主包只在测试里使用；产品代码不 import 任何 `@deepseek-ai/*` 包。
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

/** 宿主栈固定版本（与 DSH 0.2.1-rc.2 安装树一致；升级宿主时**必须**同步改这里）。 */
export const HOST_STACK_PINS = Object.freeze({
  "@deepseek-ai/cordis": "4.0.5",
  "@deepseek-ai/dsh-host-webserver": "0.2.1-rc.2",
  "@deepseek-ai/dsh-client-connection": "0.2.1-rc.2",
});

const PACKAGES = Object.keys(HOST_STACK_PINS);

/** 依赖缺失（明确失败，不是 skip）。 */
export class G507HostStackMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "G507HostStackMissing";
  }
}

function versionOf(scopeDir: string, pkg: string): string | undefined {
  // pkg 形如 "@deepseek-ai/<name>" ⇒ 目录 = <scopeDir>/<name>（scopeDir 已指向 @deepseek-ai）
  const name = pkg.split("/").pop() as string;
  try {
    const manifest = JSON.parse(readFileSync(join(scopeDir, name, "package.json"), "utf8"));
    return typeof manifest?.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/** 某个 `node_modules/@deepseek-ai` 目录是否同时具备三个包且版本与固定值一致。 */
function scopeMatches(scopeDir: string): boolean {
  return PACKAGES.every((pkg) => versionOf(scopeDir, pkg) === HOST_STACK_PINS[pkg]);
}

/** 从 `dsh` 包位置推出同级的 `@deepseek-ai` 目录。 */
function scopeFromDsh(dshDir: string): string | undefined {
  // …/node_modules/@deepseek-ai/dsh → …/node_modules/@deepseek-ai
  const scope = dirname(dshDir);
  return scopeMatches(scope) ? scope : undefined;
}

/** ① 显式环境变量。 */
function fromEnv(): string | undefined {
  const dir = process.env.G507_HOST_STACK_DIR;
  if (!dir) return undefined;
  if (!scopeMatches(dir)) {
    const found = PACKAGES.map((p) => `${p}@${versionOf(dir, p) ?? "missing"}`).join(", ");
    throw new G507HostStackMissing(
      `G507_HOST_STACK_DIR=${dir} 不含预期的宿主栈版本（期望 ${JSON.stringify(HOST_STACK_PINS)}，实得 ${found}）`,
    );
  }
  return dir;
}

/** ② 仓库/被检 profile 依赖树里已安装的 DSH 宿主。 */
function fromInstalledHost(): string | undefined {
  const require = createRequire(new URL("../../package.json", import.meta.url));
  const candidates: string[] = [];
  try {
    candidates.push(dirname(require.resolve("@deepseek-ai/dsh/package.json")));
  } catch {
    /* 未安装宿主：继续按路径探测 */
  }
  for (const base of candidates) {
    const scope = scopeFromDsh(base);
    if (scope) return scope;
  }
  return undefined;
}

/** ③ 仓库内私有副本（安装缓存也在此目录）。 */
export function privateStackDir(): string {
  return join(process.cwd(), "tmp", "g507-host-stack");
}

function fromPrivateCopy(): string | undefined {
  const scope = join(privateStackDir(), "node_modules", "@deepseek-ai");
  return scopeMatches(scope) ? scope : undefined;
}

/**
 * 解析宿主栈目录（不安装）。返回 `node_modules/@deepseek-ai` 的绝对路径。
 * @returns {{dir: string, source: "env"|"installed-host"|"private-copy"}}
 */
export function resolveHostStack() {
  const env = fromEnv();
  if (env) return { dir: env, source: "env" as const };
  const host = fromInstalledHost();
  if (host) return { dir: host, source: "installed-host" as const };
  const priv = fromPrivateCopy();
  if (priv) return { dir: priv, source: "private-copy" as const };
  // 仍不存在 ⇒ 尝试在仓库 tmp/ 私有副本里安装（缓存同在 tmp），失败则明确报错。
  return { dir: installPrivateCopy(), source: "private-copy" as const };
}

/**
 * 在仓库 `tmp/` 私有副本里安装固定版本宿主栈（不跑 pnpm、不写共享 node_modules、不用绝对路径）。
 * 安装命令与版本都打进错误信息，便于复现。
 */
export function installPrivateCopy(): string {
  const root = privateStackDir();
  const scope = join(root, "node_modules", "@deepseek-ai");
  if (scopeMatches(scope)) return scope;
  if (process.env.G507_SKIP_HOST_STACK_INSTALL === "1") {
    throw new G507HostStackMissing(
      `宿主栈缺失且已设置 G507_SKIP_HOST_STACK_INSTALL=1（不自动安装）。请先执行：`
      + ` npm install --no-save --prefix ${root} ${PACKAGES.map((p) => `${p}@${HOST_STACK_PINS[p]}`).join(" ")}`,
    );
  }
  const args = ["install", "--no-save", "--no-audit", "--no-fund", "--prefix", root];
  args.push(...PACKAGES.map((p) => `${p}@${HOST_STACK_PINS[p]}`));
  try {
    mkdirSync(root, { recursive: true });
    execFileSync("npm", args, {
      stdio: "pipe",
      // 缓存必须同在仓库 tmp/（不污染全局 npm cache，便于清理与复现）
      env: { ...process.env, npm_config_cache: join(root, ".npm-cache") },
    });
  } catch (cause: any) {
    throw new G507HostStackMissing(
      `无法准备宿主栈（npm ${args.join(" ")} 失败：${String(cause?.message ?? cause).slice(0, 400)}）。`
      + `可改用 G507_HOST_STACK_DIR 指向已安装 DSH 的 node_modules/@deepseek-ai 目录。`,
    );
  }
  // 安装后复检（npm 可能把包 hoist 到上一层 node_modules/@deepseek-ai，故两处都看）
  for (const candidate of [scope, join(root, "node_modules", "@deepseek-ai")]) {
    if (scopeMatches(candidate)) return candidate;
  }
  throw new G507HostStackMissing(
    `安装后仍未找到预期版本（${JSON.stringify(HOST_STACK_PINS)}），目录：${scope}`,
  );
}

/**
 * 加载真实宿主栈模块（全部来自同一份已解析目录，版本已校验）。
 * @returns {Promise<{Context: any, WebServer: any, connectionApi: any, dir: string, source: string}>}
 */
export async function loadHostStack() {
  const { dir, source } = resolveHostStack();
  const url = (pkg: string, file: string) => new URL(`file://${join(dir, pkg, "lib", file)}`).href;
  const { Context } = await import(url("cordis", "index.js"));
  const { WebServer } = await import(url("dsh-host-webserver", "index.js"));
  const connectionApi = await import(url("dsh-client-connection", "index.js"));
  return { Context, WebServer, connectionApi, dir, source };
}

/** 宿主栈目录是否存在（用于报告，不据此 skip）。 */
export function hostStackAvailable(): boolean {
  try {
    resolveHostStack();
    return true;
  } catch {
    return false;
  }
}

