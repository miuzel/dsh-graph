# 隔离的 Dev/Test dsh 实例指南

> 本文承接 [`AGENTS.md`](../AGENTS.md) 中「Isolated Dev/Test dsh Instance」段迁走的详细内容；
> AGENTS.md 只保留摘要 + 指向本文件的导航链接。
>
> **现行工具是 `scripts/dsh-test-web.sh`**。本文的用法、默认值与门禁均以该脚本**自身的 `usage()`
> 与实现**为准（成文时对应 `v0.16.0-test` 的 `94ae977`）；脚本变更后以脚本为准。
> 已归档的 `scripts/archived/dev-dsh-instance.sh` 只在最后一节作为历史说明出现，**不要再使用**。

## 1. 隔离模型：以 `DSH_HOME` 为边界

`dsh-test-web.sh` 用**指定版本的 DSH**（`pnpm add` 装进版本目录
`./tmp/dsh-test/<完整版本>/node_modules`，运行时即 `node_modules/.bin/dsh`）拉起一个
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
用法：dsh-test-web.sh <DSH 版本> [--port PORT] [--proxychains] [--host HOST] [--host-dir PATH] [--skip-install] [--dry-run]
```

```bash
bash scripts/dsh-test-web.sh <DSH版本> [--port PORT] [--proxychains] [--host HOST] [--host-dir PATH] [--skip-install] [--dry-run]
```

| 参数 | 默认值 | 说明 |
|---|---|---|
| `<DSH版本>`（位置参数，必填） | 无 | 要拉起的 DSH 版本，如 `0.1.6-alpha.2`、`v0.1.6-alpha.2`；必须匹配 `^[A-Za-z0-9][A-Za-z0-9._+~-]*$` |
| `--port PORT` | `3082` | 实例端口；必须为 1–65535 的十进制整数（禁止前导零）、**不能是 3080**、不能已被占用 |
| `--host HOST` | 不传（dsh 默认） | 透传给 `dsh web --host`；只允许字母/数字/`.`/`-`/`_`/`:` 且不得以 `-` 开头（空值与 shell 元字符拒绝） |
| `--host-dir PATH` | `$REPO_ROOT/dist` | 本地 dsh-graph 插件目录（允许的落点见下） |
| `--proxychains` | 关 | 安装与启动都经 `proxychains4 -q`（需 PATH 中有 `proxychains4`） |
| `--skip-install`（别名 `--no-install`） | 关 | 跳过插件安装，复用已有 profile；要求该 `DSH_HOME` 已有可用 profile，且 PATH 中已有 `dsh` |
| `--dry-run`（别名 `--doctor`） | 关 | **只读预检**：复用启动路径的端口/工具/link/隔离检查并如实报告缺项，零副作用（见 §2.2） |
| `--help` / `-h` | — | 打印用法后退出 0（不依赖位置参数，任何位置生效） |

启动前脚本还会：创建 `DSH_HOME` / workspace / cache / pnpm-store 目录，按需
`plugin --profile web add link:<HOST_DIR>`，导出 `npm_config_cache`、`pnpm_config_store_dir`、
`XDG_CACHE_HOME`，并用 `web --dump-config` 校验有效配置里同时含 `@deepseek-ai/dsh-base`、
`@deepseek-ai/dsh-web-app`、`dsh-graph`，最后 exec：

```text
<dsh> web --no-open --port <PORT> [--host <HOST>]
```

> pnpm 项目根：版本目录与 `$DSH_HOME/profiles/web` 各自写一份 `pnpm-workspace.yaml`
> （`packages` / `autoInstallPeers: true` / `allowBuilds`），以免继承仓库根的
> `autoInstallPeers: false` 而装出缺 peer 的树；`allowBuilds` 的包名由 pnpm 报文解析得出。

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
它本身也必须位于 canonical `$REPO_ROOT/tmp` 之下、不含 `..`、不经 symlink 越界；指向生产
`$HOME` / `$HOME/.dsh` 或看板 `.dsh-graph` 的路径在任何副作用之前就被拒绝。

### 2.2 只读预检 `--dry-run` / `--doctor`（g-301）

`--dry-run`（别名 `--doctor`）回答一个问题：**按当前这组参数，现在能不能启动？缺什么？**
它复用启动路径**同一份**判定（工具探测、端口占用、隔离根 canonicalize 与边界、`--host-dir`
允许落点、`profile_ready` 的 profile/link/bundle 判定），但**零副作用**：

- 不建目录（`mkdir` 全部在预检 `return` 之后）、不安装（不跑 pnpm / `plugin add`）、不写配置、
  不启动服务（**不跑 `web --dump-config`**，那需要子进程/运行时 ⇒ 报告里显式列为未验证）；
- 不自动安装、不自动修环境、不自动安装缺失工具；不回显任何环境变量/凭据值（如 `NEWAPI_ASEIT_API_KEY`）；
- 只读预检与 `--help` 的前后**文件与进程快照相同**（`core/tests/g301-dry-run-doctor.test.ts` 断言）。

报告内容：平台与平台范围、生效参数、`TEST_ROOT`/`DSH_HOME`/`WORKSPACE`/cache/pnpm-store 的
**实际状态**（`缺失` / `目录` / `非目录(!)`）、工具可用性与绝对路径、端口探测结论、候选
`host-dir` 与**实际 link 目标**（`link:<canonical host-dir>`）、`RUNTIME_DSH` / profile manifest /
`pnpm-workspace.yaml` 的存在性与 profile 诊断明细，最后是**阻塞项**与**缺项**两张清单。
「目录存在 ≠ 环境正确」：就绪与否看 profile/link/`bundle.patch` 是否与实际 `link:` 一致，而不是看目录在不在。

退出码：

| 退出码 | 含义 |
|---|---|
| `0` | 按当前参数**可以启动**（无阻塞项；缺项会在启动时创建/安装，故缺项不单独判失败） |
| `1` | 存在**阻塞项**（缺工具、端口被占用、`host-dir` 无有效插件、隔离根存在但不是目录、`--skip-install` 而 profile 未就绪等） |
| `2` | **非法/危险输入**：非法端口（越界/前导零/空值/非数字）、3080、非法 `--host`、空值、生产 `HOME` 或看板路径、受管参数透传、未知参数 |

`--dry-run` 下的危险输入**同样先拒绝**（`exit 2`，先于一切 `mkdir`/install/配置写入/启动/端口探测之外的动作）。

```bash
# 预检（不产生任何副作用）
bash scripts/dsh-test-web.sh <DSH版本> --dry-run [--port PORT] [--host-dir PATH] [--skip-install]
# 例：在隔离 worktree 里用源码目录做预检
bash scripts/dsh-test-web.sh 0.2.0-rc.2 --dry-run --port 3090 --host-dir "$PWD/dsh-graph-host"
```

> **平台范围（如实登记）**：脚本与预检按 **linux/WSL2（bash + GNU coreutils）** 编写与验证；
> 原生 Windows / macOS 未验证（`usage()` 与预检报告都会打印这一行）。`ss` 缺失时端口探测退回
> node 的短暂 bind/close 探测；`realpath` 缺失时预检报阻塞项（`exit 1`）而不是猜测路径。

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
- g-149 归一化（`core/root.ts` 的 `resolveCanonicalRoot`）：workspace 位于**真正的 linked worktree**
  （`git worktree add` 出来的树，含其**已跟踪**子目录）内时，相对 root 会被归一到
  `<main-worktree>/.dsh-graph`（mode `canonicalized`）；workspace 在 main worktree 内则落在
  `<workspace>/.dsh-graph`（mode `main-tree`）。
- **g-363 边界（2026-09-29 修正，取代本文档此前的错误描述）**：只**新增一条边界** ——
  **被 git 忽略的子目录**（`git check-ignore` 命中，且不是工作树根自身）一律当作**独立项目根**：
  不归一化、不归属外层仓库的代码工作树、干净度探测报 unknown（mode `workspace-fallback`）。
  「是否 linked worktree」的判据**仍是** `realpath(workspace) !== realpath(mainWorktree)` ——
  仓库内**被跟踪**的子目录（`core/`、`docs/` 等）与工作树根的解析**逐字不变**（g-149 语义保留）。
  （不能用「包含 workspace 的工作树根」当判据：那会让 `dsh-graph-host/.dsh-graph` 这类游离骨架
  变成活动看板 —— 属未经论证的行为变化。）因此：
  - 仓库内 `tmp/**`（含隔离实例 workspace `tmp/dsh-test/<版本>/workspace`）**不再**被归一为
    `<仓库>/.dsh-graph`，而是落在自己目录下的 `.dsh-graph` —— 隔离实例真正独立，测试夹具也
    写不到真实看板；
  - linked worktree **根**即使命中 `.gitignore` 的 `.worktrees/` 仍照旧归一（g-149 语义不变）。

> 历史缺陷（本段修正的就是它）：旧判据 `workspace !== mainWorktree` 让主工作树的**任意子目录**
> 都被当成 linked worktree ⇒ `tmp/` 下的测试夹具写真实 `project.yaml`/`events.jsonl`、隔离实例写
> 真实 `memory.jsonl`、在 worktree 内跑全量出现 47 条假红、真实仓库被登记出 `.worktrees/g-001-att-01`
> 之类的夹具残留。守卫见 `core/tests/g363-scratch-isolation.test.ts`。

> **跨平台实现约束（g-363 返工点，Windows 红线）**：`core/root.ts` 里带**路径参数**的 git 调用
> 一律走参数**数组**签名 —— `_gitRunner.execFileSync("git", ["check-ignore", "-q", "--", "<相对路径>/"], …)`。
> 字符串命令形式（`execSync("git … '…'")`）在 Windows 上单引号**不被 cmd.exe 剥离** ⇒ 引号成了路径
> 的一部分 ⇒ `git check-ignore` 恒 `exit 1` ⇒ 被判「未忽略」⇒ scratch 判定失效、三个污染出口在
> Windows 全部回归；另外 `relative()` 在 Windows 产出 `\`，匹配不上 `.gitignore` 里按 `/` 写的规则，
> 故路径统一 `/` 分隔。两点都由纯函数 `checkIgnoreArgv()` 负责，守卫 A2 以**字符级**断言钉住
> （参数数组不含引号、路径 `/` 分隔、含空格/单引号/非 ASCII 的目录端到端可用）。

> **与 mem-73f84ba7（隔离实例的 DSH_HOME/workspace 必须落仓库 `tmp/` 内）如何共存**：两者不冲突，
> 不需要二选一 —— `tmp/` 仍是沙盒可写的隔离区（该记忆的要求保留），而 g-363 让「落在 `tmp/` 里」
> 等价于「是一个**独立看板**」：git-ignored ⇒ 独立项目根。此前的张力来自判定缺陷（`tmp/` 被误判成
> linked worktree ⇒ 隔离实例实际读写真实看板），现已消除。
>
> 需要与主看板分离的数据时，仍可显式给绝对 `config.root`（例如在 `--host-dir` 指向的插件 profile
> 的 `cordis.patch.yml` 里 patch）；对看板数据做破坏性验证前，先确认实例实际使用的 root
> （看板端点 `_diagnostics.rootMode` / `canonicalWorkspace` 会如实回报）。

## 4.1 在 linked worktree 内跑测试（正确姿势与限制）

执行者按隔离纪律都在 `.worktrees/g-<goal>-att-<NN>` 里干活，跑测试的正确姿势是：

```bash
cd .worktrees/g-<goal>-att-<NN>
ln -sfn ../../node_modules node_modules      # worktree 无 node_modules（gitignored）
bash scripts/build.sh                        # 先产出 dist/（否则 dist/index.js 类导入全红）
node --test core/tests/*.test.ts             # 与主树同一命令、同一口径
```

- **两种 TMPDIR 都必须全绿**：默认 `TMPDIR=/tmp` 与 `TMPDIR=<worktree>/tmp`（AGENTS.md 要求临时
  文件写仓库 `tmp/`）。后者曾是 47 条假红的来源，命令可直接复现历史缺陷：
  `TMPDIR="$PWD/tmp" node --test core/tests/*.test.ts`（修复前 47 fail，修复后 0 fail）。
- **两条与「是否被污染」有关的环境前提**（属环境前提，不是断言面，已由测试自身按构造保证）：
  `g347-help-asset-guard` 的镜像必须落在仓库外、`g355-mock-seed-shared-card` 的 mock 沙箱必须
  不含 `/home/`、`/workspace/` 等敏感字样（seed 自带脱敏自检会（正确地）拒绝真实工作区路径）。
  两者现在显式挑选合规的临时根，`TMPDIR` 落仓库内时同样绿。
- **不要用「某次跑绿」当结论**：套件必须不留下真实仓库残留。判据是「跑完后真实仓库无新增
  worktree 注册、真实 `.dsh-graph` 未被写入」这个**不变量**（`git worktree list` + 真实看板
  文件不含本次唯一 marker），由 `core/tests/g363-scratch-isolation.test.ts` 钉住。
- **发布门禁的权威证据口径不变**：发布/复核取数仍在**主工作树**做（`node --test core/tests/*.test.ts`）；
  worktree 内跑绿是执行者的自检，不替代主树取数。主树跑之前必须确认 `dist/` 与源同步
  （`dist-freshness-g312` 会拦：主树 dist 陈旧时该用例必红 —— 那是「主树该重建了」的信号，
  不是代码回归；主树重建按 Build Isolation 纪律只在发布/复核的明确时点做）。
- **实测（g-363 att-001，2026-09-29，同一 commit）**：

| 口径 | 命令 | 结果 |
|---|---|---|
| worktree + `TMPDIR` 落 worktree | `TMPDIR=$PWD/tmp node --test core/tests/*.test.ts` | 1417 pass / **0 fail** / exit 0 |
| worktree + 默认 `TMPDIR` | `node --test core/tests/*.test.ts` | 1417 pass / **0 fail** / exit 0 |
| 主树（发布门禁口径） | `node --test core/tests/*.test.ts` | 1406 tests / 1405 pass / 1 fail（`dist-freshness-g312`：主树 `dist/` 相对源陈旧，**与本次改动无关**，重建后即绿） |

  （1417 = 修复前 1415 + 返工时新增的 A2 字符级守卫、A3 调用形状守卫；主树一行是在**主树自己的
  代码/测试**上取的，故仍为 1406。）
  三条口径跑完后真实 `.dsh-graph/project.yaml`、`memory/memory.jsonl` md5 未变、
  `git worktree list` 未变、`events.jsonl` 行数未增 —— 即「不污染真实看板」的不变量成立。
  修复前同一命令（worktree + `TMPDIR` 落 worktree）为 **47 fail / 1359 pass / exit 1**。
- **判别力（改坏即红，变异命令与统计范围写明）**：每个变异只改 `core/root.ts` **一处**，先用副本
  备份、跑完按副本还原（还原后 `md5` 与备份逐字节一致）；两种统计范围都给出 ——
  守卫文件全量 `node --test core/tests/g363-scratch-isolation.test.ts`（11 条）与
  全量套件 `node --test core/tests/*.test.ts`（默认 `TMPDIR`，1417 条）：
  - 变异 ①：scratch 边界改成恒假（`const isScratch = false;`）⇒ 守卫 **9/11 红**（仅「不误伤
    linked worktree 根」「非 scratch 干净度」两条仍绿），全量 **1408 pass / 9 fail**；
  - 变异 ②：撤「scratch 不进项目工作树」（`discoverGitWorktree` 对 scratch 仍返回 info）⇒
    守卫 **7/11 红**，全量 **1410 pass / 7 fail**；
  - 变异 ③：调用形状改回 shell 字符串命令（`execSync(\`git check-ignore …\`)`，即 Windows 失效
    的那个形态）⇒ 守卫 **2/11 红**（A2 端到端 + A3 调用形状），全量 **1415 pass / 2 fail**
    —— 在 POSIX 上也会因未转义引号而失败，A3 正是钉住「不许再写成字符串命令」的那条；
  - 还原后守卫 **11/11 绿**、全量 **1417 pass / 0 fail**。
  三次变异运行期间真实看板**零污染**：两条写入类不变量**在写入前**就断言失败（前置断言在前），
  且 `project.yaml`/`memory.jsonl` md5 未变、`events.jsonl` 未增、无 `.worktrees/g-363-att-99`
  注册、看板内无夹具 marker。
- **已知限制（如实登记，本目标未收敛）**：REST 路由把写操作 actor **硬编码为 `human:gui`**
  （`dsh-graph-host/index.js` 多处，如 `resolve-accept` / `transition` / `move-goal` / `add-card`）。
  即「任何能访问该端口的本地调用都能以负责人名义写入」——因此在隔离失效时无法从事件流区分
  「谁写的」。本地单机单用户场景下按可接受风险处理；若要收敛，需把 actor 由请求上下文派生
  （独立目标再做）。

## 5. 常见报错

脚本 `die()` 统一以 `exit 2` 退出，信息形如 `错误：<原因>`。常见原因：

| 报错 | 触发 |
|---|---|
| `必须显式指定 DSH 版本` | 没给位置参数 |
| `非法 DSH 版本：…` | 版本串形状不合法 |
| `禁止透传受管参数：…` | 传了 `--profile` / `--dsh-home` / `--workspace` / `--patch` 等（§2.1） |
| `不支持的参数：…` | 未知参数 |
| `非法端口：…` / `拒绝端口 3080（生产 DSH web）` / `端口已占用：…` | 端口门禁（§2.1） |
| `缺少 pnpm；请安装 pnpm 后重试` / `缺少 node` / `缺少 realpath` | 基础命令缺失 |
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
  **当前已发布版本是 v0.16.1**（见 [`README.md`](../README.md) 顶部「当前版本 v0.16.1」；
  用户可见变更史见 [`CHANGELOG.md`](../CHANGELOG.md)）。
  该默认值只影响旧脚本的 `main-published` 子命令，与现行脚本无关。
- 两者的设计不同，**不是同一工具的两个版本**：现行脚本按 DSH 版本启动单实例、以 `DSH_HOME`
  为隔离边界，并拒绝透传受管参数（§2.1）。
