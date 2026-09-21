# dsh-graph v0.15.0 发布检查清单

> 流程沿用 v0.10.0：主管完成准备并推送 `main` + tag 后，由**负责人手动执行 `pnpm publish`**。
> 本文件同时承载 v0.15.0 的 Release Notes 与发布前/后检查项。
> 版本线说明：**v0.13 / v0.14 按负责人习惯显式跳过（数字不吉利）**，故上一发布版本为 `v0.12.0`，
> 本次为 `v0.15.0`，非连续版本号是**有意为之**，不是漏版。

## 0. 宿主版本兼容性（本次发布强调项）

**✅ v0.15.0 支持 DeepSeek Harness `0.1.2-rc.1` ~ `0.1.6-alpha.2`；本次周期的重点是适配 `0.1.6` 宿主 API 变更，并保持对 `0.1.5-rc.2` 的向下兼容。**

> 上一发布版本（v0.12.0）README 曾声明「**暂不支持 `0.1.6-alpha.2`**（因宿主依赖构建审批拦截机制调整）」。
> **该表述已在本版本消除**：`0.1.6` 的适配工作由 g-321 / g-323 交付并在实机验证，声明已同步刷新为支持。

验证方式（均为实测，非声明）：

| 验证面 | 证据 |
|---|---|
| `0.1.6-alpha.2` 隔离 Web 实例 | 测试实例（3082，插件经 `link:` 加载本地 `dist/`）+ 会话导航/focus、实时会话区、批量接受通知、并发槽位提示实机验证 |
| `0.1.6` 看板实时会话区 | 修复前 `VERDICT: DEFECTS PRESENT (D1=true D2=true)` → 修复后 `VERDICT: DEFECTS GONE (D1=false D2=false)`；正向证据为真实 `tok 1.57M ｜ ctx 6%` / `tok 486.3k ｜ ctx 3% ｜ deepseek-flash` 已渲染（非「把面板清空」式假修复）|
| `0.1.5-rc.2` 向下兼容 | 真实 `0.1.5-rc.2` 运行时实机：`VERDICT: 0.1.5-rc.2 COMPATIBLE`，被动 binding 回退确实借到真实 binding（正向证据 `tok 1.12M ｜ ctx 5% ｜ deepseek-flash`）；0.1.5 控制器内 `retain(` 出现次数为 0，即新路径在旧宿主上不生效、旧路径不退化 |
| 兼容范围 | `0.1.2-alpha.x` ~ `0.1.5` 系列按工具与提示词契约向后兼容，但**未在本次周期复跑**，README 已如实区分 |
| 双向兼容的实现约束 | 全部走**特性探测**（`typeof sessions.using/retain === "function"` 能力探测），代码中**零版本号比较**——由测试断言强制（`doesNotMatch /0\.1\.[0-9]/`） |

README 中的显式声明位置：`README.md`（顶部 + 安装小节）、`dsh-graph-host/README.md`（中文与英文
「环境要求」小节）。本版本 tarball 内 `README.md` 为 `dsh-graph-host/README.md` 的副本。

## 1. Release Notes（v0.15.0，4 个交付目标）

版本主题：**适配 DeepSeek Harness `0.1.6` 宿主 API 变更，并恢复/修复三处用户可见缺陷。**

### 适配 DSH `0.1.6` 宿主 API 变更（g-321）

`0.1.5-rc.2` → `0.1.6-alpha.2` 之间宿主内部服务与前端交互 API 发生实质变化，导致以下链路受损：

- **会话导航/focus 职责迁移**：`0.1.6` 移除了 `ClientSessions.open` / `openSubagent`，导航改由
  `uiWorkspace.openSession` 承担。插件统一走 `openSessionTarget(target)`（`uiWorkspace.openSession`
  优先，回退 0.1.5 的 `sessions.*`），子代理聚焦、点击「转到对话」、「交给产品经理」与用户反馈
  派发链路全部恢复。
- **看板实时会话区（根因）**：`0.1.6-alpha.2` 起 `ClientSessions.binding(id)` **只借用已存在的保留代际**
  （`this.scopes.get(id)?.binding`），被动调用恒 `undefined`，于是实时区显示
  「⚠️ 会话未接入（不在会话列表）」、模型行显示「模型目录不可用」。修复为按新宿主的
  **retain 生命周期**先 `retain` 再借取 binding，并**严格配平 release 不泄漏代际**；
  在无 `retain` 的 `0.1.5` 上自动回退被动 `binding ?? get`。判据 6 守住 g-224 既有取舍：
  实时显示开关关闭时仍不订阅输出流、不打开会话窗口（retain 只为取得 binding 与投影）。
