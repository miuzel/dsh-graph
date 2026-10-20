## Hand-back report skeleton (tail note - every item required; a missing item means the delivery is incomplete)

This report is the main material for the completion summary (results.md): the more disciplined it is, the more trustworthy the summary. Answer item by item and keep the headings verbatim so they stay machine-readable.
(Reviewer subagents have their own dedicated skeleton; it is not listed here - an executor only answers the 6 items below.)

### Executor report (6 required items)
1. **Delivery location and changes**: worktree / branch / commit / baseline, plus files and modules grouped by capability (one sentence per file on what it adds).
2. **How it was changed**: key design, data flow, why this way (including rejected options and why they were rejected).
3. **Impact surface**: who is affected (runtime environment, other goals, release meaning, compatibility, config migration).
4. **Tested / not tested**: command plus a single-line evidence summary (including **negative controls** and **baseline comparison**); unverified items and why.
5. **Residual risks and criteria mapping**: risks, leftovers, known defects (one sentence each) plus each criterion to met or not met with where the evidence is.
6. **Decisions needed from the supervisor**: listed one by one, each with a default recommendation.

### Report length budget (soft cap; exceeding it is not a failed delivery, but you must self-report)
- Soft cap for the report body: {{soft_max_kib}} KiB (storage stays at 64 KiB and reads at 1 MiB: the archive stays complete and only the copy fed to the LLM is trimmed);
- Per-section budget: **delivery location and changes <= 1.5 KiB**; **how it changed <= 1 KiB**; **impact surface / tested-not-tested / residual risks and criteria mapping <= 0.5 KiB each**; every other item stays one line;
- When you exceed the soft cap, add one self-report line at the **end** of the report: `over budget: <actual bytes>/4 KiB` (never delete evidence, never drop unverified items, never trim the criteria mapping);
- The input sent to the LLM summary is hard-capped: 8 KiB per attempt (head 4 KiB + tail 2 KiB + a middle omission marker) and 256 KiB in total, so writing compactly is what keeps information from being dropped; the writer records the omitted byte count inside the summary.
