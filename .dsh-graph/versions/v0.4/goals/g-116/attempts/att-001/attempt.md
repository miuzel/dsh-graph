---
{
  "id": "att-001",
  "goal": "g-116",
  "executor": "subagent",
  "sandbox": "directory",
  "started_at": "2026-08-22T04:53:40+08:00",
  "claimed_at": null,
  "status_line": "✅ 包名改 dsh-graph 完成，等规划方修订 kanban 断言",
  "result": "pending",
  "child_id": "796d8797-cadc-48a8-aa6e-aa75eca1efd0",
  "parent_session_id": "session-b00ed183-bc6c-4f66-b07e-e5d909c1f46b"
}
---

## 执行笔记

（执行者自由记录）

### g-116 att-001 执行总结（合并单包）

**产出物**：
- `dsh-graph-host/index.js`：原 client index.js 的 webServer 端点（board/goal/accept/resolve-accept/edit-description/add-card/start-collection/start-execution/spawn-options 9 条路由）+ spawnChild/resolveSpawnParent/readSpawnOptions 全部并入；`inject` 保持 `["tools"]`，webServer 经 `ctx.get` 惰性轮询注册（首段 100ms 密轮询，10 次后 500ms，unref 不阻塞退出）——headless（仅工具）与 web（工具+端点+看板）两种组合均可用；DEBUG 行保留（`[dsh-graph-host] apply: tools + /api/dsh-graph(+goal+write) registered`）；marker 自测保留（14 工具）。
- `dsh-graph-host/lib/client.js`：原 client 看板 UI 移入（id/name/日志前缀均改为 dsh-graph-host）。
- `dsh-graph-host/package.json`：0.4.0 单包；`dsh.bundle.patch` + `dsh.client`(platform web + inject) 同包；exports 含 `./client`；files 白名单 = index.js + core/ + lib/ + cordis.patch.yml + supervisor-guide.md + README.md + LICENSE。
- `dsh-graph-host/cordis.patch.yml`：单条 insert（host+client 两个半边同由该 entry 提供——client-modules 扫描同一 entry 的 dsh.client 声明）。
- **dsh-graph-client 包已删除**（git rm -r）；scripts（sync-core.sh 单包、check_* 路径）、core/tests（client.test.ts / root.test.ts 指向单包 + 新增「单包双半」测试）、docs（DESIGN.md / README / release-handbook / recipe / recon）、core/ops.ts 注释全部更新，无残留功能引用。

**验证证据**：
- 单测 53/53 全绿（合并前基线 53/53，未回归）；
- 8 个冻结脚本全 PASS（check_core / check_cards / check_plugin / check_g107 / check_g108 / check_g109 / check_ga92e1406 / check_kanban）；
- check_plugin（headless 真实加载）：marker 14 工具 + validate PASS；
- check_kanban（隔离 web 实装）：首页含 `plugins/dsh-graph-host/client.js`、client.js 200 serving、`/api/dsh-graph` 返回正确 JSON（多次重跑稳定，修复了 webServer 轮询竞态）；
- 独立 probe：`__DSH_BOOT__` entry `dsh-graph-host` + inject `@deepseek-ai/dsh-client-runtime`；lib/client.js 浏览器契约 smoke（id= dsh-graph-host，注册 conversation.view 看板槽）；skills 注册（dsh-graph / dsh-graph-supervisor）+ 14 工具。
- core 无 .ts 泄漏，sync-core.sh 单包同步一致。

**遗留（需负责人/主管处理）**：
- 本机 live profile（`~/.dsh/profiles/web/package.json`）仍 link 已删除的 `dsh-graph-client`——不在本 workspace 沙箱内，需负责人手动更新为单包 dsh-graph-host；
- 发布 0.4.0 版本号已在 package.json 落实，发布动作属人工 gate。

## Review 记录

<!-- 受管小节 -->

### 命名更正（负责人定案，review 阶段反馈）

- npm 包名定为 **dsh-graph**（= repo 名），非 dsh-graph-host；内部 host 插件 id 保留 dsh-graph-host。
- 落点调整：package.json `name: "dsh-graph"`；cordis.patch.yml entry `name: dsh-graph`（id 保留 dsh-graph-host）；lib/client.js bundle `id`/插件 `name` = dsh-graph（client-modules 契约：load id 必须=包名，URL=/plugins/dsh-graph/client.js）；README/DESIGN/release-handbook/recon/recipe/上架清单全部改为 dsh-graph；目录名保留 dsh-graph-host/。
- 实测：`dsh plugin add` 后 link 键名=dsh-graph、node_modules/dsh-graph、__DSH_BOOT__ entry id=dsh-graph、/plugins/dsh-graph/client.js 200（/plugins/dsh-graph-host/client.js 404）；npm pack 0.4.0 tgz 解包验证 host 导出 + client bundle OK。
- **需规划方修订**：冻结脚本 check_kanban.sh 第 49/50 行 URL 断言值 `plugins/dsh-graph-host/client.js` → 应为 `plugins/dsh-graph/client.js`（包名更名引起的断言值变化，R-03 执行方不得擅改）。其余 7 个脚本只引用目录路径 dsh-graph-host/，不受包名影响，全绿。
