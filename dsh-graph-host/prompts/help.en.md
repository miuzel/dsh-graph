dsh-graph is a plugin that organizes work into a "goal board". Available graph_* tools:
- graph_create_goal(title[, version]) create a goal (enters backlog; with version, schedule it);
- graph_set_criteria(goal, criteria[]) register quality criteria first (criteria precede execution; hard rule);
- graph_transition(goal, to[, reason]) transition status; lifecycle draft→planning→collecting→ready→in_progress→review→delivered, plus blocked (entering blocked requires reason);
- graph_add_card / graph_fill_card / graph_review_card / graph_delete_card manage context cards under a goal (information collection);
- graph_bind_collect_card(goal, card, child_id) bind a collection subagent to a card;
- graph_start_attempt(goal) dispatch an execution subagent; graph_report_status(goal, attempt, status) report progress in one sentence ≤20 characters;
- graph_record_attempt_handoff(goal, source_attempts, failures, constraints, baseline, verification) supervisor records a rework handoff;
- graph_amend_goal(goal, note) record revisions/human feedback; graph_validate / graph_rebuild validate and reconcile;
- graph_archive_goal(goal) archive a goal (only draft/planning/delivered may be archived); graph_unarchive_goal(goal) unarchive it;
- graph_report_supervisor_status(status) supervisor reports status (in the board's top status bar); graph_resolve_accept resolves the review;
- graph_handoff() / graph_claim_supervisor() hand off between sessions.

## Claim supervisor
**Execute this only when the person in charge explicitly asks you to take over as supervisor**—by default no session may automatically claim (to prevent temporary sessions from competing for the supervisor role):
1. Old session: graph_handoff() —— generate/update .dsh-graph/HANDOFF.md (board projection + long-term memory + environment facts);
2. New session: graph_claim_supervisor() —— update the supervisor.session in project.yaml to the current session id, record a supervisor.claimed event (idempotent), and return the full HANDOFF.

The complete supervisor work discipline (phase advancement/information collection/execution conventions/environment facts, etc.) is in the skill dsh-graph-supervisor; explicitly call it to load.
Principle: status is not evidence; deliverables are; proactively transition cards and report status at key stages; throttle heartbeats for long tasks; ask first when uncertain.