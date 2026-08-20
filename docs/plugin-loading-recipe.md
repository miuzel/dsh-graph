# 本地第三方 cordis 插件加载进 DSH profile —— 实机验证配方

验证环境：Node v26.7.0 · DSH 安装 `/home/miuzel/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/`
· 隔离 `DSH_HOME`（**未触碰** `~/.dsh/profiles/web`）· 全部命令实机跑过。

本目录（`probe/`）是可复现的验证台：
- `probe/dsh-hello-plugin/` 最小宿主插件（bundle 形态）
- `probe/home/` 隔离的 `DSH_HOME`（含自动初始化的 `headless` profile）
- `probe/final.err` 最后一次全量启动的 stderr 证据

清理：`rm -rf probe`。

---

## 0. 三条已验证的挂载路径（按推荐度）

| 路径 | 用户操作 | 适用 |
|---|---|---|
| **A. bundle 包 + `dsh plugin add`** | 一条命令，`dsh.profile.bundles` 自动追加 | 正式交付 `dsh-graph-host` |
| **B. profile `cordis.patch.yml` 手写 `insert`** | 编辑一个 YAML | 本地开发 / 快速试 |
| **C. `--patch overlay.yml` 覆盖层** | 完全不改 profile 文件 | 一次性实验、不污染 profile |

`$DSH_HOME/cordis.patch.yml`（home 级）同样可用，但**相对 specifier 仍以 profile 目录为基准**（不是 patch 文件所在目录），极易写错，不推荐。

---

## 1. 最小插件文件（零 `@deepseek-ai/*` 运行时依赖）

`/tmp/dsh-hello-plugin/package.json`：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.0.2",
  "private": true,
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`/tmp/dsh-hello-plugin/index.js`：

```js
// 只有具名导出：绝不能再加 export default（见「坑」#4）
import { appendFileSync } from 'node:fs'

const MARKER = new URL('./loaded.log', import.meta.url)
function note(line) {
  try { appendFileSync(MARKER, `${new Date().toISOString()} ${line}\n`) } catch {}
  process.stderr.write(`[dsh-hello-plugin] ${line}\n`)
}

export const name = 'dsh-hello-plugin'
export const inject = ['tools']          // 硬依赖：cordis 会等 tools 服务出现再激活

export function apply(ctx, config) {
  note(`apply() config=${JSON.stringify(config ?? null)}`)
  ctx.effect(() => ctx.tools.register({   // disposer 归本 fiber，卸载即摘除工具
    name: 'hello_marker',
    description: 'Return a fixed marker string proving the third-party plugin is live.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { marker: { type: 'string' } },
                required: ['marker'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: `marker=${value.marker}` }],
    },
    execute: async () => ({ marker: 'dsh-hello-plugin-alive' }),
  }))
  note(`tools=${ctx.tools.schemas().map(s => s.name).join(',')} ` +
       `get=${ctx.tools.get('hello_marker') ? 'FOUND' : 'MISSING'}`)
}
```

`/tmp/dsh-hello-plugin/cordis.patch.yml`（bundle 层；**用裸包名**，因为 bundle 的行是合成进 profile 树的，
specifier 以 *profile 目录* 为基准，不是 bundle 目录）：

```yaml
- insert:
    - id: hello-plugin
      name: dsh-hello-plugin
      config:
        greeting: from-bundle-layer
```

---

## 2. 路径 A：bundle 包 + `dsh plugin add`（推荐）

```sh
export DSH_HOME=/tmp/dsh-home              # 生产用直接省略，走 ~/.dsh
dsh --profile headless --dump-default-config >/dev/null   # 首次使用自动初始化 headless profile
dsh plugin --profile headless add /tmp/dsh-hello-plugin   # pnpm link: + 自动 reconcile bundles
dsh --profile headless --dump-config | tail -6            # 看到 "# == dsh-hello-plugin" 归属行
dsh --profile headless "ping"                             # 全量启动（真正会断言插件已加载激活）
```

`dsh plugin add` 之后 profile manifest 被自动改成：

```json
"dependencies": { "dsh-hello-plugin": "link:/tmp/dsh-hello-plugin" },
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-hello-plugin"] } }
```

机制（`dsh/lib/plugin-*.js` `reconcilePlugins`）：按**安装后实际状态**对账——依赖解析到的包若声明
`dsh.bundle.patch` 就追加进 `bundles`；不声明则只打一行 warning 当普通库；版本升级后新增声明会自动激活。

