## v0.20.2 — 2026-10-10

- **Windows 上派发不再因「工具名对不上」而起不来**：宿主提供哪套 shell 工具（`bash` / `pwsh`）由平台条件化的组合声明决定；旧版按固定名字预置白名单，组合里装的若是另一套，Windows 上评审 / 上下文收集 / 极简执行三条派发路径会直接起不来（工具调用报 `tools.restrict() names unknown`）。本版改为**按组合实际声明的工具名解析**，缺所需能力时给出可读诊断，不再让子代理无声失败。
- **两平台门禁新增「组合与系统行为」探针层**：新增共享探针覆盖 shell 工具名解析、角色白名单求交、派发可用、路径大小写语义、换行与编码往返、命令引号与参数传递 —— 单一定义、Windows 执行件与跨平台执行件共用；组合声明一变就判红，缺真机事实时如实标注跳过，不冒充通过。
- **注入式判定不再被真实系统带跑偏**：判「大小写敏感卷」时旧实现仍去问真实文件系统，在 Windows / macOS 这类真实不敏感卷上会得出错误结论；本版让三种注入状态全部忠实、判定与真实卷解耦。同时修好 Windows 上组合声明的自动发现（旧实现调用 `npm` 不经 shell 必然失败），找不到时给出可复制的定位命令。
- **配置与行为零变化**：宿主兼容声明范围、设置项与看板行为均未改动；从 v0.20.1 升级无需任何手工动作。

### 安装 / 升级

```sh
dsh plugin --profile <name> add dsh-graph@0.20.2
```

从 v0.20.1 升级**无需任何手工动作**：本版只改「派发工具名解析 / 门禁探针 / 注入判定」；宿主兼容声明范围（`engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh-settings"]` 同为 `>=0.1.5-rc.2 <0.2.2-0`）、设置项与数据格式均未改动。

### 验证与产物

- **Linux / WSL2（本版已在发布准备轮实测）**：整套件自证闸门 2411/2411 全绿（`fail=0`/`skipped=0`，退出码 0）、`tsc --noEmit` 0 错；门禁执行件在本机（静态层）`win-smoke --self-test` 全绿、`win-smoke --static-only` 通过 8/失败 0/告警 0、`platform-smoke --static-only` 通过 14/失败 0/告警 0；回传 H3 事实后两者分别升为 9/0/0 与 15/0/0（`H3=PASS`）。逐项证据见 [`docs/release-checklist-v0.20.2.md`](https://github.com/miuzel/dsh-graph/blob/main/docs/release-checklist-v0.20.2.md)。
- **Windows 真机门禁（红线 1）**：**本版结论尚不存在** —— 候选包（见下「发布产物」）的 Round A'（静态复跑）与 Round B（完整 tarball 门禁，宿主 `0.2.1-alpha.2`）由负责人在原生 Windows 上执行；三段执行配方（Round A' / Round B / H3）与两条一手互操作事实见本地产物 `tmp/uat-v0202/WINDOWS-GATE-RECIPE.md`（`tmp/` 不入版本控制）。**在负责人回传之前，本版不得读出任何「Windows 已通过」**；回填位为 [`docs/platform-gate.md`](https://github.com/miuzel/dsh-graph/blob/main/docs/platform-gate.md) **§7.10**（Round A'，该节按纪律**保持未预填**）与 **§7.11**（Round B 与 H3，本轮新建）。
- **派发可用维度（H3，本版验证核心之一）**：T1–T5 **不含**「派发可用」维度（v0.20.1 的 T1–T5 全绿仍漏掉了本版修的这类问题），故本版把「派发可用」做成**可回传的探针**：在**隔离实例**里真实派发 `reviewer` / `collector` / `executor-minimal` 三条路径，把真 `child_id` 收成事实文件供两道门禁消费（缺事实时如实打印 `SKIP(需真机/实例)`，不冒充通过）。**Linux 隔离实例侧已跑通并回传事实**：两轮独立采集各取得三条真 `child_id`（`collector` / `executor-minimal` / `reviewer`），且同一 `child_id` 在隔离实例自己的 `cards/*.md`、`attempts/att-001/attempt.md`、`reviews/*.md` 里**独立核对命中**（即派发确实发生，而非仅响应字段）；两道门禁消费后 `H3=PASS`。命令、两次事实与门禁输出见本地产物 `tmp/uat-v0202/h3-linux-evidence.md`，采集器为 `tmp/uat-v0202/h3-collect-facts.mjs`。**Windows 侧 H3 仍待负责人按配方在真机上回传** —— 在回传之前，Windows 的派发可用维度**未经真机验证**，不得读作已通过。
- **原生 macOS**：**本版未验证** —— 未在原生 macOS 上执行真机门禁 ⇒ **不得读出「已通过」**；两份 README 的平台状态表已按「本版未验证」如实标注（最近一次 macOS 真机结论覆盖 v0.19.8 及更早的产品代码，**不能替代**本版）。
- **发布产物**：`dsh-graph-0.20.2.tgz` — sha256 `f39517c3aa0470e3aa60d9541a06842f4633523f024fd697b456e68aed0e0703`，sha1 `059fae1b6393a1d5c5c35442d10e8a24406e5683`，1,444,792 字节，共 **43 个成员**、包内**不含 `docs/`**（`docs/` 成员数 0）与 `CHANGELOG.md`，包内 `package/package.json` 的 `version` 与包内常量 `PLUGIN_VERSION` 均为 `0.20.2`；包内 `README.md` 与提交源码 `dsh-graph-host/README.md` **逐字节相同**（双方 sha256 `a2064bd7…`）。该指纹来自**隔离 worktree 的独立构建路径**（`.worktrees/g-476-att-01` 内 `bash scripts/build.sh` + `dist/` 内 `npm pack`），同一构建树内**重建重打与本产物 `cmp` 逐字节一致**（同 sha256）；发布时由负责人在 tag 树上重建重打并逐字比对（见发布清单 §5）。
- **一轮闭环（本版纪律）**：包内文件**不含任何随本轮真机结论变化的表述** —— 两份 README 的平台状态表按「结论以台账为准」+「宿主代际陈述」措辞，不写轮次计数与结论数字（包内不含 `docs/` 与 `CHANGELOG.md`）⇒ Round A' / Round B / H3 跑完后**只需回填 `docs/`**（不入包），**不会触发第 4 轮产物**。⚠️ 仍需注意（沿用上一版教训）：`dist/` 内若残留上一次打包的 `.tgz`，会被当作普通文件一起打进新包 ⇒ 指纹改变，打包后务必移除 `dist/*.tgz`。
- **发布记录**：[`docs/release-checklist-v0.20.2.md`](https://github.com/miuzel/dsh-graph/blob/main/docs/release-checklist-v0.20.2.md)（含版本一致性三处、`CHANGELOG`/守卫快照、夹具复冻、独立构建路径对账、自证闸门、H3 事实与「待负责人执行」清单）。