- **并发槽位上限**：`0.1.6` 为 `subagents.startContinuable` 引入硬性并发槽位
  （`maxActiveSubagents` 默认 8），容量耗尽抛 `ACTIVATION_LIMIT_REACHED`，冷恢复失败报
  `subagent/delivery-unavailable`。新增 `subagentSpawnErrorText` 把这些码翻译为可操作中文提示，
  **其余错误原样透传**（保住 `LLM quota exceeded` 等既有可追溯性）。

交付物：`3173157`（+ 合并 `c43b2df`）。

### 批量接受主管通知在 `0.1.6` 下恢复（g-323）

看板批量接受后向主管会话派发通知的路径同样踩中 `binding(id)` 语义变更。修复把通知派发改为
**能力探测分流**（`using` → 0.1.6 路径；`retain` + `finally release` → 兜底；否则 0.1.5 旧行为），
并把探测逻辑抽成共享 helper `promptSessionQueue`，**单卡接受与批量接受同形路径一并补齐**
（原始缺陷只修了批量路径）。契约约束：恰好投递一条 `"queue"` 消息、从不抛异常、返回布尔值。

交付物：`077cd1e` + `170b19c`（+ 合并 `6db59c1`）。

### 看板刷新按钮重置自动刷新倒计时（g-324）

点击「刷新」确实重新拉取了数据，但倒计时仍沿旧终点递减。根因：倒计时重置依赖
`generated_at` 变化，而 `/api/dsh-graph` 的 **304 复用路径**下 `generated_at` 逐字节不变，
重置条件不成立，于是读数一直走到旧的零点。修复为显式信号驱动（`signalRefreshFlowDone()`），
不再把「载荷是否变化」当作「刷新是否发生」的判据。

交付物：`0751d07`。

### 「定义/润色」复制模板改写为自述式主管指令（g-325）

目标卡「📝 定义/润色」弹窗的「发送给主管（复制请求）」生成的剪贴板文本原本只有结构化字段，
负责人粘贴进主管会话后看起来像「发给产品经理子代理的内部任务」。模板改写为自述式指令，明确
**接收者（主管 Agent）/ 动作 / 边界**四件事，并显式声明「这条消息由负责人从看板复制发送，
不是产品经理的任务提示，也不要求主管扮演产品经理」「本次仅处理目标定义/润色，不执行代码，
不推进状态或版本」。

**硬性约束（已守住）**：PM 自动派发路径（`askPm` / `formatPmPrompt` / `/api/dsh-graph/define-polish`）
**仍保持完全独立的 PM prompt，不共用这段文本**——diff 为 2 文件 +11/−2，`core/ops.ts`、
`index.js`、`i18n.js` 均零改动。

交付物：`8ce711d`。

## 2. 发布前检查项

- [x] `dsh-graph-host/package.json` 版本 `0.15.0-alpha` → **`0.15.0`**
- [x] 看板标题栏版本徽章：`dsh-graph-host/lib/client/constants.js` 的 `PLUGIN_VERSION` → `0.15.0`，
      并 `bash scripts/build.sh` 重建 `dist/lib/client.js`
- [x] **版本号三处一致**（发布门禁红线 2）：`package.json` version / `PLUGIN_VERSION` / README 版本表述
      = `0.15.0`；`dist/package.json` 与 tarball 内 `package/package.json` 亦为 `0.15.0`
- [x] `README.md`：版本表述 → v0.15.0 + 顶部与安装小节显式声明 **支持 `0.1.2-rc.1` ~ `0.1.6-alpha.2`**；
      **消除「暂不支持 0.1.6-alpha.2」表述**；工具表按实际注册数（44）校正并补齐
      `graph_convert_card_to_shared/owned`、`graph_abandon_attempt`、`graph_get_settings/update_settings`
- [x] `dsh-graph-host/README.md`：中文与英文两处兼容性声明同步刷新为 v0.15.0 + `0.1.6` 支持
- [x] 全量测试 `node --test core/tests/*.test.ts` 全绿（**1152/1152**；`v0.12.0` tag 处实测基线为
      **1097/1097**，本次周期净增 55 个用例）
- [x] `bash scripts/build.sh` 重建后 `node --check dist/lib/client.js` = OK；重建幂等（重复构建 sha256 不变）
- [x] 工作区干净、`main` 只读未被触碰（全部改动先落 `v0.15.0-test`）
- [x] **T1 静态门禁本机预检 PASS**（`node scripts/win-smoke-test.mjs --static-only`，对源码目录与 `dist/` 各跑一次；
      已扫描发布包内 JS，无 POSIX 专有常量具名导入）
