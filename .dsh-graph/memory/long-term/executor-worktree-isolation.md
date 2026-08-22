# 执行子代理 worktree 隔离工作流（负责人 2026-08-22 指示）

来源目标：g-118/g-119/g-120 筹备期 supervisor 执行规范（负责人直接指示）。

## 约定

- **并发/复杂的执行任务**：子代理宜先 `git worktree add` 独立工作树（与 main
  隔离）再改代码，review 交付阶段由 supervisor 复核通过后合并回 main。
- **目的**：避免并发子代理互相踩提交、避免半成品直接落 main。
- **简单/单文件小修**：可不走 worktree，主管按复杂度判断。

## 实施注意（待 g-120 后工具化时补充）

- spawn 提示词是否内联 worktree 指令：尚待决定（g-120 执行注入卡片成果时
  一并考虑，避免两处 prompt 重复膨胀）。
- 子代理 worktree 与看板数据（.dsh-graph/ 本身也在 git 仓库内）的交互：
  worktree 里 .dsh-graph 事件流与 main 的合并冲突需在 review 阶段处理——
  工具化时需明确「看板数据仍在主工作树写，代码改动在 worktree」的分工。

## 细化（2026-08-22 负责人补充）：子代理自决，简单改动直接 main

- 负责人指出：supervisor 自动合并 worktree 给子代理造成困扰；
- 约定：**简单的一两行改动、且与现有工作无冲突 → 子代理可直接在 main 分支修改，
  不必 worktree**；worktree 与否由**子代理自己决定**，supervisor 不代劳合并、
  不强行套 worktree；
- 已同步 supervisor-guide「worktree 隔离」条目与 WORKTREE_GUIDE 常量（spawn 提示词）。

## 二次强化（2026-08-22 负责人：并发同文件必须 worktree）

- 背景：g-129 与 g-77647351 并发改 client.js 都直接 main（各自认为「简单改动」），
  造成分叉冲突、supervisor merge 地狱（手工合并 487 行出错多次）；
- 强化约定：**「直接 main」仅限真正一两行 + 唯一文件改动 + 无其他目标并发改该文件**；
  多目标并发改同一文件 → 子代理**必须 worktree**，不得自认为简单就直改 main；
- 已同步 supervisor-guide「worktree 隔离」条目 + WORKTREE_GUIDE 常量（spawn 提示词）。
