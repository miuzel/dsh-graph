# dsh-graph v0.7.1 发布检查清单

> 负责人手动执行，每项确认后打 `[x]`
> 主管/执行代理**不执行** npm publish、git tag、git push——发布与推送仅由负责人在确认后手动运行。

---

## 1. 发布前验证（已完成 by att-001）

- [x] `dsh-graph-host/package.json` version = `0.7.1`
- [x] `dsh-graph-host/lib/client/constants.js` `PLUGIN_VERSION` = `0.7.1`，`lib/client.js` 经 `scripts/build-client.sh` 重建（未手改产物）
- [x] `README.md` 版本口径 = v0.7.1（保留 dsh-market 引用与两张截图）
- [x] `docs/release-notes-v0.7.1.md` 已创建，含 28 项已交付 + 排除项
- [x] `bash scripts/sync-core.sh` 通过（无 core 差异）
- [x] `node --check dsh-graph-host/lib/client.js` → 语法 OK，含 `⚠️ GENERATED FILE` 标记
- [x] `node --test core/tests/*.test.ts` → 全绿（主树 cwd）
- [x] `npm pack --dry-run`（等价 pack + tarball listing）→ version `0.7.1`，31 files / 241.7 kB，shasum `97b76cb36275be4acdfda480091b8be0c63bb068`，无 .ts/tests/scripts/.dsh-graph/.session/worktrees/mock 数据
- [x] `git diff --check` 通过（无空白错误）

### 已知环境差异（非阻塞）

- `core/tests/plugin.test.ts` 的 `g-113 host 工具按 session.header.cwd 建目标` 用例在 **worktree** 下会因 `process.cwd()` 无 `.dsh-graph` fixture 失败——在主工作树 cwd 运行全绿（v0.6.1 同款已知项，非代码回归）。
- 沙箱内 `~/.npm` 为只读（EROFS）：`npm pack` 需 `--cache` 指向可写目录（如 `--cache=/tmp/npm-cache`）。真实终端环境无此限制。
- 两张截图（`screenshot/screenshot-1.png`、`screenshot/screenshot-2.png`）位于仓库根、由根 `README.md` 引用；发布包 files 白名单不含 `screenshot/`（与 v0.6.1 一致），包内 `README.md` 不引用截图、无失效链接。

---

## 2. 发布前负责人确认

- [ ] 确认 v0.7.1 拟纳入目标范围正确（v0.7 泳道 28 项已交付）
- [ ] 确认排除目标正确（g-139、g-143、g-146 及 backlog 未排期目标）
- [ ] 确认 release notes 内容准确
- [ ] 确认升级/迁移与回退说明完整
- [ ] 确认发布包不含敏感/临时/mock 数据

---

## 3. 合并到 main 并构建

```sh
# 在主工作树执行
cd /home/miuzel/workspace/personal/dsh-graph
git checkout main
git merge g-182-att-01 --no-ff -m "chore(release): merge v0.7.1 release-prep"
```

---

## 4. 发布前完整构建与验证

```sh
cd /home/miuzel/workspace/personal/dsh-graph

# 4.1 重新构建 client.js（从模块化源文件组装）
bash scripts/build-client.sh

# 4.2 同步 core 编译产物到发布包
bash scripts/sync-core.sh

# 4.3 client.js 语法检查
node --check dsh-graph-host/lib/client.js

# 4.4 全量测试（主树 cwd）
node --test core/tests/*.test.ts
# 预期：全绿

# 4.5 pack dry-run（核验包内容与版本）
cd dsh-graph-host && npm pack --dry-run && cd ..
# 预期：version 0.7.1，无意外文件、无 .ts 泄漏、无 .dsh-graph/.session/mock 数据
```

---

## 5. npm 认证与发布（负责人执行；主管/代理不运行）

```sh
cd /home/miuzel/workspace/personal/dsh-graph

# 5.1 验证 npm 登录态（显式官方 registry；不使用 npm login，若失败需负责人手动解决凭据）
npm whoami --registry=https://registry.npmjs.org
# 预期：输出 npm 用户名
# 若报 ENEEDAUTH：设置 NODE_AUTH_TOKEN 环境变量或更新 ~/.npmrc 中
#   //registry.npmjs.org/:_authToken=<token>

# 5.2 发布（显式官方 registry + --access public；不使用 --no-git-checks）
cd dsh-graph-host
pnpm publish --registry=https://registry.npmjs.org --access public
# 等价命令：npm publish --registry=https://registry.npmjs.org --access public
```

> 注意：本机 `~/.npmrc` 可能指向 npmmirror 镜像——必须显式指定官方 registry。
> `--no-git-checks` 不应使用：merge 到 main 后工作树应干净，正常 git 检查是安全网。

---

## 6. 仅 publish 成功后：tag 和 push（负责人执行）

```sh
cd /home/miuzel/workspace/personal/dsh-graph

# 6.1 打 tag
git tag -a v0.7.1 -m "v0.7.1: 目标类型/判据编辑/更新强调/浅色主题/配置管理/看板交互"

# 6.2 推送 main + tag
GIT_SSH_COMMAND="ssh -F /dev/null" git push origin main --tags
```

> `GIT_SSH_COMMAND="ssh -F /dev/null"` 绕过本机 `/etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf` 权限问题（实机验证，见 docs/release-prep-gh-recon.md §1）。

---

## 7. 发布后验证（负责人执行）

```sh
# 7.1 核验 npm 版本
npm view dsh-graph version --registry=https://registry.npmjs.org
# 期望输出：0.7.1

# 7.2 全新 profile 安装验收（可选）
DSH_HOME=/tmp/dsh-v071-check dsh plugin --profile test add dsh-graph
DSH_HOME=/tmp/dsh-v071-check dsh --profile test "graph_help"
# 期望：graph_* 工具注册成功，help 输出包含版本信息

# 7.3 清理验收环境
rm -rf /tmp/dsh-v071-check
```

---

## 8. 可选：清理 worktree

```sh
# 发布确认无误后
cd /home/miuzel/workspace/personal/dsh-graph
git worktree remove .worktrees/g-182-att-01
git branch -d g-182-att-01
```

---

## 变更文件清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `dsh-graph-host/package.json` | 修改 | version 0.6.1 → 0.7.1 |
| `dsh-graph-host/lib/client/constants.js` | 修改 | `PLUGIN_VERSION` 0.6.1 → 0.7.1 |
| `dsh-graph-host/lib/client.js` | 重建 | `build-client.sh` 生成（含 `PLUGIN_VERSION` 0.7.1） |
| `README.md` | 修改 | 版本口径 → v0.7.1 |
| `docs/release-notes-v0.7.1.md` | 新增 | 28 项已交付 + 排除 + 迁移/回退 |
| `docs/release-checklist-v0.7.1.md` | 新增 | 逐项确认清单 + 负责人手动命令 |
| `scripts/dev-dsh-instance.sh` | 修改 | `PUBLISHED_VER` 默认 ^0.6.1 → ^0.7.1 |
| `AGENTS.md` | 修改 | `main-published` 注释 ^0.6.1 → ^0.7.1 |
