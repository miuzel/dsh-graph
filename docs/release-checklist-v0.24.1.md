# dsh-graph v0.24.1 发布检查清单

> 本文件状态：发布准备就绪（两项 rc.3 兼容修复已交付、版本串与文档已同步、发布树全量自证通过、
> 发布包已打包、Windows 原生门禁 PASS）。**合 main / tag / publish 尚未执行**，仍待负责人放行。

## 0. 本版核心变更概述

v0.24.1 是**紧急兼容补丁**，只修 DSH `0.2.2-rc.3` 适配，不含新功能。

1. **修复 provider 探测误判**（g-624）：rc.3 删除 `subagents.list()`，旧代码 `list?.() ?? []` 把「查不到」折叠为空数组，导致派发恒报「无可用 subagent provider（已注册：无）」。改为 rc.1 保留枚举、rc.3 用具名 `getProvider('spawn'/'fork')`，未知/异常/默认缺失分开诊断。
2. **修复激活参数结构不兼容**（g-624）：rc.3 移除了 `startActivation` 的嵌套 `request`，改为扁平 spec 且 `delivery` 必填。`startSubagentCompat` 单点构建双形态（有 `list()` ⇒ 嵌套；无 `list()` ⇒ 扁平），两形态都显式 `delivery: "parent"`。
3. **适配被删除的中断 API**（g-625）：rc.3 删 `interruptByParent`，本地改用 `interrupt(child, {kind:"ancestor", agent})`；`interruptByUser` 是 Remote/Gateway 面，插件不使用。
4. **适配被删除的子级目录 API**（g-625）：`listChildren` → `sessionQuery.observeSession` 的 `subagentCatalog` 投影；缺投影/异常一律按 unknown，绝不当作「没有 child」。
5. **适配被删除的归属 API**（g-625）：`agents.isOwnedBy` → `subagents.rootOf` 比较 Agent 对象身份 + `header.parentSession`；19 处文本面收敛为 8 个功能面，UNAUTHORIZED 按「不可确认」处理。

## 1. 版本号一致性核查

- [x] 包清单版本：`dsh-graph-host/package.json` -> `"version": "0.24.1"`
- [x] 客户端常量：`dsh-graph-host/lib/client/constants.js` -> `const PLUGIN_VERSION = "0.24.1";`
- [x] 根目录 README：`README.md` -> `当前版本 v0.24.1` 与 `最新亮点（v0.24.1）`
- [x] CHANGELOG：`CHANGELOG.md` -> `## v0.24.1 — 2026-11-14`（4 条要点，无过程痕迹）
- [x] 构建产物：`dist/package.json` 由构建生成，实测 `0.24.1`
- [x] `g-371` 版本/变更史守卫：10/10 通过（含快照 `v0.24.1: 4 条`）

## 2. 门禁与自证（发布树）

发布树：`.worktrees/release-v0.24.1`（detached at `aeff775`，等价于待打 tag 的树）。

- [x] 全套测试：`node scripts/run-tests.mjs` -> `tests=3001 pass=3001 fail=0 skipped=0 todo=0 cancelled=0 exit=0 ms=96938`
- [x] 产物新鲜度（只读）：`node --test core/tests/dist-freshness-g312.test.ts` -> 9/9
- [x] 客户端语法：`node --check dist/lib/client.js`、`node --check dist/index.js` 通过
- [x] 构建：`bash scripts/build.sh` 原子发布成功，`dist/index.js` 含 `ownershipProbeOf` 等三收口
- [x] `g-352` 签名夹具：版本号变更后按维护者工具**重新冻结**（仅 provenance 两行变化，正文与内容 hash 不变）

> 说明：主树 `dist/` **未重建**（保持 v0.24.0 发布资产，避免与运行中的 3080 GUI 争用）。
> 因此主树直接跑全量会有 dist 同步族失败（17 项），这是预期状态，不是回归；发布结论以发布树为准。

## 3. rc.3 真机验证（隔离实例）

隔离实例：`0.2.2-rc.3`，加载补丁 `dist`，私有 `DSH_HOME` 位于补丁工作树 `tmp/dsh-test/`。

