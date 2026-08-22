# HANDOFF（换会话交接）

> 由 graph_handoff 自动生成于 2026-08-22T11:17:25+08:00（g-117）。图根：`/home/miuzel/workspace/personal/dsh-graph/.dsh-graph`。
> 你的职责指南：dsh-graph-host/supervisor-guide.md（注册为 skill `dsh-graph-supervisor`）。

## 目标看板

### 版本 v0.1（released）

- **g-003（上下文卡片模型与核心命令）**：`delivered`
- **g-001（核心层 TypeScript 参考实现）**：`delivered`
- **g-002（Dogfood：用本系统管理 g-001 走通全生命周期）**：`delivered`

### 版本 v0.2（released）

- **g-101（目标闭环 DSH 插件（goal-loop））**：`delivered`（check_plugin PASS：插件真实加载、10 工具注册、core 自测通过）

### 版本 v0.3（active）

- **g-108（看板顶部 supervisor 会话状态栏：复用实时控件+一键跳转主管对话）**：`delivered`（追加：status_line 摘要并入状态小窗（LiveStrip），图标随子代理状态——运行中 ⏳ / 空闲 ✅ 最近已完成；全脚本 PASS）
- **g-109（看板可写交互：目标描述编辑与人工反馈、上下文卡片添加、抽屉收集提示词可编辑）**：`delivered`（提示词加泳道迁移指令，38/38全绿）
- **g-111（v0.3 对外发布与插件商店上架）**：`blocked` —— 负责人 2026-08-22 指示暂搁置：awesome-dsh-plugin PR 需仓库满 1 天（约 8/23 01:57 +08:00 后开），且 0.4.1 发布待负责人自执行（OTP）。条件满足后解除。（B8修复完成0.3.1，真实安装验收过）
- **g-112（root 通用化：数据目录解析与初始化（去除 client 硬编码绝对路径））**：`delivered`（已交付：review→delivered 落定）
- **g-113（dsh-graph 新项目开箱即用：root 跟随会话 workspace + 使用指引注入）**：`delivered`（workspaces 数据源已修，待负责人刷 DEBUG 验证）
- **g-116（合并单包：dsh-graph-client 并入 dsh-graph-host）**：`delivered`（✅ 包名改 dsh-graph 完成，等规划方修订 kanban 断言）
- **g-117（supervisor 会话交接：一键 handoff + 自动更新主管会话 id）**：`review`
- **g-118（supervisor 守则自动注入：新 supervisor 会话无需显式调用 skill 即拿到工作守则）**：`ready`
- **g-119（收集卡绑定工具 graph_bind_collect_card + supervisor skill 绑定约束）**：`ready`
- **g-a92e1406（状态摘要运行动画与履历：流动背景+图标动画、modal 显示、近期动态收录汇报）**：`delivered`（判据 3① 二次扩展（supervisor 状态栏）实现完成：新增 supervisor.status_reported 事件（R-02 事件流唯一真相源）+ reportSupervisorStatus/readSupervisorStatus（读最新一条）+ host 工具 graph_report_supervisor_status + boardPayload 下发 supervisorStatus + SupervisorBar 传 statusLine 复用 LiveStrip 动画。core 23/23、冻结脚本断言内容 6/6 恒真、事件流测试数据已清理。另发现冻结脚本 awk|grep -q+pipefail 存在 SIGPIPE 竞态（间歇 FAIL 非逻辑回归），已上报。）
- **g-102（Kanban 二维泳道看板（client-plugin））**：`delivered`
- **g-107（卡片会话内嵌：实时状态与看板直达指令）**：`delivered`（六轮修复：模型查询被拒根因定位（subagent 围栏）并退化父会话；折叠态内联状态/token/模型；全绿待复测）（被复用→g-108）

### 独立目标

- **g-115（测试目标卡片流程）**：`draft`

### backlog

