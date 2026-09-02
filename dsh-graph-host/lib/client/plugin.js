    // g-199: workspace identity is security-sensitive. Use only the real
    // conversation session id and the backend workspace membership mapping.
    // Never infer it from cwd, title/aria labels, current session, or parent ids.
    let clientLifecycleCleanup = null;
    let clientLifecycleGeneration = null;
    // ===== g-199：左侧会话列表 GRAPH 主管标记 =====
    // 数据源：/api/dsh-graph/supervisor-session（GET，服务端受保护 workspace 权威）。
    // 只按真实会话 id 匹配标记（判据 1：普通/子代理/历史/无绑定不误标）；绝不从
    // cwd/title/aria/current/parent 推断（P0 修复）。标记仅展示，不改变会话行为（判据 2）。
    // 未知/缺字段隐藏、非敏感降级，不泄露 session token（判据 3）。
    const SUPERVISOR_BADGE_CLASS = "dg-graph-supervisor-badge";
    let supervisorSessionId = null;        // 服务端权威 supervisor session id（null = 不标记）
    let supervisorHasKnown = false;        // 是否拿到过成功响应（首次失败不标记）
    let supervisorMarkerGeneration = null; // 与 apply 生命周期代绑定
    let supervisorFetchSeq = 0;            // 防乱序响应覆盖
    let supervisorObserver = null;
    let supervisorObserverScheduled = false;
    let supervisorTimer = null;
    let supervisorFocusHandler = null;
    let supervisorVisibilityHandler = null;

    function supervisorBadgeEl() {
      const span = document.createElement("span");
      span.className = SUPERVISOR_BADGE_CLASS;
      span.setAttribute("role", "img");
      span.setAttribute("aria-label", "GRAPH 主管");
      span.setAttribute("title", "GRAPH 主管会话（dsh-graph project.yaml supervisor.session）");
      span.style.cssText = [
        "display:inline-flex", "align-items:center", "gap:3px",
        "flex-shrink:0", "font-size:10px", "font-weight:600", "line-height:1",
        "padding:1px 5px", "border-radius:8px", "margin-right:4px",
        "color:var(--dsw-alias-state-success-primary,#3aa675)",
        "background:rgba(58,166,117,0.12)",
        "border:1px solid rgba(58,166,117,0.35)",
        "white-space:nowrap", "pointer-events:none", "user-select:none",
      ].join(";");
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("width", "10");
      svg.setAttribute("height", "10");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "2.2");
      svg.setAttribute("stroke-linejoin", "round");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", "M12 3l2.7 5.5L21 9.4l-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.4l6.3-.9L12 3z");
      svg.appendChild(path);
      span.appendChild(svg);
      const label = document.createElement("span");
      label.textContent = "GRAPH主管";
      span.appendChild(label);
      return span;
    }

    // 只认真实 id 数据属性（data-session-id / data-sessionid）；无真实 id 的行绝不标记。
    function supervisorRowId(row) {
      if (!row || row.nodeType !== 1) return null;
      const id = row.dataset?.sessionId ?? row.dataset?.sessionid ?? null;
      return typeof id === "string" && id ? id : null;
    }

    function applySupervisorMarker() {
      if (supervisorMarkerGeneration !== clientLifecycleGeneration) return;
      let rows = [];
      try {
        rows = Array.from(document.querySelectorAll("[data-session-id], [data-sessionid]"));
      } catch { return; }
      const markId = supervisorHasKnown ? supervisorSessionId : null;
      for (const row of rows) {
        const id = supervisorRowId(row);
        if (!id) continue; // fail-closed：无真实 id 不标记
        let badge = null;
        try { badge = row.querySelector("." + SUPERVISOR_BADGE_CLASS); } catch { badge = null; }
        const should = markId !== null && id === markId;
        if (should && !badge) {
          try { row.prepend(supervisorBadgeEl()); } catch { /* 静默 */ }
        } else if (!should && badge) {
          try { badge.remove(); } catch { /* 静默 */ }
        }
      }
    }

    // 服务端只读受保护 workspace 或 ?workspace= 回退；响应只含 supervisorSession。
    function fetchSupervisorSession() {
      const seq = ++supervisorFetchSeq;
      fetch(graphUrl("/api/dsh-graph/supervisor-session"), {
        method: "GET",
        headers: { accept: "application/json" },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (seq !== supervisorFetchSeq) return; // 乱序响应丢弃
          supervisorHasKnown = true;
          const id = data && typeof data.supervisorSession === "string" && data.supervisorSession
            ? data.supervisorSession : null;
          if (id !== supervisorSessionId) {
            supervisorSessionId = id;
            applySupervisorMarker();
          }
        })
        .catch(() => {
          // 网络/解析失败：保留上次已知值（轮询/重连后恢复）；从未成功则不标记。
        });
    }

    function startSupervisorMarker() {
      cleanupSupervisorMarker();
      supervisorMarkerGeneration = clientLifecycleGeneration;
      supervisorSessionId = null;
      supervisorHasKnown = false;
      fetchSupervisorSession();
      // 列表挂载/分页/虚拟化：MutationObserver（防抖）+ 周期重应用兜底。
      try {
        supervisorObserver = new MutationObserver(() => {
          if (supervisorObserverScheduled) return;
          supervisorObserverScheduled = true;
          setTimeout(() => {
            supervisorObserverScheduled = false;
            applySupervisorMarker();
          }, 120);
        });
        supervisorObserver.observe(document.body, { childList: true, subtree: true });
      } catch { supervisorObserver = null; }
      supervisorTimer = setInterval(() => {
        applySupervisorMarker();
        fetchSupervisorSession();
      }, 30000);
      // 网络重连/回前台：重取（连接服务 API 不稳定，用 focus/visibility 兜底 + 轮询）。
      supervisorFocusHandler = () => fetchSupervisorSession();
      supervisorVisibilityHandler = () => {
        if (document.visibilityState === "visible") fetchSupervisorSession();
      };
      window.addEventListener("focus", supervisorFocusHandler);
      document.addEventListener("visibilitychange", supervisorVisibilityHandler);
    }

    function cleanupSupervisorMarker() {
      supervisorMarkerGeneration = null;
      if (supervisorTimer) { clearInterval(supervisorTimer); supervisorTimer = null; }
      if (supervisorObserver) {
        try { supervisorObserver.disconnect(); } catch { /* 静默 */ }
        supervisorObserver = null;
      }
      if (supervisorFocusHandler) {
        try { window.removeEventListener("focus", supervisorFocusHandler); } catch { /* 静默 */ }
        supervisorFocusHandler = null;
      }
      if (supervisorVisibilityHandler) {
        try { document.removeEventListener("visibilitychange", supervisorVisibilityHandler); } catch { /* 静默 */ }
        supervisorVisibilityHandler = null;
      }
      try {
        document.querySelectorAll("." + SUPERVISOR_BADGE_CLASS).forEach((b) => b.remove());
      } catch { /* 静默 */ }
    }
    function currentWorkspace() {
      try {
        const wsItems = workspacesRt?.list?.getSnapshot?.()?.items
          ?? appCtx?.get?.("workspaces")?.list?.getSnapshot?.()?.items ?? [];
        if (!viewedSessionId || typeof viewedSessionId !== "string") return null;
        const workspace = wsItems.find?.((w) =>
          Array.isArray(w?.sessionIds) && w.sessionIds.includes(viewedSessionId));
        return typeof workspace?.path === "string" && workspace.path ? workspace.path : null;
      } catch { return null; }
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
    return {
      name: "dsh-graph",
      inject: ["slots", "sessions", "connection"],
      apply(ctx) {
        clientLifecycleCleanup?.();
        const generation = {};
        clientLifecycleGeneration = generation;
        clientLifecycleCleanup = () => {
          if (clientLifecycleGeneration !== generation) return;
          appCtx = null;
          sessionsRt = null;
          workspacesRt = null;
          connectionRt = null;
          if (viewedSessionOwner == null) viewedSessionId = null;
          cleanupSupervisorMarker();
          clientLifecycleGeneration = null;
          clientLifecycleCleanup = null;
        };
        // Cordis owns the lifecycle; repeated plugin reloads cannot retain the
        // old runtime references or attach duplicate UI state.
        const cleanupForGeneration = clientLifecycleCleanup;
        ctx.effect?.(() => cleanupForGeneration);
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
        // g-199：启动左侧会话列表主管标记（幂等：重复 apply 先清理旧实例）。
        startSupervisorMarker();
        console.log("[dsh-graph-host] client apply: kanban view registered");
      },
    };
  },
});
