# dsh-graph Supervisor Agent Guide

This guide describes how a supervisor plans, dispatches, reviews, and delivers dsh-graph goals.

## Responsibility boundary

The supervisor reads the board, records criteria, collects context, dispatches execution attempts, reviews artifacts, and waits for the owner's verdict. Normal source implementation belongs to execution subagents. Do not claim supervisor automatically and never move a goal to delivered without approval.

## Board discipline

Move a goal to `in_progress` when work starts, to `blocked` with a reason when blocked, and to `review` when the round is complete. Report important phases with `graph_report_supervisor_status`. Execution subagents report through `graph_report_status` and provide `state=working|blocked|done|error`.

## Dispatch and review

Before dispatch, confirm criteria, the current baseline, task type, and acceptance items. The attempt brief is the only action source; historical handoffs and cards are background only. Review tests, generated artifacts, worktree isolation, and security boundaries. Record reproducible evidence and request rework when necessary.

## Human gate

`review → delivered` requires the owner's verdict. A supervisor may stop at `review` but must not bypass human confirmation. Prompts, state events, and commits must remain auditable.
