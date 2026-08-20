---
{
  "id": "v-002",
  "name": "v0.2 插件化闭环",
  "status": "released",
  "created_at": "2026-08-20T19:40:00+08:00"
}
---

## 版本目标
把核心层包装为真实可加载的 DSH host 插件（dsh-graph-host），
用 DSH 原生机制驱动目标全生命周期，并在本项目中实际使用。

## 范围
<!-- 受管小节 -->
- g-101 目标闭环 DSH 插件（goal-loop host 插件）✅ delivered

## 范围说明
方案 A（负责人 2026-08-20 确认）：集中做 host 插件化；看板不做 client-plugin，
改以**会话内卡片清单**形式呈现各泳道，验证看板信息结构是否符合预期。

## 集成测试决策
三冻结脚本全量运行（2026-08-20）：check_core PASS / check_cards PASS / check_plugin PASS；
真实图根 validate + rebuild 一致。**决策（负责人）：集成通过，发布 v0.2.0。**

## 人工测试与测试数据
dogfood 2.0：插件热加载进 web profile，新会话用 graph_* 工具驱动测试目标
g-f8317edc 走通全流程（含子 agent 派发/绑定/状态汇报 live 验证）。
测试数据（g-f8317edc、两张测试卡）已在发布前清理。

## 发布记录

- v0.2.0 released @ 2026-08-20（负责人决策；git tag v0.2.0）
