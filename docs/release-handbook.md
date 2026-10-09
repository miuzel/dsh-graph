# dsh-graph v0.3 发布手册与商店上架清单（g-111）

> 状态：**v2（att-003 执行阶段产物，含关键 bug 修复）**。
> 前置缺口已补齐：g-112 已交付（root 通用化）、B7 打包结构已实现（**ship 编译后 .js**）、
> 包元数据/LICENCE/README 完成、53/53 单测 + 冻结脚本全绿、**真实全新 profile 安装加载验证通过**（g-116 后单包）。
> 剩余人工 gate 见 §1 表（B6 npm 登录凭据）。
> 依据：调研卡 card-996e88de + docs/release-prep-gh-recon.md（att-003 实机侦查）。

> **现行打包口径（g-353，2026-10，覆盖下文 §2.1/§6.1 的旧描述）**：唯一打包入口是根目录
> `bash scripts/build.sh`（= `pnpm build` = `prepare` 生命周期；根 `package.json` **没有**
> `prepack` 脚本）。打包 = `bash scripts/build.sh && (cd dist && npm pack)`。**纯只读检查**（不构建、
> 不修复、不改文件）用 `node --test core/tests/dist-freshness-g312.test.ts`。⚠️ **不要用
> `pnpm check:dist` 当只读入口**（g-408）：pnpm 在 `run`/`exec` 前会做 `verifyDepsBeforeRun` 检查
> （pnpm ≥ 11 默认 `install`，pnpm 10 为 `false`），`node_modules` 不新鲜时会隐式 `pnpm install` ⇒
> 根 `prepare`（= 完整构建）并原子替换 `dist/`，随后才跑守卫。下文提到的「包内 `prepack`」属
> v0.4.0 多包结构，**已废止**，勿照做。

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

## 4. pnpm publish 单包（发布树标准流程）

**权威流程（自 v0.10.0 复盘确定）**：发布必须在「发布 tag 的独立 worktree」里执行，严禁在 `<version>-test` 集成分支或主工作区直接发布。
集成分支在发布合并之后随时可能继续提交，从那里 publish 会让「发布物 ≠ tag 内容」的隐患成立。

> ### ⚠️ 发布目录是 `dist/`，不是 `dsh-graph-host/`（2026-09-21 修正）
>
> 本仓库把**源码**与**发布物**分离：
>
> - **源码**：`dsh-graph-host/`（`index.js`、`lib/client/*.js` 拆模块、`package.json`、`prompts/`、
>   `README.md`、`supervisor-guide.*`、`cordis.patch.yml`）+ 仓库根 `core/*.ts`。
> - **发布物**：`dist/` —— 编译后的 `core/*.js`、拼装成单文件的 `lib/client.js`、以及以上静态资源。
>
> **`dsh-graph-host/` 里没有 `core/`、也没有 `lib/client.js`**，从那里 publish 会发出 TS 源码并
> 缺 `core/*.js` / `lib/client.js`，装到宿主上直接 loader 失败。
> 旧版手册的 `cd dsh-graph-host && pnpm publish` 是 0.4 时代残留，**已作废**。
> 核对依据：线上 `dsh-graph@0.12.0` 包内 36 个文件与 `dist/` 内容逐一同构（`core/*.js`，无 `.ts`）。
>
> `dist/` 被 `.gitignore` 忽略 ⇒ **发布树里必须先构建**（见步骤 3）。

