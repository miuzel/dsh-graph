共 5 个功能模块：

## 功能模块

| 模块 | 作用 | 状态 |
| --- | --- | --- |
| 标签 | 给目标打标签（≤20 个），用于筛选与分组 | {tags} |
| 记忆 | 跨会话持久事实：项目记忆与用户偏好，分按需 / 常驻两级 | {memory} |
| 共享卡 | 多目标复用的上下文：共享池挂载、引用计数、自有卡互转 | {shared_cards} |
| 自动化提示词 | 六键自动化指导段；**无专属工具**，只影响提示词 | {automation_prompts} |
| 附件 | 卡片正文可引用的文件（文本 / 二进制） | {attachments} |

模块 = 宿主按 `<board root>/project.yaml` 的 `modules` 段裁剪的工具组；关闭的模块其工具**不暴露**（数据不删除）。未配置 / 配置不可读一律按**全部开启**。上表「状态」为**本会话当前生效值**。

各工具的名称、参数与用途以 harness 注入的工具定义为准，此处不重复；需要操作细则（签名、必填/可选、证据分层等）时读使用说明：`graph_help(topic="usage")`。

## 接管 supervisor
**仅在负责人明确要求你接管 supervisor 时执行**——默认任何会话都不得自动 claim：
1. 旧会话：graph_handoff() —— 生成 HANDOFF.md；
2. 新会话：graph_claim_supervisor() —— 更新 supervisor.session，返回 HANDOFF 全文。

完整 supervisor 工作守则见 skill dsh-graph-supervisor，显式调用加载。
原则：产出物才是证据；关键阶段主动迁移卡片、自报状态；长任务节流心跳；不确定先问。
