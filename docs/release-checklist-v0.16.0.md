# dsh-graph v0.16.0 发布检查清单

> 流程沿用 v0.10.0 起确立的做法：主管完成准备并（经负责人授权后）合并 `main` + 打 annotated tag，
> 再由**负责人手动执行 `pnpm publish`**。
> 本文件同时承载 v0.16.0 的 Release Notes 与发布前/后检查项。
> 版本线说明：本次为 `v0.16.0`（由开发线期间的 `0.16.0-alpha` **去 alpha** 得到，沿用 `v0.15.0`
> 的做法），上一发布版本为 `v0.15.0`；版本号连续。

**负责人 2026-09-25 的四项决定**（本次发布的授权边界）：

1. **版本号 = `0.16.0`**（去 alpha）。
2. **git 授权**：授权主管执行「合并 `v0.16.0-test` → `main`（`--no-ff`）+ 创建 annotated tag
   `v0.16.0`」，**不推送**（推送另行授权）。
3. **Windows 真机门禁**：由负责人在**原生 Windows** 执行 `win-smoke-test.mjs --tarball`
   （发布门禁红线 1）；主管负责产出 tarball 并提供 Windows 可达路径 + sha256。
4. **g-355 发布前修**已派发并合入。

## 0. 宿主版本兼容性（本次发布强调项）

**✅ v0.16.0 支持 DeepSeek Harness `0.1.2-rc.1` ~ `0.1.7-rc.2`。**

本周期（`0.1.7` 线）的核心工作是 **g-351 的 DSH `0.1.7` 适配**：宿主在 `0.1.7` 线上同时改动了
**settings 服务**与**子代理目录**两处 API 形态。插件一律以**能力/形状探测**分流，**零版本号比较**
（由测试断言钉住），因此同一条代码路径在新旧宿主上都能工作。

验证方式（**「本周期实测」与「按契约兼容未复跑」已如实区分**）：

| 验证面 | 证据 |
|---|---|
| `0.1.7-rc.2` 宿主（**2026-09-25 复验**） | 用 v0.16.0 发布物 tarball 真实安装 + 启动 ⇒ **T1–T5 全绿 10/0/0**；逐包比对 `rc.1`→`rc.2`：`dsh-base` 零 JS 变化（仅 `cordis.patch.yml` 把 LLM provider 插件换成 `dsh-llm-deepseek-api-key` 并新增 account 条目）、`dsh-session-projection`（子代理目录层）与 `dsh-skill` 零代码变化、`dsh-llm` 的 `listProviders`/`listModels`/`resolveModelInfo` **签名逐字未变**（仅新增可选字段 `toolUpdate`）、客户端唯一用到的 `MarkdownText` 仍在（导出 268→279，仅移除我们未用的 `OnboardingSurface`） |
| `0.1.7-rc.1` 隔离实例（**本周期实测**） | settings 服务换代后走**能力探测分流**：新 API 存在 ⇒ 「profile 条目 Config → 设置表单」投影。实测 `sctx.settings.register is not a function` 降级告警**消失**；profile 全局默认（如 `subagentMode`）经 profile patch **真正生效**（`mode_source=global`）；`graph_*` 工具计数仍为 **44**、`/api/dsh-graph*` 端点注册齐全 |
| `0.1.7-rc.1` 子代理目录换代（**本周期实测**） | 容器由 `subagentsByParent` 改为 `projectionsBySession[sid].values.subagentCatalog`，entry 形状**去掉 `kind`** 并新增 `mode:'unknown'`；目录谓词改为形状探测，避免点「↗ 转到对话」**静默**打开父会话 |
| `0.1.6-alpha.2` 旧路径复跑（**本周期实测**） | 重跑 namespace 注册路径：`$DSH_HOME/settings.yaml` 与 profile 全局默认照常生效，**零退化** |
| `0.1.5-rc.2` 及更早（**按契约兼容，本周期未复跑**） | `0.1.2-alpha.x` ~ `0.1.5` 系列按工具与提示词契约向后兼容；README 已如实区分，未作过度声明 |
| 双宿主兼容的实现约束 | 全部走**特性/形状探测**（`typeof … .register === "function"`、entry 有/无 `kind`），可执行代码中**零版本号比较**——由测试断言强制 |
| 工具面 | `graph_*` 注册数 **44**（源码 `dsh-graph-host/index.js` 与构建产物 `dist/index.js` 各实测一次，均为 44） |

README 中的显式声明位置：`README.md`（顶部 + 安装小节）、`dsh-graph-host/README.md`（中文与英文
「环境要求 / Requirements」小节）。本版本 tarball 内 `README.md` 为 `dsh-graph-host/README.md` 的副本。

## 1. Release Notes（v0.16.0，26 个交付目标）

版本主题：**看板窄档与侧边栏可用性收敛 + DSH `0.1.7` 宿主适配 + 构建/评审/证据纪律工程化。**