```sh
# 0. 前置：确认 registry 与登录态（人工 gate）
npm config get registry                             # 期望 https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org    # ⚠️ 2026-09-21 实测 E401 → 现有 token 已失效
npm login --registry=https://registry.npmjs.org     # ⇒ 发布前必须先重新登录（whoami 打印出用户名才算过）

# 1. 把待发布内容合并到 main 并打 tag（由负责人执行；主管不新建/不迁移/不推送 tag）
git checkout main && git merge --no-ff vX.Y.Z-test && git tag -a vX.Y.Z -m "dsh-graph vX.Y.Z"
GIT_SSH_COMMAND="ssh -F /dev/null" git push origin main && GIT_SSH_COMMAND="ssh -F /dev/null" git push origin vX.Y.Z

# 2. 为 tag 建独立发布树（不打扰集成分支/开发实例），并软链仓库根 node_modules 确保 tsc/pnpm 可用
git worktree add --detach .worktrees/release-vX.Y.Z vX.Y.Z
ln -sfn "$PWD/node_modules" .worktrees/release-vX.Y.Z/node_modules
git -C .worktrees/release-vX.Y.Z describe --tags   # 必须输出 vX.Y.Z

# 3. 在发布树里构建 dist/（发布物的唯一来源），并核对版本号与产物内容
(cd .worktrees/release-vX.Y.Z && bash scripts/build.sh)
node -p "require('./.worktrees/release-vX.Y.Z/dist/package.json').version"   # 必须 == X.Y.Z
(cd .worktrees/release-vX.Y.Z/dist && pnpm pack --dry-run)                   # 核对文件清单（v0.18.0 起应为 37 个文件）

# 4. 在 dist/ 里发布（发布物必须来自「tag 树构建出的 dist/」）
(cd .worktrees/release-vX.Y.Z/dist && pnpm publish --registry=https://registry.npmjs.org --no-git-checks)
# 4'. 或（v0.20.0 起**推荐**）：直发已验 tarball —— registry **不重打**，指纹与本地逐字一致（见下方 v0.20.0 实证）
npm publish /abs/path/dsh-graph-X.Y.Z.tgz --registry=https://registry.npmjs.org
#     注意：tarball 必须来自「与 tag 树 tree 逐字相等」的构建树（发布源树），并已记录 sha256

# 5. 核验线上版本 + 内容级对账
npm view dsh-graph version                       # 期望 X.Y.Z
# ⚠️ registry 会重写上传的 tarball（条目排序/gzip 不同）⇒ 线上 sha256 必然 ≠ 本地 pack sha256。
#    不要拿 tarball sha256 比对；要解包后比内容：
mkdir -p /tmp/pubcheck && cd /tmp/pubcheck && npm pack dsh-graph@X.Y.Z && tar -xzf dsh-graph-X.Y.Z.tgz
diff -r /tmp/pubcheck/package <本地已验包解包目录>     # 期望无输出；唯一已知例外：package.json 末尾换行（见下方对账判据）

# 6. 收尾：核验后清理发布树
git worktree remove .worktrees/release-vX.Y.Z
```

