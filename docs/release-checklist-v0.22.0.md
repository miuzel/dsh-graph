# dsh-graph v0.22.0 发布检查清单

> 本文件状态：发布准备完毕（全量 5 个目标已交付收口、版本串与文档已同步、全量测试自证通过）。

## 0. 本版核心变更概述
1. **完成摘要去冗余瘦身与交回报文精简**（g-504）；
2. **目标删除与隔离工作树清理防护闭环**（g-500）；
3. **共享卡片全生命周期与保底解除通道**（g-501）；
4. **目标流转评审记录自愈消除死链**（g-499）；
5. **全新官方插件图标与评审统计口径披露**（icon.svg, g-503）。

## 1. 版本号一致性核查
- [x] 包清单版本：`dsh-graph-host/package.json` -> `"version": "0.22.0"`
- [x] 客户端常量：`dsh-graph-host/lib/client/constants.js` -> `const PLUGIN_VERSION = "0.22.0";`
- [x] 根目录 README：`README.md` -> `当前版本 v0.22.0` 与 `最新亮点（v0.22.0）`
- [x] 包内 README：`dsh-graph-host/README.md` -> `v0.22.0`
- [x] CHANGELOG：`CHANGELOG.md` -> `## v0.22.0 — 2026-10-20`（5 条要点，无过程痕迹）
- [x] 发布正文：`docs/release-notes-v0.22.0.md`

## 2. 门禁与自证
- [x] 全套测试通过：`node scripts/run-tests.mjs`（2646 pass / 0 fail / 0 skip）
- [x] TypeScript 类型检查：`./node_modules/.bin/tsc --noEmit -p tsconfig.json` 通过（0 error）
- [x] 客户端语法检查：`node --check dist/lib/client.js` 通过
- [x] 产物新鲜度守卫：`node --test core/tests/dist-freshness-g312.test.ts` 通过（9 pass / 0 fail）
- [x] 跨宿主版本兼容性：DSH `0.2.1-rc.2` 干净测试实例与真实多会话拓扑看板验证通过

## 3. 产物与指纹
- [x] 候选包文件名：`dsh-graph-0.22.0.tgz`（82 个文件，解包大小 4.6 MB）
- [x] 文件体积：1,550,654 字节
- [x] SHA-256：`23c1ba51b0bc1e587d448d47cda578492d04a298ab392aef7eb3285ba42be7e4`
- [x] SHA-1：`4f56e01effb4631c9b045144e7bac4a07bdd15cb`
- [x] 隔离性核验：`dist/` 目录干净（无 `.tgz` 残留，已移至 `tmp/`）