### 1.1 看板 UI：窄档适配与侧边栏入口（g-330 / g-343 / g-352 / g-356）

**g-330 —— 看板以右侧栏页签形式接入（方案 B）**：看板新增右侧栏「看板」页签入口，与会话内页签
**共用同一份实现**（同一组件、同一套头部与窄档逻辑，零 host 门控）；会话内入口零回归，不做全局页面。
用户可见效果：在会话里打开右侧栏即可常驻看板面板，随时切回。
交付物：`c08c25e`。

**g-352 —— 看板窄宽度响应式适配（本版最大的一块 UI 工作）**：新增窄宽度派生**纯函数模块**
（`ResizeObserver` **实测**看板根容器宽度分档，取代 g-330 时代的纯 CSS 最小适配），并完成
B1/B2/B3 布局修正与两侧完全一致（拆 host 门控）；排期交互放开到任意非归档目标（两种语义分离、
无 backlog 选项、带附件拒绝给本地化失败态）；授权改写 g-330 判据 5 与 g-174 列模板契约，新增
g-352 契约套件并加 C2 判别力守卫；期间完成多轮负责人人工 gate 反馈收敛（1–9 项渲染级断言），
以及 ⋯ 工具弹层改纵向堆叠（修复横向排布致窄档工具条不可用）与角落水平内边距收到 2px
（en 下 `Create Version` 零截断）。
用户可见效果：看板在窄档（含右侧栏被拖窄）不再横向裁切，工具条自动折叠为「⋯ 工具」，
信息密度与可操作性同时保住。
交付物：`a30edd9` `c7d0f11` `b4344b0` `5c5cc61` `0fddd4c` `83bb041` `539d232` `ac7c177`
`0dbff2c` `7bbd7c2` `aaf890c` `b226ea3` `abeb264` `445c971` `a92a96d` `addf344` `8cb9d73` `07a5c7b`。

**g-356 —— 窄档单泳道阈值 `<360` 抬到 `<480`**：与工具条折叠档同界，消除 `<480` 档下
「确认 / 批量接受」列被横向裁掉的问题，并同步更新分档契约与 479 / 480 边界用例
（g-352 签名 fixture 随之重新冻结，正文逐字未变）。
用户可见效果：窄档下阶段列纵向堆叠的切换时点与实际可用性一致，不再出现「差一点点就裁掉关键列」。
交付物：`91cc034` `eeda778`。

**g-343 —— 弹窗层叠修复**：看板浮层 portal 到 `body`，composer 恢复原生 `z-index:7`
（修 g-216 降级 composer 的副作用）。
用户可见效果：弹窗打开时不再压过输入框，输入框可正常点击与输入。
交付物：`7b04b43`。

### 1.2 构建原子化（g-348）

**g-348 —— `build.sh` 由 `rm -rf dist` 改为原子发布**：所有产物先在仓库内暂存根
（`.dist-stage.XXXXXX/`，与 `dist/` 同文件系统）组装，全部步骤成功后才用**一次**
`mv -T --exchange`（`renameat2(RENAME_EXCHANGE)`）切换；失败则旧 `dist/` 逐字节不动并由 EXIT trap
清理暂存。`mv --exchange` 不可用时（需 GNU coreutils ≥ 9.6；macOS/BSD）退回两次 rename 并在
stderr 告警。同步把「实验性构建禁止在主树」的构建纪律文档化。
用户可见效果：**不再出现构建窗口期内插件资产读不到而中断在途会话**（这是已造成真实故障的缺陷，
曾击杀两个在途 worker）；并加结构性回归守卫（禁止对活动 `dist` 执行 `rm -rf`、3 并发读者 × 3 轮
构建断言 0 缺失、改回旧模式必红）。
交付物：`388e92b` `358ce40`。

### 1.3 DSH `0.1.7` 宿主适配（g-351）

**g-351 —— 适配 DSH `0.1.7-rc.1`（能力探测 + 双向兼容，不静默降级）**：三块改动——
① **settings 服务换代**：旧 `settings.register(namespace, schema)` 被移除，改为能力探测分流
（有 `register` 走旧 namespace 注册，否则回落 `describe` 表单投影）；
② **子代理目录形状换代**：容器改为 `projectionsBySession[sid].values.subagentCatalog`，
entry 去掉 `kind` 并新增 `mode:'unknown'`，谓词改为**形状探测**（有 `kind` 走旧判定、无 `kind` 按 `id`），
避免「↗ 转到对话」**静默打开父会话**这类最难发现的行为退化；
③ 补客户端子代理目录形状/能力探测的分支单测，并补 BLOCK-1 症状行为用例。
用户可见效果：在 `0.1.7` 宿主上设置表单与全局默认真正生效、无降级告警，子代理跳转落到正确会话；
在 `0.1.6` 上旧路径零退化。
交付物：`ebe9acf` `ea841a4` `8fd5fce` `71c5d2e`。

