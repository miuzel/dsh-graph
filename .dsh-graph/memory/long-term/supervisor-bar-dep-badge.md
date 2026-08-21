# mem-004：看板主管栏与状态化依赖徽章（g-108 交付模式）

source_goal: g-108（versions/v0.3/goals/g-108），交付于 43ebf5b

## 模式
- **主管栏（SupervisorBar）**：数据不靠客户端硬编码会话 id——host `boardPayload()` 在 `/api/dsh-graph` 响应里下发 `supervisorSession`（core `readSupervisorSession` 零依赖行扫 project.yaml），客户端凭它做 uSES 实时行 + 模型显示 + ↗ 一键跳对话 tab。
- **状态化依赖徽章**：投影时建立 id→status 映射，徽章按依赖目标实时状态渲染两态（⛓等待 / ✅依赖满足: g-xxx），卡片与 modal 头部同源。教训来源 发现#23：只查"有依赖"会把已交付依赖也标成等待。
- **判据 checklist（附加交付）**：modal 判据区逐条 ☑ 勾选（localStorage 评审草稿，key `dsh-graph.crit.<goalId>`）+ 逐条 💬 反馈经 `session.prompt(..., "queue")` 直达该目标最新 attempt 的执行会话。勾选态要跨端/入图需 host 写端点（→ g-109 衔接）。

## 复用要点
- 跳对话 tab 无公开 API，用 DOM 点击第一个 tab（order=0），脆弱、已在 attempt 记录，DSH 暴露 API 后替换。
- 验收脚本教训：专名标记（dg-supervisor / supervisorSession / dg-tab / 被复用）防真空通过——grep 通用词会匹配到无关残留。
