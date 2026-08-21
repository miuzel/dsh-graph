# dsh-graph v0.3 发布手册与商店上架清单（g-111）

> 状态：**草稿 v0**（att-003 侦查阶段产物）。执行前须解决前置阻塞（见 §6）。
> 依据：调研卡 card-996e88de + docs/release-prep-gh-recon.md（att-003 实机侦查）。

## 0. 总体路径（负责人定案）

补缺口 → 建公开 repo + 打 dsh-plugin topic → pnpm publish 两包 →
本地 `dsh plugin add` 验收 → PR awesome-dsh-plugin（自动带出三家商店）。

## 1. 前置阻塞清单（须先解决）

| # | 阻塞 | 归属 | 状态 |
|---|------|------|------|
| B1 | client cordis.patch.yml 硬编码绝对路径 | g-112（root 通用化） | ⏳ collecting，卡 empty |
| B2 | 两包 `private: true` | g-111 执行 | 待补 |
| B3 | 缺 LICENSE/README/npm 元数据/files 白名单/build&prepack 脚本 | g-111 执行 | 待补 |
| B4 | git 无 remote、无 user.name/email | g-111 执行 | 待补 |
| B5 | 无 dsh-plugin topic（建 repo 后打） | g-111 执行 | 待补 |
| B6 | **npm 官方 registry 未登录**（npmmirror 镜像无账号） | 人工 gate | ⚠️ 需负责人凭据 |
| B7 | **跨包打包结构未定**：client/host 均 `import "../core/ops.ts"`，client 还跨包引 host 的 boardPayload | 设计定案 | ⚠️ 新发现，见 §6 |

## 2. 发布缺口补齐（B2/B3/B4）

两包 package.json 需：

- `"private": false`；
- 元数据：`description`、`repository`（公开 repo URL）、`keywords`（含 `dsh-plugin`、`dsh` 等）、`license`、`files` 白名单（index.js + cordis.patch.yml + README + LICENSE，host 另加 supervisor-guide.md）；
- `main`/`exports` 保留现有；
- `prepack` 脚本（build 步骤见 §6 定案后补）。

git 前置（B4）：

```sh
git config user.name "miuzel"
git config user.email "<github 绑定邮箱>"
```

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

## 5. 本地验收（B7 解决后）

```sh
# 用一个全新 profile 验证「他机视角」安装
DSH_HOME=/tmp/dsh-pub-check dsh plugin --profile web add dsh-graph-client
DSH_HOME=/tmp/dsh-pub-check dsh --profile web "ping"   # 断言插件加载激活
# 断言 graph_* 工具注册（marker 自测或 dump-config 看归属行）
```

验收点：profile 内安装包（非 link:）、root 解析正确（g-112 后不再硬编码）、
`/api/dsh-graph` 端点在 web 模式可访问。

## 6. 待设计定案：跨包打包结构（B7，本 attempt 新发现）

现状（实机确认）：

```
dsh-graph-client/index.js  import {…} from "../core/ops.ts"
dsh-graph-client/index.js  import { boardPayload } from "../dsh-graph-host/index.js"
dsh-graph-host/index.js    import {…} from "../core/ops.ts"
core/ops.ts → events.ts / machine.ts / model.ts（纯 node: 内置模块，无第三方运行时依赖）
```

npm 发布后 `../core`、`../dsh-graph-host` 均不在包内 → 安装即崩。候选方案：

- **A. core 抽独立包**（如 `dsh-graph-core`）：两包 `dependencies` 引它；最干净，但多一个发布物；
- **B. 打包进两包**：prepack 把 core 复制进包内目录并改 import（如 `./vendor/core/`），
  两包各自独立；client 需要的 boardPayload 从 host 抽到 core；
- **C. 合并单包**：放弃 host/client 拆分，一个 `dsh-graph` 包内分 exports；
  最简单，但偏离现状结构。

**建议**：方案 B 或 A（A 更可维护）。需负责人定案（与 g-112 root 通用化一并决策）。

## 7. 上架 awesome-dsh-plugin（B5+B7 后）

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

- [ ] g-112 root 通用化完成（client patch 无硬编码路径，host/client 同一解析基准）
- [ ] B7 打包结构定案并实现（core 归位、build/prepack 脚本、files 白名单）
- [ ] 两包 private:false + LICENSE + README + npm 元数据
- [ ] git user/remote 配置、代码 commit 全量入库
- [ ] 建公开 repo miuzel/dsh-graph + dsh-plugin topic（B6 凭据由负责人提供）
- [ ] npm 官方登录 → pnpm publish 两包 → npm view 核验
- [ ] 本地全新 profile `dsh plugin add` 验收通过
- [ ] PR awesome-dsh-plugin（YAML + 重新生成 README）→ 合并 → 三家商店带出