### 1.4 证据与评审纪律（g-295 / g-311 / g-312 / g-326）

**g-311 —— 分级评审机制与自动化快速通道（Fast-Track Review Policy）**：引入
`review.policy`（`auto` / `strict` / `none`）、四项机器门禁（测试 exit/fail、typecheck、
产品代码增删行数、判据 `✅已验` 全覆盖）与 `review.fast_track` 事件；`patch` / `chore` 派生目标
可走机器快速放行，任一门禁不满足即拒绝且零副作用。**边界如实标注**：`delivered` 的人工 gate
是指南约束而非引擎强制。
用户可见效果：小改动不再被迫排长队；放行有机器证据可追溯，而不是「主管说可以」。
交付物：`cdacc2f` `48ec85e` `29aa0f9`。

**g-312 —— 「以断言化证据替代长文倾倒」（Assertion-as-Evidence）**：把证据形式收敛为
**纯函数机器化定义** + 三路投递 + `dist` 新鲜度断言。
用户可见效果：复核者拿到的是可复跑的断言，不是难以验证的散文。
交付物：`cd8d93f`。

**g-326 —— 按改动性质分级测试力度**：纪律段成为分级规则**唯一真源**（去重删除独立分级区块），
并同步主管指南与派发提示词（zh/en）。
用户可见效果：文案类改动不再被要求凑单测，而逻辑改动仍必须覆盖被改分支。
交付物：`1acc1b7` `88f5399` `8987b32`。

**g-295 —— 精简常驻规范并统一协作与证据回报约定**：`graph_help` 改述现行
`scripts/dsh-test-web.sh`；`AGENTS.md` 恢复 Harness 演算示例；修正隔离测试实例数据域路径等
越界发现。
用户可见效果：常驻提示词更短，测试实例路径说明与实际脚本一致。
交付物：`16dbc4a` `86319eb`。

### 1.5 设置 / 记忆 / 归档 / 指南（14 个目标）

**g-313 —— 架构评估纳入指南**：白盒自研 vs 第三方黑盒重型库的 T1 阈值与成本矩阵。
用户可见效果：引入重型依赖前有量化的评估口径。`6433de3`

**g-327 —— 「定义/润色」发送给主管直发**：能力可投递时**直接投递**恰好一条 queue 消息给
supervisor session（本轮不写剪贴板）；不可投递时**完整退回**原复制契约（复制失败仍展示手动复制
预览，与 g-168 原契约逐字一致）；不做版本号分支。用户可见效果：点一下就到主管，不再需要手动粘贴。
`d18d3f4`

**g-329 —— `isActive` 识别 `result=cancelled`**：终态白名单补入 `cancelled`/`detached`，
修「已放弃 attempt 的 worktree 永久无法清理」。用户可见效果：放弃过的 attempt 不再卡住 worktree
清理。`34a392c`

**g-331 —— 英侧提示词 `join("\n")` 字面反斜杠**：修 collect / PM / review 三路英文提示词被拼成
一行；并把 zh 逐字符 golden 降级为不变量断言（解除散文冻结）。`c5a5db2` `949c397`

**g-333 —— 设置字段真正生效**：派发侧改消费 `prompt_overrides.subagent` 结构化三态
（`default` 回落遗留值 / `override` 注入 / `disable` 不回落），不再读遗留 `defaults.subagent_prompt`
单值键。用户可见效果：设置弹窗里改子代理提示词**真的会生效**（此前是「能配但不生效」）。
`194aa5a`

**g-335 —— 全仓类型门禁补齐**：`core/tests` 纳入 `tsconfig` 并补 `typecheck` 脚本
（此前整体 typecheck 存在大量既有错误、无全仓门禁）。`c735e69`

**g-336 —— 归档历史脚本**：19 个历史脚本移入 `scripts/archived/` 并更新全部活引用
（含 2 处指向已归档 `dev-dsh-instance.sh` 的陈旧注释路径）。`ebc8be7` `94ae977`

**g-339 —— 记忆单条上限放宽**：`on_demand` 记忆单条上限由旧值放宽到 **1000**（存储与注入同源；
`standing` 200 常驻铁律不动），超长条目注入时带可见截断标记。`6ff991f`

**g-340 —— 指南格式红线补机器断言**：禁 g-编号 / 禁「本次」/ 标题禁版本号，此前零守护。
`0301dfc`

**g-341 —— 设置弹窗未保存关闭确认文案**：改用场景化文案（不再丢失/含糊）。
`8f0161d`

**g-342 —— 设置弹窗补 `review.policy` 下拉**：四态（继承未配置 / auto / strict / none），
给分级评审策略一个可视化入口。`4161c44` `7c3d172`

