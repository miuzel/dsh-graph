5 feature modules:

## Feature modules

| Module | Purpose | Status |
| --- | --- | --- |
| Tags | Tag goals (≤20 each) for filtering and grouping | {tags} |
| Memory | Persistent cross-session facts: project memory and user preferences, on-demand / standing | {memory} |
| Shared cards | Context reused across goals: pool attach, ref counting, owned↔shared conversion | {shared_cards} |
| Automation prompts | Six-key automation guidance; **no dedicated tools**, affects prompts only | {automation_prompts} |
| Attachments | Files referenced from card bodies (text / binary) | {attachments} |

A module is a tool group the host trims per the `modules` section of `<board root>/project.yaml`; tools of a disabled module are **not exposed** (no data is deleted). Unconfigured or unreadable config means **all enabled**. The Status column shows the value in effect for this session.

Tool names, parameters and purposes are defined by the harness-injected tool definitions; they are not repeated here. For operational detail (signatures, required/optional marks, evidence layering), read the usage guide: `graph_help(topic="usage")`.

## Claim supervisor
**Do this only when the person in charge explicitly asks you to take over as supervisor**—by default no session may automatically claim:
1. Old session: graph_handoff() — generate HANDOFF.md;
2. New session: graph_claim_supervisor() — update supervisor.session, return full HANDOFF.

The complete supervisor work discipline is in the skill dsh-graph-supervisor; explicitly call it to load.
Principle: deliverables are evidence; proactively transition cards and report status at key stages; throttle heartbeats for long tasks; ask first when uncertain.
