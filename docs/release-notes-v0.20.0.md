## v0.20.0 — 2026-10-09

- **支持 DSH 0.2.1 系宿主**：宿主兼容范围由 `>=0.1.5-rc.2 <0.2.1-0` 放宽为 `>=0.1.5-rc.2 <0.2.2-0`（上界 `-0` 现在排除 `0.2.2` 的一切预发布与正式版，整条 `0.2.1` 线纳入范围），并在隔离实例上以 `0.2.1-alpha.2` 宿主（**未使用**任何版本豁免）完成安装与启动，旧基线复测不回归。⚠️ 宿主的安装/启动门禁**只读 `peerDependencies`、不读 `engines.dsh`**，故 `engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh-settings"]` 必须**同步**放宽——只改前者无效，安装期仍会被硬拒绝。
- **升级宿主后旧设置不再丢**：旧 `settings.yaml` 里的 `dsh-graph` 节会一次性、幂等地补进新的 `dsh-graph-host` 条目（重复执行不会重复导入，读取仍保留回退），该升级路径已在真实宿主上做过端到端验证。
- **Agent Teams 协作模式（默认关闭）**：同一次执行内可扇出多个成员并行推进，并指定独立验证者对结果交叉核验；开关关闭时提示词与行为与旧版逐字一致。
- **不再产出坏数据、也不再静默失效**：设置写入的父级不是块式映射时直接拒绝（不再返回成功却写出非法 YAML）；工作树归属标记改为原子写入，中途失败不再留下半个标记、导致清理面保护静默失效。
- **设计过程看得见、状态不用猜**：看板标题栏新增「Graph 设计」入口，弹窗内嵌两张可交互流程图（随包发布、经只读路由提供），并有中英双语文档说明开发流程；新一轮对话开始时先显示「正在处理…」占位，不必盯着空白等首字。

### 安装 / 升级

```sh
dsh plugin --profile <name> add dsh-graph@0.20.0
```

从 v0.19.8 升级无需手工迁移：宿主兼容范围与旧设置迁移都在安装 / 首次读取时自动完成（见上文第 1、2 条）。

### 验证与产物

- **平台真机门禁**：原生 Windows（`win32/x64`，Node `v24.21.0`，宿主 DSH `0.2.0-rc.2`）在**本版终版发布包**上实测通过 —— `win-smoke` T1–T5 **15 通过 / 0 失败 / 1 设计内告警**，看板文件系统生命周期 **32 步全通过**（唯一告警为设计内：`--tarball` 轮包内只有编译产物、无 `core/*.ts`，台账对账改在仓库根完成）；**原生 macOS 本版未验证**（不得读作「已通过」）；Linux / WSL2 整套件自证闸门通过（`tests=2353 / pass=2353 / fail=0 / skipped=0 / todo=0 / cancelled=0`）。Windows 门禁经 WSL↔Windows 互操作执行，与纯原生场景的 4 点差异已逐条登记。逐字报告见 [`docs/platform-gate.md`](https://github.com/miuzel/dsh-graph/blob/main/docs/platform-gate.md) §7.8。
- **发布产物**：`dsh-graph-0.20.0.tgz` — sha256 `51d7de25134725c1955a5d6a177352a2ae53f10c39b1af1678311d714ae86e5a`，sha1 `01590980f4800e5c9c8d442fc62ade11802ef482`（npm 注册表上的 `dist.shasum` 与此 sha1 逐字节一致，`dist.integrity` 亦逐字一致；共 43 个成员）。**Windows 真机测过的包、npm 上发布的包与 GitHub release 附件是同一份字节**（GitHub 附件服务端 digest 同为 `sha256:51d7de25…`）。
- **发布记录**：[`docs/release-checklist-v0.20.0.md`](https://github.com/miuzel/dsh-graph/blob/main/docs/release-checklist-v0.20.0.md)（含候选包→终版包逐次差异、可复现性、发布后对账）。
- 从源码构建的版本与本 tag 逐字节可复现（同一 `build.sh` + `npm pack` 得同一 sha256）—— 本版经**三条独立构建路径**（发布准备树 / 真机被测树 / 集成审计树）交叉验证，产物 sha256 完全一致。
