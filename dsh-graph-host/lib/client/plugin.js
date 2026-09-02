    // g-223：按 sessionId 解析 workspace；无法验证时必须 fail closed，绝不跨会话复用缓存。
    let lastGoodWorkspace = null;
    function setLastGoodWorkspace(ws) { if (typeof ws === "string" && ws) lastGoodWorkspace = ws; }
    // wsOf(sid) remains the explicit workspace-membership check; viewed?.parentSessionId is walked safely.
    function resolveWorkspaceOfSession(sessionId) {
      try {
        const rawWsItems = workspacesRt?.list?.getSnapshot?.()?.items
          ?? appCtx?.get?.("workspaces")?.list?.getSnapshot?.()?.items;
        const wsItems = Array.isArray(rawWsItems) ? rawWsItems : [];
        const wsOf = (sid) => wsItems.find((w) => Array.isArray(w?.sessionIds)
          && w.sessionIds.includes(sid) && typeof w.path === "string" && w.path);
        const rt = sessionsRt ?? appCtx?.get?.("sessions");
        const snap = rt?.list?.getSnapshot?.() ?? {};
        const items = Array.isArray(snap.items) ? snap.items : [];
        const byId = (sid) => items.find((s) => s && s.sessionId === sid);
        const pathOf = (sid) => {
          const seen = new Set();
          let current = sid;
          while (current && !seen.has(current)) {
            seen.add(current);
            const mapped = wsOf(current);
            if (mapped?.path) return mapped.path;
            const item = byId(current);
            if (typeof item?.cwd === "string" && item.cwd) return item.cwd;
            current = typeof item?.parentSessionId === "string" ? item.parentSessionId : null;
          }
          return null;
        };
        const sid = sessionId ?? viewedSessionId;
        // Any supplied/viewed session is an isolation boundary: no current/cache fallback.
        if (sid) {
          const resolved = pathOf(sid);
          if (resolved) { setLastGoodWorkspace(resolved); return resolved; }
          return null;
        }
        // With no session selected, only the runtime's current session is eligible.
        const current = typeof snap.current === "string" ? snap.current : null;
        const resolved = current ? pathOf(current) : null;
        if (resolved) { setLastGoodWorkspace(resolved); return resolved; }
        return null;
      } catch { return null; }
    }

    function currentWorkspace() {
      return resolveWorkspaceOfSession(viewedSessionId);
    }

    // 给 /api/dsh-graph* 请求统一追加 ?workspace=；未知 workspace 时由调用方 fail closed。
    function graphUrl(path, extraParams = {}, explicitWs = null) {
      const p = new URLSearchParams(extraParams);
      const ws = explicitWs ?? currentWorkspace();
      if (!ws) return null;
      p.set("workspace", ws);
      const qs = p.toString();
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
        className: "dg-btn dg-session-link",
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