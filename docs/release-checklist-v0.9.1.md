# dsh-graph v0.9.1 发布检查清单

> 负责人手动执行并确认；执行代理不执行 npm publish 与 git push；本地 tag 由 supervisor 合并时按负责人授权创建。

## 发布准备验证

- [ ] `dsh-graph-host/package.json` version = `0.9.1`
- [ ] `dsh-graph-host/lib/client/constants.js` 的 `PLUGIN_VERSION` = `0.9.1`
- [ ] 已运行 `bash scripts/build-client.sh`，生成的 `dsh-graph-host/lib/client.js` 含同一版本与 generated marker，未手改产物
- [ ] `README.md` 当前版本口径为 `v0.9.1`，工具数为 38
- [ ] `dsh-graph-host/README.md` 工具表包含 38 个工具（中英文对照）
- [ ] `scripts/dev-dsh-instance.sh` PUBLISHED_VER 默认 `^0.9.1`
- [ ] `AGENTS.md` 主 profile 已发布版本说明为 `^0.9.1`
- [ ] release notes 完整纳入 g-183、g-185、g-186、g-187、g-188、g-189、g-191、g-192、g-197、g-105、g-231、g-232 等 v0.9.1 变更
- [ ] `bash scripts/sync-core.sh` 通过且无未预期 core 差异
- [ ] `node --check dsh-graph-host/index.js` 通过
- [ ] `node --check dsh-graph-host/lib/client.js` 通过
- [ ] `node --test core/tests/*.test.ts` 全绿
- [ ] `npm pack --dry-run` 通过（使用仓库内可写 cache/store）
- [ ] pack 内容仅为白名单：host `index.js`、`core/*.js`、`lib`、`cordis.patch.yml`、`supervisor-guide.md`、`README.md`、`LICENSE`、`package.json`；不含 `.ts`、tests、scripts、`.dsh-graph`、worktrees 或敏感临时数据

## 负责人发布 gate

- [ ] 复核 v0.9.1 范围与 release notes，确认 npm 包文件列表
- [ ] supervisor 合并 v0.9.1-test → main 后在 main 创建本地 tag（`git tag -a v0.9.1 -m "dsh-graph v0.9.1"`，不 push）
- [ ] 负责人手动执行 npm publish
- [ ] publish 成功后负责人手动 `git push origin main --tags`

## 验证命令

> ⚠️ 正式发布前若仓库根 `node_modules/.bin/tsc` 失效，先运行 `pnpm install` 修复本地构建链接，再执行 sync-core / prepack。

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

## 负责人手动发布命令

```sh
# 1. 切到 dsh-graph-host 目录发布（或等价命令）
cd dsh-graph-host && pnpm publish --registry=https://registry.npmjs.org --no-git-checks

# 2. 推送 main 分支与 tag（tag 由 supervisor 合并时已在 main 创建）
GIT_SSH_COMMAND="ssh -F /dev/null" git push origin main --tags
```

## 变更文件清单

| 文件 | 变更 |
|---|---|
| `dsh-graph-host/package.json` | 版本 `0.9.1-alpha` → `0.9.1` |
| `dsh-graph-host/lib/client/constants.js` | `PLUGIN_VERSION` `0.9.1-alpha` → `0.9.1` |
| `dsh-graph-host/lib/client.js` | 由 `build-client.sh` 重建 |
| `README.md` | 当前版本口径 → `v0.9.1`，工具数 28 → 38 |
| `dsh-graph-host/README.md` | 工具表更新至 38 个工具 |
| `docs/release-notes-v0.9.1.md` | 新增本版本说明 |
| `docs/release-checklist-v0.9.1.md` | 新增发布检查清单 |
| `scripts/dev-dsh-instance.sh` | 已发布版本默认值 → `^0.9.1` |
| `AGENTS.md` | 主 profile 已发布版本说明 → `^0.9.1` |
