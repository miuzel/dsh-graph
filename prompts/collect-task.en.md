## Collection task context

**Working directory**: the assigned worktree/current working directory.
**Canonical attachment root (absolute path, not worktree-relative)**: `{{attRoot}}`
**Data root (.dsh-graph, absolute path)**: `{{dataRoot}}`

**Goal information**:
- id: `{{goalId}}`
- title: {{goalTitle}}

**Card information**:
- id: `{{cardId}}`
- title: {{cardTitle}}

**Collection scope**:
Collect detailed context related to card "{{cardTitle}}" for this card.

**Fill requirements**:
1. Put the full body in `text`; write a concise key-point `summary` (about 100 characters), not a long text.
2. For any file attachments you collect (md/txt text, images, csv/Excel, binaries, ...), call `graph_store_attachment` to write the content under the canonical attachment root above:
   - Text: `graph_store_attachment(name="docs/report.md", content=<UTF-8 text>)`
   - Binary/image/Excel: `graph_store_attachment(name="chart.png", base64=<base64>)` (or a raw byte upload).
   - The returned stable reference name is a relative path (it may contain safe subdirectories, e.g. `docs/report.md`).
3. When referencing an attachment from the card body or goal.md, use `@att/<name>` (e.g. `@att/docs/report.md`); `<name>` is the relative reference name returned by `graph_store_attachment`. References are preserved and resolved in the card body, goal.md, later attempt injections and the GUI view.
4. When done, fill the result with exactly this command:
```
graph_fill_card(goal="{{goalId}}", card="{{cardId}}", text=<full body, may contain @att/<name>>, summary=<summary of about 100 characters>)
```

**Attachment safety and boundaries (strictly enforced)**:
1. Attachments may only be written under the canonical attachment root above and its safe subdirectories; reject absolute paths, `.`/`..` traversal, backslashes and NUL.
2. Do not write or reference files outside `.dsh-graph`; do not use the relative `.dsh-graph/attachments` (unreachable inside the worktree).
3. If you fetch from the internet: only http/https is allowed, with a timeout and a size cap; `file://`, `localhost` and intranet addresses are forbidden (SSRF). Persist fetched results through `graph_store_attachment`; never write to the filesystem directly.

**Strict boundaries**:
1. Do not modify other goals or cards - you may only fill the currently bound card `{{cardId}}`.
2. Do not call `graph_review_card` yourself - the supervisor reviews the result.
3. Run all graph tool operations in the assigned worktree/current working directory.
4. Track progress through the card lifecycle (empty → collecting → filled → reviewed); never create a fake attempt and never call graph_report_status.