- [x] provider 探测：派发不再出现「无可用 subagent provider（已注册：无）」
- [x] 真实派发：`graph_start_attempt` 返回 `child_id` 非空（`6bedac42-…`），子代理实起并回结果；不再抛 `Cannot read properties of undefined (reading 'id')`
- [x] 存活/归属判定：同目标二次派发被明确拒绝「仍在运行（公开 registry=running）」
- [x] 复用准入：被拒但理由准确「不在 live registry（已结束/冷态）」，未退化为「无归属/找不到」
- [ ] **未真机演练**：失败收敛路径的真实中断（`interrupt` 仅在派发失败收敛触发，未人为制造失败注入）、缺 receipt 的真实 catalog 孤儿回收、复用成功路径

## 4. 产物与指纹

- [x] 候选包文件名：`dsh-graph-0.24.1.tgz`（86 个文件，解包 5,176,669 B）
- [x] 文件体积：1,712,879 字节
- [x] SHA-256：`112b6b2db3c99516d68c8f8a5d1db34a9dcafb8e58f61802d27f608539141dee`
- [x] SHA-1：`d4284398a8f0fc45e0f4c5224326287404c313a4`
- [x] 隔离性核验：包内无 `.tgz` / `.git` 残留；产物位于发布树 `tmp/pack2/`（不入库）
- [x] 可复现性：在发布提交 `aeff775` 上重新打包，SHA-256 与上表**逐字相同**（同一内容 ⇒ 已跑的 Windows 门禁对新树同样有效）

## 5. Windows 原生门禁（红线）

- [x] 在**原生 Windows** 上用 `pwsh` 运行 `node win-smoke-test.mjs --tarball dsh-graph-0.24.1.tgz --port 3091`
- [x] 结果：**PASS**，通过 22 / 失败 0 / 告警 1（win32/x64，node v24.21.0）
- [x] T3 看板文件系统生命周期：32 步全通过，每步盘面断言；跨进程并发 CAS 4 抢 1 恰好 1 成功
- [x] T4/T5：实例启动、插件加载、`dsh-graph` 路由注册、看板载荷可读、Web UI 可达（HTTP 303）
- [x] harness 组合矩阵：**H1–H6 全部 PASS（6/6）**。H3 由 `--h3-dispatch-json h3-facts.json` 提供真机事实后**真判通过**：
  - `reviewer` → `e9a1b856-bbd2-4886-a747-5372f49ec928`
  - `collector` → `ea73873c-4409-4219-9f00-97d0cdfe332b`
  - `executor-minimal` → `9517bf53-b8a8-453a-9fca-51e480b161ca`
  - 三条 `child_id` 均非空、`errors` 均为空；无 `tools.restrict() names unknown`、无启动失败/`child_error`
  - 取证环境：rc.3 隔离实例（3093）测试项目工作区；`executor-minimal` 由项目设置 `executor.mode=minimal` 触发（`mode_source=project`），取证后已恢复；`reviewer` 用工作区内临时 git 仓库的一次真实提交作 candidate
- [x] 告警项已消除：包内无产品源码导致台账未对账，改在仓库根跑 `node scripts/win-smoke-test.mjs --static-only .` -> 8/0/0，台账 67 项 / 268 处命中

## 6. 未完成（人工 gate，需负责人放行）

- [ ] 合入 `main`
- [ ] 打 tag `v0.24.1` 并推送
- [ ] `npm publish`
- [ ] GitHub Release 正文与 awesome-dsh-plugin 更新（按 `docs/release-handbook.md`）

## 7. 已知限制（如实记录）

- `interrupt` 迁移、catalog 孤儿回收、复用**成功**路径仅单测 + rc.3 宿主桩覆盖，真机未触发。
- `archive-worktrees`（rc.3 归档会话是否影响 graph 自管 `.worktrees/`）未实测。
- `subagent-names` / `working-directory` / `session-projection-handles` / `tool-executor-plugins` 仅静态核对「不涉及」。
- rc.3 上 `rootOf` 对缺 `parentSession` 的历史 child 会判 unknown ⇒ 复用会要求重建（fail-closed 取舍）。
- `catalog` 语义（直接子级、catalog 事件序、排除 fork 继承）与旧 `listChildren` 不完全等价。
