## Collection task context

**Working directory**: the assigned worktree/current working directory.
**Canonical attachment root**: `{{attRoot}}`
**Data root (.dsh-graph)**: `{{dataRoot}}`

**Goal information**:
- id: `{{goalId}}`
- title: {{goalTitle}}

**Card information**:
- id: `{{cardId}}`
- title: {{cardTitle}}

**Collection scope**:
Collect detailed context related to card "{{cardTitle}}" for this card.

**Fill requirements**:
1. Put the full body in `text`; write a concise key-point `summary` (about 100 characters).
2. Store discovered attachments with `graph_store_attachment` under the canonical attachment root.
3. Reference attachments with `@att/<relative-name>` in the card body or goal.md.
4. Fill the result with exactly:
```
graph_fill_card(goal="{{goalId}}", card="{{cardId}}", text=<full body>, summary=<short summary>)
```

**Strict boundaries**:
1. Modify only the bound card `{{cardId}}`; do not modify other goals or cards.
2. Do not call graph_review_card; the supervisor reviews the result.
3. Run graph tools in the assigned worktree/current working directory.
4. Use card lifecycle only; do not create a fake attempt or call graph_report_status.
