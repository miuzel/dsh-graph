# supervisor 换会话一键化（graph_handoff / graph_claim_supervisor）——来源 g-117

## 成功模式

- 换会话三件套（原手改 project.yaml + 手写 HANDOFF.md + sed 改 session）已工具化：
  1. 旧会话 `graph_handoff` → 自动生成/更新 `.dsh-graph/HANDOFF.md`
     （board 投影 + memory/long-term 清单 + 固定环境事实段，产物不依赖会话上下文）；
  2. 新会话 `graph_claim_supervisor` → 更新 `supervisor.session` 为当前会话 id
     （ex.agent.session.id 链，与 header.cwd 同一链）、记 `supervisor.claimed` 事件
     （幂等：session 未变不重复记）、返回 HANDOFF 全文直接注入上下文。
- core 层 `writeSupervisorSession`：零依赖行编辑（无 supervisor 块新建 / 有块无 session
  键插入 / 有则替换值保留行尾注释），原子写（tmp + rename），事件先行。
- 看板主管栏数据源 readSupervisorSession 现读，claim 后无需改 client 代码。

## 坑与注记（低危，暂不修，建议与 g-108 一并排期 hardening）

1. supervisor 块内**嵌套子键的 session:**（如 automation.session）会被行扫描误识别为
   supervisor.session——g-108 readSupervisorSession 既有问题，g-117 未新引入；
2. 引号值 session 写回时剥引号并丢行尾注释；CRLF 文件写后混合行尾；inline
   `supervisor: x` 会追加重复键——本仓库 project.yaml 均为无引号块式，未触发；
3. 事件 actor 形如 `agent:<agent.id>`（工具统一 actorOf 约定），非 session 形——与全库一致。

## 约定

- 判据「actor=当前会话」在事件里体现为 actor 字段；事件 details.supervisor_session
  才是会话 id 本体。

## 复核补充（g-117 负责人复核 2026-08-22）

- 改 host 插件代码后**必须重启 dsh web 服务**，新 graph_* 工具才在会话中可见：
  profile link 本地工作树 ≠ 运行中进程持新代码（内存快照）。复核时新会话列工具
  只有 14 个（缺 graph_claim_supervisor），重启后 16 个齐全。环境事实已入
  supervisor-guide.md。