- **g-106（收集项任务化：卡片绑定收集子代理）**：`draft`
- **g-105（记忆提炼与技能沉淀机制）**：`draft`
- **g-110（目标卡片操作：暂缓（移回 backlog）、与现有目标合并、删除）**：`draft`
- **g-114（测试目标卡片）**：`draft`
- **g-77647351（看板卡片拖放交互（泳道内排序、跨列拖动触发状态迁移））**：`draft`
- **g-104（PK 沙盒编排与对比评审）**：`draft`
- **g-103（版本管理插件（version-supervisor））**：`draft`

## 进行中（下一步就干）

- **g-117（supervisor 会话交接：一键 handoff + 自动更新主管会话 id）**：`review`
- **g-118（supervisor 守则自动注入：新 supervisor 会话无需显式调用 skill 即拿到工作守则）**：`ready`
- **g-119（收集卡绑定工具 graph_bind_collect_card + supervisor skill 绑定约束）**：`ready`
- **g-115（测试目标卡片流程）**：`draft`
- **g-106（收集项任务化：卡片绑定收集子代理）**：`draft`
- **g-105（记忆提炼与技能沉淀机制）**：`draft`
- **g-110（目标卡片操作：暂缓（移回 backlog）、与现有目标合并、删除）**：`draft`
- **g-114（测试目标卡片）**：`draft`
- **g-77647351（看板卡片拖放交互（泳道内排序、跨列拖动触发状态迁移））**：`draft`
- **g-104（PK 沙盒编排与对比评审）**：`draft`
- **g-103（版本管理插件（version-supervisor））**：`draft`

## 已交付

- **g-003**：上下文卡片模型与核心命令
- **g-001**：核心层 TypeScript 参考实现
- **g-002**：Dogfood：用本系统管理 g-001 走通全生命周期
- **g-101**：目标闭环 DSH 插件（goal-loop）
- **g-108**：看板顶部 supervisor 会话状态栏：复用实时控件+一键跳转主管对话
- **g-109**：看板可写交互：目标描述编辑与人工反馈、上下文卡片添加、抽屉收集提示词可编辑
- **g-112**：root 通用化：数据目录解析与初始化（去除 client 硬编码绝对路径）
- **g-113**：dsh-graph 新项目开箱即用：root 跟随会话 workspace + 使用指引注入
- **g-116**：合并单包：dsh-graph-client 并入 dsh-graph-host
- **g-a92e1406**：状态摘要运行动画与履历：流动背景+图标动画、modal 显示、近期动态收录汇报
- **g-102**：Kanban 二维泳道看板（client-plugin）
- **g-107**：卡片会话内嵌：实时状态与看板直达指令

## 阻塞

- **g-111（v0.3 对外发布与插件商店上架）**：`blocked` —— 负责人 2026-08-22 指示暂搁置：awesome-dsh-plugin PR 需仓库满 1 天（约 8/23 01:57 +08:00 后开），且 0.4.1 发布待负责人自执行（OTP）。条件满足后解除。（B8修复完成0.3.1，真实安装验收过）

## 关键环境事实（固定段）

- **executor provider** = `deepseek-official`/deepseek-v4-flash（「deepseek」是错名；DSH adapter 注册名是 deepseek-official）
- **本地 dev 的 root 覆盖必须用相对值 `.dsh-graph`**（绝对路径会被 `path.resolve` 顶掉、破坏 workspace 跟随）
- **pnpm 11 supply-chain 策略在 `pnpm-workspace.yaml` 设 `minimumReleaseAge`**（不是 .npmrc）
- **冻结脚本 R-03**：执行方不得改；规划方（supervisor）可改但必须加 revision 注记
- **子代理 spawn 两个 provider 概念别混**：subagent provider（spawn/fork）≠ LLM provider（agentOptions）

## 长期记忆

`memory/long-term/` 下 8 个文件：
- client-session-embed-pattern.md
- core-goal-success-pattern.md
- dsh-plugin-pitfalls.md
- kanban-write-root-genericize.md
- root-follows-workspace.md
- status-anim-modal-tab-reused-supervisor-status.md
- supervisor-bar-dep-badge.md
- supervisor-handoff-automation.md
