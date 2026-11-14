# dsh-graph v0.24.1 发布检查清单

> 本文件状态：发布准备就绪（两项 rc.3 兼容修复已交付、版本串与文档已同步、发布树全量自证通过、
> 发布包已打包、Windows 原生门禁 PASS）。**合 main / tag / publish 尚未执行**，仍待负责人放行。

## 0. 本版核心变更概述

v0.24.1 是**紧急兼容补丁**，只修 DSH `0.2.2-rc.3` 适配，不含新功能。

1. **修复 provider 探测误判**（g-624）：rc.3 删除 `subagents.list()`，旧代码 `list?.() ?? []` 把「查不到」折叠为空数组，导致派发恒报「无可用 subagent provider（已注册：无）」。改为 rc.1 保留枚举、rc.3 用具名 `getProvider('spawn'/'fork')`，未知/异常/默认缺失分开诊断。
2. **修复激活参数结构不兼容**（g-624）：rc.3 移除了 `startActivation` 的嵌套 `request`，改为扁平 spec 且 `delivery` 必填。`startSubagentCompat` 单点构建双形态（有 `list()` ⇒ 嵌套；无 `list()` ⇒ 扁平），两形态都显式 `delivery: "parent"`。
3. **适配被删除的中断 API**（g-625）：rc.3 删 `interruptByParent`，本地改用 `interrupt(child, {kind:"ancestor", agent})`；`interruptByUser` 是 Remote/Gateway 面，插件不使用。
4. **适配被删除的子级目录 API**（g-625）：`listChildren` → `sessionQuery.observeSession` 的 `subagentCatalog` 投影；缺投影/异常一律按 unknown，绝不当作「没有 child」。
5. **适配被删除的归属 API**（g-625）：`agents.isOwnedBy` → `subagents.rootOf` 比较 Agent 对象身份 + `header.parentSession`；19 处文本面收敛为 8 个功能面。
6. **修复 rc.3 上关照不可用**（g-626）：`rootOf` 抛错时会直接判「不可确认」，导致 `children_probe` 不可用、关照整体不采样。改为回退到公开 `parentSession`（相等⇒yes / 指向他人⇒no / 缺失⇒unknown），UNAUTHORIZED 本身绝不放行。

## 1. 版本号一致性核查

- [x] 包清单版本：`dsh-graph-host/package.json` -> `"version": "0.24.1"`
- [x] 客户端常量：`dsh-graph-host/lib/client/constants.js` -> `const PLUGIN_VERSION = "0.24.1";`
- [x] 根目录 README：`README.md` -> `当前版本 v0.24.1` 与 `最新亮点（v0.24.1）`
- [x] CHANGELOG：`CHANGELOG.md` -> `## v0.24.1 — 2026-11-14`（4 条要点，无过程痕迹）
- [x] 构建产物：`dist/package.json` 由构建生成，实测 `0.24.1`
- [x] `g-371` 版本/变更史守卫：10/10 通过（含快照 `v0.24.1: 4 条`）

## 2. 门禁与自证（发布树）

发布树：`.worktrees/release-v0.24.1`（detached at `fd1062e`，等价于待打 tag 的树）。

- [x] 全套测试（**rc.3 宿主栈**）：`node scripts/run-tests.mjs` -> `tests=3013 pass=3013 fail=0 skipped=0 todo=0 cancelled=0 exit=0 ms=91604`
- [x] 宿主栈固定并记录：`G505_HOST_STACK_DIR=.../lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`，实测 `dsh=0.2.2-rc.3`、`dsh-subagent=0.2.2-rc.3`（此前该栈为 rc.1，全局升级后必须先固定再跑门禁）
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

- [x] 候选包文件名：`dsh-graph-0.24.1.tgz`（86 个文件）
- [x] 文件体积：1,713,581 字节
- [x] SHA-256：`6f05e8a15cdb521cfa35c0619031165776ea850503d2294cf78138dca417a0e2`
- [x] SHA-1：`48fa98816a2cf946c84002192185f0a05c94456e`
- [x] 隔离性核验：包内无 `.tgz` / `.git` 残留；产物位于发布树 `tmp/pack2/`（不入库）
- [x] 可复现性：同一发布提交 `fd1062e` 两次打包 SHA-256 逐字相同；Windows 门禁校验的正是该指纹（见 T2 段）

## 5. Windows 原生门禁（红线）

- [x] 在**原生 Windows** 上用 `pwsh` 运行 `node win-smoke-test.mjs --tarball dsh-graph-0.24.1.tgz --port 3091 --h3-dispatch-json h3-facts.json`
- [x] T2 实测被测产物指纹：`1713581 B sha256=6f05e8a1…`（即本节第 4 节的包）
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

## 6. 发布步骤（人工 gate）

- [x] 合入 `main`：`v0.24.1-test` 以 fast-forward 合入 `main`（本地，未推送）
- [ ] 打 tag `v0.24.1` 并推送
- [ ] `npm publish`
- [ ] GitHub Release 正文与 awesome-dsh-plugin 更新（按 `docs/release-handbook.md`）

### 发布自检（按顺序执行）

```bash
git switch main && git log --oneline -1          # 应为 v0.24.1 发布提交
git tag -a v0.24.1 -m "dsh-graph v0.24.1"        # 负责人执行
git push origin main --follow-tags               # 负责人执行
npm publish ./dsh-graph-0.24.1.tgz               # 负责人执行（tarball sha256 见第 4 节）
```

## 7. 已知限制（如实记录）

- `interrupt` 迁移、catalog 孤儿回收、复用**成功**路径仅单测 + rc.3 宿主桩覆盖，真机未触发。
- `archive-worktrees`（rc.3 归档会话是否影响 graph 自管 `.worktrees/`）未实测。
- `subagent-names` / `working-directory` / `session-projection-handles` / `tool-executor-plugins` 仅静态核对「不涉及」。
- rc.3 上 `rootOf` 对缺 `parentSession` 的历史 child 会判 unknown ⇒ 复用会要求重建（fail-closed 取舍）。
- **发布门禁对宿主版本敏感**：真实宿主测试按 `npm root -g` 解析宿主栈。本次全局宿主在改版过程中被从 rc.1 升到 rc.3（rc.1 全绿 → rc.3 出现 7 条关照失败）。今后跑门禁必须显式固定 `G505_HOST_STACK_DIR` 并记录实测版本，否则"全绿"结论会随环境漂移。
- **H3 事实的采集时点**：三条真机派发事实（reviewer/collector/executor-minimal）采集于 g-625 构建；g-626 只改归属探测回退，未改派发准入/启动路径。rc.3 宿主栈上的**全量门禁**（3013/3013）是在 g-626 构建上跑的。
- `catalog` 语义（直接子级、catalog 事件序、排除 fork 继承）与旧 `listChildren` 不完全等价。
