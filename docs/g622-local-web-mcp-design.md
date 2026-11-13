# g-622：独立本地 Web App + localhost MCP 研究

2026-11-13；基线 `d4d91fec6c576ebf4cdab353ae62008751b07893`。仅设计，无服务实现/启动、安装或运行认证。官方接口证据与三态见 [recon](<g622-official-host-recon.md>)；本文的安全规则是拟议验收要求，不是宿主已有保证。

## 1. 服务边界与单一真源

- 独立本地服务同进程提供静态 Web App、Web API、MCP endpoint；浏览器承担浏览、设置、可视化与未来人工操作，CLI 仅消费 skills/MCP，不假设 CLI Web UI。
- Web API 与 MCP 都只调用 g-620 [公共 core/store/application 草案](<v1.0.0-public-contract-draft.md>)；浏览器不直接读写磁盘，transport 不拼接 frontmatter/事件、不绕过状态机、锁、CAS 或恢复逻辑。契约尚未批准，不在本文新增公共 API。
- 一个显式配置的 graphRoot 对应既有 graph 文件与项目配置；root 与 executionWorkspace 分开，不按客户端 cwd/roots 参数切换。未初始化只报告错误，不 init/claim。两入口共享同一 application/store，不能复制 graph、事件或项目配置为第二真源；缓存只是可丢弃投影。
- 服务私有运行配置只保存绑定、端口、显式 root 和凭据位置等连接信息，不镜像项目业务设置；Web 设置页读取/未来修改同一项目配置。g-621 组件只作为复用候选，不复制配置模型。
- 现有 DSH adapter/UI/工具、profile、发布链独立保留；新服务不是 DSH 的前置依赖。多进程同时写同一 root 尚未认证；未来写阶段必须验证共享事务边界，未验证不得绕过或自造锁库。

## 2. 端口、绑定与请求边界

单机单用户，默认信任携带正确 token 的 loopback 调用；token 表示本地服务访问权，**不代表 human/owner/审批权**。不抵御已能读取本用户凭据的同 UID 恶意进程，不增加多租户/RBAC/跨机身份。

- 候选为一个显式或自动分配的未占用高位端口，Web/MCP 同 origin、不同路由；具体端口不冻结，不占用户实例 3080。端口冲突报错或重新选择并明确展示，不接管现有服务。
- 只绑定数值 loopback `127.0.0.1`；若开启 IPv6，只能另行显式绑定 `::1` 并验证 v6-only，禁止 `0.0.0.0`、`::`、LAN 地址及“失败后通配回退”。localhost 只是访问别名，解析结果须全部为 loopback，不能仅检查字符串。
- 每个请求校验实际 socket peer 为 loopback；不信 X-Forwarded-For/反向代理。校验 Host 为实际端口的本地 allowlist，拒绝 DNS rebinding。无远程 HTTP 部署、代理暴露、隧道或 OAuth 路线。
- MCP 拟用本地 HTTP transport；固定协议/SDK版本与 client 兼容性留给实现前 probe，不声称 HTTP 已连通。必须先认证再解析业务/访问 store，每个请求及重连均验证 token，不能靠 session ID 延续过期权限。
- CORS 不开放通配；浏览器 Web API 只允许同 origin，拒绝外站 Origin；有 Origin 的 MCP 请求也只接受显式本地 allowlist，无 Origin 的 CLI 仍需 peer+token。只监听 loopback 不能代替浏览器跨站防护。

## 3. token 生命周期（拟议实现项）

| 环节 | 设计要求 |
|---|---|
| 生成 | 服务首次显式初始化时用 OS CSPRNG 生成至少 256 bit 随机秘密；不从 root、用户名、模型输出或固定默认值派生；失败即不开放 API |
| 保存 | 服务私有凭据文件，Linux 目录 0700/文件 0600，Windows 使用当前用户 ACL；权限无法限制则拒绝启动；不入 Git/graph/项目共享配置，不随导出/日志泄露 |
| 注入 MCP | 本地用户在宿主私有配置设置 endpoint 与 Authorization Bearer 的安全环境引用/秘密加载；由 client transport 注入 header，绝不在工具 schema/args/prompt/skills 中传 token；实际语法和脱敏待逐宿主 probe |
| 注入 Web | 人在本地 UI 输入/粘贴凭据，经同 origin API 换短期 Web 会话；秘密不放 URL/query/hash、静态 bundle 或 localStorage，不打印完整 token；会话候选 HttpOnly+SameSite=Strict，并验证本地 HTTP 的浏览器行为 |
| 轮换 | 可信本地用户经服务管理入口原子替换凭据，立即拒绝旧 token、关闭旧 MCP 会话、撤销 Web 会话；客户端安全更新后重连，无双 token 宽限默认值 |
| 失效 | 删除/撤销凭据、轮换或显式停用后旧连接不得继续访问；重启不恢复旧 Web 会话；丢失/泄露由本地用户重置，禁止模型工具重置/显示 token |
| 卸载 | 先停服务并确认监听释放，撤销凭据/会话；只移除本次自有运行凭据与连接配置，保留 graph 数据；配置备份不得把已撤销秘密恢复成有效凭据 |

Web 会话与 MCP token 分离，MCP token不能调用人工审批路由；Web 登录本身也不等于已批准某个写操作。无需 OAuth、远程身份服务或复杂权限系统。以上凭据文件和会话不是第二份 graph 配置真源。

## 4. 只读 MVP 与未来人工写入

只读白名单：列目标/版本、读目标描述/判据/状态、读取卡片/结果摘要与 board 派生投影、读取脱敏项目设置。附件只能通过固定 root 内安全引用读取；token、运行秘密与任意文件读取均不暴露。按实际副作用审查白名单，不直接注册所有 graph_*；例如 rebuild、refresh_results、handoff、validate 等在未证明纯读前不进入 MVP。

