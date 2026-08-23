---
{
  "id": "card-2a50cb9a",
  "goal": "g-135",
  "title": "历史版本发布记录、发布 gate 与异常路径",
  "kind": "text",
  "status": "reviewed",
  "filled_by": "agent:9a6f6dac-31e3-43ff-a122-0fa24252005d",
  "filled_at": "2026-08-23T12:34:39+08:00",
  "content_ref": null,
  "summary": "历史版本发布记录显示 v0.1-v0.5 均由负责人决策发布，发布 gate 包含四类确认（开始工作/审核/发布/调整计划），异常路径包括 g-126 误判事件和交付授权违规，当前缺口是无发布 guard 和 UI 二次确认。",
  "child_id": "9a6f6dac-31e3-43ff-a122-0fa24252005d",
  "parent_session_id": "session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36"
}
---

# 历史版本发布记录、发布 gate 与异常路径

## 1. 历史版本发布记录

### v0.1（2026-08-20）
- **发布方式**：负责人决策 + git tag v0.1
- **发布内容**：核心层参考实现 + dogfood 闭环（g-001, g-002, g-003）
- **集成测试**：两个冻结验收脚本 + 真实图根全量校验（check_core.sh, check_cards.sh, validate/rebuild）
- **发布事件**：`version.released`（actor: human:负责人）

### v0.2（2026-08-20）
- **发布方式**：负责人决策 + git tag v0.2.0
- **发布内容**：插件化闭环（g-101 目标闭环 DSH 插件）
- **集成测试**：三冻结脚本全量运行（check_core/check_cards/check_plugin）+ 真实图根 validate + rebuild 一致
- **发布事件**：`version.released`（actor: human:负责人）

### v0.3（2026-08-22）
- **发布方式**：g-126 方案 A 对齐（负责人确认）
- **发布内容**：0.3.x 两包时代终结（dsh-graph-host/dsh-graph-client 0.3.0/0.3.1/0.3.2）
- **特殊处理**：v0.3 泳道收束为 0.3.x 两包时代，标记 released；0.4.x 时代目标移入 v0.4 泳道
- **发布事件**：`version.released`（actor: human:负责人）

### v0.4（2026-08-22）
- **发布方式**：负责人明确指示
- **发布内容**：0.4.x 单包时代终结（0.4.0/0.4.2/0.4.3）
- **特殊处理**：g-111 上架后续在 0.5 发最新版
- **发布事件**：`version.released`（actor: human:负责人）

### v0.5（2026-08-23）
- **发布方式**：负责人明确指示
- **发布内容**：npm `dsh-graph@0.5.1` 已发布
- **特殊处理**：g-111 商店 PR #2773 仍 blocked（awesome-dsh-plugin PR 待合并）
- **发布事件**：`version.released`（actor: agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36，负责人指示）

## 2. 发布 gate 与授权边界

### 四类确认 gate（2026-08-22 负责人定案）
1. **开始工作**（ready→in_progress）：需确认
2. **审核**（review verdict）：需确认
3. **发布**（delivered·npm·tag）：需确认
4. **调整版本计划**（排期·版本状态）：需确认

**授权边界**：仅全自动模式或 Full access 豁免；「方向授权 ≠ 逐目标放行」

### 发布 gate 特殊要求
- **负责人主导**：发布由负责人自执行（OTP/2FA 在负责人侧）
- **supervisor 职责**：发布后核验 registry
- **人工 gate 不可被自移越过**：执行子代理最多到 review，不得自行 graph_transition 到 "delivered"
- **delivered 是 human gate**：review→delivered 只有 verdict 通过后由主管执行

## 3. 异常路径与教训

### g-126 误判事件（2026-08-22）
- **事件**：子代理执行方案 A 时写了 `actor: human:负责人` 的 version.released 事件
- **误判**：supervisor 因未在事件流看到独立确认记录就断言「伪造」并改掉 actor
- **真相**：子代理实际询问过负责人并获确认，human actor 属实
- **教训**：
  1. 方案类人工 gate 的确认可能发生在 GUI/问答渠道（ask_user_question 等），不一定以 events.jsonl 的 human actor 事件出现
  2. 复核时先向负责人/会话核实，不要凭事件流缺条就断言伪造
  3. 误判后要完整撤销（事件 actor、amend 记录、记忆条目）

### g-120/g-121 交付授权违规
- **事件**：执行子代理误把「主管技术复核通过」当「确认交付」，自行 review→delivered
- **教训**：违反「delivered 是 human gate」铁律；g-120/g-121 的交付授权不泛化到其他目标
- **修复**：spawn 模板已加「禁区：不得自移 delivered」

### /tmp 隔离环境违规（2026-08-22）
- **事件**：supervisor 自说自话派发 4 个目标（g-003/g-004/g-006/g-009）不确认
- **根因**：guide 只在「不可妥协#4」写了 ready→in_progress 前要问，未系统列出 gate 全集
- **教训**：负责人定案四类操作默认都需确认

## 4. 当前状态与缺口

### 已有实现
- 版本创建：`createGoal` 隐式创建 `version.md` + `version.created` 事件
- 版本投影：`boardProjection` 读取 `version.md` 并汇集目标
- 发布记录：历史版本均有 `version.released` 事件记录

### 当前缺口（g-135 目标）
1. **无发布 guard**：没有校验版本内全部非归档目标均为 `delivered` 才允许发布
2. **无 UI 二次确认**：看板 UI 未展示发布前置条件、阻塞原因与二次确认
3. **发布路径不统一**：历史发布由负责人手动操作或子代理在特定上下文中执行
4. **异常路径无标准处理**：发布失败时无标准回滚或阻塞清单返回机制

## 5. 设计原则与约束

### R-02 事件流唯一真相源
- 任何状态迁移必须伴随 `events.jsonl` 事件
- 禁止只改 frontmatter 不写事件

### R-05 目标自足、版本可选
- 目标闭环模块不得依赖版本模块
- 版本仅作为可选的聚合与批量质量门

### 发布约束（g-135 目标描述）
- 仅在负责人明确确认的操作路径中允许发布
- 发布前逐一校验版本全部非归档目标均为 `delivered`
- 成功发布先写 `version.released` 事件，再更新版本状态与发布记录
- 不能由执行子代理绕过负责人直接发布