**g-346 —— g-335 守护的两处收敛**：判据 4 的 `tsconfig` 扫描漏 `dsh-graph-host/`（可绕过）已堵；
判据 2 负向对照由字面片段定位改为 `anchors` 定位式，消除同一门禁行内重排的误红。
`a6c1f80` `9ed3d57` `c13bc88` `cb3e2b5`

**g-347 —— 帮助资产与引擎 schema 对齐**：补齐 8 个工具的参数面（含 `fast_track` /
`machine_report` 与 `unbind` 的 `legacy`），并新增资产守护断言。
用户可见效果：`graph_help` 描述与实际参数一致，agent 不再按过时说明调用。
`8352069`

**g-349 —— 帮助资产可选性收敛**：修 `state` 误标必填（既存偏差）+ 启用 `required` 断言 +
消除签名换行误红 + 计数正则解耦。`1013fda` `f7dfda3`

### 1.6 文档（g-354 / g-355）

**g-354 —— README 侧边栏用法 + 真实截图**：两份 README 补「侧边栏用法」小节，窄档口径改为
`<480` 单泳道，并入库一张真实看板截图。
用户可见效果：新用户能直接照 README 找到右侧栏入口并理解窄档行为。`17c9e2d`

**g-355 —— 修 `scripts/dsh-graph-mock-seed.mjs` 共享卡路径**：README 截图复现回路此前已断
（共享卡定位走错池），已修走项目共享池并加回归守卫 + 「改坏即红」负向对照。`c847916` `31266e2`

## 2. 发布前检查项

- [x] `dsh-graph-host/package.json` 版本 `0.16.0-alpha` → **`0.16.0`**
- [x] 看板标题栏版本徽章：`dsh-graph-host/lib/client/constants.js` 的 `PLUGIN_VERSION` → `0.16.0`，
      并 `bash scripts/build.sh` 重建 `dist/lib/client.js`
- [x] **版本号三处一致**（发布门禁红线 2）：`package.json` version / `PLUGIN_VERSION` /
      README 版本表述 = **`0.16.0`**（根 `README.md` + `dsh-graph-host/README.md` 中英各半）；
      `dist/package.json` 亦为 `0.16.0`
- [x] `README.md`：版本表述 → v0.16.0 + 顶部与安装小节显式声明
      **支持 `0.1.2-rc.1` ~ `0.1.7-rc.2`**（区分「本周期实测」与「按契约兼容未复跑」）
- [x] `dsh-graph-host/README.md`：中文与英文两处兼容性声明同步刷新为 v0.16.0 + `0.1.7` 支持
- [x] **平台声明如实（红线 1 例外条款）**：Windows 一行写成
      「**本次发布前由负责人在原生 Windows 执行门禁，结论见 §3**」，**未预先写 PASS**；
      并显式声明「若发布时未执行该门禁，则以『Windows 未验证』标注」
- [x] **工具表按实际注册数 44 校正**：
      `grep -oE 'name: "graph_[a-z_]+"' dsh-graph-host/index.js | sort -u | wc -l` = **44**；
      源码与 `dist/index.js` 各实测一次；两份 README 的工具表与分组逐项对齐 44（无缺项、无多项）
- [x] 全量测试 `node --test core/tests/*.test.ts` 全绿（**1347/1347**，fail 0，9 suites；
      `v0.15.0` tag 处实测基线为 **1152/1152**，本次周期净增 **195** 个用例）
- [x] `bash scripts/build.sh` 重建后 `node --check dist/lib/client.js` = **OK**；重建幂等
      （连续两次构建，`dist/` 逐文件 sha256 汇总不变 = `cb509039908170a5db712d0d027a38e59740a0a66e8d8135f90d94be800fbb34`）
- [x] **`dist/` 文件数 37 / `.tgz` 数 0**；`cd dist && pnpm pack --dry-run` 清单 **37 个文件**
      （与 `find dist -type f | wc -l` 一致），目标名为 `dsh-graph-0.16.0.tgz`，且 dry-run **不产生** `.tgz`
- [x] **T1 静态门禁本机预检 PASS**（`node scripts/win-smoke-test.mjs --static-only`，对源码目录
      `dsh-graph-host` 与构建产物 `dist/` 各跑一次，均 `通过1/失败0/告警0`、退出码 0）
- [x] g-352 签名 fixture 随 `PLUGIN_VERSION` 变更**重新冻结**：正文（`content-sha256`
      `0e6b7094…`）与冻结基线**逐字节相同**，仅更新 `source-sha256` / `source-commit` 两行 provenance
      （维护者工具需显式 ack，已按 g-356 同一做法执行）
- [ ] **Windows 真机门禁 T1–T5**（发布门禁红线 1）——**由负责人在原生 Windows 上执行，
      结论待回填本文件 §3**；⚠️ **在回填之前不得对外声明 Windows 已验证**，缺失时按红线 1 标注
      「**Windows 未验证**」
