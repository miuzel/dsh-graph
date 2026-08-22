# dsh-graph v0.3 发布手册与商店上架清单（g-111）

> 状态：**v2（att-003 执行阶段产物，含关键 bug 修复）**。
> 前置缺口已补齐：g-112 已交付（root 通用化）、B7 打包结构已实现（**ship 编译后 .js**）、
> 包元数据/LICENCE/README 完成、53/53 单测 + 冻结脚本全绿、**真实全新 profile 安装加载验证通过**（g-116 后单包）。
> 剩余人工 gate 见 §1 表（B6 npm 登录凭据）。
> 依据：调研卡 card-996e88de + docs/release-prep-gh-recon.md（att-003 实机侦查）。

## 0. 总体路径（负责人定案）

补缺口 → 建公开 repo + 打 dsh-plugin topic → pnpm publish 单包（dsh-graph，g-116 合并，包名=repo 名）→
本地 `dsh plugin add` 验收 → PR awesome-dsh-plugin（自动带出三家商店）。

## 1. 前置阻塞清单（当前状态）

| # | 阻塞 | 归属 | 状态 |
|---|------|------|------|
| B1 | client cordis.patch.yml 硬编码绝对路径 | g-112（root 通用化） | ✅ **已交付**（resolveRoot + init，43/43+7 脚本） |
| B2 | 包 `private: true` | g-111 执行 | ✅ **已改 false**（version 0.3.0，g-116 后单包 0.4.0） |
| B3 | 缺 LICENSE/README/npm 元数据/files 白名单/build&prepack 脚本 | g-111 执行 | ✅ **已补齐**（见 §2） |
| B4 | git 无 remote、无 user.name/email | g-111 执行 | ⏳ 待发布前配置（命令见 §2.2） |
| B5 | 无 dsh-plugin topic（建 repo 后打） | g-111 执行 | ⏳ 建 repo 时打 |
| B6 | **npm 官方 registry 未登录**（npmmirror 镜像无账号） | 人工 gate | ⚠️ 需负责人凭据 |
| B7 | **跨包打包结构**：client/host 均依赖包外 core，client 跨包引 host | g-111 执行 | ✅ **已解决**（见 §6） |
| B8 | **发布包带 .ts 源码不可加载**（node_modules 下 type-stripping 硬禁用） | g-111 执行 | ✅ **已修复**（编译 .js，见 §6.1） |

## 2. 发布缺口补齐（B2/B3/B7——已完成）

### 2.1 单包 package.json（0.4.0，g-116 合并后）

- `"private": false`、`"version": "0.4.0"`（单包重新发，表示结构变更）；
- 元数据：`description`（单包双半）、`repository` → `https://github.com/miuzel/dsh-graph.git`、
  `keywords`（含 `dsh` `dsh-plugin` `deepseek-harness` `plugin` `kanban` `ui` 等）、`license: MIT`、
  `engines.node: ">=22"`（包内 core 为编译后 .js，无 type-stripping 依赖）；
- `files` 白名单：index.js + core/ + lib/ + cordis.patch.yml + supervisor-guide.md + README.md + LICENSE；
- `dsh` 声明：`bundle.patch`（cordis.patch.yml）+ `client`（platform web + inject）同在一包；
- `prepack`：`bash ../scripts/sync-core.sh && 断言 core/ops.js 存在`（先同步 core 副本再打包）；
- `exports`：`.` / `./client`（lib/client.js）/ `./cordis.patch.yml` / `./package.json`。

### 2.2 git 前置（B4，发布前执行）

```sh
git config user.name "miuzel"
git config user.email "<github 绑定邮箱>"
```

### 2.3 验收证据（att-003 已跑）

- `node --test core/tests/*.test.ts` → **43/43 全绿**；
- 8 个冻结验收脚本（check_core/plugin/g107/g108/g109/ga92e1406/cards/kanban）→ **全部 PASS**；
- `npm pack` 单包 → 产物完整（index.js + core/ + lib/ + cordis.patch.yml + supervisor-guide.md + README + LICENSE）；
- **他机视角验证**：解包 tgz 后 node 直接 import —— host 14 工具注册 + boardPayload/resolveRoot 导出；
  client 9 条 web 路由注册 + apply OK（无任何包外引用）。

