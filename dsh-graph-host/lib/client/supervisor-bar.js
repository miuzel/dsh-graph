    // g-192：仅当当前查看会话与后端受保护 supervisor.session 相等时显示。
    function SupervisorHeaderBadge(props) {
      // g-431：本组件是**顶层 slot**（conversation.session.header.actions），不在看板子树里，
      // 宿主不会因 locale 变化替我们重渲染 ⇒ 必须自己订阅重渲染广播，否则切语言后徽标文案残留。
      useLocaleRevision();
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
      return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 } },
        h("span", {
          role: "status", title: dgT('supervisor.badgeTooltip'), "aria-label": dgT('supervisor.badgeTooltip'),
          style: { display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", borderRadius: 6, padding: "2px 7px", fontSize: 12, lineHeight: 1.4, flexShrink: 0, background: "var(--dsw-alias-fill-tsp-secondary, rgba(128,128,128,.15))", color: "var(--dsw-alias-label-secondary, inherit)" },
        }, dgT('supervisor.badge')),
        h(CareCountdown, { sessionId, workspace }));
    }

    // g-506：主管会话「GRAPH主管」标签旁的关照倒计时与控制（服务端唯一真源）。
    //
    // 设计约束（逐条对应判据 5/6）：
    //   · 倒计时**只**由服务端下发的 `next_due_at` + `server_now` 派生（本地仅做流逝插值），
    //     不维护第二套调度真源；多任务由服务端取最早有效到期；
    //   · 主管忙 ⇒ 「待主管空闲」；关闭/无任务/待人工/能力不可用/暂停 ⇒ 分别显示，绝不显示虚假倒计时；
    //   · 到零只表示巡检到期，不是子代理卡死（tooltip 明说）；
    //   · 点击展开暂停/继续/重置（整组、当前主管当前工作区）；重复点击幂等、到期竞争由服务端 revision 校验；
    //   · 暂停不撤回已投递巡检（面板明示）；重置不清无进展记录、不解除人工裁决；
    //   · 键盘可操作（原生 button + Esc 关闭）、中英对称；刷新/重连/任务与配置变化轮询 + focus/online 刷新。
    function CareCountdown(props) {
      useLocaleRevision();
      const sessionId = props?.sessionId ?? null;
      const workspace = props?.workspace
        ?? (sessionId && typeof resolveWorkspaceOfSession === "function" ? resolveWorkspaceOfSession(sessionId) : null);
      const [snap, setSnap] = React.useState({ status: null, receivedAt: 0, error: null });
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(null);
      const [, setTick] = React.useState(0);

      const load = React.useCallback(() => {
        if (!workspace) return () => {};
        let cancelled = false;
        const url = "/api/dsh-graph/care/status?workspace=" + encodeURIComponent(workspace);
        fetch(url, { method: "GET", credentials: "same-origin" })
          .then((res) => res.ok ? res.json() : null)
          .then((data) => {
            if (cancelled) return;
            if (data && typeof data === "object") setSnap({ status: data, receivedAt: Date.now(), error: null });
            else setSnap((prev) => ({ ...prev, error: "unavailable" }));
          })
          .catch(() => { if (!cancelled) setSnap((prev) => ({ ...prev, error: "unavailable" })); });
        return () => { cancelled = true; };
      }, [workspace]);

      React.useEffect(() => {
        if (!workspace) return () => {};
        let cleanup = load();
        const timer = setInterval(() => { cleanup(); cleanup = load(); }, 15000);
        const refresh = () => { cleanup(); cleanup = load(); };
        const onVisible = () => { if (document?.visibilityState === "visible") refresh(); };
        try { window.addEventListener("focus", refresh); window.addEventListener("online", refresh); document?.addEventListener?.("visibilitychange", onVisible); } catch { /* 宿主无 window（测试） */ }
        return () => {
          clearInterval(timer);
          cleanup();
          try { window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); document?.removeEventListener?.("visibilitychange", onVisible); } catch { /* 忽略 */ }
        };
      }, [workspace, load]);

      React.useEffect(() => {
        const timer = setInterval(() => setTick((v) => v + 1), 1000);
        return () => clearInterval(timer);
      }, []);

      if (!workspace) return null;

      const status = snap.status;
      const cfg = status?.configured ?? null;
      const effective = cfg ? cfg.effective === true : null;
      const phase = status?.phase ?? null;
      const serverNow = typeof status?.server_now === "number" ? status.server_now : null;
      const dueAt = typeof status?.next_due_at === "number" ? status.next_due_at : null;
      const elapsed = snap.receivedAt ? Math.max(0, Date.now() - snap.receivedAt) : 0;
      const remainingMs = dueAt !== null && serverNow !== null ? Math.max(0, dueAt - (serverNow + elapsed)) : null;
      const pausedRemaining = typeof status?.paused_remaining_ms === "number" ? status.paused_remaining_ms : null;
      const pendingDelivered = (status?.pending_inspections ?? []).some((i) => i.status === "delivered" || i.status === "claimed" || i.status === "queued");
      const fmt = (ms) => {
        const total = Math.max(0, Math.ceil((ms ?? 0) / 1000));
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
      };

      let label;
      if (snap.error || !status) label = dgT("care.statusUnavailable");
      else if (effective === false) label = dgT("care.disabled");
      else if (status.reason === "delivery_failed_limit") label = dgT("care.deliveryFailed");
      else if (phase === "unavailable") label = dgT("care.unavailable");
      else if (phase === "paused") label = dgT("care.pausedRemaining").replace("{t}", fmt(pausedRemaining ?? remainingMs));
      else if (status.reason === "no_response_limit") label = dgT("care.noResponseLimit");
      else if (status.awaiting_human || phase === "awaiting_human") label = dgT("care.awaitingHuman");
      else if (phase === "awaiting_outcome") label = dgT("care.awaitingOutcome");
      else if (phase === "waiting_supervisor") label = dgT("care.waitingSupervisor");
      else if (phase === "idle") label = dgT("care.noTasks");
      else if (remainingMs !== null && remainingMs > 0) label = dgT("care.countdown").replace("{t}", fmt(remainingMs));
      else if (remainingMs === 0) label = dgT("care.dueNow");
      else label = dgT("care.noTasks");

      const noTasks = phase === "idle" || (status?.tasks ?? []).length === 0;
      const disabledAction = !status || effective === false || noTasks || phase === "unavailable" || !status.supervisor_live;
      const disabledReset = !status || effective === false || noTasks || !status.supervisor_live;
      const submit = (action) => {
        if (busy) return;
        setBusy(true);
        setNote(null);
        // g-506 返工：reset 的本次唯一请求 id 随请求体提交，服务端据此做「同一次点击重试」幂等；
        // 不同真实点击生成不同 id（绝不按秒猜重复）。
        const requestId = action === "reset"
          ? (globalThis.crypto?.randomUUID?.() ?? `reset-${Date.now()}-${Math.random().toString(36).slice(2)}`)
          : null;
        fetch("/api/dsh-graph/care/control", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspace, action, request_id: requestId ?? undefined, expected_revision: typeof status?.revision === "number" ? status.revision : undefined }),
        }).then(async (res) => {
          if (res.ok) {
            const data = await res.json();
            if (data?.status) setSnap({ status: data.status, receivedAt: Date.now(), error: null });
            setNote({ kind: "ok", text: dgT("care.actionDone") });
          } else {
            const data = await res.json().catch(() => null);
            setNote({ kind: "err", text: data?.error === "revision_conflict" ? dgT("care.conflict") : dgT("care.failed") });
            if (data?.error === "revision_conflict") setSnap((prev) => ({ ...prev, error: "conflict" }));
          }
        }).catch(() => setNote({ kind: "err", text: dgT("care.failed") }))
          .finally(() => { setBusy(false); });
      };

      const chipStyle = {
        display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap",
        borderRadius: 6, padding: "2px 7px", fontSize: 11, lineHeight: 1.4, flexShrink: 0,
        border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25))",
        background: "var(--dsw-alias-fill-tsp-secondary, rgba(128,128,128,.12))",
        color: "var(--dsw-alias-label-secondary, inherit)", cursor: "pointer",
        fontVariantNumeric: "tabular-nums",
      };
      const panelStyle = {
        position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 60, width: 300,
        padding: 10, borderRadius: 8, fontSize: 12, lineHeight: 1.5,
        border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.3))",
        background: "var(--dsw-alias-bg-elevated, #262626)",
        color: "var(--dsw-alias-label-primary, inherit)",
        boxShadow: "0 6px 24px rgba(0,0,0,.35)",
      };
      const btn = (labelText, action, disabled) => h("button", {
        type: "button", className: "dg-btn dg-care-" + action,
        style: { ...S.btn, fontSize: 11, padding: "3px 10px", opacity: disabled ? 0.5 : 1 },
        disabled,
        onClick: () => submit(action),
      }, labelText);
      const sourceKey = cfg && cfg.source ? ({
        project_explicit: "care.srcProject",
        global_explicit: "care.srcGlobal",
        global_default: "care.srcDefault",
        project_invalid: "care.srcProjectInvalid",
        global_invalid: "care.srcGlobalInvalid",
      })[cfg.source] : null;
      const warnText = (status?.warnings ?? []).map((w) => ({
        project_care_malformed: "care.warnProjectMalformed",
        project_care_threshold_malformed: "care.warnThresholdMalformed",
        project_care_recheck_malformed: "care.warnRecheckMalformed",
        global_care_malformed: "care.warnGlobalMalformed",
        global_care_threshold_malformed: "care.warnGlobalThresholdMalformed",
        global_care_recheck_malformed: "care.warnGlobalRecheckMalformed",
      })[w]).filter(Boolean).map((k) => dgT(k));

      return h("span", {
        style: { position: "relative", display: "inline-flex", flexShrink: 0 },
        onKeyDown: (e) => { if (e?.key === "Escape" && open) { setOpen(false); e.stopPropagation?.(); } },
      },
        h("button", {
          type: "button",
          className: "dg-care-chip",
          "aria-haspopup": "dialog",
          "aria-expanded": open ? "true" : "false",
          "aria-label": dgT("care.open"),
          title: (status?.reason === "counting" || remainingMs !== null)
            ? dgT("care.countdownHint")
            : dgT("care.statusHint"),
          style: chipStyle,
          onClick: () => setOpen((v) => !v),
        }, "⏱ " + label),
        open
          ? h("div", {
              role: "dialog", "aria-label": dgT("care.title"), className: "dg-care-panel", style: panelStyle,
            },
              h("div", { style: { fontWeight: 700, marginBottom: 4 } }, dgT("care.title")),
              status
                ? h("div", { style: { opacity: 0.85 } },
                    (effective ? dgT("care.effectiveOn") : dgT("care.effectiveOff"))
                      + (sourceKey ? " · " + dgT(sourceKey) : "")
                      + (cfg ? ` · ${dgT("care.threshold").replace("{v}", String(cfg.threshold_seconds))}` : "")
                      + (cfg ? ` · ${dgT("care.recheck").replace("{v}", String(cfg.recheck_seconds))}` : ""))
                : null,
              status
                ? h("div", { style: { opacity: 0.85, marginTop: 2 } },
                    dgT("care.tasks").replace("{n}", String((status.tasks ?? []).filter((t) => !t.human_locked).length))
                    + ((status.capable?.unverified ?? []).length ? " · " + dgT("care.unverifiedIntervention") : ""))
                : null,
              status && dueAt !== null && remainingMs !== null && phase !== "paused"
                ? h("div", { style: { opacity: 0.85, marginTop: 2 } }, dgT("care.countdownHint"))
                : null,
              pendingDelivered ? h("div", { style: { opacity: 0.85, marginTop: 4 } }, dgT("care.deliveredHint")) : null,
              status && (status.awaiting_human || phase === "awaiting_human")
                ? h("div", { style: { opacity: 0.85, marginTop: 4 } }, dgT("care.awaitingHumanHint"))
                : null,
              warnText.length ? h("div", { style: { color: "var(--dsw-alias-state-error-primary, #f08080)", marginTop: 4 } }, warnText.join(" · ")) : null,
              disabledAction
                ? h("div", { style: { opacity: 0.75, marginTop: 4 } },
                    !status ? dgT("care.statusUnavailable")
                      : effective === false ? dgT("care.disabled")
                        : phase === "unavailable" ? dgT("care.unavailable")
                          : dgT("care.noSupervisor"))
                : h("div", { style: { display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" } },
                    phase === "paused"
                      ? btn(dgT("care.resume"), "resume", busy)
                      : btn(dgT("care.pause"), "pause", busy),
                    btn(dgT("care.reset"), "reset", busy)),
              h("div", { style: { opacity: 0.7, marginTop: 6, fontSize: 11 } }, dgT("care.pauseHint")),
              note
                ? h("div", { style: { marginTop: 6, color: note.kind === "ok" ? "var(--dsw-alias-label-primary, #6ee7a0)" : "var(--dsw-alias-state-error-primary, #f08080)" } }, note.text)
                : null,
              h("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 6 } },
                h("button", { type: "button", style: { ...S.btn, fontSize: 11, padding: "3px 10px" }, onClick: () => setOpen(false) }, dgT("care.close"))))
          : null);
    }

    function SupervisorBar(props) {
      const { model, modelErr } = useSessionModel(props.id, null);
      const jump = () => {
        try {
          // g-321：0.1.6 移除了 sessions.open，统一走 openSessionTarget（uiWorkspace.openSession 优先）；
          // supervisor 是顶层会话，直接以 sessionId 为目标。
          openSessionTarget(props.id, typeof sessionsRt?.open === "function" ? () => sessionsRt.open(props.id) : null);
          activateChatTab();            // 已在该会话看板 tab 时切回「对话」
        } catch (e) {
          // i18n-keep(category-a)：开发者控制台诊断日志（console.warn），非 UI 文案。
          console.warn("[dsh-graph-host] 跳转主管会话失败", e);
        }
      };
      const narrow = !!props.narrow;
      // g-352 att-003 第 3 项（负责人人工 gate 反馈「主管对话区域需要重排一下，只留一行 statusline 和
      // 转到对话按钮（缩成一个图标）并隐藏模型 id」）：窄档只保留**一行** —— 主管标识 + 状态行
      //（LiveStrip 的 compact 单行形态）+ 纯图标「↗转到对话」按钮（title/aria-label 仍是完整文案）。
      // 模型 id（provider/model 两行）与 meter 在此档不再渲染 ⇒ 不再有文字互相重叠。
      // 宽档（含 conversation.view 路径）走下面原分支，逐字不变。
      const jumpTooltip = dgT('supervisor.goToChatTooltip');
      if (narrow) {
        return h(
          "div",
          { style: S.supervisorBar, className: "dg-supervisor dg-supervisor-narrow" },
          h("span", { style: { fontWeight: 600, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 } },
            dgT('supervisor.label'),
            h(CareCountdown, { sessionId: props.id, workspace: props.workspace })),
          h("div", { style: { flex: 1, minWidth: 0, overflow: "hidden" } },
            h(LiveStrip, { parentId: null, childId: props.id, statusLine: props.statusLine ?? null, statusAt: props.statusAt ?? null, compact: true, agentKind: "supervisor" })),
          // 图标按钮与同行按钮等高（rowBtnStyle({ iconOnly: true }) ⇒ 26×26 方形，第 9 项）
          h("button", {
            style: { ...S.btn, ...rowBtnStyle({ iconOnly: true }), flexShrink: 0 },
            className: "dg-btn dg-supervisor-jump-icon",
            title: jumpTooltip,
            "aria-label": jumpTooltip,
            onClick: jump,
          }, "↗"),
        );
      }
      return h(
        "div",
        { style: S.supervisorBar, className: "dg-supervisor" },
        h("span", { style: { fontWeight: 600, flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 } },
          dgT('supervisor.label'),
          h(CareCountdown, { sessionId: props.id, workspace: props.workspace })),
        h("div", { style: { flex: 1, minWidth: 0 } },
          h(LiveStrip, { parentId: null, childId: props.id, statusLine: props.statusLine ?? null, statusAt: props.statusAt ?? null, agentKind: "supervisor" })),
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
