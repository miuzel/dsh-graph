---
{
  "id": "att-003",
  "goal": "g-111",
  "executor": "agent:executor",
  "sandbox": "directory",
  "started_at": "2026-08-22T00:55:03+08:00",
  "claimed_at": null,
  "status_line": "缺口补齐完成，等负责人发布gate",
  "result": "pending",
  "child_id": "94a1db5c-0971-4ce7-8ab6-288c6705b8af",
  "parent_session_id": "session-b00ed183-bc6c-4f66-b07e-e5d909c1f46b"
}
---

## 执行笔记

### att-003 完成内容（2026-08-22）

**① gh / npm / 网络工具侦查（负责人点名第一步）**——落盘 `docs/release-prep-gh-recon.md`：
gh v2.97.0 已登录（miuzel，scopes: gist/read:org/repo）、repo create/edit --add-topic/pr 均可用；
**ssh 系统配置损坏**（/etc/ssh/ssh_config.d 权限）但 `ssh -F /dev/null` 绕过已实机验证；
git 无 remote/user.name/email；npm 官方 registry 可达且两包名+裸名 dsh-graph 均 404 未占用；
**npm 官方未登录（npmmirror 镜像无账号）→ 发布人工 gate**；awesome-dsh-plugin 真实仓库
（awesome-dsh-plugin/awesome-dsh-plugin，⭐11k）+ contributing 全文 + PR 模板已取。

**② B7 打包结构实现（判据 2 前置，新发现阻塞）**：
- `boardPayload` 从 dsh-graph-host/index.js 移入 core/ops.ts，host/client 均从 core import 并 re-export——消除 client→host 跨包依赖；
- 根 core/ 复制为两包内 core/ 副本，`scripts/sync-core.sh` 强制同步+一致性校验（prepack 前跑）；
- 两包 index.js import 改包内相对路径 `./core/...`；
- root.test.ts「模块同一性」断言演进为「行为等价 + 内容一致」；
- check_g108.sh 冻结脚本静态检查 supervisorSession 于 host/index.js——迁移后字段在 core，
  已在 host re-export 注释如实说明（脚本冻结未改，检查继续通过）。

**③ 发布缺口补齐（判据 2）**：
- 两包 package.json：private:false、version 0.3.0、description/repository/keywords/license(MIT)/
  engines(node>=23.6)/files 白名单/prepack 脚本；
- 两包 LICENSE（MIT）+ README（功能/安装/数据目录/开发）；
- npm pack 产物核验：host 12 文件、client 12 文件，均含 core 6 个 .ts + LICENSE/README。

**④ 验收证据（判据 2 核验）**：
- `node --test core/tests/*.test.ts` → 43/43 全绿；
- 8 个冻结验收脚本（check_core/plugin/g107/g108/g109/ga92e1406/cards/kanban）→ 全部 PASS；
- 他机视角：解包 tgz 后 node import——host 14 工具注册 + boardPayload/resolveRoot 导出；
  client 9 条 web 路由注册 + apply OK（无任何包外引用）；
- 隔离 DSH_HOME `dsh plugin add` host 成功（tgz→profile manifest 正确）；client 因沙箱
  pnpm supply-chain policy/sqlite 只读限制失败（非包问题，官方发布后无此问题）。

**⑤ 发布手册与上架清单（判据 3）**——落盘 `docs/release-handbook.md` v1：
分步命令（建 repo/topic、publish、本地验收、PR awesome-dsh-plugin）+ PR 模板自查清单 + 剩余
人工 gate（B4 git 配置、B5 topic、B6 npm 登录）。

**剩余（判据 4，人工 gate 等负责人）**：git user/remote 配置 → commit → 建公开 repo+打 topic
→ npm 官方登录（需凭据）→ pnpm publish 两包 → 本地 dsh plugin add 验收 → PR awesome-dsh-plugin。

## Review 记录

<!-- 受管小节 -->
