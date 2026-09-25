# 隔离的 Dev/Test dsh 实例指南

> 本文承接 [`AGENTS.md`](../AGENTS.md) 中「Isolated Dev/Test dsh Instance」段迁走的详细内容；
> AGENTS.md 只保留摘要 + 指向本文件的导航链接。
>
> **现行工具是 `scripts/dsh-test-web.sh`**。本文的用法、默认值与门禁均以该脚本**自身的 `usage()`
> 与实现**为准（成文时对应 `v0.16.0-test` 的 `94ae977`）；脚本变更后以脚本为准。
> 已归档的 `scripts/archived/dev-dsh-instance.sh` 只在最后一节作为历史说明出现，**不要再使用**。

## 1. 隔离模型：以 `DSH_HOME` 为边界

`dsh-test-web.sh` 用**指定版本的 DSH**（经 `pnpx` 从 npm 取 `@deepseek-ai/dsh@<版本>`）拉起一个
web 实例，在本地插件产物上做开发/验证，而不会碰主 GUI（`dsh web`，端口 3080）：

- **隔离边界是 `DSH_HOME`**，不是 profile 名、也不是 CWD —— web 别名固定使用 `web` profile，
  所以「哪个 `DSH_HOME`」才是实例之间唯一的分界（脚本注释原文：*the web alias owns the fixed
  "web" profile; `DSH_HOME` is the isolation boundary*）。
- **`DSH_HOME`** 默认 `./tmp/dsh-test/<稳定版本>/home`：sessions / storages / credentials 与主
  `~/.dsh` 完全隔离。
- **预发布版本折叠到稳定版本**（`v0.16.0-test` → `v0.16.0`），同一预发布族共享同一个 `DSH_HOME`
  （profile 因此只装一次）；但 workspace / cache / pnpm-store 仍按**完整版本**隔离。
- **workspace** 默认 `./tmp/dsh-test/<完整版本>/workspace`，脚本 `cd` 到该目录后再启动 dsh。
- 上述路径全部落在仓库 `tmp/` 之内，符合「`DSH_HOME` 与 workspace 必须在项目 `tmp/` 内」的
  常驻环境约束（`mem-73f84ba7`）。
- 插件通过 `link:` 指向 `--host-dir`（默认 `$REPO_ROOT/dist`，即**发布产物目录**，不是
  `dsh-graph-host/`），所以改完源码必须先 `pnpm build` 才会被实例看到。

## 2. 用法

脚本的 `usage()` 原文：

```text
用法：dsh-test-web.sh <DSH 版本> [--port PORT] [--proxychains] [--host HOST] [--host-dir PATH] [--skip-install]
```

```bash
bash scripts/dsh-test-web.sh <DSH版本> [--port PORT] [--proxychains] [--host HOST] [--host-dir PATH] [--skip-install]
```

| 参数 | 默认值 | 说明 |
|---|---|---|
| `<DSH版本>`（位置参数，必填） | 无 | 要拉起的 DSH 版本，如 `0.1.6-alpha.2`、`v0.1.6-alpha.2`；必须匹配 `^[A-Za-z0-9][A-Za-z0-9._+~-]*$` |
| `--port PORT` | `3082` | 实例端口；必须为 1–65535 的整数，且**不能是 3080**、不能已被占用 |
| `--host HOST` | 不传（dsh 默认） | 透传给 `dsh web --host` |
| `--host-dir PATH` | `$REPO_ROOT/dist` | 本地 dsh-graph 插件目录（允许的落点见下） |
| `--proxychains` | 关 | 安装与启动都经 `proxychains4 -q`（需 PATH 中有 `proxychains4`） |
| `--skip-install`（别名 `--no-install`） | 关 | 跳过插件安装，复用已有 profile；要求该 `DSH_HOME` 已有可用 profile，且 PATH 中已有 `dsh` |
| `--help` / `-h` | — | 打印用法后退出 0 |

