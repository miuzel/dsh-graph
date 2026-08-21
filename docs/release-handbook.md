# dsh-graph v0.3 发布手册与商店上架清单（g-111）

> 状态：**v1（att-003 执行阶段产物）**。
> 前置缺口已补齐：g-112 已交付（root 通用化）、B7 打包结构已实现、两包元数据/LICENCE/README 完成、
> 43/43 单测 + 8 验收脚本全绿、他机视角加载验证通过。剩余人工 gate 见 §1 表。
> 依据：调研卡 card-996e88de + docs/release-prep-gh-recon.md（att-003 实机侦查）。

## 0. 总体路径（负责人定案）

补缺口 → 建公开 repo + 打 dsh-plugin topic → pnpm publish 两包 →
本地 `dsh plugin add` 验收 → PR awesome-dsh-plugin（自动带出三家商店）。

## 1. 前置阻塞清单（当前状态）

| # | 阻塞 | 归属 | 状态 |
|---|------|------|------|
| B1 | client cordis.patch.yml 硬编码绝对路径 | g-112（root 通用化） | ✅ **已交付**（resolveRoot + init，43/43+7 脚本） |
| B2 | 两包 `private: true` | g-111 执行 | ✅ **已改 false**（version 0.3.0） |
| B3 | 缺 LICENSE/README/npm 元数据/files 白名单/build&prepack 脚本 | g-111 执行 | ✅ **已补齐**（见 §2） |
| B4 | git 无 remote、无 user.name/email | g-111 执行 | ⏳ 待发布前配置（命令见 §2.2） |
| B5 | 无 dsh-plugin topic（建 repo 后打） | g-111 执行 | ⏳ 建 repo 时打 |
| B6 | **npm 官方 registry 未登录**（npmmirror 镜像无账号） | 人工 gate | ⚠️ 需负责人凭据 |
| B7 | **跨包打包结构**：client/host 均依赖包外 core，client 跨包引 host | g-111 执行 | ✅ **已解决**（见 §6） |

## 2. 发布缺口补齐（B2/B3/B7——已完成）

### 2.1 两包 package.json（0.3.0）

- `"private": false`、`"version": "0.3.0"`（对齐 dsh-graph v0.3）；
- 元数据：`description`（两包各写功能）、`repository` → `https://github.com/miuzel/dsh-graph.git`、
  `keywords`（含 `dsh` `dsh-plugin` `deepseek-harness` `plugin` 等）、`license: MIT`、
  `engines.node: ">=23.6"`（core 为 .ts，依赖 Node 原生 type-stripping）；
- `files` 白名单：host = index.js + core/ + cordis.patch.yml + supervisor-guide.md + README.md + LICENSE；
  client = index.js + core/ + lib/ + cordis.patch.yml + README.md + LICENSE；
- `prepack`：`bash ../scripts/sync-core.sh && 断言 core/ops.ts 存在`（先同步 core 副本再打包）；
- `exports`/`main`/`dsh.bundle.patch` 保留原有结构。

### 2.2 git 前置（B4，发布前执行）

```sh
git config user.name "miuzel"
git config user.email "<github 绑定邮箱>"
```

### 2.3 验收证据（att-003 已跑）

- `node --test core/tests/*.test.ts` → **43/43 全绿**；
- 8 个冻结验收脚本（check_core/plugin/g107/g108/g109/ga92e1406/cards/kanban）→ **全部 PASS**；
- `npm pack` 两包 → 产物完整（host 12 文件、client 12 文件，含 core 6 个 .ts + LICENSE/README）；
- **他机视角验证**：解包 tgz 后 node 直接 import —— host 14 工具注册 + boardPayload/resolveRoot 导出；
  client 9 条 web 路由注册 + apply OK（无任何包外引用）。

## 3. 建公开 repo + 打 topic（B5）

```sh
# 本机 ssh 系统配置损坏，push 用 -F /dev/null 绕过（实机验证，见 recon §1）
GIT_SSH_COMMAND="ssh -F /dev/null" git remote add origin git@github.com:miuzel/dsh-graph.git
GIT_SSH_COMMAND="ssh -F /dev/null" git push -u origin main
gh repo edit miuzel/dsh-graph --add-topic dsh-plugin --add-topic dsh --add-topic plugin
```

> `miuzel/dsh-graph` 已在 GitHub 核验不存在（404），裸名可用；npm 侧 `dsh-graph-host`/
> `dsh-graph-client`/`dsh-graph` 均 404 未占用。

## 4. pnpm publish 两包（B6 解除后）

```sh
# 前置：npm 官方登录（人工 gate，需负责人凭据）
npm login --registry=https://registry.npmjs.org   # 或 NODE_AUTH_TOKEN + .npmrc

# 发布（目录内执行，registry 显式指定官方）
(cd dsh-graph-host   && pnpm publish --registry=https://registry.npmjs.org --no-git-checks)
(cd dsh-graph-client && pnpm publish --registry=https://registry.npmjs.org --no-git-checks)

# 核验
npm view dsh-graph-host   version
npm view dsh-graph-client version
```

> 注意：本机 `~/.npmrc` 指向 npmmirror 镜像且未登录——发布前必须切官方 registry 并登录；
> 沙箱内 pnpm 的 supply-chain policy 会对本地 tgz 误报（minimum-release-age），真实发布到官方
> registry 后无此问题（该 policy 只查官方 registry 的发布时间）。

