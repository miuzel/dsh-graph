# g-111 发布前置侦查：本地 gh / npm / 网络工具信息（att-003）

> 侦查时间：2026-08-22 00:55–01:10（att-003 执行子代理）
> 目的：为「建公开 repo → pnpm publish → 本地 `dsh plugin add` 验收 → PR awesome-dsh-plugin」各步
> 提供本机工具链可用性结论。所有命令均实机验证。

## 1. gh CLI（GitHub CLI）

| 项 | 结论 |
|----|------|
| 版本 | v2.97.0（2026-07-31），位于 `/usr/sbin/gh` |
| 登录 | ✅ 已登录 github.com 账户 **miuzel**，active account |
| token scopes | `gist` `read:org` `repo`（**无** admin:public_key / admin:ssh_signing_key） |
| git_protocol | ssh（hosts.yml 配置） |
| gh api 连通 | ✅ `gh api user` → `miuzel` |
| repo create | ✅ `--public/--private/--internal`、`--add-readme`、`--license`、`--push` 均可用 |
| repo edit --add-topic | ✅ 支持（打 `dsh-plugin` topic 无障碍） |
| pr create / pr list | ✅ 可用 |
| gh auth setup-git | ✅ 可配置 git credential helper（HTTPS 路径备用） |
| gh ssh-key list | ⚠️ 需要 `admin:public_key` scope（当前无）——仅影响查 key 列表，**不影响 push** |

**ssh 关键障碍（实机复现）**：默认 `ssh -T git@github.com` 报
`Bad owner or permissions on /etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf`——
该文件是 777 权限的 symlink（指向 `/usr/lib/systemd/ssh_config.d/...`），容器内无 sudo
无法修复。**绕过方案已实机验证**：

```sh
ssh -F /dev/null -T git@github.com   # → Hi miuzel! You've successfully authenticated...
```

→ 发布时 git push 必须显式绕过系统 ssh config，二选一：

```sh
# 方案 A（推荐，不改系统）：推送时指定
GIT_SSH_COMMAND="ssh -F /dev/null" git push -u origin main

# 方案 B：全程 HTTPS + gh 凭据助手（先执行一次）
gh auth setup-git && git remote set-url origin https://github.com/miuzel/dsh-graph.git
```

## 2. git 本地配置现状

| 项 | 结论 |
|----|------|
| git remote | ❌ **无任何 remote**（需新建公开 repo 后 add） |
| user.name / user.email | ❌ **均未配置**（commit 前必须先配，否则 commit 报错） |
| 分支 | `main`（本地唯一分支） |
| 仓库规模 | 70 个 tracked 文件，历史 15+ commits |

提交前需补：

```sh
git config user.name  "miuzel"
git config user.email "<github 绑定邮箱>"
```

## 3. npm / pnpm 工具链

| 项 | 结论 |
|----|------|
| node / npm / pnpm | v26.7.0 / 11.19.0 / 11.3.0 ✅ |
| 当前 registry | `https://registry.npmmirror.com`（~/.npmrc 与 pnpm 全局均指向镜像） |
| 官方 registry 连通 | ✅ `https://registry.npmjs.org` 可达（HTTP 404 = 包不存在） |
| **npm 官方登录态** | ❌ **未登录官方 registry**（`npm whoami --registry=https://registry.npmjs.org` → ENEEDAUTH） |
| 环境变量 token | ❌ 无 NPM_TOKEN / NODE_AUTH_TOKEN / GITHUB_TOKEN / GH_TOKEN |
| npmmirror 登录态 | ❌ 同样未登录 |

**包名占用核验（官方 registry 实机）**：

```
GET https://registry.npmjs.org/dsh-graph   → 404（未被占用 ✅ 可发布；g-116 命名更正：包名=repo 名）
GET https://registry.npmjs.org/dsh-graph-client → 404（g-116 合并后废弃，不再发布）
```

