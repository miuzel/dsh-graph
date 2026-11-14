# DSH 0.2.2-rc.3 / rc.1 compatibility investigation

- **已修复（源码与夹具）**：rc.3 官方安装的 `dsh-subagent` 导出 `getProvider(name)`，无 `list`；spawn 官方插件默认名称 `spawn`。旧 `list?.() ?? []` 误称无注册 provider，五处统一改用探测。
- **已验证（形态夹具）**：rc.1 `list` 支持自定义名称及空列表；rc.3 具名查询 spawn/fork、不声称全局空；缺 API、异常与无默认 provider 区分。rc.1 真实宿主整套测试随全量门禁运行，具体链路另见测试。
- **未验证**：rc.3 隔离真实宿主中从 provider 探测到准入及 start 的无模型完整链路；已安装启动真实 rc.3，但尚无链路证据。
- **未验证**：rc.3 相对 rc.1 的其他宿主接口及平台整体兼容；不把 rc.2 历史线索视为 rc.3 实测。rc.2 list 被移除是历史报告，未重新实测。
- **已知限制**：无枚举 API 时仅检测官方默认名 spawn/fork，自定义名称不能发现，诊断明确说明。
- **发布前未验证**：原生 Windows 与其他平台、实际模型调用；发布、tag 与推送仍须负责人单独批准。