- [x] **Windows 真机门禁 T1–T5 = PASS ✅**（发布门禁红线 1；2026-09-21 在**原生 Windows** 上跑
      `win-smoke-test.mjs --tarball`，**通过 10 项 / 失败 0 项 / 告警 0 项**，退出码 0；完整报告见 §3）
- [x] tarball 已产出并记录 sha256，且**两机 sha256 逐字节一致**（发布门禁红线 3；见 §3）
- [ ] `v0.15.0-test` 合并 → `main`，推送 `main`；**annotated tag `v0.15.0` 由负责人创建/推送**
      （负责人已明确「不移 tag」：主管不新建、不迁移、不推送 tag）
- [ ] 负责人执行 `pnpm publish`（npm 官方 registry；发布树必须自 tag 独立 worktree 建，见 `docs/release-handbook.md` §4）
- [ ] 发布后核验：全新隔离 profile 安装（`dsh plugin --profile <p> add dsh-graph`）→ 工具 / 看板 /
      skill 注册正常；`npm view dsh-graph version` = `0.15.0`

## 3. Windows 真机门禁与产物对账

**权威流程**见 [`docs/release-handbook.md`](release-handbook.md) §0–§7（尤其 §4 发布树标准流程）；
**跨版本发布红线**（Windows 真机 T1–T5 / 版本号三处一致 / tarball + sha256 对账）的权威定义在
仓库根 [`AGENTS.md`](../AGENTS.md) 的「发布门禁」段。本节只记录 **v0.15.0 的具体执行件与对账信息**。

**执行件**：`scripts/win-smoke-test.mjs`（单文件、纯 Node、无第三方依赖，可直接拷到 Windows 运行）。
本次随 tarball 一并拷贝了一份 `win-smoke-test.mjs` 到产物目录，无需从仓库取。

```bat
:: 在原生 Windows 上（推荐：直接验现成 tarball，等于用户真实安装语义）
node win-smoke-test.mjs --tarball <path>\dsh-graph-0.15.0.tgz
:: 或只跑秒级静态门禁：
node win-smoke-test.mjs --static-only <解包后的包目录>
```

检查分层：**T1 静态门禁**（无 POSIX 专有常量具名导入）→ **T2 安装**（全新隔离 `DSH_HOME` + 全新 profile）
→ **T3 核心运行时**（建目标 / 写标签 / 跨进程并发 CAS / validate）→ **T4 实例启动**（`dsh web` 插件树加载）
→ **T5 REST 冒烟**（dsh-graph 路由已注册、看板载荷可读）。退出码 0 = 全部通过。

> **T1/T2 平台敏感性最低，T4/T5 才是 Windows 真正要跑的。** Linux/WSL2 上取得的 PASS **不能替代**真机结论。

**tarball 与对账信息**（跨机器传递唯一渠道；发布门禁红线 3）：