- [x] tarball 已产出并记录 sha256（发布门禁红线 3）：发布树 `.worktrees/release-v0.16.0`
      （detached @ tag `v0.16.0`，`git describe --tags` = `v0.16.0`）内 `bash scripts/build.sh` 后
      `pnpm pack` ⇒ `dsh-graph-0.16.0.tgz`，**487,120 B**，sha256 **`548afccd…`**（见 §3.2）
      —— **已重切两次**：g-358 / g-359 合入后一次；宿主 `0.1.7-rc.2` 复验并将声明上界抬到 rc.2 后又一次
      （npm README 属包内文件）；旧指纹 `75738dce…`、`3690b899…` **全部作废**
- [x] `v0.16.0-test` 合并 → `main`（`--no-ff`）+ annotated tag **`v0.16.0`**（**未推送** —— 推送由负责人另行授权）
      —— 经负责人 2026-09-25 明确授权执行。**重切记录**：因 g-358（窄档单泳道修复）与 g-359（macOS 门禁
      执行件）随后合入，`main` 已回退到 `origin/main`（`5d731cc`）并**重新做单次合并**，tag 删除后重打；
      最终 `main` 与 tag 指向**同一次合并提交**（核对：`git rev-parse v0.16.0^{commit}` 与
      `git log --merges -1 main` 应一致）。此前三轮的合并提交（`d4f6ec1`、`2ed393a` 及其后续一轮）均已被取代，以「tag 与 `main` 同点」为最终判据
- [ ] 负责人执行 `pnpm publish`（npm 官方 registry）；**发布目录是 `dist/`，不是 `dsh-graph-host/`**
      —— 完整命令序列见 [`docs/release-handbook.md`](release-handbook.md) §4
      （发布前务必确认 `dist/` 内**无 `.tgz`**、文件数 **37**）
      ⚠️ **前置必做**：先 `npm whoami --registry=https://registry.npmjs.org` 确认登录态；
      `v0.15.0` 周期实测该命令返回 `E401 Unauthorized`（token 已失效）⇒ **必须先 `npm login`**
- [ ] 发布后核验：全新隔离 profile 安装（`dsh plugin --profile <p> add dsh-graph`）→ 工具 / 看板 /
      skill 注册正常；`npm view dsh-graph version` = `0.16.0`

## 3. Windows 真机门禁与产物对账

**权威流程**见 [`docs/release-handbook.md`](release-handbook.md) §0–§7（尤其 §4 发布树标准流程）；
**跨版本发布红线**（Windows 真机 T1–T5 / 版本号三处一致 / tarball + sha256 对账）的权威定义在
仓库根 [`AGENTS.md`](../AGENTS.md) 的「发布门禁」段。本节只记录 **v0.16.0 的具体执行件与对账信息**。

**执行件**：`scripts/win-smoke-test.mjs`（单文件、纯 Node、无第三方依赖，可直接拷到 Windows 运行）。
建议随 tarball 一并拷贝一份到 Windows 侧产物目录，无需从仓库取。

```bat
:: 在原生 Windows 上（推荐：直接验现成 tarball，等于用户真实安装语义）
node win-smoke-test.mjs --tarball <path>\dsh-graph-0.16.0.tgz --dsh "npx -y @deepseek-ai/dsh@0.1.7-rc.2"
:: 建议显式指定宿主，使门禁结论与本版本 README 声明的上界（0.1.7-rc.2）一致
:: 或只跑秒级静态门禁：
node win-smoke-test.mjs --static-only <解包后的包目录>
```

检查分层：**T1 静态门禁**（无 POSIX 专有常量具名导入）→ **T2 安装**（全新隔离 `DSH_HOME` + 全新 profile）
→ **T3 核心运行时**（建目标 / 写标签 / 跨进程并发 CAS / validate）→ **T4 实例启动**（`dsh web` 插件树加载）
→ **T5 REST 冒烟**（dsh-graph 路由已注册、看板载荷可读）。退出码 0 = 全部通过。

> **T1/T2 平台敏感性最低，T4/T5 才是 Windows 真正要跑的。** Linux/WSL2 上取得的 PASS **不能替代**真机结论。
> 本机预检（WSL2）已跑 T1 = PASS（见 §2），**但这不构成 Windows 结论**。

### 3.1 真机门禁执行结果：**⏳ 待负责人回填**（2026-09-25 预置）

| 项 | 值 |
|---|---|
| 是否已执行 | **⏳ 待回填**（决策 3：由负责人在原生 Windows 执行） |
| 执行日期 | ⏳ 待回填 |
| 平台 | ⏳ 待回填（期望 `win32/x64`） |
| 宿主 DSH 版本 | ⏳ 待回填 |
| 被测产物 | ⏳ 待回填（§3.2 的 tarball） |
| 结果 | ⏳ 待回填（期望 `PASS 通过 N/失败 0/告警 0`，退出码 0） |
| 若未执行 | **必须写「Windows 未验证」并同步 README 平台声明（红线 1 例外条款）** |

