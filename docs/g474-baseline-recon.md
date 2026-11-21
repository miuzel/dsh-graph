# g-474：版本派发基线只读复现与待裁决设计

本轮仅调查，不实现策略。采样：2026-11-13，WSL2；权威基线 `d4d91fec6c576ebf4cdab353ae62008751b07893`。没有创建真实 attempt、调用派发、操作用户实例、构建、安装或启动服务。

## 1. 当前证据与实际解析来源

- 主工作树当前为 `v1.0.0-test`，HEAD=`d4d91fe`；`main`=`80feee1`；`git rev-list --left-right --count main...v1.0.0-test` 为 `0 4`：两线 tip 不同，main 是祖先，并非拓扑双向分叉。
- `git worktree list` 核实专属树 `.worktrees/g-474-att-01`，分支 `g-474-att-01`、起点 `d4d91fe`。主树初始 `git status --porcelain` 为空，`stat -c '%Y %n' dist` 为 `1794167536 dist`。
- [本次持久化 attempt](/home/miuzel/workspace/personal/dsh-graph/.dsh-graph/versions/v1.0.0/goals/g-474/attempts/att-001/attempt.md#L13-L29) 的 `worktree.head` 和 `baseline_commit` 均为完整 `d4d91fe…`。这是已有派发记录，不是本轮新建的证据；没有重放工具/HTTP 派发。
- [当前解析器](/home/miuzel/workspace/personal/dsh-graph/core/worktree.ts#L1047-L1093) 的入参无 version；隔离关闭直接返回。开启时，非空显式值经 `git rev-parse --verify '<value>^{commit}'` 解析，非法值抛错；否则 `git rev-parse HEAD`。目标版本没有参与。
- [host 调用与锚点](/home/miuzel/workspace/personal/dsh-graph/dsh-graph-host/index.js#L7741-L7778) 只传显式 baseline、隔离开关与原因。显式锚点原样回显；否则取实际 worktree.head，再否则 `readRepoHead(dirname(root))`。不能把“回显短 SHA/符号引用”误称已规范化 SHA。
- [复用分支](/home/miuzel/workspace/personal/dsh-graph/core/worktree.ts#L1115-L1163) 回传已有树的当前 HEAD；不能把复用 HEAD 自动标为新解析版本基线，显式锚点也未在此校验与既有树一致。

## 2. 四种情形：私有 Git 解析实验

私有仓库位置为专属树 `tmp/g474-baseline-recon`，运行前断言不存在；最终已删除。使用 `git init -b main`、`git mktree`、`git commit-tree` 生成空树提交 A 和以 A 为父的 B，再用 `git update-ref` 设置私有 main=A、v1.0.0-test=B。无真实仓库 ref 修改、无 worktree add。

实验先逐字断言源码包含上述两条 `rev-parse` 语句，然后使用 Python subprocess 执行同样的 Git 命令复现解析分支。**这不是直接运行 prepareAttemptWorktree，也不是端到端 attempt 回报测试**；建树后续路径仅由读码核实。

| 情形 | 命令与断言 | 当前结果 |
| --- | --- | --- |
| 显式 baseline | `git rev-parse --verify 'B^{commit}'`，断言等于 B | B，显式优先 |
| 目标分支存在 | `git rev-parse refs/heads/v1.0.0-test`=B；默认 `git rev-parse HEAD`=A | A，版本分支被忽略 |
| 目标分支缺失 | `git show-ref --verify --quiet refs/heads/v9.9.9-test` exit=1；默认 HEAD=A | A，不会因缺分支拒绝 |
| HEAD 与版本分歧 | 断言 A≠B 且默认结果≠版本 tip | 跨线错误基线被负向对照捕获 |

基线对照：显式 B 返回 B；负向对照：期待默认结果落在版本 B 的断言条件不成立。另用不存在的 40 个零提交执行显式解析，exit=128，源码对应抛 GraphError 而非回退。

实测 A=`c0f9225885af7469083b1dc782619bfc9d5da807`，B=`8ddb4173530fdfff2e341e758d97dc2e0c6924e6`。四情形及非法显式值共 5 项断言通过，包装命令 exit=0；这些是解析调查检查数，不是产品测试套件计数。

## 3. 建议的发现规则与可审计来源（未实现）

1. 显式非空 baseline 最先解析为 commit；非法即拒绝，不能降级。保留 requested 值并另存 resolved 完整 SHA，避免改变现有锚点回显契约时无感迁移。
2. 版本从目标实际所属泳道/已解析版本实体取得，不从标题、cwd 或 attempt 分支猜测。[v1 元数据](/home/miuzel/workspace/personal/dsh-graph/.dsh-graph/versions/v1.0.0/version.md) 当前只有 id/name/status，无集成分支字段；core 搜索 `integration_branch|integrationBranch|test_branch` 无命中。注册表不是已有能力。
3. 最小命名建议：版本名已有单个 `v` 前缀则保留，否则补一个，再追加 `-test`；`v1.0.0`→`refs/heads/v1.0.0-test`，不能生成 `vv1.0.0-test`。明确校验名称，用精确本地 heads ref 和 `^{commit}`，避免 tag、remote、短名歧义；不 fetch、不自动建分支。
4. 如负责人选择显式版本元数据映射，则“映射优先、约定次之”是否允许必须另行批准；失效映射不能暗中绕过。远端独有分支按缺本地分支处理，除非另立显式远端策略。
5. 建议 `baseline_source`：`explicit`、`version_branch`、`main_head`、`existing_worktree`；旧记录缺失显示 null/unknown，不能倒推伪造。`main_head` 仅表示主工作树 HEAD，并不等于名为 main 的分支。
6. 配套建议字段：`baseline_resolved_commit`、`baseline_ref`、`baseline_version`、`baseline_fallback_reason`。失败不返回成功来源；无版本、版本缺失、无 Git、解析错误应分辨。复用树应同时保留原始基线与当前 HEAD，不用后者覆盖起点；策略变更需兼容已有锚点门禁。

## 4. 缺版本分支：负责人裁决，不自动定案

| 选项 | 行为 | 代价/约束 |
| --- | --- | --- |
| A：fail-closed（建议默认） | 有版本但本地集成分支缺失即拒绝，告知缺失 ref；允许调用者另传有效显式 baseline 重试 | 暂停旧流程，但不静默跨线；拒绝须在状态/attempt/子代理副作用之前 |
| B：显式授权回退 | 默认仍拒绝；调用者明确选择主树 HEAD 回退并给原因，回报 `main_head`、缺失 ref 与 fallback reason | 增加参数/契约；不能把告警当成已授权，须有可审计确认 |
| C：自动 HEAD 回退并告警 | 为兼容保留继续派发 | 告警会被忽略或白名单吞掉；仍可跨线，不建议作为安全默认 |
| D：负责人提供映射/先建集成分支 | 不回退，负责人先建立确定的版本落点再派发 | 注册表需设计/迁移；自动建分支需选择种子，本轮不做 |

无版本目标是否允许默认主树 HEAD、远端 ref 是否接受、复用树不一致时拒绝还是仅提示，都需明确裁决；不能把这些条件混成“分支缺失”。建议无版本保留当前默认、版本目标缺分支默认 A，均仅建议。

## 5. 工具/HTTP 白名单影响与后续验收

- [工具返回白名单](/home/miuzel/workspace/personal/dsh-graph/dsh-graph-host/index.js#L9261-L9271) 与 [HTTP/GUI 返回白名单](/home/miuzel/workspace/personal/dsh-graph/dsh-graph-host/index.js#L11150-L11157) 各自手写字段。仅改解析器或 isolationReport 不会自动透出新字段。
- 后续需贯穿解析结果→host report→attempt 元数据/事件→工具及 HTTP→goalDetail/GUI；同时核对复用 child 路径，不能声称其新建了版本工作树。旧记录来源缺失如实显示未知。
- 结构守卫需覆盖两白名单、持久化一致性与失败零副作用；不能只检验 JSON 包含字段。建议独立后续实现运行全量测试、类型/构建、WSL2 与原生 Windows 验证，本轮未运行。
- 正向：显式 baseline 优先且 resolved SHA 可对账；版本分支存在时取其 tip；无版本按批准策略；工具/HTTP/持久化来源一致；幂等复用不重置树。
- 负向：主树 HEAD 与版本 tip 不同不能静默成功落错线；缺版本分支、非法显式值、未知版本、失效映射、来源字段漏白名单、复用基线冲突都必须按批准策略拒绝或明确暴露，不能伪装版本解析成功。
- 产品尚未修复，跨线风险仍在；策略未裁决，不能将本材料视为上线实现或安全保证。

## 6. 边界与判据

判据 1：当前 Git/既有 attempt 记录与源码已核实，未新建派发回报。判据 2：四情形已完成解析层复现。判据 3：来源、发现、白名单与 fallback 选项见第 3–5 节。判据 4：只新增本文，私有仓库已清理，未改产品/测试/依赖或真实 refs。判据 5：正反验收方案见第 5 节。判据 6：仅命令调查与文档；全量/平台验证留待独立实现，未声称已通过。
