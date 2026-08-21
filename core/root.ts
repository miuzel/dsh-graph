/**
 * 统一 root 解析（g-112）：host 与 client 两半共用同一函数，杜绝解析分叉。
 *
 * 基准 = workspace 根（DSH 官方「运行命令时所在的目录将作为默认 workspace 根」→ process.cwd()），
 * 默认相对 `.dsh-graph`——git 友好、多项目各用各数据（第三方插件数据约定在工作区内，非 $DSH_HOME）。
 * config.root 仍可覆盖（用户层 patch / --patch overlay）：绝对路径原样返回，相对路径以 workspace 根为基准。
 */
import { resolve } from "node:path";

export function resolveRoot(
  config?: { root?: string } | null,
  workspaceRoot: string = process.cwd(),
): string {
  return resolve(workspaceRoot, config?.root ?? ".dsh-graph");
}
