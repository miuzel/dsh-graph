# dsh-graph / goal-graph v1.0.0 发布清单

## 1. 版本号与声明面一致性

- [x] 包清单真源：[dsh-graph-host/package.json](../dsh-graph-host/package.json) `version = "1.0.0"`、`name = "dsh-graph"`、`bin.goal-graph = "./bin/goal-graph.mjs"`
- [x] 客户端常量：[dsh-graph-host/lib/client/constants.js](../dsh-graph-host/lib/client/constants.js) `PLUGIN_VERSION = "1.0.0"`
- [x] 宿主兼容范围：`engines.dsh === peerDependencies["@deepseek-ai/dsh-settings"] === ">=0.2.2-rc.3 <0.2.3-0"`
- [x] 根 [README.md](../README.md)、包内 [dsh-graph-host/README.md](../dsh-graph-host/README.md)（中英）与 [CHANGELOG.md](../CHANGELOG.md) 全部对齐 `v1.0.0`
- [x] 5 个打包产物版本统一 `1.0.0`（`node scripts/pack-packages.mjs --check` 通过）

## 2. 看板目标收口（`v1.0.0` 泳道）

- [x] 全部 **20 / 20** 目标已交付（`delivered`），零结果真空（均有 `results.md`）：
  - 已交付基础项：`g-393`、`g-474`、`g-620`、`g-621`、`g-622`、`g-628`
  - 负责人批量验收交付（14 项）：`g-314`、`g-315`、`g-316`、`g-317`、`g-615`、`g-623`、`g-627`、`g-629`、`g-630`、`g-631`、`g-632`、`g-633`、`g-634`、`g-637`

## 3. 自动化与实机门禁结论

- [x] `bash scripts/build.sh` exit 0（原子发布，`dist/` 共 112 文件，含 3 张交互图）
- [x] `./node_modules/.bin/tsc --noEmit -p tsconfig.json` exit 0
- [x] `TMPDIR=/tmp node scripts/run-tests.mjs` 自证通过：`tests=3332 pass=3332 fail=0 skipped=0 cancelled=0 todo=0 exit=0`
- [x] `claude plugin validate plugins/claude-code` → `✔ Validation passed`（0 error）
- [x] `TMPDIR=/tmp node scripts/g633-opencode-mcp-probe.mjs` → `pass=12 fail=0 skip=1 exit=0`（`/tmp` 零残留）
- [x] 跨平台静态与 OS 台账门禁：`node scripts/win-smoke-test.mjs --static-only .` → PASS（通过 8 / 失败 0 / 告警 0，台账 86 项 / 296 处命中未登记 0）
- [x] Linux / WSL2 浏览器端到端实机验证：DSH `0.2.2-rc.5` + `dsh-graph@1.0.0` + Claude Code 零配置 stdio MCP 实机全通
- [x] 原生 macOS 实机验证：实机安装通过；`win-smoke-test.mjs --tarball`（T1–T5）与 `platform-smoke-test.mjs --skip-build --tarball`（P1–P3 + T1–T5）双 PASS（未跑 P4–P6，见 [docs/platform-gate.md](platform-gate.md) §7.14）
- [ ] 原生 Windows 完整 T1–T5 命令行脚本：DSH Desktop 实机安装已通过、未见严重缺陷；完整 `win-smoke-test.mjs --tarball` 命令行复跑待按需补齐（README 与 platform-gate §7.14 已如实标注）

## 4. 5 包交付产物（由 `main` 上 `v1.0.0` tag 树构建产出）

产物位于 `out/`，校验和清单以 `out/SHA256SUMS.txt` 为准：

| npm 包名 | 文件名 | 说明 |
|---|---|---|
| `dsh-graph` | `dsh-graph-1.0.0.tgz` | DSH 插件本体（含 53 工具、二维看板 UI、56 prompts、9 diagram 文件） |
| `goal-graph-cli` | `goal-graph-cli-1.0.0.tgz` | 跨宿主独立 CLI（`goal-graph`，含 `mcp` stdio 与 `serve`） |
| `goal-graph-service` | `goal-graph-service-1.0.0.tgz` | 独立本地服务与 stdio MCP 运行时 |
| `goal-graph-skills` | `goal-graph-skills-1.0.0.tgz` | 技能正文与安装器（`goal-graph-skills`） |
| `goal-graph-mcp` | `goal-graph-mcp-1.0.0.tgz` | 三宿主 MCP 配置生成器（`goal-graph-mcp`） |

## 5. 发布操作命令（须由负责人人工核对后执行）

```bash
# ① 推送 main 与 v1.0.0 tag 到远端
git push origin main
git push origin v1.0.0

# ② 按序发布 5 个 npm 包（全部使用 main + v1.0.0 tag 树构建出的 out/*.tgz）
npm publish out/dsh-graph-1.0.0.tgz --access public
npm publish out/goal-graph-cli-1.0.0.tgz --access public
npm publish out/goal-graph-service-1.0.0.tgz --access public
npm publish out/goal-graph-skills-1.0.0.tgz --access public
npm publish out/goal-graph-mcp-1.0.0.tgz --access public

# ③ （可选）创建 GitHub Release
gh release create v1.0.0 out/*.tgz out/SHA256SUMS.txt \
  --title "v1.0.0" \
  --notes-file docs/release-notes-v1.0.0.md
```
