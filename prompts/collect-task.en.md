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
1. Put the full body in `text`; write a concise key-point `summary` (about 100 characters); no long text.
2. If file attachments are collected (md/txt text, images, csv/Excel, binary, ...), call `graph_store_attachment` to write the content under the canonical attachment root above:
   - Text: `graph_store_attachment(name="docs/report.md", content=<UTF-8 text>)`
   - Binary/image/Excel: `graph_store_attachment(name="chart.png", base64=<base64>)` (or raw byte upload).
   - The returned stable reference name is a relative path (may contain safe subdirectories, e.g. `docs/report.md`).
3. When referring back from the card body or goal.md, reference attachments with `@att/<relative-name>` (e.g. `@att/docs/report.md`); references are preserved/resolved in the card body, goal.md, later attempt injection and GUI viewing.
4. Fill the result with exactly:
```
graph_fill_card(goal="{{goalId}}", card="{{cardId}}", text=<full body, may contain @att/<name>>, summary=<short summary>)
```

**Attachment safety and boundaries (strictly observe)**:
1. Attachments may only be written under the canonical attachment root above and its safe subdirectories; reject absolute paths, `.`/`..` traversal, backslashes, NUL.
2. Do not write or reference files outside `.dsh-graph`; do not use the relative `.dsh-graph/attachments` (unreachable inside the worktree).
3. If fetching from the internet: only http/https, set a timeout and size cap, forbid `file://`, `localhost`, intranet addresses (SSRF); store fetched results safely via `graph_store_attachment`, never write the filesystem directly.

**Strict boundaries**:
1. Modify only the bound card `{{cardId}}`; do not modify other goals or cards.
2. Do not call graph_review_card; the supervisor reviews the result.
3. Run graph tools in the assigned worktree/current working directory.
4. Use card lifecycle only (empty → collecting → filled → reviewed); do not create a fake attempt or call graph_report_status.