**为什么本次 Windows 门禁预期风险较低（但仍必须实测）**：`v0.11.0` 已修复并真机复验过 Windows 的
两类致命问题（POSIX 专有锁常量、核心包重复声明）。自 `v0.11.0` 到 `v0.16.0`：

- `core/platform.ts`（平台判定与锁实现）**零改动**；
- 本周期 26 个交付目标的改动面集中在**看板前端渲染/分档**、**宿主 API 适配层**、
  **构建脚本原子化**与**文档/纪律**，**未触碰文件系统锁路径**；
- T1 静态门禁（正是当年 Windows 崩溃的预测性检查）在本机对源码目录与 `dist/` 均 PASS。

> 上述只是**风险判断**，不能代替实测。发布门禁红线 1 要求「Linux/WSL2 全绿不能替代 Windows 真机结论」。

### 3.2 tarball 与对账信息（跨机器传递唯一渠道；发布门禁红线 3）

| 项 | 值 |
|---|---|
| 文件名 | `dsh-graph-0.16.0.tgz`（发布树内 `pnpm pack` 实测产出名） |
| 建议相对路径 | `tmp/release-v0.16.0/dsh-graph-0.16.0.tgz` |
| 包内版本 | `0.16.0`（`dist/package.json` 实测；须与 tag 一致） |
| 包内文件数 | **37**（`pnpm pack --dry-run` 清单实测，与 `dist/` 实数逐项一致） |
| 体积 | **487,120 B**（发布树内 `pnpm pack` 实测，2026-09-25，**最终重切后**） |
| sha256 | **`548afccd4ca7f62b91ef09a650882b6aa93c3b82c3bf866406dff77ed8705224`**（同上） |
| Windows 侧可达路径（UNC） | `\\wsl.localhost\archlinux\home\miuzel\workspace\personal\dsh-graph\tmp\release-v0.16.0\` |
| 老式 UNC 别名 | `\\wsl$\archlinux\home\miuzel\workspace\personal\dsh-graph\tmp\release-v0.16.0\` |

> **为什么本清单不预先写死 sha256**：`v0.15.0` 周期出现过「首次打包的指纹在后续 README 调整后作废、
> 必须重新打包并声明旧指纹失效」的情况。发布物**必须**来自 tag 树的 `dist/`（手册 §4 步骤 3），
> 而 tag 尚未创建 ⇒ 此刻任何本地指纹都只是**候选**，写进来反而会变成过期指纹。
> 故 §3.2 的体积与 sha256 一律留**占位**，由主管在合并 + 打 tag 后按手册 §4 步骤 3 产出并回填。
>
> **✅ 已回填（2026-09-25）**：tag `v0.16.0` 于 **`d4f6ec1`** 创建后，主管在发布树
> `.worktrees/release-v0.16.0`（detached @ `v0.16.0`，`git describe --tags` = `v0.16.0`）内重建 `dist/`
> （`dist/package.json` = `0.16.0`；`dist/lib/client.js` md5 `d6cc82b5235f523b02979ce948fd9386`，
> 与主树同值 ⇒ 跨树构建一致），`pnpm pack` 得 §3.2 表内数值；该 tarball 与发布树 `dist/` 逐文件
> `diff -r` **文件清单 0 差异**（唯一差异 `package.json` 末尾换行 = pnpm 打包重写的已知行为）。
> 发布树保留至负责人完成 `pnpm publish` 后再按手册 §4 步骤 6 清理。
>
> **⚠️ 已重切（2026-09-25 同日）**：上表首次记录的是 g-358 之前的产物（`75738dce…`）。负责人报障
> 「只有独立目标、没有创建版本时窄窗单泳道不激活」⇒ 立 g-358 修复（standalone 视为常驻泳道）+
> g-359 补 macOS 门禁执行件；两者合入 `v0.16.0-test`（`ceda4a8`，全量 **1356/0**）后，`main` 回退
> `5d731cc` **重新做单次合并**，tag `v0.16.0` 删除重打（仍未推送；最终 tag 与 `main` 同点，按 §2 核对），
> 发布树重指后重建（`dist/lib/client.js` md5 `c8736a6a…`，与主树一致）并重新 `pnpm pack` ⇒ **上表数值为最终值**；
> 旧指纹 `75738dce…` 作废，任何基于旧包得出的门禁结论须以新包重跑。g-359 经独立复核**对发布物零影响**
> （其 worktree `dist/` 与重切前主树发布构建 `diff -r` = 0 差异）。
>
> **⚠️ 再重切一次（同日，宿主 `0.1.7-rc.2` 发布后）**：负责人在 `@deepseek-ai/dsh@0.1.7-rc.2` 发布后要求核查
> API 变更影响。结论：**无影响** —— 用**本文件 §3.2 的发布物 tarball** 在 rc.2 上真实安装 + 启动跑完 T1–T5
> 全绿 **10/0/0**；逐包静态比对确认子代理目录层与 `dsh-skill` 零代码变化、`llm` 服务三个方法签名逐字未变。
> 据此把 README（两份、中英）声明的支持上界由 `0.1.7-rc.1` 抬到 **`0.1.7-rc.2`**（npm 那份 `README.md` 属
> 发布包内文件 ⇒ 指纹随之变化）⇒ 发布物重打：上表数值为**最终值**，此前 `3690b899…`（及更早 `75738dce…`）
> **全部作废**；门禁结论须以最终包重跑（建议显式 `--dsh "npx -y @deepseek-ai/dsh@0.1.7-rc.2"` 使结论与声明一致）。
>
> **发布物对账顺序（v0.15.0 实证，务必遵守）**：
> 1. 先在**发布树**（`git worktree add --detach .worktrees/release-v0.16.0 v0.16.0`）内
>    `bash scripts/build.sh`，核 `dist/package.json` = `0.16.0`；
> 2. 树内 `pnpm pack` 得 tarball，记录体积 + sha256 ⇒ 回填本表；
> 3. 把该 tarball 交负责人在原生 Windows 跑 `win-smoke-test.mjs --tarball`，两机 sha256 逐字节一致
>    ⇒ 红线 3 满足；
> 4. 最终发布物以发布树 `pnpm publish` 产出的为准，**与已验 tarball 内容应逐字节一致**。

**Windows 侧取值建议**：UNC 路径下 `pnpm`/`npm` 的原生依赖安装较慢且部分工具对 UNC 支持不佳，
建议先把 `dsh-graph-0.16.0.tgz` 与 `win-smoke-test.mjs` 两个文件**复制到 Windows 本地盘**
（如 `C:\Users\<you>\Desktop\v0160\`）再执行；复制前后各算一次 sha256 与上表核对。

### 3.3 发布后对账判据（继承 v0.15.0 修正）

⚠️ **不要**用「线上包 sha256 == 本地 pack sha256」作为发布后对账判据：registry 会重写上传的
tarball（条目排序与 gzip 参数/头不同），`v0.15.0` 实测线上 414,753 B / `d72f8ea6…` vs 本地
414,102 B / `c102aca6…`——**差 651 B 但解包后 36/36 文件逐字节相同**。正确判据：

1. `npm view dsh-graph version` = 目标版本；
2. 拉线上 tarball 解包，与本地已验 tarball 解包结果做 **`diff -r`**（文件清单 + 逐文件字节）；
3. 需要指纹时用**内容指纹**（逐文件 sha256 列表）而非 tarball sha256。

> 红线 3「记录 sha256 对账」用于**跨机器传递**（本机 ↔ Windows）；对 **registry 侧**改用内容级判据。

### 3.4 macOS 门禁（v0.16.0 新增执行件；结论待回填）

Mac 侧执行件为 [`scripts/macos-smoke-test.mjs`](../scripts/macos-smoke-test.mjs)（纯 Node、零第三方依赖，
规避 macOS 自带 bash 3.2 的 bashism）：**转发**既有 `win-smoke-test.mjs` 的 T1–T5（不复制其逻辑），
另加四项 Mac 专检 —— **M1** 退化构建路径（无 `mv --exchange` ⇒ 两次 rename + 告警；macOS/BSD 与
coreutils < 9.6 的 Linux 用户都走这条，g-359 起有机器测试覆盖）、**M2** APFS 大小写不敏感探针
（只报告、不改核心行为）、**M3** 软链 root 边界（显式 `/tmp` root 被拒 / realpath 物理路径通过）、
**M4** 发布脚本 Linux-only 假设扫描。命令序列、每项预期输出与判读、回填表见
[`docs/macos-gate.md`](macos-gate.md)。

| 项 | 值 |
|---|---|
| 是否已执行 | **⏳ 待回填**（负责人本周期在 Mac 上执行） |
| 被测产物 | §3.2 同一 tarball（sha256 `548afccd…`）；宿主建议 `--dsh "npx -y @deepseek-ai/dsh@0.1.7-rc.2"` |
| 结果 | ⏳ 待回填（M1/M2/M4 期望 PASS；M3 在非 darwin 上必然 WARN，属如实降级口径） |
| 若未执行 | README 保持「macOS 门禁执行件已就绪 + 真机结论待回填」，**不得**声明 macOS 已验证 |

## 4. 发布操作

完整命令序列见 [`docs/release-handbook.md`](release-handbook.md) **§4「pnpm publish 单包
（发布树标准流程）」**——本节不复制正文，只列出**本次发布必须确认的三个易错点**：

1. **发布目录是 `dist/`，不是 `dsh-graph-host/`**。`dsh-graph-host/` 里既无 `core/` 也无
   `lib/client.js`（那是源码形态），照旧手册 publish 会发出 TS 源码并缺编译产物，宿主侧 loader 直接失败。
2. **发布前确认 `dist/` 内无 `.tgz`**：`find dist -name '*.tgz' | wc -l` == **0**；
   文件数 `find dist -type f | wc -l` == **37**。（试打产物会被一并发出去。）
3. **`npm login` 是前置**：`npm whoami --registry=https://registry.npmjs.org` 返回
   `E401 Unauthorized` 时，现有 token 已失效，**必须先重新登录**再 publish。

