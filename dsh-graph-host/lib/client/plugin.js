    // g-129 修复：缓存最近一次成功解析的 workspace——切到子代理会话（不在 workspace 映射、
    // 无 cwd/parentSessionId 可用）时回退缓存，避免看板读 process.cwd() 空骨架而空白。
    let lastGoodWorkspace = null;
    function setLastGoodWorkspace(ws) { if (ws) lastGoodWorkspace = ws; }
    // g-113 定点 bug 2：workspace 数据源改用 workspaces 服务——sessions 条目 cwd 并非总有
    // （DSH 源码 dsh-client-runtime/client.js:9233 `...entry.cwd !== void 0 ? { cwd: entry.cwd } : {}`，
    // aseit-ella 会话条目 cwd 为空），可靠来源是 workspaces 服务：
    // `workspaces.list.getSnapshot().items` 每条 `{ workspaceId, path, title, sessionIds, ... }`
    // （host workspaceView：dsh-host-apiproxy lib 793-801；runtime project() 直接透传 items），
    // path 即该 workspace 目录，`sessionIds.includes(被查看会话)` 即归属映射
    // （同文件 :9866 `summary.cwd === workspace.path && workspace.sessionIds.includes(summary.id)`）。
    // g-223：纯函数按 sessionId 解析归属 workspace（供 render/effect 阶段直接调用，避免会话切换时序缺陷）
    // 优先级：指定 sessionId（workspaces 映射）→ sessionId（sessions cwd）→ sessionId（parent 回溯 cwd/workspaces）
    // → list.current（workspaces）→ list.current（cwd）→ list.current（parent 回溯）→ lastGoodWorkspace 兜底
    function resolveWorkspaceOfSession(sessionId) {
      try {
        const wsItems = workspacesRt?.list?.getSnapshot?.()?.items
          ?? appCtx?.get?.("workspaces")?.list?.getSnapshot?.()?.items ?? [];
        const wsOf = (sid) => wsItems.find?.((w) => Array.isArray(w?.sessionIds) && w.sessionIds.includes(sid));
        const rt = sessionsRt ?? appCtx?.get?.("sessions");
        const snap = rt?.list?.getSnapshot?.();
        const items = snap?.items ?? [];
        const sid = sessionId ?? viewedSessionId;
        if (sid) {
          const w = wsOf(sid);
          if (w?.path) { setLastGoodWorkspace(w.path); return w.path; }
          const viewed = items.find?.((s) => s.sessionId === sid);
          if (viewed?.cwd) { setLastGoodWorkspace(viewed.cwd); return viewed.cwd; }
          if (viewed?.parentSessionId) {
            const parent = items.find?.((s) => s.sessionId === viewed.parentSessionId);
            if (parent?.cwd) { setLastGoodWorkspace(parent.cwd); return parent.cwd; }
            const pw = wsOf(viewed.parentSessionId);
            if (pw?.path) { setLastGoodWorkspace(pw.path); return pw.path; }
          }
        }
        const current = snap?.current;
        if (current) {
          const w = wsOf(current);
          if (w?.path) { setLastGoodWorkspace(w.path); return w.path; }
          const item = items.find?.((s) => s.sessionId === current);
          if (item?.cwd) { setLastGoodWorkspace(item.cwd); return item.cwd; }
          if (item?.parentSessionId) {
            const parent = items.find?.((s) => s.sessionId === item.parentSessionId);
            if (parent?.cwd) { setLastGoodWorkspace(parent.cwd); return parent.cwd; }
            const pw = wsOf(item.parentSessionId);
            if (pw?.path) { setLastGoodWorkspace(pw.path); return pw.path; }
          }
        }
        if (lastGoodWorkspace) return lastGoodWorkspace;
        return null;
      } catch { if (lastGoodWorkspace) return lastGoodWorkspace; return null; }
    }

    function currentWorkspace() {
      return resolveWorkspaceOfSession(viewedSessionId);
    }

    // 给 /api/dsh-graph* 请求统一追加 ?workspace=（GET/POST 通用；已知则带，未知则裸路径；可选显式传入 workspace）
    function graphUrl(path, extraParams = {}, explicitWs = null) {
      const p = new URLSearchParams(extraParams);
      const ws = explicitWs ?? currentWorkspace();
      if (ws) p.set("workspace", ws);
      const qs = p.toString();
      if (!qs) return path;
      return path + (path.includes("?") ? "&" : "?") + qs;
    }
    // 跳转后把会话页切回「对话」tab：chat 是 conversation.view 中 order=0 的固定首 tab；
    // tab 选中态存在 ui-conversation 的 per-session chatStore 内、无跨插件 API（源码核实），
    // 故在跳转后点一下首 tab（仅当当前选中不是它）。无 tab 栏（单视图）时不动。
    function activateChatTab() {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        try {
          const tabs = document.querySelectorAll('[role="tablist"] [role="tab"]');
          if (tabs.length < 2) return;
          const first = tabs[0];
          if (first.getAttribute("aria-selected") !== "true") first.click();
        } catch { /* 静默 */ }
      }));
    }
    async function openChildSession(parentSessionId, childId) {
      const rt = sessionsRt ?? appCtx?.get?.("sessions");
      try {
        if (!rt) return;
        // 目录必须先加载，否则 selectSubagent 抛 "not a healthy catalog child"（发现#21）
        rt.setSubagentCatalogOpen?.(parentSessionId, true);
        await rt.refreshSubagents?.(parentSessionId);
        const entries = rt.list?.getSnapshot?.().subagentsByParent?.[parentSessionId]?.entries ?? [];
        const entry = entries.find((e) => e.kind === "child" && e.id === childId);
        if (entry) {
          rt.openSubagent?.({ parentSessionId, childSessionId: childId, mode: entry.mode });
          activateChatTab();
        } else {
          // 目录里没有（不健康/已清理）：退化为打开父会话
          console.warn("[dsh-graph-host] child not in catalog, opening parent:", childId);
          rt.open?.(parentSessionId);
          activateChatTab();
        }
      } catch (e) {
        console.warn("[dsh-graph-host] openSubagent failed", e);
        try { rt?.open?.(parentSessionId); activateChatTab(); } catch { /* 静默 */ }
      }
    }
    function sessionLinkBtn(parentSessionId, childId, label) {
      if (!childId) return null;
      return h("button", {
        style: { ...S.btn, fontSize: 11, padding: "0 6px", marginLeft: 6, flexShrink: 0 },
        className: "dg-btn",
        title: parentSessionId ? "跳转到子代理会话" : "子代理 id（父会话未知，仅展示）",
        onClick: (e) => { e.stopPropagation(); if (parentSessionId) openChildSession(parentSessionId, childId); },
      }, label ?? "↗ 会话");
    }
    return {
      name: "dsh-graph",
      inject: ["slots", "sessions", "connection", "remote", "modelDirectories"],
      apply(ctx) {
        appCtx = ctx;
        sessionsRt = ctx.sessions ?? null;
        connectionRt = ctx.connection ?? null;
        // workspaces 服务经 ctx.get(name) 可选查找即可取到（runner 的 ctx.get 方法不要求 inject 声明，
        // 注入门禁只拦 ctx.workspaces 属性访问；workspaces 由 client-runtime `ctx.reflect.provide` 提供）
        workspacesRt = ctx.get?.("workspaces") ?? null;
        ctx.slots.inject("conversation.view", () =>
          ctx.slots.register(
            { name: "conversation.view", id: "dsh-graph-kanban", order: 80, label: "看板" },
            (props) => h(KanbanView, props),
          ),
        );
        // g-133：注册「看板设置」settings.section 页（profile 级全局默认配置）。
        // settingsScope 缺失 / slots 未就绪时整页降级，不影响看板与工具。
        try { registerGraphSettingsSection(ctx); } catch { /* 静默 */ }
        console.log("[dsh-graph-host] client apply: kanban view registered");
      },
    };
  },
});