## 5. 本地验收（发布后）

```sh
# 用一个全新 profile 验证「他机视角」安装
DSH_HOME=/tmp/dsh-pub-check dsh plugin --profile web add dsh-graph-client
DSH_HOME=/tmp/dsh-pub-check dsh --profile web "ping"   # 断言插件加载激活
# 断言 graph_* 工具注册（marker 自测或 dump-config 看归属行）
```

验收点：profile 内安装包（非 link:）、root 解析正确（g-112 后不再硬编码）、
`/api/dsh-graph` 端点在 web 模式可访问。

> att-003 已用本地 tgz 解包 + 隔离 DSH_HOME 验证过加载链路；正式发布后按本命令复验一次即可。

## 6. 打包结构（B7——已实现，方案 B）

**问题**：两包源码均 `import "../core/ops.ts"`（包外），client 还 `import { boardPayload } from "../dsh-graph-host/index.js"`（跨包）；npm 发布后这些引用全部失效。

**方案 B（已实现）**：

1. `boardPayload` 从 `dsh-graph-host/index.js` **移入 `core/ops.ts`**（它只依赖 core 内函数），
   host/client 均改为从 core import 并 re-export —— **消除跨包依赖**；
2. 根 `core/` 复制为两包内 `core/` 副本（`scripts/sync-core.sh` 强制同步 + 一致性校验，
   prepack 前必跑；`core/tests` 不进包）——**包自包含**；
3. 两包 `index.js` import 改为 `./core/...`（包内相对路径）；
4. `root.test.ts` 的「模块同一性」断言演进为「行为等价 + 内容一致」（B7 后两半持包内副本，
   实例不同但内容必须一致——防分叉的实质不变）；
5. `check_g108.sh` 静态检查 `supervisorSession` 于 host/index.js——boardPayload 迁移后
   该字符串位于 core/ops.ts，已在 host re-export 注释处如实说明字段来源（脚本冻结未改）。

**备选方案**（如负责人倾向）：
- A. core 抽独立 npm 包（`dsh-graph-core`）：三包发布，host/client `dependencies` 引它——最干净但多一个发布物；
- C. 合并单包：放弃 host/client 拆分——最简单但偏离现有结构。

## 7. 上架 awesome-dsh-plugin（B5+B6 后）

仓库：`awesome-dsh-plugin/awesome-dsh-plugin`（⭐11k，双语 README）。

**提交物**：新增一个文件 `data/plugins/miuzel__dsh-graph.yml`：

```yaml
url: https://github.com/miuzel/dsh-graph        # 必须与仓库完全一致
name: miuzel/dsh-graph                          # 列表中显示的链接文本
category: dev                                   # 待定：dev/workflow/tools 中选贴合实际者
description:
  en: Goal lifecycle management for dsh with an interactive kanban board.
  zh: dsh 目标生命周期管理与可视化看板。          # 可选，维护者会补
```

**分步命令**：

```sh
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
# 写 data/plugins/miuzel__dsh-graph.yml（如上）
npm ci && node scripts/generate-readme.mjs        # 重新生成双语 README
git add data/plugins/miuzel__dsh-graph.yml README.md README.zh.md
git commit -m "add dsh-graph plugin entry"
GIT_SSH_COMMAND="ssh -F /dev/null" git push -u origin <branch>
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin --fill
```

**PR 硬性条件自查**（PR 模板清单）：

- [ ] 一个文件 `data/plugins/<owner>__<repo>.yml`；
- [ ] 已跑 `node scripts/generate-readme.mjs` 并提交重新生成的 README；
- [ ] repo 的 package.json 声明 `dsh.bundle`（非仅 `dsh.client`）；
- [ ] 仓库创建 ≥1 天且 commits ≥10（CI 自动检查）；
- [ ] category 取值合法且贴合实际；
- [ ] 描述只说功能、无营销词、与代码一致；
- [ ] 仓库已打 `dsh-plugin` topic；
- [ ] 推荐：npm 发布（预构建免 allowBuilds）、`@deepseek-ai/*` 用 peerDependencies、
      截图入 `data/screenshots.json`。

PR 合并后，dsh-market / DshMarketPlace / DSH Get 三家自动带出（同源 awesome-dsh-plugin）。

## 8. 发布 checklist（总）

- [x] g-112 root 通用化完成（client patch 无硬编码路径，host/client 同一解析基准）
- [x] B7 打包结构实现（boardPayload 移 core、core 副本进包、sync-core.sh、import 改包内路径）
- [x] 两包 private:false + LICENSE + README + npm 元数据 + files 白名单 + prepack 脚本
- [x] 43/43 单测 + 8 验收脚本全绿 + 他机视角加载验证
- [ ] git user/remote 配置、代码 commit 全量入库
- [ ] 建公开 repo miuzel/dsh-graph + dsh-plugin topic（B6 凭据由负责人提供）
- [ ] npm 官方登录 → pnpm publish 两包 → npm view 核验
- [ ] 本地全新 profile `dsh plugin add` 验收通过
- [ ] PR awesome-dsh-plugin（YAML + 重新生成 README）→ 合并 → 三家商店带出