## 3. 路径 B：profile 用户层 `insert`（不需要 pnpm）

`$DSH_HOME/profiles/headless/cordis.patch.yml` 原文：

```yaml
- insert:
    - id: hello-plugin
      name: '../../../dsh-hello-plugin/index.js'   # 相对 profile 目录，必须指到文件
      config:
        greeting: hello-from-tmp
```

（`$DSH_HOME/profiles/headless` → `../../../` = `/tmp` 的父级换算；`DSH_HOME=/tmp/dsh-home` 时正好指到 `/tmp/dsh-hello-plugin`。）

## 4. 路径 C：`--patch` 覆盖层（不改 profile 任何文件）

```sh
cat > /tmp/overlay.yml <<'YML'
- insert:
    - id: hello-overlay
      name: dsh-hello-plugin        # 或相对文件路径
      config: { greeting: from-overlay }
YML
dsh --profile headless --patch /tmp/overlay.yml "ping"
```

---

## 5. 验证证据（实测输出摘要）

```
$ dsh --profile headless --dump-config | tail -6
# == dsh-hello-plugin
- id: hello-plugin
  name: dsh-hello-plugin
  config:
    greeting: from-bundle-layer

$ dsh --profile headless "ping"      # exit 1，但失败点在 LLM 凭据，不在插件树
tree settled: OK
MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
[dsh-hello-plugin] apply() config={"greeting":"from-bundle-layer"}
[dsh-hello-plugin] ctx.tools=object register=function
[dsh-hello-plugin] registered; tools now visible = hello_marker
[dsh-hello-plugin] get('hello_marker') = FOUND
```

四重证据：① `--dump-config` 有归属注释的条目；② `apply()` 拿到 patch 里的 `config`；
③ `ctx.tools.get('hello_marker')` = FOUND（同一个 agent 用的注册表）；
④ 全量启动通过 `assertEntriesLoaded/Activated`，只在之后的 LLM 凭据处失败。

负向对照（证明验证有效）：

```
name: './does-not-exist.js'   → dsh: plugin tree failed to load: ... Cannot find module '.../profiles/headless/does-not-exist.js'
name: '../../../dsh-hello-plugin'  → ERR_UNSUPPORTED_DIR_IMPORT: Directory import ... is not supported
import '@deepseek-ai/cordis'（realpath 在 profiles 之外） → Cannot find package '@deepseek-ai/cordis'
具名导出 + export default { apply } → cannot get property "tools" without inject
```

---

## 6. 坑与限制（全部实测）

1. **`dsh --profile headless --help` 会静默吞掉加载失败**：app 的 `--help` 在 loader 结算前就 `exit(0)`，
   `./does-not-exist.js` 也照样 exit 0、零诊断。**只能用它做"正向"证据（看到插件日志），不能用它证明没问题。**
   要判失败必须跑会走完启动的命令（`dsh --profile headless "<task>"`）。
2. **相对 specifier 不能指目录**：Node ESM `ERR_UNSUPPORTED_DIR_IMPORT`。必须写到 `.../index.js`，
   或改用裸包名（走 `package.json` 的 `exports`/`main`）。
3. **相对 specifier 的基准永远是配置目录（profile 目录）**，即使 patch 条目来自 home 级 `cordis.patch.yml`
   或 `--patch` 文件。`dsh` 启动时**不传** `bareModuleBaseUrl`（`boot(NAME, rootConfig, patches, prepare)`，4 参），
   所以裸包名也从 profile 目录起按 Node 常规逐级向上找：
   `profiles/<name>/node_modules` → `profiles/node_modules`（`healProfilesModuleFallback` 维护的扁平符号链接目录）→ …
4. **`export default` 会吃掉 `inject`**：Loader 的 `unwrapExports` 见到 default 就塌缩到它。
   具名 `name/inject/apply` **再加**一个 `export default { apply }` → 启动直接报
   `cannot get property "tools" without inject`。只用 default 导出整个插件对象倒是能跑，
   但官方约定（`dsh-tool-todo` README「Export shape」+ docs/postmortem/0001）是**只用具名导出、不要 default**。
