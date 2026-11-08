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

/**
 * 宿主栈固定版本（g-617：已对齐本机安装的 DSH **0.2.2-rc.1** 及其 cordis 4.1.0；升级宿主时**必须**同步改这里）。
 *
 * 为什么钉版本而不是「随便取最新的」：真实宿主栈是**宿主侧包**，本仓库不声明这些运行时依赖。
 * 钉死版本让「测试在哪个宿主上跑」可复现，也让版本漂移**显式失败**而不是静默用错接口。
 * 但「钉死」不等于「写死单一版本即可」：见 {@link HOST_STACK_COMPATIBLE}——同一 cordis 主版本内的
 * 补丁/预发布位差异仍应可用，判定按**能力探测**（包是否齐备 + 主版本相符）而非逐字相等。
 */
export const HOST_STACK_PINS = Object.freeze({
  "@deepseek-ai/cordis": "4.1.0",
  "@deepseek-ai/dsh-host-webserver": "0.2.2-rc.1",
  "@deepseek-ai/dsh-client-connection": "0.2.2-rc.1",
});

const PACKAGES = Object.keys(HOST_STACK_PINS);

/**
 * g-617：**能力探测**式的宿主栈兼容判定（取代 g-507 的「版本逐字相等」）。
 *
 * 为什么改：旧实现要求 `dsh-host-webserver`/`dsh-client-connection` 与 `cordis` 三个包**逐字**等于
 * 固定版本，于是宿主补丁位一升（0.2.1-rc.2 → 0.2.2-rc.1）就把「已安装的宿主」整体判为不可用，
 * 夹具只好回落到 `tmp/` 私有副本或直接抛错 —— 这正是「钉死版本」在宿主升级时的失败形态。
 * 现在按**真实能力**判定：
 *   ① 三个包都必须**存在且版本可读**（缺包 = 真不可用，明确失败，不 skip）；
 *   ② `cordis` 必须与固定版本**同一主版本**（跨主版本是真实的破坏性跃迁：Context/Service 契约会变）；
 *   ③ `dsh-host-webserver` / `dsh-client-connection` 必须与固定版本**同一 `major.minor.patch` 主干**
 *      （预发布/修版本位可以不同），因为它们必须与运行中的 DSH 宿主同批发布。
 */
export function hostStackCompatible(version: string | undefined, expected: string): boolean {
  if (typeof version !== "string" || !version) return false;
  const majorOf = (v: string) => v.split(/[.\-+]/)[0];
  const trunkOf = (v: string) => v.split(/[+\-]/)[0]; // 去掉预发布/构建元数据：0.2.2-rc.1 → 0.2.2
  return majorOf(version) === majorOf(expected) && trunkOf(version) === trunkOf(expected);
}

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

/** 某个 `node_modules/@deepseek-ai` 目录是否同时具备三个包且版本与固定值**能力兼容**（见 {@link hostStackCompatible}）。 */
function scopeMatches(scopeDir: string): boolean {
  return PACKAGES.every((pkg) => hostStackCompatible(versionOf(scopeDir, pkg), HOST_STACK_PINS[pkg]));
}