## 3. 建公开 repo + 打 topic（B5）

```sh
# 本机 ssh 系统配置损坏，push 用 -F /dev/null 绕过（实机验证，见 recon §1）
GIT_SSH_COMMAND="ssh -F /dev/null" git remote add origin git@github.com:miuzel/dsh-graph.git
GIT_SSH_COMMAND="ssh -F /dev/null" git push -u origin main
gh repo edit miuzel/dsh-graph --add-topic dsh-plugin --add-topic dsh --add-topic plugin
```

> `miuzel/dsh-graph` 为 repo 名；npm 侧 `dsh-graph` 未占用（包名=repo 名，g-116 命名更正）；原 `dsh-graph-client` 名已废弃。

## 4. pnpm publish 单包（B6 解除后）

```sh
# 前置：npm 官方登录（人工 gate，需负责人凭据）
npm login --registry=https://registry.npmjs.org   # 或 NODE_AUTH_TOKEN + .npmrc

# 发布（目录内执行，registry 显式指定官方；g-116 后仅单包）
(cd dsh-graph-host && pnpm publish --registry=https://registry.npmjs.org --no-git-checks)  # 目录名保留 dsh-graph-host，npm 包名为 dsh-graph

# 核验
npm view dsh-graph version
```

> 注意：本机 `~/.npmrc` 指向 npmmirror 镜像且未登录——发布前必须切官方 registry 并登录；
> 沙箱内 pnpm 的 supply-chain policy 会对本地 tgz 误报（minimum-release-age），真实发布到官方
> registry 后无此问题（该 policy 只查官方 registry 的发布时间）。

## 5. 本地验收（发布后）

```sh
# 用一个全新 profile 验证「他机视角」安装（单包同时给工具/skill/看板）
DSH_HOME=/tmp/dsh-pub-check dsh plugin --profile web add dsh-graph
DSH_HOME=/tmp/dsh-pub-check dsh --profile web "ping"   # 断言插件加载激活
# 断言 graph_* 工具注册（marker 自测或 dump-config 看归属行）
```

验收点：profile 内安装包（非 link:）、root 解析正确（g-112 后不再硬编码）、
`/api/dsh-graph` 端点在 web 模式可访问。

> att-003 已用**真实全新 profile（隔离 DSH_HOME）+ tgz 安装**验证加载链路：headless 启动 marker
> 落盘（14 工具注册 + validate PASS）、web 启动 `/api/dsh-graph` 返回正确 JSON 且首页含
> client.js bundle。正式发布后按本命令复验一次即可。

## 6. 打包结构（B7+B8——已实现，方案 B + .js 编译）

### 6.0 关键 bug（B8）：发布包必须 ship 编译后的 .js

**实机复现**：Node 原生 type-stripping 对 `node_modules` 下的 .ts **硬禁用**：

```
node -e "import('./node_modules/probe/index.ts')"
→ ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING: Stripping types is currently
  unsupported for files under node_modules
```