Web MVP 同样只读；设置页只展示，写控件禁用并说明原因。MCP 不注册 create/update/delete、claim、start/reuse/review、accept/delivered、清理、凭据管理。直接构造这些调用仍须拒绝且零 store 副作用。无可信 actor/执行/审批能力时只读或拒绝，不伪造 DSH session/child。

未来写路径（另批实施，不改变现有 DSH 授权语义）：本地人打开独立 Web UI，经独立 Web 会话查看确定的 root、操作、参数、差异与当前 revision，明确点击确认；可信服务端注入 actor/审批上下文，application 重新检查权限和 CAS 后执行既有事务。批准绑定单次操作、参数、root、revision、有效期；过期/变更/重复消费拒绝并重新展示。不从 MCP 参数接受 actor、human=true、approval 或模型自然语言“同意”。写操作及 Human Gate 的具体语义沿用公共契约，不能以 UI 点击扩大权限。若未来需要 MCP 写，必须单独设计这条可信人工路径，当前不开放。

## 5. 隔离 probe 计划（未授权执行）

所有 probe 在当前项目 `tmp/g622-probe/<host>/<pinned-version>/` 私有 HOME/config/cache/workspace、无用户凭据环境，使用预审查离线包；不连接用户服务或 DSH GUI。固定 OS、CLI/SDK/协议版本和包 hash，先取得负责人批准；本轮不下载、构建或启动。

1. **服务/Web**：离线安装私有包，绑定独占 loopback 高位端口；静态页面、认证、只读列表/详情/设置展示、断连与重启；无 DSH 环境也可工作。卸载停进程、确认端口释放、撤销凭据、恢复配置，graph hash 不变。
2. **无宿主 MCP**：独立测试 client 做初始化、capability、tools/list/call、无 roots、错误 schema、断连重连。对照有效 token 的合法只读请求成功，证明拒绝不是服务整体不可用。
3. **Claude Code**：固定 CLI 版，私有 HOME/CLAUDE_CONFIG_DIR，离线 skills/本地插件可选封装；验证 HTTP endpoint/header/env、秘密不进入模型转录、scope、拒绝审批、只读工具发现。移除自有 skills/client 配置，重启工具消失，备份逐字节恢复。
4. **OpenCode**：固定 V1 或 latest 单一版，私有 HOME/XDG config/data/cache；验证 local HTTP MCP、header/env 插值、skills 搜索、工具命名、禁用/重连。禁止自动拉依赖；移除自有配置和 skills，重启验证工具消失，不能照搬另一版卸载命令。
5. **Codex**：固定 CLI 与所需 MCP 配置版本，私有 HOME/CODEX_HOME；CLI MCP transport、Bearer/env 注入、skills 发现/作用域、信任提示、重连/卸载均待实测。X1 SDK 与 X3 app-server 不能替 CLI 认证；缺支持直接标 unknown/unavailable，不启动 SDK 兜底。
6. **记录/回滚**：逐项保存版本、命令、预期/实际、退出码、脱敏诊断、用户配置与 graph 前后 hash；只删除本次自有文件。需要产品语义取舍时停止报告；范围扩大前人工确认及后续实现全量回归、Windows 实测。

## 6. 安全负向矩阵（实施前必须完成，当前全部未运行）

每项均先以合法只读请求作正向对照；拒绝前后比较整个 graph 树内容/目录及事件、锁、配置、初始化状态，要求零持久副作用。安全诊断只可写服务私有脱敏日志，不得写 graph；启动拒绝不得残留监听。未来写用例仅在另批实现阶段执行。

| 输入/情形 | 预期拒绝与观测 |
|---|---|
| 远程/通配绑定、localhost 解析出非 loopback、v6 dual-stack 外放 | 启动前拒绝，无监听；不回退公网 |
| 非 loopback peer、伪造 X-Forwarded-For、非法 Host | 请求拒绝，不访问 store，不信代理头 |
| 缺/空/错误 token、工具 args 伪 token、仅有 session ID | 认证失败；业务 dispatcher 未调用；响应不泄露真实 token |
| 轮换后旧 token/旧连接、撤销后重连 | 全部拒绝；新 token 合法只读成功 |
| 外站 Origin/CORS、跨站 Web 表单、MCP token 调人工路由 | 拒绝；无跨站凭据泄露/审批升级 |
| ../、编码穿越、绝对路径、根外 symlink、客户端 roots 覆盖 | 拒绝越界；根外 sentinel 与 graph hash 不变 |
| 伪 actor/owner/human/approval、伪 parent/child、未知 capability | 不作为可信上下文；拒绝提权/执行，无 claim/绑定/结果生成 |
| 未注册写工具、直接 Web 写 API、GET 触发隐式 init | 拒绝；无目录、事件、锁或配置变更 |
| 未来确认过期/重复/参数或 revision 改变 | 写阶段重新校验并拒绝，不能复用批准 |
| 凭据文件宽权限/轮换失败/端口占用 | fail-closed；旧状态明确，不打印秘密、不抢占用户端口 |

这是安全验收计划而非通过证据；尤其不能把缺 token 被拒绝推断为所有负向都已覆盖。

## 7. 本轮文档验证边界

仅检查 Markdown 本地引用存在、来源 URL 结构、Git 相对权威基线仅文档新增、产品/测试/依赖路径零差异及 `git diff --check`。外链能力依据继承 recon 的 att-001 fetch，未重新认证滚动内容；没有任何 CLI/服务运行、安全负向、安装/卸载或构建测试通过声明。
