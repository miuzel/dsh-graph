# dsh-graph v0.7.3 发布检查清单

> 负责人手动执行并确认；执行代理不执行 `npm publish`、`git tag` 或 `git push`。

## 发布准备验证

- [ ] `dsh-graph-host/package.json` version = `0.7.3`
- [ ] `dsh-graph-host/lib/client/constants.js` 的 `PLUGIN_VERSION` = `0.7.3`
- [ ] 已运行 `bash scripts/build-client.sh`，生成的 `dsh-graph-host/lib/client.js` 含同一版本与 generated marker，未手改产物
- [ ] `README.md` 当前版本口径为 `v0.7.3`
- [ ] release notes 完整纳入 g-205、g-206、g-207、g-209、g-210、g-211、g-214 等 v0.7.3 变更
- [ ] `bash scripts/sync-core.sh` 通过且无未预期 core 差异
- [ ] `node --check dsh-graph-host/index.js` 通过
- [ ] `node --check dsh-graph-host/lib/client.js` 通过
- [ ] `node --test core/tests/*.test.ts` 全绿 (551/551 pass)
- [ ] `npm pack --dry-run` 通过（使用仓库内可写 cache/store）
- [ ] pack 内容仅为白名单：host `index.js`、`core/*.js`、`lib`、`cordis.patch.yml`、`supervisor-guide.md`、`README.md`、`LICENSE`、`package.json`；不含 `.ts`、tests、scripts、`.dsh-graph`、worktrees 或敏感临时数据

## 负责人发布 gate

- [ ] 复核 v0.7.3 范围与 release notes，确认 npm 包文件列表
- [ ] 手动执行 `npm publish`（本 attempt 不执行）
- [ ] publish 成功后手动执行 `git tag v0.7.3` 与 `git push origin main --tags`

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

## 变更文件清单

| 文件 | 变更 |
|---|---|
| `dsh-graph-host/package.json` | 版本 `0.7.2` → `0.7.3` |
| `dsh-graph-host/lib/client/constants.js` | `PLUGIN_VERSION` `0.7.2` → `0.7.3` |
| `dsh-graph-host/lib/client.js` | 由 `build-client.sh` 重建 |
| `README.md` | 当前版本口径 → `v0.7.3` |
| `docs/release-notes-v0.7.3.md` | 新增本版本说明 |
| `docs/release-checklist-v0.7.3.md` | 新增发布检查清单 |
| `scripts/dev-dsh-instance.sh` | 已发布版本默认值 → `^0.7.3` |
| `AGENTS.md` | 主 profile 已发布版本说明 → `^0.7.3` |