本地仓库内 core/*.ts 能跑（不在 node_modules 下），但 npm 包安装后一定在用户
node_modules 下 → **带 .ts 的包必然崩**。修复：core/*.ts 编译为 .js 进包。

### 6.1 编译链路（已实现）

1. 根 `package.json` 加 `devDependencies: typescript ^5.7 + @types/node`（构建期依赖，
   R-01 零运行时依赖不受影响）；`tsconfig.json`：`module: esnext`、`target: es2022`、
   `allowImportingTsExtensions + rewriteRelativeImportExtensions`（TS 5.7+ 自动把
   `./x.ts` import 重写为 `./x.js`）；
2. `scripts/sync-core.sh`（语义 = build）：`tsc -p tsconfig.json` → `core-dist/*.js`
   → 复制进包 `core/` → 校验单包产物与编译输出一致 + **无 .ts 泄漏**；
3. 包 `index.js` import 从 `./core/*.ts` 改为 `./core/*.js`；`engines.node` 降到 `>=22`
   （编译后无 type-stripping 依赖）；`files` 白名单即含编译后的 `core/*.js`；
4. 包 `prepack` = `bash ../scripts/sync-core.sh` + 断言 `core/ops.js` 存在；
5. `root.test.ts`「内容一致」断言改为校验包内 `core/root.js` 产物 + 无 .ts 引用（g-116 后单包）。

### 6.2 跨包结构（B7，前一轮已实现）

1. `boardPayload` 从 `dsh-graph-host/index.js` **移入 `core/ops.ts`**（它只依赖 core 内函数），
   host/client 均改为从 core import 并 re-export —— **消除跨包依赖**；
2. 根 `core/` 为唯一事实来源，产物经 sync-core.sh 进包——**包自包含**；
3. 包 `index.js` import 改为 `./core/...`（包内相对路径）；
4. `check_g108.sh` 静态检查 `supervisorSession` 于 host/index.js——boardPayload 迁移后
   该字符串位于 core/ops.ts，已在 host re-export 注释处如实说明字段来源（脚本冻结未改）。

**备选方案**（如负责人倾向）：
- A. core 抽独立 npm 包（`dsh-graph-core`）：三包发布，host/client `dependencies` 引它——最干净但多一个发布物；
- C. 合并单包：放弃 host/client 拆分——最简单但偏离现有结构。

### 6.3 编译产物文件（单包 6 个，与根 core/*.ts 一一对应）

`core/events.js` `core/machine.js` `core/main.js` `core/model.js` `core/ops.js` `core/root.js`

**验收证据（att-003 实机）**：`node --check` ✅；43/43 单测 ✅；8 冻结脚本全 PASS ✅；
真实全新 profile（隔离 DSH_HOME）+ `pnpm add <tgz>` 装进 node_modules → headless 启动
marker 落盘（14 工具注册 + validate PASS）；web 启动（端口 4317）`/api/dsh-graph`
返回 `{"generated_at":…,"versions":[],"supervisorSession":null,…}`、首页含
`plugins/dsh-graph/client.js`（单包 client 半边，entry name=包名 dsh-graph）。

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
- [x] **B8 修复：core 编译为 .js 进包（node_modules 下可加载）**——tsconfig/tsc 链路 + sync-core.sh build 语义 + import 改 .js + 无 .ts 泄漏
- [x] 单包 private:false + LICENSE + README + npm 元数据 + files 白名单 + prepack 脚本
- [x] 59/59 单测 + 8 验收脚本全绿 + 真实全新 profile 安装加载验证（headless marker + web /api/dsh-graph）
- [x] **发布版本号：0.4.0**（2026-08-22 10:24 已发，g-116 单包合并版；**不含 g-117 工具**）
- [x] git user/remote 配置、代码 commit 全量入库（81 commits 已推 origin/main）
- [x] 建公开 repo miuzel/dsh-graph（2026-08-21 17:56Z）+ dsh-plugin topic
- [ ] **npm 发布 0.5.1**（v0.5 特性集：拖放 g-77647351 / 建目标 g-129 / append 规范 g-130 / 主管提醒 g-131 / backlog 平铺 g-137 / 重命名 g-141 / 归档 g-110 / 删除 g-140 / 阻塞折叠 g-127 + g-117 交接工具；0.3.2 弃用不动）——由负责人执行：
      `cd dsh-graph-host && pnpm publish --registry=https://registry.npmjs.org --no-git-checks`（2FA 设备验证；若 token 失效先 `npm login`）
      发布后核验 `curl -s https://registry.npmjs.org/dsh-graph | grep '"version"'` 为 0.5.1，`.../index.js` 含 graph_archive_goal/delete_goal/rename_goal
- [ ] 本地全新 profile `dsh plugin add` 验收通过（0.5.1 发布后）
- [ ] **PR awesome-dsh-plugin**：分支 `miuzel/awesome-dsh-plugin:add-dsh-graph` 已备好（YAML + 双 README 再生成 1838 条，diff 仅 +1 行/README）；
      仓库满 1 天（约 2026-08-23 01:57 +08:00，CI 自动检查）后 `gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin --fill` → 合并 → 三家商店带出
