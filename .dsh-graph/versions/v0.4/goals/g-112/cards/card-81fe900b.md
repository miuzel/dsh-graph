---
{
  "id": "card-81fe900b",
  "goal": "g-112",
  "title": "DSH 插件数据目录约定调研",
  "kind": "text",
  "status": "reviewed",
  "filled_by": "agent:2c38c38d-32ae-461f-b87e-d94aa8426c82",
  "filled_at": "2026-08-22T01:10:34+08:00",
  "content_ref": null,
  "summary": "DSH 数据目录约定：$DSH_HOME（默认~/.dsh）单根下 profiles/sessions/attachments；第三方插件数据约定放工作区内（kanban 参考：sandboxPolicy.workspaceRoot 下）；官方“启动目录=默认 workspace 根”。dsh-graph 现状 host 用 process.cwd()+.dsh-graph、client bundle patch 硬编码绝对路径（不可移植）；覆盖机制=profile patch/--patch/!!js 表达式；core init() 可幂等建骨架（目前 host 未调用）。root 方案候选 4 个，倾向 workspace 根基准+用户层覆盖。",
  "child_id": "2c38c38d-32ae-461f-b87e-d94aa8426c82",
  "parent_session_id": "session-b00ed183-bc6c-4f66-b07e-e5d909c1f46b"
}
---

# DSH 插件数据目录约定调研（g-112 root 通用化前置调研）

## 1. DSH 官方的数据目录层级（权威来源：@deepseek-ai/dsh-home-paths、dsh-app-boot、实机 ~/.dsh）

- **DSH home 单根**：`resolveDshHome(configured, env)` 优先级 = 显式配置 > `$DSH_HOME` 环境变量（空/纯空白视为未设）> `~/.dsh`（dsh-home-paths/lib/index.js L73-76）。所有用户数据都在这一个根下。`dshHomePath(...)` 拼接子路径；`dshHomeDisplay()` 只显示 `~/.dsh` / `$DSH_HOME` 符号名，绝不泄露绝对机器路径。
- **home 下各目录**（实机 /home/miuzel/.dsh）：
  - `profiles/<name>/` — profile 目录（`resolveProfileDir` = `join(resolveDshHome(), "profiles", name)`，dsh-app-boot L318-321）。内含：`package.json`（manifest + `dsh.profile.bundles` 有序列表）、`cordis.yml`（空根列表，L102-106）、`cordis.patch.yml`（用户 patch 层）、`pnpm-workspace.yaml`、`node_modules/`。另有 home 级 `$DSH_HOME/cordis.patch.yml`（机器级偏好，优先级高于 profile 层，L88-96/168）。
  - `sessions/<projectKey(cwd)>/<sessionId>/session.jsonl[.zstd]` — 会话 JSONL；`projectKey()` 把 cwd 编码成可读目录键：路径分隔符→`-`、不安全字符→`~XXXX`、包 `--...--`（dsh-session-persistence-jsonl L110-141）。实例：`--home-miuzel-workspace-personal-dsh-graph--`。
  - `attachments/v1/`、`settings.yaml`、`.credentials.yaml`、`storages/workspace.json`、`storages/session_projcache.json` 等 — 内置服务统一 `join(resolveDshHome(), ...)`（attachment-local L291、credentials-local L58、settings-file L31）。
- **用户全局指令**：`$DSH_HOME/AGENTS.md`（dsh-agent-instructions USER_GLOBAL_FILE）。

## 2. 工作区根（workspace root）约定

