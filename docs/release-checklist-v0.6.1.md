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
- [x] `node --test core/tests/*.test.ts` → **343/343 pass**（主树；worktree 342/343 为环境耦合，见下方说明）
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

## 3. 合并到 main

```sh
# 在主工作树执行
cd /home/miuzel/workspace/personal/dsh-graph
git checkout main
git merge release-prep/v0.6.1 --no-ff -m "chore(release): merge v0.6.1 release-prep"
```

---

## 4. npm 发布（需先登录官方 registry）

```sh
# 前置：登录（需要负责人凭据）
npm login --registry=https://registry.npmjs.org

# 发布
cd /home/miuzel/workspace/personal/dsh-graph/dsh-graph-host
pnpm publish --registry=https://registry.npmjs.org --no-git-checks
```

> 注意：本机 `~/.npmrc` 可能指向 npmmirror 镜像——必须显式指定官方 registry。

---

## 5. Git tag（发布后）

```sh
cd /home/miuzel/workspace/personal/dsh-graph
git tag -a v0.6.1 -m "v0.6.1: 版本泳道生命周期、数据仓库解耦、上下文卡片增强、客户端重构"
git push origin main --tags
```

---

## 6. 发布后验证

```sh
# 6.1 核验 npm 版本
npm view dsh-graph version --registry=https://registry.npmjs.org
# 期望输出：0.6.1

# 6.2 核验包内容
curl -s https://registry.npmjs.org/dsh-graph/0.6.1 | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('version:', d.version);
  console.log('files:', Object.keys(d.dist || {}).join(', '));
"

# 6.3 全新 profile 安装验收
DSH_HOME=/tmp/dsh-v061-check dsh plugin --profile test add dsh-graph
DSH_HOME=/tmp/dsh-v061-check dsh --profile test "graph_help"
# 期望：graph_* 工具注册成功，help 输出包含版本信息

# 6.4 清理验收环境
rm -rf /tmp/dsh-v061-check
```

---

## 7. 可选：清理 worktree

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
