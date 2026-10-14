## Hand-back report skeleton (tail note - every item required; a missing item means the delivery is incomplete)

This report is the main material for the completion summary (results.md): the more disciplined it is, the more trustworthy the summary. Answer item by item and keep the headings verbatim so they stay machine-readable.

### A. executor report (8 required items)
1. **Delivery location**: worktree / branch / commit / baseline (one line).
2. **What changed**: files and modules grouped by capability, one sentence per file on what it adds.
3. **How it was changed**: key design, data flow, why this way (including rejected options and why they were rejected).
4. **Impact surface**: who is affected (runtime environment, other goals, release meaning, compatibility, config migration).
5. **Tested / not tested**: command plus a single-line evidence summary (including **negative controls** and **baseline comparison**); unverified items and why.
6. **Worth noting**: risks, leftovers, known defects, follow-up dependencies (one sentence each).
7. **Criteria mapping**: each criterion to met or not met plus where the evidence is.
8. **Decisions needed from the supervisor**: listed one by one, each with a default recommendation.

### B. reviewer report (6 required items)
1. **Overall verdict**: one verdict word only, on its own line (PASS / BLOCK / UNVERIFIED - pick one), e.g. {{conclusion_example}} (with a one-line reason).
2. **Per-item conclusion and single-line evidence**: each criterion to its conclusion plus evidence.
3. **BLOCK minimal rework list**: directly actionable rework items, one by one.
4. **Non-blocking notes**: issues that can ship but must be recorded.
5. **Residual risks**: what still remains after the fix.
6. **Unverified items**: paths not covered and why.

### C. Report length budget (soft cap; exceeding it is not a failed delivery, but you must self-report)
- Soft cap for the report body: {{soft_max_kib}} KiB (storage stays at 64 KiB and reads at 1 MiB: the archive stays complete and only the copy fed to the LLM is trimmed);
- Per-section budget: **what changed <= 1.5 KiB**; **how it changed <= 1 KiB**; **impact surface / tested-not-tested / worth noting / criteria mapping <= 0.5 KiB each**; every other item stays one line;
- When you exceed the soft cap, add one self-report line at the **end** of the report: `over budget: <actual bytes>/4 KiB` (never delete evidence, never drop unverified items, never trim the criteria mapping);
- The input sent to the LLM summary is hard-capped: 8 KiB per attempt (head 4 KiB + tail 2 KiB + a middle omission marker) and 256 KiB in total, so writing compactly is what keeps information from being dropped; the writer records the omitted byte count inside the summary.
