## v0.20.1 — 2026-10-10

- **在 DSH 0.2.1 系宿主上派发不再失效**：宿主把子代理启动接口换了名字后，新宿主上任何派发都会直接失败（报 `startContinuable is not a function`）；本版把全部派发入口收口到同一处兼容层 —— 新宿主走新接口、旧宿主自动回退旧接口，两者都没有时明确报错，不再静默失败。
- **兼容性结论从此必须验「派得出去」**：新宿主上「装得上、起得来」不等于可用；宿主兼容判定固定为**安装 / 启动 / 派发可用**三个维度，缺一不得判定兼容。
- **本版这样验证**：用与用户相同的安装包在干净环境里装上后实测派发 —— 新宿主与旧宿主各成功派发一次并拿到真实子代理标识。原生 Windows 真机门禁已在本版候选包上执行，覆盖**安装 / 启动 / REST 层**（**不含「派发可用」维度**）；原生 macOS 真机门禁**本版未执行**，如实标注为「未验证」，不得读作「已通过」。
- **配置与行为零变化**：宿主兼容声明范围、设置项与看板行为均未改动；从 v0.20.0 升级无需任何手工动作。

### 安装 / 升级

```sh
dsh plugin --profile <name> add dsh-graph@0.20.1
```

从 v0.20.0 升级**无需任何手工动作**：本版只改派发入口的宿主兼容适配；宿主兼容声明范围（`engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh-settings"]` 同为 `>=0.1.5-rc.2 <0.2.2-0`）、设置项与数据格式均未改动。

### 验证与产物

- **平台真机门禁**：**原生 Windows 已实测通过**（负责人 2026-10-10 真机门禁，被测产物 = `v0.20.1` 候选包：原生 Windows `win32/x64` + Node `v24.21.0` + 宿主 DSH `0.2.0-rc.2`，T1–T5 **通过 15 / 失败 0 / 告警 1**、T3 看板文件系统生命周期 **32/32 步**、步骤清单自证 32/32；唯一告警 = 发布包内无 `core/*.ts` ⇒ 台账层未对账，属设计内 —— 逐字报告见 [`docs/platform-gate.md`](https://github.com/miuzel/dsh-graph/blob/main/docs/platform-gate.md) §7.9）。⚠️ **该结论只覆盖安装 / 启动 / REST 层，不覆盖「派发可用」维度**（T1–T5 不含派发）：派发可用维度本版在 Linux/WSL2 隔离实例上验证（见下一条），**Windows 未经真机验证** —— 不得读作 Windows 三维度齐全。**原生 macOS 本版未执行真机门禁** ⇒ **不得读出「已通过」**，两份 README 的平台状态表已按「本版未验证」如实标注（最近一次 macOS 真机结论覆盖 v0.19.8 及更早的产品代码，**不能替代**本版）。
- **派发可用维度（本版验证核心）**：按用户安装方式（**本地安装包**，即本节所列发布产物）在隔离实例中安装后实测派发 —— 新宿主（`startActivation` 形态，DSH `0.2.1-alpha.2`）与旧宿主（`startContinuable` 形态）**各自成功派发一次并拿到真实子代理标识（childId）**，即覆盖 [`docs/release-handbook.md`](https://github.com/miuzel/dsh-graph/blob/main/docs/release-handbook.md) §5.1 的三维度口径（安装 / 启动 / 派发可用）；本版正是该口径的首次完整执行（`v0.20.0` 判定当时只覆盖前两维，已如实留痕）。
- **发布产物**：`dsh-graph-0.20.1.tgz` — sha256 `94459a16ae7d8dd378230d4c8daaf0f7885d2cd68b08e67b743d28d3b2d9c22c`，sha1 `e000fc324e3537669c45551a5a983b87e80ae4e1`，1,437,660 字节，共 **43 个成员**、包内**不含 `docs/`**（`docs/` 成员数 0），包内 `package.json` 的 `version` 与包内常量 `PLUGIN_VERSION` 均为 `0.20.1`。该指纹来自**隔离 worktree 的独立构建路径**（`bash scripts/build.sh` + `dist/` 内 `npm pack`），同一构建树内**两次重复打包 sha256 逐字一致**；发布时由负责人在 tag 树上重建重打并逐字比对（见发布清单 §5）。
- **被测产物与发布产物的对齐**：第 1 轮 Windows 真机门禁的被测产物是**回填前**的候选包（sha256 `9b3e3e37…`，1437282 B，另存 `tmp/uat-v0201/dsh-graph-0.20.1.round1-9b3e3e37.tgz`）；README 平台表回填后已**重建重打**得上一条指纹 ⇒ **自第 2 轮起「被测产物 == 发布产物」**（候选包 vs 新包逐文件差异实拍 = 仅 `README.md`、42/43 逐字节相同，见 [`docs/platform-gate.md`](https://github.com/miuzel/dsh-graph/blob/main/docs/platform-gate.md) §7.9）。**第 2 轮（闭环轮）待负责人执行。**
- **发布记录**：[`docs/release-checklist-v0.20.1.md`](https://github.com/miuzel/dsh-graph/blob/main/docs/release-checklist-v0.20.1.md)（含版本一致性、夹具复冻、独立构建路径对账、自证闸门与「待负责人执行」清单）。
- **可复现性**：同一构建树内重复 `npm pack` 得同一 sha256（逐字节可复现）；跨树一致性由发布时对 tag 树重建的 sha256 比对确认。**注意**：`dist/` 内若残留上一次打包的 `.tgz`，会被当作普通文件一起打进新包 ⇒ 指纹改变，打包后务必移除 `dist/*.tgz`（tarball 另存 `tmp/`）。
