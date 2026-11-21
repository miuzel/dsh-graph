# g-628 port ledger (unfinished candidate)

Base `9cf4f2e`; release reference `d701952`; prior candidate `6058849`. No release version strings or release documents were ported.

| Scope | Candidate and conflict |
| --- | --- |
| g-624 | Provider lookup and flat/nested activation compatibility taken from the prior v1 port; provider/query failures remain explicit. |
| g-625 | Ancestor interrupt and session catalog projection/disposal adapters ported; unknown catalog is not treated as empty. |
| g-626 | Release parentSession fallback retained when the child root lookup throws. Owner root lookup exceptions now return unknown: a real rc.3 stale caller produced an unauthorized dispatch and an attempt before the host rejected delivery. |
| g-474 | Existing version branch, baseline resolution, reused child cwd and response fields retained from v1, not replaced by the release branch. |
| Smoke registry | Release rc.3 tool plugin inventory entries added to prevent unknown combination declarations. |

## att-008 unversioned reuse baseline

On the fixed rc.3 host, the actual `workingDirectory.get(child.session)` reported a live idle child in a second Git worktree. With the previous version-only guard, both default and explicit main-tree baselines were accepted despite a different child HEAD. The real-host matrix also showed unknown cwd accepted; all four negative cases failed their rejection assertions, while both same-tree cases passed. Extending the existing guard to every reused child yields six passing cases; rejection tests compare attempts, status, events, live agents, worktrees, send and startActivation calls. Unknown cwd is injected only after observing the real child cwd; it is a fault-injection case, not a claim that the real service naturally returned unknown. No non-Git reused child can now be admitted without a verifiable Git baseline.

## Evidence and unresolved risks

Real host `@deepseek-ai/dsh` version `0.2.2-rc.3`, installed at `/home/miuzel/.local/share/fnm/node-versions/v26.7.0/installation/lib/node_modules/@deepseek-ai/dsh`. The real stale-caller regression failed before the owner-root fix (dispatch returned after delivery rejection) and passed after it, with no message, attempt, event, worktree, registry set or catalog change. A real separately resumed idle child preserved its original parentSession while rootOf(child) threw UNAUTHORIZED: release fallback said yes and dispatch wrote an attempt before host delivery failed. The reuse path now requests strict live-tree verification; the real regression turned green and checks the same full side-effect set. A real managed direct child, same-tree different-parent child, cross-tree child, cold child, and an ordinary fork built through the host's public buildForkSeed + agents.create path were tested. Rejection cases check registry and catalog sets and no messages/attempt/events/worktrees. The real controller endpoint itself was not used: ordinary fork via that exact endpoint is UNVERIFIED.

### Shared ownership fallback consumer inventory

- `sampleRunningChildren`: count influences keepalive eligibility and wake actions. Strict live-tree verification now returns unknown for an independently resumed child whose root lookup is unauthorized; see `g628-resumed-care-evidence.md` for real-host evidence and limits.
- `capabilityOf` and `keepaliveStatusProjection`: capability/explanation, not direct ownership verdict; affect eligibility/display respectively.
- `entryOfChildAgent`: event association influences scheduler and entry state; it now requires verified live-tree ownership.
- `sampleTasks`: combines board binding, workspace and running registry with strict live-tree ownership. Real-host fault-window evidence and its limitations are documented in `g628-resumed-care-evidence.md`.
- `capabilitiesOf`: reports capabilities and derives child session progress-read availability from sampled tasks; downstream decision data, not a standalone authorization.
- `submitOutcome`: checks an exact live supervisor, binding/inspection/freshness, running child and workspace, and now requires verified live-tree ownership before applying outcomes. Real-host fault-window tests cover independently resumed children; their production reachability limits remain documented separately.
- `callerOwnsChild`/`inspectReuseChild`: now opts into strict live-tree ownership; real stale owner and independently resumed child are rejected before side effects.

Real-host care/keepalive tests and the strict-ownership changes supersede the earlier unverified description. They do not prove every production fault window reachable or global security; see `g628-resumed-care-evidence.md`. A synthetic old-API adapter is not evidence for real runtime ownership.

Initial targeted run: 75 tests, 72 passed, 3 failed. The original g613 count assertion used the removed rc.3 list method; it was replaced with an entire live-registry set assertion and its real-host suite passed 6/6. The g625 strict-ownership assertion now explicitly exercises the reuse strict mode, retaining both original expected unknown assertions and the separate reuse rejection test. The four g626 matrix failures came from a fixture throwing for both owner and child: it now fails child root only, keeps the full fallback matrix and adds an explicit owner-root unauthorized regression. Targeted compat/real-host suite: 51/51 passed. These changes make the intended distinction explicit; a passing suite is not proof of shared fallback safety.

Initial full self-gate: 3038 tests, 3033 passed, 5 failed. After inventory and owner-root fixes: 3039 tests, 3033 passed, 6 failed (two g625 and four g626 assertions). After strict reuse-mode and fixture separation: `TMPDIR="$PWD/tmp" node scripts/run-tests.mjs` self-gate passed 3042/3042, exit 0, 98001 ms after the complete catalog-set assertion was added; g474 passed 17/17; isolated build, TypeScript check, dist syntax and import succeeded. The later strict live-tree changes and real-host evidence are documented in `g628-resumed-care-evidence.md`; independent review and a decision on the remaining unverified production fault windows remain mandatory before integration.
