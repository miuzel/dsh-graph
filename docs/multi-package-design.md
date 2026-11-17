# dsh-graph v1.0.0 多包设计

## 1. 结论先行

v1.0.0 把原先的单包 `dsh-graph` 拆成 **5 个可独立安装的 npm 包**：

| 包 | 职责 | 用户场景 | 独立可用 |
|---|---|---|---|
| `dsh-graph` | DSH 插件本体：`graph_*` 工具 + 二维泳道看板 | DSH 用户 | ✅ 只装它即可 |
| `dsh-graph-cli` | 命令行：`info`/`status`/`goal`/`version`/`sync`/`claim`/`submit`/`serve` | 单兵终端用户 | ✅ 只装它即可 |
| `dsh-graph-service` | 本地只读服务：Web App + Web API + localhost MCP | 要 Web / MCP 入口 | ✅（驱动入口见 §3.2） |
| `dsh-graph-skills` | 技能包：`dsh-graph` / `dsh-graph-supervisor` 正文与安装脚本 | 按需加载技能 | ✅ |
| `dsh-graph-mcp` | MCP 适配器 + Claude Code / Codex / OpenCode 配置生成 | 接入外部 Agent | ✅（另需 running service） |

「单包能力与拆分前等价」的判据：插件包保留 `index.js` + `lib/` + `prompts/` + `diagrams/` +
`cordis.patch.yml` 与全部 `graph_*` 工具（68 个导出、`graph_*` 工具集不变）；
CLI 包保留全部子命令与语义；看板数据格式、事件格式一字未动。

## 2. 关键约束与取舍

### 2.1 为什么是「打包层」而不是真 monorepo

两道守卫把源码位置钉死：

- `scripts/run-tests.mjs` 的 `TEST_GLOB = "core/tests/*.test.ts"` 字面量与无参行为不得改；
- `tsconfig.json` 的 `include` 是**精确枚举**，出现 `core/**` 或 `dsh-graph-host/**` 会被 g335 判红。

搬动 `core/` 或 `dsh-graph-host/` 会同时击穿两者，而收益为零（单用户场景，无独立版本发布需求）。
因此：

> **源码位置一律不动；`packages/<name>/` 只是「从 `dist/` 取产物组装」的打包层。**

`scripts/pack-packages.mjs` 读 `dist/`（构建产物），按模块图推导每包文件集，组装到
`packages/<name>/`，再 `npm pack` 出 tarball。它**只读 dist、从不构建**——构建仍只走
`bash scripts/build.sh`（原子发布）。

### 2.2 共享运行时为什么「复制」而不是「声明依赖」

CLI 与 SERVICE 共用 24 个 `core/` 模块，且两者互相可达：

- `core/cli/main.js` 对 `core/service/serve.js` 是**动态** `import`（`serve` 子命令）；
- `core/service/queries.js` 反向依赖公共 core（`events/model/ops`）。

可选方案对比：

| 方案 | 结果 | 否决/采纳理由 |
|---|---|---|
| A. 拆出 `dsh-graph-runtime` 共享包 | 需把这 24 个模块切出去 | **否决**：等于搬源码，直接撞 g335/g350 |
| B. CLI 声明 `peerDependencies: dsh-graph-cli`→service | 装 CLI 不装 service 时 `serve` 子命令炸 | **否决**：违反「不假设其他包已装」 |
| C. 各包把自身闭包整体打包 | 体积各多约 1.5MB（未压缩） | **采纳**：零包间依赖，装哪个用哪个 |

判据 2 原话是「不假设其他包已装，除非显式声明依赖」。C 让**所有包都零依赖**，
是这一判据最强的满足方式；代价只是磁盘体积（tarball 层面已由 gzip 压缩）。

### 2.3 提示词资产的隐性依赖（易错点）

`core/ops.js` 在**运行期**用 `new URL("../prompts/", import.meta.url)` 现读正文，缺资产
**fail-closed 抛错**（不静默降级为空串）。因此：

> 任何携带 `core/` 的包（`dsh-graph` / `dsh-graph-cli` / `dsh-graph-service`）**必须**把合并后的
> `prompts/` 放在与 `core/` 同级的位置。

打包脚本按「闭包里是否含 `core/`」自动附带 `prompts/` 并在缺失时**抛错**，不靠人工记得。

## 3. 包间依赖

```
dsh-graph             （零依赖；peer: @deepseek-ai/dsh-settings / cordis / schemastery 均 optional）
dsh-graph-cli         （零依赖；内含所需 core 运行时 + prompts）
dsh-graph-service     （零依赖；内含所需 core 运行时 + prompts；peer: @deepseek-ai/dsh-settings optional）
dsh-graph-skills      （零依赖）
dsh-graph-mcp         （零依赖；但运行时需要一个已启动的 service endpoint）
```

**没有任何包以 `dependencies` 形式依赖另一个 dsh-graph 包。** 若将来确需包间依赖，必须用
**精确版本**（如 `"dsh-graph-service": "1.0.0"`），不用 `^` 或 `*`——首次发布要保证用户装到的是一套
自洽版本。

### 3.1 版本一致性

五个包版本**统一为 `1.0.0`**（与插件本体 `package.json` / `PLUGIN_VERSION` 同源）。
打包脚本从 `dsh-graph-host/package.json` 的 `version` 取唯一真源，守卫测试逐包断言相等。

### 3.2 service 的驱动方式（如实说明）

`dsh-graph-service` 的 `core/service/serve.js` 导出 `runServeCommand`，**本身不是可执行入口**
（该模块是服务生命周期实现，不是 CLI）。故：

- 想要命令行：装 `dsh-graph-cli`，用 `dsh-graph serve …`（CLI 包内已含服务代码）；
- 想要编程式：`import { runServeCommand } from "dsh-graph-service"`。

这是拆分前的既有形状（`serve.ts` 从不是独立 bin），未在本轮改动，以免改变 CLI 语义（判据 6）。

## 4. MCP 三宿主适配

单一真源：`mcpEndpoint()` 由 `{host, port}` 推导，三宿主共用同一结果，不可能出现
「三个配置指向三个端口」的漂移。token 一律**只写变量名**：

| 宿主 | 文件 | token 引用语法（各宿主原生） |
|---|---|---|
| Claude Code | `.mcp.json` / `~/.claude.json` | `${DSH_GRAPH_MCP_TOKEN}` |
| Codex | `~/.codex/config.toml` | `bearer_token_env_var = "DSH_GRAPH_MCP_TOKEN"` |
| OpenCode | `opencode.json` | `{env:DSH_GRAPH_MCP_TOKEN}` |

`--check` 自检：断言生成结果**只**含上述引用、且不含 `Bearer <24+ 字面量>` 形态的真实 token。

## 5. 打包与产物

```bash
bash scripts/build.sh                  # 第一步：构建（原子发布）
node scripts/pack-packages.mjs         # 第二步：组装 packages/<name>/
node scripts/pack-packages.mjs --tarballs   # 第三步：npm pack 到 out/ + SHA256SUMS.txt
```

tarball 内**不含**开发资产（源码 `.ts`、`core/tests/`、`.worktrees/`、`dist/` 之外的构建中间物），
由守卫测试逐条断言。

## 6. 不做的事

- 不引入 pnpm workspace / turbo（无独立发布流水线，徒增复杂度）；
- 不 publish / tag / push；
- 不搬动 `core/` 与 `dsh-graph-host/`；
- 不改变 `.dsh-graph` 事件格式、看板行为、`graph_*` 工具集与 CLI 命令语义。