启动前脚本还会：创建 `DSH_HOME` / workspace / cache / pnpm-store 目录，按需
`plugin --profile web add link:<HOST_DIR>`，导出 `npm_config_cache`、`pnpm_config_store_dir`、
`XDG_CACHE_HOME`，并用 `web --dump-config` 校验有效配置里同时含 `@deepseek-ai/dsh-base`、
`@deepseek-ai/dsh-web-app`、`dsh-graph`，最后 exec：

```text
<dsh> web --no-open --port <PORT> [--host <HOST>]
```

`--host-dir` 允许的落点（越界即报错退出）：`$REPO_ROOT/dist`、`$REPO_ROOT/dsh-graph-host`、
`$REPO_ROOT/.worktrees/*/dist`、`$REPO_ROOT/.worktrees/*/dsh-graph-host`；目录里必须有
`package.json` 且 `name` 为 `dsh-graph`。后两种落点用于在隔离 worktree 里验证构建产物。

### 2.1 三条硬门禁

**（1）以 `DSH_HOME` 为隔离边界。** 实例身份由 `DSH_HOME` 决定（§1），**不是**旧脚本的
`TEST_HOME` / `CWD` 环境变量，也不是 `--profile`。要换隔离范围就换版本目录，不要试图透传 profile。

**（2）拒绝透传受管参数。** 以下参数命中即报错退出（`exit 2`），不会传给 dsh：

```text
--profile  --patch  --dump-config  --dump-default-config  --open  --no-open
--workspace  --cwd  --dsh-home  --DSH_HOME  --
```

错误信息形如 `错误：禁止透传受管参数：--profile`；其余未知参数也一律拒绝
（`不支持的参数：…`）。这些参数决定实例身份或配置，必须由脚本自己管。

**（3）拒绝端口 3080。** `--port 3080` 直接报 `错误：拒绝端口 3080（生产 DSH web）`；
端口非数字、超出 1–65535、或已被占用（`ss -ltn` 探测，无 `ss` 时退回 node 探测）同样拒绝。
默认端口 `3082`。

另外，沿用的 `DSH_TEST_ROOT` 只在内部离线 smoke（`DSH_TEST_MODE=1`）里有效，日常调用会被拒绝；
它本身也必须位于 canonical `$REPO_ROOT/tmp` 之下、不含 `..`、不经 symlink 越界。

## 3. 开发回路

- **Node 侧**（`dsh-graph-host/index.js`、`core/*.ts`、`cordis.patch.yml`）：插件经 `link:` 指向
  `--host-dir`（默认 `dist/`），所以**改完源码先 `pnpm build`** 重新生成 `dist/core/*.js` 等产物，
  再重启实例即可，无需重装 profile。
- **浏览器/看板侧**（`dsh-graph-host/lib/client/*.js`）：这些是源模块，按 AGENTS.md 的
  「Generated File Policy」**绝不直接改 `dist/lib/client.js`**；改完重建并刷新 3082 页面：

```bash
pnpm build
node --check dist/lib/client.js
node --test core/tests/*.test.ts
```

  dsh-graph 自己的客户端 bundle 没有热重载 watcher，所以是「重建 + 刷新」。
- **主 GUI（3080）**：本脚本不修改、不重启主实例，也不切换主 profile；主实例要用新版本请自行
  重启/刷新（脚本把开发与验证完全留在隔离实例里）。

## 4. 看板数据（`.dsh-graph`）落点

脚本**不**固定 `.dsh-graph` 的绝对 root —— 这是与已归档旧脚本的一处关键差异（旧脚本会往 profile
里写绝对 `config.root`，新脚本不再写）。落点由插件的 root 解析决定：

- bundle 层的默认值是**相对** `config.root: .dsh-graph`（`dsh-graph-host/cordis.patch.yml`），
  按 `resolve(会话 workspace, config.root)` 解析（g-112）；
