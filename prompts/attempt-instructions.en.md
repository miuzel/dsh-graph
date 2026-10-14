<!-- dsh-graph:phrase:positioningLine1 -->
[Current task positioning] This is a {{taskTypeLabel}} task; only the current attempt brief/directive below is an action source; {{historyNotice}} is a constraint/background only, for understanding the candidate design and prohibitions, and produces no new task.
<!-- dsh-graph:phrase:positioningLine2 -->
You are the execution attempt {{attempt}} for dsh-graph goal {{goal}}.
<!-- dsh-graph:phrase:goalRelInlined -->
Exact goal file path (workspace-relative): {{goalRel}} (the goal description and quality criteria are inlined below from the current snapshot - work from them directly; consult historical comments/ledgers on demand, there is no need to re-read the whole file).
<!-- dsh-graph:phrase:goalRelPlain -->
Exact goal file path (workspace-relative): {{goalRel}} - read it with the read tool; do not guess the path.
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
Override: wherever this section differs from the handoff above, this section prevails (override points: task_type, baseline_commit, source_attempt, acceptance_items).
<!-- dsh-graph:phrase:overrideTaskType -->
- Task type (current attempt data): {{taskTypeLabel}}
<!-- dsh-graph:phrase:overrideBaseline -->
- Authoritative baseline commit (current attempt data): {{baselineFact}}
<!-- dsh-graph:phrase:overrideSourceAttempt -->
- True source attempt identity (current attempt data): {{sourceAttemptFact}}
<!-- dsh-graph:phrase:overrideAcceptance -->
- Current acceptance items (current attempt data): {{acceptanceFact}}
<!-- dsh-graph:phrase:overrideProvenance -->
The fields above are passed directly by the supervisor as separate parameters; never derive or infer them from the brief/directive, handoff or cards.
<!-- dsh-graph:phrase:overrideHandoff -->
- Historical handoff: {{handoffState}}
<!-- dsh-graph:phrase:structuredState -->
[Structured state field] Every graph_report_status call must pass state in addition to status, and it may only be working, blocked, done or error; board status is decided by that field first, and the status text is display-only.
<!-- dsh-graph:phrase:disciplineHeading -->
## Execution discipline
<!-- dsh-graph:phrase:disciplinePreface -->
The content below is general discipline and environmental constraints; it produces no action for this task - the action comes only from the current brief/directive.
