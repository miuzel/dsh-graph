/**
 * g-626：轻量「真实宿主」夹具的 rc.3 归属面（**测试夹具层**，不进产品代码）。
 *
 * 背景：g-5xx/g-6xx 有一批夹具为了速度只装载 SessionStore / AgentRegistry / AgentLoop，
 * **不装载** `dsh-subagent`（真实宿主在 rc.3 由它提供 `subagents.rootOf`），并直接用
 * `reg.create({ parentAgent })` 造子会话。rc.1 的 `agents.isOwnedBy` 能从这种创建方式判出父子；
 * rc.3 删除了该 API，而 `rootOf` 只认 `session.header.parentSession` + **确切 live 对象**。
 *
 * 于是同一份夹具在 rc.3 上会把所有 running child 判成「归属不可确认」⇒ children_probe /
 * keepalive agentsOk / care 采样整体不可用。本 helper 把夹具补成与真实宿主**同形**的 rc.3 语义：
 *   ① 包装 `reg.create`：把 `parentAgent` 映射为会话头的 `parentSession`（真实 dsh-subagent 的
 *      `startActivation` 正是这么写的；rc.3 的 `create` 本身不认 `parentAgent` 选项）；
 *   ② 提供窄 `rootOf`：非 live / 对象身份不符 ⇒ `UNAUTHORIZED`（与真实 rc.3 一致）；否则沿
 *      `parentSession` 上溯到最近 live 祖先（无活父 ⇒ 自身即树根）。
 *
 * 这**不**替代真实宿主证据：端到端关照在 `_g610-real-host.ts`（装载真实 SubagentRuntime）上验证，
 * 归属回退矩阵由 `g626-ownership-parent-fallback.test.ts` 直接钉住。
 */

const UNAUTHORIZED_MESSAGE = "agent has no active runtime owner";

function unauthorized(message: string): Error {
  return Object.assign(new Error(message), { code: "UNAUTHORIZED" });
}

/**
 * 安装 rc.3 归属面并返回 `subagents` 服务桩。
 *
 * @param hostCtx 宿主 Context（会把桩 `provide("subagents", …)`，供生产 `apply` / runtime 的
 *   `ctx.get("subagents")` 读取）
 * @param reg 真实 `AgentRegistry`
 * @returns `{ rootOf }` 窄服务桩（同时作为 `host.subagents` 暴露给手写 ctx 包装）
 */
export function installRc3SubagentOwnership(hostCtx: any, reg: any) {
  const origCreate = reg.create.bind(reg);
  reg.create = async (options: any) => {
    const parent = options?.parentAgent;
    const parentSid = parent?.session?.id ?? parent?.id;
    const next = parentSid === undefined || parentSid === null || parentSid === ""
      ? options
      : { ...options, meta: { ...(options?.meta ?? {}), parentSession: String(parentSid) } };
    return origCreate(next);
  };
  // rc.1 夹具惯用 `reg.enter(child, ownerAgent)` 声明归属；rc.3 的 `enter(agent)` 已删除该参数，
  // 夹具层把第二参数折成会话头的 `parentSession`（等价于真实派发写入的公开证据）。
  const origEnter = reg.enter.bind(reg);
  reg.enter = (agent: any, owner?: any) => {
    const ownerSid = owner?.session?.id ?? owner?.id;
    if (ownerSid !== undefined && ownerSid !== null && ownerSid !== "") {
      try {
        if (agent?.session?.header) agent.session.header.parentSession = String(ownerSid);
      } catch { /* 只读 header 的夹具退回「不可确认」 */ }
    }
    return origEnter(agent);
  };
  const rootOf = (agent: any) => {
    if (!agent || typeof agent?.id !== "string" || reg.get(agent.id) !== agent) {
      // 未管理/陈旧/非 live 实例：rc.3 只判「不可确认」，绝不臆断归属。
      throw unauthorized(UNAUTHORIZED_MESSAGE);
    }
    let current = agent;
    for (let guard = 0; guard < 64; guard += 1) {
      const parentSid = current?.session?.header?.parentSession;
      if (parentSid === undefined || parentSid === null || parentSid === "") return current;
      const parent = reg.get(String(parentSid));
      if (!parent) return current; // 根仍 live：父已消失 ⇒ 自身即根
      current = parent;
    }
    throw unauthorized(UNAUTHORIZED_MESSAGE);
  };
  const service = { rootOf };
  hostCtx.provide("subagents", service);
  return service;
}
