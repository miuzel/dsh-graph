      wrap: { padding: 12, fontSize: 13, color: "inherit", overflowX: "auto" },
      head: { display: "flex", alignItems: "center", gap: 12, marginBottom: 8 },
      grid: { display: "grid", gridTemplateColumns: "130px repeat(6, minmax(150px, 1fr))", gap: 4 },
      laneLabel: { fontWeight: 600, padding: "8px 6px", borderTop: "1px solid rgba(128,128,128,.35)" },
      stageHead: { fontWeight: 600, textAlign: "center", padding: 4, opacity: 0.75, whiteSpace: "nowrap" },
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
        position: "fixed", inset: 0, background: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,.55))",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999,
      },
      drawer: {
        position: "fixed", top: 0, right: 0, height: "100vh", width: 400,
        background: "var(--dsw-alias-bg-layer-1, #1e1f24)", color: "var(--dsw-alias-label-primary, #e6e6e6)", zIndex: 10000,
        boxShadow: "-4px 0 16px rgba(0,0,0,.45)",
        padding: "20px 22px", overflowY: "auto", fontSize: 13, lineHeight: 1.7,
        fontFamily: "inherit",
      },
      drawerSection: { marginTop: 14 },
      drawerH: { fontWeight: 700, fontSize: 13, marginBottom: 6, opacity: 0.9 },
      modal: {
        background: "var(--dsw-alias-bg-layer-1, #1e1f24)", color: "var(--dsw-alias-label-primary, #e6e6e6)", borderRadius: 10,
        maxWidth: 720, width: "90%", maxHeight: "80vh", overflowY: "auto",
        padding: "16px 20px", fontSize: 13, lineHeight: 1.6,
      },
      modalSection: { marginTop: 10, whiteSpace: "pre-wrap" },
      modalH: { fontWeight: 700, marginBottom: 4 },
      // g-153：共享按钮样式 token——暗色主题下确保可读性与层级；g-176：改 DSH 主题变量并保留暗色 fallback
      btn: {
        fontSize: 12, padding: "2px 10px", cursor: "pointer",
        background: "var(--dsw-alias-interactive-bg-hover-solid, rgba(128,128,128,.15))",
        color: "var(--dsw-alias-label-primary, #e6e6e6)",
        border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.30))", borderRadius: 4,
      },
      // g-153：主要操作按钮（蓝底高亮）
      btnPrimary: {
        fontSize: 12, padding: "2px 10px", cursor: "pointer",
        background: "var(--dsw-alias-state-business-tertiary, rgba(76,141,255,.18))",
        color: "var(--dsw-alias-state-business-primary, #8ab4ff)",
        border: "1px solid var(--dsw-alias-state-business-primary, rgba(76,141,255,.40))", borderRadius: 4,
      },
      // g-153：危险操作按钮（红底红字）
      btnDanger: {
        fontSize: 12, padding: "2px 10px", cursor: "pointer",
        background: "rgba(214,102,102,.18)", color: "var(--dsw-alias-state-error-primary, #f08080)",
        border: "1px solid rgba(214,102,102,.35)", borderRadius: 4,
      },
      // g-153：接受/确认操作按钮（绿底绿字）
      btnAccept: {
        fontSize: 12, padding: "2px 10px", cursor: "pointer",
        background: "rgba(58,166,117,.18)", color: "var(--dsw-alias-state-success-primary, #6ee7a0)",
        border: "1px solid rgba(58,166,117,.40)", borderRadius: 4,
      },
      // g-153：下拉菜单/选择控件样式 token
      select: {
        fontSize: 12, padding: "3px 8px", cursor: "pointer",
        background: "var(--dsw-alias-bg-layer-2, rgba(30,31,36,.92))",
        color: "var(--dsw-alias-label-primary, #e6e6e6)",
        border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))", borderRadius: 4,
      },
      selectOption: { background: "var(--dsw-alias-bg-layer-3, #222328)", color: "var(--dsw-alias-label-primary, #e6e6e6)" },
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
        background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,.25))", color: "inherit",
        border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))", borderRadius: 4,
      },
      // g-108 看板顶部 supervisor 状态栏
      supervisorBar: {
        display: "flex", alignItems: "center", gap: 10, marginBottom: 8,
        padding: "4px 10px", border: "1px solid rgba(58,166,117,.45)",
        borderRadius: 6, background: "var(--dsw-alias-bg-module-platform, rgba(30,31,36,.92))", fontSize: 12,
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
