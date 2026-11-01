# dsh-graph v0.23.0 发布检查清单

> 本文件状态：发布准备就绪（全量 6 个目标已交付收口、版本串与文档已同步、全量测试自证通过、发布包已打包生成）。

## 0. 本版核心变更概述
1. **主管会话智能保活机制**（g-505）；
2. **长任务智能关照与僵局干预**（g-506）；
3. **插件 HTTP 接口安全加固**（g-507）；
4. **移除 HTTP 鉴权诊断中的目标编号**（g-561）；
5. **防止同一目标并行派发重复 attempt**（g-610）；
6. **子代理时间预算调度与动态基准重算**（g-612）。

## 1. 版本号一致性核查
- [x] 包清单版本：`dsh-graph-host/package.json` -> `"version": "0.23.0"`
- [x] 客户端常量：`dsh-graph-host/lib/client/constants.js` -> `const PLUGIN_VERSION = "0.23.0";`
- [x] 根目录 README：`README.md` -> `当前版本 v0.23.0` 与 `最新亮点（v0.23.0）`
- [x] 包内 README：`dsh-graph-host/README.md` -> `v0.23.0`
- [x] CHANGELOG：`CHANGELOG.md` -> `## v0.23.0 — 2026-11-02`（5 条要点，无过程痕迹）
- [x] 发布正文：`docs/release-notes-v0.23.0.md`

## 2. 门禁与自证
- [x] 全套测试通过：`node scripts/run-tests.mjs`（2898 pass / 0 fail / 0 skip）
- [x] TypeScript 类型检查：`./node_modules/.bin/tsc --noEmit -p tsconfig.json` 通过（0 error）
- [x] 客户端语法检查：`node --check dist/lib/client.js` 与 `node --check dist/index.js` 通过
- [x] 产物新鲜度守卫：`node --test core/tests/dist-freshness-g312.test.ts` 通过（9 pass / 0 fail）
- [x] 跨宿主版本兼容性：DSH `0.2.1-rc.2` 干净测试实例与真实多会话拓扑看板验证通过

## 3. 产物与指纹
- [x] 候选包文件名：`dsh-graph-0.23.0.tgz`（84 个文件，解包大小 5.1 MB）
- [x] 文件体积：1,677,228 字节
- [x] SHA-256：`139a8ed07979d8dd83df879bd58d96dbcb74f26200bc465ea6bd76603f1855e8`
- [x] SHA-1：`58edc90bda49d9909229492e53693d0b7c80c14a`
- [x] 隔离性核验：`dist/` 目录干净（无 `.tgz` 残留，已保存在 `tmp/dsh-graph-0.23.0.tgz`）