> **发布后对账判据（v0.15.0 实证修正）**：v0.15.0 实测线上 414,753 B / sha256 `d72f8ea6…`，
> 本地已验 414,102 B / `c102aca6…`——**差 651 B 但内容完全等价**：解包后 36/36 文件、逐文件
> `diff -r` 无差异，且两者**未压缩 tar 体积相同**（1,564,672 B）、包内 mtime 相同（registry 可复现
> 时间戳）。差异纯在打包层（条目顺序 + gzip 头/参数）。故：
> **跨机器传递**（本机 ↔ Windows）用 tarball sha256 对账（红线 3）；
> **registry 侧**必须用**内容级**对账（`diff -r` 或逐文件 sha256 列表）。
>
> **v0.18.0 再次实证（2026-10-02）**：npm `dist.integrity` = `sha512-qZFf141MLYECy4jdPBXRWZXPrjU7h+44EP4kcepesQC3yTJ+fBYGomNmcjjaWUuXNJR51B5ZfQlJJqIObP1Kqg==`
> （tarball **570,878 B**）vs 本地 `pnpm pack` = `sha512-MOgg3ZJd…`（**570,157 B**）——**差 721 B**；
> 但 `diff -rq` **零差异**、**37/37 文件**、排除 `package.json` 后逐文件 sha256 聚合两边同为
> `daf705b6a6ee919f…`，且 `package.json` 本身**逐字节相同**。⇒ 规则不变，**别拿 tarball sha256 比 registry**；
> 只有**同一个本地 tarball**（v0.18.0 = `3ae728dd…`，570,157 B）才用于本机 ↔ Windows/macOS 的对账。
> 另：`npm publish` 会**重新压缩并改写** tarball，因此**发布后不可能用本地 sha256 复现 registry 指纹**，
> 这不是发布事故、**无需返工**——按内容级判据放行即可。
>
> **v0.19.7 第三次实证（2026-10-06）——「唯一的合法差异」已被钉死**：线上 tarball **628,367 B** /
> sha256 `9874e83d2c6e3c9a5f2d46f75c64b4b89d785e4088069d4c86933dd231a01690`，本地终版 **624,934 B** /
> `3800ba76b1002ae9475019008cc4e973b6390a09953071ae89a1589cbdfd02bd`（差 **3,433 B**）。
> 解包对账：**成员集合 37/37 完全相同**，逐文件差异**只有 `package.json` 一处** —— registry 规范化
> **删掉了文件末尾的换行**（`diff -u` 显示 `\ No newline at end of file`），其余 **36 个文件逐字节一致**。
> ⇒ 判据收紧为：**`diff -r` 出现且仅出现「`package.json` 末尾换行」这一处差异 = 等价放行**；
> 除此之外的任何差异（含 `package.json` 的其他字段）都必须查清再放行。
> （本次另一条平行证据：同一提交在隔离 worktree 内独立 build + pack 复算出**同一**本地 sha256 ⇒ 本地侧
> 字节可复现，唯一变量就是 registry 的重写。）
>
> **v0.20.0 第四次实证（2026-10-10）—— 口径再进一步：直发 tarball 时 registry 指纹与本地逐字一致**：
> 本次**未**在 `dist/` 里 `pnpm publish`，而是 `npm publish <本地终版 tarball>`（步骤 4'）。实测
> `npm view dsh-graph@0.20.0 dist --json` 得 `shasum` `01590980f4800e5c9c8d442fc62ade11802ef482`、
> `integrity` `sha512-eVbLFfmqYiZYyK2QHTlesBLJ62icaiG3K6b2btohuYosiJavd0zlaHkNnaY6decCRShEHb40QWUVunG+SaM/nA==`
> （`fileCount` 43 / `unpackedSize` 4318053），与本地终版包（1,436,959 B）**sha1 与 sha512 双双逐字一致**；
> GitHub release 附件的**服务端自算 digest** 亦同为 `sha256:51d7de25134725c1955a5d6a177352a2ae53f10c39b1af1678311d714ae86e5a`。
> ⇒ **直发 tarball 不会被 registry 重打**，registry 侧对账因此可升级为**字节级**（sha1 + sha512）；
> 上文「线上必然差几百 B」只适用于**从目录发布**（npm 重新打包）的旧路径。**推荐直发 tarball**：
> 它让红线 3 的对账第一次做到字节级，并保证「**被测产物 == 发布产物 == release 附件**」是同一份字节；
> 内容级 `diff -r` 判据保留为兜底（成员集合 + 逐文件差异）。
> （本次 tag 树相等性：发布源树 tree 与 `v0.20.0` tag 指向的合并提交 tree **逐字相等**，已核对 `HEAD^{tree}`；
> 且三条独立构建路径得同一 sha256 ⇒ 与「tag 树构建」等价。）

> 注意：**registry 与登录态（2026-09-21 实测更新）**——早先「`~/.npmrc` 指向 npmmirror 镜像且未登录」
> 的描述已过时：当前 `npm config get registry` 输出 `https://registry.npmjs.org/`。
> 但 `~/.npmrc` 里**虽存在** `//registry.npmjs.org/:_authToken=…`，该 token **实测已失效**：
> `npm whoami --registry=https://registry.npmjs.org` 返回 **`E401 Unauthorized`**（2026-09-21）。
> ⇒ **不能只看 `.npmrc` 里有 token 就认定已登录**；发布前必须 `npm login` 并确认 `whoami` 能打印
> 出用户名，否则 `pnpm publish` 必定 401。这正是步骤 0 要求「必做」的原因。
>
> 沙箱内 pnpm 的 supply-chain policy 会对本地 tgz 误报（minimum-release-age），真实发布到官方
> registry 后无此问题（该 policy 只查官方 registry 的发布时间）。
>
> ⚠️ **`dist/` 里不要留 `.tgz`**：若在 `dist/` 里试打过包（`pnpm pack` 会就地生成
> `dsh-graph-X.Y.Z.tgz`），**必须先删掉再 `publish`**，否则该 tgz 会被当作普通文件一起打进发布包，
> 污染发布物。发布前固定核对两项：
> `find dist -type f | wc -l`（**v0.18.0 起期望 37**：g-381 新增 `lib/client/search-match.js`；此前为 36）与 `find dist -name '*.tgz' | wc -l`（期望 **0**）。
>
> 另：本机 `/etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf` 权限损坏会导致所有 ssh 推送失败
> （`Bad owner or permissions on ...`），git push 一律加 `GIT_SSH_COMMAND="ssh -F /dev/null"`（v0.9.2、
> v0.10.0 均以此绕行成功）。

