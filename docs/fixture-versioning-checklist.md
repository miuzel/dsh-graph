# Fixture 版本化操作清单（g-298）

## 1. 现有 Fixture 清单

### 1.1 Mock Seed（`scripts/dsh-graph-mock-seed.mjs`）
- **用途**: 生成虚构演示项目 `nebula-notes` 的看板数据
- **数据域**: `/tmp/dsh-graph-mock-demo`（可通过 `MOCK_ROOT` 环境变量覆盖）
- **版本**: v1.4（固定版本号）
- **包含内容**:
  - 版本 `v1.4`（活跃版本）
  - 版本 `v1.3`（已发布版本）
  - 12 个目标（不同状态、类型、标签）
  - 卡片、attempt、状态汇报
  - 评论、描述

### 1.2 隔离测试实例（`scripts/archived/dev-dsh-instance.sh`）
- **用途**: 启动隔离的 DSH web 实例用于开发和测试
- **端口**: 3082（测试实例），3080（主实例）
- **数据域**: `./tmp/test-review/workspace/dsh-graph-test/.dsh-graph`（仓库内；由脚本默认值 `TEST_HOME=$REPO_ROOT/tmp/test-review` 与 `CWD=$TEST_HOME/workspace/$PROFILE` 决定）
- **隔离特性**:
  - 独立 DSH_HOME（`$REPO_ROOT/tmp/test-review`）
  - 独立 workspace（`$TEST_HOME/workspace/$PROFILE`）
  - 独立 pnpm store

### 1.3 核心测试（`core/tests/*.test.ts`）
- **用途**: 单元测试和集成测试
- **测试类型**:
  - 源码契约测试（检查代码中的模式）
  - API 行为测试（调用 core 函数验证行为）
  - 边界条件测试

## 2. 版本化操作规则

### 2.1 Mock Seed 版本化
- **当前版本**: v1.4（固定）
- **更新规则**:
  1. 修改 `scripts/dsh-graph-mock-seed.mjs` 时，必须更新 `VERSION_SLUG` 常量
  2. 更新后运行 `node scripts/dsh-graph-mock-seed.mjs --validate` 验证
  3. 更新 `README.md` 中的截图说明（如适用）
- **回滚**: 保留旧版本的 mock 数据备份（通过 `MOCK_ROOT` 环境变量指向不同目录）

### 2.2 测试实例版本化
- **当前版本**: 与仓库版本一致
- **更新规则**:
  1. 修改 `dsh-graph-host` 后，重新运行 `bash scripts/archived/dev-dsh-instance.sh run`
  2. 测试实例会自动重新安装插件（`link:` 方式）
  3. 验证 `node --test core/tests/*.test.ts` 通过
- **回滚**: 使用 `git checkout` 回退到之前的 commit

### 2.3 核心测试版本化
- **当前版本**: 与仓库版本一致
- **更新规则**:
  1. 新增测试文件时，遵循命名规范 `g<NNN>-<description>.test.ts`
  2. 修改现有测试时，确保不破坏现有测试
  3. 运行 `node --test core/tests/*.test.ts` 验证所有测试通过
- **回滚**: 使用 `git checkout` 回退测试文件

## 3. 操作清单模板

### 3.1 新增 Fixture 操作
```
1. 确定 fixture 类型（mock seed / 测试实例 / 核心测试）
2. 创建 fixture 文件（遵循命名规范）
3. 更新版本号（如适用）
4. 运行验证命令
5. 更新文档（如适用）
6. 提交到版本控制
```

### 3.2 修改 Fixture 操作
```
1. 备份当前版本（如需要）
2. 修改 fixture 文件
3. 更新版本号（如适用）
4. 运行验证命令
5. 运行回归测试
6. 更新文档（如适用）
7. 提交到版本控制
```

### 3.3 删除 Fixture 操作
```
1. 确认无其他地方引用该 fixture
2. 删除 fixture 文件
3. 更新版本号（如适用）
4. 运行验证命令
5. 运行回归测试
6. 更新文档（如适用）
7. 提交到版本控制
```

## 4. 验证命令

### 4.1 Mock Seed 验证
```bash
# 生成并验证 mock 数据
node scripts/dsh-graph-mock-seed.mjs --validate

# 检查生成的数据结构
ls -la /tmp/dsh-graph-mock-demo/.dsh-graph/
```

### 4.2 测试实例验证
```bash
# 启动测试实例
bash scripts/archived/dev-dsh-instance.sh run --port 3082

# 验证插件加载
curl http://127.0.0.1:3082/api/dsh-graph/board

# 运行核心测试
node --test core/tests/*.test.ts
```

### 4.3 核心测试验证
```bash
# 运行所有测试
node --test core/tests/*.test.ts

# 运行特定测试
node --test core/tests/g290-retained-lazy.test.ts
```

## 5. 注意事项

1. **不要修改生产数据**: 所有测试必须在隔离环境中进行
2. **不要破坏现有测试**: 修改 fixture 后必须运行回归测试
3. **保持版本一致性**: Mock seed 版本应与仓库版本保持同步
4. **文档同步**: 修改 fixture 后更新相关文档
5. **提交规范**: 使用清晰的提交信息说明 fixture 变更
