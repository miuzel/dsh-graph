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

    // g-158：目标类型视觉配置——颜色、缩写、完整名（四者共用同一语义色）
    const GOAL_TYPES = ["feature", "bug", "task", "improvement"];
    const GOAL_TYPE_COLORS = { feature: "#4c8dff", bug: "#d66", task: "#8a8a8a", improvement: "#3aa675" };
    const GOAL_TYPE_ABBREV = { feature: "F", bug: "B", task: "T", improvement: "I" };
    const GOAL_TYPE_LABELS = { feature: "feature", bug: "bug", task: "task", improvement: "improvement" };
    // g-158：规范化类型——非法值安全回退 task
    function normalizeGoalType(raw) {
      return GOAL_TYPES.includes(raw) ? raw : "task";
    }
    // g-158：获取类型色——回退 task 色
    function goalTypeColor(type) {
      return GOAL_TYPE_COLORS[normalizeGoalType(type)] ?? GOAL_TYPE_COLORS.task;
    }

    const EVENT_LABEL = {
      "goal.created": "创建目标", "goal.planned": "完成规划", "criteria.confirmed": "确认判据",
      "goal.transition": null, "attempt.started": "派发执行", "attempt.status_reported": null,
      "completion.claimed": "声明完成", "review.passed": "评审通过", "review.failed": "评审未通过",
      "goal.moved": "排期移动", "card.created": "创建卡片", "card.filled": "填充卡片",
      "card.reviewed": "复核卡片", "evidence.added": "登记证据", "memory.promoted": "沉淀记忆",
      "version.created": "创建版本", "version.released": "发布版本",
      "version.status_changed": "版本状态变更", "version.scope_changed": "调整版本范围", "version.integration_decided": "集成测试决策",
      "goal.deleted": "删除目标", "card.deleted": "删除卡片", "attempt.bound": "绑定子代理",
      "goal.renamed": "重命名目标",
      "goal.type_changed": "变更类型", // g-158
      "goal.directive_set": "设置最近指令", "goal.comment_added": "添加评论",
      "attempt.handoff.confirmed": "确认返工 handoff", "attempt.handoff.superseded": "覆盖旧 handoff",
    };

    // 近期动态只保留对人有用的事件：泳道切换、修订与人工补充、判据/评审/交付关键节点
    // g-a92e1406：补 attempt.status_reported（状态汇报履历）
    const MEANINGFUL = new Set([
      "goal.transition", "goal.amended", "scope.note", "criteria.confirmed",
      "completion.claimed", "review.passed", "review.failed", "attempt.started",
      "goal.moved", "goal.created", "attempt.status_reported", "goal.renamed",
      "goal.type_changed", // g-158
      "goal.directive_set", "goal.comment_added",
      "attempt.handoff.confirmed", "attempt.handoff.superseded",
    ]);

    // 拆出事件三要素（时间/事件/执行者），供表格列渲染与 humanEvent 复用
    function eventParts(e) {
      const d = e.details ?? {};
      let what = EVENT_LABEL[e.event];
      if (what === null || what === undefined) {
        if (e.event === "goal.transition") what = `状态流转：${STATUS_LABEL[d.from] ?? d.from} → ${STATUS_LABEL[d.to] ?? d.to}`;
        else if (e.event === "attempt.status_reported") what = `汇报：${d.status ?? ""}`;
        else if (e.event === "goal.amended") what = `修订：${d.note ?? ""}`;
        else if (e.event === "goal.renamed") what = `重命名：${d.old_title ?? ""} → ${d.new_title ?? ""}`;
        else if (e.event === "goal.type_changed") what = `变更类型：${GOAL_TYPE_LABELS[d.old_type] ?? d.old_type} → ${GOAL_TYPE_LABELS[d.new_type] ?? d.new_type}`; // g-158
        else if (e.event === "scope.note") what = `补充：${d.note ?? ""}`;
        else if (e.event === "goal.directive_set") what = `设置指令：${(d.directive ?? "").slice(0, 80)}${(d.directive ?? "").length > 80 ? "…" : ""}`;
        else if (e.event === "goal.comment_added") what = `评论：${(d.text ?? "").slice(0, 60)}${(d.text ?? "").length > 60 ? "…" : ""}`;
        else if (e.event === "attempt.handoff.confirmed") what = `确认 handoff：${d.handoff ?? ""}`;
        else if (e.event === "attempt.handoff.superseded") what = `覆盖 handoff：${d.old_handoff ?? ""} → ${d.new_handoff ?? ""}`;
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
      .dg-deliver-collapsed:hover { background: rgba(128,128,128,.14); }
      .dg-blocked-collapsed:hover { background: rgba(128,128,128,.14); }
      .dg-btn { transition: background .12s ease, border-color .12s ease, filter .12s ease; }
      .dg-btn:hover { filter: brightness(1.20); background: rgba(128,128,128,.25); }
      .dg-btn:active { filter: brightness(0.95); }
      .dg-btn:disabled { opacity: 0.45; cursor: default; filter: none; }
      /* g-162：普通泳道内容底部居中的扁平折叠入口；released 不使用此控件 */
      .dg-lane-collapse {
        position: absolute; left: 50%; right: auto; bottom: 2px; transform: translateX(-50%); width: 32px; height: 9px; padding: 0; border: 1px solid rgba(128,128,128,.42);
        border-radius: 2px; background: rgba(128,128,128,.16); cursor: pointer;
        display: flex; align-items: center; justify-content: center;
      }
      .dg-lane-collapse { transition: transform .14s ease, background .14s ease, filter .14s ease; }
      .dg-lane-collapse:hover { background: rgba(128,128,128,.28); transform: translateX(-50%) translateY(-2px); filter: brightness(1.15); }
      .dg-lane-collapse:active { transform: translateX(-50%) translateY(0); }
      .dg-lane-collapse-triangle {
        width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent;
        border-bottom: 5px solid rgba(220,220,220,.82);
      }
      /* g-153：主要操作按钮 hover/active/disabled */
      .dg-btn-primary { transition: background .12s ease, border-color .12s ease, filter .12s ease; }
      .dg-btn-primary:hover { background: rgba(76,141,255,.30); border-color: rgba(76,141,255,.55); }
      .dg-btn-primary:active { background: rgba(76,141,255,.40); }
      .dg-btn-primary:disabled { opacity: 0.45; cursor: default; }
      /* g-153：危险操作按钮 hover/active/disabled */
      .dg-btn-danger { transition: background .12s ease, border-color .12s ease, filter .12s ease; }
      .dg-btn-danger:hover { background: rgba(214,102,102,.30); border-color: rgba(214,102,102,.50); }
      .dg-btn-danger:active { background: rgba(214,102,102,.42); }
      .dg-btn-danger:disabled { opacity: 0.45; cursor: default; }
      /* g-153：接受/确认操作按钮 hover/active/disabled */
      .dg-btn-accept { transition: background .12s ease, border-color .12s ease, filter .12s ease; }
      .dg-btn-accept:hover { background: rgba(58,166,117,.30); border-color: rgba(58,166,117,.55); }
      .dg-btn-accept:active { background: rgba(58,166,117,.42); }
      .dg-btn-accept:disabled { opacity: 0.45; cursor: default; }
      /* g-153：下拉菜单/选择控件暗色主题 */
      .dg-select {
        font-size: 12px; padding: 3px 8px; cursor: pointer;
        background: rgba(30,31,36,.92); color: #e6e6e6;
        border: 1px solid rgba(128,128,128,.35); border-radius: 4px;
        transition: border-color .12s ease;
      }
      .dg-select:hover { border-color: rgba(128,128,128,.55); }
      .dg-select:focus { border-color: rgba(76,141,255,.55); outline: none; }
      .dg-select option { background: #222328; color: #e6e6e6; }
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
