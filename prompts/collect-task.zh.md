## 收集任务上下文

**工作目录**：当前分配的 worktree/当前工作目录。
**canonical 附件根（绝对路径，非 worktree 相对路径）**：`{{attRoot}}`
**数据根（.dsh-graph，绝对路径）**：`{{dataRoot}}`

**目标信息**：
- id: `{{goalId}}`
- 标题: {{goalTitle}}

**卡片信息**：
- id: `{{cardId}}`
- 标题: {{cardTitle}}

**收集范围**：
请收集与卡片「{{cardTitle}}」相关的详细上下文信息，用于填充该卡片。

**回填要求**：
1. 把正文全文写进 `text` 参数；`summary` 写一句话要点式摘要（≤100 字左右），不要长文。
2. 若收集到文件附件（md/txt 文本、图片、csv/Excel、二进制等），调用 `graph_store_attachment` 把内容写入上面的 canonical 附件根：
   - 文本：`graph_store_attachment(name="docs/report.md", content=<UTF-8 文本>)`
   - 二进制/图片/Excel：`graph_store_attachment(name="chart.png", base64=<base64>)`（或原始字节上传）。
   - 返回的稳定引用名为相对路径（可含安全子目录，如 `docs/report.md`）。
3. 回调正文或 goal.md 时，用 `@att/<relative-name>` 引用附件（如 `@att/docs/report.md`）；引用会在卡片正文、goal.md、后续 attempt 注入与 GUI 查看时保留/解析。
4. 完成后调用以下精确命令回填结果：
```
graph_fill_card(goal="{{goalId}}", card="{{cardId}}", text=<全文可含 @att/<name>>, summary=<≤100字摘要>)
```

**附件安全与边界（严格遵守）**：
1. 附件只能写入上述 canonical 附件根及其安全子目录；拒绝绝对路径、`.`/`..` 穿越、反斜杠、NUL。
2. 不得写入或引用 `.dsh-graph` 之外的文件；不要用相对 `.dsh-graph/attachments`（worktree 内不可达）。
3. 若从互联网抓取：仅允许 http/https，设置超时与大小上限，禁止 `file://`、`localhost`、内网地址（SSRF）；抓取结果经 `graph_store_attachment` 安全落盘，不得直接写文件系统。

**禁区（严格遵守）**：
1. 不得修改其他 goal 或 card——只能回填当前绑定的卡片 `{{cardId}}`
2. 不得自行调用 `graph_review_card`——完成后由 supervisor 复核
3. 所有 graph 工具操作必须在当前分配的 worktree/当前工作目录下运行
4. 进度协作依托卡片生命周期（empty → collecting → filled → reviewed），不创建虚假 attempt，绝不调用 graph_report_status