### 4.1 发布正文（release notes）：真源、模板与发布后核对

> **背景（v0.20.0 教训）**：首次发布时正文只由 `CHANGELOG` 要点 + 两个裸链接拼成，**漏掉「验证与产物」整节**
> （产物 sha1、registry 对账句、真机门禁段落、可复现性），比 v0.19.8 的正文少 4 项。根因是当时 notes
> 只存在于 `tmp/`（无真源、无守卫、无复核面）；而更早的 v0.6.1–v0.9.1 曾把 notes 作为**版本化文档**
> `docs/release-notes-v*.md` 入库。本条把这套做法定为**跨版本规则**。

**真源**：`docs/release-notes-v<版本>.md` —— **入 git、随版本评审**，不得只留在 `tmp/`。
线上正文必须由该文件发布（不手改线上）：

```sh
gh release create vX.Y.Z -R miuzel/dsh-graph <tarball> SHA256SUMS \
  --title "vX.Y.Z" --notes-file docs/release-notes-vX.Y.Z.md
# 已发布后才发现正文不全（可逆，不涉 push/publish）：
gh release edit vX.Y.Z -R miuzel/dsh-graph --notes-file docs/release-notes-vX.Y.Z.md
```

**必需小节（缺一即视为不完整）**：

1. `## v<版本> — <日期>` 标题 + **要点**（与 `CHANGELOG.md` 同文，≤5 条，受 `g371` 守卫约束）；
2. `### 安装 / 升级`：宿主内安装命令 + 本版升级是否需要手工动作；
3. `### 验证与产物`，含四条：
   - **平台真机门禁**：已实测平台写通过事实（分层结论 + 指向 `docs/platform-gate.md` 的具体小节）；
     **未实测平台必须如实标注「本版未验证」**，不得留空、不得读作「已通过」；
   - **发布产物**：文件名 + **sha256 与 sha1**（+ 成员数），并写明 registry `dist.shasum` / `dist.integrity` 的对账结论；
   - **发布记录**：指向 `docs/release-checklist-v<版本>.md`；
   - **可复现性**：从源码构建是否与本 tag 逐字节可复现（含独立构建路径数）。

**发布后核对（必做）**：线上正文与真源**逐字相等**（唯一可接受差异：GitHub 侧对文末换行的归一化）——

```sh
diff <(gh release view vX.Y.Z -R miuzel/dsh-graph --json body --jq .body) docs/release-notes-vX.Y.Z.md
```

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

### 5.1 宿主兼容性判定口径（**必需三维度**，g-469 修正）

宿主（DSH）升级或放宽兼容声明面时，「**安装** + **启动**」**不足以**证明插件可用——它只覆盖
「加载链路」，覆盖不到「**派发链路**」。兼容性判定必须**同时**包含三个维度，缺一即不得判定兼容：

| # | 维度 | 最小验证 | 失败形态 |
| --- | --- | --- | --- |
| 1 | **安装** | 全新 profile（隔离 `DSH_HOME`）+ 真 tarball/registry 安装，`dsh plugin add` 成功 | 依赖/入口解析失败 |
| 2 | **启动** | headless/web 起得来：工具注册 marker 落盘、`/api/dsh-graph` 返回合法 JSON、首页含 client bundle | profile 冲突、`apply()` 抛错 |
| 3 | **派发可用** | 在隔离实例上**真正起一个子代理**：`graph_start_attempt` 返回**真实 `child_id`**（非 null、无 `child_error`）并完成绑定；同时覆盖旧宿主回归 | `startContinuable/startActivation is not a function`、provider 能力探测失配、并发槽位文案未被映射 |

- 维度 3 是**独立**维度：宿主对 subagent 服务的方法改名/签名变更（如 DSH `0.2.1-alpha.2` 把
  `startContinuable(spec)` 改名为 `startActivation(spec)`）不影响维度 1/2，却让**全部派发点**失效
  ⇒ 只看「可装可跑」会把「派发完全不可用」判成兼容。