其余步骤（合并 `main` + 打 tag、建发布树、树内构建、`pnpm publish`、线上核验、清理发布树）
一律以手册 §4 为准。**主管只执行负责人明确授权的 git 动作，不推送。**

## 5. 已知问题（不阻断本次发布）

1. **Windows 真机门禁尚未执行**（截至本清单编写时点）：由负责人按决策 3 在原生 Windows 上执行
   `win-smoke-test.mjs --tarball`，结论回填 §3.1。**在回填之前，本项目不得对外声称 Windows 已验证**；
   若发布时仍未执行，README 与 §3.1 必须如实写「**Windows 未验证**」（发布门禁红线 1 例外条款）。
2. **macOS 真机门禁待复跑（执行件已就绪）**：最近一次真机复验仍为 **`v0.11.0`**；自 `v0.11.0` 以来
   `core/platform.ts` 与文件锁相关代码零改动。本版本已落地 **`scripts/macos-smoke-test.mjs`**（四项
   Mac 专检 M1–M4 + 转发既有 `win-smoke-test.mjs` 的 T1–T5），命令序列、预期输出、判读口径与回填表见
   [`docs/macos-gate.md`](macos-gate.md) 与本文 §3.4；**真机结论由负责人在 Mac 上跑出后回填**。
   README 已如实区分（「执行件已就绪 + 真机结论待回填」），未作预先声明。
   另注：M1（退化构建路径）需仓库检出与 `node_modules`（`pnpm install`）；只验产物时可加 `--skip-build`
   跳过 M1，仅跑 M2–M4 + 转发的 T1–T5。
