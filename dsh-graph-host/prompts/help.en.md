dsh-graph is a plugin that organizes work into a "goal board". Available graph_* tools (44 total):

## Goal lifecycle
- graph_create_goal(title[, version][, type]) create a goal (enters backlog; with version, schedule it; type: feature/bug/task/improvement/patch/chore);
- graph_transition(goal, to[, reason]) transition status; lifecycle draft→planning→collecting→ready→in_progress→review→delivered, plus blocked (entering blocked requires reason);
- graph_archive_goal(goal) archive a goal (only draft/planning/delivered may be archived);
- graph_unarchive_goal(goal) unarchive a goal;
- graph_delete_goal(goal) delete an archived goal (including cards/attempts);
- graph_postpone_goal(goal[, reason]) postpone a goal (move back to backlog, set to draft);
- graph_rename_goal(goal, title) rename a goal.

## Goal content
- graph_amend_goal(goal, note[, append]) record revisions/human feedback; note is the revision note, append writes into the goal description;
- graph_set_description(goal, description) edit the goal description in place (empty clears it);
- graph_set_directive(goal, directive) set supplemental directive for the next attempt (empty clears it);
- graph_set_goal_tags(goal, tags[]) set tags (≤20, optimistic concurrency, force overwrites);
- graph_set_goal_type(goal, type) set type feature/bug/task/improvement/patch/chore;
- graph_move_goal(goal, to[, version]) move goal between backlog / standalone goals/ / version;
- graph_add_comment(goal, text) append a comment/feedback to the Comments section.

## Criteria · Cards · Attachments
- graph_set_criteria(goal, criteria[]) register quality criteria first (criteria precede execution; hard rule);
- graph_add_card(goal, title[, kind][, scope]) create a context card (shared by default; scope="goal" for owned);
- graph_fill_card(goal, card[, text][, summary]) fill card body (may reference @att/<name> for attachments);
- graph_review_card(goal, card) review a filled card (filled → reviewed);
- graph_delete_card(goal, card) delete a card (cannot delete while collecting);
- graph_convert_card_to_shared(goal, card) convert owned card → shared card;
- graph_convert_card_to_owned(goal, card) convert shared card → owned card (ref count must be 1);
- graph_store_attachment(name[, content][, base64]) store an attachment (text uses content, binary uses base64);
- graph_delete_attachment(name) delete an attachment (rejected if still referenced);
- graph_bind_collect_card(goal, card, child_id) bind a collection subagent to a card.

## Execution & Rework
- graph_start_attempt(goal) dispatch an execution subagent (supports task_type/baseline_commit/source_attempt/acceptance_items/worktree etc.);
- graph_record_attempt_handoff(goal, source_attempts[], failures, constraints, baseline, verification) supervisor records rework constraints;
- graph_unbind_goal_child(goal, {attempt|child_id}[, token]) safely detach an execution subagent (requires token or legacy=true);
- graph_abandon_attempt(goal, attempt, reason) mark an attempt as abandoned;
- graph_resolve_accept(goal, verdict[, objection][, force]) supervisor resolves acceptance request (accept/object).

## Validation & Reconciliation
- graph_validate() validate all invariants (status, ownership, criteria, dependency cycles, card references);
- graph_rebuild() rebuild state from event stream and reconcile with frontmatter.

## Memory management
- graph_memory_add(kind, text[, scope][, importance]) add a persistent memory (scope: on_demand default / standing for constant rules);
- graph_memory_replace(old, text[, kind][, importance]) correct existing memory (old locates, text is the new content);
- graph_memory_remove(old[, reason]) delete a memory entry (must confirm obsolete or withdrawn);
- graph_memory_recall([query][, kind][, limit]) search memories.

## Coordination & Handoff
- graph_handoff([query][, memory_limit]) session handoff (generates HANDOFF.md: board projection + memory + environment facts);
- graph_claim_supervisor() new session takes over as supervisor (idempotent, returns full HANDOFF).

## Worktree · Status · Settings
- graph_list_worktrees([goal]) list worktree cleanup candidates (read-only);
- graph_clean_worktree(id, confirm) clean a verified worktree (keeps branch by default);
- graph_report_status(goal, attempt, status, state) report attempt status (state: working/blocked/done/error);
- graph_report_supervisor_status(status) supervisor reports status (board top status bar);
- graph_get_settings() read-only query of project config and valid enum metadata;
- graph_update_settings(patch) update project config (schema validation, comment preservation, atomic write).

## Help
- graph_help() display this help (full 44-tool checklist with parameter reference).

## Claim supervisor
**Execute this only when the person in charge explicitly asks you to take over as supervisor**—by default no session may automatically claim:
1. Old session: graph_handoff() —— generate HANDOFF.md;
2. New session: graph_claim_supervisor() —— update supervisor.session, return full HANDOFF.

The complete supervisor work discipline is in the skill dsh-graph-supervisor; explicitly call it to load.
Principle: deliverables are evidence; proactively transition cards and report status at key stages; throttle heartbeats for long tasks; ask first when uncertain.