- 维度 3 的实现口径由仓内守卫钉住：`dsh-graph-host/index.js` 的派发**唯一收口** helper
  `startSubagentCompat(subagents, spec)`（新名优先、旧名回退、两者皆无 fail-closed），
  回归测试 `core/tests/g469-host-subagent-api-compat.test.ts`（含结构性守卫与真实宿主契约夹具）。
- 环境约束（沿用 §5）：验收实例的 `DSH_HOME` 与 workspace 必须在项目 `tmp/` 内，端口避开在跑的
  宿主实例；**不得**把测试替换进正在服务的主实例。

> **历史判定如实记录（g-465）**：v0.20.0 放宽宿主兼容声明面（`<0.2.2-0`）时的兼容性判定
> **只覆盖了维度 1（安装）+ 维度 2（启动）**，未做维度 3（派发可用）⇒ 该判定**不满足**本节口径，
> 结论「兼容」在派发维度上**未被验证**。后续实际使用中由 g-469 暴露：`0.2.1-alpha.2` 上
> 5 处派发点全部报 `subagents.startContinuable is not a function`。本条按事实留痕，**不回改**
> g-465 的历史结论措辞；后续同类判定一律按本节三维度执行。

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

> ⚠️ **本节为历史存档（v0.4.0 / v0.5.1 时期），已不作当前版本的操作依据。**
> §0–§7 的流程仍然有效（尤其 **§4 发布树标准流程**），但**每版本的检查清单已按版本独立成文**：
>
> - 当前版本：**[`docs/release-checklist-v0.15.0.md`](release-checklist-v0.15.0.md)**
> - 上一版本：`docs/release-checklist-v0.10.0.md`
>
> 另注意：**跨版本发布红线（Windows 真机 T1–T5 门禁、版本号三处一致、tarball + sha256 对账）
> 的权威定义在仓库根 [`AGENTS.md`](../AGENTS.md) 的「发布门禁」段，不在本手册内。**

- [x] g-112 root 通用化完成（client patch 无硬编码路径，host/client 同一解析基准）
- [x] B7 打包结构实现（boardPayload 移 core、core 副本进包、sync-core.sh、import 改包内路径）
- [x] **B8 修复：core 编译为 .js 进包（node_modules 下可加载）**——tsconfig/tsc 链路 + sync-core.sh build 语义 + import 改 .js + 无 .ts 泄漏
- [x] 单包 private:false + LICENSE + README + npm 元数据 + files 白名单 + prepack 脚本
- [x] 59/59 单测 + 8 验收脚本全绿 + 真实全新 profile 安装加载验证（headless marker + web /api/dsh-graph）
- [x] **发布版本号：0.4.0**（2026-08-22 10:24 已发，g-116 单包合并版；**不含 g-117 工具**）
- [x] git user/remote 配置、代码 commit 全量入库（81 commits 已推 origin/main）
- [x] 建公开 repo miuzel/dsh-graph（2026-08-21 17:56Z）+ dsh-plugin topic
- [ ] **npm 发布 0.5.1**（v0.5 特性集：拖放 g-77647351 / 建目标 g-129 / append 规范 g-130 / 主管提醒 g-131 / backlog 平铺 g-137 / 重命名 g-141 / 归档 g-110 / 删除 g-140 / 阻塞折叠 g-127 + g-117 交接工具；0.3.2 弃用不动）——由负责人执行：
      ~~`cd dsh-graph-host && pnpm publish --registry=https://registry.npmjs.org --no-git-checks`~~
      **⚠️ 此命令已作废**（发布目录是 `dist/`，见 §4 顶部的修正说明）；保留仅作历史记录。
      发布后核验 `curl -s https://registry.npmjs.org/dsh-graph | grep '"version"'` 为 0.5.1，`.../index.js` 含 graph_archive_goal/delete_goal/rename_goal
- [ ] 本地全新 profile `dsh plugin add` 验收通过（0.5.1 发布后）
- [ ] **PR awesome-dsh-plugin**：分支 `miuzel/awesome-dsh-plugin:add-dsh-graph` 已备好（YAML + 双 README 再生成 1838 条，diff 仅 +1 行/README）；
      仓库满 1 天（约 2026-08-23 01:57 +08:00，CI 自动检查）后 `gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin --fill` → 合并 → 三家商店带出