3. **`0.1.5-rc.2` 及更早宿主未在本周期复跑**：`0.1.2-alpha.x` ~ `0.1.5` 系列按工具与提示词契约
   向后兼容，但**本周期实测只覆盖 `0.1.7-rc.1` 与 `0.1.6-alpha.2`**，README 已如实区分。
4. **macOS 符号链接工作区路径限制**（沿用旧版）：经**显式传入且含符号链接**的工作区路径
   （如位于 `/tmp`、`/var` 之下）会被拒绝并报 `graph root symlink is not allowed`；
   由 `process.cwd()` 推导的路径不受影响（Node 返回物理路径）。建议一律使用真实路径。
5. **`supervisor.automation` 等配置字段仍是「只声明不消费」的存储字段**：`scope_planning` /
   `integration_decision` / `rework` / `memory_promotion` / `skill_proposal` / `release` 六键以及
   `defaults.review` / `defaults.pk`，全仓穷举后**无任何派发/迁移/复核/发布路径读取**；
   设置弹窗已把它们标注为「主管自动化（高级 / 仅存储字段）」。g-333 已把真正影响行为的
   `prompt_overrides.subagent` 修成生效（三态），但**上述字段的消费实现不在本版本范围**。
6. **g-327 有一处证据不可复核（判据本身仍成立）**：判据 1 中执行者自述的**剪贴板哨兵**证据——
   脚本 `step6.mjs` 确实存在（含哨兵常量、权限授予、点击前后 `readText` 对比），但其 stdout
   **未落盘**且 3086 实例已停，故该**具体证据**不可复核。复核者用自建注入式测试**独立证明**了
   直发分支不调用 `copyText`（并有变异证明该断言有判别力），故判据 1 仍标 `✅已验`；
   如实登记此证据缺口。
7. **本周期多次出现「交付汇报未落盘 `attempts/att-XXX/delivery/`」的记账缺口**
   （g-295 / g-331 / g-333 / g-336 / g-340 等同类）：结论仅存在于会话与提交信息中，
   事后不可独立核验。不阻断发布，但属流程性遗留，已在各目标内如实留痕。
8. **g-329 的已知瑕疵（非阻断）**：① 自述「测试走真实 `abandonAttempt` 路径」只对测试 1 成立，
   测试 2/3 是手改 YAML 的判定侧映射测试（不覆盖写入侧）；② 新注释宣称的
   「评审/交付路径 `selected`/`merged`/`rejected`/`completed`/`failed`」在当前源码中查不到写入点
   （历史遗留白名单项）；③ 注释未点名 legacy 事件 `attempt.detached`（与 `attempt.unbound` 共用写入点）。
