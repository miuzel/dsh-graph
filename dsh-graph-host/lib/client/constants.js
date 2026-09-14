    // g-174：标题栏显示的插件版本（快速通道：硬编码当前包版本，不做版本号自动同步机制）
    const PLUGIN_VERSION = "0.11.0";

    // g-230：阶段列定义——label 改为函数式动态翻译（每次渲染时读取当前语言）
    const STAGES = [
      { key: "describe", get label() { return dgT('stage.describe'); }, statuses: ["draft", "planning"] },
      { key: "collect", get label() { return dgT('stage.collect'); }, statuses: ["collecting", "ready"] },
      { key: "execute", get label() { return dgT('stage.execute'); }, statuses: ["in_progress"] },
      { key: "confirm", get label() { return dgT('stage.confirm'); }, statuses: ["review"] },
      { key: "deliver", get label() { return dgT('stage.deliver'); }, statuses: ["delivered"] },
      { key: "blocked", get label() { return dgT('stage.blocked'); }, statuses: ["blocked"] },
    ];

    // g-230：状态标签——动态翻译函数（渲染时读取当前语言）
    const STATUS_LABEL = {
      get draft() { return dgT('status.draft'); },
      get planning() { return dgT('status.planning'); },
      get collecting() { return dgT('status.collecting'); },
      get ready() { return dgT('status.ready'); },
      get in_progress() { return dgT('status.in_progress'); },
      get review() { return dgT('status.review'); },
      get delivered() { return dgT('status.delivered'); },
      get blocked() { return dgT('status.blocked'); },
    };

    // g-158/g-232：目标类型视觉配置——颜色、缩写、完整名
    const GOAL_TYPES = ["feature", "bug", "task", "improvement", "patch", "chore"];
    const GOAL_TYPE_COLORS = { feature: "#4c8dff", bug: "#dd6666", task: "#8a8a8a", improvement: "#3aa675", patch: "#00acc1", chore: "#9c27b0" };
    const GOAL_TYPE_ABBREV = { feature: "F", bug: "B", task: "T", improvement: "I", patch: "P", chore: "C" };
    const GOAL_TYPE_LABELS = { feature: "feature", bug: "bug", task: "task", improvement: "improvement", patch: "patch", chore: "chore" };
    // g-158：规范化类型——非法值安全回退 task
    function normalizeGoalType(raw) {
      return GOAL_TYPES.includes(raw) ? raw : "task";
    }
    // g-158：获取类型色——回退 task 色
    function goalTypeColor(type) {
      return GOAL_TYPE_COLORS[normalizeGoalType(type)] ?? GOAL_TYPE_COLORS.task;
    }

    // g-230：事件标签——动态翻译（getter 延迟读取当前语言）
    const EVENT_LABEL = {
      get "goal.created"() { return dgT('event.goalCreated'); },
      get "goal.planned"() { return dgT('event.goalPlanned'); },
      get "criteria.confirmed"() { return dgT('event.criteriaConfirmed'); },
      get "criteria.updated"() { return dgT('event.criteriaUpdated'); },
      "goal.transition": null,
      get "attempt.started"() { return dgT('event.attemptStarted'); },
      "attempt.status_reported": null,
      get "completion.claimed"() { return dgT('event.completionClaimed'); },
      get "review.requested"() { return dgT('event.reviewRequested'); },
      get "review.objected"() { return dgT('event.reviewObjected'); },
      get "review.passed"() { return dgT('event.reviewPassed'); },
      get "review.failed"() { return dgT('event.reviewFailed'); },
      get "goal.moved"() { return dgT('event.goalMoved'); },
      get "card.created"() { return dgT('event.cardCreated'); },
      get "card.filled"() { return dgT('event.cardFilled'); },
      get "card.reviewed"() { return dgT('event.cardReviewed'); },
      get "evidence.added"() { return dgT('event.evidenceAdded'); },
      get "memory.promoted"() { return dgT('event.memoryPromoted'); },
      get "version.created"() { return dgT('event.versionCreated'); },
      get "version.released"() { return dgT('event.versionReleased'); },
      get "version.status_changed"() { return dgT('event.versionStatusChanged'); },
      get "version.scope_changed"() { return dgT('event.versionScopeChanged'); },
      get "version.integration_decided"() { return dgT('event.versionIntegrationDecided'); },
      get "goal.deleted"() { return dgT('event.goalDeleted'); },
      get "card.deleted"() { return dgT('event.cardDeleted'); },
      get "attempt.bound"() { return dgT('event.attemptBound'); },
      get "goal.renamed"() { return dgT('event.goalRenamed'); },
      get "goal.type_changed"() { return dgT('event.goalTypeChanged'); },
      get "goal.directive_set"() { return dgT('event.directiveSet'); },
      get "goal.comment_added"() { return dgT('event.commentAdded'); },
      get "attempt.handoff.confirmed"() { return dgT('event.handoffConfirmed'); },
      get "attempt.handoff.superseded"() { return dgT('event.handoffSuperseded'); },
      get "attempt.unbound"() { return dgT('event.attemptUnbound'); },
      get "attempt.detached"() { return dgT('event.attemptDetached'); },
      get "attempt.abandoned"() { return dgT('event.attemptAbandoned'); },
    };

    // 近期动态只保留对人有用的事件：泳道切换、修订与人工补充、判据/评审/交付关键节点
    // g-a92e1406：补 attempt.status_reported（状态汇报履历）
    const MEANINGFUL = new Set([
      "goal.transition", "goal.amended", "scope.note", "criteria.confirmed",
      "criteria.updated", // g-170
      "completion.claimed", "review.requested", "review.objected", "review.passed", "review.failed", "attempt.started",
      "goal.moved", "goal.created", "attempt.status_reported", "goal.renamed",
      "goal.type_changed", // g-158
      "goal.directive_set", "goal.comment_added",
      "attempt.handoff.confirmed", "attempt.handoff.superseded",
      "attempt.unbound", // g-190
      "attempt.detached", "attempt.abandoned", // g-282
    ]);

    // g-230：拆出事件三要素（时间/事件/执行者），供表格列渲染与 humanEvent 复用
    function eventParts(e) {
      const d = e.details ?? {};
      let what = EVENT_LABEL[e.event];
      if (what === null || what === undefined) {
        if (e.event === "goal.transition") what = dgT('event.statusFlow', { from: STATUS_LABEL[d.from] ?? d.from, to: STATUS_LABEL[d.to] ?? d.to });
        else if (e.event === "review.requested") what = dgT('event.reviewRequestedDetail', { stage: d.targetStage ?? "" }) + (d.snapshot ? `（${String(d.snapshot).slice(0, 120)}）` : "");
        else if (e.event === "review.objected") what = dgT('event.reviewObjected') + "：" + (d.objection ?? "");
        else if (e.event === "attempt.status_reported") what = dgT('event.statusReport', { status: d.status ?? "" });
        else if (e.event === "goal.amended") what = dgT('event.amended', { note: d.note ?? "" });
        else if (e.event === "goal.renamed") what = dgT('event.renamed', { old: d.old_title ?? "", new: d.new_title ?? "" });
        else if (e.event === "goal.type_changed") what = dgT('event.typeChanged', { old: GOAL_TYPE_LABELS[d.old_type] ?? d.old_type, new: GOAL_TYPE_LABELS[d.new_type] ?? d.new_type }); // g-158
        else if (e.event === "scope.note") what = dgT('event.scopeNote', { note: d.note ?? "" });
        else if (e.event === "goal.directive_set") what = dgT('event.directiveSetDetail', { directive: (d.directive ?? "").slice(0, 80) + ((d.directive ?? "").length > 80 ? "…" : "") });
        else if (e.event === "goal.comment_added") what = dgT('event.commentDetail', { text: (d.text ?? "").slice(0, 60) + ((d.text ?? "").length > 60 ? "…" : "") });
        else if (e.event === "attempt.handoff.confirmed") what = dgT('event.handoffConfirmedDetail', { id: d.handoff ?? "" });
        else if (e.event === "attempt.handoff.superseded") what = dgT('event.handoffSupersededDetail', { old: d.old_handoff ?? "", new: d.new_handoff ?? "" });
        else if (e.event === "attempt.unbound") what = dgT('event.unboundDetail', { id: d.child_id ?? "" }) + (d.reason ? "（" + d.reason + "）" : ""); // g-190
        else if (e.event === "attempt.detached") what = dgT('event.detachedDetail', { id: d.child_id ?? d.attempt ?? "" }) + (d.reason ? "（" + d.reason + "）" : ""); // g-282
        else if (e.event === "attempt.abandoned") what = dgT('event.abandonedDetail', { id: d.attempt ?? "" }) + (d.reason ? "（" + d.reason + "）" : ""); // g-282
        else what = e.event;
      }
      // g-230：执行者标签国际化
      const who = String(e.actor ?? "")
        .replace(/^human:/, "").replace(/^supervisor:.*/, dgT('event.supervisorActor'))
        .replace(/^agent:session-.*/, dgT('event.otherSessionActor')).replace(/^agent:/, "Agent:");
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
      .dg-criteria-row { transition: background .12s ease; border-radius: 4px; }
      .dg-criteria-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }
      .dg-collapsed:hover { background: rgba(128,128,128,.14); }
      .dg-deliver-collapsed:hover { background: rgba(128,128,128,.14); }
      .dg-blocked-collapsed:hover { background: rgba(128,128,128,.14); }
      .dg-btn { transition: background .12s ease, border-color .12s ease, filter .12s ease; }
      /* g-176：hover 不再用 brightness(1.20)（浅色主题下会洗白），改用主题化背景加深 */
      .dg-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.25)); }
      .dg-btn:active { filter: brightness(0.95); }
      .dg-btn:disabled { opacity: 0.45; cursor: default; filter: none; }
      /* g-188：统一“转到对话”入口的 hover/active/focus 反馈，不改变布局。 */
      .dg-card-drawer-resize-handle { transition: background .12s ease, box-shadow .12s ease; }
      .dg-card-drawer-resize-handle:hover, .dg-card-drawer-resize-handle:active, .dg-card-drawer-resize-handle.dg-dragging { background: var(--dsw-alias-state-business-primary, rgba(76,141,255,.35)) !important; box-shadow: inset 2px 0 0 0 var(--dsw-alias-state-business-primary, #4c8dff) !important; }
      .dg-session-link { border-color: var(--dsw-alias-state-business-primary, rgba(76,141,255,.55)); }
      .dg-session-link:hover { background: var(--dsw-alias-state-business-tertiary, rgba(76,141,255,.30)); border-color: var(--dsw-alias-state-business-primary, rgba(76,141,255,.85)); box-shadow: 0 0 0 2px rgba(76,141,255,.18); }
      .dg-session-link:active { background: var(--dsw-alias-state-business-tertiary, rgba(76,141,255,.42)); transform: translateY(1px); }
      .dg-session-link:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4c8dff); outline-offset: 2px; }
      .dg-live-strip-clickable { cursor: pointer; transition: transform .14s ease, box-shadow .14s ease, background .14s ease; }
      .dg-live-strip-clickable:hover { transform: translateY(-1px); box-shadow: 0 2px 8px rgba(76,141,255,.24); background: rgba(76,141,255,.18); }
      .dg-live-strip-clickable:active { transform: translateY(0); box-shadow: 0 0 0 2px rgba(76,141,255,.28); }
      .dg-live-strip-clickable:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4c8dff); outline-offset: 2px; }
      /* g-227：仅“转到对话”入口在可悬停指针下轻微放大，不影响布局 */
      @media (hover: hover) and (pointer: fine) {
        .dg-session-link { transition: transform .16s ease, background .12s ease, border-color .12s ease, filter .12s ease; }
        .dg-session-link:hover:not(:disabled) { transform: scale(1.04); }
      }
      @media (prefers-reduced-motion: reduce) {
        .dg-session-link { transition-duration: 0s !important; }
        .dg-session-link:hover:not(:disabled) { transform: none; }
      }
      /* g-162：普通泳道内容底部居中的扁平折叠入口；released 不使用此控件 */
      .dg-lane-collapse {
        position: absolute; left: 50%; right: auto; bottom: 2px; transform: translateX(-50%); width: 32px; height: 9px; padding: 0; border: 1px solid rgba(128,128,128,.42);
        border-radius: 2px; background: rgba(128,128,128,.16); cursor: pointer;
        display: flex; align-items: center; justify-content: center;
      }
      .dg-lane-collapse { transition: transform .14s ease, background .14s ease, filter .14s ease; }
      /* g-176：hover 去掉 brightness(1.15)（浅色主题下会洗白），保留背景加深 */
      .dg-lane-collapse:hover { background: rgba(128,128,128,.28); transform: translateX(-50%) translateY(-2px); }
      .dg-lane-collapse:active { transform: translateX(-50%) translateY(0); }
      .dg-lane-collapse-triangle {
        width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent;
        border-bottom: 5px solid var(--dsw-alias-label-tertiary, rgba(220,220,220,.82));
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
      /* 统一弹窗与抽屉右上角关闭按钮 */
      .dg-close {
        transition: opacity .12s ease, background .12s ease, transform .12s ease;
        line-height: 1 !important;
        text-align: center;
      }
      .dg-close:hover {
        opacity: 1 !important;
        background: rgba(128,128,128,.22) !important;
        transform: scale(1.08);
      }
      .dg-close:active {
        transform: scale(0.95);
      }
      /* g-153：下拉菜单/选择控件——g-176：改 DSH 主题变量并保留暗色 fallback */
      .dg-select {
        font-size: 12px; padding: 3px 8px; cursor: pointer;
        background: var(--dsw-alias-bg-layer-2, rgba(30,31,36,.92)); color: var(--dsw-alias-label-primary, #e6e6e6);
        border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); border-radius: 4px;
        transition: border-color .12s ease;
      }
      .dg-select:hover { border-color: rgba(128,128,128,.55); }
      .dg-select:focus { border-color: rgba(76,141,255,.55); outline: none; }
      .dg-select option { background: var(--dsw-alias-bg-layer-3, #222328); color: var(--dsw-alias-label-primary, #e6e6e6); }
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
      /* g-277: compact tag chips in subtitle row with hover delete */
      .dg-tag-chips-wrap {
        display: inline-flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 4px;
        min-width: 0;
        max-width: 100%;
        vertical-align: middle;
      }
      .dg-tag-chip {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        font-size: 11px;
        line-height: 1.3;
        padding: 1px 6px;
        border-radius: 4px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.30));
        background: var(--dsw-alias-interactive-bg-hover-solid, rgba(128,128,128,.15));
        color: var(--dsw-alias-label-primary, #e6e6e6);
        box-sizing: border-box;
        max-width: 160px;
        outline: none;
        cursor: default;
        transition: background .12s ease, border-color .12s ease;
      }
      .dg-tag-chip:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.25));
        border-color: var(--dsw-alias-border-l1, rgba(128,128,128,.45));
      }
      .dg-tag-chip:focus-within,
      .dg-tag-chip:focus {
        border-color: var(--dsw-alias-state-business-primary, #4c8dff);
        box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary, #4c8dff);
      }
      .dg-tag-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .dg-tag-chip .dg-tag-del {
        visibility: hidden;
        border: none;
        background: transparent;
        color: var(--dsw-alias-label-secondary, rgba(220,220,220,.75));
        cursor: pointer;
        padding: 0 2px;
        margin-left: 2px;
        font-size: 12px;
        line-height: 1;
        border-radius: 2px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: color .12s ease, background .12s ease;
      }
      .dg-tag-chip:hover .dg-tag-del,
      .dg-tag-chip:focus-within .dg-tag-del,
      .dg-tag-del:focus,
      .dg-tag-del:focus-visible {
        visibility: visible;
      }
      .dg-tag-chip .dg-tag-del:hover {
        color: var(--dsw-alias-state-error-primary, #d66);
        background: rgba(214,102,102,.22);
      }
      .dg-tag-chip .dg-tag-del:focus-visible {
        outline: 1px solid var(--dsw-alias-state-error-primary, #d66);
      }
      .dg-tag-add-btn {
        display: inline-flex;
        align-items: center;
        font-size: 11px;
        line-height: 1.3;
        padding: 1px 6px;
        border-radius: 4px;
        border: 1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.35));
        background: transparent;
        color: var(--dsw-alias-label-secondary, rgba(220,220,220,.75));
        cursor: pointer;
        flex-shrink: 0;
        transition: background .12s ease, border-color .12s ease, color .12s ease;
      }
      .dg-tag-add-btn:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.20));
        color: var(--dsw-alias-label-primary, #e6e6e6);
        border-color: var(--dsw-alias-state-business-primary, #4c8dff);
      }
      .dg-tag-input {
        width: 100px;
        font-size: 11px;
        line-height: 1.3;
        padding: 1px 6px;
        border-radius: 4px;
        border: 1px solid var(--dsw-alias-state-business-primary, #4c8dff);
        background: var(--dsw-alias-bg-layer-2, rgba(30,31,36,.92));
        color: var(--dsw-alias-label-primary, #e6e6e6);
        outline: none;
        box-sizing: border-box;
        flex-shrink: 0;
      }
      .dg-card-active { box-shadow: 0 0 0 2px rgba(76,141,255,.85) !important; background: rgba(76,141,255,.12) !important; }
      .dg-sub-active { background: rgba(58,166,117,.30) !important; box-shadow: 0 0 0 1px #3aa675 !important; }
      /* g-233：搜索匹配与当前选中视觉反馈 */
      .dg-card-matched { box-shadow: 0 0 0 1.5px rgba(255,193,7,.55) !important; }
      .dg-card-search-current {
        box-shadow: 0 0 0 2.5px #ff9800, 0 2px 14px rgba(255,152,0,.55) !important;
        background: rgba(255,152,0,.14) !important;
        animation: dg-search-pulse 2s infinite ease-in-out;
      }
      @keyframes dg-search-pulse {
        0%, 100% { box-shadow: 0 0 0 2.5px #ff9800, 0 2px 14px rgba(255,152,0,.55); }
        50% { box-shadow: 0 0 0 3.5px #ffb74d, 0 4px 18px rgba(255,152,0,.8); }
      }
      .dg-search-highlight {
        background: rgba(255,235,59,.45);
        color: inherit;
        padding: 0 1px;
        border-radius: 2px;
        font-weight: 600;
      }
      .dg-search-highlight-current {
        background: #ffd54f;
        color: #111;
        padding: 0 2px;
        border-radius: 2px;
        font-weight: 700;
      }
      .dg-supervisor { position: sticky; top: 0; z-index: 50; backdrop-filter: blur(6px); background: var(--dsw-alias-bg-base, rgba(30,31,36,.85)); }
      /* g-216: 看板以低层级保留 composerSeat 输入框；看板打开时禁用并降下宿主 widthHandle，避免其遮挡/抢占看板边缘。 */
      .wSkVaW_root:has(.dg-kanban-root) .wSkVaW_widthHandle,
      .wSkVaW_body:has(.dg-kanban-root) .wSkVaW_widthHandle {
        z-index: 0 !important;
        pointer-events: none !important;
      }
      /* 弹窗与抽屉等蒙层打开时，隐藏原生 widthHandle，防止手柄遮挡/穿透弹层与边缘溢出 */
      .wSkVaW_root:has(.dg-modal-open) .wSkVaW_widthHandle,
      .wSkVaW_body:has(.dg-modal-open) .wSkVaW_widthHandle,
      .wSkVaW_root:has([style*="position: fixed"]) .wSkVaW_widthHandle,
      .wSkVaW_root:has([style*="position:fixed"]) .wSkVaW_widthHandle,
      .wSkVaW_body:has([style*="position: fixed"]) .wSkVaW_widthHandle,
      .wSkVaW_body:has([style*="position:fixed"]) .wSkVaW_widthHandle,
      body:has(.dg-modal-open) [data-width-handle],
      body:has([style*="position: fixed"]) [data-width-handle],
      body:has([style*="position:fixed"]) [data-width-handle] {
        display: none !important;
      }
      /* 弹窗与抽屉打开时，降低 composer 对话框层级并禁用点击穿透，彻底防止遮挡抽屉 */
      .wSkVaW_root:has(.dg-modal-open) .wSkVaW_composerSeat,
      .wSkVaW_body:has(.dg-modal-open) .wSkVaW_composerSeat,
      body:has(.dg-modal-open) [class*="composerSeat"] {
        z-index: 0 !important;
        pointer-events: none !important;
      }
      /* g-a92e1406：运行中状态摘要流动背景 + 图标动画 */
      @keyframes dg-flow-bg {
         0% { background-position: 0% 50%; }
        50% { background-position: 100% 50%; }
         100% { background-position: 0% 50%; }
              }
      @keyframes dg-polish-flow {
         0%, 80% { background-position: 0% 50%; opacity: 1; }
         100% { background-position: 100% 50%; opacity: 0; }
       }
       /* g-171：更新强调动画——左侧类型色边框金属光泽浮层（10 秒生命周期内循环扫光并淡出） */
       .dg-update-sheen {
         position: absolute; left: -5px; top: 0; bottom: 0; width: 5px;
         overflow: hidden; pointer-events: none; border-radius: 6px 0 0 6px;
         /* 时长由内联 animationDuration（剩余毫秒）覆盖；forwards 结束停留不可见 */
         animation: dg-update-fade 10s linear forwards;
       }
       .dg-update-sheen-bar {
         position: absolute; left: 0; right: 0; top: 0; height: 40%;
         background: linear-gradient(180deg, rgba(255,255,255,0), rgba(255,255,255,.92), rgba(205,212,224,.55), rgba(255,255,255,0));
         animation: dg-update-sheen-sweep 1.6s linear infinite;
       }
       @keyframes dg-update-sheen-sweep {
         0% { transform: translateY(-130%); }
         100% { transform: translateY(230%); }
       }
       @keyframes dg-update-fade {
         0% { opacity: 1; }
         100% { opacity: 0; }
       }
       @media (prefers-reduced-motion: reduce) {
         .dg-update-sheen, .dg-update-sheen-bar { animation: none !important; }
         /* g-171 回退修复：reduced-motion 下不隐藏浮层（原 opacity:0 导致用户系统开
            "减少动态效果"时动画完全不可见）。降级为静态斜向金属光泽高光——135° 对角线
            渐变直接在浮层上画"一宽一细两条高光"（细亮线 + 宽柔光带，中间暗间隙分隔，
            两侧羽化）。不用旋转子条（stop 沿 5px 水平方向分布像素太少，羽化无余地）；
            135° 渐变轴沿浮层对角线（长度≈卡片高度），stop 百分比有足够像素跨度。
            不用纯色整条填充（避免误判为类型色改变）。 */
         .dg-update-sheen {
           background: linear-gradient(135deg,
             rgba(255,255,255,0) 0%,
             rgba(255,255,255,0) 35%,
             rgba(255,255,255,.95) 45%,
             rgba(255,255,255,0) 52%,
             rgba(255,255,255,.35) 62%,
             rgba(255,255,255,.6) 72%,
             rgba(255,255,255,0) 85%,
             rgba(255,255,255,0) 100%);
         }
         .dg-update-sheen-bar { display: none; }
       }
       @keyframes dg-pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.45; transform: scale(1.25); }
      }
      @keyframes dg-spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .dg-spin {
        display: inline-block;
        animation: dg-spin 1.5s linear infinite;
        transform-origin: center center;
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
      .dg-drag-ghost { position: fixed; pointer-events: none; z-index: 100000; opacity: 0.85;
        max-width: 260px; padding: 6px 10px; border-radius: 6px;
        background: rgba(30,31,36,.92); border: 1px solid rgba(76,141,255,.55);
        box-shadow: 0 4px 16px rgba(0,0,0,.35); font-size: 12px; font-weight: 600;
        color: #e6e6e6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      /* g-270：目标描述只读态半透明暗色底纹面板（圆角 + 内边距），视觉圈出正文区域，分层栏目标题，深浅主题自适应 */
      .dg-description-preview {
        background: var(--dsw-alias-fill-tsp-secondary, rgba(0, 0, 0, 0.025));
        border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
        border-radius: 8px;
        padding: 10px 14px;
        margin-top: 4px;
        box-sizing: border-box;
      }
      /* g-270 修正（负责人反馈）：浅色下正文底纹调淡；代码块/行内代码需比正文底纹略"深"，
         覆盖 DSH MarkdownText 默认的近白底（实测 #f9fafb / #fafafa），避免"块比正文更浅"的观感。
         代码块只让最外层 .md-code-block 承载一次底纹，内部（复制条/pre/code 等）一律透明，
         否则 pre 与其内层 code 会各叠一层、文字区域出现重复底纹（负责人反馈） */
      body:not([data-ds-dark-theme]) .dg-description-preview .md-code-block {
        background: rgba(0, 0, 0, 0.06);
      }
      body:not([data-ds-dark-theme]) .dg-description-preview .md-code-block *:not(button) {
        background: transparent;
      }
      /* 标题 banner（复制条）恢复与代码区的边界：更浅的底 + 细分隔线（负责人反馈"缺少原本的边界"） */
      body:not([data-ds-dark-theme]) .dg-description-preview .md-code-block > div:first-child {
        background: #ffffff;
        border-bottom: 1px solid rgba(0, 0, 0, 0.07);
      }
      body:not([data-ds-dark-theme]) .dg-description-preview code {
        background: rgba(0, 0, 0, 0.06);
      }
      body[data-ds-dark-theme] .dg-description-preview {
        background: var(--dsw-alias-fill-tsp-secondary, rgba(0, 0, 0, 0.25));
        border-color: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.10));
      }
      /* 深色：DSH 原语代码块实测仍写死近白底（不随主题变化）→ 改为微亮抬升面，避免暗色里的刺眼白块。
         注意：深色判定只用 DSH 自身解析出的 body[data-ds-dark-theme]，
         不得使用 @media (prefers-color-scheme: dark)——应用内浅色 + 系统深色时会把深色值泄漏到浅色 UI
         （负责人真机复现：app 浅色 + OS 深色 → 底纹变 rgba(0,0,0,.25)） */
      body[data-ds-dark-theme] .dg-description-preview .md-code-block {
        background: rgba(255, 255, 255, 0.06);
      }
      body[data-ds-dark-theme] .dg-description-preview .md-code-block *:not(button) {
        background: transparent;
      }
      body[data-ds-dark-theme] .dg-description-preview .md-code-block > div:first-child {
        background: rgba(255, 255, 255, 0.05);
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      body[data-ds-dark-theme] .dg-description-preview code {
        background: rgba(255, 255, 255, 0.06);
      }
    `;

    const S = {

    // Contract alias: "criteria.updated": "更新判据" (runtime value is a locale getter).