5. **运行时 `import '@deepseek-ai/cordis'` 会失败**，只要插件的 **realpath** 不在 `$DSH_HOME/profiles/**` 下面。
   `dsh plugin add /path` 生成的是 `link:` 符号链接，Node 按 realpath 解析，于是 `/tmp/dsh-hello-plugin`
   往上只能找到 `/tmp/node_modules`、`/node_modules`。三种解法（1、2 已实测通过）：
   1. `ln -s $DSH_HOME/profiles/node_modules /tmp/dsh-hello-plugin/node_modules`；
   2. 让包真身住在 profile 目录里（如 `$DSH_HOME/profiles/headless/plugins/hello/`），父级走查即可命中 `profiles/node_modules`；
   3. **最佳：运行时零 `@deepseek-ai/*` import**（`Context`/`Service` 只作 `import type`，被 TS 擦除）。
      需要 `Schema`（schemastery）或 `defineTool` 时才必须解决解析，此时用 1 或 2。
6. **`apply()` 里看不到别的工具**：`ctx.tools.schemas()` 当时只有 `hello_marker`——cordis 按服务可用性并发激活，
   别的 tool 插件还没注册。不要在 `apply()` 里假设别人已就绪；要观察全量请用事件。
7. **`ctx.get('tools')` 在 apply 早期可能是 `undefined`**（首版实测 `tools present=false`）。想要"等它出现"就必须
   声明 `inject: ['tools']`（声明后 `ctx.tools` 稳定可用）；只想可选增强才用 `ctx.get()` + 缺失分支。
8. **本沙箱特有**：`~/.dsh` 只读（故全程用隔离 `DSH_HOME`）；`/tmp` 是每次 bash 调用私有的 tmpfs，
   跨调用不保留——所以 `/tmp` 配方是在**单次调用内**完整复现的，持久台放在 `probe/`。
   `pnpm` 默认 store（`~/.local/share/pnpm`）不可写 → `dsh plugin add` 报 `[ERR_SQLITE_ERROR] unable to open database file`；
   加 `--store-dir <可写目录>` 即通过（此为沙箱限制，真实环境无此问题）。
9. **未验证项**：`watchUserPatches` 的热加载（改 `cordis.patch.yml` 免重启生效）文档有述、本次未测；
   模型真正调用 `hello_marker`（隔离 home 无凭据，且不动用户凭据/token）——但工具已在注册表中被 `get()` 命中。

---

## 7. 对 `dsh-graph-host` 包结构的建议

```
dsh-graph-host/
  package.json
  cordis.patch.yml        # 自己的 bundle 层：insert 自己的行
  lib/index.js            # 具名导出 name / inject / apply / Config
```

`package.json` 关键字段：

```json
{
  "name": "@dsh-graph/host",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.8",
    "@deepseek-ai/dsh-session": "^0.1.0-rc.8",
    "@deepseek-ai/dsh-agent": "^0.1.0-rc.8"
  },
  "devDependencies": { "…同上，供本地 tsc/类型用…": "*" }
}
```

- **`dsh.bundle.patch` 是关键**：有它 `dsh plugin --profile <x> add <path|pkg>` 就自动进 `dsh.profile.bundles`，
  用户不用手写 YAML；没有它只能靠路径 B/C。
- **peerDependencies 而非 dependencies**：DSH 的服务包必须与宿主同一实例；`healProfilesModuleFallback` 的 BFS
  会把 `dependencies` + `peerDependencies` 闭包都软链到 `$DSH_HOME/profiles/node_modules`，所以声明成 peer
  正好让运行时解析到宿主自带的那一份（前提是 realpath 在 profiles 下，见坑 #5；开发期用 `link:` 时按 #5.1 加软链）。
- **`apply` 形态**：`export function apply(ctx, config)`，`export const name`，`export const inject = [...]`，
  可选 `export const Config = z.object({...})`（schemastery，运行时 import，属于要解析的依赖）。**禁止 `export default`**。
- **`inject` 声明**：硬依赖才写。`dsh-graph` 若要注册工具 → `inject: ['tools']`；要读写会话 → 加 `'session'`；
  要跟 agent 绑定 → `'agent'`。可选能力（如 `sessionProjections`、`jobs`）用 `ctx.inject([...], (c) => …)`
  或 `ctx.get(name)` + 缺失分支，别塞进顶层 `inject`（否则组合里缺这项就整个插件挂起不激活）。
- **副作用全部挂 fiber**：`ctx.effect(() => disposer)` / `ctx.on(...)`；模块顶层不做任何进程级副作用，
  否则 HMR/卸载会泄漏。
- **core/ 是零依赖 TS 库**：host 包只做薄适配层（把 `core/` 的能力包成工具/服务），
  `core/` 保持零依赖、可被 Node 26 原生 `.ts` 直跑；host 侧发布 `lib/*.js`（ESM）避免让 Loader 处理 TS。