/** 从 `dsh` 包位置推出同级的 `@deepseek-ai` 目录。 */
function scopeFromDsh(dshDir: string): string | undefined {
  // …/node_modules/@deepseek-ai/dsh → …/node_modules/@deepseek-ai
  // g-617：全局安装形态是 `<globalRoot>/@deepseek-ai/dsh`，它**没有** `node_modules/` 这一层；
  // 实际承载宿主栈的是它自己的 `<dsh>/node_modules/@deepseek-ai`（npm 按依赖就近放置）。
  // 两处都探测，命中即返回，避免只认一种目录形态而静默落到私有副本。
  const candidates = [
    dirname(dshDir),
    join(dshDir, "node_modules", "@deepseek-ai"),
  ];
  for (const scope of candidates) if (scopeMatches(scope)) return scope;
  return undefined;
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

/** ② 仓库/被检 profile 依赖树里已安装的 DSH 宿主（含 `npm root -g` 的全局安装）。 */
function fromInstalledHost(): string | undefined {
  const candidates: string[] = [];
  try {
    const require = createRequire(new URL("../../package.json", import.meta.url));
    candidates.push(dirname(require.resolve("@deepseek-ai/dsh/package.json")));
  } catch {
    /* 本仓库不依赖 dsh ⇒ 继续按全局安装探测 */
  }
  // g-617：本仓库**从不**声明 @deepseek-ai/dsh 为依赖，所以上面那条在本仓库内必然落空；
  // 若不补全局探测，解析就会退到 ③ 私有副本（可能是旧版本），从而与实际运行的宿主分叉。
  // 判据 4 要求「装配到当前已安装 DSH」，故这里按 `npm root -g` 显式探测已安装宿主。
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: "pipe" }).trim();
    candidates.push(join(globalRoot, "@deepseek-ai", "dsh"));
  } catch {
    /* npm 不可用 ⇒ 只剩 ③ */
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

/**
 * g-617：在进程内直构的宿主服务上**跑一遍它们的 `[Service.init]` 钩子**（等价于 cordis 装载时执行）。
 *
 * 为什么必须有它（A/B 两类共 139 例失败的同一根因）：
 *   cordis 只有在服务经 `ctx.plugin()` / fiber 装载时才自动调用 `instance[Service.init]()`；
 *   夹具都是 `new AgentLoop(ctx, …)` **直构**实例，于是：
 *   · `AgentRegistry[Service.init]` 里 `ctx.sessionProjections.register(turnBoundaryProjectionDefinition)`
 *     **从不执行** ⇒ `turnBoundaryProjectionHandle` 永远是 `undefined`
 *     ⇒ `agents.turnBoundaryOf()` 抛 `Cannot read properties of undefined (reading 'stateOf')`（A 类）；
 *   · `AgentLoop[Service.init]` 里 `ctx.agents.setFactory(this)` **从不执行**
 *     ⇒ `agents.create()` 抛 `no agent factory registered (load an agent-loop plugin)`（B 类）。
 *   两类是**同一个**“服务生命周期没被驱动”问题，只是先撞上哪个取决于调用方先碰 `create` 还是先碰 `turnBoundaryOf`。
 *
 * 为什么不是「改用别的公开构造路径」：`turnBoundaryProjectionHandle` 在 0.2.2-rc.1 里**仍然存在**
 * 且仍是 `turnBoundaryOf` 的唯一来源 —— 缺的不是句柄本身，而是**驱动 init 的那一步**。
 * 本函数不替换任何接口，只是把 cordis 本该替我们做的生命周期推进做出来（与 fiber 装载同一语义、同一顺序）。
 *
 * 按**能力探测**工作（判据 4：不得钉死某一宿主版本）：
 *   · 有 `[Service.init]` 就 await（依赖顺序由调用方给出：先 registry 后 loop）；
 *   · 没有该钩子的服务（纯注册型）直接跳过；
 *   · 版本相关的分支全部收敛在 {@link hostStackCompatible} 与这里的两处 `typeof … === "function"` 探测，
 *     不出现任何「本机是 0.2.x 所以…」的硬编码分支。
 *
 * @param services 按**依赖顺序**构造出的服务实例数组（被依赖者在前）。
 * @returns 同一个数组（便于链式使用），但已全部 init 完毕。
 * @throws {G507HostStackMissing} 当**一个**服务都找不到 init 钩子时 —— 说明宿主已改名/移除了该钩子，
 *   此时必须**明确报错**（而不是静默跳过、让下游以晦涩的 `stateOf` / `no agent factory` 报错收场）。
 *   见 {@link serviceInitHookMissing}。
 */
export async function initServiceInstances<T>(services: readonly T[]): Promise<readonly T[]> {
  // cordis 的 Service.init 是 `Symbol.for("cordis.init")`（lib/index.js：`Service.init = symbols.init`），
  // 用 Symbol.for 取同一个全局注册符号，避免依赖某个具体包导出的常量名。
  const INIT = Symbol.for("cordis.init");
  let ran = 0;
  for (const service of services) {
    const init = (service as any)?.[INIT];
    if (typeof init === "function") { await init.call(service); ran += 1; }
  }
  if (services.length > 0 && ran === 0) {
    // 兜底（主管要求）：钩子整体消失 ⇒ 明确失败。若未来宿主把 init 改到别处，这里会点名说清楚，
    // 而不是让 139 个用例各自抛出「读不到 stateOf」这种看不出根因的错。
    throw new G507HostStackMissing(
      `宿主服务生命周期钩子缺失：${services.map((s) => (s as any)?.constructor?.name ?? "?").join(", ")} `
      + `均未提供 Symbol.for("cordis.init") 钩子。cordis 可能已重命名/移除 Service.init —— `
      + `请按新宿主的公开装配方式更新 core/tests/_host-stack.ts 的 initServiceInstances()（不要 skip 用例）。`,
    );
  }
  return services;
}

