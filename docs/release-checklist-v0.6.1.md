# dsh-graph v0.6.1 发布检查清单

> 负责人手动执行，每项确认后打 `[x]`

---

## 1. 发布前验证（已完成 by att-001）

- [x] `dsh-graph-host/package.json` version = `0.6.1`
- [x] `README.md` 版本引用 = `0.6.1`
- [x] `docs/release-notes-v0.6.1.md` 已创建，含 12 项已交付 + 7 项排除
- [x] `tsc` 编译通过：`bash scripts/sync-core.sh` → 7 个 `.js` 产物，无 `.ts` 泄漏
- [x] `node --check dsh-graph-host/lib/client.js` → 语法 OK
- [x] `client.js` 含 `⚠️ GENERATED FILE` 标记
- [x] `node --test core/tests/*.test.ts` → **343/343 pass**（主树）
- [x] `npm pack --dry-run` → 28 files, 172.8 kB, shasum `473e1d1e134085c1b829f28a243a8a332d40cff9`
- [x] Parent/inner Git 边界：父仓库 `.gitignore` 排除 `/.dsh-graph/`，内层仓库无 remote

### 已知环境差异（非阻塞）

`core/tests/plugin.test.ts` 第 93 行 `g-113 host 工具按 session.header.cwd 建目标` 在 worktree 环境下失败 1 次：
- **原因**：测试第 105 行 `findGoalFile(resolveRoot({}, process.cwd()), out.goal)` 假设 `process.cwd()` 下有含目标的 `.dsh-graph`——主树有（项目数据），worktree 无
- **影响**：无。测试验证的是"数据不落到服务进程 cwd"，与发布包功能无关；主树 343/343 全绿
- **建议**：后续可改进测试，用独立 temp dir 替代 `process.cwd()` 依赖

---

## 2. 发布前负责人确认

- [ ] 确认 v0.6.1 拟纳入目标范围正确（12 项已交付）
- [ ] 确认排除目标正确（g-146, g-153, g-143, g-138, g-139, g-132/133, g-136）
- [ ] 确认 release notes 内容准确
- [ ] 确认升级/迁移说明覆盖 `.dsh-graph` 数据仓库解耦
- [ ] 确认回退说明完整

---

## 3. 合并到 main 并构建

```sh
# 在主工作树执行
cd /home/miuzel/workspace/personal/dsh-graph
git checkout main
git merge release-prep/v0.6.1 --no-ff -m "chore(release): merge v0.6.1 release-prep"
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

# 4.4 全量测试
node --test core/tests/*.test.ts
# 预期：343/343 pass
# 已知：若在 worktree 中运行，plugin.test.ts:93 会因缺少 .dsh-graph fixture 失败 1 条
# （process.cwd() 耦合测试环境，非代码回归；在主树运行可全绿）

# 4.5 pack dry-run（核验包内容）
cd dsh-graph-host && npm pack --dry-run && cd ..
# 预期：28 files, ~173 kB, 无意外文件、无 .ts 泄漏
```

---

## 5. npm 认证与发布

```sh
cd /home/miuzel/workspace/personal/dsh-graph

# 5.1 验证 npm 登录态（不使用 npm login；若失败需负责人手动解决凭据）
npm whoami --registry=https://registry.npmjs.org
# 预期：输出 npm 用户名
# 若报 ENEEDAUTH：设置 NODE_AUTH_TOKEN 环境变量或更新 ~/.npmrc 中
#   //registry.npmjs.org/:_authToken=<token>

# 5.2 发布（注意：不使用 --no-git-checks，依赖正常 git 状态校验）
cd dsh-graph-host
pnpm publish --registry=https://registry.npmjs.org
```

> 注意：本机 `~/.npmrc` 可能指向 npmmirror 镜像——必须显式指定官方 registry。
> `--no-git-checks` 不应使用：merge 到 main 后工作树应干净，正常 git 检查是安全网。

---

## 6. 仅 publish 成功后：tag 和 push

```sh
cd /home/miuzel/workspace/personal/dsh-graph

# 6.1 打 tag
git tag -a v0.6.1 -m "v0.6.1: 版本泳道生命周期、数据仓库解耦、上下文卡片增强、客户端重构"

# 6.2 推送 main + tag
GIT_SSH_COMMAND="ssh -F /dev/null" git push origin main --tags
```

> `GIT_SSH_COMMAND="ssh -F /dev/null"` 绕过本机 `/etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf` 权限问题（实机验证，见 docs/release-prep-gh-recon.md §1）。

---

## 7. 发布后验证

```sh
# 7.1 核验 npm 版本
npm view dsh-graph version --registry=https://registry.npmjs.org
# 期望输出：0.6.1

# 7.2 全新 profile 安装验收
DSH_HOME=/tmp/dsh-v061-check dsh plugin --profile test add dsh-graph
DSH_HOME=/tmp/dsh-v061-check dsh --profile test "graph_help"
# 期望：graph_* 工具注册成功，help 输出包含版本信息

# 7.3 清理验收环境
rm -rf /tmp/dsh-v061-check
```

---

## 8. 可选：清理 worktree

```sh
# 发布确认无误后
cd /home/miuzel/workspace/personal/dsh-graph
git worktree remove .worktrees/g-144-release-prep
git branch -d release-prep/v0.6.1
```

---

## 变更文件清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `dsh-graph-host/package.json` | 修改 | version 0.5.2 → 0.6.1 |
| `README.md` | 修改 | 版本引用 0.5.1 → 0.6.1 |
| `docs/release-notes-v0.6.1.md` | 新增 | 完整 release notes、迁移、回退、限制 |
| `docs/release-checklist-v0.6.1.md` | 新增 | 逐项确认清单 + 手动命令 |

## 附注：scripts/migrate-dsh-graph-repo.sh 不在 npm 包内

迁移脚本 `scripts/migrate-dsh-graph-repo.sh` 仅在源码仓库中提供。
npm 发布包（`dsh-graph-host/`）的 `files` 白名单不包含 `scripts/` 目录。
需要运行迁移的用户应从 v0.6.1 源码 checkout 获取该脚本（见 release notes 升级步骤）。
