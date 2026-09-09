    // g-192：仅当当前查看会话与后端受保护 supervisor.session 相等时显示。
    function SupervisorHeaderBadge(props) {
      const [supervisorSession, setSupervisorSession] = React.useState(null);
      const sessionId = props?.sessionId ?? props?.session?.sessionId ?? props?.id ?? null;
      const workspace = props?.workspace ?? props?.cwd ?? props?.session?.cwd ?? props?.session?.header?.cwd ?? (typeof resolveWorkspaceOfSession === "function" ? resolveWorkspaceOfSession(sessionId) : null);
      React.useEffect(() => {
        let cancelled = false;
        if (!sessionId || !workspace) { setSupervisorSession(null); return () => { cancelled = true; }; }
        const url = "/api/dsh-graph/supervisor-session?workspace=" + encodeURIComponent(workspace);
        fetch(url, { method: "GET", credentials: "same-origin" }).then((res) => res.ok ? res.json() : null)
          .then((data) => { if (!cancelled) setSupervisorSession(typeof data?.supervisorSession === "string" ? data.supervisorSession : null); })
          .catch(() => { if (!cancelled) setSupervisorSession(null); });
        return () => { cancelled = true; };
      }, [sessionId, workspace]);
      if (!sessionId || !supervisorSession || sessionId !== supervisorSession) return null;
      return h("span", {
        role: "status", title: dgT('supervisor.badgeTooltip'), "aria-label": dgT('supervisor.badgeTooltip'),
        style: { display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", borderRadius: 6, padding: "2px 7px", fontSize: 12, lineHeight: 1.4, flexShrink: 0, background: "var(--dsw-alias-fill-tsp-secondary, rgba(128,128,128,.15))", color: "var(--dsw-alias-label-secondary, inherit)" },
      }, dgT('supervisor.badge'));
    }

    function SupervisorBar(props) {
      const { model, modelErr } = useSessionModel(props.id, null);
      const jump = () => {
        try {
          sessionsRt?.open?.(props.id); // supervisor 是顶层会话，直接 open
          activateChatTab();            // 已在该会话看板 tab 时切回「对话」
        } catch (e) {
          console.warn("[dsh-graph-host] 跳转主管会话失败", e);
        }
      };
      return h(
        "div",
        { style: S.supervisorBar, className: "dg-supervisor" },
        h("span", { style: { fontWeight: 600, flexShrink: 0 } }, dgT('supervisor.label')),
        h("div", { style: { flex: 1, minWidth: 0 } },
          h(LiveStrip, { parentId: null, childId: props.id, statusLine: props.statusLine ?? null, statusAt: props.statusAt ?? null })),
        model
          ? h("div", { style: { ...S.meta, flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.2 } },
              h("span", null, model.provider),
              h("span", null, model.model))
          : h("span", { style: { ...S.meta, flexShrink: 0 } },
              modelErr ? dgT('supervisor.modelUnavailable') : dgT('supervisor.modelLoading')),
        h("button", {
          style: { ...S.btn, flexShrink: 0 }, className: "dg-btn",
          title: dgT('supervisor.goToChatTooltip'), onClick: jump,
        }, dgT('supervisor.goToChat')),
      );
    }

    // g-a92e1406：被复用徽章——同一 child_id 跨目标绑定时旧绑定显示「被复用→新目标」
    function ReusedBadge(props) {
      const { childId, reusedBy } = props;
      if (!childId || !reusedBy) return null;
      return h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-warn-label, #e0a53a)", marginTop: 2 } },
        dgT('reused.label', { goalId: reusedBy }));
    }

    // g-125：上下文摘要默认折叠到 2 行（截断+省略号），点击展开全文；
    // 短摘要（≤40 字）不折叠，直接整行显示。状态提升自 Card（无 hooks 的纯函数）外。
    function CardSummary(props) {

    // Source contract marker: 🧭 GRAPH主管.
