# dsh-graph v0.9.2 发布检查清单

> 本次发布由负责人指令调整顺序：supervisor 完成准备后**先推送 main + tag**，负责人最后手动执行 pnpm publish。

## Release Notes（v0.9.2，20 个目标）

### 全链路 i18n（g-230、g-262）

- 看板 UI、39 个工具描述、dsh-help 与 supervisor 接管指南、全部 LLM 提示词中英双语；
- 整篇提示词文档按语言后缀文件区分（`supervisor-guide.zh.md` / `.en.md`、`prompts/*.zh.md` / `.en.md`），保留 Markdown 可读性，zh 为唯一事实源、缺失显式抛错；
- 语言选择：看板设置可显式指定 zh/en；`follow` 模式读取 DSH `locale.preference` 跟随界面语言；
- 卡片 / handoff 注入段的插件自有标签双语化，用户原文不翻译，zh 输出逐字节不变（parity 锁定）。

### 结构化执行状态（g-247）

- `graph_report_status` 新增 `state` 枚举（working / blocked / done / error），attempt meta 持久化 + 事件记录；
- 看板「活跃执行」判断结构化状态优先，中文关键词正则降级为遗留回退（修复「尚未完成」「fixed the failing test」误判）。

### 执行派发与上下文（g-236、g-237、g-241、g-240、g-242）

- g-241：工具与 HTTP 派发统一服务，持久化完整执行契约快照（template_version / context_version / prompt_hash / 注入清单）；
- g-237：执行准入门禁前置——判据 / rules_snapshot / 状态校验全部通过才启动子代理，拒绝零副作用；
- g-236：brief 缺失时从目标描述自动生成默认 action，杜绝静默空派发；
- g-240：卡片注入预算统一（单卡截断 / 总量折叠 + digest 定位），standing 记忆按需加载；
- g-242：子代理角色契约对齐——收集者状态、只读 reviewer / PM 约束。

### 看板与 GUI（g-233、g-243、g-244、g-245、g-246、g-249、g-255、g-256、g-260）

- g-233 + g-255：目标卡片搜索（逻辑抽纯函数 + 真实回归测试）；
- g-260：目标描述弹窗内就地 Markdown 编辑（新工具 `graph_set_description`）；
- g-245：blocked 目标可拖回阻塞前状态（CAS 修复）；g-244：子代理会话中看板可用；
- g-243：版本抽屉选择自动跳转；g-246：看板设置未保存修改关闭确认；
- g-249：记忆面板来源标注、define-polish 成功提示可见性修复。

### 修复（g-234、g-238、g-239）

- g-234：最大编号目标归档后新建编号重复；g-238：system prompt 渲染纯读化（移除隐式初始化与同步 I/O）；g-239：状态汇报节流与生命周期自动投影。

### 验收期小修

- 描述 / 评论 / handoff 编辑框高度可拖拽（flex 吃掉 resize 高度）+ 最小 / 最大高度限制；
- handoff GUI 登记展开顺序 bug（`...form` 覆盖解析后的数组）修复；
- handoff 表单等残留硬编码中文标签接通既有词条。

## 发布准备验证

- [x] `dsh-graph-host/package.json` version = `0.9.2`
- [x] `dsh-graph-host/lib/client/constants.js` 的 `PLUGIN_VERSION` = `0.9.2`
- [x] 已运行 `bash scripts/build-client.sh`，生成的 `dsh-graph-host/lib/client.js` 含同一版本与 generated marker，未手改产物
- [x] `README.md` 当前版本口径为 `v0.9.2`，工具数为 39（新增 `graph_set_description`）
- [x] `dsh-graph-host/README.md` 工具表中英文均含 `graph_set_description`
- [x] `scripts/dev-dsh-instance.sh` PUBLISHED_VER 默认 `^0.9.2`
- [x] `AGENTS.md` 主 profile 已发布版本说明为 `^0.9.2`
- [x] `bash scripts/sync-core.sh` 通过且无未预期 core 差异
- [x] `node --check dsh-graph-host/index.js` 通过
- [x] `node --check dsh-graph-host/lib/client.js` 通过
- [x] `node --test core/tests/*.test.ts` 全绿（839/839）
- [x] `npm pack --dry-run` 通过，pack 内容为白名单（host 运行时 + lib + prompts/*.md + supervisor-guide.{zh,en}.md + README + LICENSE），不含 tests / scripts / .dsh-graph / worktrees

## 发布执行（本版顺序经负责人确认调整）

- [x] supervisor 合并 v0.9.2-test → main，创建 tag `v0.9.2`
- [x] supervisor 推送 main + tag 到 origin
- [ ] **负责人手动执行 pnpm publish**：

```sh
cd dsh-graph-host && pnpm publish --registry=https://registry.npmjs.org --no-git-checks
```

## 验证命令

```sh
bash scripts/sync-core.sh
bash scripts/build-client.sh
node --check dsh-graph-host/index.js
node --check dsh-graph-host/lib/client.js
node --test core/tests/*.test.ts
mkdir -p tmp/npm-cache tmp/npm-tmp
(cd dsh-graph-host && npm --cache "../tmp/npm-cache" pack --dry-run --pack-destination "../tmp/npm-tmp")
rm -rf tmp/npm-cache tmp/npm-tmp
```