- 官方 README（@deepseek-ai/dsh）：**“运行命令时所在的目录将作为默认 workspace 根目录”** — 启动目录 = 默认 workspace 根。
- `sandboxPolicy.workspaceRoot`：`resolveWorkspaceRoot(session?.header.cwd ?? process.cwd())`（dsh-sandbox-policy L117/142）— 会话 header 的 `cwd` 是会话工作目录，是 workspace 根的权威来源。
- **参考插件 dsh-project-kanban v0.8.3（唯一同源第三方参考，clone 于 tmp/dsh-project-kanban/）**：数据写进 **workspace 项目目录内** — `<workspaceRoot>/kanban-board-<workspaceId>.json`（README.zh：“磁盘持久化：每次改动自动写入 kanban-board-<workspaceId>.json（位于 sandboxPolicy.workspaceRoot）”；工具执行经 `exec.agent.session.header.cwd` → `ctx.workspaceRegistry.resolveByPath` 反查当前工作区）。**结论：第三方插件持久化数据的约定位置 = 当前工作区/项目目录内，而非 $DSH_HOME**。
- DESIGN.md L236 同此意图：dsh-graph 数据模型“存于 workspace（如 `.dsh-graph/` 目录），git 友好”。

## 3. dsh-graph 现状：两半 root 解析不一致（g-112 要消除的）

- host（dsh-graph-host/index.js L69）：`resolve(process.cwd(), config?.root ?? ".dsh-graph")` — 以 **process.cwd()** 为基准，默认 `.dsh-graph`。
- client（dsh-graph-client/index.js L25-27）：`config?.root ? resolve(config.root) : resolve(process.cwd(), ".dsh-graph")` — 有 config.root 时直接 resolve（相对时也以 cwd 为基准），无则 cwd/.dsh-graph。**写法不同但语义等价**。
- host bundle patch（dsh-graph-host/cordis.patch.yml）：`root: .dsh-graph`（相对、可移植 ✓）。
- client bundle patch（dsh-graph-client/cordis.patch.yml）：`root: /home/miuzel/workspace/personal/dsh-graph/.dsh-graph`（**绝对路径、不可移植 ✗** — 本目标要除掉的硬编码）。
- 当前活跃 profile（~/.dsh/profiles/web/cordis.patch.yml）：用户 patch 层手动 insert dsh-graph-host（name 用相对 specifier 指向仓库文件），root 与 marker 均硬编码绝对路径 — **这就是“不破坏本地开发”的现成机制：用户 profile patch 层覆盖**（且该文件是 hot-reload 的 watchUserPatches）。
- 注意：当前 web profile 里 client 经 `dsh plugin add` 以 bundle 层进来（package.json dependencies 有 `dsh-graph-client: link:...` 且 bundles 列表含它），host 则完全靠用户 patch 层 insert — 两半挂载路径不同，root 却必须指向同一目录。

## 4. 配置注入机制（root 从哪来、谁能覆盖）

- **层序**（dsh-app-boot composeProfile L166-198）：`bundlePatches`（dsh.profile.bundles 顺序）→ `profile.patches`（profile 目录 cordis.patch.yml）→ `homePatches`（$DSH_HOME/cordis.patch.yml）→ `overlays`（--patch 参数）→ telemetry。后者覆盖前者（同 id config 合并）。
- **bundle 层行内 specifier 以 profile 目录为基准**（不是 bundle 目录；plugin-loading-recipe 坑#3，实测）。
- **`!!js` 表达式**：patch YAML 支持 `!!js` 标量，在 Loader 激活时以 `with(ctx) { eval(expr) }` 求值（cordis-plugin-loader L279-286 evaluate；app-boot JsExpr L15-21）。**可用于在配置里动态计算 root**（例如引用 ctx 上暴露的值/环境变量）— 是“配置不写死路径”的候选机制。
- `boot()` 提供：`ctx.baseUrl` = profile 目录 URL（dsh-app-boot L1171）、`ctx.provide("dshHomePath", dshHomePath)`（L1172）— 插件 apply 里可据此解析 $DSH_HOME 子路径。
- 插件 apply 可注入的上下文服务（参考 dsh-project-kanban）：`sandboxPolicy`（workspaceRoot）、`workspaceRegistry`（resolveByPath）、`fs`、`webServer`、`tools`、`sessions`、`agent`。

