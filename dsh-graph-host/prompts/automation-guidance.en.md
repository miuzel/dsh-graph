<!-- dsh-graph:automation-guidance:begin -->
<!--
  The single source of truth (en) for the six-key automation action guidance body.
  This file is a data asset: the host `renderAutomationGuidance` reads it and parses the
  `@@<field>` blocks. Structure, gating, language fallback and the empty-string rule all stay
  in code; this file carries prose only and no judgment logic.

  Fields:
  - `@@header` / `@@confirm` / `@@autonomous` / `@@trailer` - section head, human clause, ai clause, trailer;
  - `@@action.<key>` / `@@boundary.<key>` - action and boundary prose per key; the key set is closed and
  maps one-to-one onto `AUTOMATION_GUIDANCE_KEYS`, and missing or duplicated blocks fail closed.-->
@@header
⚠️ **Automation action guidance** (from this workspace's supervisor.automation config):
@@confirm
request the person in charge's confirmation for this action
@@autonomous
decide autonomously within the already authorized scope and leave a trace
@@action.scope_planning
**scope/scheduling and version-plan adjustments**
@@boundary.scope_planning
it is not first-start authorization
@@action.integration_decision
**candidate selection and merge trade-offs**
@@boundary.integration_decision
it is not a review verdict or delivered authorization
@@action.rework
**rework trade-offs for existing goals**
@@boundary.rework
it does not authorize a first start or automatically approve scope expansion
@@action.memory_promotion
**memory distillation**
@@boundary.memory_promotion
it does not bypass the standing privilege: the default stays on_demand, and standing is limited to a human standing instruction or safety prohibition with a 200-character cap
@@action.skill_proposal
**whether to propose a skill**
@@boundary.skill_proposal
it is not installation or release
@@action.release
**release decision**
@@boundary.release
an ai setting still cannot approve delivered on its own
@@trailer
Boundaries and precedence (add-only, never relaxed): human only adds confirmation requirements and is never overridden by a low-risk exemption; an explicit, clearly scoped batch authorization from the person in charge may cover item-by-item confirmation for exactly the listed actions, while a vague directional authorization does not; an explicit prohibition of push/publish/tag always takes precedence; Full access is not business approval. Among the four gates, "start work" and "review" have no corresponding key, so their existing requirements (including that review→delivered must wait for the person in charge's verdict) stay unchanged. This guidance only affects the prompt: it changes no tool permission and is not engine enforcement.
<!-- dsh-graph:automation-guidance:end -->