- g-149 归一化（`core/root.ts` 的 `resolveCanonicalRoot`）：workspace 位于某个 git worktree 之内、
  但**不是**该仓库的 main worktree 时，相对 root 会被归一到 `<main-worktree>/.dsh-graph`
  （mode `canonicalized`）。默认 workspace 就在本仓库 `tmp/` 内，正属于这种情况；只有当 workspace
  自身是一个 git 仓库的 main worktree 时才落在 `<workspace>/.dsh-graph`（mode `main-tree`）。

> **不要假设测试实例的看板数据落在 `tmp/` 下。** 需要与主看板分离的数据时，显式给绝对
> `config.root`（例如在 `--host-dir` 指向的插件 profile 的 `cordis.patch.yml` 里 patch）；
> 对看板数据做破坏性验证前，先确认实例实际使用的 root。

## 5. 常见报错

脚本 `die()` 统一以 `exit 2` 退出，信息形如 `错误：<原因>`。常见原因：

| 报错 | 触发 |
|---|---|
| `必须显式指定 DSH 版本` | 没给位置参数 |
| `非法 DSH 版本：…` | 版本串形状不合法 |
| `禁止透传受管参数：…` | 传了 `--profile` / `--dsh-home` / `--workspace` / `--patch` 等（§2.1） |
| `不支持的参数：…` | 未知参数 |
| `非法端口：…` / `拒绝端口 3080（生产 DSH web）` / `端口已占用：…` | 端口门禁（§2.1） |
| `缺少 pnpx` / `缺少 node` / `缺少 realpath` | 基础命令缺失 |
| `已请求 --proxychains，但找不到 proxychains4` | `--proxychains` 但无 `proxychains4` |
| `仓库 tmp symlink 越界：…` / `DSH_TEST_ROOT 必须位于 canonical … 下` | `tmp/` 或 `DSH_TEST_ROOT` 越过仓库 `tmp/` |
| `无法 canonicalize 本地插件目录：…` / `--host-dir 必须位于仓库 dist、dsh-graph-host 或 .worktrees 下：…` | `--host-dir` 越界或不存在 |
| `本地插件 package name 必须为 dsh-graph：…` | `--host-dir` 指错目录 |
| `--skip-install 要求目标 DSH_HOME 已有可复用的 dsh-graph profile；请先不带该参数运行一次` | `--skip-install` 但 profile 未就绪 |
| `插件安装失败` / `无法读取 web effective config` / `web effective config 缺少 …` | 安装或有效配置校验失败 |

## 6. 历史脚本（已归档）：`scripts/archived/dev-dsh-instance.sh`

> **它是历史脚本，已被 `scripts/dsh-test-web.sh` 完整取代**（归档日期 2026-09-21，g-336；
> 见 [`scripts/archived/README.md`](../scripts/archived/README.md)）。保留仅供追溯，不要使用。

- **退役的模型**：双 profile（`web` 主 + `dsh-graph-test` 测试）与子命令
  `run | setup | main-published | main-dev | status | help`，隔离靠 `TEST_HOME` / `CWD`
  环境变量（默认 `TEST_HOME=$REPO_ROOT/tmp/test-review`、
  `CWD=$TEST_HOME/workspace/dsh-graph-test`），旧落点约
  `./tmp/test-review/workspace/dsh-graph-test/.dsh-graph`。**这些子命令已随脚本一并退役**：
  现行脚本没有子命令、只有一个固定 `web` profile，也**不再切换主 profile**。
- **`PUBLISHED_VER` 默认值 `^0.11.0` 是陈旧的锁定值，不是当前已发布版本。**
  它是该脚本自 v0.11.0 发布（commit `0c2230e`，2026-09-15）起再未更新的历史值；
  **当前已发布版本是 v0.16.1**（见 [`README.md`](../README.md)「当前版本 v0.16.1」）。
  该默认值只影响旧脚本的 `main-published` 子命令，与现行脚本无关。
- 两者的设计不同，**不是同一工具的两个版本**：现行脚本按 DSH 版本启动单实例、以 `DSH_HOME`
  为隔离边界，并拒绝透传受管参数（§2.1）。
