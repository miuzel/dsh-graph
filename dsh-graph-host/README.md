# dsh-graph

[中文](#中文) | [English](#english)

<p align="center">
  <img src="https://raw.githubusercontent.com/miuzel/dsh-graph/main/docs/banner.webp" alt="dsh-graph —— Agent 工作的目标化管理" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-graph"><img src="https://img.shields.io/npm/v/dsh-graph?style=flat-square&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-graph"><img src="https://img.shields.io/npm/dm/dsh-graph?style=flat-square&label=downloads&color=cb3837" alt="npm downloads"></a>
  <a href="https://raw.githubusercontent.com/miuzel/dsh-graph/main/dsh-graph-host/package.json"><img src="https://img.shields.io/node/v/dsh-graph?style=flat-square" alt="node engine"></a>
  <a href="https://awesome-dsh-plugin.com"><img src="https://img.shields.io/badge/awesome--dsh--plugin-listed-2f6feb?style=flat-square" alt="awesome-dsh-plugin listed"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="license MIT"></a>
  <a href="https://raw.githubusercontent.com/miuzel/dsh-graph/main/dsh-graph-host/package.json"><img src="https://img.shields.io/badge/DSH-%3E%3D0.2.2--rc.3%20%3C0.2.3--0-2f6feb?style=flat-square" alt="DSH host range"></a>
</p>

---

## 中文

### 概述

**dsh-graph** 是面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的目标看板插件。它将大模型智能体（Agent）的工作流组织为基于图的目标管理（Graph-based Goal Management）。

本包是 DSH 插件本体（npm 包名 `dsh-graph`），单独安装即可获得完整的 DSH 看板能力；v1.0.0 起 CLI / 本地服务 / 技能包 / MCP 亦可按需单独安装（详见 [多包分发设计](https://github.com/miuzel/dsh-graph/blob/main/docs/multi-package-design.md)）。本包同时集成两大核心能力：

- **Host 端**：向 DSH Agent 提供覆盖目标全生命周期的 53 个 `graph_*` 工具，并暴露 `/api/dsh-graph*` REST API（支持看板投影、目标详情查询与写操作）；
- **Client 端**：无缝内嵌于 DSH Web 控制台（`conversation.view` 槽位）的浏览器二维泳道看板，提供直观的可视化交互与实时追踪。

数据以本地纯文本与事件流形式存储于工作区的 `.dsh-graph/` 目录，Git 友好、天然支持协同对账与审计追踪。

---

### 安装方式

在 DSH 环境中运行以下命令即可安装：

```sh
dsh plugin --profile <profile-name> add dsh-graph
```

**当前版本**：v1.0.0。**环境要求**：Node.js ≥ 22（包内预编译 core 运行时）。宿主提供的核心包（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-settings`）以 `peerDependencies` + `peerDependenciesMeta.optional`（DSH 生态惯例）声明，由 DSH 宿主环境提供，安装不产生 peer 告警；`yaml` 为插件自带运行依赖（声明在 `dependencies` 中），避免产生重复的核心包实例。

**宿主兼容范围**：`engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh-settings"]` 同步声明 `>=0.2.2-rc.3 <0.2.3-0`（自 v0.25.0 起；更早版本声明的是 `>=0.1.5-rc.2 <0.2.3-0`）。本包要求 Node ≥22，而 `0.2.2` 线宿主自身要求 Node ≥24.9.0。已核实的 `0.2.1-rc.5`、`0.2.2-alpha.3` 和 `0.2.2-rc.1`（以及本版验证的 `0.2.2-rc.3`）中，宿主 `unmetRequirements` 在 `engines.dsh` 存在时**单独据此判定并立即返回**、忽略 peer（出处：`@deepseek-ai/dsh-app-boot/lib/index.js`，`unmetRequirements`：0.2.0-rc.2:287-299；0.2.1-rc.5:279-290；0.2.2-alpha.3 与 0.2.2-rc.1:1096-1105；0.2.2-rc.3:1102-1117）。本包始终声明 `engines.dsh`，因此在上述已核实的新实现中 peer 分支不会执行（`0.2.0-rc.2` 及更早则只读 peer——该实现属历史轮次，已不在本版支持范围）；两处仍须同步以保持声明一致并供 dsh-market 等市场读取。**低于下限的诊断**：在 `0.2.2-rc.3` 上 `dsh plugin add` 会打印 `pluginCompatibilityWarning`（点名 `engines.dsh` 与运行版本）并拒绝启用该插件行；宿主被强制加载时插件自身也会 fail-closed 报错（例如 `subagents 服务缺少派发 API（需 startActivation，DSH ≥ 0.2.2-rc.3…）`）。**实测通过的宿主**：`0.2.2-rc.3`（v0.25.0 轮次，安装/启动/派发/子代理生命周期/看板）。`0.2.2-rc.1` / `rc.2` **已不在支持范围**（其嵌套 activation spec 分支已删除，v0.24.x 轮次的 rc.1 结论不再适用）。⚠️ 更早版本（`0.1.x`、`0.2.0`、`0.2.1`）**已不在支持范围**：它们的兼容分支已按 v0.25.0 的清理目标删除，升级说明见 [`docs/host-compat-v0.25.0.md`](../docs/host-compat-v0.25.0.md)。g-507 引入的 **HTTP 鉴权入口**只在 `0.2.1-rc.2`（历史轮次）实测（见下文「HTTP 鉴权」一节），**不得**据本段推断其它版本上的鉴权结论。

**平台状态**：

| 平台 | 本版状态 |
|------|----------|
| Linux / WSL2 | ✅ 已实测通过（本版全量测试 fail 0；已在 DSH `0.2.2-rc.5` 上完成浏览器端到端实机验证） |
| 原生 Windows | ⏳ **本版未验证**：`v1.0.0` 尚未在原生 Windows 上执行真机门禁（最近一次历史记录为 2026-11-02 `v0.23.0` / 宿主 `0.2.1-rc.5`，见 [platform-gate §7.13 回填表](https://github.com/miuzel/dsh-graph/blob/main/docs/platform-gate.md)） |
| macOS | ⏳ **本版未验证**：`v1.0.0` **未**在原生 macOS 上执行真机门禁 ⇒ **不得读出「已通过」**；结论同样以 [platform-gate §7 回填表](https://github.com/miuzel/dsh-graph/blob/main/docs/platform-gate.md)（不随包发布）为准。历史记录见 [platform-gate §7.4 / §7.7](https://github.com/miuzel/dsh-graph/blob/main/docs/platform-gate.md)，只覆盖各自版本的产品代码。 |

三平台使用同一安装包。**已知限制**：① macOS 默认文件系统 APFS 大小写不敏感 —— 仅大小写不同的目标编号 / 版本泳道会落到**同一实体**，请勿只用大小写区分；② macOS 上若工作区路径**经显式传入且含符号链接**（如位于 `/tmp`、`/var` 之下），会被拒绝并报 `graph root symlink is not allowed`；由 `process.cwd()` 推导的路径不受影响。

**最新亮点（v1.0.0）**

- **五包拆分与命令行工具 `goal-graph`**：DSH 专属插件保留 `dsh-graph`，跨宿主产物按职责拆分为 4 个独立包（`goal-graph-cli` / `goal-graph-service` / `goal-graph-skills` / `goal-graph-mcp`），提供独立 CLI（`info` / `status` / `goal` / `version` / `sync` / `claim` / `submit`）与三宿主（Claude Code / Codex / OpenCode）插件定义。
- **独立本地服务（`goal-graph serve`）与按需写模式**：单进程提供 Web 看板、Web API 与 localhost MCP 端点（CSPRNG 令牌、0600 凭据文件）；默认只读（仅暴露只读查询），显式 `serve --allow-write` 开启执行类写能力（固定 actor `mcp:local-service` 并留审计），人工裁决与派发始终 fail-closed。
- **核心资料目录名可按项目自定义**：默认仍为 `.dsh-graph`（零迁移），支持通过插件 `config.root`、CLI `--graph-dir-name` 与 `serve init --graph-dir-name` 指定工作区内规整相对路径。
- **大看板 `status` 提速约 2 倍**：事件流增量索引（大小 + inode + 头部指纹三重校验）使大看板中位耗时减半，异常一律回退全量校验。
- **宿主支持面收窄与测试分层**：`engines.dsh` 与 peer 统一收窄为 `>=0.2.2-rc.3 <0.2.3-0`；测试按 `shakedown ⊊ integration ⊊ full ⊊ everything` 四层治理，发布门禁仍为无参全量。

完整变更史见 [CHANGELOG](https://github.com/miuzel/dsh-graph/blob/main/CHANGELOG.md)。已发布版本支持通过 npm 与 dsh-market 生态分发。

---

### 升级残留自检与清理

**现象**（外部报告）：升级宿主后 Web GUI 冷启动报
`web boot: N entry did not activate` / `<插件名>: failed` —— 插件的 host 半边（`graph_*` 工具）正常、热加载也正常，只有浏览器半边不激活。

**成因**：`dsh.client.inject` **不是「名录」，而是加载顺序边**。浏览器端 loader
（`@deepseek-ai/dsh-client-modules/lib/client.js`）只对 inject 中**已存在于客户端清单**的包名做前置加载，
名字不在清单里就**静默跳过**。而 `@deepseek-ai/dsh-client-runtime` 自 dsh 0.2.x 起**不再随宿主分发**
（在 dsh 0.1.5-rc.2 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-alpha.2 的安装树里均无此包），但它的包清单**仍声明 `dsh.client`**：
升级过程中若这个旧条目/旧副本残留在 profile 里，它会**重新变成一条客户端清单行**；该行的加载失败会被级联成
`client-modules: "<插件>" not loaded because dependency "…" failed`，把**任何仍声明它的插件**一起拖死。
干净安装没有这一行，所以不复现。**dsh-graph 已删除该声明**（即使残留仍在，本插件也不再是它的消费者）。

**首选动作：把 dsh-graph 升级到含本修复的版本即可，残留无需处理。** 含本修复的版本已不再声明该死引用 ⇒ 无论 profile 里是否还残留旧副本，本插件都不再是它的消费者，也不会被它拖死。下面的自检只是「想确认现状」时的只读排查；清理残留是**可选**的进阶动作。

**自检（全部只读；下述命令已在隔离实例 dsh 0.2.0-rc.2 / 0.1.7-rc.2 上实测）**：

把 `<DSH_HOME>` 换成你的 DSH home：web 版默认是 `~/.dsh`（也可由 `DSH_HOME` 环境变量指定）；**桌面版是另一套路径**，请以该壳的配置/日志里显示的 profile 目录为准。

```sh
# ① 本插件的声明 —— 期望 3 项，且不含 dsh-client-runtime
node -e 'console.log(JSON.stringify(require(process.argv[1]).dsh.client.inject))' \
  "<DSH_HOME>/profiles/web/node_modules/dsh-graph/package.json"

# ② profile 清单里是否还列着它 —— 期望输出 0
#    （注意：grep -c 在计数为 0 时退出码是 1，看打印出的数字即可，不要看退出码）
grep -c dsh-client-runtime "<DSH_HOME>/profiles/web/package.json"

# ③ 整个 DSH home 内是否还有名为 dsh-client-runtime 的目录 —— 期望无输出
find "<DSH_HOME>" -type d -name dsh-client-runtime 2>/dev/null

# ④（可选，仅在 Web 版且实例正在运行时）客户端清单里是否还有该行 —— 期望无输出
#    「dsh web」启动行会打印带 token 的 URL，把它原样填进 <URL>
curl -sL -b "" "<URL>" | grep -o '"@deepseek-ai/dsh-client-runtime"' | head -1
```

隔离实例实测结果（dsh 0.2.0-rc.2）：

- ① → `["@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-ui-primitives","@deepseek-ai/dsh-client-ui-sidebar-right"]`
- ② → `0`
- ③ → 无输出
- ④ → 无输出；`curl` 返回 200、35125 字节（同一命令对清单里**确实存在**的行名如 `@deepseek-ai/dsh-client-ui-settings` 能打印出来）
- 命令有效性反证（都不是恒真空跑）：在一份确实含该名字的清单文件上 ② 打印 `1`；在 profile 里放入名为 `dsh-client-runtime` 的目录后 ③ **确实打印出该路径**（随即移除）

**清理（可选，先备份）**：仅当你确实想清干净、且 ②非 0 或 ③有输出时：先**备份** profile，再删除 ③ 打印出的残留目录（并在 ② 命中的清单里去掉对应条目），然后**重启宿主** —— 客户端包元数据在激活期缓存，增删客户端插件必须重启才生效。**风险提示**：在 live profile 上直接删目录/改清单有改坏环境的风险；**更稳妥的替代**是重装同版本 dsh-graph 或新建一个干净 profile。自行清理前务必留备份，异常时用备份复原。

**未验证**：无桌面壳环境可用（`@deepseek-ai/dsh-desktop` 在 npm 为 E404）。上述现象与成因链引用外部报告与宿主源码，
**不声称已复现桌面壳症状**。

---

### 核心特性

- **四阶段生命周期状态机**：
  引擎严格约束状态迁移：`draft → planning → collecting → ready → in_progress → review → delivered`（任何阶段均可标记进入 `blocked` 阻塞状态）。
- **判据先于执行（Criteria Before Execution）**：
  在目标派发执行前必须登记明确的质量验收判据，最终评审严格依照逐条判据核验交付物，杜绝模糊交付。
- **结构化上下文卡片**：
  支持文本（Text）、文件（File）、图片（Image）、数据（Data）等多种上下文类型。经历 `empty → collecting → filled → reviewed` 闭环生命周期，为执行子代理提供精确的上下文种子。
- **二维泳道看板**：
  横向按生命周期阶段划分列，纵向按排期划分版本（Version）、暂存池（Backlog）与独立目标（Standalone）泳道；支持拖拽排期。
- **目标间关系标记**：
  目标之间可标记「取代 / 调整 / 补充 / 相关」四类关系（也可解除），关系只记在目标文件（frontmatter）这一处真源；看板卡片显示关系徽标，目标弹窗在「目标描述」下方直接列出关系清单（含跨版本与已归档标注）。
- **流畅跨会话交接（Handoff & Supervisor Claim）**：
  支持生成包含看板投影、长期记忆与关键环境事实的 `HANDOFF.md`，换会话后新 Supervisor 可幂等认领上下文并快速接管。
- **现代交互与双主题适配**：
  完整适配深色与浅色双套主题（自动跟随 DSH 全局主题变量）；外部数据更新时支持微光动画提醒（支持系统的 `prefers-reduced-motion` 无障碍降级）；弹窗拖拽防误关。

---

### 设计哲学（面向首次接触本插件的用户）

想先弄懂「dsh-graph 为什么这样组织开发」——目标生命周期与状态机、判据门禁与人工 gate、派发与隔离三件套、
attempt 与结果面、独立复核与留痕真源、版本泳道与发布红线、记忆分级、事件先行——请读
[设计哲学（中文）](https://github.com/miuzel/dsh-graph/blob/main/docs/design-philosophy.zh.md)：
它逐条给出代码真源引用，并附 archify 交互式图（内联静态预览 + 可交互 HTML）；图只画今天已实现的
状态流转与角色分工，图内不含文件、函数或内部产物名，1.0 路线见文档 §13。

---

### Agent 工具速查表

dsh-graph 为 Agent 提供了完善的工具链（共 53 个 `graph_*` 工具），按功能划分为以下分类：

| 分类 | 工具名称 | 核心说明 |
|------|----------|----------|
| **目标生命周期** | `graph_create_goal` | 创建目标（默认放入 Backlog，可指定版本） |
| | `graph_rename_goal` | 重命名目标标题 |
| | `graph_set_description` | 设置/更新目标描述正文（Markdown） |
| | `graph_set_directive` | 为下一次 Attempt 注入补充指令与边界要求 |
| | `graph_set_goal_type` | 设置目标类型（feature / bug / task / improvement / patch / chore） |
| | `graph_set_goal_tags` | 设置目标标签列表（最多 20 个，乐观并发） |
| | `graph_set_goal_budget` | 设置/清空目标预计任务预算（整数秒 30–86400；空=继承项目/全局关照阈值） |
| | `graph_amend_goal` | 记录对目标的修订补充，可自动同步至描述 |
| | `graph_transition` | 推进目标状态机迁移（进入 blocked 需附原因） |
| | `graph_postpone_goal` | 暂缓目标，移回 Backlog 并置为 draft |
| | `graph_archive_goal` | 归档已完成或已废弃的目标 |
| | `graph_unarchive_goal` | 从归档中恢复目标 |
| | `graph_delete_goal` | 安全删除已归档的目标 |
| | `graph_clean_worktree` | 清理已验证的 worktree（用户确认后执行） |
| | `graph_list_worktrees` | 查询 Git worktree 清理候选（只读，不自动删除） |
| **目标关系** | `graph_set_relation` | 标记/解除目标间关系（取代/调整/补充/相关，可增可删；幂等，拒绝替代环） |
| **质量判据** | `graph_set_criteria` | 登记目标验收判据（严格在执行前设定） |
| **上下文卡片** | `graph_add_card` | 创建上下文卡片占位（text / file / image / data） |
| | `graph_bind_collect_card` | 绑定收集子代理，卡片状态转为 collecting |
| | `graph_fill_card` | 填充卡片内容并生成看板简要摘要 |
| | `graph_review_card` | 复核卡片内容（filled → reviewed） |
| | `graph_delete_card` | 删除未在收集中的卡片 |
| | `graph_convert_card_to_shared` | 将自有卡转换为共享卡（放入共享池） |
| | `graph_convert_card_to_owned` | 将共享卡收回为自有卡（独占） |
| | `graph_attach_shared_card` | 把共享池既有共享卡挂载到目标（复用已收集上下文，仅 owner/主管） |
| | `graph_detach_shared_card` | 解除目标对共享卡的引用（卡仍留池；collecting 拒绝） |
| | `graph_list_shared_cards` | 只读列出共享池共享卡（id/title/status/refs） |
| **附件管理** | `graph_store_attachment` | 存储文件附件到目标 |
| | `graph_delete_attachment` | 删除目标附件 |
| **排期管理** | `graph_move_goal` | 在 Backlog、独立目标与版本之间移动排期 |
| **执行与返工** | `graph_start_attempt` | 派发执行 Attempt，启动并绑定可续轮子代理 |
| | `graph_record_attempt_handoff`| 记录前序 Attempt 的返工约束与排查基线 |
| | `graph_unbind_goal_child` | 安全解绑目标执行子代理 |
| | `graph_abandon_attempt` | 放弃陈旧或失联的 Attempt |
| | `graph_start_review` | 为既有执行 Attempt 派发独立评审子代理（只读；不新建 attempt、不覆盖作者结果；结论独立落盘） |
| **配置管理** | `graph_get_settings` | 查询当前 workspace 项目配置及合法枚举元信息 |
| | `graph_update_settings` | 结构化更新当前 workspace 项目配置（支持 patch） |
| **记忆管理** | `graph_memory_add` | 写入按需/常驻记忆条目 |
| | `graph_memory_recall` | 按关键词检索记忆 |
| | `graph_memory_remove` | 删除指定记忆条目 |
| | `graph_memory_replace` | 替换已有记忆条目内容 |
| **状态汇报** | `graph_report_status` | 汇报当前 Attempt 进度（看板卡片实时显示） |
| | `graph_report_supervisor_status` | Supervisor 汇报全局工作状态（顶部状态栏动画） |
| | `graph_care_outcome` | 子代理关照巡检回传（仅绑定主管；一次性、事件先行、有证据才计数） |
| **评审裁决** | `graph_resolve_accept` | 裁决交付验收（verdict: accept / object） |
| **协作与交接** | `graph_add_comment` | 向目标追加可追溯的讨论与反馈历史 |
| | `graph_write_results` | 人工写入 attempt 完成摘要（source=manual + 写入者标注；无子代理的轻量改动兜底） |
| | `graph_refresh_results` | 重写 `results.md`：零 LLM 兜底拼装，或采用专用摘要子代理/人工产出的 `content`（旧版自动归档；支持批量 goals[]） |
| | `graph_handoff` | 生成跨会话交接文档 `HANDOFF.md` |
| | `graph_claim_supervisor` | 新会话接管 Supervisor 并更新会话元数据 |
| | `graph_help` | 输出插件功能说明与 53 个工具速查清单 |
| **数据与校验** | `graph_validate` | 执行全量不变式检查（状态、依赖环、卡片引用） |
| | `graph_rebuild` | 从事件流完全重建目标状态并与元数据对账 |

---

### 浏览器看板说明

内嵌于 DSH Web 界面：

- **二维泳道布局**：清晰展现多个版本的推进节奏，支持灵活查看不同泳道和阶段；
- **分级评审策略支持**：通过 `graph_get_settings` / `graph_update_settings` 配置项目实际的 `review.regions` / `review.contract_paths` / `review.non_product_prefixes`，未登记区域安全升级 strict，空契约默认 M1 不触发；
- **实时流式更新**：卡片与顶部状态栏直观反映 Agent 汇报的最新执行状态；外部文件变更触发动画闪烁；
- **丰富弹窗与抽屉交互**：点击卡片可展开目标详情弹窗，查看质量判据、上下文卡片与 Attempt 历史。

---

### 侧边栏用法

右侧栏的「**看板**」与会话页的「**看板**」页签是**同一份实现**——同一个看板组件、同一套头部与窄档逻辑，**两侧完全一致**（零 host 门控），任选其一即可。

- **入口**：在会话里打开右侧栏 → 点「看板」磁贴；打开的看板面板会成为右侧栏顶部的一个页签常驻，随时切回。
- **`⋯ 工具`**：刷新 / 标签筛选 / 记忆 / 项目知识库（共享条目）/ 看板设置 / 已归档。工具条按**头部实测宽度装不下**自动折叠为这一项（不是写死的窗口断点）。
- **`[🏷️]` 版本管理**：角落的方形图标按钮（可访问名称为「🏷️ 版本管理」），点开版本管理抽屉；紧邻其右是**同一行等高**的 `创建版本`。
- **版本选择器**：位于泳道行 `[+]`（新建目标）**左侧**，切换当前显示的泳道（具体版本 / Backlog / 独立目标）。
- **窄档行为**（分档依据是**看板根容器实测宽度**——即看板组件自身元素的 `clientWidth`，**不是窗口宽度、也不是浏览器视口宽度**）：
  - **`≥ 480px`（宽档）**：多泳道横向并排，各版本 / Backlog / 独立目标可同时查看；
  - **`< 480px`（单泳道档）**：阶段列由横向并排改为**纵向堆叠**，泳道内容由版本选择器决定（**具体版本 / Backlog / 独立目标三选一**；**工作区一个版本都没有时，默认落点就是「独立目标」**，选择器当前项显示「独立目标」）；该档**没有版本折叠开关**（收起来等于空板），并同时**把工具条强制折叠为「⋯ 工具」**、**隐藏 DEBUG 行**。
  - **怎么把看板放进 `< 480px`**：宿主页签的宽度由**页签布局模式**决定，不是拖出来的——实测（1600px 视口）单页签 **719px**、页签上的 `分栏` 之后每页签 **359px**（该档随窗口宽度变化）、`全屏` **799px**。所以**默认单页签宽度（719px）落在宽档**，此时不会出现单泳道；需要单泳道档时用页签上的 **`分栏`**，或把窗口收窄到看板面板实测宽度 <480px。进入后一眼可验：六个阶段块**纵向堆叠**，且泳道标题右侧出现版本选择器（当前项为具体版本 / Backlog / 独立目标）。
  - **宽档残留（实测）**：宽档网格的最小宽度实测约 **956px**，所以看板面板实测宽度在这之下时（例如默认单页签 **719px**），宽档网格**仍会横向滚动**、把「确认 / 批量接受」列推到可视区外；真正消除横向滚动的是单泳道档（<480px）。
  - **版本选择器只在单泳道档渲染**：宽档下整个看板**没有**版本选择器（该元素不渲染）。因此宽档里能看到的「全部版本」只可能来自**打开的下拉选项列表**，而不是当前选中项；单泳道档未显式选择任何视图时，当前项是「独立目标」而**不是**「全部版本」。

效果截图见仓库 [screenshot/sidebar-kanban.png](https://github.com/miuzel/dsh-graph/blob/main/screenshot/sidebar-kanban.png)（虚构演示数据 nebula-notes，右侧栏宽度落在 `< 480px` 单泳道档）；本 npm 包不包含仓库的 `screenshot/` 目录，故此处只给出仓库路径。

---

### HTTP 鉴权（Web 看板的 REST 入口）

本插件在 Web 宿主里提供一组 `/api/dsh-graph/**` REST 入口（浏览器看板与脚本都用它）。从 g-507 起，这些入口的安全模型是**单一受保护入口**：

- **一个入口，不是 63 个**：插件只向宿主 `webServer` 注册**一条** `kind:"prefix"`、`path:"/api/dsh-graph"` 的路由；原有的 63 条业务路由不再是宿主的独立路由，只在插件内部按 `exact` / 两条资产 `prefix`（`/diagram`、`/help/asset`）分发。
- **先鉴权，后业务**：入口每请求先调用宿主的**公开** `connection.admit(req)`（保留 `this` 绑定），再判定调用方是否为 owner。认证之前**不读请求体、不解析目标路径、不初始化工作区、不触碰任何文件与派发**。
- **拒绝面（固定口径）**：
  | 情形 | 状态码 |
  |---|---|
  | 匿名 / 凭证无效（宿主 401） | `401` |
  | 信任边界拒绝（宿主 403：Host / Origin / cross-site） | `403` |
  | 凭证有效但**不是 owner** | `403`（`not-owner`） |
  | 宿主未提供 `connection` 服务、未提供 `admit`、`admit` 抛错、或返回不可判定的结构 | `503`（**fail-closed**，不带任何内部细节） |
  | 认证通过但路径不存在 / 方法不符 | `404` / `405`（认证之后才返回） |
- **能力依赖**：判定完全依赖宿主公开能力 `connection.admit`。宿主没提供它时，HTTP 入口**一律 503 fail-closed**（不会退化成匿名放行）；该情形**不影响** Agent 工具面（`graph_*` 工具不经过 HTTP 入口）。
- **尾斜杠与 query**：`/api/dsh-graph` 与 `/api/dsh-graph/` 不是同一路径（后者认证后 404）；两条资产 `prefix` 的 `prefix/` 会进入业务并由业务给 400（非法文件名）；query 不参与匹配。
- **实测范围（如实）**：本节的鉴权行为只在 **DSH `0.2.1-rc.2`**（历史轮次）上实测（真实宿主 `BrowserAuth` + 真实 Token 交换 + 真实 HTTP）。该结论**早于**本版收窄宿主范围：`0.1.x`、`0.2.0`、`0.2.1` 各版本已不在支持范围（见上「宿主兼容范围」一节），当前声明范围 `>=0.2.2-rc.3` 上的鉴权**未逐版验证**；若某宿主缺少公开 `admit`，按上表 HTTP 入口会 503，这一点同样**未经逐版核实**，因此不能把声明范围读成「当前 Web 鉴权结论」。


### Profile 全局设置（子代理默认值）

子代理默认 provider / model、推理档位、执行模式、提示词语言与补充提示词是 **profile 级全局默认** —— 写入当前 DSH profile、**跨 workspace 生效**，且 workspace 的 `project.yaml` 明确配置与单次派发参数都更优先。

同一个设置页在**两个入口**都能打开，两处是**同一份实现**、读写同一份 profile 配置：

- **设置 → 看板设置**：左侧设置导航里的独立设置页；
- **右侧栏 → 插件 → dsh-graph**：组合包详情页里的配置区（按包名 `dsh-graph` 绑定）。

宿主未提供某个位面时（精简 profile / 旧宿主），对应席位自动不出现，看板与工具不受影响；两处都取不到设置服务时，页面**如实提示**当前 profile 未暴露设置服务，而不是假装已启用。配置文件落在 profile 的设置文档里（0.2.0 系宿主为 profile 的 `cordis.patch.yml` 中 `dsh-graph-host` 条目，0.1.6 系宿主为 `$DSH_HOME/settings.yaml` 的 `dsh-graph` 命名空间）。

---

### 关照唤醒正文：首次全量、后续精简（`supervisor.care_wake_compact`）

长任务关照的每次唤醒都会带上「检查清单 + 纪律 + 三值结论定义 + 回传要求」。项目级开关
`supervisor.care_wake_compact` 控制**纪律与检查清单的投递方式**（默认 `null` = **开启**）：

- **开启（默认）**：同一主管会话的**第一份**唤醒内联完整检查清单与纪律（正文与旧行为逐字一致）；
  **第二份及以后**只保留兜底纪律（「计时到期不是卡死证据」「证据不足 ⇒ unknown」）+ 指向
  `prompts/care-discipline.{zh,en}.md` 的资产路径，用来节省多目标巡检时的重复注入。
- **关闭（`false`）**：每份唤醒都内联完整纪律 —— 逐字回退到旧行为，可一键退回。

不变的部分（两态都一样）：`inspection=<id>`、每个目标的 goal/attempt/child、
`outcome=progress|no-progress|unknown`、三值定义、evidence 与「必须用 `graph_care_outcome` 回传」的
要求**永远内联**（回传校验是 fail-closed 的）；计数/锁/升级规则一律不变。纪律资产缺失或不可读时
**fail-open 回退内联全文**（`care.inspection` 事件里以 `wake_discipline_degraded=true` 如实标注），
绝不因少一个 `.md` 中断巡检。「已发过全量纪律」按**主管会话**判定并持久化到关照状态快照——
换主管会话或宿主重启后的新会话都重新按首次处理。界面入口：设置 → **高级** → 子代理长任务关照。

---

### 数据存储说明

插件数据保存在当前工作区下的 `.dsh-graph/` 目录：

- **自动初始化**：首次在工作区运行工具时自动生成数据骨架，不包含多余 Demo 数据；
- **Git 友好**：所有数据由纯文本 YAML/Markdown 与只追加（append-only）的 `events.jsonl` 组成；
- **事件流对账**：`events.jsonl` 记录每一次状态流转与操作，是唯一事实来源，可通过 `graph_rebuild` 随时对账；
- **多 Worktree 适配**：Git Linked Worktrees 自动解析归一到主工作树的同一 `.dsh-graph/` 根目录。

---

## English

### Overview

**dsh-graph** is a goal-oriented kanban plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness), bringing Graph-based Goal Management into Agent workflows.

This package is the standalone DSH plugin (`dsh-graph`) providing complete kanban capabilities out-of-the-box; since v1.0.0, companion packages for CLI / local service / skills / MCP are also available separately (see [multi-package design](https://github.com/miuzel/dsh-graph/blob/main/docs/multi-package-design.md)). It provides both halves:

- **Host Side**: Exposes 53 `graph_*` tools to DSH Agents covering the entire goal lifecycle, along with `/api/dsh-graph*` REST endpoints for board projections, goal details, and mutations;
- **Client Side**: A browser 2D swimlane kanban board integrated into DSH Web (the `conversation.view` slot) for intuitive visualization and real-time tracking.

All data is stored locally as human-readable files and an append-only event log under `.dsh-graph/`, making it Git-friendly, easily auditable, and collaborative.

---

### Installation

Install the plugin using the DSH CLI:

```sh
dsh plugin --profile <profile-name> add dsh-graph
```

**Current version**: v1.0.0. **Requirements**: Node.js ≥ 22 (includes the precompiled core runtime). Core packages provided by the DSH host (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-settings`) are declared under `peerDependencies` with `peerDependenciesMeta.optional` (standard DSH ecosystem convention) and provided by the host runtime without peer warnings; `yaml` is retained in `dependencies` as a plugin-specific runtime dependency, preventing duplicate core package instances.

**Host compatibility range**: `engines.dsh` and `peerDependencies["@deepseek-ai/dsh-settings"]` both declare `>=0.2.2-rc.3 <0.2.3-0` (since v0.25.0; earlier releases declared `>=0.1.5-rc.2 <0.2.3-0`). This package requires Node ≥22; the `0.2.2` line host itself requires Node ≥24.9.0. In the verified `0.2.1-rc.5`, `0.2.2-alpha.3` and `0.2.2-rc.1` implementations (plus `0.2.2-rc.3`, verified in this release), host `unmetRequirements` uses `engines.dsh` alone and returns immediately when present, ignoring peers (source: `@deepseek-ai/dsh-app-boot/lib/index.js`, `unmetRequirements`, 0.2.0-rc.2:287-299; 0.2.1-rc.5:279-290; 0.2.2-alpha.3 and 0.2.2-rc.1:1096-1105; 0.2.2-rc.3:1102-1117). This package always declares `engines.dsh`, so in those verified newer implementations the peer branch is never reached (`0.2.0-rc.2` and earlier read only peers — that implementation is a historical round and is outside this release's supported range); keep both declarations synchronized for consistency and for markets such as dsh-market. **Diagnostics below the floor**: on hosts below the floor, `dsh plugin add` prints a `pluginCompatibilityWarning` naming `engines.dsh` and the running version and refuses to enable the plugin row; if the host is forced to load it, the plugin itself fails closed (e.g. `subagents service lacks dispatch API (needs startActivation, DSH >= 0.2.2-rc.3...)`). **Hosts verified**: `0.2.2-rc.3` (v0.25.0 round: install/boot/dispatch/subagent lifecycle/kanban). `0.2.2-rc.1` / `rc.2` are **no longer supported** (their nested activation-spec branch was removed; the v0.24.x rc.1 verdict no longer applies). Older hosts (`0.1.x`, `0.2.0`, `0.2.1`) are **no longer supported**; their compatibility branches were removed in v0.25.0 — see [`docs/host-compat-v0.25.0.md`](../docs/host-compat-v0.25.0.md). The **HTTP authentication entry** introduced by g-507 was measured on `0.2.1-rc.2` only (historical round, see "HTTP authentication" below) and must **not** be inferred for other versions from this paragraph.

**Platform status**:

| Platform | Status for this release |
|----------|-------------------------|
| Linux / WSL2 | ✅ Verified on-device (this release's full test suite: 0 failures; end-to-end browser verification completed on DSH `0.2.2-rc.5`) |
| Native Windows | ⏳ **Not verified for this release**: `v1.0.0` has not yet run the on-device Windows gate (most recent historical record: 2026-11-02 `v0.23.0` on host `0.2.1-rc.5`, see [platform-gate §7.13](https://github.com/miuzel/dsh-graph/blob/main/docs/platform-gate.md)) |
| macOS | ⏳ **Not verified for this release**: `v1.0.0` has **not** run the on-device gate on native macOS ⇒ **must not be read as "passed"**; the verdict likewise comes from the [platform-gate §7 backfill table](https://github.com/miuzel/dsh-graph/blob/main/docs/platform-gate.md) (not shipped in the package). Earlier records are in [platform-gate §7.4 / §7.7](https://github.com/miuzel/dsh-graph/blob/main/docs/platform-gate.md) and cover each of those versions' product code only. |

All three platforms share the same package. **Known limitations**: (1) APFS, the macOS default, is case-insensitive — entries that differ only by case resolve to the **same entity**, so do not rely on case alone to distinguish goal ids or version lanes; (2) on macOS a workspace path that is **explicitly supplied and contains a symlink** (e.g. under `/tmp` or `/var`) is rejected with `graph root symlink is not allowed`; paths derived from `process.cwd()` are unaffected.

**What's new (v1.0.0)**

- **Five-Package Split & Standalone CLI (`goal-graph`)**: Keeps `dsh-graph` for the DSH plugin while splitting cross-host artifacts into 4 independent packages (`goal-graph-cli` / `goal-graph-service` / `goal-graph-skills` / `goal-graph-mcp`), with a zero-daemon CLI (`info` / `status` / `goal` / `version` / `sync` / `claim` / `submit`) and host plugin definitions for Claude Code, Codex, and OpenCode.
- **Standalone Local Service (`goal-graph serve`) & Opt-In Write Mode**: Single-process Web board, Web API, and localhost MCP endpoint secured with CSPRNG tokens (0600 credential files); read-only by default (11 tools), with explicit `serve --allow-write` enabling execution-class write tools (38 tools, fixed actor `mcp:local-service`, audited), while human gates and dispatch remain fail-closed.
- **Per-Project Custom Graph Directory Name**: Defaults to `.dsh-graph` (zero migration); supports custom normalized relative paths via plugin `config.root`, CLI `--graph-dir-name`, and `serve init --graph-dir-name`.
- **~2x Faster `status` on Large Boards**: Incremental event-stream indexing (validated by size + inode + header fingerprint) halves median latency on large boards, falling back to full verification on any mismatch.
- **Narrowed Host Range & Tiered Testing**: `engines.dsh` and peer aligned to `>=0.2.2-rc.3 <0.2.3-0`; tests organized into `shakedown ⊊ integration ⊊ full ⊊ everything` while the release gate remains the full no-arg run.

See the [CHANGELOG](https://github.com/miuzel/dsh-graph/blob/main/CHANGELOG.md) for the full history. Official releases are distributed via npm and the dsh-market ecosystem.

---

### Upgrade-residue self-check and cleanup

**Symptom** (externally reported):
after upgrading the host, a Web GUI cold start reports `web boot: N entry did not activate` / `<plugin>: failed` — the plugin's
host half (`graph_*` tools) works and hot reload works, but its browser half never activates.

**Cause**: `dsh.client.inject` is **not a directory listing, it is a load-order edge**. The browser-side loader
(`@deepseek-ai/dsh-client-modules/lib/client.js`) preloads only those inject names that **already exist in the client
manifest**, and silently skips the rest. `@deepseek-ai/dsh-client-runtime` is **no longer shipped with the host** since dsh 0.2.x
(absent from the install trees of dsh 0.1.5-rc.2 / 0.1.7-rc.2 / 0.2.0-rc.2 / 0.2.1-alpha.2), yet its package manifest **still declares `dsh.client`**.
If an old entry/copy of it survives an upgrade in your profile, it **becomes a client manifest row again**; that row's load failure
cascades into `client-modules: "<plugin>" not loaded because dependency "…" failed`, dragging down **every plugin that still declares it**.
A clean install has no such row, which is why it does not reproduce. **dsh-graph has dropped that declaration** — even if the
residue is still present, this plugin is no longer one of its consumers.

**Preferred action: just upgrade dsh-graph to a build that contains this fix — the residue needs no handling.** A fixed build no longer
declares the dead name, so whether or not an old copy survives in your profile, this plugin is no longer one of its consumers and can no
longer be dragged down by it. The self-check below is only a read-only way to inspect the current state; cleaning up the residue is an
**optional** advanced step.

**Self-check (read-only; every command below was measured on isolated instances of dsh 0.2.0-rc.2 / 0.1.7-rc.2)**:

Replace `<DSH_HOME>` with your DSH home: for the Web build it defaults to `~/.dsh` (or wherever `DSH_HOME` points); the **desktop build
uses a different path** — take the profile directory shown in that shell's configuration or logs.

```sh
# (1) This plugin's declaration — expect three names, without dsh-client-runtime
node -e 'console.log(JSON.stringify(require(process.argv[1]).dsh.client.inject))' \
  "<DSH_HOME>/profiles/web/node_modules/dsh-graph/package.json"

# (2) Does the profile manifest still list it? — expect the number 0
#     (note: `grep -c` exits 1 when the count is 0 — read the printed number, not the exit code)
grep -c dsh-client-runtime "<DSH_HOME>/profiles/web/package.json"

# (3) Is there still a directory named dsh-client-runtime anywhere under the DSH home? — expect no output
find "<DSH_HOME>" -type d -name dsh-client-runtime 2>/dev/null

# (4) Optional, Web build with a running instance only: is it still a row in the client manifest? — expect no output
#     `dsh web` prints a tokenized URL on startup; paste it verbatim as <URL>
curl -sL -b "" "<URL>" | grep -o '"@deepseek-ai/dsh-client-runtime"' | head -1
```

Measured on an isolated instance (dsh 0.2.0-rc.2):

- (1) → `["@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-ui-primitives","@deepseek-ai/dsh-client-ui-sidebar-right"]`
- (2) → `0`
- (3) → no output
- (4) → no output, while `curl` returned 200 with 35125 bytes (the same command does print a row name that **is** present in the manifest,
  e.g. `@deepseek-ai/dsh-client-ui-settings`)
- Command-sanity counter-checks (neither command is vacuously silent): (2) prints `1` on a manifest file that really contains the name, and
  (3) **did print the path** after a directory named `dsh-client-runtime` was deliberately placed into the profile (removed again immediately).

**Cleanup (optional, back up first)**: only if you really want a clean slate and (2) is non-zero or (3) has output: **back up** the profile first,
then remove the residue directory printed by (3) (and drop the matching entry from the manifest that (2) flagged), then **restart the host** —
client package metadata is cached at activation time, so adding/removing client plugins only takes effect after a restart. **Risk note**: deleting
directories or editing the manifest of a live profile can break your environment; the **safer alternatives** are reinstalling the same dsh-graph
version or creating a fresh, clean profile. Always keep a backup before doing this yourself, and restore from it if anything misbehaves.

**Not verified**: no desktop-shell environment is available (`@deepseek-ai/dsh-desktop` is E404 on npm). The symptom and cause chain above cite the
external report and host source code; this README does **not** claim the desktop-shell symptom was reproduced.

---

### Key Features

- **Four-Phase Lifecycle State Machine**:
  Enforced by the core engine: `draft → planning → collecting → ready → in_progress → review → delivered` (with a `blocked` escape hatch available at any stage).
- **Criteria Before Execution**:
  Acceptance criteria must be explicitly defined prior to execution. Deliverables in the review phase are verified strictly against individual criteria, preventing ambiguous delivery.
- **Context Cards**:
  Supports Text, File, Image, and Data cards. Follows a structured lifecycle (`empty → collecting → filled → reviewed`) to seed precise task context for execution subagents.
- **2D Swimlane Board**:
  Columns represent lifecycle stages, while horizontal swimlanes organize goals by Version, Backlog, and Standalone categories, complete with drag-and-drop scheduling.
- **Graded Review & Policy Calibration**:
  Configure project review parameters (`review.regions`, `review.contract_paths`, `review.non_product_prefixes`) via `graph_get_settings` and `graph_update_settings`. Product changes in unregistered regions safely escalate to strict; empty contract paths default to not triggering M1.
- **Relations Between Goals**:
  Goals can be linked with four relation kinds — supersedes / amends / extends / related — and unlinked again; relations live in exactly one source of truth (the goal's frontmatter). Cards show relation badges, and the goal dialog lists the full inventory under "Goal description" (cross-version and archived peers flagged).
- **Seamless Session Handoff**:
  Generate `HANDOFF.md` summarizing board projections, long-term memory, and environment facts. A new session can claim the Supervisor role idempotently via `graph_claim_supervisor`.
- **Modern UI & Dual-Theme Support**:
  Full Dark and Light theme adaptation following DSH variables. Subtle pulse animations highlight external updates (with `prefers-reduced-motion` accessibility support); drag-safe modal text selection.

---

### Design Philosophy (for readers new to this plugin)

To understand *why* dsh-graph organises development the way it does — goal lifecycle and state machine, criteria
gate and human gate, dispatch and the isolation triad, attempts and the results surface, independent review and
its source of truth, version lanes and release red lines, memory grading, event-first writes — read
[Design Philosophy (English)](https://github.com/miuzel/dsh-graph/blob/main/docs/design-philosophy.en.md):
every behavioural claim carries a code citation, and the document ships archify interactive diagrams — an inline
static preview plus an explorable HTML page — that draw only what is implemented today (state flow and role
split, with no file, function or internal artifact names inside the figures; the 1.0 roadmap lives in §13).

---

### Agent Tools Reference

dsh-graph equips Agents with a comprehensive set of `graph_*` tools (53 in total):

| Category | Tool | Description |
|----------|------|-------------|
| **Goal Lifecycle** | `graph_create_goal` | Create a goal (defaults to Backlog, optional Version) |
| | `graph_rename_goal` | Rename goal title |
| | `graph_set_description` | Set/update goal description body (Markdown) |
| | `graph_set_directive` | Inject instructions and boundaries for the upcoming attempt |
| | `graph_set_goal_type` | Set goal type (feature / bug / task / improvement / patch / chore) |
| | `graph_set_goal_tags` | Set goal tags (max 20, optimistic concurrency) |
| | `graph_set_goal_budget` | Set/clear the goal budget (integer seconds 30–86400; empty inherits the project/global care threshold) |
| | `graph_amend_goal` | Record amendments, optionally appending to description |
| | `graph_transition` | Advance goal through lifecycle states (reason required for blocked) |
| | `graph_postpone_goal` | Postpone goal back to Backlog as draft |
| | `graph_archive_goal` | Archive completed or obsolete goals |
| | `graph_unarchive_goal` | Restore goals from archive |
| | `graph_delete_goal` | Safely delete an archived goal |
| | `graph_clean_worktree` | Clean up a verified worktree (requires user confirmation) |
| | `graph_list_worktrees` | Query Git worktree cleanup candidates (read-only, no auto-delete) |
| **Goal Relations** | `graph_set_relation` | Mark or unmark a relation between goals (supersedes / amends / extends / related; idempotent, rejects supersede cycles) |
| **Quality Criteria** | `graph_set_criteria` | Define quality criteria (required prior to execution) |
| **Context Cards** | `graph_add_card` | Create a context card placeholder (text / file / image / data) |
| | `graph_bind_collect_card` | Bind collection subagent; marks card status as collecting |
| | `graph_fill_card` | Populate card content with a concise board summary |
| | `graph_review_card` | Review card content (filled → reviewed) |
| | `graph_delete_card` | Delete cards not currently collecting |
| | `graph_convert_card_to_shared` | Convert owned card to shared card |
| | `graph_convert_card_to_owned` | Convert shared card back to owned card |
| | `graph_attach_shared_card` | Attach an existing shared card to a goal (reuse collected context; owner/supervisor only) |
| | `graph_detach_shared_card` | Remove a goal's reference to a shared card (card stays in the pool; rejected while collecting) |
| | `graph_list_shared_cards` | List shared pool cards read-only (id/title/status/refs) |
| **Attachments** | `graph_store_attachment` | Store file attachments to a goal |
| | `graph_delete_attachment` | Delete a goal attachment |
| **Scheduling** | `graph_move_goal` | Move goals between Backlog, Standalone, and Versions |
| **Execution & Rework** | `graph_start_attempt` | Dispatch an execution attempt and spawn a continuable subagent |
| | `graph_record_attempt_handoff`| Record rework constraints, failure notes, and baseline |
| | `graph_unbind_goal_child` | Safely detach an execution subagent from a goal |
| | `graph_abandon_attempt` | Abandon a stale or lost attempt |
| | `graph_start_review` | Dispatch an independent read-only review subagent for an existing attempt (no new attempt, never overwrites author results; conclusion stored separately) |
| **Configuration** | `graph_get_settings` | Query workspace project configuration and enum metadata |
| | `graph_update_settings` | Update workspace project configuration (supports partial patch) |
| **Memory** | `graph_memory_add` | Write on-demand / standing memory entries |
| | `graph_memory_recall` | Recall memory entries by keyword search |
| | `graph_memory_remove` | Remove a specific memory entry |
| | `graph_memory_replace` | Replace an existing memory entry's content |
| **Status Reporting** | `graph_report_status` | Report progress of current attempt (live card display) |
| | `graph_report_supervisor_status` | Report supervisor status (top status bar animation) |
| | `graph_care_outcome` | Report a subagent-care inspection outcome (bound supervisor only; one-shot, event-first, evidence required for counting) |
| **Review & Verdict** | `graph_resolve_accept` | Accept or object to delivered attempts |
| **Collaboration** | `graph_add_comment` | Append historical discussion or human feedback |
| | `graph_write_results` | Manually write an attempt completion summary (source=manual + writer annotation; fallback for subagent-less changes) |
| | `graph_refresh_results` | Regenerate `results.md`: zero-LLM fallback assembly, or a caller-supplied `content` body from the dedicated summarizer subagent / a human (previous version archived; supports a goals[] batch) |
| | `graph_handoff` | Export cross-session handover document (`HANDOFF.md`) |
| | `graph_claim_supervisor` | Claim supervisor role in new session & update metadata |
| | `graph_help` | Display usage instructions and the 53-tool checklist |
| **Validation** | `graph_validate` | Validate full invariants (states, cycles, card refs) |
| | `graph_rebuild` | Rebuild goal state from `events.jsonl` and reconcile |

---

### Browser Kanban UI

Embedded directly within the DSH Web console:

- **2D Swimlane Layout**: View the progress of multiple versions and categories simultaneously;
- **Live Streaming Updates**: Cards and the top status bar stream real-time execution updates; external file edits trigger visual highlights;
- **Interactive Modals & Drawers**: Click cards to inspect quality criteria, context cards, attempt histories, and detailed instructions.

---

### Sidebar Usage

The sidebar's "**Kanban**" tile and the conversation page's "**Kanban**" tab are **the same implementation** — the same board component and the same header / narrow-width logic, **fully identical on both sides** (zero host gating). Either entry point works.

- **Entry**: open the right sidebar in a session → click the "Kanban" tile; the opened board then stays as a persistent tab at the top of the sidebar, one click away.
- **`⋯ Tools`**: Refresh / Tag filter / Memory / Project Knowledge Base (shared entries) / Board settings / Archived. The toolbar collapses into this single item automatically when it **does not fit the measured header width** (not a hard-coded viewport breakpoint).
- **`[🏷️]` Version Management**: the square icon button in the corner (accessible name "🏷️ Version Management") opens the version-management drawer; immediately to its right sits `Create Version`, **same row and equal height**.
- **Version selector**: sits **to the left of** the lane-row `[+]` (new goal) and switches the lane currently shown (a specific version / Backlog / Standalone).
- **Narrow-width behaviour** (tiered by the **measured width of the board's root container** — the board element's own `clientWidth`, **not the window width and not the browser viewport width**):
  - **`≥ 480px` (wide tier)**: multiple swimlanes side by side, so versions / Backlog / Standalone are all visible at once;
  - **`< 480px` (single-lane tier)**: stage columns switch from side-by-side to **vertically stacked**, and the lane shown is chosen by the version selector (**exactly one of a specific version / Backlog / Standalone**; **when the workspace has no versions at all, the default landing lane is "Standalone"**, and the selector's current item reads "Standalone"); this tier has **no per-lane collapse toggle** (collapsing would leave an empty board), and it also **forces the toolbar into `⋯ Tools`** and **hides the DEBUG line**.
  - **How to get the board into `< 480px`**: the host tab's width comes from the **tab layout mode**, not from dragging — measured at a 1600px viewport: single tab **719px**, **359px** per tab after the tab's `Split` mode (this mode scales with the window width), **799px** in `Fullscreen`. So the **default single-tab width (719px) lands in the wide tier** and no single lane appears; use the tab's **`Split`** mode, or narrow the window until the board panel measures <480px. Once there, it is obvious: the six stage blocks are **stacked vertically** and the version selector appears next to the lane title (current item: a specific version / Backlog / Standalone).
  - **Residual in the wide tier (measured)**: the wide-tier grid's minimum width is about **956px**, so whenever the board panel measures less than that (e.g. the default single tab at **719px**) the wide grid **still scrolls horizontally** and pushes the confirm / bulk-accept column out of view; the tier that actually removes horizontal scrolling is the single-lane one (<480px).
  - **The version selector is rendered only in the single-lane tier**: in the wide tier the board has **no** version selector at all. So an "All versions" string seen in the wide tier can only come from an **opened dropdown option list**, never from the current selection; and in the single-lane tier, before any explicit view choice, the current item is "Standalone" — **not** "All versions".

See [screenshot/sidebar-kanban.png](https://github.com/miuzel/dsh-graph/blob/main/screenshot/sidebar-kanban.png) in the repository for a screenshot (fictional demo data nebula-notes, sidebar width in the `< 480px` single-lane tier); this npm package does not ship the repository's `screenshot/` directory, so only the repository path is given here.

---

---

### HTTP authentication (REST entry points behind the Web kanban)

The plugin serves a set of `/api/dsh-graph/**` REST endpoints in the Web host (used by both the kanban UI and scripts). Since g-507 the security model is a **single protected entry point**:

- **One entry, not 63**: the plugin registers exactly **one** `kind:"prefix"` route with `path:"/api/dsh-graph"`. The 63 business routes are no longer host routes; they are dispatched inside the plugin as `exact` routes plus two asset prefixes (`/diagram`, `/help/asset`).
- **Authenticate first, business second**: every request first calls the host's **public** `connection.admit(req)` (with `this` preserved), then checks whether the caller is the owner. Before admission it never reads the body, resolves the target path, initializes a workspace, touches files, or dispatches anything.
- **Rejection matrix (fixed)**:
  | Situation | Status |
  |---|---|
  | Anonymous / invalid credential (host 401) | `401` |
  | Trust-boundary rejection (host 403: Host / Origin / cross-site) | `403` |
  | Valid credential but **not the owner** | `403` (`not-owner`) |
  | Host has no `connection` service, no `admit`, `admit` throws, or returns an undecidable shape | `503` (**fail-closed**, no internal detail) |
  | Admitted but unknown path / wrong method | `404` / `405` (only after admission) |
- **Capability dependency**: everything hinges on the host's public `connection.admit`. When the host does not provide it, the HTTP entry points answer **503 fail-closed** (never a silent anonymous pass-through); the **tool surface is unaffected** (`graph_*` tools do not go through the HTTP entry).
- **Trailing slash and query**: `/api/dsh-graph` and `/api/dsh-graph/` are different paths (the latter is 404 after admission); `prefix/` on the two asset prefixes enters business handling and yields a 400 (illegal file name); query does not participate in matching.
- **Verified scope, stated plainly**: the behaviour in this section was measured **only on DSH `0.2.1-rc.2`** (a historical round; real host `BrowserAuth`, real token exchange, real HTTP). That verdict **predates** this release's narrowing: the `0.1.x`, `0.2.0` and `0.2.1` lines are no longer supported (see "host compatibility range" above), and authentication on the current declared range `>=0.2.2-rc.3` was **not verified version by version**. If a host lacks the public `admit`, the table above implies 503 for HTTP entry points — that implication is likewise **not verified per version**, so the declared range must not be read as a current Web-authentication verdict.


### Profile-wide settings (subagent defaults)

The subagent default provider / model, reasoning effort, execution mode, prompt language and supplementary prompt are **profile-wide defaults**: they are written to the current DSH profile, apply **across workspaces**, and an explicit `project.yaml` value or a per-dispatch argument still takes precedence.

The same settings page opens from **two places**, both backed by one implementation reading and writing the same profile configuration:

- **Settings → Kanban Settings**: the standalone page in the settings navigation;
- **Right sidebar → Plugins → dsh-graph**: the configuration block on the bundle page (bound by the package name `dsh-graph`).

When the host does not expose a given seat (slim profile / older host) that seat simply does not appear and the board and tools are unaffected; when no settings service is reachable from either of them the page **says so** instead of pretending the settings are live. Values live in the profile's settings document (on 0.2.0-line hosts the `dsh-graph-host` entry in the profile's `cordis.patch.yml`; on 0.1.6-line hosts the `dsh-graph` namespace in `$DSH_HOME/settings.yaml`).

---

### Data Storage

All data resides in `.dsh-graph/` within your workspace:

- **Zero-Config Auto-Init**: Generates directory structure automatically upon first tool call without dummy demo data;
- **Git Friendly**: Managed as plain YAML/Markdown files and an append-only `events.jsonl` event log;
- **Auditability**: `events.jsonl` serves as the authoritative single source of truth, reconcilable at any time via `graph_rebuild`;
- **Multi-Worktree Support**: Git Linked Worktrees automatically resolve to the canonical graph root in the primary worktree.

---

## License

[MIT](LICENSE)
