# dsh-graph Design Philosophy

> Chinese version: [design-philosophy.zh.md](design-philosophy.zh.md). The two versions are structurally
> symmetric (their section-anchor sets are byte-identical), pinned by the structural guard
> `core/tests/g460-design-philosophy-guard.test.ts`.

<!-- sec: intro -->

## 0. Who this document is for

It is written for **someone meeting dsh-graph for the first time**: you know what an AI coding agent is
(an autonomous process that reads files, edits code and runs commands), and you know where "just let an
agent work" usually goes wrong — scope drift, self-declared completion, nobody able to review. What you do
not know is the shape dsh-graph imposes on that work.

This document describes only mechanisms that **actually exist in the code today**, and gives a source
citation (`file:line`, or a named section) for every behavioural claim. Anything not yet implemented —
the 1.0 ideas — is collected in [§13](#13-the-10-roadmap-not-implemented) and explicitly marked
**"1.0 roadmap (not implemented)"**; it is never mixed into the behavioural description.

**In one sentence**: dsh-graph splits one piece of development into the chain
**goal → attempt → review → delivered → released**, and installs a gate at every point where something can
be written, dispatched or declared complete. Every state change is appended to an append-only event log
(`events.jsonl`) first; files are only a projection.

<!-- sec: overview -->

## 1. The main chain at a glance

Both diagrams below render directly on GitHub and clearly separate **implemented today** from
**1.0 roadmap (not implemented)**.

### 1.1 States and legal transitions (implemented today)

![dsh-graph goal state machine: 8 states and legal transitions](assets/design-philosophy.lifecycle.light.svg)

[Interactive version](../dsh-graph-host/diagrams/design-philosophy.lifecycle.html) · [Dark theme](assets/design-philosophy.lifecycle.dark.svg)

Sources: state set `core/machine.ts:10-19` (`STATUSES`); legal edges `core/machine.ts:24-33` (`EDGES`).

### 1.2 Roles and gate chain (implemented today vs 1.0 roadmap)

![dsh-graph main chain: roles, gates, and trace](assets/design-philosophy.workflow.light.svg)

[Interactive version](../dsh-graph-host/diagrams/design-philosophy.workflow.html) · [Dark theme](assets/design-philosophy.workflow.dark.svg)

Sources: admission `core/ops.ts:7771` (`assertExecutionAdmission`); isolation `core/worktree.ts:784`
(`resolveWorktreeIsolationDecision`); results surface `core/ops.ts:8653` (`writeAttemptResults`);
review trace `core/ops.ts:6914` (`reviewsDir`).

<!-- sec: lifecycle -->

## 2. Goal lifecycle and state machine

### 2.1 The state set

`core/machine.ts:10-19` defines eight states: `draft`, `planning`, `collecting`, `ready`,
`in_progress`, `review`, `delivered`, `blocked`. This is a **closed set** — not a convention but the
shared source of truth for both the type and the runtime check.

### 2.2 Legal transitions

The legal edges live in `EDGES` at `core/machine.ts:24-33` and form a directed graph; `blocked` is
special-cased with no outgoing edges. Several edges carry their design rationale (also written into the
source comments):

- `planning → ready`: direct when there is nothing to collect — collection is not a ritual
  (`core/machine.ts:26`);
- `collecting → in_progress`: a manual drag counts as authorisation, so `ready` may be skipped
  (`core/machine.ts:27`);
- `in_progress → collecting`: interrupt and re-collect (`core/machine.ts:29`);
- `review → in_progress`: sent back (`core/machine.ts:30`);
- `delivered → review`: after an owner note, go back to `review` to amend or fix a bug
  (`core/machine.ts:31`).

### 2.3 How illegal transitions are rejected

Every transition goes through `assertTransition` (`core/machine.ts:50-91`), which throws `GraphError`
before anything is written to disk:

| Situation | Behaviour | Source |
| --- | --- | --- |
| Current or target state outside the closed set | reject (`current state illegal` / `target state illegal`) | `core/machine.ts:56-61` |
| `from === to` | reject (`state unchanged`) | `core/machine.ts:62` |
| Edge absent from `EDGES` | reject (`illegal transition: from → to`) | `core/machine.ts:70-72` |
| `blocked` without `blocked_from` | reject | `core/machine.ts:65-66` |
| Leaving `blocked` to a non-original state | reject (`may only return to the original state`) | `core/machine.ts:67-69` |
| Entering `blocked` without `reason` | reject | `core/machine.ts:74-78` |
| Entering `in_progress` without `rules_snapshot` | reject | `core/machine.ts:81-83` |
| Entering `in_progress` with an empty criteria section | reject | `core/machine.ts:84-86` |
| Entering `in_progress` without a `criteria.confirmed` event | reject | `core/machine.ts:87-89` |

In addition, a draft goal sitting in `backlog/` may not make a stage transition at all — it must first be
scheduled into a version or made standalone (`core/ops.ts:2923-2925`).

### 2.4 Status is a projection, not the source of truth

Transitions all go through `transition()` (`core/ops.ts:2918`) and are **event-first**: the
`goal.transition` event is appended first, and `goal.md` is written only after that append succeeds
(`core/ops.ts:2945-2959`). `events.jsonl` is therefore the single source of truth and the `status` field
in `goal.md` is only a projection; `graph_rebuild` replays `goal.created` / `goal.transition` and reports
any drift between frontmatter and the event log (`core/ops.ts:3990`).
The board column is the `status` itself — so a card left sitting in the wrong column is a lie
(`dsh-graph-host/supervisor-guide.zh.md:84-85`).

<!-- sec: criteria-gate -->

## 3. Criteria gate and human gate

### 3.1 Criteria before execution

Criteria are registered by `graph_set_criteria` (`core/ops.ts:2609`): an empty list is rejected outright
(`core/ops.ts:2613`); writing snapshots the rule-set version (`rules_snapshot`, `core/ops.ts:2626-2628`)
and appends a `criteria.confirmed` event (`core/ops.ts:2629-2638`).
Whether the criteria section "has substance" is decided by `criteriaPresent`, which strips HTML comments
and template placeholders (`core/model.ts:193-195`; placeholder set at `core/model.ts:186-190`).

This gate fires in **two** places:

1. The state machine itself: the `in_progress` transition requires `rules_snapshot` + non-empty criteria
   + a `criteria.confirmed` event (`core/machine.ts:80-90`);
2. Dispatch admission: `assertExecutionAdmission` rehearses the `in_progress` transition with the same
   state-machine invariants **before starting any subagent**; a failure throws with **zero side effects**
   (no attempt created, no subagent started) (`core/ops.ts:7771-7833`; the comment states explicitly that
   it never starts a subagent and then swallows a failed transition).

Admission additionally rejects four locations/states: `backlog` (`core/ops.ts:7781-7783`), `draft`
(`core/ops.ts:7785-7787`), `blocked` (`core/ops.ts:7788-7790`) and `delivered` (`core/ops.ts:7791-7793`);
and for `collecting` / `ready` it adds a "goal description must not be empty" check
(`core/ops.ts:7753`, `core/ops.ts:7795-7805`).

### 3.2 `review → delivered` requires a human verdict

Acceptance is applied by `graph_resolve_accept`: it appends a `review.passed` event and then performs the
`review → delivered` transition (`core/ops.ts:12693-12713`, `applyAcceptMapping`).
Requesting acceptance is the `review.requested` event (`core/ops.ts:12388-12411`).

**But one honest boundary must be stated here**: the `delivered` human gate is a **supervisor discipline
constraint, not engine enforcement**. Neither `graph_resolve_accept` nor
`graph_transition(to='delivered')` validates any human signal — no token, no GUI confirmation, and the
event payload does not record an approver; the engine cannot distinguish "the owner adjudicated" from
"the supervisor let itself through" (`dsh-graph-host/supervisor-guide.zh.md:148`). This flex is
**deliberate**: hard enforcement would only push agents into workarounds. The discipline lives with the
supervisor, not in the engine. Correspondingly, the supervisor guide lists "review" as one of the four
operations that need owner confirmation by default (`dsh-graph-host/supervisor-guide.zh.md:36-43`), and
execution subagents are explicitly forbidden from moving `review→delivered` themselves
(`dsh-graph-host/supervisor-guide.zh.md:306-307`).

### 3.3 Machine fast-track is not a substitute for the human gate

`review.policy` takes three values, `auto` / `strict` / `none` (when unset it is derived from the goal
type: `patch`/`chore` → `auto`, everything else → `strict`)
(`dsh-graph-host/supervisor-guide.zh.md:132-136`). Only `auto` permits `fast_track`, and all four machine
gates must be green:

1. full test suite `exit_code=0` **and** `fail=0` (**caller evidence**; the engine does not re-run it);
2. type check `exit_code=0` (**caller evidence**);
3. change size (**computed by the engine from Git**): product-code churn <150 lines, no untracked user files;
4. every criterion ends with `✅已验` (**computed by the engine**).

Evidence layering and fail-safe behaviour (any missing signal means no pass) are described in
`dsh-graph-host/supervisor-guide.zh.md:140-146`; the implementation entry point is `core/ops.ts:12504`
(`resolveAccept`). **`fast_track` only waives machine evidence collection; it does not waive the owner's
final adjudication of `delivered`** (`dsh-graph-host/supervisor-guide.zh.md:150`).

<!-- sec: dispatch -->

## 4. Dispatch and the isolation triad

### 4.1 Dispatch goes through one tool

Execution is dispatched by `graph_start_attempt` (`core/ops.ts:7867`, `startAttempt`). Admission is
checked first (§3.1); once it passes, the `in_progress` transition is landed **first** and only then is the
attempt directory created and the subagent started (`core/ops.ts:7846`, `ensureExecutionInProgress`). The
order is deliberate: a rejected transition leaves no attempt residue behind.

### 4.2 Isolation decision: explicit > dirty workspace > type default

Whether to create a separate worktree is decided by `resolveWorktreeIsolationDecision`
(`core/worktree.ts:784-826`); the rules short-circuit top-down:

| Rule | Condition | Result | `reason` |
| --- | --- | --- | --- |
| 1 | `worktree` passed explicitly | honour the explicit value | `explicit` |
| 2 | a reliably dirty workspace is detected (`clean === false`) | **always escalate to isolation** (even `patch`/`chore`/`task`) | `dirty_workspace` |
| 3 | clean detected (`clean === true`) or no probe | per-type default | `type_default` |
| 4 | probe unreliable (`clean === null`) | per-type default, honestly labelled unknown | `type_default_unknown` |

Per-type defaults: `patch`/`chore`/`task` do not get a worktree; `feature`/`bug`/`improvement` do
(`core/worktree.ts:334`, `defaultWorktreeForGoalType`).
The worktree itself is created by `prepareAttemptWorktree` (`core/worktree.ts:845`) under the naming
convention `.worktrees/g-<goal>-att-<NN>`, with a branch of the same name. It runs **synchronously before**
the subagent starts, with no `await` in between, so the worktree is always created and registered by the
time the subagent starts; a creation failure always throws `GraphError` and **never silently degrades to
running in the main tree** (`AGENTS.md`, "派发即隔离" / dispatch-time isolation section).

The dispatch response is built from a **whitelist** and returns `isolated` / `worktree` /
`worktree_reason` / `worktree_created` / `worktree_reused`, so the supervisor can tell whether isolation
really happened (same AGENTS.md section).

### 4.3 Isolation triad verification

After dispatch, verify with three independent pieces of evidence (defined item by item in `AGENTS.md`,
"派发即隔离"):

1. `git worktree list` contains this attempt's worktree path (`.worktrees/<goal>-att-<NN>`, two-digit index);
2. the main tree's `git status --porcelain` shows zero changes;
3. the main tree's `dist/` mtime is unchanged (no build ran in the main tree).

Failing any of the three means "treat it as not isolated". Note that `isolated:false` **does not mean
isolation failed** — it means the attempt runs from the integration workspace root per policy; when
isolation really is needed, pass `worktree:true` explicitly at dispatch time.

### 4.4 Why builds must not run in the main tree

`dist/` is the asset source for the **running host**, and the host reads `dist/prompts/*.md` **fresh on
every call** (not cached at startup). Building in the main tree competes with the running host for that
directory and has historically killed in-flight attempts (`AGENTS.md`, "Build Isolation", records the real
`dsh-graph prompt asset missing or unreadable` failure). Two concrete traps: `pnpm typecheck` also triggers
`prepare` (= a full build), so in the main tree use
`./node_modules/.bin/tsc --noEmit -p tsconfig.json`; and `pnpm check:dist` is **not** a read-only entry
either (pnpm ≥ 11's `verifyDepsBeforeRun` implicitly runs `pnpm install` ⇒ full build) — the read-only check
is `node --test core/tests/dist-freshness-g312.test.ts` (`AGENTS.md`, "Build Isolation"; the g-408
reproduction is on record). The build itself is an **atomic publish**: everything is assembled in a staging
directory inside the repository, and only on full success is the tree swapped with a single
`renameat2(RENAME_EXCHANGE)`; on failure the old `dist/` stays byte-for-byte intact
(`AGENTS.md`, "Atomic publish (g-348)").

<!-- sec: attempt -->

## 5. Attempts and the results surface

### 5.1 The attempt is the single execution unit

A goal projects at most one active attempt at a time; the attempt directory lives under the goal directory
and `attempt.started` / `attempt.bound` events are written first (`core/ops.ts:8409`,
`bindAttemptChild`; the event-first convergence record is in `docs/event-first-commit-contract.zh.md:116-124`).
Execution subagents self-report through `graph_report_status`, which writes into the attempt
(`core/ops.ts:8366`); **the supervisor must never report on a subagent's behalf** — that line is the
subagent's own statement, and standing in for it fabricates progress
(`dsh-graph-host/supervisor-guide.zh.md:285-288`).

### 5.2 Auto-capture: a results surface with zero LLM calls

When a subagent ends, the host emits `subagent/end`; the plugin uses it to write the subagent's last
assistant text to `results-att-<attempt>.md` — **with zero LLM calls throughout** (`core/ops.ts:8644-8670`;
the comment states "zero tokens: the text comes from the host's subagent/end event, not an LLM call").
The known source domain is an open set: `subagent/end` / `child_error` / `abandon` / `detach` / `manual` /
`history` / `deterministic` / `llm` (`core/ops.ts:8483`, `ATTEMPT_RESULTS_SOURCES`); an unknown source is
written verbatim and a missing one defaults to `subagent/end` (`core/ops.ts:8664-8668`). The per-file cap
is 64 KiB (`core/ops.ts:8472`).

### 5.3 Repairing a results vacuum

Auto-capture does fail — the host is interrupted, the process is killed, or the supervisor made a small
change with no subagent at all. A results vacuum is **not allowed**, and there are two repair tools:

- `graph_write_results`: hand-write one attempt's completion summary (`source=manual`, zero LLM calls);
- `graph_refresh_results`: rewrite the goal-level `results.md` (`core/ops.ts:9514`, `refreshGoalResults`),
  archiving the old version as `results-archive-YYYYMMDDTHHMMSS.md` first (archive naming source
  `core/ops.ts:8917-8919`, implementation `core/ops.ts:8933-8960`).

`graph_refresh_results` has three write modes and is **zero-LLM by default**: omitting `content`
assembles from goal history with no LLM call (`source=deterministic`); passing `content` uses the caller's
text (`source=manual`); passing `llm:true` dispatches a **dedicated summarizer subagent** (role=summarizer)
that writes "what changed / impact / worth noting" from the goal detail (`source=llm`), keyed by a history
fingerprint so unchanged history hits the cache instead of calling again (`core/ops.ts:8493-8497` defines
the three source constants).

<!-- sec: review -->

## 6. Independent review: vocabulary and source of truth

### 6.1 The conclusion vocabulary is closed

There are exactly three review conclusions: `PASS` / `BLOCK` / `UNVERIFIED`, defined at
`core/ops.ts:6866` (`REVIEW_CONCLUSIONS`); **`FAIL` may not be used**. Day-to-day review grading also
includes a fourth class, `OUT-OF-SCOPE` (beyond the current threat model or version scope; it does not
auto-escalate) — that does not affect the closed set above, because the closed set governs **what may be
written into a review record** (`dsh-graph-host/supervisor-guide.zh.md:118-122`).

What may trigger `BLOCK` is explicitly narrowed: workspace escape, credential leakage, obvious path
errors, ordinary concurrent data loss, unauthorised destructive writes and crashes on bad input must
block; theoretical network attacks, same-UID malicious races, kernel-level full TOCTOU and distributed
consistency flaws **do not auto-block** (`dsh-graph-host/supervisor-guide.zh.md:120-124`).

### 6.2 The independence source of truth: `reviews/<review_id>.md`

A review is an **attachment to an existing execution attempt** — it creates no attempt, transitions no
state, and overwrites neither the author's `child_id` nor `results-att-*.md`
(`dsh-graph-host/supervisor-guide.zh.md:148`). The conclusion is written, independently, in two places:

- the directory `<goalDir>/reviews/`: `core/ops.ts:6914` (`reviewsDir`), whose comment states it sits
  beside `attempts/` and is **never written into `attempts/`**;
- the record file `reviews/<review_id>.md`: `core/ops.ts:6923` (`reviewRecordFile`), with `review_id`
  shaped `rev-att-<attempt>-<NN>` (pattern `core/ops.ts:6908`; the sequence takes the maximum existing
  file +1 and never reuses a number).

Review event names are a closed set too, fail-closed on the write side: anything outside
`REVIEW_EVENT_NAMES` throws (`core/ops.ts:6877-6903`).

### 6.3 What does **not** count as independent

This is the most self-deceiving step in the whole design, so it sits in plain sight:

- **the author's own report does not count as independent verification** (the author's own output or self-check);
- **a review the author dispatched themselves does not count as independent** — the trace records
  `self_requested`, and the structural guard turns "claims independent while `self_requested`" red
  immediately (`core/ops.ts:7529`; the message reads "self_requested (self-dispatched by the author) must
  not impersonate independent verification");
- **an author child impersonating an independent reviewer** is likewise red
  (`fanoutIndependentVerificationProblems` / `auditFanoutIndependentVerification`,
  `core/ops.ts:7440-7537`).

The "reverse boundary" for honest traces is pinned too: entries that truthfully declare
`source=self_requested` or `source=author` are **not** flagged red (honest records are not punished), but
they do not constitute independent verification either (`core/ops.ts:7537`).

### 6.4 Grading policy and the "not independently reviewed" marker

`strict` means an independent (author-bias-free) review subagent must be dispatched and `fast_track` is
forbidden (`dsh-graph-host/supervisor-guide.zh.md:134`). If a `strict` goal is accepted while the current
candidate has no auditable independent PASS record, the engine appends a **goal-level visibility marker**
`review.independent_missing` (`core/ops.ts:7676-7706`) recording the policy, the strict reasons and the
current candidate SHA — but it **does not block acceptance**. The board badge and
`review_state.independent_ok` refer to `current_candidate_sha` (the candidate most recently requested for
review), which is **not HEAD** (`dsh-graph-host/supervisor-guide.zh.md:149`).

### 6.5 Honest boundary: review is not an engine gate

It must be stated plainly: in the plugin layer, `strict`'s "an independent reviewer must be dispatched" is
**only a judgement and a guideline constraint, not engine enforcement**; with no independent review
dispatched, the board and the event log honestly mark "not independently reviewed" but acceptance is not
blocked (`dsh-graph-host/supervisor-guide.zh.md:148`). The dispatch entry point is
`graph_start_review(goal, attempt, candidate_commit)` / `POST /api/dsh-graph/start-review` (same section).

<!-- sec: release -->

## 7. Version lanes and release red lines

### 7.1 A version lane is scheduling, not status

The board has three vertical lane kinds: versions (`versions/<slug>/goals/`), the backlog (`backlog/`) and
standalone goals (`goals/`). `graph_move_goal` is a file move, and the file move *is* the ownership change
(`classifyGoalRel` at `core/ops.ts:326` is the ownership-decision source of truth). Relations between goals
(supersedes / amends / extends / related) live only in each goal's frontmatter `meta.relations`
(`core/ops.ts:3047`, `RELATION_TYPES`); `meta.depends_on` is stored separately and supersede/amend cycles
are detected (`core/ops.ts:3077`, `RELATION_CYCLE_TYPES`).

### 7.2 `released` has admission conditions

`releaseVersion` (`core/version-lane.ts:471-521`) does two things before writing any state:

1. **actor identity**: only `human:*` or `supervisor:*` may release; `agent:*` is rejected
   (`core/version-lane.ts:484-486`; message: "execution subagents cannot release directly");
2. **version completeness**: every **non-archived** goal in the version must be `delivered`; otherwise a
   blocking list is returned and no state is written (`core/version-lane.ts:498-503`; the list is produced
   by `validateVersionRelease`, `core/version-lane.ts:439-469`).

On success it is event-first: `version.released` is appended first, then `version.md`'s `status` is
updated (`core/version-lane.ts:505-521`). The legal target states for `setVersionStatus` are
`["planning", "active"]` and deliberately exclude `released`
(`VERSION_STATUS_ALLOWLIST`, just after `core/version-lane.ts:521`).

### 7.3 The three cross-version release red lines

`AGENTS.md`, "发布门禁 (Release Gate)", is the single source of truth; this section does not modify it and
only restates it:

1. **Windows compatibility**: before every release, a compatibility test must be run on **native Windows**
   (the T1–T5 layered check, runner `scripts/win-smoke-test.mjs`); an all-green Linux/WSL2 run **cannot**
   substitute for a real Windows conclusion, and if Windows verification is missing the README must
   honestly state "Windows unverified";
2. **Version-string consistency**: before release, the `package.json` version, `PLUGIN_VERSION` and the
   README version statement must be checked for agreement — **this can only be caught by manual review**
   (the 0.11.0 lesson: the constant takes no part in build validation);
3. **Artifact transfer discipline**: the only channel for cross-machine transfer is a tarball, reconciled
   by sha256 (the registry rewrites the tarball, so the published sha256 necessarily differs from the local
   pack sha256; registry-side reconciliation must therefore be content-level —
   `docs/release-handbook.md:120-141`).

In this repository those three version strings live at: the packaged version
`dsh-graph-host/package.json:3` (`version`), the client constant
`dsh-graph-host/lib/client/constants.js:12` (`PLUGIN_VERSION`), and the README "current version" statements
(`dsh-graph-host/README.md:43` and `:276`).

<!-- sec: memory -->

## 8. Memory grading

Memory has two **hard per-entry caps**, with `MEMORY_LIMITS` at `core/ops.ts:11965-11971` as the source of
truth:

| scope | per-entry cap | Purpose |
| --- | --- | --- |
| `standing` | **200 characters** (code points) | injected permanently, occupies the system prompt |
| `on_demand` | 1000 characters | retrieved on demand, occupies nothing permanent |

Exceeding a cap throws (`core/ops.ts:11994-11999`, `validateMemoryInput`). The write side also rejects
control characters and text that looks like a credential or token (`core/ops.ts:11978-11984`,
`validateMemoryText`).

**The grading rule**: every self-generated summary, technical lesson or design decision defaults 100% to
`on_demand`; `standing` is allowed only when "a human explicitly asks for it to be permanent" or the entry
"concerns workspace isolation / a non-negotiable safety prohibition"
(`dsh-graph-host/supervisor-guide.zh.md:78-80`). Permanent injection also has its own total budget,
`MEMORY_INJECT_TOTAL_BUDGET = 4000` (`core/ops.ts:11973`); rendering sorts by
"critical constraint → human authorisation → importance → update time" (`core/ops.ts:1760`,
`formatStandingMemorySection`), and when the budget cannot fit every critical constraint it **does not
silently drop them** but emits a bounded overflow notice (`core/ops.ts:1892`).

The source of truth for structured memory is `memory/memory.jsonl` (an event log) read by replay
(`core/events.ts:302`, `replayMemory`); `on_demand` entries are retrieved with `graph_memory_recall` and
need no index file at all (`dsh-graph-host/supervisor-guide.zh.md:19-20`, `:413`).

<!-- sec: cards -->

## 9. Shared cards and attachments

### 9.1 Context cards

The card lifecycle is a four-state closed set `empty → collecting → filled → reviewed`
(`core/ops.ts:4037`, `CARD_STATUSES`), and scope is binary, `goal` / `shared` (`core/ops.ts:4038`).
One card is one collection task: `graph_add_card` registers the placeholder, the collecting subagent must
be bound **immediately** with `graph_bind_collect_card` (no binding is a process violation), the subagent
fills it back to `filled`, and the supervisor reviews it to `reviewed`
(`dsh-graph-host/supervisor-guide.zh.md:208-223`).

A **shared card** can be mounted into multiple goals: mounting increments the reference count and appends a
`card.shared_referenced` event (`core/ops.ts:4243-4263`, `addSharedCardRef`); the count includes
**archived goals** (`core/ops.ts:4267`, `referenceCount`). Authorisation matches unbinding: the goal
creator, `human:*` (the owner's GUI), and the `supervisor:<sessionId>` matching `project.yaml` are allowed;
**execution subagents are always rejected with zero side effects** (`core/ops.ts:9735-9751`,
`authorizeSharedCardLink`, which reuses `authorizeUnbind` at `core/ops.ts:9714` as the single decision
source of truth). Shared cards and long-term memory are not interchangeable: the former is an explicit part
of goal assembly, the latter is a persistent fact any agent can recall
(`dsh-graph-host/supervisor-guide.zh.md:257-268`).

### 9.2 Attachments

Attachments live under the project root's `.dsh-graph/attachments/` and are referenced from goal bodies and
cards as `@att/<relative reference name>` (`core/ops.ts:4677`, `formatAttachmentRef`). Path safety is
whitelist-based (`core/ops.ts:4683-4704`, `sanitizeAttachmentPath`): absolute paths, NUL, backslashes,
colons, empty/`.`/`..` segments and segments not matching `[A-Za-z0-9][A-Za-z0-9._-]*` are rejected, and a
trailing dot is forbidden. The per-attachment cap is 50 MiB (`core/ops.ts:4672`,
`MAX_ATTACHMENT_BYTES`). **An attachment that is still referenced may not be deleted**
(`core/ops.ts:5147-5157`: `deleteAttachment` counts references first and rejects when > 0); deletion itself
is a compensable sequence — rename to a same-directory trash, append the event, and rename back if the
event fails (same function).

<!-- sec: cross-board -->

## 10. Cross-board safety

One Git repository may host several boards (the default `<repo>/.dsh-graph` and custom ones such as
`<repo>/boards/board-n/.dsh-graph`). Real Git discovery resolves them to the **same** main worktree, so
their `.worktrees/g-<goal>-att-<NN>` paths and branch names are **byte-identical**. Without proof of
ownership, board B would silently treat board A's worktree as its own execution directory and overwrite the
old binding (`core/worktree.ts:96-107`).

The answer is a two-level ownership source of truth that **reads persisted real metadata instead of guessing
from old naming** (`core/worktree.ts:104-113`):

1. **Ownership marker (authoritative)**: written at creation time into the worktree's **own Git
   administrative directory** (`<git-common-dir>/worktrees/<name>/dsh-graph-board-owner.json`). It never
   enters the working tree, never pollutes `git status`, disappears with `git worktree remove`, and **every
   board can read the same copy** ⇒ cross-board verification needs no new scheduling system and no shared
   cross-board state;
2. **Event provenance (legacy-tree compatibility only)**: whether this board's own `attempt.started` event
   recorded this tree's exact path and its same-numbered goal/attempt. One board's event log cannot see
   another board's records ⇒ cross-board lookups necessarily miss.

When neither exists ⇒ an orphan/external worktree with no proof of ownership: **conservatively refused**;
never silently taken over, renamed or deleted. On a hit, the error names the bound board and refuses reuse
with **zero side effects** (`core/worktree.ts:927`). The cleanup path verifies ownership again:
`cleanWorktree` re-checks the binding before removing a tree, so board B may not delete board A's worktree
(`core/worktree.ts:300-310`). Marker writing became an atomic replace in g-451 — a real crash now leaves
either "the old complete marker" or "no marker", never a half marker that silently disables ownership
protection (`core/worktree.ts:114-140`).

<!-- sec: evidence -->

## 11. Evidence discipline

Delivery and verification evidence has exactly one legal shape: a **single-line structured summary** with
the prefix `evidence:` (`core/ops.ts:8109`, `EVIDENCE_SUMMARY_PREFIX`), capped at 160 characters per entry
(`core/ops.ts:8112`), with the key set exactly `suite` / `passed` / `failed` / `exit` / `ms` / `diff` /
`commit` (`core/ops.ts:8171`; one unknown key makes it non-canonical).

"Banning dumps" is machine-defined in `validateEvidenceSummary` (`core/ops.ts:8299-8339`), with a fixed
decision order `empty → code_fence → multiline → json_dump → dom_dump → too_long → format`: it rejects
multi-line text, code fences, JSON fragments longer than 200 characters, DOM dump keywords, and
over-long/non-canonical shapes (the rationale for that order is in the comment at `core/ops.ts:8290-8298`).

**Honest boundary**: this layer is "guidance + pure function + soft observation" and **not a hard rejection
gate**. `validate` / `parse` only produce a verdict and never reject the call (the design boundary is stated
at `core/ops.ts:8096-8107`); an over-long status/comment merely appends a `report.oversize` event (soft
thresholds: status > 40 characters, comment > 800 characters, `core/ops.ts:8115-8119`; implementation
`core/ops.ts:8347`; wired at status `core/ops.ts:8404` and comment `core/ops.ts:2887`). Structured evidence
never goes into `status_line` — that stays a single human sentence (`core/ops.ts:8103-8106`).

<!-- sec: event-first -->

## 12. Event-first

`events.jsonl` is the single source of truth for all state (R-02), under a **three-phase contract**
(`docs/event-first-commit-contract.zh.md:23-36`):

```text
prepare (caller)  →  event (commitPrepared)  →  persist (commitPrepared)  →  unlock
in-memory only        append events first        write files afterwards
```

- **prepare**: the caller performs all validation and in-memory mutation with **zero file side effects**;
  a `saveGoal` / `atomicWrite` inside the callback is a contract violation;
- **event**: `plan.events` is consumed before any file write; failure ⇒ `TxError(phase="event")`, persist
  does not run ⇒ disk keeps its original values;
- **persist**: files are written after the events are on disk; failure ⇒ a `tx.persist_failed` diagnostic
  event plus `TxError(phase="persist")`, and an idempotent retry of the same call converges.

`appendEvent` is the only write point (`core/events.ts:47-63`); it only appends and never rewrites.

**Honest boundary** (`docs/event-first-commit-contract.zh.md:49-57`, `:143-186`): there is **no claim of
cross-file atomic transactions** — event and persist are two independent writes with a non-atomic window
between them; a failed `persist` is **not retried automatically** (that would mask real EIO/ENOSPC) and
already-appended events are not rolled back. As of that document, 16 write points have still not been
migrated to `commitPrepared` (`createGoal`, `addCard`, `bindCardChild` and others, listed one by one at
`docs/event-first-commit-contract.zh.md:145-149`); when their event append fails they can still leave a
silent state change — file modified, no event, caller sees an error.

<!-- sec: roadmap -->

## 13. The 1.0 roadmap (not implemented)

None of the following exists today. This section describes intentions only and must not be read as current
capability.

### 13.1 Presentation-layer visualisation (not implemented)

Today the client has only kanban columns, drawers and modals — `dsh-graph-host/lib/client/` holds rendering
modules such as `kanban.js`, `card.js` and `goal-modal.js`, and there is **no process or relation diagram
view at all** (the directory listing is the evidence). Goal relations are indeed stored in frontmatter with
a tool-side query surface (`core/ops.ts:3047`; `goalRelationViews` at `core/ops.ts:3284`), but they are
**not rendered as a graph**.

### 13.2 Declarative process semantics (not implemented)

Today the state set and legal transitions are **hard-coded** in `core/machine.ts:10-33`, and the gate
conditions are hard-coded in `assertTransition` (`core/machine.ts:50-91`) and the admission layer
(`core/ops.ts:7771`). A candidate direction is to introduce a process definition (for example
`.dsh-graph/process.yaml`) plus a validator and renderer, moving states, transitions, gates and roles out
of code. That is an architectural change and must be assessed separately.

### 13.3 A different graph per project (not implemented)

Today there is no "choose a process per project" option at all: the supported `project.yaml` keys are
`executor`, `defaults`, `supervisor.automation`, `supervisor.agent_teams`, `review` and so on
(`core/ops.ts:1525`; the default shape in `readProjectConfig` at `core/ops.ts:1529-1533`) — there is
**no** graph/process selection key. The 1.0 goal is for different projects to enable different graphs.

### 13.4 Why this is 1.0 work rather than now

There is one explicit self-imposed constraint in the design: in a single-machine, single-user setting,
**avoid over-engineering**. And this process earns trust through "gates that really exist in the code plus
an event log that can be reconciled", not through a good-looking diagram. Hence the order: first state
plainly **what truly exists today** (this document), then discuss visualisation and declarativisation.

<!-- sec: sources -->

## 14. Appendix: source index

Every path below really exists in the repository; the structural guard
`core/tests/g460-design-philosophy-guard.test.ts` asserts their existence one by one (when a citation
carries a `:line` suffix, the guard validates the file part only).

| Topic | Source of truth |
| --- | --- |
| State set and legal transitions | `core/machine.ts` |
| Criteria-non-empty decision | `core/model.ts` |
| Criteria registration / admission / transitions / results surface / review / memory caps / evidence shape | `core/ops.ts` |
| Event-log append and replay | `core/events.ts` |
| Isolation decision / ownership marker / Git-truth collection | `core/worktree.ts` |
| Version lanes and `released` admission | `core/version-lane.ts` |
| Event-first three-phase contract | `docs/event-first-commit-contract.zh.md` |
| Guide-prompt injection boundary | `docs/guide-auto-injection.md` |
| Supervisor guide (lifecycle / criteria gate / review discipline / memory grading) | `dsh-graph-host/supervisor-guide.zh.md` |
| Supervisor guide (English counterpart) | `dsh-graph-host/supervisor-guide.en.md` |
| Build isolation and release red lines | `AGENTS.md` |
| Release handbook and tarball reconciliation | `docs/release-handbook.md` |
| Structural guard | `core/tests/g460-design-philosophy-guard.test.ts` |
