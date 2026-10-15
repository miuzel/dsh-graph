# dsh-graph v0.21.0 发布检查清单

> 本文件状态：发布准备中（全量 19 个目标已交付收口、版本串与文档同步中）。

## 0. 本版核心变更概述
1. **全新「使用说明」中心与 Graph Engineering 体系**（g-481, g-489, g-493, g-498, g-502）；
2. **提示词渐进式披露、单源化与零开发痕迹**（g-495, g-496）；
3. **工作区级模块真裁剪与前端入口联动隐藏**（g-480, g-482, g-494）；
4. **设置弹窗信息架构升级与双语无缝热重载**（g-479, g-488, g-490）；
5. **健壮性与开发基建加固**（g-468, g-472, g-478, g-483, g-484, g-487）。

## 1. 版本号一致性核查
- [x] 包清单版本：`dsh-graph-host/package.json` -> `"version": "0.21.0"`
- [x] 客户端常量：`dsh-graph-host/lib/client/constants.js` -> `const PLUGIN_VERSION = "0.21.0";`
- [x] 根目录 README：`README.md` -> `当前版本 v0.21.0` 与 `最新亮点（v0.21.0）`
- [x] 包内 README：`dsh-graph-host/README.md` -> `v0.21.0`
- [x] CHANGELOG：`CHANGELOG.md` -> `## v0.21.0 — 2026-10-15`（5 条要点）
- [x] 发布正文：`docs/release-notes-v0.21.0.md`

## 2. 门禁与自证
- [x] 全套测试通过：`node scripts/run-tests.mjs`（2598 pass / 0 fail）
- [x] TypeScript 类型检查：`tsc --noEmit` 通过（0 error）
- [x] 客户端语法检查：`node --check dist/lib/client.js` 通过
- [x] 跨宿主版本兼容性：DSH `0.2.1-alpha.2` / `0.2.1-alpha.3` 验证通过
