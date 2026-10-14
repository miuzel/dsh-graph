Board lanes and the status line are yours to maintain; they must reflect real progress:
1. Lane migration (Human Gate constraint):
   - At start (when not already in_progress): call graph_transition(goal="{goal}", to="in_progress");
   - On a blocker: call graph_transition(goal="{goal}", to="blocked", reason=<one-line reason>);
   - When this round is done: call graph_transition(goal="{goal}", to="review") and stop for adjudication;
   - [Forbidden] never call graph_transition to "delivered" yourself - delivered is the owner/supervisor human gate; stop at review at most.
2. Status reporting (limited milestone triggers; never append mechanically after every action):
   - Report trigger: call graph_report_status(goal="{goal}", attempt="{attempt}", status=<one short line, <=20 chars>) only at the 4 finite milestones: start, phase change / switching to a new task, blocked, and round complete awaiting adjudication;
   - Long-task throttled heartbeat: for long-running work (large builds, multi-step batch investigation) report progress at a moderate heartbeat; ordinary light reads or single-step debugging must never add a mechanical report per step; no status call is required per read/bash action any more;
   - Migration and status sync: update status_line together; when a migration is rejected by the engine (e.g. criteria not registered), do not keep implementing - report and stop immediately;
Tier test intensity by the nature of the change (never manufacture an assertion for a change that does not warrant one):
  - Tier 1 | zero behavioral-logic change (copy/labels/i18n strings, comments, docs, pure styling): no new unit tests required, but you must provide real evidence such as the full existing suite still green plus build/syntax checks passing (or real-machine visual verification);
  - Tier 2 | small logic change (branches, data transformation, boundary and error handling): targeted unit tests covering the changed branches, with the original behavior not regressing;
  - Tier 3 | new feature / contract change / core-layer rewrite / concurrency and state machines: complete unit tests plus boundary and negative cases, and a "breaking it turns it red" negative control when necessary;
  - Iron rule: never skip, delete, or weaken existing tests because a change is "lightweight/copy-only", and never lower criteria gates or human gates.
Evidence form: report deliverables only as a single-line structured summary (one suite per line, at most 160 characters each), formatted as `evidence: suite=<id> passed=<n> failed=<n> exit=<code> ms=<n> diff=<files>f/+<a>/-<d> commit=<sha7>`, together with the assertion command and its conclusion; never dump multi-line JSON, DOM dumps, sliced data, raw logs, or fenced code blocks; turn runtime invariants into automated assertions and keep lightweight screenshot verification only for the non-codifiable UI/visual layer.
