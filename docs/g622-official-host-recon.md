# g-622：多宿主官方能力 recon 与只读 MVP

## 范围与证据口径

采集日：2026-11-13（Asia/Shanghai）。基线：`5f94cee214b3e141f5e9e883d1c9b82b1084333e`。仅研究；未安装依赖、启动宿主、接触用户实例或实现 adapter。本文不修改 [g-620 matrix](<v1.0.0-host-matrix.md>) 或 [公共契约](<v1.0.0-public-contract-draft.md>)。

`supported` = 下述官方材料明确存在该**限定接口**，不是本轮实测认证；`unsupported` = 所选接口/协议明确不能提供指定语义；`unknown` = 已读材料不足以建立保证。没有文档不能证明整个产品不支持。每个单元格的来源编号见证据目录；unknown 的来源是本轮审阅范围，不是不存在的证明。

证据强度：A=版本化协议规范；B=官方公开 SDK/源码或产品文档；C=未来隔离运行证据（本轮没有）。Claude 文档为滚动版，OpenCode 分别记录 V1 与 latest，Codex 为官方 `main` 快照（未锁 commit、未绑定发行版）。因此所有 B 结论上线前均须固定产品版本再 probe，不将浏览日误写为发行版本。本轮没有使用本执行 agent 的工具列表作为 Codex 证据。

## 官方证据目录（att-001 已 fetch；本轮继承，未重新运行认证）