## 5. 初始化约定

- **DSH 侧**：profile 首次使用自动初始化（initProfile：manifest + 空 patch 层 + pnpm-workspace.yaml；PROFILE_TEMPLATES 的 web/headless 自带 bundles）；`dsh plugin --profile <n> add` 未初始化会先 initProfile（plugin-9h8shc4d.js L84-89）。
- **dsh-graph core 侧** `init(root)`（core/ops.ts L76-93）：建 `backlog/ goals/ versions/ memory/long-term/` 目录 + `events.jsonl` + `index.json` + `rules.md`（r-init 骨架），记 `project.initialized` 事件。**不建 project.yaml、不带任何 demo 数据**。project.yaml 目前是人工创建维护的（supervisor.session / executor.provider/model 等）。
- **host apply 里目前没有调用 init()** — 仓库里 `.dsh-graph` 是现成的（git 管理）。发布后新用户装上不会有骨架，除非 apply 时调 init。

## 6. 与本目标相关的既有约定/教训

- **发现#16**（events L143）：bundle patch 硬编码 root 曾使隔离测试用了真实图数据；已修：验收脚本用用户层 patch 按 id 覆盖 config.root 指向隔离图根。**已知限制：“root 解析策略（按会话工作区）留待后续版本”** — 正是 g-112。
- **g-108 先例**（同模式）：supervisor 会话 id 不硬编码，记入 project.yaml，core 提供 `readSupervisorSession(root)` 零依赖行扫描 — 与本目标的“去硬编码”同构。
- **mem-002 dsh-plugin-pitfalls**：`--help` 吞加载失败 → 验证必须跑真实任务路径；隔离 DSH_HOME + headless + `--patch` overlay = 验收台。
- **release-handbook B1**：client patch 硬编码绝对路径是发布前置阻塞；验收点含“root 解析正确（g-112 后不再硬编码）、host/client 同一解析基准”。
- **check_plugin.sh**：验收用 `--root "$WS/.dsh-graph"` init + overlay 注入 root — g-112 后脚本可能需适配（root 解析变化时）。

## 7. root 解析方案候选（供设计定案，按证据强度）

1. **process.cwd() 基准（现状 host 默认）**：`dsh web` 从项目目录启动 → cwd = workspace 根 → `.dsh-graph` 落在项目内（符合 DESIGN “workspace 内 git 友好” + kanban 同款语义）。局限：web 进程 cwd 是启动时的工作区；多工作区场景下不是“当前会话工作区”。
2. **session.header.cwd / sandboxPolicy.workspaceRoot（kanban 同款）**：按会话工作区解析，多工作区隔离最准确；但 host apply 在会话上下文外（web 进程级），需要注入（如 webServer handler 里按请求/会话取，或固定用某工作区）。
3. **$DSH_HOME 下固定子目录**（如 `dshHomePath("dsh-graph")` 或 profile 内）：彻底机器无关、跨项目共享一份；但违背 DESIGN “git 友好/workspace 内”意图，多项目数据混在一起。
4. **config.root 覆盖链（现机制，必保留）**：bundle 层给相对默认值 → 用户 profile patch / --patch 覆盖（本地开发现状即如此）→ 可选 `!!js` 动态计算。优先级、可测试性最好，且不破坏本地开发。

**关键张力**：DESIGN 说数据在 workspace 内 git 友好（项目级、可提交），而“任意用户安装即可用”要求无硬编码。若维持 workspace 内定位，root 解析基准应是“当前工作区根”而非固定绝对路径 — 与 kanban 参考插件一致，也符合官方“启动目录 = 默认 workspace 根”语义。推荐候选：bundle patch 默认相对 `root: .dsh-graph`（host 已如此）+ host/client 统一 `resolve(workspaceRoot, root)` + 保留用户层覆盖；初始化由 host apply 调用 core init() 幂等补骨架。
