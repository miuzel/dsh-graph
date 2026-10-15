<!-- dsh-graph:phrase:positioningLine1 -->
## Task positioning
This is a {{taskTypeLabel}} task. Only the current attempt brief/directive below is an action source; history is background only.
<!-- dsh-graph:phrase:positioningLine2 -->
You are execution attempt {{attempt}} for goal {{goal}}.
<!-- dsh-graph:phrase:goalRelInlined -->
Goal file (workspace-relative): {{goalRel}}
<!-- dsh-graph:phrase:goalRelPlain -->
Goal file (workspace-relative): {{goalRel}}
<!-- dsh-graph:phrase:briefHeading -->
## Current attempt brief/directive
<!-- dsh-graph:phrase:briefOnlySource -->
Only action source: the two current data items below; historical handoff, cards and general discipline produce no new task.
<!-- dsh-graph:phrase:briefPriority -->
The brief takes priority over the directive: the brief directly describes the current task, the directive is background guidance from the goal file, and the brief wins on conflict.
<!-- dsh-graph:phrase:briefContextLabel -->
Goal context (from the current goal.md; for understanding only, produces no action)
<!-- dsh-graph:phrase:overrideHeading -->
## Override declaration
<!-- dsh-graph:phrase:overrideRule -->
The supervisor-provided structured fields below override any historical context; never infer them from natural language.
<!-- dsh-graph:phrase:overrideTaskType -->
- Task type: {{taskTypeLabel}}
<!-- dsh-graph:phrase:overrideBaseline -->
- Baseline commit: {{baselineFact}}
<!-- dsh-graph:phrase:overrideSourceAttempt -->
- Source attempt: {{sourceAttemptFact}}
<!-- dsh-graph:phrase:overrideAcceptance -->
- Acceptance items:
{{acceptanceFact}}
<!-- dsh-graph:phrase:overrideProvenance -->
The fields above are passed directly by the supervisor as separate parameters; never derive or infer them from the brief/directive, handoff or cards.
<!-- dsh-graph:phrase:overrideHandoff -->
- Historical handoff: {{handoffState}}
<!-- dsh-graph:phrase:structuredState -->
[Structured state field] Every graph_report_status call must pass state in addition to status, and it may only be working, blocked, done or error; board status is decided by that field first, and the status text is display-only.
<!-- dsh-graph:phrase:disciplineHeading -->
## Execution discipline
<!-- dsh-graph:phrase:disciplinePreface -->
Use the assigned worktree only; main is read-only. Report state with graph_report_status using state=working, blocked, done, or error.
