// dsh-graph — 浏览器半边（npm 包名 = dsh-graph；内部 host 插件 id 保留 dsh-graph-host）：手写 classic script，零构建。
// 二维泳道看板。视觉约定：卡片类型用「粗左边框 + 颜色 + 图标」区分；
// 依赖关系用琥珀色左边框 + 「⛓ 等待」标识；详情走 modal 弹窗；事件话术人类化。
window.__ModuleLoader__.load({
  id: "dsh-graph",
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
    // g-a92e1406：补 attempt.status_reported（状态汇报履历）
    const MEANINGFUL = new Set([
      "goal.transition", "goal.amended", "scope.note", "criteria.confirmed",
      "completion.claimed", "review.passed", "review.failed", "attempt.started",
      "goal.moved", "goal.created", "attempt.status_reported",
    ]);

    // 拆出事件三要素（时间/事件/执行者），供表格列渲染与 humanEvent 复用
    function eventParts(e) {
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
      return { when, what, who };
    }

    function humanEvent(e) {
      const { when, what, who } = eventParts(e);
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
      /* g-125 fb3：三角展开/收起按钮——暗底纹、窄宽度，不占整列、不像播放按钮 */
      .dg-chevron {
        background: rgba(128,128,128,.18);
        border: none;
        border-radius: 4px;
        padding: 0 3px;
        min-width: 16px;
        width: auto;
        flex: 0 0 auto;
        color: inherit;
        cursor: pointer;
        line-height: 1.6;
        font-size: 11px;
        opacity: .8;
        transition: background .12s ease, opacity .12s ease;
      }
      .dg-chevron:hover { background: rgba(128,128,128,.32); opacity: 1; }
      .dg-card-active { box-shadow: 0 0 0 2px rgba(76,141,255,.85) !important; background: rgba(76,141,255,.12) !important; }
      .dg-sub-active { background: rgba(58,166,117,.30) !important; box-shadow: 0 0 0 1px #3aa675 !important; }
      .dg-supervisor { position: sticky; top: 0; z-index: 50; backdrop-filter: blur(6px); }
      /* g-a92e1406：运行中状态摘要流动背景 + 图标动画 */
      @keyframes dg-flow-bg {
        0% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
        100% { background-position: 0% 50%; }
      }
      @keyframes dg-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.45; transform: scale(1.25); }
      }
      @keyframes dg-spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .dg-running-flow {
        background: linear-gradient(90deg, rgba(76,141,255,0.30), rgba(58,166,117,0.42), rgba(76,141,255,0.30));
        background-size: 200% 100%;
        animation: dg-flow-bg 2.5s ease infinite;
        border-radius: 4px;
        padding: 2px 6px;
        box-shadow: inset 0 0 0 1px rgba(76,141,255,.45);
      }
      .dg-running-flow .dg-icon-pulse { animation: dg-pulse 1.2s ease-in-out infinite; display: inline-block; }
      .dg-running-flow .dg-icon-spin { animation: dg-spin 1.5s linear infinite; display: inline-block; }
      /* 阻塞行保持静态，无动画类 */
      /* g-125：上下文摘要默认折叠 2 行（截断+省略），展开全文 */
      .dg-summary-clamp {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        text-overflow: ellipsis;
        word-break: break-word;
      }
      .dg-summary-clamp:hover { text-decoration: underline; }
      /* g-137：backlog 行平铺展示样式 */
      .dg-backlog-lane {
        background: rgba(0,0,0,.15);
        border-radius: 6px;
        padding: 4px;
      }
      .dg-backlog-flat {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding: 8px;
        min-height: 40px;
        align-content: flex-start;
      }
      .dg-backlog-flat .dg-card {
        flex: 0 0 220px;
        width: 220px;
        box-sizing: border-box;
      }
      .dg-backlog-flat .dg-cell-drop-active {
        background: rgba(76,141,255,.08);
      }
      /* g-77647351：拖放视觉反馈 */
      .dg-dragging { opacity: 0.45; transform: scale(0.97); }
      .dg-drop-before { border-top: 2px solid #4c8dff !important; }
      .dg-drop-after { border-bottom: 2px solid #4c8dff !important; }
      .dg-cell-drop-active { background: rgba(76,141,255,.10); border-radius: 4px; }
      .dg-drag-ghost { position: fixed; pointer-events: none; z-index: 99999; opacity: 0.85;
        max-width: 260px; padding: 6px 10px; border-radius: 6px;
        background: rgba(30,31,36,.92); border: 1px solid rgba(76,141,255,.55);
        box-shadow: 0 4px 16px rgba(0,0,0,.35); font-size: 12px; font-weight: 600;
        color: #e6e6e6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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

    // g-77647351：拖放辅助函数
    /** Pointer-position half of a card (insert line above or below). */
    function rowHalf(e) {
      const rect = e.currentTarget.getBoundingClientRect();
      return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    }
    /** 将列 key 映射回一个代表状态（用于 transition 目标） */
    function stageDefaultStatus(stageKey) {
      const stage = STAGES.find((s) => s.key === stageKey);
      return stage ? stage.statuses[0] : null;
    }
    /** 跨列拖动时解析目标状态：from+toStageKey → 具体 to 状态 */
    function resolveTargetStatus(fromStatus, toStageKey) {
      // blocked 只能回 blocked_from（由服务端强制，前端预判提示）
      if (fromStatus === "blocked") return null; // 前端不预设，服务端校验
      // planning→collect 二义默认 collecting
      if (toStageKey === "collect") return "collecting";
      if (toStageKey === "describe") return "planning";
      return stageDefaultStatus(toStageKey);
    }
    /** 判断是否为回退方向（后→前，如 delivered→execute） */
    const STAGE_ORDER = STAGES.map((s) => s.key);
    function isBackward(fromStatus, toStatus) {
      const fromStage = stageOf(fromStatus);
      const toStage = stageOf(toStatus);
      if (fromStage === toStage) return false;
      // delivered 终态特殊：任何离开 delivered 的方向都是回退（但 delivered 无出边，服务端会拒）
      return STAGE_ORDER.indexOf(toStage) < STAGE_ORDER.indexOf(fromStage);
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
            console.warn("[dsh-graph-host] 子代理地址配置失败", e);
          }
        }
        try { await session.open(); } catch (e) {
          console.warn("[dsh-graph-host] session.open() 失败", e);
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
        catch (e) { console.warn("[dsh-graph-host] binding 解析失败", e); return null; }
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

    // 状态延续时长（statusAt 距今多久）——g-124 staleStatus 分支显示用（负责人 2026-08-22）
    function fmtElapsed(ts, now) {
      const ms = now - ts;
      if (!(ms > 0)) return "刚刚";
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + " 秒";
      const m = Math.floor(s / 60);
      if (m < 60) return m + " 分钟";
      const h = Math.floor(m / 60);
      if (h < 24) return h + " 小时" + (m % 60 ? " " + (m % 60) + " 分" : "");
      const d = Math.floor(h / 24);
      return d + " 天" + (h % 24 ? " " + (h % 24) + " 小时" : "");
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

    // 卡片内嵌实时条（g-129 负责人 2026-08-22 格式调整）：第一行 = 运行状态 + 流式内容（同行，
    // 流式时有时无不再引起高度变化）；status_line + tok/ctx 放 tooltip（悬浮查看）。
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
      // g-a92e1406 追加（负责人指示）：新一轮开始（running false→true）时清空上次 status，
      // 等 supervisor 快速替换成最新——记录 running 翻转时刻，旧于它的状态视为过期清空。
      const runningSinceRef = React.useRef(null);
      React.useEffect(() => {
        if (running && runningSinceRef.current == null) runningSinceRef.current = Date.now();
        if (!running) runningSinceRef.current = null;
      }, [running]);
      const staleStatus =
        running && props.statusAt != null && runningSinceRef.current != null &&
        props.statusAt < runningSinceRef.current;
      // g-124（负责人 2026-08-22）：staleStatus 不再用等待占位文案——
      // 改为显示当前状态延续时长（statusAt 距今多久，行内 + tooltip）；30s 时钟驱动刷新。
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        if (!staleStatus) return;
        const t = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(t);
      }, [staleStatus]);
      const staleDur = staleStatus && props.statusAt != null ? fmtElapsed(props.statusAt, now) : null;
      const line = snap && snap.chat ? lastStreamLine(snap.chat.legacy.partial) : null;
      const meter = liveMeter(usage, pressure);
      // g-129 负责人 2026-08-22 格式：第一行 = 状态 + 流式内容（同行，流式时有时无不引起高度变化），
      // 右侧有足够宽度时显示 tok/ctx；第二行 = status_line 固定显示。
      const statusLabel = running ? "🟢 运行中" : "⚪ 空闲";
      const statusFull = running ? "运行中" : "空闲";
      // 第二行 status_line 内容（stale 时也显示全文，tooltip 补延续时长——g-124）
      const statusRowText = props.statusLine
        ? (running ? "⏳ " : "✅ ") + props.statusLine
        : (staleStatus ? "⏳ 状态延续 " + staleDur : null);
      // g-129: 空闲时 status_line 背景不带动画
      const statusRowClass = running && props.statusLine ? "dg-running-flow" : "";
      const lineEl = line
        ? h("span", { style: { ...S.meta, fontSize: 10, overflow: "hidden",
                                textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 } },
            "⏵ " + line)
        : h("span", { style: { ...S.meta, fontSize: 10, flex: 1, overflow: "hidden",
                               textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "…");
      return h(
        "div",
        { style: S.liveStrip, title: [statusFull, props.statusLine ? "状态：" + props.statusLine : null, meter ? "资源：" + meter : null, line ? "流式：" + line : null].filter(Boolean).join("\n") },
        // 第一行：状态 + 流式内容（同行）；右侧有空间时显示 tok/ctx（flex 布局自动压缩）
        h("div", { style: { display: "flex", alignItems: "center", gap: 5 } },
          h("span", { style: { color: running ? "#3aa675" : "rgba(128,128,128,.9)", flexShrink: 0 } },
            statusLabel),
          lineEl,
          meter
            ? h("span", { style: { ...S.meta, fontSize: 10, flexShrink: 0, marginLeft: 4 } }, meter)
            : null),
        // 第二行：status_line 固定显示（stale 时也显示全文）
        statusRowText
          ? h("div", {
              className: statusRowClass,
              style: { ...S.liveLine, marginTop: 1, fontSize: 10, overflow: "hidden",
                       textOverflow: "ellipsis", whiteSpace: "nowrap" },
              title: props.statusLine ? props.statusLine + (staleDur ? "（状态已延续 " + staleDur + "）" : "") : undefined,
            }, statusRowText)
          : null,
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
    // 查询某会话的当前模型选择。
    // g-109 判据反馈：子代理会话的 models 查询常失败（continuable idle 后无 live agent），
    // 旧逻辑回退父会话会把「父会话模型」冒充子代理实际模型（如用 flash 派发却显示 v4-pro），
    // 误导负责人。现改为失败即报错，由调用方用「重新执行指定路由」或「查询不可用」兜底。
    function useSessionModel(sessionId, parentId) {
      const [model, setModel] = React.useState(null); // {provider, model, fromParent}
      const [modelErr, setModelErr] = React.useState(null);
      React.useEffect(() => {
        if (!sessionId || !connectionRt) return;
        let alive = true;
        const load = async () => {
          try {
            const r = await connectionRt.api.sessions.models({ sessionId });
            if (!alive) return;
            if (r?.result?.ok) {
              setModel({ ...(r.result.value.current ?? {}), fromParent: false });
              setModelErr(null);
            } else {
              setModel(null);
              setModelErr(r?.result?.error?.message ?? "查询失败");
            }
          } catch (e) {
            if (alive) { setModel(null); setModelErr(String(e?.message ?? e)); }
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
    // g-109 判据反馈：实时会话控件中的「重新执行」——选择 provider/model 重新拉一个子代理。
    // kind="exec" → start-execution（目标执行子代理）；kind="collect" → start-collection（卡片收集子代理，需 cardId+prompt）。
    // 下拉数据源 = spawn-options 的 modelGroups（LLM provider 分组目录）；subagent provider（spawn/fork）不暴露给用户。
    function ReExecBox(props) {
      const { goalId, kind, cardId, prompt } = props;
      const [opts, setOpts] = React.useState(null); // {modelGroups, default}
      const [provider, setProvider] = React.useState("");
      const [model, setModel] = React.useState("");
      const [note, setNote] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        fetch(graphUrl("/api/dsh-graph/spawn-options"))
          .then((r) => r.json())
          .then((d) => {
            if (!alive) return;
            setOpts(d);
            // g-109 判据反馈：默认 = project.yaml executor（spawn-options.default）；
            // provider 不在目录 → 选第一个；model 默认取 project.yaml，若不在所选 provider
            // 的模型清单 → 选该清单第一个（不再出现「模型写死」且 provider/model 失配）。
            const groups = d?.modelGroups ?? [];
            const defP = d?.default?.provider ?? "";
            const defM = d?.default?.model ?? "";
            const effProvider = groups.some((g) => g.id === defP) ? defP : (groups[0]?.id ?? "");
            const g0 = groups.find((x) => x.id === effProvider);
            const ms = g0?.models ?? [];
            const effModel = ms.some((m) => m.id === defM) ? defM : (ms[0]?.id ?? "");
            setProvider(effProvider);
            setModel(effModel);
          })
          .catch(() => alive && setOpts({ modelGroups: null, default: null }));
        return () => { alive = false; };
      }, []);

      const groups = opts?.modelGroups ?? [];
      const currentGroup = groups.find((g) => g.id === provider) ?? null;
      const modelChoices = currentGroup?.models ?? [];

      const relaunch = async () => {
        setBusy(true);
        setNote("重新派发中…");
        try {
          const url = kind === "collect" ? "/api/dsh-graph/start-collection" : "/api/dsh-graph/start-execution";
          const body = { goal: goalId, provider: provider || undefined, model: model || undefined };
          if (kind === "collect") { body.card = cardId; body.prompt = prompt; }
          const r = await fetch(graphUrl(url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            if (data.child_id) {
              const route = data.model_route ? `（${data.model_route}）` : "";
              setNote("✅ 已重新派发子代理，id：" + data.child_id + " " + route);
              showToast("✅ 已重新派发子代理 " + route);
              if (data.model_route) props.onRelaunched?.(data.model_route);
            } else {
              setNote("⚠️ 子代理启动失败：" + (data.child_error || "无 child_id"));
            }
          } else {
            setNote("⚠️ 派发失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setBusy(false);
      };

      const selStyle = {
        fontSize: 12, padding: "2px 6px", cursor: "pointer", maxWidth: 160,
        background: "rgba(128,128,128,.10)", color: "inherit",
        border: "1px solid rgba(128,128,128,.35)", borderRadius: 4,
      };
      // 深色主题：浏览器原生 option 默认白底，下拉展开时突兀 → 显式深色底
      const optStyle = { background: "#2a2b31", color: "#e6e6e6" };
      const defP = opts?.default?.provider ?? "";
      const defM = opts?.default?.model ?? "";
      // 无模型目录（llm 服务不可用）：只显示默认模型 + 提示，仍可重新派发（走 project.yaml 默认）
      const noCatalog = !groups.length;
      return h("div", { style: { marginTop: 6, display: "flex", flexDirection: "column", gap: 4 } },
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
          h("span", { style: { ...S.meta, fontSize: 11 } }, "🔄 重新派发子代理："),
          noCatalog
            ? h("span", { style: { ...S.meta, fontSize: 11 } },
                defP ? `模型 ${defP}/${defM}` : "模型目录不可用")
            : [
                h("select", {
                  style: selStyle, value: provider,
                  title: "LLM provider（缺省 project.yaml executor.provider）",
                  onChange: (e) => { setProvider(e.target.value); setModel(""); },
                },
                  groups.map((g) => h("option", { key: g.id, value: g.id, style: optStyle }, g.name ?? g.id))),
                h("select", {
                  style: selStyle, value: model,
                  disabled: !modelChoices.length,
                  title: "模型（缺省 project.yaml executor.model）",
                  onChange: (e) => setModel(e.target.value),
                },
                  !modelChoices.length
                    ? h("option", { value: defM, style: optStyle }, defM ? `默认 ${defM}` : "model 不可用")
                    : [h("option", { key: "", value: "", style: optStyle }, "默认"),
                       ...modelChoices.map((m) => h("option", { key: m.id, value: m.id, style: optStyle }, m.name ?? m.id))]),
              ],
          h("button", {
            style: { ...S.btn, padding: "3px 10px", fontSize: 12 }, className: "dg-btn dg-relaunch",
            disabled: busy, onClick: relaunch,
          }, busy ? "派发中…" : (kind === "collect" ? "🔄 重新收集" : "🔄 重新执行"))),
        note ? h("div", { style: { ...S.meta, marginTop: 2 } }, note) : null,
      );
    }

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
      const statusLine = props.statusLine ?? null;
      const statusLabel = running ? "🟢 运行中" : "⚪ 空闲";
      // g-109 判据反馈：sessions.models 对子代理查询失败时，用「重新执行指定路由」兜底（绝不用父会话模型冒充）
      const relaunchRoute = props.relaunchRoute ?? null;
      const modelText = model
        ? `${model.provider}/${model.model}` + (model.fromParent ? "（父会话，子代理继承）" : "")
        : relaunchRoute ? `按重新执行指定：${relaunchRoute}` : modelErr ? "不可用：" + modelErr : "查询中…";
      // 折叠态标题行的内联摘要：状态 + statusLine + token/ctx + 模型短名
      const collapsedBits = [
        statusLabel,
        statusLine ? (running ? "⏳ " : "✅ ") + statusLine : null,
        meter || null,
        model ? model.model : relaunchRoute ? "重派:" + String(relaunchRoute).split("/").pop() : null,
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
          collapsible && !open
            ? h("span", { style: { ...S.meta, fontSize: 11, flex: 1, minWidth: 0,
                                   overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                collapsedBits || "（无状态）")
            : h("span", { style: { flex: 1 } }),
          sessionLinkBtn(props.parentId, props.childId, "↗ 转到对话")),
        !open ? null : [
          h(LiveStrip, { key: "s", parentId: props.parentId, childId: props.childId,
                         statusLine }),
          h("div", { key: "m", style: { ...S.meta, marginTop: 3 } },
            "模型：" + modelText
            + (mode ? ` ｜ 模式：${mode === "continuable" ? "可续轮" : "一次性"}` : "")),
          h(PromptBox, { key: "p", parentId: props.parentId, childId: props.childId }),
          // g-109 判据反馈：实时会话控件内「重新执行」——子代理出错/无法运行时换 provider/model 重拉
          props.goalId
            ? h(ReExecBox, { key: "rx", goalId: props.goalId, kind: props.relaunchKind ?? "exec",
                             cardId: props.relaunchCardId, prompt: props.relaunchPrompt,
                             onRelaunched: props.onRelaunched })
            : null,
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
    // g-a92e1406 判据 3① 扩展：statusLine 传 supervisor 自己的 status_line（事件流最新一条），
    // 运行中由 LiveStrip 走 StatusLine 带动画（流动背景 + 图标 pulse）。
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
        h("span", { style: { fontWeight: 600, flexShrink: 0 } }, "🧭 主管"),
        h("div", { style: { flex: 1, minWidth: 0 } },
          h(LiveStrip, { parentId: null, childId: props.id, statusLine: props.statusLine ?? null, statusAt: props.statusAt ?? null })),
        h("span", { style: { ...S.meta, flexShrink: 0 } },
          model ? `${model.provider}/${model.model}` : modelErr ? "模型不可用" : "模型查询中…"),
        h("button", {
          style: { ...S.btn, flexShrink: 0 }, className: "dg-btn",
          title: "跳转到主管 Agent 对话窗", onClick: jump,
        }, "↗ 主管对话"),
      );
    }

    // g-a92e1406：被复用徽章——同一 child_id 跨目标绑定时旧绑定显示「被复用→新目标」
    function ReusedBadge(props) {
      const { childId, reusedBy } = props;
      if (!childId || !reusedBy) return null;
      return h("div", { style: { ...S.meta, color: "#e0a53a", marginTop: 2 } },
        `♻️ 被复用→${reusedBy}`);
    }

    // g-125：上下文摘要默认折叠到 2 行（截断+省略号），点击展开全文；
    // 短摘要（≤40 字）不折叠，直接整行显示。状态提升自 Card（无 hooks 的纯函数）外。
    function CardSummary(props) {
      const [open, setOpen] = React.useState(false);
      const { summary } = props;
      if (!summary) return null;
      if (summary.length <= 40) {
        return h("div", { style: { opacity: 0.75, marginTop: 1 } }, summary);
      }
      return h("div", {
        style: { opacity: 0.75, marginTop: 1, cursor: "pointer" },
        className: open ? "dg-summary-open" : "dg-summary-clamp",
        title: open ? "点击收起摘要" : "点击展开摘要全文",
        onClick: (e) => { e.stopPropagation(); setOpen(!open); },
      }, summary);
    }

    // 目标卡：只保留关键信息（标题/状态/状态行/徽标/依赖），子卡片扼要列出、点击开抽屉
    // 依赖徽章状态化（发现#23）：已交付依赖显示「依赖满足」，仅未交付依赖显示「等待」并触发琥珀边框
    // 被复用徽章（g-a92e1406）：reused_by 由 boardProjection 派生（attempt.reused 事件 + 绑定记录双源），
    // 客户端直接消费 g.reused_by，不再用数组顺序猜测旧/新绑定。
    // g-125：所有卡片统一用标题左侧小三角展开/收起；delivered/blocked 默认折叠精简
    //（折叠态只留标题+状态行，隐藏依赖/livestrip/执行按钮/上下文卡片），可展开查看完整。
    // expanded 默认值由 KanbanView 决定（delivered/blocked 默认 false，其余默认 true），
    // 用户手动切换后记录到 expandedGoals；Card 保持纯函数（无 hooks）。
    // g-77647351：drag 参数——可选拖放对象 {active, marker, start, hover, drop, end}
    function Card(g, onOpen, onOpenCard, activeGoal, activeCard, goalStatus, expanded, onToggleExpand, drag) {
      const blocked = g.status === "blocked";
      const collapsed = !expanded;
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
      const reusedBy = g.reused_by ?? null;
      // g-125：标题左侧小三角（▸ 折叠 / ▾ 展开），所有卡片统一；点击卡片其余区域打开详情
      // fb3：独立 .dg-chevron 样式——暗底纹、窄宽度（不用 S.btn/dg-btn，避免播放按钮观感）
      // fb4：按钮与标题 inline 同行（非 flex 列）——标题换行时第二行从行首开始，不被按钮占去宽度
      const chevron = h("button", {
        style: { marginRight: 4, verticalAlign: "middle", display: "inline-block" },
        className: "dg-chevron",
        title: collapsed ? "展开查看依赖/实时会话/上下文卡片等完整信息" : "收起为精简视图",
        onClick: (e) => { e.stopPropagation(); onToggleExpand(g.id); },
      }, collapsed ? "▸" : "▾");
      const titleRow = h("div", { style: { lineHeight: 1.5 } },
        chevron,
        h("span", { style: { ...S.title, display: "inline", verticalAlign: "middle" } }, `🎯 ${g.title}`));
      // g-77647351：拖放 class 合并
      const dragClass = [
        "dg-card",
        activeGoal ? " dg-card-active" : "",
        drag?.active ? " dg-dragging" : "",
        drag?.marker === "before" ? " dg-drop-before" : "",
        drag?.marker === "after" ? " dg-drop-after" : "",
      ].filter(Boolean).join(" ");
      // g-77647351：拖放事件 props
      const dragProps = drag ? {
        draggable: true,
        onDragStart: (e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", g.id);
          drag.start();
        },
        onDragEnd: () => {
          if (drag?.over) drag.drop(drag.over);
          else drag.end();
        },
      } : {};
      const dropProps = drag ? {
        onDragOver: (e) => {
          // 修复（负责人 2026-08-22）：拖过任意卡片（非源）都应响应并显示 marker 占位——
          // 原守卫 !drag.active 只对源卡片 true，导致目标位置不为空时无 drop 指示。
          if (drag.goalId === g.id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          drag.hover(rowHalf(e));
        },
        onDrop: (e) => {
          if (drag.goalId === g.id) return;
          e.preventDefault();
          drag.drop(rowHalf(e));
        },
      } : {};
      if (collapsed) {
        // g-125 折叠态：仅核心——标题（≤2 行）+ 状态一行；不显示状态摘要、依赖、livestrip、执行按钮、上下文卡片
        return h(
          "div",
          { key: g.id, style, className: dragClass,
            title: "点击打开详情", onClick: () => onOpen(g.id), ...dragProps, ...dropProps },
          titleRow,
          h("div", { style: S.meta },
            `${g.id} ｜ ${STATUS_LABEL[g.status] ?? g.status}${badges.length ? " ｜ " + badges.join(" ") : ""}`),
        );
      }
      return h(
        "div",
        { key: g.id, style, className: dragClass,
          title: "点击打开详情", onClick: () => onOpen(g.id), ...dragProps, ...dropProps },
        titleRow,
        h("div", { style: S.meta },
          `${g.id} ｜ ${STATUS_LABEL[g.status] ?? g.status}${badges.length ? " ｜ " + badges.join(" ") : ""}`,
          sessionLinkBtn(g.attempt_parent_session_id, g.attempt_child_id, "↗ 转到对话")),
        hasDep
          ? h("div", { style: { ...S.meta, color: "#e0a53a" } }, `⛓ 等待 ${pendingDeps.join("、")} 交付`)
          : null,
        metDeps.length
          ? h("div", { style: { ...S.meta, color: "#3aa675" } }, `✅ 依赖满足：${metDeps.join("、")} 已交付`)
          : null,
        blocked && g.blocked_reason
          ? h("div", { style: { ...S.statusLine, color: "#d66" } }, "⛔ " + g.blocked_reason)
          : null,
        // g-a92e1406：执行会话内嵌实时条——status_line 摘要并入状态小窗
        //（运行中 ⏳ / 空闲刚执行完 ✅）；无执行会话时退化为独立状态行（带动画）
        g.attempt_child_id
          ? h("div", { key: "live" },
              h(LiveStrip, { parentId: g.attempt_parent_session_id, childId: g.attempt_child_id,
                             statusLine: g.status_line }))
          : g.status_line
            ? h(StatusLine, { text: g.status_line, blocked: g.status === "blocked", running: g.status === "in_progress" })
            : null,
        reusedBy ? h(ReusedBadge, { childId: g.attempt_child_id, reusedBy }) : null,
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
            h(CardSummary, { summary: c.summary }),
            c.child_id
              ? h("div", { onClick: (e) => e.stopPropagation() },
                  h(LiveStrip, { parentId: c.parent_session_id, childId: c.child_id }))
              : null)),
      );
    }

    // g-a92e1406：状态摘要行——运行中带流动背景+图标动画，阻塞行静态
    function StatusLine(props) {
      const { text, blocked, running } = props;
      if (!text) return null;
      if (blocked) {
        return h("div", { style: { ...S.statusLine, color: "#d66" } }, "⛔ " + text);
      }
      const animClass = running ? "dg-running-flow" : "";
      return h(
        "div", { className: animClass, style: { ...S.statusLine, marginTop: 3 } },
        h("span", { className: running ? "dg-icon-pulse" : "" }, "⏳ "),
        text,
      );
    }

    // 上下文抽屉：摘要 + 全文 + 子代理 id/链接 + g-109 收集提示词编辑
    function CardDrawer(props) {
      const [state, setState] = React.useState({ loading: true });
      const [promptText, setPromptText] = React.useState("");
      const [collectNote, setCollectNote] = React.useState(null);
      const [collecting, setCollecting] = React.useState(false);
      const [relaunchRoute, setRelaunchRoute] = React.useState(null); // g-109：最近一次重新收集的模型路由
      React.useEffect(() => {
        let alive = true;
        fetch(graphUrl("/api/dsh-graph/goal", { id: props.goalId }))
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
          // g-109：自动生成收集提示词草稿（卡片标题+目标上下文模板）
          // g-125：回填要求——summary 一句话要点式 ≤100 字（看板摘要折叠 2 行，长摘要被截断）
          const autoPrompt = `请收集关于「${card.title}」的上下文信息。\n\n目标：${state.data.meta?.title ?? props.goalId}\n\n请基于目标上下文，收集与该卡片相关的详细信息。\n\n回填要求：全文写进 text；summary 写一句话要点式摘要（≤100 字左右），不要长文。`;
          const childLink = card.child_id
            ? h("div", { style: S.drawerSection, key: "child" },
                h("div", { style: { ...S.drawerH, display: "flex", alignItems: "center", justifyContent: "space-between" } },
                  "🤖 收集子代理",
                  card.parent_session_id
                    ? h("button", {
                        style: S.btn,
                        className: "dg-btn",
                        onClick: () => { openChildSession(card.parent_session_id, card.child_id); },
                      }, "↗ 转到对话")
                    : null),
                h("div", { style: S.meta }, `id：${card.child_id}`))
            : null;
          // g-109：收集提示词编辑区（空卡片显示）
          const collectPanel = card.status === "empty" || card.status === "collecting"
            ? h("div", { style: S.drawerSection, key: "collect", className: "dg-collect-prompt" },
                h("div", { style: S.drawerH }, "📝 收集提示词"),
                h("textarea", {
                  style: { ...S.promptInput, width: "100%", minHeight: 80, resize: "vertical", marginTop: 4 },
                  value: promptText || autoPrompt,
                  onChange: (e) => setPromptText(e.target.value),
                }),
                h("button", {
                  style: { ...S.btn, marginTop: 6, padding: "4px 14px" }, className: "dg-btn",
                  disabled: collecting,
                  onClick: async () => {
                    setCollecting(true);
                    setCollectNote("派发中…");
                    try {
                      const r = await fetch(graphUrl("/api/dsh-graph/start-collection"), {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                          goal: props.goalId,
                          card: props.cardId,
                          prompt: promptText || autoPrompt,
                        }),
                      });
                      const data = await r.json();
                      if (data.ok) {
                        if (data.child_error) {
                          setCollectNote("⚠️ 子代理启动失败：" + data.child_error);
                        } else if (data.child_id) {
                          setCollectNote("✅ 已派发收集子代理，id：" + data.child_id);
                        } else {
                          setCollectNote("⚠️ 子代理未启动（无 child_id）");
                        }
                      } else {
                        setCollectNote("⚠️ 派发失败：" + (data.error || "未知错误"));
                      }
                    } catch (e) {
                      setCollectNote("⚠️ 请求失败：" + String(e?.message ?? e));
                    }
                    setCollecting(false);
                  },
                }, "开始收集"),
                collectNote ? h("div", { style: { ...S.meta, marginTop: 4 } }, collectNote) : null)
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
            collectPanel,
            // g-107：卡片会话内嵌——实时状态/模型/直达指令/最近记录
            // g-109 判据反馈：收集子代理出错时在实时会话控件内换 provider/model 重新收集
            card.child_id
              ? h(SessionPanel, { key: "live", parentId: card.parent_session_id, childId: card.child_id, collapsible: true,
                                  goalId: props.goalId, relaunchKind: "collect",
                                  relaunchCardId: props.cardId, relaunchPrompt: promptText || autoPrompt,
                                  relaunchRoute, onRelaunched: setRelaunchRoute })
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
          if (res?.ok) {
            setFbNote("✅ 反馈已排队送达执行会话");
            setFbText("");
            setFbIdx(-1);
            // g-109：判据反馈提交后自动关闭弹窗
            if (props.onClose) props.onClose();
          }
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

    // 轻量 toast：底部居中浮层，约 2.5s 自动消失（零依赖，不引入 DSH 内部组件）
    function showToast(text) {
      const host = document.createElement("div");
      host.style.cssText =
        "position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:99999;" +
        "background:rgba(30,30,30,.94);color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:none;opacity:0;transition:opacity .18s ease;max-width:80vw;";
      host.textContent = text;
      document.body.appendChild(host);
      requestAnimationFrame(() => { host.style.opacity = "1"; });
      setTimeout(() => {
        host.style.opacity = "0";
        setTimeout(() => { if (host.parentNode) document.body.removeChild(host); }, 200);
      }, 2500);
    }

    // 复制文本到剪贴板：优先 Clipboard API（需安全上下文+用户手势），失败回退 execCommand（textarea 选中法）
    async function copyText(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch { /* 回退 */ }
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }

    // g-109：目标描述区执行/反馈交互组件（执行按钮直接创建子代理；接受默认经主管 Agent 复核，
    // 无异议生效，有异议显示在按钮处并转「强制接受」，可选理由记 goal.amended 事件供学习）
    function AcceptFeedback(props) {
      const { goalId, status, events, supervisorSession } = props;
      const [mode, setMode] = React.useState("idle"); // idle | feedback
      const [fbText, setFbText] = React.useState("");
      const [note, setNote] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [forceMode, setForceMode] = React.useState(false); // 异议后是否展开强制接受理由输入
      const [forceReason, setForceReason] = React.useState("");
      // 反馈预填模板（复制与显示共用，保证一致）
      const prefillText = fbText.trim() ? `【${goalId} 反馈】\n${fbText.trim()}` : "";

      // 接受复核状态（与 core readAcceptStatus 同语义的事件流推断）：
      // none（未请求）/ pending（已请求待主管裁决）/ objection（主管异议）/ resolved（已生效）
      const evs = events ?? [];
      let lastReq = -1, lastObj = -1, lastRes = -1;
      evs.forEach((e, i) => {
        if (e.event === "review.requested") lastReq = i;
        if (e.event === "review.objected") lastObj = i;
        if (["description.confirmed", "criteria.confirmed", "review.passed"].includes(e.event)) lastRes = i;
      });
      let acceptState = "none";
      if (lastReq >= 0) {
        if (lastObj > lastReq) acceptState = "objection";
        else if (lastRes > lastReq) acceptState = "resolved";
        else acceptState = "pending";
      }
      const objectionText = acceptState === "objection" ? evs[lastObj]?.details?.objection : null;

      // 接受：默认经主管 Agent 复核（review.requested → 主管裁决）
      const doAccept = async () => {
        setLoading(true);
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/accept"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: goalId }),
          });
          const data = await r.json();
          if (data.pending) setNote("✅ 已请求主管复核接受，等待主管裁决（无异议即生效）");
          else if (data.ok) setNote("✅ 已接受");
          else setNote("⚠️ 接受失败：" + (data.error || "未知错误"));
        } catch (e) {
          setNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setLoading(false);
      };
      // 强制接受：跳过主管复核，可选理由记入 goal.amended 事件
      const doForceAccept = async () => {
        setLoading(true);
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/accept"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: goalId, force: true, reason: forceReason.trim() || undefined }),
          });
          const data = await r.json();
          if (data.ok) setNote(forceReason.trim() ? "✅ 已强制接受（理由已记入事件）" : "✅ 已强制接受");
          else setNote("⚠️ 强制接受失败：" + (data.error || "未知错误"));
          setForceMode(false);
          setForceReason("");
        } catch (e) {
          setNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setLoading(false);
      };

      const startExecution = async () => {
        setLoading(true);
        try {
          // Step 1: force transition 到 in_progress（人工操作视为授权）
          const tr = await fetch(graphUrl("/api/dsh-graph/transition"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: goalId, to: "in_progress", force: true }),
          });
          const trData = await tr.json();
          if (!trData.ok) {
            setNote("⚠️ 状态迁移失败：" + (trData.error || "未知错误"));
            setLoading(false);
            return;
          }
          // Step 2: 派发执行子代理
          const r = await fetch(graphUrl("/api/dsh-graph/start-execution"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: goalId }),
          });
          const data = await r.json();
          if (data.ok) {
            if (data.child_id) {
              setNote("✅ 已派发执行子代理，id：" + data.child_id);
            } else if (data.child_error) {
              setNote("⚠️ 子代理启动失败：" + data.child_error);
            } else {
              setNote("⚠️ 子代理未启动（无 child_id）");
            }
            load(); // 刷新看板
          } else {
            setNote("⚠️ 执行失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setLoading(false);
      };

      const openSupervisorWithFeedback = async () => {
        try {
          const rt = sessionsRt ?? appCtx?.get?.("sessions");
          if (!rt) { setNote("⚠️ 会话服务不可用"); return; }
          // 打开主管会话（id 由 board 端点下发 project.yaml supervisor.session，g-108）
          if (!supervisorSession) { setNote("⚠️ 未配置主管会话（project.yaml 的 supervisor.session）"); return; }
          // 自动复制预填内容（负责人指示），再切到主管对话窗直接粘贴发送
          const copied = prefillText ? await copyText(prefillText) : false;
          rt.open?.(supervisorSession);
          activateChatTab();
          if (copied) {
            showToast("✅ 预填内容已复制，到主管对话窗 Ctrl+V 直接粘贴发送");
            setNote("✅ 预填内容已复制，已切换到主管对话窗，直接粘贴发送");
          } else {
            setNote("⚠️ 自动复制失败（浏览器限制），请手动复制下方预填内容；已切换到主管对话窗");
          }
        } catch (e) {
          setNote("⚠️ 跳转失败：" + String(e?.message ?? e));
        }
      };

      // 是否有活跃「执行」attempt（已启动但未完成）。
      // g-109 定点 bug：「开始收集」也写 attempt.started（executor=agent:collect），
      // 若不加区分，只收集过未执行的目标其 🚀 执行/💬 反馈会被误藏。
      // 只认非 collect 的 attempt：凡非收集类（agent:collect）的 attempt 都视为活跃执行。
      const hasActiveAttempt = (events ?? []).some(
        (e) => e.event === "attempt.started" && e.details?.executor !== "agent:collect",
      );
      // review 及之后阶段、或已有活跃 attempt，不显示执行/反馈按钮
      const allowed = ["draft", "planning", "collecting", "ready"];
      if (!allowed.includes(status) || hasActiveAttempt) return null;

      return h("div", { style: { marginTop: 8, display: "flex", flexDirection: "column", gap: 6 } },
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
          acceptState === "none"
            ? h("button", {
                style: { ...S.btn, padding: "4px 12px", fontSize: 13 }, className: "dg-btn dg-accept",
                disabled: loading, onClick: doAccept,
              }, "✅ 接受")
            : acceptState === "pending"
              ? h("span", { style: { ...S.meta, fontSize: 12 } }, "⏳ 已请求主管复核，等待裁决")
              : acceptState === "resolved"
                ? h("span", { style: { ...S.meta, fontSize: 12, color: "#3aa675" } }, "✅ 已接受生效")
                : null,
          h("button", {
            style: { ...S.btn, padding: "4px 12px", fontSize: 13 }, className: "dg-btn",
            disabled: loading,
            onClick: startExecution,
          }, "🚀 执行"),
          h("button", {
            style: { ...S.btn, padding: "4px 12px", fontSize: 13 }, className: "dg-btn",
            disabled: loading,
            onClick: () => { setMode(mode === "feedback" ? "idle" : "feedback"); setNote(null); },
          }, "💬 反馈")),
        // g-109 判据：主管有异议 → 显示在按钮处，可转「强制接受」（可选理由记事件供学习）
        acceptState === "objection"
          ? h("div", { key: "obj", style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 2 } },
              h("div", { style: { ...S.meta, color: "#e0a53a" } },
                "⚠️ 主管异议：" + (objectionText ?? "（无内容）")),
              forceMode
                ? [
                    h("input", {
                      style: { ...S.promptInput, flex: 1 },
                      value: forceReason, placeholder: "强制接受理由（可选，将记入事件）…",
                      onChange: (e) => setForceReason(e.target.value),
                      onKeyDown: (e) => { if (e.key === "Enter") doForceAccept(); },
                    }),
                    h("div", { style: { display: "flex", gap: 6 } },
                      h("button", {
                        style: { ...S.btn, fontSize: 12 }, className: "dg-btn dg-accept",
                        disabled: loading, onClick: doForceAccept,
                      }, "确认强制接受"),
                      h("button", {
                        style: { ...S.btn, fontSize: 12 }, className: "dg-btn",
                        disabled: loading, onClick: () => { setForceMode(false); setForceReason(""); },
                      }, "取消")),
                  ]
                : h("button", {
                    style: { ...S.btn, fontSize: 12, alignSelf: "flex-start" }, className: "dg-btn dg-accept",
                    onClick: () => setForceMode(true),
                  }, "强制接受（跳过复核）"),
            )
          : null,
        mode === "feedback"
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 2 } },
              h("input", {
                style: { ...S.promptInput, flex: 1 },
                value: fbText, placeholder: "输入反馈内容…",
                onChange: (e) => setFbText(e.target.value),
              }),
              h("button", {
                style: { ...S.btn, fontSize: 11, alignSelf: "flex-start" }, className: "dg-btn",
                onClick: openSupervisorWithFeedback,
              }, "→ 去主管对话窗发送"),
              fbText.trim()
                ? h("div", { style: { ...S.meta, padding: "4px 6px", background: "rgba(128,128,128,.08)", borderRadius: 4 } },
                    "预填内容（已自动复制）：",
                    h("pre", { style: { margin: "4px 0 0", whiteSpace: "pre-wrap", fontSize: 11 } },
                      prefillText))
                : null)
          : null,
        note ? h("div", { style: { ...S.meta, marginTop: 2 } }, note) : null,
      );
    }

    // g-109：新增信息收集任务组件（弹窗内信息收集区）
    function AddCardBox(props) {
      const { goalId, supervisorSession } = props;
      const [mode, setMode] = React.useState("idle"); // idle | naming | chat
      const [title, setTitle] = React.useState("");
      const [note, setNote] = React.useState(null);
      const [loading, setLoading] = React.useState(false);

      const addByName = async () => {
        const t = title.trim();
        if (!t) return;
        setLoading(true);
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/add-card"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: goalId, title: t, kind: "text" }),
          });
          const data = await r.json();
          if (data.ok) {
            setNote("✅ 已创建任务：" + data.card);
            setTitle("");
            setMode("idle");
          } else {
            setNote("⚠️ 创建失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setLoading(false);
      };

      // 对话创建：打开主管会话让用户直接输入需求
      const openSupervisorChat = () => {
        try {
          const rt = sessionsRt ?? appCtx?.get?.("sessions");
          if (!rt) { setNote("⚠️ 会话服务不可用"); return; }
          // 主管会话 id 由 board 端点下发（project.yaml supervisor.session，g-108）
          if (!supervisorSession) { setNote("⚠️ 未配置主管会话（project.yaml 的 supervisor.session）"); return; }
          rt.open?.(supervisorSession);
          activateChatTab();
          setNote("✅ 已切换到对话窗，请直接输入收集需求");
        } catch (e) {
          setNote("⚠️ 跳转失败：" + String(e?.message ?? e));
        }
      };

      return h("div", { style: { marginTop: 8 }, className: "dg-card-add" },
        h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
          h("span", { style: { ...S.meta, fontSize: 11 } }, "新增信息收集任务："),
          h("button", { style: S.btn, className: "dg-btn", onClick: () => { setMode("naming"); setNote(null); } }, "📝 一句话任务"),
          h("button", { style: S.btn, className: "dg-btn", onClick: () => { setMode("chat"); setNote(null); } }, "💬 通过对话创建")),
        mode === "naming"
          ? h("div", { style: { display: "flex", gap: 4, marginTop: 4 } },
              h("input", {
                style: { ...S.promptInput, flex: 1 },
                value: title, placeholder: "输入任务描述…",
                onChange: (e) => setTitle(e.target.value),
                onKeyDown: (e) => { if (e.key === "Enter") addByName(); },
              }),
              h("button", { style: S.btn, className: "dg-btn", onClick: addByName, disabled: loading }, "创建"))
          : null,
        mode === "chat"
          ? h("div", { style: { marginTop: 4, padding: "6px 8px", borderRadius: 4, background: "rgba(76,141,255,.08)" } },
              h("div", null, "点击按钮切换到主管对话窗，直接描述你想收集的信息，主管 Agent 会帮你创建任务并派发子代理。"),
              h("button", {
                style: { ...S.btn, marginTop: 6 }, className: "dg-btn",
                onClick: openSupervisorChat,
              }, "→ 去对话窗输入需求"))
          : null,
        note ? h("div", { style: { ...S.meta, marginTop: 2 } }, note) : null,
      );
    }

    // 详情 modal：g-a92e1406 改为 tab 结构（详情 / 近期动态）
    function GoalModal(props) {
      const [state, setState] = React.useState({ loading: true });
      const [tab, setTab] = React.useState("detail"); // "detail" | "activity"
      const [logSort, setLogSort] = React.useState("desc"); // "desc" | "asc"
      const [logFilter, setLogFilter] = React.useState(""); // "" 全部 / 事件名
      const [relaunchRoute, setRelaunchRoute] = React.useState(null); // g-109：最近一次重新执行的模型路由（显示兜底）
      React.useEffect(() => {
        let alive = true;
        // g-109 判据：接受默认经主管复核——20s 轮询详情，主管裁决（无异议生效/有异议）自动反映到按钮处
        const load = () => fetch(graphUrl("/api/dsh-graph/goal", { id: props.id }))
          .then((r) => r.json())
          .then((data) => alive && setState({ loading: false, data }))
          .catch((e) => alive && setState({ loading: false, error: String(e) }));
        load();
        const t = setInterval(load, 20000);
        return () => { alive = false; clearInterval(t); };
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
            : null,
        ];
        // g-107：📡 会话实时面板上移至标题与状态摘要下方（默认折叠，点击展开）
        // g-109 判据反馈：最新 attempt 无 child_id（子代理启动失败）时也给出「重新执行」兜底区
        const att = (d.attempts ?? []).filter((a) => a.child_id).slice(-1)[0];
        const anyAtt = (d.attempts ?? []).length > 0;
        livePanel = att
          ? h(SessionPanel, { parentId: att.parent_session_id, childId: att.child_id, collapsible: true,
                              statusLine: lastAtt?.status_line ?? null,
                              goalId: props.id, relaunchKind: "exec",
                              relaunchRoute, onRelaunched: setRelaunchRoute })
          : anyAtt
            ? h("div", { key: "relaunch-fallback", style: { ...S.livePanel, marginTop: 6 } },
                h("div", { style: { ...S.meta, marginBottom: 2 } }, "⚠️ 最新子代理未启动/不可用，可换 provider/model 重新派发："),
                h(ReExecBox, { goalId: props.id, kind: "exec", onRelaunched: setRelaunchRoute }))
            : null;

        // g-a92e1406：tab 内容（占位文案视觉降级：trim 后以「（待」开头 → 小字灰色放标题右侧）
        // 识别逻辑：trim 后以「（待」开头 → 占位；若占位后仍有正文，剥离占位行只显示正文
        function isPlaceholder(text) {
          const t = String(text ?? "").trim();
          return t.startsWith("（待");
        }
        function parsePlaceholder(text) {
          const t = String(text ?? "").trim();
          if (!t.startsWith("（待")) return { isPh: false, marker: null, body: t };
          const m = t.match(/^（待[^）]*）/);
          const marker = m ? m[0] : "（待填写）";
          const rest = t.replace(/^（待[^）]*）\s*/, "").trim();
          return { isPh: true, marker, body: rest };
        }
        function sectionBlock(key, title, body, extra, hideBodyWhenExtra) {
          const { isPh, marker, body: content } = parsePlaceholder(body);
          return h("div", { key, style: S.modalSection },
            h("div", { style: S.modalH },
              title,
              isPh && !content ? h("span", { style: { ...S.meta, fontSize: 12, marginLeft: 6, fontWeight: 400 } }, marker) : null),
            hideBodyWhenExtra && extra != null ? null : (isPh && !content ? null : content),
            extra ?? null);
        }
        const detailTab = [
          desc != null ? sectionBlock("d", "📋 目标描述", desc,
            h(AcceptFeedback, { goalId: props.id, status, events: d.events, supervisorSession: props.supervisorSession })) : null,
          // g-109：判据栏只在 ready 及之后阶段显示 checklist（已确认可勾选），早期阶段只显示纯文本
          crit != null ? sectionBlock("c", "✅ 质量判据", crit,
            !isPlaceholder(crit) && ["ready", "in_progress", "review", "delivered"].includes(status)
              ? h(CriteriaChecklist, { goalId: props.id, crit, att, onClose: props.onClose })
              : null, true) : null,
          (d.cards ?? []).length
            ? h("div", { key: "k", style: S.modalSection },
                h("div", { style: S.modalH }, "🗂 信息收集"),
                d.cards.map((c) => h("div", { key: c.id, style: S.subCard },
                  `${CARD_STATUS_ICON[c.status] ?? c.status} ｜ ${c.title}（${c.kind}）`)),
                h(AddCardBox, { goalId: props.id, supervisorSession: props.supervisorSession }))
            : h("div", { key: "k", style: S.modalSection },
                h("div", { style: S.modalH }, "🗂 信息收集"),
                h("div", { style: S.meta }, "（暂无上下文卡片）"),
                h(AddCardBox, { goalId: props.id, supervisorSession: props.supervisorSession })),
        ];
        const activityTab = (() => {
          const meaningful = (d.events ?? []).filter((e) => MEANINGFUL.has(e.event));
          if (!meaningful.length) {
            return [h("div", { key: "empty", style: S.meta }, "（暂无近期动态）")];
          }
          // 简单筛选：按事件类型过滤；排序：按 ts 升/降
          const filtered = logFilter ? meaningful.filter((e) => e.event === logFilter) : meaningful;
          const sorted = [...filtered].sort((a, b) =>
            logSort === "asc" ? String(a.ts).localeCompare(String(b.ts))
                              : String(b.ts).localeCompare(String(a.ts)));
          const typeOptions = [...MEANINGFUL].map((ev) =>
            h("option", { key: ev, value: ev }, EVENT_LABEL[ev] ?? ev));
          const th = { textAlign: "left", padding: "4px 8px", fontWeight: 700,
                       borderBottom: "1px solid rgba(128,128,128,.45)", fontSize: 12 };
          const td = { padding: "3px 8px", borderBottom: "1px solid rgba(128,128,128,.12)", fontSize: 12 };
          return [
            // 排序 / 筛选工具条
            h("div", { key: "tools", style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 6 } },
              h("span", { style: { ...S.meta, fontSize: 11 } }, `共 ${sorted.length} 条`),
              h("select", {
                value: logFilter,
                onChange: (e) => setLogFilter(e.target.value),
                style: { fontSize: 12, padding: "2px 6px", cursor: "pointer",
                         background: "rgba(128,128,128,.10)", color: "inherit",
                         border: "1px solid rgba(128,128,128,.35)", borderRadius: 4 },
              },
                h("option", { value: "" }, "全部类型"), ...typeOptions),
              h("button", {
                onClick: () => setLogSort(logSort === "asc" ? "desc" : "asc"),
                style: { ...S.btn, border: "1px solid rgba(128,128,128,.35)", borderRadius: 4 },
              }, logSort === "asc" ? "↑ 时间正序" : "↓ 时间倒序")),
            // 事件日志表格：时间 / 事件 / 执行者
            h("table", { key: "tbl", style: { width: "100%", borderCollapse: "collapse" } },
              h("thead", null, h("tr", null,
                h("th", { style: th }, "时间"),
                h("th", { style: th }, "事件"),
                h("th", { style: th }, "执行者"))),
              h("tbody", null,
                sorted.map((e, i) => {
                  const { when, what, who } = eventParts(e);
                  return h("tr", { key: i, style: i % 2 ? { background: "rgba(128,128,128,.05)" } : undefined },
                    h("td", { style: { ...td, whiteSpace: "nowrap", opacity: 0.85 } }, when),
                    h("td", { style: td }, what),
                    h("td", { style: { ...td, whiteSpace: "nowrap", opacity: 0.7 } }, who));
                }))),
          ];
        })();

        content = [
          // g-a92e1406：tab 切换栏（页签式——选中页签与下方面板同底色、无下边框、下移覆盖分隔线，
          // 从面板"长出"形成视觉关联；未选中页签扁平透明，区别于普通按钮）
          h("div", {
            key: "tabs",
            style: { display: "flex", gap: 4, marginTop: 12, alignItems: "flex-end",
                     borderBottom: "1px solid rgba(128,128,128,.35)" },
            className: "dg-tab",
          },
            h("button", {
              style: {
                fontSize: 12, padding: "5px 14px", cursor: "pointer",
                marginBottom: -1, borderRadius: "6px 6px 0 0",
                border: "1px solid " + (tab === "detail" ? "rgba(128,128,128,.35)" : "transparent"),
                borderBottom: "none",
                background: tab === "detail" ? "rgba(128,128,128,.10)" : "transparent",
                fontWeight: tab === "detail" ? 700 : 400,
                color: tab === "detail" ? "#8ab4ff" : "inherit",
                opacity: tab === "detail" ? 1 : 0.7,
              },
              onClick: () => setTab("detail"),
            }, "📋 详情"),
            h("button", {
              style: {
                fontSize: 12, padding: "5px 14px", cursor: "pointer",
                marginBottom: -1, borderRadius: "6px 6px 0 0",
                border: "1px solid " + (tab === "activity" ? "rgba(128,128,128,.35)" : "transparent"),
                borderBottom: "none",
                background: tab === "activity" ? "rgba(128,128,128,.10)" : "transparent",
                fontWeight: tab === "activity" ? 700 : 400,
                color: tab === "activity" ? "#8ab4ff" : "inherit",
                opacity: tab === "activity" ? 1 : 0.7,
              },
              onClick: () => setTab("activity"),
            }, "🕘 近期动态"),
            // g-129: goal.md 链接放在 tab 行右侧
            d.goalFile
              ? h("div", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, marginBottom: 1 } },
                  h("span", { style: { fontSize: 11, opacity: 0.7 } }, "📄 goal.md"),
                  h("button", {
                    style: { ...S.btn, fontSize: 11, padding: "1px 6px" },
                    className: "dg-btn",
                    title: "用系统默认编辑器打开 goal.md",
                    onClick: async (e) => {
                      e.stopPropagation();
                      try {
                        const conn = connectionRt ?? appCtx?.get?.("connection");
                        if (conn?.api?.host?.openPath) {
                          const result = await conn.api.host.openPath({ path: d.goalFile });
                          if (result?.opened) { showToast("✅ 已打开 goal.md"); return; }
                        }
                        await copyText(d.goalFile);
                        showToast("✅ 路径已复制（打开不可用）");
                      } catch {
                        await copyText(d.goalFile);
                        showToast("✅ 路径已复制");
                      }
                    },
                  }, "打开"),
                  h("button", {
                    style: { ...S.btn, fontSize: 11, padding: "1px 6px" },
                    className: "dg-btn",
                    title: "复制 goal.md 路径",
                    onClick: async (e) => { e.stopPropagation(); const ok = await copyText(d.goalFile); if (ok) showToast("✅ 路径已复制"); },
                  }, "复制路径"))
              : null),
          // 面板容器：与页签一体（上边框由 tab 栏分隔线承接），包住当前 tab 内容
          h("div", {
            key: "panel",
            style: { border: "1px solid rgba(128,128,128,.35)", borderTop: "none",
                     borderRadius: "0 6px 6px 6px", padding: "10px 12px",
                     background: "rgba(128,128,128,.06)" },
          }, tab === "detail" ? detailTab : activityTab),
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

    // g-77647351：回退询问理由弹窗（后→前方向拖动时）
    // 判据 4：有子代理 → 作为子代理消息补充（send_message）；无子代理 → 补充给主管
    function BackwardReasonPrompt(props) {
      const { goalId, toStatus, hasChild, childId, parentId, onConfirm, onCancel } = props;
      const [reason, setReason] = React.useState("");
      const [sending, setSending] = React.useState(false);
      const [sent, setSent] = React.useState(false);
      // 如果有子代理，通过 session.prompt 发送理由
      const { session } = useBoundSession(parentId, childId);
      const sendReason = async () => {
        if (!reason.trim()) { onConfirm(""); return; }
        if (hasChild && session?.prompt) {
          setSending(true);
          try {
            await session.prompt(
              [{ type: "text", text: `【${goalId} 回退理由】${reason.trim()}` }], "queue");
            setSent(true);
            setTimeout(() => onConfirm(reason.trim()), 800);
          } catch {
            onConfirm(reason.trim());
          }
          setSending(false);
        } else {
          onConfirm(reason.trim());
        }
      };
      return h("div", { style: S.overlay, onClick: onCancel },
        h("div", { style: { ...S.modal, maxWidth: 480 }, onClick: (e) => e.stopPropagation() },
          h("span", { style: S.close, onClick: onCancel }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 14, marginBottom: 8 } },
            `⬅️ 回退到「${STATUS_LABEL[toStatus] ?? toStatus}」`),
          h("div", { style: { ...S.meta, marginBottom: 8 } },
            `目标 ${goalId} 将从当前状态回退到「${STATUS_LABEL[toStatus] ?? toStatus}」。`,
            h("br"),
            hasChild
              ? "理由将作为消息发送给执行子代理。"
              : "理由将作为补充信息记录（无执行子代理时供主管参考）。"),
          h("textarea", {
            style: { ...S.promptInput, width: "100%", minHeight: 80, resize: "vertical", marginTop: 4 },
            value: reason,
            placeholder: "请输入回退理由（可选）…",
            onChange: (e) => setReason(e.target.value),
          }),
          h("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
            h("button", {
              style: { ...S.btn, padding: "4px 14px", fontSize: 13 }, className: "dg-btn",
              disabled: sending, onClick: sendReason,
            }, sending ? "发送中…" : (sent ? "✅ 已发送" : "确认回退")),
            h("button", {
              style: { ...S.btn, padding: "4px 12px", fontSize: 12 }, className: "dg-btn",
              onClick: onCancel,
            }, "取消")),
        ),
      );
    }

    // g-77647351：进执行列确认弹窗
    // 无子代理 → force transition + start-execution 派新子代理
    // 有子代理 → force transition + 通过 session.prompt 给旧子代理排队重新执行（不派新）
    function InProgressPrompt(props) {
      const { goalId, goalData, supervisorSession, onConfirm, onCancel } = props;
      const [loading, setLoading] = React.useState(false);
      const [note, setNote] = React.useState(null);
      const hasChild = !!(goalData?.attempt_child_id);
      const hasCriteria = !!(goalData?.criteria_count);
      const oldChildId = goalData?.attempt_child_id ?? null;
      const oldParentId = goalData?.attempt_parent_session_id ?? null;

      // 有子代理时用 session.prompt 排队重新执行，无子代理时派新
      const { session: oldSession } = useBoundSession(oldParentId, oldChildId);

      const startExec = async () => {
        if (!supervisorSession) {
          setNote("⚠️ 该 workspace 未配置 supervisor.session（project.yaml）。请先在此 workspace 运行 graph_claim_supervisor() 完成主管会话接管，再执行。");
          return;
        }
        setLoading(true);
        try {
          // Step 1: force transition 到 in_progress（人工拖动视为授权）
          setNote("迁移中…");
          const tr = await fetch(graphUrl("/api/dsh-graph/transition"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: goalId, to: "in_progress", force: true }),
          });
          const trData = await tr.json();
          if (!trData.ok) {
            setNote("⚠️ 状态迁移失败：" + (trData.error || "未知错误"));
            setLoading(false);
            return;
          }

          if (hasChild && oldSession?.prompt) {
            // 有子代理 → 排队发"重新执行"消息，不派新子代理
            setNote("发送重新执行指令…");
            try {
              const res = await oldSession.prompt(
                [{ type: "text", text: `【重新执行】用户从看板拖放触发重新执行目标 ${goalId}。请从头开始执行目标描述和质量判据中的任务。` }],
                "queue",
              );
              if (res?.ok) {
                setNote("✅ 已向子代理排队发送重新执行指令");
                showToast("✅ 已向子代理发送重新执行指令");
              } else {
                setNote("⚠️ 发送失败：" + (res?.error?.message ?? "未知错误") + "。请打开子代理会话手动操作。");
              }
            } catch (e) {
              setNote("⚠️ 发送失败：" + String(e?.message ?? e) + "。请打开子代理会话手动操作。");
            }
            setTimeout(() => { onConfirm(); }, 1500);
          } else {
            // 无子代理 → 派发新执行子代理
            setNote("派发子代理…");
            const r = await fetch(graphUrl("/api/dsh-graph/start-execution"), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ goal: goalId }),
            });
            const data = await r.json();
            if (data.ok) {
              if (data.child_id) {
                setNote("✅ 已派发执行子代理，id：" + data.child_id);
                showToast("✅ 已派发执行子代理");
              } else if (data.child_error) {
                setNote("⚠️ 子代理启动失败：" + data.child_error);
              } else {
                setNote("⚠️ 子代理未启动（无 child_id）");
              }
              setTimeout(() => { onConfirm(); }, 1200);
            } else {
              setNote("⚠️ 执行失败：" + (data.error || "未知错误"));
            }
          }
        } catch (e) {
          setNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setLoading(false);
      };

      return h("div", { style: S.overlay, onClick: onCancel },
        h("div", { style: { ...S.modal, maxWidth: 480 }, onClick: (e) => e.stopPropagation() },
          h("span", { style: S.close, onClick: onCancel }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 14, marginBottom: 8 } },
            `🚀 执行「${goalData?.title ?? goalId}」`),
          h("div", { style: { ...S.meta, marginBottom: 8 } },
            hasChild
              ? "该目标已有执行子代理。将向其发送重新执行指令（排队），不另起新子代理。"
              : "将为目标创建执行子代理，状态迁移到「执行中」。"),
          // 有子代理时：提供链接让用户自己打开会话管理
          hasChild && oldChildId
            ? h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 } },
                h("span", { style: { fontSize: 12 } }, "🔗 子代理："),
                h("button", {
                  style: { ...S.btn, fontSize: 12, padding: "2px 8px" }, className: "dg-btn",
                  onClick: (e) => {
                    e.stopPropagation();
                    if (oldParentId) openChildSession(oldParentId, oldChildId);
                  },
                }, oldChildId.slice(0, 8) + "… ↗"))
            : null,
          !hasCriteria
            ? h("div", { style: { ...S.meta, color: "#e0a53a", marginBottom: 4 } },
                "⚠️ 质量判据尚未登记——将以授权模式强制迁移到执行列。")
            : null,
          h("div", { style: { display: "flex", gap: 8, marginTop: 4 } },
            h("button", {
              style: { ...S.btn, padding: "4px 14px", fontSize: 13 }, className: "dg-btn",
              disabled: loading, onClick: startExec,
            }, loading ? "处理中…" : (hasChild ? "🔄 重新执行" : "🚀 确认执行")),
            h("button", {
              style: { ...S.btn, padding: "4px 12px", fontSize: 12 }, className: "dg-btn",
              onClick: onCancel,
            }, "取消")),
          note ? h("div", { style: { ...S.meta, marginTop: 6 } }, note) : null,
        ),
      );
    }

    // g-77647351：交付确认弹窗——告知主管需做代码合并等交付工作，提供跳转主管会话按钮
    function DeliverPrompt(props) {
      const { goalId, goalTitle, supervisorSession, onConfirm, onCancel } = props;
      const promptText = `【交付通知】目标「${goalTitle ?? goalId}」（${goalId}）即将标记为已交付。请进行最终复核：代码合并、文档更新等交付工作。`;
      const jumpToSupervisor = async () => {
        try {
          const copied = await copyText(promptText);
          const rt = sessionsRt ?? appCtx?.get?.("sessions");
          if (rt && supervisorSession) {
            rt.open?.(supervisorSession);
            activateChatTab();
          }
          if (copied) {
            showToast("✅ 预填内容已复制，到主管对话窗 Ctrl+V 直接粘贴发送");
          }
        } catch { /* 静默 */ }
      };
      return h("div", { style: S.overlay, onClick: onCancel },
        h("div", { style: { ...S.modal, maxWidth: 520 }, onClick: (e) => e.stopPropagation() },
          h("span", { style: S.close, onClick: onCancel }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 14, marginBottom: 8 } },
            `📦 交付「${goalTitle ?? goalId}」`),
          h("div", { style: { ...S.meta, marginBottom: 8, lineHeight: 1.8 } },
            "交付前请确保以下工作已完成：", h("br"),
            "• 代码已合并到主分支", h("br"),
            "• 相关文档/配置已更新", h("br"),
            "• 已通知主管进行最终复核", h("br"),
            h("br"),
            h("span", { style: { color: "#e0a53a" } },
              "⚠️ 标记为「已交付」后需主管评审通过才能正式完成。")),
          h("div", { style: { display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" } },
            supervisorSession
              ? h("button", {
                  style: { ...S.btn, padding: "4px 14px", fontSize: 13 }, className: "dg-btn",
                  onClick: jumpToSupervisor,
                }, "↗ 告知主管")
              : null,
            h("button", {
              style: { ...S.btn, padding: "4px 14px", fontSize: 13 }, className: "dg-btn",
              onClick: () => onConfirm(),
            }, "📦 确认交付"),
            h("button", {
              style: { ...S.btn, padding: "4px 12px", fontSize: 12 }, className: "dg-btn",
              onClick: onCancel,
            }, "取消")),
        ),
      );
    }

    function KanbanView(props) {
      const [state, setState] = React.useState({ loading: true });
      const [modalGoal, setModalGoal] = React.useState(null);
      const [drawerCard, setDrawerCard] = React.useState(null); // {goalId, cardId}
      const [openReleased, setOpenReleased] = React.useState({});
      // g-125：delivered/blocked 卡片展开完整视图的开关（默认折叠精简）
      const [expandedGoals, setExpandedGoals] = React.useState({});
      // g-129: 新建目标弹窗状态
      const [showCreateGoal, setShowCreateGoal] = React.useState(false);
      const [newGoalTitle, setNewGoalTitle] = React.useState("");
      const [newGoalVersion, setNewGoalVersion] = React.useState("");
      const [newGoalDesc, setNewGoalDesc] = React.useState("");
      const [createNote, setCreateNote] = React.useState(null);
      const [creating, setCreating] = React.useState(false);
      // g-77647351：拖拽状态机
      const [drag, setDrag] = React.useState(null); // {goalId, fromStatus, overGoalId, overStageKey, overHalf, laneKey}
      const dropCommitted = React.useRef(false);
      const [orderMap, setOrderMap] = React.useState({}); // {laneKey: {stageKey: goalId[]}}
      const [transitionNote, setTransitionNote] = React.useState(null);

      // g-77647351：document 级兜底（拖到列表外不显示 rejected）
      React.useEffect(() => {
        if (!drag) return;
        const acceptDrag = (e) => {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        };
        const acceptDrop = (e) => { e.preventDefault(); };
        document.addEventListener("dragover", acceptDrag);
        document.addEventListener("drop", acceptDrop);
        return () => {
          document.removeEventListener("dragover", acceptDrag);
          document.removeEventListener("drop", acceptDrop);
        };
      }, [drag !== null]);

      // g-77647351：加载排序
      const loadOrder = () => {
        fetch(graphUrl("/api/dsh-graph/order"))
          .then((r) => r.json())
          .then((data) => setOrderMap(data))
          .catch(() => {});
      };
      const saveOrder = (newOrder) => {
        setOrderMap(newOrder);
        fetch(graphUrl("/api/dsh-graph/order"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(newOrder),
        }).catch(() => {});
      };

      // g-77647351：对账排序（reconciledSessionOrder 模式）
      function reconciledGoalOrder(goalIds, stored) {
        if (!stored || !stored.length) return [...goalIds];
        const byId = new Map(goalIds.map((id) => [id, id]));
        const ordered = [];
        const included = new Set();
        for (const key of stored) {
          const id = byId.get(key);
          if (id === undefined || included.has(key)) continue;
          ordered.push(id);
          included.add(key);
        }
        for (const id of goalIds) {
          if (included.has(id)) continue;
          ordered.push(id);
        }
        return ordered;
      }

      // g-77647351：跨列拖动提交（transition API 调用）
      async function commitCrossColumnDrag(goalId, toStatus, reason) {
        try {
          const body = { goal: goalId, to: toStatus };
          if (reason) body.reason = reason;
          const r = await fetch(graphUrl("/api/dsh-graph/transition"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            showToast(`✅ ${goalId} → ${STATUS_LABEL[toStatus] ?? toStatus}`);
            load(); // 刷新看板
          } else {
            showToast("⚠️ 迁移失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          showToast("⚠️ 请求失败：" + String(e?.message ?? e));
        }
      }

      // g-77647351：回退询问理由弹窗状态
      const [backwardPrompt, setBackwardPrompt] = React.useState(null); // {goalId, toStatus, hasChild, childId, parentId}
      // g-77647351：进执行列确认弹窗状态（复用执行按钮逻辑，替代服务端报错）
      const [inProgressPrompt, setInProgressPrompt] = React.useState(null); // {goalId}
      // g-77647351：交付确认弹窗状态
      const [deliverPrompt, setDeliverPrompt] = React.useState(null); // {goalId, goalTitle, toStatus}

      // g-77647351：同列重排提交（照抄 commitSessionDrag）
      function commitSameColumnDrag(activeDrag, over) {
        if (dropCommitted.current) return;
        dropCommitted.current = true;
        setDrag(null);
        const { goalId, laneKey, overGoalId, overHalf } = activeDrag;
        const stageKey = STAGES.find((s) => s.statuses.includes(activeDrag.fromStatus))?.key;
        if (!stageKey) return;
        const currentOrderKey = `${laneKey}|${stageKey}`;
        const stored = orderMap[currentOrderKey] ?? [];
        const laneGoals = allGoals.filter((g) => {
          const gStage = stageOf(g.status);
          if (gStage !== stageKey) return false;
          // 同一泳道
          const gLane = goalLane(g);
          return gLane === laneKey;
        });
        const goalIds = laneGoals.map((g) => g.id);
        const reconciled = reconciledGoalOrder(goalIds, stored);
        // 计算新位置
        const filtered = reconciled.filter((id) => id !== goalId);
        const anchorIdx = overHalf === "before" ? filtered.indexOf(overGoalId) : filtered.indexOf(overGoalId) + 1;
        if (anchorIdx < 0) return;
        filtered.splice(anchorIdx, 0, goalId);
        // 检查是否真的变了
        if (filtered.join(",") === reconciled.join(",")) return;
        const newOrder = { ...orderMap, [currentOrderKey]: filtered };
        saveOrder(newOrder);
      }

      // g-77647351：跨 lane 拖放提交（moveGoal 归属变更，状态保持）
      function commitCrossLaneMove(goalId, targetLaneKey) {
        let to, version;
        if (targetLaneKey === "standalone") {
          to = "standalone";
        } else if (targetLaneKey === "backlog") {
          to = "backlog";
        } else if (targetLaneKey.startsWith("v-")) {
          to = "version";
          version = targetLaneKey.slice(2);
        } else {
          showToast("⚠️ 未知目标泳道：" + targetLaneKey);
          return;
        }
        const body = { goal: goalId, to };
        if (version) body.version = version;
        fetch(graphUrl("/api/dsh-graph/move-goal"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
          .then((r) => r.json())
          .then((data) => {
            if (data.ok) {
              showToast(`✅ ${goalId} 已移动到 ${targetLaneKey}`);
              load();
            } else {
              const err = data.error || "未知错误";
              if (err.includes("不能移回 backlog 平铺")) {
                showToast("⚠️ 目标有附件（cards/attempts），不能移回 backlog。可移到独立目标或版本中。");
              } else {
                showToast("⚠️ 移动失败：" + err);
              }
            }
          })
          .catch((e) => showToast("⚠️ 请求失败：" + String(e?.message ?? e)));
      }

      // g-77647351：提交拖放（入口）
      function commitGoalDrag(activeDrag, over) {
        if (dropCommitted.current) return;
        dropCommitted.current = true;
        setDrag(null);
        const { goalId, fromStatus, overGoalId, overStageKey, overHalf, laneKey } = activeDrag;
        const overLaneKey = activeDrag.overLaneKey ?? laneKey;
        const fromStage = stageOf(fromStatus);
        // 跨 lane 拖放 → moveGoal 归属变更（状态保持，不涉及 transition）
        if (overLaneKey !== laneKey) {
          // g-137：backlog 卡拖入版本 lane 的落点限定
          // 从 backlog 拖到版本 lane 时，只能落到「描述」列（overStageKey === "describe"）
          if (laneKey === "backlog" && overLaneKey.startsWith("v-") && overStageKey !== "describe") {
            showToast("⚠️ backlog 卡片只能拖到版本的「描述」列，不能直接到收集/执行/确认/交付/阻塞列");
            return;
          }
          commitCrossLaneMove(goalId, overLaneKey);
          return;
        }
        if (fromStage === overStageKey) {
          // 同列重排
          if (overGoalId) {
            const currentOrderKey = `${laneKey}|${fromStage}`;
            const stored = orderMap[currentOrderKey] ?? [];
            const laneGoals = allGoals.filter((g) => stageOf(g.status) === fromStage && goalLane(g) === laneKey);
            const goalIds = laneGoals.map((g) => g.id);
            const reconciled = reconciledGoalOrder(goalIds, stored);
            const filtered = reconciled.filter((id) => id !== goalId);
            const anchorIdx = overHalf === "before" ? filtered.indexOf(overGoalId) : filtered.indexOf(overGoalId) + 1;
            if (anchorIdx >= 0) {
              filtered.splice(anchorIdx, 0, goalId);
              if (filtered.join(",") !== reconciled.join(",")) {
                saveOrder({ ...orderMap, [`${laneKey}|${fromStage}`]: filtered });
              }
            }
          }
          return;
        }
        // 跨列 → transition
        // 判据 3：planning→collect 二义默认 collecting
        let toStatus = resolveTargetStatus(fromStatus, overStageKey);
        if (!toStatus) {
          // blocked 只能回 blocked_from，前端无法预判，提示用户
          showToast("⚠️ blocked 状态只能解除回原状态（由服务端校验）");
          return;
        }
        // 判据 3：delivered 终态 → 弹窗告知主管需做交付工作
        if (overStageKey === "deliver") {
          const goalData = allGoals.find((g) => g.id === goalId);
          setDeliverPrompt({ goalId, goalTitle: goalData?.title ?? goalId, toStatus });
          return;
        }
        // 判据 4：回退方向询问理由
        if (isBackward(fromStatus, toStatus)) {
          // 查找该目标的执行子代理信息
          const goalData = allGoals.find((g) => g.id === goalId);
          const hasChild = !!(goalData?.attempt_child_id);
          setBackwardPrompt({
            goalId,
            toStatus,
            hasChild,
            childId: goalData?.attempt_child_id ?? null,
            parentId: goalData?.attempt_parent_session_id ?? null,
          });
          return;
        }
        // 判据 3+4：进执行列 → 弹窗确认（复用执行按钮逻辑，替代服务端报错兜底）
        if (overStageKey === "execute") {
          setInProgressPrompt({ goalId });
          return;
        }
        if (toStatus === "blocked") {
          const reason = prompt("请输入阻塞原因：");
          if (!reason || !reason.trim()) return;
          commitCrossColumnDrag(goalId, toStatus, reason.trim());
          return;
        }
        commitCrossColumnDrag(goalId, toStatus);
      }

      // g-77647351：辅助——确定目标属于哪个泳道
      function goalLane(g) {
        for (const v of active) if (v.goals.some((vg) => vg.id === g.id)) return "v-" + v.slug;
        if (b.standalone.some((sg) => sg.id === g.id)) return "standalone";
        if (b.backlog.some((bg) => bg.id === g.id)) return "backlog";
        return "backlog";
      }

      // g-113 定点 bug：从 slot props 取「被查看会话」id（conversation.view 渲染回调注入的
      // session 作用域字段，字段名 props.sessionId——renderer 的 standardProps 里
      // standard["sessionId"] = info.sessionId）。必须先于 load effect 声明，挂载即生效。
      React.useEffect(() => {
        viewedSessionId = props?.sessionId ?? null;
        return () => { viewedSessionId = null; };
      }, [props?.sessionId]);
      const load = () => {
        fetch(graphUrl("/api/dsh-graph"))
          .then((r) => r.json())
          .then((data) => { setState({ loading: false, data }); loadOrder(); })
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
      // g-a92e1406：被复用徽章派生已移交 boardProjection（attempt.reused 事件 + 绑定记录双源），
      // 客户端直接消费 g.reused_by，不再用数组顺序猜测旧/新绑定。
      const allGoals = [
        ...active.flatMap((v) => v.goals),
        ...released.flatMap((v) => v.goals),
        ...b.standalone,
        ...b.backlog,
      ];
      // g-129: 打开新建目标弹窗，预选版本
      const openCreateGoal = (version) => {
        setNewGoalVersion(version || "");
        setShowCreateGoal(true);
        setCreateNote(null);
      };
      // g-77647351：泳道渲染（带拖放支持，跨 lane 拖放改归属）；g-129 版本 lane 标题「＋」预选版本
      // g-137：laneIndex 用于交替背景色
      const lane = (label, goals, key, version, laneIndex = 0) => {
        const cells = STAGES.map((s) => {
          const cellGoals = goals.filter((g) => stageOf(g.status) === s.key);
          // 排序对账
          const orderKey = `${key}|${s.key}`;
          const stored = orderMap[orderKey] ?? [];
          const goalIds = cellGoals.map((g) => g.id);
          const reconciled = reconciledGoalOrder(goalIds, stored);
          const orderedGoals = reconciled.map((id) => cellGoals.find((g) => g.id === id)).filter(Boolean);
          // g-77647351：anyDrag = 有拖动进行中（不限同 lane，允许跨 lane 拖放）
          const anyDrag = drag !== null;
          // g-137：backlog 卡拖到版本 lane 时，无论悬停在哪一列，都高亮「描述」列
          const isFromBacklog = anyDrag && drag.laneKey === "backlog";
          const isOverThisLane = anyDrag && drag.overLaneKey === key;
          const isOverThisCell = anyDrag && (
            (isFromBacklog && isOverThisLane && s.key === "describe") || // backlog→版本：只高亮描述列
            (!isFromBacklog && drag.overStageKey === s.key && drag.overLaneKey === key) // 其他情况：正常高亮
          );
          // g-137：交替背景色
          const laneBg = laneIndex % 2 === 0 ? "rgba(255,255,255,.03)" : "rgba(0,0,0,.08)";
          return h("div", {
            key: s.key,
            style: { ...S.cell, background: isOverThisCell ? "rgba(76,141,255,.10)" : laneBg },
            className: isOverThisCell && !orderedGoals.some((g) => g.id === drag.goalId) ? "dg-cell-drop-active" : "",
            onDragOver: anyDrag ? (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              // 列空白区域：设 overStageKey + overLaneKey 但无 overGoalId
              if (!orderedGoals.length) {
                // g-137：backlog 卡拖到版本 lane 时，overStageKey 固定为 "describe"
                const effectiveStageKey = (isFromBacklog && isOverThisLane) ? "describe" : s.key;
                setDrag((d) => d ? { ...d, overGoalId: null, overStageKey: effectiveStageKey, overLaneKey: key, overHalf: "after" } : d);
              }
            } : undefined,
            onDrop: anyDrag ? (e) => {
              e.preventDefault();
              if (!orderedGoals.length) {
                commitGoalDrag({ ...drag, overGoalId: null, overStageKey: s.key, overLaneKey: key, overHalf: "after" }, null);
              }
            } : undefined,
          },
            orderedGoals.map((g) => {
              const defExpanded = g.status !== "delivered" && g.status !== "blocked";
              const expanded = expandedGoals[g.id] ?? defExpanded;
              const isDragTarget = isOverThisCell && drag.overGoalId === g.id;
              return Card(g, setModalGoal, (goalId, cardId) => setDrawerCard({ goalId, cardId }),
                modalGoal === g.id, drawerCard?.cardId, goalStatus,
                expanded,
                (id) => setExpandedGoals((p) => ({ ...p, [id]: !expanded })),
                // g-77647351：drag props（active 仍限同 lane 卡片，marker/over 不限）
                {
                  active: drag && drag.goalId === g.id,
                  marker: isDragTarget ? drag.overHalf : null,
                  start: () => {
                    dropCommitted.current = false;
                    setDrag({
                      goalId: g.id,
                      fromStatus: g.status,
                      overGoalId: null,
                      overStageKey: s.key,
                      overLaneKey: key,
                      overHalf: null,
                      laneKey: key,
                    });
                  },
                  over: isDragTarget ? { id: g.id, half: drag.overHalf } : null,
                  hover: (half) => {
                    // g-137：backlog 卡拖到版本 lane 时，overStageKey 固定为 "describe"
                    const effectiveStageKey = (isFromBacklog && isOverThisLane) ? "describe" : s.key;
                    setDrag((d) => d ? { ...d, overGoalId: g.id, overStageKey: effectiveStageKey, overLaneKey: key, overHalf: half } : d);
                  },
                  drop: (half) => {
                    if (!drag) return;
                    // g-137：backlog 卡拖到版本 lane 时，overStageKey 固定为 "describe"
                    const effectiveStageKey = (isFromBacklog && isOverThisLane) ? "describe" : s.key;
                    commitGoalDrag({ ...drag, overGoalId: g.id, overStageKey: effectiveStageKey, overLaneKey: key, overHalf: half }, { id: g.id, half });
                  },
                  end: () => {
                    if (drag?.overGoalId) {
                      commitGoalDrag(drag, { id: drag.overGoalId, half: drag.overHalf });
                    } else {
                      setDrag(null);
                    }
                    dropCommitted.current = false;
                  },
                },
              );
            }),
          );
        });
        // g-137：labelEl 交替背景色
        const labelBg = laneIndex % 2 === 0 ? "rgba(255,255,255,.03)" : "rgba(0,0,0,.08)";
        const labelEl = h("div", { key: key + "-label", style: { ...S.laneLabel, position: "relative", background: labelBg } },
          label,
          // g-129: 每个 lane 标题右下角加「+」按钮（版本 lane 预选版本，独立/backlog 进 backlog）
          h("button", {
            style: { ...S.btn, position: "absolute", right: 4, bottom: 2, fontSize: 11, padding: "0 5px", lineHeight: 1.4 },
            className: "dg-btn",
            title: version ? `在 ${version} 新建目标` : "新建目标（backlog）",
            onClick: () => openCreateGoal(version),
          }, "＋"));
        return [labelEl, ...cells];
      };

      // g-137：backlog 行平铺展示函数
      const backlogRow = (label, goals, key) => {
        const isOverThisCell = drag && drag.overLaneKey === key;
        const labelEl = h("div", { key: key + "-label", style: { ...S.laneLabel, position: "relative", background: "rgba(0,0,0,.12)" } },
          label,
          h("button", {
            style: { ...S.btn, position: "absolute", right: 4, bottom: 2, fontSize: 11, padding: "0 5px", lineHeight: 1.4 },
            className: "dg-btn",
            title: "新建目标（backlog）",
            onClick: () => openCreateGoal(null),
          }, "＋"));
        // g-137 修复：backlog 平铺也按 order.json 对账排序（否则拖放重排保存了却不生效）
        const backStored = orderMap[`${key}|describe`] ?? [];
        const orderedGoals = reconciledGoalOrder(goals.map((g) => g.id), backStored)
          .map((id) => goals.find((g) => g.id === id))
          .filter(Boolean);
        const flatCell = h("div", {
          key: key + "-flat",
          style: { gridColumn: "2 / -1", minHeight: 40, borderTop: "1px solid rgba(128,128,128,.35)" },
          className: "dg-backlog-lane" + (isOverThisCell ? " dg-cell-drop-active" : ""),
          onDragOver: drag ? (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (!goals.length) {
              setDrag((d) => d ? { ...d, overGoalId: null, overStageKey: "describe", overLaneKey: key, overHalf: "after" } : d);
            }
          } : undefined,
          onDrop: drag ? (e) => {
            e.preventDefault();
            if (!goals.length) {
              commitGoalDrag({ ...drag, overGoalId: null, overStageKey: "describe", overLaneKey: key, overHalf: "after" }, null);
            }
          } : undefined,
        },
          h("div", { className: "dg-backlog-flat" },
            orderedGoals.map((g) => {
              const defExpanded = g.status !== "delivered" && g.status !== "blocked";
              const expanded = expandedGoals[g.id] ?? defExpanded;
              const isDragTarget = isOverThisCell && drag?.overGoalId === g.id;
              return Card(g, setModalGoal, (goalId, cardId) => setDrawerCard({ goalId, cardId }),
                modalGoal === g.id, drawerCard?.cardId, goalStatus,
                expanded,
                (id) => setExpandedGoals((p) => ({ ...p, [id]: !expanded })),
                {
                  active: drag && drag.goalId === g.id,
                  marker: isDragTarget ? drag.overHalf : null,
                  start: () => {
                    dropCommitted.current = false;
                    setDrag({
                      goalId: g.id,
                      fromStatus: g.status,
                      overGoalId: null,
                      overStageKey: "describe",
                      overLaneKey: key,
                      overHalf: null,
                      laneKey: key,
                    });
                  },
                  over: isDragTarget ? { id: g.id, half: drag.overHalf } : null,
                  hover: (half) => {
                    setDrag((d) => d ? { ...d, overGoalId: g.id, overStageKey: "describe", overLaneKey: key, overHalf: half } : d);
                  },
                  drop: (half) => {
                    if (!drag) return;
                    commitGoalDrag({ ...drag, overGoalId: g.id, overStageKey: "describe", overLaneKey: key, overHalf: half }, { id: g.id, half });
                  },
                  end: () => {
                    if (drag?.overGoalId) {
                      commitGoalDrag(drag, { id: drag.overGoalId, half: drag.overHalf });
                    } else {
                      setDrag(null);
                    }
                    dropCommitted.current = false;
                  },
                },
              );
            }),
          ),
        );
        return [labelEl, flatCell];
      };

      const rows = [];
      let laneIndex = 0;
      for (const v of active) {
        rows.push(...lane(`🏷 ${v.name}`, v.goals, "v-" + v.slug, v.slug, laneIndex));
        laneIndex++;
      }
      rows.push(...lane("独立目标", b.standalone, "standalone", null, laneIndex));
      laneIndex++;
      rows.push(...backlogRow("backlog", b.backlog, "backlog"));

      const releasedRows = released.map((v, idx) => {
        const open = !!openReleased[v.slug];
        return [
          h("div", {
            key: "rel-" + v.slug, style: S.collapsed, className: "dg-collapsed", title: "点击展开/收起",
            onClick: () => setOpenReleased({ ...openReleased, [v.slug]: !open }),
          }, `${open ? "▾" : "▸"} ${v.name} ✅ ${v.goals.length} 目标全部交付 · released · ${v.slug}`),
          open ? h("div", { key: "relx-" + v.slug, style: S.grid },
            ...lane(v.name, v.goals, "rellane-" + v.slug, null, laneIndex + idx)) : null,
        ];
      });

      const createGoal = async () => {
        const t = newGoalTitle.trim();
        if (!t) { setCreateNote("⚠️ 请输入目标标题"); return; }
        setCreating(true);
        setCreateNote("创建中…");
        try {
          const body = { title: t };
          if (newGoalVersion.trim()) body.version = newGoalVersion.trim();
          if (newGoalDesc.trim()) body.description = newGoalDesc.trim();
          const r = await fetch(graphUrl("/api/dsh-graph/create-goal"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json();
          if (data.ok) {
            setCreateNote("✅ 已创建目标：" + data.goal);
            setNewGoalTitle("");
            setNewGoalVersion("");
            setNewGoalScope("");
            load(); // 刷新看板
            setTimeout(() => setShowCreateGoal(false), 1500);
          } else {
            setCreateNote("⚠️ 创建失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setCreateNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setCreating(false);
      };

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
          h("button", { style: { ...S.btn, marginLeft: 8 }, className: "dg-btn", onClick: load }, "刷新"),
          // g-113 临时诊断（灰色低调显示，负责人 2026-08-22 保留）：显示当前解析的 workspace 与会话 id
          h("span", { style: { ...S.meta, color: "rgba(128,128,128,.55)", marginLeft: 8, fontSize: 11 } },
            "DEBUG sessionId=" + (props?.sessionId ?? "∅") + " ws=" + (currentWorkspace() ?? "∅"))),
        // g-108：顶部 supervisor 状态栏（id 由 board 端点下发，未配置则不显示）；
        // g-a92e1406：statusLine 传 supervisor 自己的 status_line（board 下发 supervisorStatus）
        b.supervisorSession
          ? h(SupervisorBar, { id: b.supervisorSession, statusLine: b.supervisorStatus ?? null, statusAt: b.supervisorStatusAt ?? null })
          : null,
        h("div", { style: S.grid },
          h("div", { style: S.stageHead }, "泳道＼阶段"),
          STAGES.map((s) => h("div", { key: s.key, style: S.stageHead }, s.label)),
          ...rows),
        ...releasedRows,
        modalGoal
          ? h(GoalModal, { id: modalGoal, title: modalGoalData?.title, onClose: () => setModalGoal(null), goalStatus, supervisorSession: b.supervisorSession ?? null })
          : null,
        drawerCard
          ? h(CardDrawer, { goalId: drawerCard.goalId, cardId: drawerCard.cardId,
                            onClose: () => setDrawerCard(null) })
          : null,
        // g-129: 新建目标弹窗
        showCreateGoal
          ? h("div", { style: S.overlay, onClick: () => setShowCreateGoal(false) },
              h("div", { style: S.modal, onClick: (e) => e.stopPropagation() },
                h("span", { style: S.close, onClick: () => setShowCreateGoal(false) }, "✕"),
                h("div", { style: { fontWeight: 700, fontSize: 15, marginBottom: 12 } }, "＋ 新建目标"),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, "标题 *"),
                  h("input", {
                    style: { ...S.promptInput, width: "100%" },
                    value: newGoalTitle,
                    placeholder: "输入目标标题…",
                    onChange: (e) => setNewGoalTitle(e.target.value),
                    onKeyDown: (e) => { if (e.key === "Enter") createGoal(); },
                  })),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, "正文（可选）"),
                  h("textarea", {
                    style: { ...S.promptInput, width: "100%", minHeight: 64, resize: "vertical" },
                    value: newGoalDesc,
                    placeholder: "目标描述（可选）…",
                    onChange: (e) => setNewGoalDesc(e.target.value),
                  })),
                h("div", { style: { marginBottom: 8 } },
                  h("label", { style: { display: "block", marginBottom: 4, fontWeight: 600 } }, "版本（可选）"),
                  h("select", {
                    style: { ...S.promptInput, width: "100%" },
                    value: newGoalVersion,
                    onChange: (e) => setNewGoalVersion(e.target.value),
                  },
                    h("option", { value: "" }, "backlog（默认）"),
                    // 版本选项来自 board 数据的 versions 列表
                    ...b.versions.map((v) => h("option", { key: v.slug, value: v.slug }, v.slug)))),
                h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
                  h("button", {
                    style: { ...S.btn, padding: "6px 16px", fontSize: 13 },
                    className: "dg-btn",
                    disabled: creating,
                    onClick: createGoal,
                  }, creating ? "创建中…" : "创建"),
                  h("button", {
                    style: { ...S.btn, padding: "6px 12px", fontSize: 12 },
                    className: "dg-btn",
                    onClick: () => setShowCreateGoal(false),
                  }, "取消")),
                createNote ? h("div", { style: { ...S.meta, marginTop: 8 } }, createNote) : null))
          : null,
        // g-77647351：回退询问理由弹窗
        backwardPrompt
          ? h(BackwardReasonPrompt, {
              key: "backward-prompt",
              goalId: backwardPrompt.goalId,
              toStatus: backwardPrompt.toStatus,
              hasChild: backwardPrompt.hasChild,
              childId: backwardPrompt.childId,
              parentId: backwardPrompt.parentId,
              onConfirm: (reason) => {
                commitCrossColumnDrag(backwardPrompt.goalId, backwardPrompt.toStatus, reason || undefined);
                setBackwardPrompt(null);
              },
              onCancel: () => setBackwardPrompt(null),
            })
          : null,
        // g-77647351：进执行列确认弹窗
        inProgressPrompt
          ? h(InProgressPrompt, {
              key: "in-progress-prompt",
              goalId: inProgressPrompt.goalId,
              goalData: allGoals.find((g) => g.id === inProgressPrompt.goalId) ?? null,
              supervisorSession: b.supervisorSession ?? null,
              onConfirm: () => { setInProgressPrompt(null); load(); },
              onCancel: () => setInProgressPrompt(null),
            })
          : null,
        // g-77647351：交付确认弹窗
        deliverPrompt
          ? h(DeliverPrompt, {
              key: "deliver-prompt",
              goalId: deliverPrompt.goalId,
              goalTitle: deliverPrompt.goalTitle,
              supervisorSession: b.supervisorSession ?? null,
              onConfirm: () => {
                setDeliverPrompt(null);
                commitCrossColumnDrag(deliverPrompt.goalId, deliverPrompt.toStatus);
              },
              onCancel: () => setDeliverPrompt(null),
            })
          : null,
      );
    }

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
    return {
      name: "dsh-graph",
      inject: ["slots", "sessions", "connection"],
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
        console.log("[dsh-graph-host] client apply: kanban view registered");
      },
    };
  },
});
