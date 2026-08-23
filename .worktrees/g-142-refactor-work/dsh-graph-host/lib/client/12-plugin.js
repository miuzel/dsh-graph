
    let appCtx = null;
    let sessionsRt = null;
    let connectionRt = null;
    let workspacesRt = null;
    // g-113 定点 bug：看板按「被查看会话」取 workspace——conversation.view 是 session 作用域 slot，
    // 渲染回调的 props.sessionId 就是该视图当前挂载的会话（renderer 把 info.sessionId 注入为
    // props.sessionId），不能用全局聚焦会话 list.current 代替（多窗口/子代理视图时两者可能不同）。
    // KanbanView(props) 挂载时写入，currentWorkspace() 优先按它查 cwd；找不到再回退 list.current。
    let viewedSessionId = null;
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
    // 优先级：被查看会话（workspaces）→ 被查看会话（sessions cwd）→ list.current（workspaces）
    // → list.current（sessions cwd）→ null（裸路径，端点兜底 process.cwd()）。
    function currentWorkspace() {
      try {
        const wsItems = workspacesRt?.list?.getSnapshot?.()?.items
          ?? appCtx?.get?.("workspaces")?.list?.getSnapshot?.()?.items ?? [];
        const wsOf = (sid) => wsItems.find?.((w) => w.sessionIds.includes(sid));
        const rt = sessionsRt ?? appCtx?.get?.("sessions");
        const snap = rt?.list?.getSnapshot?.();
        const items = snap?.items ?? [];
        if (viewedSessionId) {
          const w = wsOf(viewedSessionId);
          if (w?.path) { setLastGoodWorkspace(w.path); return w.path };
          const viewed = items.find?.((s) => s.sessionId === viewedSessionId);
          if (viewed?.cwd) { setLastGoodWorkspace(viewed.cwd); return viewed.cwd };
          // g-129 修复（负责人 2026-08-22）：子代理会话不在 workspace 映射且无 cwd 时，
          // 沿 parentSessionId 链回溯父会话的 workspace（子代理继承父会话 workspace）
          if (viewed?.parentSessionId) {
            const parent = items.find?.((s) => s.sessionId === viewed.parentSessionId);
            if (parent?.cwd) { setLastGoodWorkspace(parent.cwd); return parent.cwd };
            const pw = wsOf(viewed.parentSessionId);
            if (pw?.path) { setLastGoodWorkspace(pw.path); return pw.path };
          }
        }
        const current = snap?.current;
        if (current) {
          const w = wsOf(current);
          if (w?.path) { setLastGoodWorkspace(w.path); return w.path };
          const item = items.find?.((s) => s.sessionId === current);
          if (item?.cwd) { setLastGoodWorkspace(item.cwd); return item.cwd };
          // g-129 修复：current 是子代理时回溯父会话 workspace
          if (item?.parentSessionId) {
            const parent = items.find?.((s) => s.sessionId === item.parentSessionId);
            if (parent?.cwd) { setLastGoodWorkspace(parent.cwd); return parent.cwd };
            const pw = wsOf(item.parentSessionId);
            if (pw?.path) { setLastGoodWorkspace(pw.path); return pw.path };
          }
        }
        if (lastGoodWorkspace) return lastGoodWorkspace;
        return null;
      } catch { if (lastGoodWorkspace) return lastGoodWorkspace; return null; }
    }
    // 给 /api/dsh-graph* 请求统一追加 ?workspace=（GET/POST 通用；已知则带，未知则裸路径）
    function graphUrl(path, extraParams = {}) {
      const p = new URLSearchParams(extraParams);
      const ws = currentWorkspace();
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
