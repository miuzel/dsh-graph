// dsh-graph-client — 浏览器半边：手写 classic script，零构建。
// 二维泳道看板。视觉约定：卡片类型用「粗左边框 + 颜色 + 图标」区分；
// 依赖关系用琥珀色左边框 + 「⛓ 等待」标识；详情走 modal 弹窗；事件话术人类化。
window.__ModuleLoader__.load({
  id: "dsh-graph-client",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const STAGES = [
      { key: "describe", label: "描述", statuses: ["draft", "planning"] },
      { key: "collect", label: "收集", statuses: ["collecting", "ready"] },
      { key: "execute", label: "执行", statuses: ["in_progress"] },
      { key: "confirm", label: "确认", statuses: ["review"] },
      { key: "deliver", label: "交付", statuses: ["delivered"] },
      { key: "blocked", label: "阻塞", statuses: ["blocked"] },
    ];

    const STATUS_LABEL = {
      draft: "草稿", planning: "规划中", collecting: "收集中", ready: "就绪",
      in_progress: "执行中", review: "评审中", delivered: "已交付", blocked: "阻塞",
    };

    const EVENT_LABEL = {
      "goal.created": "创建目标", "goal.planned": "完成规划", "criteria.confirmed": "确认判据",
      "goal.transition": null, "attempt.started": "派发执行", "attempt.status_reported": null,
      "completion.claimed": "声明完成", "review.passed": "评审通过", "review.failed": "评审未通过",
      "goal.moved": "排期移动", "card.created": "创建卡片", "card.filled": "填充卡片",
      "card.reviewed": "复核卡片", "evidence.added": "登记证据", "memory.promoted": "沉淀记忆",
      "version.created": "创建版本", "version.released": "发布版本",
      "version.scope_changed": "调整版本范围", "version.integration_decided": "集成测试决策",
      "goal.deleted": "删除目标", "card.deleted": "删除卡片", "attempt.bound": "绑定子代理",
    };

    // 近期动态只保留对人有用的事件：泳道切换、修订与人工补充、判据/评审/交付关键节点
    const MEANINGFUL = new Set([
      "goal.transition", "goal.amended", "scope.note", "criteria.confirmed",
      "completion.claimed", "review.passed", "review.failed", "attempt.started",
      "goal.moved", "goal.created",
    ]);

    function humanEvent(e) {
      const d = e.details ?? {};
      let what = EVENT_LABEL[e.event];
      if (what === null || what === undefined) {
        if (e.event === "goal.transition") what = `状态流转：${STATUS_LABEL[d.from] ?? d.from} → ${STATUS_LABEL[d.to] ?? d.to}`;
        else if (e.event === "attempt.status_reported") what = `汇报：${d.status ?? ""}`;
        else if (e.event === "goal.amended") what = `修订：${d.note ?? ""}`;
        else if (e.event === "scope.note") what = `补充：${d.note ?? ""}`;
        else what = e.event;
      }
      const who = String(e.actor ?? "")
        .replace(/^human:/, "").replace(/^supervisor:.*/, "主管 Agent")
        .replace(/^agent:session-.*/, "Agent（另一会话）").replace(/^agent:/, "Agent:");
      let when = "";
      try {
        const dt = new Date(e.ts);
        when = `${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
      } catch { when = String(e.ts ?? "").slice(5, 16); }
      return `${when}  ${what}（${who}）`;
    }

    const HOVER_CSS = `
      .dg-card { transition: box-shadow .12s ease, transform .12s ease, border-color .12s ease; }
      .dg-card:hover { box-shadow: 0 0 0 2px rgba(76,141,255,.55); transform: translateY(-1px); }
      .dg-card:active { transform: translateY(0); box-shadow: 0 0 0 2px rgba(76,141,255,.8); }
      .dg-sub { transition: background .12s ease; }
      .dg-sub:hover { background: rgba(58,166,117,.22); }
      .dg-collapsed:hover { background: rgba(128,128,128,.14); }
      .dg-btn { transition: filter .12s ease; }
      .dg-btn:hover { filter: brightness(1.25); }
      .dg-card-active { box-shadow: 0 0 0 2px rgba(76,141,255,.85) !important; background: rgba(76,141,255,.12) !important; }
      .dg-sub-active { background: rgba(58,166,117,.30) !important; box-shadow: 0 0 0 1px #3aa675 !important; }
      .dg-supervisor { position: sticky; top: 0; z-index: 50; backdrop-filter: blur(6px); }
    `;

    const S = {
      wrap: { padding: 12, fontSize: 13, color: "inherit", overflowX: "auto" },
      head: { display: "flex", alignItems: "center", gap: 12, marginBottom: 8 },
      grid: { display: "grid", gridTemplateColumns: "130px repeat(6, minmax(150px, 1fr))", gap: 4 },
      laneLabel: { fontWeight: 600, padding: "8px 6px", borderTop: "1px solid rgba(128,128,128,.35)" },
      stageHead: { fontWeight: 600, textAlign: "center", padding: 4, opacity: 0.75 },
      cell: { borderTop: "1px solid rgba(128,128,128,.35)", padding: 4, minHeight: 40, verticalAlign: "top" },
      goalCard: {
        border: "1px solid rgba(128,128,128,.45)",
        borderLeft: "5px solid #4c8dff",
        borderRadius: 6, padding: "6px 8px", marginBottom: 6,
        background: "rgba(128,128,128,.08)", cursor: "pointer",
      },
      depCard: { borderLeft: "5px solid #e0a53a" },
      blockedCard: { borderLeft: "5px solid #d66" },
      subCard: {
        border: "1px solid rgba(128,128,128,.35)",
        borderLeft: "4px solid #3aa675",
        borderRadius: 5, padding: "2px 6px", margin: "4px 0 0 10px",
        fontSize: 11, opacity: 0.9,
      },
      title: { fontWeight: 600, marginBottom: 2 },
      meta: { opacity: 0.65, fontSize: 12 },
      statusLine: { fontStyle: "italic", opacity: 0.85, marginTop: 3 },
      collapsed: {
        padding: "6px", opacity: 0.75, cursor: "pointer", userSelect: "none",
        borderTop: "1px dashed rgba(128,128,128,.35)",
      },
      overlay: {
        position: "fixed", inset: 0, background: "rgba(0,0,0,.55)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999,
      },
      drawer: {
        position: "fixed", top: 0, right: 0, height: "100vh", width: 400,
        background: "#1e1f24", color: "#e6e6e6", zIndex: 10000,
        boxShadow: "-4px 0 16px rgba(0,0,0,.45)",
        padding: "20px 22px", overflowY: "auto", fontSize: 13, lineHeight: 1.7,
        fontFamily: "inherit",
      },
      drawerSection: { marginTop: 14 },
      drawerH: { fontWeight: 700, fontSize: 13, marginBottom: 6, opacity: 0.9 },
      modal: {
        background: "#1e1f24", color: "#e6e6e6", borderRadius: 10,
        maxWidth: 720, width: "90%", maxHeight: "80vh", overflowY: "auto",
        padding: "16px 20px", fontSize: 13, lineHeight: 1.6,
      },
      modalSection: { marginTop: 10, whiteSpace: "pre-wrap" },
      modalH: { fontWeight: 700, marginBottom: 4 },
      btn: { fontSize: 12, padding: "2px 10px", cursor: "pointer" },
      close: { float: "right", cursor: "pointer", opacity: 0.7, fontSize: 16 },
      // g-107 会话内嵌实时区
      liveStrip: {
        marginTop: 4, padding: "3px 6px", borderRadius: 4,
        background: "rgba(76,141,255,.10)", fontSize: 11, lineHeight: 1.6,
      },
      liveLine: {
        marginTop: 2, opacity: 0.85, whiteSpace: "nowrap",
        overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%",
      },
      livePanel: {
        marginTop: 10, padding: 8, border: "1px solid rgba(76,141,255,.35)",
        borderRadius: 6, background: "rgba(76,141,255,.06)",
      },
      promptBox: { marginTop: 4 },
      promptRow: { display: "flex", gap: 4, alignItems: "center" },
      promptInput: {
        flex: 1, minWidth: 0, fontSize: 12, padding: "3px 6px",
        background: "rgba(0,0,0,.25)", color: "inherit",
        border: "1px solid rgba(128,128,128,.4)", borderRadius: 4,
      },
      // g-108 看板顶部 supervisor 状态栏
      supervisorBar: {
        display: "flex", alignItems: "center", gap: 10, marginBottom: 8,
        padding: "4px 10px", border: "1px solid rgba(58,166,117,.45)",
        borderRadius: 6, background: "rgba(30,31,36,.92)", fontSize: 12,
      },
      recordItem: {
        marginTop: 3, padding: "3px 6px", borderRadius: 4,
        background: "rgba(128,128,128,.10)", whiteSpace: "pre-wrap",
        wordBreak: "break-word", fontSize: 12,
      },
    };

    function stageOf(status) {
      for (const s of STAGES) if (s.statuses.includes(status)) return s.key;
      return "describe";
    }

    const CARD_STATUS_ICON = { empty: "○ 待收集", collecting: "◌ 收集中", filled: "● 已填充", reviewed: "✔ 已复核" };

    // ===== g-107 会话内嵌实时：复用 DSH 客户端会话机制，不自建数据通道 =====
    // 数据源：sessions.binding(childId).session（uSES 快照 subscribe/getSnapshot），
    // 流式行读 chat.legacy.partial（必须先 session.open()），token/上下文走投影
    // faceOf("tokenUsage"|"contextPressure")（无需 open），模型走 connection.api.sessions.models，
    // 发指令走 session.prompt（continuable 子代理自动路由 api.subagents.prompt，仅文本），
    // 最近记录走 connection.api.subagents.history。

    const boundSetup = new Map(); // childId -> Promise（open/地址配置只做一次）
    const boundModes = new Map(); // childId -> 'one-shot' | 'continuable'

    // 子代理地址配置（路由 prompt/history 到 subagents.*）+ 打开尾页以接收活事件。
    // 目录 entry 提供真实 mode；目录未收录时跳过地址配置（指令走 session.prompt 默认路由，错误会明示）。
    function setupBoundSession(parentId, childId, session) {
      if (boundSetup.has(childId)) return boundSetup.get(childId);
      const p = (async () => {
        if (parentId) {
          try {
            sessionsRt.setSubagentCatalogOpen?.(parentId, true);
            await sessionsRt.refreshSubagents?.(parentId);
            const entries = sessionsRt.list?.getSnapshot?.().subagentsByParent?.[parentId]?.entries ?? [];
            const entry = entries.find((e) => e.kind === "child" && e.id === childId);
            if (entry) {
              boundModes.set(childId, entry.mode);
              session.configureSubagent?.(
                { parentSessionId: parentId, childSessionId: childId, mode: entry.mode }, true);
            }
          } catch (e) {
            console.warn("[dsh-graph-client] 子代理地址配置失败", e);
          }
        }
        try { await session.open(); } catch (e) {
          console.warn("[dsh-graph-client] session.open() 失败", e);
        }
      })();
      boundSetup.set(childId, p);
      return p;
    }

    const NOOP_UNSUB = () => () => {};

    // 会话列表快照：列表刷新（含子代理会话入列）时触发重渲染，binding 随之可解析
    function useSessionsList() {
      const subscribe = React.useCallback(
        (cb) => (sessionsRt?.list ? sessionsRt.list.subscribe(cb) : NOOP_UNSUB()), []);
      const getSnapshot = React.useCallback(
        () => (sessionsRt?.list ? sessionsRt.list.getSnapshot() : null), []);
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    // 解析绑定 childId 的 Session（binding 是文档化的纯解析，渲染期安全）
    function useBoundSession(parentId, childId) {
      const listSnap = useSessionsList();
      const session = React.useMemo(() => {
        if (!sessionsRt || !childId) return null;
        try { return sessionsRt.binding(childId)?.session ?? null; }
        catch (e) { console.warn("[dsh-graph-client] binding 解析失败", e); return null; }
      }, [childId, listSnap]);
      const [mode, setMode] = React.useState(boundModes.get(childId) ?? null);
      React.useEffect(() => {
        if (!session) return;
        let alive = true;
        setupBoundSession(parentId, childId, session).then(() => {
          if (alive) setMode(boundModes.get(childId) ?? null);
        });
        return () => { alive = false; };
      }, [session, parentId, childId]);
      return { session, mode };
    }

    function useSessionSnapshot(session) {
      const subscribe = React.useCallback(
        (cb) => (session ? session.subscribe(cb) : NOOP_UNSUB()), [session]);
      const getSnapshot = React.useCallback(
        () => (session ? session.getSnapshot() : null), [session]);
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    // 投影值（faceOf 返回 identity-stable 的 uSES face；投影推送不要求 open，看板常驻）
    function useProjectionValue(session, key) {
      const face = React.useMemo(
        () => (session?.projections ? session.projections.faceOf(key) : null), [session, key]);
      const subscribe = React.useCallback(
        (cb) => (face ? face.subscribe(cb) : NOOP_UNSUB()), [face]);
      const getSnapshot = React.useCallback(
        () => (face ? face.getSnapshot() : undefined), [face]);
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    // 流式快照（chat.legacy.partial）的最新一行可读输出
    function lastStreamLine(partial) {
      const blocks = partial?.blocks ?? [];
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if ((b.kind === "text" || b.kind === "reasoning") && b.text) {
          const lines = b.text.split("\n").map((s) => s.trim()).filter(Boolean);
          if (lines.length) return (b.kind === "reasoning" ? "💭 " : "") + lines[lines.length - 1];
        } else if (b.kind === "tool-call" && b.name) {
          return "🔧 调用工具 " + b.name;
        }
      }
      return null;
    }

    function fmtTok(n) {
      if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
      if (n >= 1000) return (n / 1000).toFixed(1) + "k";
      return String(n);
    }

    // token/上下文占用的紧凑文本（LiveStrip 与 SessionPanel 折叠态共用）
    function liveMeter(usage, pressure) {
      const tokTotal = usage
        ? usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
        : null;
      const ctxPct = pressure && pressure.contextWindow
        ? Math.round((100 * (pressure.projectedTokens ?? pressure.pressureTokens ?? 0)) / pressure.contextWindow)
        : null;
      return [
        tokTotal !== null ? "tok " + fmtTok(tokTotal) : null,
        ctxPct !== null ? "ctx " + ctxPct + "%" : null,
      ].filter(Boolean).join(" ｜ ");
    }

    // 卡片内嵌实时条：摘要行（运行/空闲 + token/上下文占用 合一）+ status_line 摘要 + 最新流式行。
    // status_line 进入状态小窗：运行中前缀 ⏳（进行中），子代理空闲（刚执行完）前缀 ✅（最近已完成）。
    function LiveStrip(props) {
      const { session } = useBoundSession(props.parentId, props.childId);
      const snap = useSessionSnapshot(session);
      const usage = useProjectionValue(session, "tokenUsage");
      const pressure = useProjectionValue(session, "contextPressure");
      if (!props.childId) return null;
      if (!session) {
        return h("div", { style: S.liveStrip, title: props.childId },
          "🔌 会话未接入（不在会话列表）：" + props.childId.slice(0, 8));
      }
      const running = !!(snap && snap.running);
      const line = snap && snap.chat ? lastStreamLine(snap.chat.legacy.partial) : null;
      const meter = liveMeter(usage, pressure);
      return h(
        "div",
        { style: S.liveStrip },
        h("div", { style: { display: "flex", alignItems: "center", gap: 5 } },
          h("span", { style: { color: running ? "#3aa675" : "rgba(128,128,128,.9)", flexShrink: 0 } },
            running ? "🟢 运行中" : "⚪ 空闲"),
          h("span", { style: { ...S.meta, fontSize: 10, overflow: "hidden",
                               textOverflow: "ellipsis", whiteSpace: "nowrap" } },
            meter || "投影待推送")),
        props.statusLine
          ? h("div", { style: S.liveLine, title: (running ? "进行中" : "最近已完成") + "：" + props.statusLine },
              (running ? "⏳ " : "✅ ") + props.statusLine)
          : null,
        line ? h("div", { style: S.liveLine, title: line }, "⏵ " + line) : null,
      );
    }

    // 看板直达指令：向 continuable 子代理发文本（queue 排队 / steer 插队）。
    // 多模态降级：子代理图片源码级不支持（SUBAGENT_IMAGE_UNSUPPORTED）——明确提示而非静默失败。
    function PromptBox(props) {
      const { session, mode } = useBoundSession(props.parentId, props.childId);
      const [text, setText] = React.useState("");
      const [note, setNote] = React.useState(null);
      if (!props.childId || !session) return null;
      if (mode === "one-shot") {
        return h("div", { style: { ...S.meta, marginTop: 3 } },
          "📦 一次性子代理会话为只读，不能续发指令");
      }
      const send = async (sendMode) => {
        const t = text.trim();
        if (!t) return;
        setNote("发送中…");
        try {
          // session.prompt：continuable 子代理自动路由 api.subagents.prompt（仅文本）
          const res = await session.prompt([{ type: "text", text: t }], sendMode);
          if (res?.ok) {
            setText("");
            setNote(sendMode === "steer" ? "✅ 已插队发送" : "✅ 已排队");
          } else {
            const err = res?.error ?? {};
            const reason = String(err?.details?.reason ?? err?.code ?? "");
            if (reason.includes("SUBAGENT_IMAGE_UNSUPPORTED"))
              setNote("⚠️ 子代理会话不支持图片等多模态输入（SUBAGENT_IMAGE_UNSUPPORTED），请改用纯文本");
            else setNote("⚠️ 发送失败：" + (err?.message ?? reason ?? "未知错误"));
          }
        } catch (e) {
          setNote("⚠️ 发送异常：" + (e?.message ?? e));
        }
      };
      return h(
        "div",
        { style: S.promptBox, onClick: (e) => e.stopPropagation() },
        h("div", { style: S.promptRow },
          h("input", {
            style: S.promptInput,
            value: text,
            placeholder: "直达指令：发送到该子代理会话…",
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") send("queue"); },
          }),
          h("button", {
            style: { ...S.btn, flexShrink: 0 }, className: "dg-btn",
            title: "追加到会话队列尾部（queue）", onClick: () => send("queue"),
          }, "排队"),
          h("button", {
            style: { ...S.btn, flexShrink: 0 }, className: "dg-btn",
            title: "打断当前输出立即执行（steer）", onClick: () => send("steer"),
          }, "插队")),
        h("div", { style: { ...S.meta, fontSize: 10 } },
          "仅文本：子代理会话不支持图片等多模态输入（SUBAGENT_IMAGE_UNSUPPORTED）",
          note ? " ｜ " + note : ""),
      );
    }

    // 最近会话记录：api.subagents.history（无父会话时退化 api.sessions.history）
    function RecentRecords(props) {
      const [state, setState] = React.useState({ loading: true });
      React.useEffect(() => {
        if (!connectionRt) { setState({ loading: false, error: "connection 服务不可用" }); return; }
        let alive = true;
        const call = props.parentId
          ? connectionRt.api.subagents.history({
              parentSessionId: props.parentId, childSessionId: props.childId,
              mode: props.mode ?? "continuable", maxMessages: 30,
            })
          : connectionRt.api.sessions.history({ sessionId: props.childId, maxMessages: 30 });
        call
          .then((r) => alive && setState(r?.result?.ok
            ? { loading: false, entries: r.result.value.events }
            : { loading: false, error: r?.result?.error?.message ?? "读取失败" }))
          .catch((e) => alive && setState({ loading: false, error: String(e?.message ?? e) }));
        return () => { alive = false; };
      }, [props.parentId, props.childId]);

      const entryText = (entry) => {
        const ev = entry?.event ?? {};
        const d = ev.data ?? {};
        if (ev.type === "user/message" || ev.type === "assistant/message") {
          const parts = (Array.isArray(d.content) ? d.content : [])
            .map((b) => b.type === "text" ? b.text
              : b.type === "reasoning" ? "💭" + String(b.text ?? "").slice(0, 120)
              : "[" + (b.type ?? "?") + "]")
            .join("");
          return (ev.type === "user/message" ? "🧑 " : "🤖 ") + (parts.trim().slice(0, 400) || "（空消息）");
        }
        if (ev.type === "assistant/tool-call") return "🔧 " + (d.name ?? "tool");
        return "· " + (ev.type ?? "未知事件");
      };

      let body;
      if (state.loading) body = "读取中…";
      else if (state.error) body = "读取失败：" + state.error;
      else if (!state.entries.length) body = "（无记录）";
      else body = state.entries.slice(-12).map((e, i) =>
        h("div", { key: i, style: S.recordItem }, entryText(e)));
      return h("div", { style: { marginTop: 4, fontSize: 12 } }, body);
    }

    // 当前模型查询（api.sessions.models，无投影走 RPC；30s 轮询）。
    // origin=subagent 的子会话被 host 围栏拒绝（agent-busy: owned by subagent routing，
    // dsh-api-remotes 源码级设计），此时退化查询父会话并标注 fromParent。
    function useSessionModel(sessionId, parentId) {
      const [model, setModel] = React.useState(null); // {provider, model, fromParent}
      const [modelErr, setModelErr] = React.useState(null);
      React.useEffect(() => {
        if (!sessionId || !connectionRt) return;
        let alive = true;
        const load = async () => {
          try {
            let r = await connectionRt.api.sessions.models({ sessionId });
            let fromParent = false;
            if (!r?.result?.ok && parentId) {
              r = await connectionRt.api.sessions.models({ sessionId: parentId });
              fromParent = true;
            }
            if (!alive) return;
            if (r?.result?.ok) {
              setModel({ ...(r.result.value.current ?? {}), fromParent });
              setModelErr(null);
            } else {
              setModelErr(r?.result?.error?.message ?? "查询失败");
            }
          } catch (e) {
            if (alive) setModelErr(String(e?.message ?? e));
          }
        };
        load();
        const t = setInterval(load, 30000);
        return () => { alive = false; clearInterval(t); };
      }, [sessionId, parentId]);
      return { model, modelErr };
    }

    // 完整实时面板（抽屉/详情用）：实时条 + 模型 + 直达指令 + 最近记录。
    // collapsible=true 时默认折叠，点击标题行展开；折叠态标题行内联显示状态/token/模型摘要。
    function SessionPanel(props) {
      const collapsible = !!props.collapsible;
      const [open, setOpen] = React.useState(!collapsible);
      const { session, mode } = useBoundSession(props.parentId, props.childId);
      const snap = useSessionSnapshot(session);
      const usage = useProjectionValue(session, "tokenUsage");
      const pressure = useProjectionValue(session, "contextPressure");
      const { model, modelErr } = useSessionModel(props.childId, props.parentId);
      const [showRecords, setShowRecords] = React.useState(false);

      const running = !!(snap && snap.running);
      const meter = liveMeter(usage, pressure);
      const modelText = model
        ? `${model.provider}/${model.model}` + (model.fromParent ? "（父会话，子代理继承）" : "")
        : modelErr ? "不可用：" + modelErr : "查询中…";
      // 折叠态标题行的内联摘要：状态 + token/ctx + 模型短名
      const collapsedBits = [
        running ? "🟢" : "⚪",
        meter || null,
        model ? model.model + (model.fromParent ? "*" : "") : null,
      ].filter(Boolean).join(" ｜ ");
      return h(
        "div",
        { style: S.livePanel },
        h("div", {
            style: { ...S.drawerH, display: "flex", alignItems: "center", gap: 6,
                     cursor: collapsible ? "pointer" : "default", userSelect: "none" },
            title: collapsible ? (open ? "点击收起" : "点击展开") : undefined,
            onClick: collapsible ? () => setOpen(!open) : undefined,
          },
          h("span", { style: { flexShrink: 0 } },
            (collapsible ? (open ? "▾ " : "▸ ") : "") + "📡 实时会话"),
          collapsible && !open && collapsedBits
            ? h("span", { style: { ...S.meta, fontSize: 11, flex: 1, minWidth: 0,
                                   overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                collapsedBits)
            : h("span", { style: { flex: 1 } }),
          sessionLinkBtn(props.parentId, props.childId, "↗ 打开会话")),
        !open ? null : [
          h(LiveStrip, { key: "s", parentId: props.parentId, childId: props.childId,
                         statusLine: props.statusLine }),
          h("div", { key: "m", style: { ...S.meta, marginTop: 3 } },
            "模型：" + modelText
            + (mode ? ` ｜ 模式：${mode === "continuable" ? "可续轮" : "一次性"}` : "")),
          h(PromptBox, { key: "p", parentId: props.parentId, childId: props.childId }),
          h("div", { key: "r", style: { marginTop: 6 } },
            h("button", {
              style: S.btn, className: "dg-btn",
              onClick: () => setShowRecords(!showRecords),
            }, showRecords ? "▾ 收起最近记录" : "▸ 查看最近会话记录")),
          showRecords
            ? h(RecentRecords, { key: "rr", parentId: props.parentId, childId: props.childId, mode })
            : null,
        ],
      );
    }

    // g-108 看板顶部 supervisor 状态栏：复用 LiveStrip（运行/空闲、最新流式行、tok/ctx）
    // + 模型名（useSessionModel，顶层会话直接查）+ 一键跳转主管对话。
    // 会话 id 来自 board 端点下发的 supervisorSession（project.yaml），不硬编码。
    function SupervisorBar(props) {
      const { model, modelErr } = useSessionModel(props.id, null);
      const jump = () => {
        try {
          sessionsRt?.open?.(props.id); // supervisor 是顶层会话，直接 open
          activateChatTab();            // 已在该会话看板 tab 时切回「对话」
        } catch (e) {
          console.warn("[dsh-graph-client] 跳转主管会话失败", e);
        }
      };
      return h(
        "div",
        { style: S.supervisorBar, className: "dg-supervisor" },
        h("span", { style: { fontWeight: 600, flexShrink: 0 } }, "🧭 主管"),
        h("div", { style: { flex: 1, minWidth: 0 } },
          h(LiveStrip, { parentId: null, childId: props.id })),
        h("span", { style: { ...S.meta, flexShrink: 0 } },
          model ? `${model.provider}/${model.model}` : modelErr ? "模型不可用" : "模型查询中…"),
        h("button", {
          style: { ...S.btn, flexShrink: 0 }, className: "dg-btn",
          title: "跳转到主管 Agent 对话窗", onClick: jump,
        }, "↗ 主管对话"),
      );
    }

    // 目标卡：只保留关键信息（标题/状态/状态行/徽标/依赖），子卡片扼要列出、点击开抽屉
    // 依赖徽章状态化（发现#23）：已交付依赖显示「依赖满足」，仅未交付依赖显示「等待」并触发琥珀边框
    function Card(g, onOpen, onOpenCard, activeGoal, activeCard, goalStatus) {
      const blocked = g.status === "blocked";
      const deps = g.depends_on ?? [];
      const pendingDeps = deps.filter((d) => goalStatus?.[d] !== "delivered");
      const metDeps = deps.filter((d) => goalStatus?.[d] === "delivered");
      const hasDep = pendingDeps.length > 0;
      const style = {
        ...S.goalCard,
        ...(hasDep ? S.depCard : {}),
        ...(blocked ? S.blockedCard : {}),
      };
      const badges = [];
      if (g.reviewer === "human") badges.push("👤人审");
      if (g.reviewer === "ai") badges.push("🤖AI审");
      if (g.pk_lanes > 1) badges.push("PK×" + g.pk_lanes);
      return h(
        "div",
        { key: g.id, style, className: "dg-card" + (activeGoal ? " dg-card-active" : ""),
          title: "点击打开详情", onClick: () => onOpen(g.id) },
        h("div", { style: S.title }, `🎯 ${g.title}`),
        h("div", { style: S.meta },
          `${g.id} ｜ ${STATUS_LABEL[g.status] ?? g.status}${badges.length ? " ｜ " + badges.join(" ") : ""}`,
          sessionLinkBtn(g.attempt_parent_session_id, g.attempt_child_id, "↗ 执行会话")),
        hasDep
          ? h("div", { style: { ...S.meta, color: "#e0a53a" } }, `⛓ 等待 ${pendingDeps.join("、")} 交付`)
          : null,
        metDeps.length
          ? h("div", { style: { ...S.meta, color: "#3aa675" } }, `✅ 依赖满足：${metDeps.join("、")} 已交付`)
          : null,
        blocked && g.blocked_reason
          ? h("div", { style: { ...S.statusLine, color: "#d66" } }, "⛔ " + g.blocked_reason)
          : null,
        // g-107/g-108：执行会话内嵌实时条——status_line 摘要并入状态小窗
        //（运行中 ⏳ / 空闲刚执行完 ✅）；无执行会话时退化为独立状态行
        g.attempt_child_id
          ? h("div", { key: "live", onClick: (e) => e.stopPropagation() },
              h(LiveStrip, { parentId: g.attempt_parent_session_id, childId: g.attempt_child_id,
                             statusLine: g.status_line }))
          : g.status_line
            ? h("div", { style: S.statusLine }, "⏳ " + g.status_line)
            : null,
        (g.cards ?? []).map((c) =>
          h("div", {
            key: c.id,
            style: { ...S.subCard, cursor: "pointer" },
            className: "dg-sub" + (activeCard === c.id ? " dg-sub-active" : ""),
            title: "点击打开上下文抽屉",
            onClick: (e) => { e.stopPropagation(); onOpenCard(g.id, c.id); },
          },
            h("div", { style: { display: "flex", alignItems: "center", gap: 4 } },
              h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                `📇 ${CARD_STATUS_ICON[c.status] ?? c.status} ｜ ${c.title}`),
              sessionLinkBtn(c.parent_session_id, c.child_id, "↗")),
            c.summary ? h("div", { style: { opacity: 0.75, marginTop: 1 } }, c.summary) : null,
            c.child_id
              ? h("div", { onClick: (e) => e.stopPropagation() },
                  h(LiveStrip, { parentId: c.parent_session_id, childId: c.child_id }))
              : null)),
      );
    }

    // 上下文抽屉：摘要 + 全文 + 子代理 id/链接
    function CardDrawer(props) {
      const [state, setState] = React.useState({ loading: true });
      React.useEffect(() => {
        let alive = true;
        fetch("/api/dsh-graph/goal?id=" + encodeURIComponent(props.goalId))
          .then((r) => r.json())
          .then((data) => alive && setState({ loading: false, data }))
          .catch((e) => alive && setState({ loading: false, error: String(e) }));
        return () => { alive = false; };
      }, [props.goalId]);

      let inner;
      if (state.loading) inner = "加载中…";
      else if (state.error) inner = "获取失败：" + state.error;
      else {
        const card = (state.data.cards ?? []).find((c) => c.id === props.cardId);
        if (!card) inner = "卡片不存在：" + props.cardId;
        else {
          const childLink = card.child_id
            ? h("div", { style: S.drawerSection, key: "child" },
                h("div", { style: { ...S.drawerH, display: "flex", alignItems: "center", justifyContent: "space-between" } },
                  "🤖 收集子代理",
                  card.parent_session_id
                    ? h("button", {
                        style: S.btn,
                        className: "dg-btn",
                        onClick: () => { openChildSession(card.parent_session_id, card.child_id); },
                      }, "↗ 在会话中打开")
                    : null),
                h("div", { style: S.meta }, `id：${card.child_id}`))
            : null;
          inner = [
            h("div", { key: "t", style: { fontWeight: 700, fontSize: 14 } },
              `📇 ${card.title}`),
            h("div", { key: "m", style: S.meta },
              `${card.id} ｜ ${card.kind} ｜ ${CARD_STATUS_ICON[card.status] ?? card.status}${card.filled_by ? " ｜ 填充：" + card.filled_by : ""}`),
            childLink,
            card.summary ? h("div", { key: "s", style: S.drawerSection },
              h("div", { style: S.drawerH }, "摘要"), card.summary) : null,
            h("div", { key: "body", style: S.drawerSection },
              h("div", { style: S.drawerH }, "全文"),
              h("div", { style: { whiteSpace: "pre-wrap" } }, card.content?.trim() || "（尚未采集内容）")),
            // g-107：卡片会话内嵌——实时状态/模型/直达指令/最近记录
            card.child_id
              ? h(SessionPanel, { key: "live", parentId: card.parent_session_id, childId: card.child_id, collapsible: true })
              : null,
          ];
        }
      }
      return h(
        "div",
        null,
        h("div", { style: { ...S.overlay, background: "rgba(0,0,0,.35)" }, onClick: props.onClose }),
        h("div", { style: S.drawer, onClick: (e) => e.stopPropagation() },
          h("span", { style: S.close, onClick: props.onClose }, "✕"),
          inner),
      );
    }

    // 质量判据 checklist（确认阶段）：每条一个勾选框（localStorage 按目标持久化，仅前端评审草稿）
    // + 「💬 反馈」按钮——展开输入框，经 session.prompt 排队送达该目标的执行会话（复用 g-107 通路）。
    function CriteriaChecklist(props) {
      const items = String(props.crit ?? "").split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("<!--"));
      const storeKey = "dsh-graph.crit." + props.goalId;
      const readChecked = () => {
        try { return JSON.parse(localStorage.getItem(storeKey) ?? "[]"); } catch { return []; }
      };
      const [checked, setChecked] = React.useState(readChecked);
      const [fbIdx, setFbIdx] = React.useState(-1);
      const [fbText, setFbText] = React.useState("");
      const [fbNote, setFbNote] = React.useState(null);
      const { session } = useBoundSession(props.att?.parent_session_id ?? null, props.att?.child_id ?? null);
      if (!items.length) return null;
      const toggle = (line) => {
        const next = checked.includes(line) ? checked.filter((t) => t !== line) : [...checked, line];
        setChecked(next);
        try { localStorage.setItem(storeKey, JSON.stringify(next)); } catch {}
      };
      const sendFb = async (criterion) => {
        const t = fbText.trim();
        if (!t) return;
        if (!session?.prompt) { setFbNote("⚠️ 执行会话未接入，反馈无法送达"); return; }
        try {
          const res = await session.prompt(
            [{ type: "text", text: `【${props.goalId} 判据反馈】${criterion}\n${t}` }], "queue");
          if (res?.ok) { setFbNote("✅ 反馈已排队送达执行会话"); setFbText(""); setFbIdx(-1); }
          else setFbNote("⚠️ 反馈发送失败：" + (res?.error?.message ?? "未知错误"));
        } catch (e) { setFbNote("⚠️ 反馈发送失败：" + String(e?.message ?? e)); }
      };
      return h("div", null,
        items.map((line, i) => {
          const done = checked.includes(line);
          const label = line.replace(/^\d+[.、)]\s*/, "");
          return h("div", { key: i, style: { marginBottom: 3 } },
            h("div", { style: { display: "flex", alignItems: "flex-start", gap: 6 } },
              h("input", { type: "checkbox", checked: done, onChange: () => toggle(line),
                           style: { flexShrink: 0, cursor: "pointer", marginTop: 2 } }),
              h("span", { style: { flex: 1, minWidth: 0, opacity: done ? 0.55 : 1,
                                   textDecoration: done ? "line-through" : "none" } }, label),
              h("button", { style: { ...S.btn, flexShrink: 0 }, className: "dg-btn",
                            title: "针对此判据向执行会话反馈",
                            onClick: () => { setFbIdx(fbIdx === i ? -1 : i); setFbNote(null); } },
                "💬 反馈")),
            fbIdx === i
              ? h("div", { style: { display: "flex", gap: 4, marginTop: 3, marginLeft: 22 } },
                  h("input", { style: S.promptInput, value: fbText, placeholder: "反馈内容…",
                               onChange: (e) => setFbText(e.target.value),
                               onKeyDown: (e) => { if (e.key === "Enter") sendFb(line); } }),
                  h("button", { style: S.btn, className: "dg-btn", onClick: () => sendFb(line) }, "发送"))
              : null);
        }),
        fbNote ? h("div", { style: { ...S.meta, marginTop: 3 } }, fbNote) : null);
    }

    // 详情 modal：扼要分区 + 人类化事件
    function GoalModal(props) {
      const [state, setState] = React.useState({ loading: true });
      React.useEffect(() => {
        let alive = true;
        fetch("/api/dsh-graph/goal?id=" + encodeURIComponent(props.id))
          .then((r) => r.json())
          .then((data) => alive && setState({ loading: false, data }))
          .catch((e) => alive && setState({ loading: false, error: String(e) }));
        return () => { alive = false; };
      }, [props.id]);

      const section = (body, name) => {
        const m = new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(body ?? "");
        return m ? m[1].trim() : null;
      };

      let content;
      let headMeta = null;   // 标题下 1-2 行：状态/泳道/版本/评审 + 等待/状态摘要
      let livePanel = null;  // 📡 会话实时：紧随摘要行
      if (state.loading) content = "加载详情…";
      else if (state.error) content = "详情获取失败：" + state.error;
      else if (state.data.error) content = "详情错误：" + state.data.error;
      else {
        const d = state.data;
        const desc = section(d.body, "目标描述");
        const crit = section(d.body, "质量判据");
        const meta = d.meta ?? {};
        const status = String(meta.status ?? "unknown");
        const stage = STAGES.find((s) => s.key === stageOf(status));
        const deps = (Array.isArray(meta.depends_on) ? meta.depends_on : []).map((x) => String(x?.goal ?? x));
        const lastAtt = (d.attempts ?? []).slice(-1)[0];
        const statusLine = lastAtt?.status_line ?? null;
        const bits = [
          props.id,
          "状态：" + (STATUS_LABEL[status] ?? status),
          stage ? "泳道：" + stage.label : null,
          "归属：" + (meta.version ? `版本 ${meta.version}` : "独立/backlog"),
          meta.review?.reviewer === "human" ? "👤人审" : meta.review?.reviewer === "ai" ? "🤖AI审" : null,
        ].filter(Boolean);
        const pendingDeps = deps.filter((d) => props.goalStatus?.[d] !== "delivered");
        const metDeps = deps.filter((d) => props.goalStatus?.[d] === "delivered");
        headMeta = [
          h("div", { key: "m1", style: S.meta }, bits.join(" ｜ ")),
          pendingDeps.length
            ? h("div", { key: "m2", style: { ...S.meta, color: "#e0a53a" } }, `⛓ 等待 ${pendingDeps.join("、")} 交付`)
            : null,
          metDeps.length
            ? h("div", { key: "m2b", style: { ...S.meta, color: "#3aa675" } }, `✅ 依赖满足：${metDeps.join("、")} 已交付`)
            : null,
          status === "blocked" && meta.blocked_reason
            ? h("div", { key: "m3", style: { ...S.meta, color: "#d66" } }, "⛔ " + meta.blocked_reason)
            : statusLine
              ? h("div", { key: "m3", style: { ...S.meta, fontStyle: "italic" } }, "⏳ " + statusLine)
              : null,
        ];
        // g-107：📡 会话实时面板上移至标题与状态摘要下方（默认折叠，点击展开）
        const att = (d.attempts ?? []).filter((a) => a.child_id).slice(-1)[0];
        livePanel = att
          ? h(SessionPanel, { parentId: att.parent_session_id, childId: att.child_id, collapsible: true,
                              statusLine: lastAtt?.status_line ?? null })
          : null;
        content = [
          desc ? h("div", { key: "d", style: S.modalSection },
            h("div", { style: S.modalH }, "📋 目标描述"), desc) : null,
          crit ? h("div", { key: "c", style: S.modalSection },
            h("div", { style: S.modalH }, "✅ 质量判据（勾选确认 / 逐条反馈）"),
            h(CriteriaChecklist, { goalId: props.id, crit, att })) : null,
          (d.cards ?? []).length
            ? h("div", { key: "k", style: S.modalSection },
                h("div", { style: S.modalH }, "🗂 信息收集"),
                d.cards.map((c) => h("div", { key: c.id, style: S.subCard },
                  `${CARD_STATUS_ICON[c.status] ?? c.status} ｜ ${c.title}（${c.kind}）`)))
            : null,
          (() => {
            const meaningful = (d.events ?? []).filter((e) => MEANINGFUL.has(e.event));
            return meaningful.length
              ? h("div", { key: "e", style: S.modalSection },
                  h("div", { style: S.modalH }, "🕘 近期动态"),
                  meaningful.slice(-10).map((e, i) =>
                    h("div", { key: i, style: S.meta }, humanEvent(e))))
              : null;
          })(),
        ];
      }

      return h(
        "div",
        { style: S.overlay, onClick: props.onClose },
        h("div", { style: S.modal, onClick: (e) => e.stopPropagation() },
          h("span", { style: S.close, onClick: props.onClose }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 15 } }, `🎯 ${props.title ?? props.id}`),
          headMeta,
          livePanel,
          content),
      );
    }

    function KanbanView() {
      const [state, setState] = React.useState({ loading: true });
      const [modalGoal, setModalGoal] = React.useState(null);
      const [drawerCard, setDrawerCard] = React.useState(null); // {goalId, cardId}
      const [openReleased, setOpenReleased] = React.useState({});
      const load = () => {
        fetch("/api/dsh-graph")
          .then((r) => r.json())
          .then((data) => setState({ loading: false, data }))
          .catch((e) => setState({ loading: false, error: String(e) }));
      };
      React.useEffect(() => {
        load();
        const t = setInterval(load, 15000);
        return () => clearInterval(t);
      }, []);

      if (state.loading) return h("div", { style: S.wrap }, "dsh-graph 看板加载中…");
      if (state.error) return h("div", { style: S.wrap }, "看板数据获取失败：" + state.error);
      const b = state.data;
      if (b.error) return h("div", { style: S.wrap }, "看板数据错误：" + b.error);

      const active = b.versions.filter((v) => v.status !== "released");
      const released = b.versions.filter((v) => v.status === "released");
      // 全量目标 id→status 映射（依赖徽章状态化，发现#23：已交付依赖算「依赖满足」）
      const goalStatus = {};
      for (const v of b.versions) for (const g of v.goals) goalStatus[g.id] = g.status;
      for (const g of b.standalone) goalStatus[g.id] = g.status;
      for (const g of b.backlog) goalStatus[g.id] = g.status;
      const lane = (label, goals, key) => {
        const cells = STAGES.map((s) =>
          h("div", { key: s.key, style: S.cell },
            goals.filter((g) => stageOf(g.status) === s.key).map((g) =>
              Card(g, setModalGoal, (goalId, cardId) => setDrawerCard({ goalId, cardId }),
                modalGoal === g.id, drawerCard?.cardId, goalStatus))),
        );
        return [h("div", { key: key + "-label", style: S.laneLabel }, label), ...cells];
      };

      const rows = [];
      for (const v of active) rows.push(...lane(`🏷 ${v.name}`, v.goals, "v-" + v.slug));
      rows.push(...lane("独立目标", b.standalone, "standalone"));
      rows.push(...lane("backlog", b.backlog, "backlog"));

      const releasedRows = released.map((v) => {
        const open = !!openReleased[v.slug];
        return [
          h("div", {
            key: "rel-" + v.slug, style: S.collapsed, className: "dg-collapsed", title: "点击展开/收起",
            onClick: () => setOpenReleased({ ...openReleased, [v.slug]: !open }),
          }, `${open ? "▾" : "▸"} ${v.name} ✅ ${v.goals.length} 目标全部交付 · released · ${v.slug}`),
          open ? h("div", { key: "relx-" + v.slug, style: S.grid },
            ...lane(v.name, v.goals, "rellane-" + v.slug)) : null,
        ];
      });

      const modalGoalData = modalGoal
        ? [...active.flatMap((v) => v.goals), ...released.flatMap((v) => v.goals),
           ...b.standalone, ...b.backlog].find((g) => g.id === modalGoal)
        : null;

      return h(
        "div",
        { style: S.wrap },
        h("style", null, HOVER_CSS),
        h("div", { style: S.head },
          h("strong", null, "dsh-graph 看板"),
          h("span", { style: S.meta }, "数据时间：" + (b.generated_at ?? "").replace("T", " ").slice(0, 19)),
          h("button", { style: S.btn, className: "dg-btn", onClick: load }, "刷新")),
        // g-108：顶部 supervisor 状态栏（id 由 board 端点下发，未配置则不显示）
        b.supervisorSession ? h(SupervisorBar, { id: b.supervisorSession }) : null,
        h("div", { style: S.grid },
          h("div", { style: S.stageHead }, "泳道＼阶段"),
          STAGES.map((s) => h("div", { key: s.key, style: S.stageHead }, s.label)),
          ...rows),
        ...releasedRows,
        modalGoal
          ? h(GoalModal, { id: modalGoal, title: modalGoalData?.title, onClose: () => setModalGoal(null), goalStatus })
          : null,
        drawerCard
          ? h(CardDrawer, { goalId: drawerCard.goalId, cardId: drawerCard.cardId,
                            onClose: () => setDrawerCard(null) })
          : null,
      );
    }

    let appCtx = null;
    let sessionsRt = null;
    let connectionRt = null;
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
          console.warn("[dsh-graph-client] child not in catalog, opening parent:", childId);
          rt.open?.(parentSessionId);
          activateChatTab();
        }
      } catch (e) {
        console.warn("[dsh-graph-client] openSubagent failed", e);
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
      name: "dsh-graph-client",
      inject: ["slots", "sessions", "connection"],
      apply(ctx) {
        appCtx = ctx;
        sessionsRt = ctx.sessions ?? null;
        connectionRt = ctx.connection ?? null;
        ctx.slots.inject("conversation.view", () =>
          ctx.slots.register(
            { name: "conversation.view", id: "dsh-graph-kanban", order: 80, label: "看板" },
            (props) => h(KanbanView, props),
          ),
        );
        console.log("[dsh-graph-client] client apply: kanban view registered");
      },
    };
  },
});