| ID | 产品/版本与 URL | 本轮直接可见事实 | 强度 |
|---|---|---|---|
| C1 | [Claude Code plugins，滚动文档](https://code.claude.com/docs/en/plugins.md) | 目录式插件封装 skills、agents、hooks、MCP；manifest；marketplace；本地 `--plugin-dir`；user/project/local scope；运行代码拥有用户权限 | B |
| C2 | [Claude Code MCP，滚动文档](https://code.claude.com/docs/en/mcp.md) | 客户端连 stdio/HTTP 等；环境 `CLAUDE_PROJECT_DIR`；roots/list；project MCP approval 与 workspace trust；add/remove；不能将配置写入成功等同连接成功 | B |
| C3 | [Claude Code subagents，滚动文档](https://code.claude.com/docs/en/sub-agents.md) | Agent 委派、结果、恢复、SendMessage、工具限制、worktree；插件 agent 忽略 permissionMode/hooks/mcpServers frontmatter | B |
| O1 | [OpenCode V1 plugins](https://opencode.ai/v1/docs/plugins/) | JS/TS hooks；context 含 project/client/directory/worktree/$；tool schema；permission/session/message events；启动时可自动安装包 | B |
| O2 | [OpenCode V1 SDK](https://opencode.ai/v1/docs/sdk/) | `session.create/children/prompt/abort/messages`；权限响应端点；path/config/file APIs；`createOpencode` 会启动服务，client-only 可单独连接；页面链接类型源 v1.19.4 | B |
| O3 | [OpenCode V1 MCP](https://opencode.ai/v1/docs/mcp-servers/) | local/remote MCP 客户端配置、工具注入、enabled、OAuth 与 logout；并未声明产品作为 MCP server | B |
| O4 | [OpenCode latest plugins](https://opencode.ai/docs/plugins/) | `plugins` 数组、CLI plugin add/remove、`./gui-experimental` 与独立 TUI 插件；不是 V1 配置契约 | B |
| X1 | [Codex TypeScript SDK README，main](https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md) | 包装 CLI、JSONL；startThread/resumeThread/run/runStreamed；workingDirectory/env/config；会话持久化；npm 安装形态 | B |
| X2 | [Codex ThreadOptions，main](https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/threadOptions.ts) | approvalPolicy、sandboxMode、workingDirectory、additionalDirectories；只证明可传选项，非审批回调或 OS enforcement 实测 | B |
| X3 | [Codex app-server README，main](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md) | command approval RPC；无 capable connection 时实验 human checkpoint 拒绝；account/read userId 可空；MCP discovery/resource/UI metadata；内部 worker 不可由任意客户端删；多项 experimental | B |
| X4 | [Codex config，main](https://raw.githubusercontent.com/openai/codex/main/docs/config.md) | 官方配置入口链接与 managed hooks 限制；未据此推断插件打包/卸载 API | B |
| M1 | [MCP architecture 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/architecture) | host 管权限/同意/编排；client 与 server 连接；server 暴露 tools/resources/prompts；按 capability 协商 | A |
| M2 | [MCP roots 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/client/roots) | roots 是可选 client capability，告知根范围；不指定用户交互形式 | A |
| M3 | [MCP tools 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) | tools 有 schema、由模型发现/调用；不指定 UI 形式 | A |

链接异常记录：`https://developers.openai.com/codex/sdk/` 抓取遇到跨域重定向，未当作已读证据；`https://raw.githubusercontent.com/openai/codex/main/docs/mcp.md` 为 404，未用作能力证据。使用 X1–X4 的官方公开源替代；不宣称浏览器文档不存在。

## 能力矩阵

矩阵中的“可信身份”特指可授权 graph 写入/owner/父子绑定的身份，不是模型自述、连接 ID 或可续接的 thread ID。MCP 列是 **skills 文本 + 协议 2025-06-18、未选 client/backend**，不是某个现成产品。

| 能力 | Claude Code（插件 + MCP） | OpenCode（V1 plugin/SDK；latest 单列） | Codex（TS SDK；app-server 单列） | 纯 skills + MCP |
|---|---|---|---|---|
| 插件/扩展形态 | supported：目录 manifest/skills/hooks/agents [C1] | supported：V1 JS/TS plugin [O1]；latest package [O4] | supported：外部 TS SDK embedding [X1]；通用产品插件 package API unknown [X1,X4] | supported：prompts/resources 传递 [M1]；自动识别 SKILL.md unknown（client 未选）[M1] |
| MCP 客户端 | supported：stdio/HTTP 等 [C2] | supported：local/remote [O3] | supported：app-server 发现/调用 MCP [X3]；TS SDK 配置细节 unknown [X1] | supported：协议定义 client 角色 [M1]；具体 client 未选 unknown [M1] |
| MCP 服务端 | unknown：C2 本轮所读片段仅证明 client，不能推断没有 server [C2] | unknown：文档只证明连接外部 server [O3] | unknown：app-server JSON-RPC 不等于 MCP server；本轮无 server 证据 [X3] | supported：server tools/resources/prompts 协议 [M1,M3]；实现尚未交付 |
| 可信 actor/owner 身份 | unknown：plugin/session/workspace 信息不足以证明 graph owner [C1,C3] | unknown：session ID/事件非经认证 human actor [O1,O2] | unknown：thread ID 非授权；app-server account userId 可空且不等于 graph owner [X1,X3] | unsupported：协议连接本身不授予 graph owner 身份 [M1]；部署身份映射 unknown |
| workspace/root | supported：项目环境、roots/list 与额外目录 [C2]；graphRoot 授权 unknown | supported：directory/worktree/path.get [O1,O2]；graphRoot 授权 unknown | supported：workingDirectory/additionalDirectories [X1,X2]；graphRoot 授权 unknown | supported：可选 roots/list [M2]；unsupported：roots 自行建立 OS 文件权限 [M1,M2] |
| 工具注册/schema | supported：插件 MCP 工具 [C1,C2]；任意 native tool 注入 unknown | supported：plugin tool + schema [O1] | supported：MCP 工具接入 app-server [X3]；TS SDK 任意 native tool 注入 unknown [X1] | supported：tools/list、tools/call 与 schema [M3] |
| 本地文件/Git | supported：插件代码按用户权限运行 [C1]；原子锁/Git backend 保证 unknown | supported：$ shell 与 file APIs [O1,O2]；原子锁/Git backend 保证 unknown | supported：CLI 工作于 Git repo、文件变更事件 [X1]；直接 Git API/原子锁 unknown | unsupported：协议自动提供磁盘/Git 权限 [M1]；server 自备 backend unknown |
| 子代理启动/结果 | supported：Agent 委派、独立上下文、结果 [C3] | supported：session.create/prompt/messages [O2]；这些是否满足受控 child 派发 unknown | supported：外部 SDK startThread/run/stream [X1]；其为 DSH 式受控子代理 unknown | unsupported：基础协议自带代理执行器 [M1] |
| 子代理续轮/中断/停止证明 | supported：指定类型可恢复、SendMessage [C3]；插件对所有 child 的可控停止与代际 registry unknown | supported：children/abort/messages [O2]；idle/abort 不证明已停，复用/代际 unknown | supported：resumeThread [X1]；取消/复用/内部 worker 生命周期授权 unknown [X3] | unsupported：协议会话/取消等于代理已停 [M1]；执行 backend unknown |
| 审批 | supported：workspace trust/MCP project approval；子代理权限限制 [C2,C3]；graph Human Gate 来源 unknown | supported：permission events + response API [O1,O2]；真实人来源不可由回调推定 unknown | supported：TS SDK approvalPolicy [X2]、app-server approval RPC [X3]；通用 graph human gate unknown | unsupported：基础协议自带可信 graph 人工裁决 [M1,M3]；部署审批 unknown |
| 配置 | supported：插件 scope 与 MCP 配置 [C1,C2] | supported：V1 `plugin`/mcp；latest `plugins`，不可混用 [O1,O3,O4] | supported：SDK env/config/ThreadOptions [X1,X2]；热更新 unknown | supported：capability 协商 [M1]；server 配置/skills 发现策略 unknown |
| UI/看板 | supported：当前文档称 hooks module 可绘 panes/commands [C1]；稳定看板槽位 unknown | supported：V1 TUI toast/prompt APIs [O2]；latest GUI experimental panels [O4]；稳定跨版看板 unknown | supported：app-server 保存 MCP App UI metadata [X3]；任意 client 实际渲染/稳定插件面板 unknown | unsupported：基础协议自动附带 GUI [M1,M3]；client 扩展 UI unknown |
| 安装/卸载 | supported：marketplace/local load/disable；本轮管理卸载细节 unknown [C1] | supported：V1 本地/npm load [O1]；latest add/remove [O4]；V1 清理步骤需 probe | supported：SDK npm 包安装形态 [X1]；产品插件安装/卸载 unknown [X4] | unsupported：协议替代软件包管理 [M1]；skills/server 分发与撤销需自行设计 |

注意：supported 的审批、UI、会话接口不拼接成“功能对等”。插件能执行用户代码也不意味着被宿主 sandbox 自动限制。Claude 插件 agent 的 permissionMode 被忽略 [C3]，不能靠该字段实现 reviewer 只读。MCP tool annotation、参数里的 `human=true`、server 名称和 roots 都不能替代后端授权。

## 负责人裁定后的统一 MVP（方案，未实现）

2026-11-13 返工：保留上文 att-001 官方 recon（来源未重新认证），首版路线改为**独立本地 Web App + 同一服务的 loopback MCP**。CLI 仅为 MCP client/skills consumer，不假设具有 Web UI。上文 UI 能力只是文档事实，不是选型依赖。具体服务、安全和 probe 设计见 [本地服务研究](<g622-local-web-mcp-design.md>)。以下方案覆盖旧版 stdio-first、OpenCode native-tool-first 与 Codex 导出器-first 路线。

### 每宿主最小接入（替代旧方案）

- **Claude Code**：skills + 指向统一 localhost MCP 的 client 配置；可用目录插件封装，不装 agent/hook，不依赖 pane [C1,C2]。固定版验证 HTTP transport、Authorization header 的环境注入/脱敏、scope precedence、重连、skills 发现和卸载；目前仅 docs-supported，不宣称运行认证。
- **OpenCode**：skills + localhost MCP client，不要求 V1 plugin/native tool 或 SDK 启动服务 [O3]。固定 V1 或 latest **单一发行版**，分别核验 MCP header/环境引用语法、skills 查找、禁用与配置回滚；不混用 `plugin`/`plugins`，不依赖 experimental GUI。若无法隐藏 token 或连通所选 transport，拒绝接入，不退回无鉴权。
- **Codex**：作为 localhost MCP client/skills consumer 的候选；现有 X3 仅证明 app-server 的 MCP 发现/调用，不足以认证固定版 CLI 的 HTTP header/env 注入、skills 安装、配置 scope、重连与卸载。全部待固定版 probe，不包装为已可用插件；SDK/exporter 不是当前首版替代路线。失败时给出 capability unavailable，不自动启用 SDK 执行。
- **Web App/MCP**：无 DSH 进程或 GUI 仍能列目标、读目标/判据/状态；浏览器负责展示，CLI 只返回工具文本。只读 MVP 不注册写管理或执行工具；未来写入只经可信本地人工入口及公共 application 门禁。

### 历史方案（已撤销，不可作为实施指令）

下列原段落仅保留以便比对官方 recon 的上下文；**不是当前 MVP 或安装计划**。其中 stdio-first、native plugin、导出器及管理 CLI 均被上述裁定替代。

所有 MVP 均不依赖 DSH 进程、GUI、profile 或 runtime registry。候选边界是独立 core 的**只读 store 投影** → 各宿主格式化文本；宿主专有 API 只进 adapter，skills 只含指导，MCP 仅转译协议。四种入口分别打包/测试/发布，不能给现有 DSH 安装链增加必需依赖。契约定稿前不冻结包名或新增公共 API。

### Claude Code

最小包为 skill + 本地 MCP 只读工具（列目标、读判据/状态），以插件目录封装 [C1,C2]。不装 agent/hook 模块，不依赖 pane。server 在独立受限进程以固定只读 graphRoot 工作；不注册 mutation/start/claim/accept。身份不足时返回 `trusted actor unavailable; read-only mode`。不能因 Claude 有 Agent 就自动将其当 graph executor [C3]。

后续安装 probe：负责人批准后，在临时 HOME/CLAUDE_CONFIG_DIR 和空 Git workspace 中加载离线本地插件目录；验证 skill、MCP tool schema、项目审批拒绝。卸载 probe：取消本地加载/禁用且移除本次自有插件与 MCP 配置，重启隔离会话验证工具消失；卸载命令先按固定版帮助核验，不能凭滚动文档猜。保留用户 graph 数据，配置备份逐字节回滚。

### OpenCode

最小包选择 **V1 plugin**，仅注册只读 tools + 文本响应 [O1]，不调用 SDK start/server 或 shell。plugin context 只用于显示 workspace，不授予 owner。MCP 为另一可选接入，不同时要求两条安装链。latest GUI experimental 不进入 V1 MVP [O4]。自动下载依赖风险见 O1，离线 probe 必须使用预审查包、网络禁用与私有 cache，缺依赖立即失败。

后续安装 probe：固定 V1 版本，临时 HOME/XDG config/data/cache，单一 `.opencode/plugins` 本地自有文件；验证名称不覆盖内置工具，缺 actor 时 mutation 不出现。卸载 probe：只移除该临时文件与本次配置项，重启后工具消失，graph 数据不变；latest 的 CLI remove 不照搬到 V1。

### Codex

最小可交付为独立只读导出器 + skill 指南；导出器只输出 board Markdown，用户将其提供给 Codex，不包装未经证实的“Codex 插件”。可选研究阶段用 TS SDK read-only thread 读导出的副本 [X1,X2]，但不是此最小 MVP 的必要组件；API key/account 均不视为 graph owner。不得用 SDK `run()` 自动取得审批权。

后续安装 probe：离线放置独立 skills/导出器包，移除即卸载；不写真实 `.codex`。若进一步验证 SDK，使用隔离 HOME/CODEX_HOME、固定 CLI/SDK 版本、只读 mount、无用户 credentials 的假 backend；验证 workingDirectory、stream 事件与未知 account fail-closed。app-server 审批/UI 是独立候选阶段，需明确 API 版本/experimental opt-in，不能归入 SDK 基础能力 [X3]。

### 纯 skills + MCP（无 DSH GUI）

首版为 stdio MCP server + skills 文本 + 无 GUI JSON-RPC client 的验收夹具。仅 list/read 目标、判据、状态；server 自己提供只读 filesystem store，不要求任何 AI/GUI。MCP 不运行目标、不授权文件、不产生人类身份 [M1–M3]。

“创建目标/设置判据/状态管理”可作为第二阶段：独立本地管理 CLI 由 OS 用户显式授权，server 绑定不可由 tool 参数覆盖的单用户 actor、固定 graphRoot 与允许动作；对 Human Gate 另外要求可信人工确认通道。未完成该身份/审批设计前，mutation/start/accept 均拒绝且零写入；**本轮不能宣称已实现质量判据 3 的核心写管理**。

后续安装 probe：离线 server 包与 skills 分发，独立 client stdio 握手/发现/调用，不启动任何 DSH 服务；无 roots client 仍由显式 server root 决定只读范围。卸载 probe：断开 client、确认 server 已退出、移除自有 package/skills/config；不删除 graph 数据、用户 cache 或 token。远程 HTTP/OAuth 暂不进入 MVP，避免为单用户过度设计。

## 历史验证顺序（已撤销；当前计划以本地服务研究为准）

1. **版本和边界**：先固定各产品/SDK commit、OS、模式、配置层与许可；核验本地帮助是否与上述滚动文档一致。所有 probe 位于本仓库 `tmp/g622-probe/<host>/<version>/`，不链接用户 HOME/config/cache；不接 3080 或其他用户实例，不从公网安装。
2. **无宿主 MCP**：受限单用户 JSON-RPC client 测 handshake/capability/list/read、坏 schema/未知方法、client 不支持 roots、断连与重连；可选功能缺失必须有诊断。证明无 GUI/DSH 依赖，但不把 handshake 计作文件访问授权。
3. **文件与身份负向**：只读 mount + 根外 sentinel；路径穿越/绝对路径/符号链接/未知 actor/伪造 human/跨 root 参数都拒绝，比较整个 store 树 hash，零新目录/锁/事件；无 actor 不隐式 init/claim。worktree 仅工作位置隔离，需 OS mount/权限另建边界。
4. **逐宿主只读接入**：Claude local plugin → OpenCode 固定 V1 plugin → Codex 导出器/skill（如要 SDK 另批）；逐一核验 schema、错误语义、配置 precedence、拒绝审批、安装不联网、禁用与卸载后工具消失。启动前后核对用户配置和真实 repo hash 不变。
5. **经负责人确认再拓展人工写入**：测试已授权本地用户创建目标、设判据、合法状态边；拒绝假 actor、过期确认、重复请求与越权 accept。记录 command、version、预期/实际、exit、store hash。不能用模型自然语言答“同意”当可信人工来源。
6. **执行最后验证**：只有新增执行 backend 经批准才测试 start→绑定→输出→review；覆盖消息晚到/重复、child 复用、取消未停、重启 registry unknown、输出中断、隔离失败。当前四个 MVP 不提供该执行面；未验证时返回 capability unavailable，不能造 child/results 或自动解绑。
7. **回滚与范围扩大 gate**：每宿主保存安装前配置 hash、离线包 hash、过程日志；卸载恢复配置且 graph 原样；下阶段产品代码变更才安排独立包全量回归/Windows 实测，负责人确认后扩大范围。

停止条件：probe 试图解析用户主目录配置、访问公网、安装依赖、自动启动额外服务、操作用户实例或越出临时根时立即拒绝。以上是未来计划，不是本轮执行授权或已通过的验证。

## 与 g-620 matrix 的差异台账（不改契约）

对照的是当前基线 [g-620 matrix](<v1.0.0-host-matrix.md#L5-L27>)，其 `?` 明确意为未核实/待实测，不是 unsupported。以下多为**证据层补充**，不是逻辑矛盾；运行层仍保持待实测。

| 项 | g-620 基线 | 本轮外部结论/版本/强度 | 裁决与保留 |
|---|---|---|---|
| Claude tools/root/agents | 全部 ? | C1–C3 滚动官方文档 B：明确接口 | 增补 docs-supported；不升级运行支持；identity、停止确认仍 unknown |
| OpenCode tools/session/UI | 全部 ? | O1–O3 V1 B；O4 latest B | 文档支持不等于统一产品版支持；V1 `plugin` 与 latest `plugins`/GUI 有版本差异，严禁揉合 |
| Codex threads/approval | 全部 ? | X1/X2 SDK main B；X3 app-server main B（部分 experimental） | thread ≠ 受控 child；policy ≠ human gate；不改 ExecutorPort/IdentityPort |
| UI 泛化 | 无实测为 ? | C1 panes、O4 experimental panels、X3 MCP UI metadata 均 B | 反对“所有外部宿主没有 UI”的绝对判断；也反对“都支持完整看板”的拼接推断 |
| MCP root/identity | A：接入方提供 | M1–M3 协议 2025-06-18 A | 一致；roots/tool schema 不提供 OS 权限、owner 或执行 registry |
| 未来版本漂移 | 未固定外部版本 | O2 页面类型链接 v1.19.4；X1–X4 未 pin main；C1–C3 滚动 | 不以当前网页反写旧版契约；固定版 probe 才有资格升级能力位 |

没有查到的能力保留 unknown，不为填满矩阵推测。Claude 文档新 mod、OpenCode latest GUI、Codex app-server experimental 都不进入保守 MVP。

## 本轮验证与未验证声明

验证限定为：官方链接抓取状态及可见内容核对、四宿主矩阵与三态检查、Markdown 本地引用存在性、Git diff 仅新增本文、原 matrix/契约对基线字节不变、`git diff --check`。失败链接已如实记录，不列入有效证据。

未跑产品测试、构建、宿主安装/启动或运行 probes：当前 brief 明确禁止构建/启动宿主，且只允许研究文档；整套测试包含构建/宿主副作用，不能为通用纪律突破本次禁令。无运行测试全绿声明，无新增测试或依赖。文档验收不等于当前十二条质量判据的运行安全要求全部达成。返工基线为 `d4d91fec6c576ebf4cdab353ae62008751b07893`；上述采集基线仅表示历史 recon 来源。本轮本地引用、产品路径零差异及 diff 检查单独记录，不把继承的 fetch 说成本轮执行。