**发布硬前置（人工 gate）**：`pnpm publish` 前必须先对官方 registry 登录——需要 npm 账号
凭据（`npm login --registry=https://registry.npmjs.org` 交互，或设置
`NODE_AUTH_TOKEN` + `.npmrc` `//registry.npmjs.org/:_authToken=`）。
**这是本 attempt 无法代办的步骤，须负责人提供凭据或亲自执行。**

## 4. dsh CLI（本地验收前置）

| 项 | 结论 |
|----|------|
| dsh | ✅ v0.1.0-rc.7（fnm node 环境） |
| `dsh plugin --profile <name> add <pkg>` | 语法可用；**实机执行报 ENOENT 是因为本沙箱对 `~/.dsh/profiles/<new>` 只读**（`profiles/web` 已存在且可读）——真实环境无此问题 |
| 当前安装形态（g-116 后） | 单包 `dsh-graph`（目录 dsh-graph-host/，npm 名 dsh-graph）经 bundle patch 插入（tools/skills/webServer + conversation.view 看板同包） |

## 5. 上架目标仓库（awesome-dsh-plugin）核验

真实仓库确认：**`awesome-dsh-plugin/awesome-dsh-plugin`**（⭐ 11,105），README 双语。

上架规则要点（contributing.md 全文已读）：
- 提交 **一个文件** `data/plugins/<owner>__<repo>.yml`（README 由脚本生成，禁手改）；
- YAML 字段：`url`（须与仓库完全一致）、`name`（owner/repo）、`category`、`description.en`（必填，句号结尾）、`description.zh`（可选）；
- 合法 category：`ui usage theme model identity session memory tools browser vision voice docs skill workflow git notify dev security remote market fun`；
- 硬性条件：仓库 **≥1 天**、**≥10 commits**（CI 自动查）；`package.json` 声明 `dsh.bundle`（仅 `dsh.client` 会被拒）；仓库打 `dsh-plugin` topic；描述与代码核对一致；
- 提交后需 `npm ci && node scripts/generate-readme.mjs` 重新生成 README 并一并提交；
- 推荐（非强制）：发布 npm（预构建免 allowBuilds）、官方 `@deepseek-ai/*` 用 peerDependencies、附截图到 `data/screenshots.json`。

PR 模板（.github/pull_request_template.md）已取全文，见发布手册上架清单章节。

## 6. 发布结构阻塞（本 attempt 新发现，超出调研卡）

**两包均依赖包外代码，npm 打包后不可用，必须先定设计**：

```
（g-116 合并后无此结构：单包 index.js import "./core/*.js"，boardPayload 由 core re-export）
dsh-graph-host/index.js    import { ... } from "../core/ops.ts";            ← 包外 core/
```

- `../core/ops.ts` 又依赖 `core/events.ts` / `core/machine.ts` / `core/model.ts`（纯 node: 内置模块 + 相对内部依赖，无第三方运行时依赖）；
- npm 发布后 `../core` 不在包内 → 安装即崩。**必须先解决打包结构**（候选：core 抽独立 npm 包 / 打包进两包 / 发布时复制 core 目录进包并改 import）；
- 与 g-112（root 通用化）同属发布前置，建议合并进 g-112 范围或本目标先行定案。

## 7. 前置依赖状态

- **g-112（root 通用化）**：status=collecting，调研卡 `card-81fe900b` 仍 **empty**（调研子代理
  att-001/002 未回填），root 解析/初始化设计未定案 → **g-111 判据 1 依赖未满足**；
- g-111 判据 4（负责人确认后执行发布）为人工 gate，等 g-112 完成 + 本目标缺口补齐。

## 结论（给负责人的一句话）

本机工具链：gh ✅（含 ssh 绕过方案）、网络 ✅、包名可用 ✅、dsh ✅；
**缺口 = ① npm 官方登录（需凭据，人工 gate）② 跨包打包结构未定 ③ g-112 root 通用化未完成 ④ git user/remote 未配**。
补齐 ②③④ 后即可按发布路径执行，① 由负责人提供凭据/亲自执行。
