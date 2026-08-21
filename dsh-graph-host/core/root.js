/**
 * 统一 root 解析（g-112）：host 与 client 两半共用同一函数，杜绝解析分叉。
 * g-113 修订：基准 = 会话 workspace（session.header.cwd），不再默认服务进程 process.cwd()——
 * dsh web 服务进程的 cwd 在 bwrap 沙箱里固定（≈ ~/.dsh/profiles/web），不是当前会话的 workspace，
 * 用它会读到 profile 本地空骨架而非项目自己的 .dsh-graph。
 *
 * 约定：resolveRoot(config, workspaceRoot) 的 workspaceRoot 必须由调用方显式注入——
 * host 工具侧传 ex.agent.session.header.cwd（或 sandboxPolicy.workspaceRoot），
 * client board 端点侧传请求携带的 workspace 参数；process.cwd() 仅作最后的兜底
 * （CLI/headless 等无会话上下文场景）。
 * 默认相对 `.dsh-graph`——git 友好、多项目各用各数据（第三方插件数据约定在工作区内，非 $DSH_HOME）。
 * config.root 仍可覆盖（用户层 patch / --patch overlay）：绝对路径原样返回，相对路径以 workspace 根为基准。
 */
import { resolve } from "node:path";
export function resolveRoot(config, workspaceRoot = process.cwd()) {
    return resolve(workspaceRoot, config?.root ?? ".dsh-graph");
}
