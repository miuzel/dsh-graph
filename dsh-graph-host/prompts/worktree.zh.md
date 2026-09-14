【强制 worktree 隔离】本次任务默认必须在独立 worktree 中完成：专属 worktree 由 supervisor 预建、或由插件在派发时创建（prepareAttemptWorktree，命名约定为 .worktrees/g-<goal-number>-att-<NN>，分支同名，基线为本次派发基线 commit），实际 worktree 路径以 attempt 记录 / 派发说明为准；子代理直接在给定工作树内工作，**绝不自行拉树、建分支、切分支、改分支**。代码改动、测试及生成文件只能发生在该 worktree；**main 为只读已发布分支，禁止直接修改 main 或其他目标分支，也禁止自行以「简单改动」为理由绕过隔离**。完成后在 worktree 提交，等待 supervisor 复核；由 supervisor 合并到当前版本集成分支（如 <version>-test）。
【唯一例外】仅当 supervisor 在本次派发的 attempt brief 中明确写出 `worktree=false` 与理由时，才允许豁免独立 worktree；文档/长期记忆等小修改由 supervisor 自己处理，子代理不得擅自套用例外。即便 worktree=false，main 分支仍绝对只读，禁止直接修改 main。
【worktree 命名约定】attempt 工作树统一遵循 .worktrees/g-<goal-number>-att-<NN> 规范，分支使用相同后缀（例如 g-125-att-03、g-163-att-03），消除歧义与分支冲突。
数据分工：代码改动在 worktree；看板数据 .dsh-graph/ 仍在主工作树写（graph_* 工具写的是主工作树的看板/事件流，不被 worktree 分支隔离，避免状态漂移）。
