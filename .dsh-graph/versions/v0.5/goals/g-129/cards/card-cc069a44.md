---
{
  "id": "card-cc069a44",
  "goal": "g-129",
  "title": "调研：DSH web GUI 打开文件/编辑器机制（goal.md 链接打开方式）",
  "kind": "text",
  "status": "reviewed",
  "filled_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "filled_at": "2026-08-22T16:54:12+08:00",
  "content_ref": null,
  "summary": "goal.md 打开方案：主推 A——复用 DSH 现成 host.openPath（ProducedFiles 产物文件行同款链路：connection.api.host.openPath({path}) → 宿主 OS 默认应用，.md 走系统默认关联进编辑器；loopback+canOpenPath 门控，当前 127.0.0.1 可用）。方案 B 增强：host 仿 settings.openDocument 加文本编辑器意图（.md 必进编辑器），canOpenPath=false 时回退返回路径文本。方案 C web 内编辑暂缓（无 fs RPC、与 agent 并发写冲突）。编辑后需用户触发重读（后续可做 watch）。dsh-file-reference 仅 @ 补全无打开能力；目录选择器只选目录。",
  "child_id": "9b70f32c-6b15-48f5-adbf-a370479234a6",
  "parent_session_id": "session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36"
}
---

# DSH Web GUI 打开文件/编辑器机制调研（g-129）

## 结论速览
DSH 无 web 内编辑器，但有成熟的生产链路：**浏览器点击 → 宿主 OS 默认应用打开**（ProducedFiles 产物文件行、工具 diff 卡片在用）。推荐方案 A：复用 `host.openPath` + 复制路径兜底。

## 各机制盘点
- **dsh-file-reference**：仅 @ 补全（fileReferences.list 返回路径候选），无打开/编辑器能力；
- **dsh-client-ui-deliverables**：ProducedFiles 组件产物 chip `onClick: () => openFile(path)`（client.js:271-273），openFile 由 conversation 注入（:10188-10191）→ 相对路径按会话 cwd 解析 → `workspaces.openPath`；
- **host.openPath**（核心）：`host.openPath({path}) → {opened:true}`，浏览器→宿主 OS 默认应用（darwin open / win32 Invoke-Item / linux xdg-open）；.md 不在 BROWSER_DOCUMENTS，走系统默认关联（通常编辑器）；能力探测 host.describe.canOpenPath + loopback 门控（当前 127.0.0.1=true）；
- **host.openNativeTextFile**（macOS open -t 强制文本编辑器）已存在但仅 settings.openDocument 用；
- **dsh-host-directory-picker**：只选目录（browse 只列目录），无文件打开；
- **dsh-tool-str-replace-editor**：agent 工具（str_replace_editor），GUI 不可复用，其 ctx.fs 写路径语义可参考；
- **web 侧无通用文件读写 RPC**（文件域只有 listDirectory/createDirectory/openPath/settings.openDocument/attachment）。

## 方案对比
| | A. 系统编辑器（native open）| B. 复制路径 | C. Web 内查看/编辑 |
|---|---|---|---|
| 机制 | 复用 host.openPath | 新 RPC openDocument（openTextFile 意图）| clipboard | 全新 fs RPC+编辑器组件 |
| 可行性 | 高（链路全现成）| 高（host 约 20 行）| 最高 | 低 |
| 风险 | 远程/无头打不开；.md 默认关联可能非编辑器 | 意图明确 .md 必进编辑器；同样受环境限制 | 用户自己粘贴 | 无 fs RPC、与 agent 并发写冲突 |

## 推荐
1. **A 主推**：看板目标卡片/抽屉加「打开 goal.md」按钮 → `ctx.get("connection").api.host.openPath({path})`，路径取 goal.md 绝对路径；与 ProducedFiles 同一宿主打开器、零新协议；
2. **B 增强**（可选）：host 加 graph 域 openDocument（openTextFile 意图），canOpenPath=false 时返回 {opened:false,path} 让 GUI 显示路径；
3. **C 暂缓**：web 内编辑成本高、与 agent 并发写冲突；如需预览可只做只读 markdown。

UX 补一环：编辑后用户需主动触发 GUI 重读（或后续做 watch/刷新）。

（纯调研，未改任何文件。）