| 项 | 值 |
|---|---|
| 文件名 | `dsh-graph-0.15.0.tgz` |
| 相对路径 | `tmp/release-v0.15.0/dsh-graph-0.15.0.tgz` |
| 包内版本 | `0.15.0`（与 tag 一致） |
| 体积 | 414,102 B |
| sha256 | `c102aca650baebaaa32578202751b69b116f6ce5035908781a250b37c54db212` |
| Windows 侧可达路径（UNC） | `\\wsl.localhost\archlinux\home\miuzel\workspace\personal\dsh-graph\tmp\release-v0.15.0\` |
| 老式 UNC 别名 | `\\wsl$\archlinux\home\miuzel\workspace\personal\dsh-graph\tmp\release-v0.15.0\` |

> `tmp/` 已被 `.gitignore` 忽略，tarball 不入库；它是**候选发布物**，最终发布物以 tag 独立发布树
> 经 `pnpm publish` 产出的为准（内容应与之逐字节一致——发布前用 §4 的 dry-run 对账）。
>
> **已做的一致性核对**：tarball 解包后与当前 `dist/` 逐文件 `cmp`，**35/36 文件逐字节一致**；
> 唯一差异 `package.json` 仅差**末尾换行**（pnpm 重写时未保留尾换行），`JSON.parse` 后语义完全一致。
> 即 tarball 确实是当前 `dist/` 的快照，不含陈旧内容。
>
> **Windows 侧取值建议**：UNC 路径下 `pnpm`/`npm` 的原生依赖安装较慢且部分工具对 UNC 支持不佳，
> 建议先把 `dsh-graph-0.15.0.tgz` 与 `win-smoke-test.mjs` 两个文件**复制到 Windows 本地盘**
> （如 `C:\Users\<you>\Desktop\v0150\`）再执行；复制前后各算一次 sha256 与上表核对。

**为什么本次 Windows 门禁预期风险较低（但仍必须实测）**：`v0.11.0` 已修复并真机复验过
Windows 的两类致命问题（POSIX 专有锁常量、核心包重复声明）。自 `v0.11.0` 到 `v0.15.0`：

- `core/platform.ts`（平台判定与锁实现）**零改动**；
- 全量 `core/` diff 中**无** `O_DIRECTORY` / `O_NOFOLLOW` / `process.platform` / `isWindows` / `ino` 相关改动；
- 本次周期的 4 个交付目标（g-321/323/324/325）改动面全在宿主 API 适配层与前端交互，**未触碰文件系统路径**；
- T1 静态门禁（正是当年 Windows 崩溃的预测性检查）在本机对源码目录与 `dist/` 均 PASS。

> 上述只是**风险判断**，不能代替实测。发布门禁红线 1 要求「Linux/WSL2 全绿不能替代 Windows 真机结论」，
> 故已按下节在原生 Windows 上实测。

### 3.1 真机门禁执行结果：**PASS ✅**（2026-09-21）

**执行环境（原生 Windows，非 WSL）**

| 项 | 值 |
|---|---|
| 平台 | `win32/x64`（`node.exe` v24.13.0，Windows PowerShell，Windows `%TEMP%`） |
| 宿主 DSH | `@deepseek-ai/dsh@0.1.6-alpha.2`（`npx -y @deepseek-ai/dsh@0.1.6-alpha.2`） |
| 被测产物 | `D:\workspace\play\dsh-graph-0.15.0.tgz` |
| 隔离 `DSH_HOME` | `%TEMP%\dsh-graph-win-smoke-1789984688253`（用后自动清理） |
| 隔离 profile / 端口 | `win-smoke` / `3089`（不触碰负责人正在使用的 3100 实例） |

**脚本回传报告（原文照录）**

```
dsh-graph Windows 冒烟 | 平台=win32/x64 node=v24.13.0
安装来源=dsh-graph-0.15.0.tgz (实际版本 0.15.0)
产物指纹=sha256:c102aca650baebaaa32578202751b69b116f6ce5035908781a250b37c54db212  414102 B
结果=PASS 通过10/失败0/告警0
```

**逐层结果**

| 层 | 检查 | 结果 |
|---|---|---|
| T1 | 无 POSIX 专有常量的 ESM 具名导入（扫描 14 个文件） | PASS |
| T2 | 初始化 web 模板 profile | PASS |
| T2 | 安装 tarball（实际版本 0.15.0） | PASS |
| T2 | 插件自带依赖 `yaml` 随安装落地 | PASS |
| T3 | 建目标 / 判据 / 标签锁 / CAS / validate — 6 步全通过，`validate` 返回空 | PASS |
| T3 | **跨进程并发 CAS（4 抢 1）— 恰好 1 个成功、3 个冲突被拒** | PASS |
| T4 | 实例启动 / 插件树加载（`dsh web` 就绪） | PASS |
| T5 | dsh-graph 路由已注册 | PASS |
| T5 | 看板载荷可读 | PASS |
| T5 | Web UI 可达 | PASS |

> **T3 的并发 CAS 是本次最有价值的一条**：它走的正是 v0.11.0 之前会在 Windows 上崩掉的
> 文件锁路径（`O_DIRECTORY`/`O_NOFOLLOW` 一类 POSIX 专有常量）。4 抢 1 得到严格串行化结果，
> 证明锁语义在 NTFS 上成立，而不只是"能启动"。

### 3.2 三段独立对账（跨机器产物传递，红线 3）

1. **两机 tarball sha256 逐字节一致**：WSL 侧产物 `c102aca6…`（414,102 B）== 负责人拷贝到
   Windows 的 `D:\workspace\play\dsh-graph-0.15.0.tgz`（414,102 B）。红线 3 满足。
2. **已安装包 == tarball**：Windows 侧 `C:\Users\mingxuan\.dsh\profiles\web\node_modules\dsh-graph`
   与 tarball 解包结果**文件清单 36/36 一致、内容 36/36 逐字节一致**（`cmp` 全等，0 差异）。
   即运行中的插件就是本次构建的产物，不存在"装错版本"。
3. **运行中实例的产物指纹**：3100 实例（`npx @deepseek-ai/dsh@0.1.6-alpha.2 web --port 3100`）
   由宿主提供的组合插件产物中 `PLUGIN_VERSION = "0.15.0"`；`/api/dsh-graph` 返回 200，
   载荷 `_diagnostics.graphRoot = D:\workspace\play\.dsh-graph`（Windows 原生路径）。

### 3.3 负责人侧真实使用（额外证据，非脚本构造）

负责人已在同一 Windows 实例上完整跑通一条**真实**目标生命周期（`g-001`，落在 `D:\workspace\play\.dsh-graph`），
事件流可查：`project.initialized` → `supervisor.claimed` → `goal.created` → `goal.amended` →
`criteria.confirmed` → `planning→ready→in_progress→review` → `attempt.started`/`attempt.bound`
（**真实派发了子代理** `child_id=848bc07c…`）→ 子代理 `attempt.status_reported` ×3 →
`goal.comment_added`（主管复核）→ 产出 `evidence/g-001/smoke-report.md`（17,438 B）。

这比脚本更强：它证明 **prompt 注入、子代理派发与回收、worktree 探测（在非 git 目录下正确回退
`worktree=false`）、评论/记忆落盘** 在 Windows 上整链可用。

**tarball 版本说明**：产物目录中的 tarball 已在本会话内**重新打包过一次**——首次打包（413,706 B /
`1a275aba…`）之后又调整了 README 的「平台范围」措辞使其与门禁红线一致，故重新 `pnpm pack`
得到上表的最终件（414,102 B / `c102aca6…`）。**请以上表为准**，旧指纹已作废。

## 4. 发布后检查项

- [ ] 主 3080 profile 切回已发布版本（`bash scripts/dev-dsh-instance.sh main-published`）
- [ ] **README 平台声明小改（负责人已决定「发布后再小改」）**：把 `dsh-graph-host/README.md`（中/英各一处）
      与根 `README.md` 的平台范围从「最近一次三平台真机复验：`v0.11.0`」更新为含 `v0.15.0` 的表述。
      **本次发布前故意不动**：`README.md` 在 tarball 内，改它会改变已验证产物的 sha256，导致
      「已验证产物 ≠ 待发布产物」。⚠️ 注意副作用：**npm 包页面的 README 冻结于发布时的那一份**，
      发布后再改只影响 GitHub 仓库首页；若要 npm 页面也同步，需一个 patch 版本重新发布。
- [ ] 开下一条开发线（`v0.16.0-test`，版本置 `0.16.0-alpha`）；
      **注意 v0.16.0 泳道已有排期目标**：g-326（按改动性质分级测试力度）、g-327（定义/润色请求
      直接投递主管会话）、g-311/g-312/g-313（评审与架构审查机制）
- [ ] 按安全规则清理已合入的 attempt worktree / 分支（g-321-att-02/03、g-323-att-01/02 等）
- [ ] 看板：v0.15.0 标记为 released；`dsh-graph-videos` README 补发布链接（如本次有录制）
- [x] **回填本文件 §2 的 Windows 真机门禁勾选与 §3 的对账表** — 已于 2026-09-21 发布前完成（T1–T5 PASS 10/0/0）

> **tag 归属（负责人要求「不移 tag」）**：`git tag` 的新建/移动**一律由负责人执行**，
> 主管不创建也不迁移 tag。手册 §4 的发布树流程以 `vX.Y.Z` tag 为起点，故 **publish 前需先由负责人
> 打好 tag**；主管侧只准备并核对待发布产物（sha256 `c102aca6…`）。

## 5. 已知问题（不阻断本次发布）

1. **`0.1.5-rc.2` 之外的旧宿主未复跑**：`0.1.2-alpha.x` ~ `0.1.5` 系列按契约向后兼容但本次未实测，
   README 已如实区分「本次周期验证」与「按契约兼容」，未作过度声明。
2. **g-323 的 GUI 端到端未人工观测**：批量接受后「主管会话是否真的多出一条 queue 消息」在自动化
   测试中已覆盖（恰好一条 `session.prompt(..., "queue")` + 探测分流断言 + 负向对照），但**未在真机
   主管会话上端到端目视确认**。该点已在 g-323 目标内如实留痕，负责人于批量交付复核时确认接受。
3. **`0.1.6` 并发槽位为宿主硬限**：默认 8 个活跃 continuable 子代理。插件只做友好提示，
   不改宿主上限；用户撞到上限时需等待结算或先解绑不再需要的子代理。
4. **`ERR_PNPM_IGNORED_BUILDS` 属环境问题**：pnpm 对 `node-pty`、`koffi` 等原生依赖的构建审批拦截，
   在 `0.1.5-rc.2` 与 `0.1.6-alpha.2` 上用全新 `DSH_HOME` 均可复现，**不是** `0.1.6` 引入的插件兼容问题，
   也不是本次发布范围的修复对象。
