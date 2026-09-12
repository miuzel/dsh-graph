    // ===== g-273：确认列「批量接受」——列头入口 + 勾选式二次确认弹窗 + 限流批量提交 + 单条聚合主管通知 =====
    // 硬约束（Human Gate 与逐卡「接受」语义逐字一致，见 goal-actions.js AcceptFeedback.doAccept）：
    // - 逐个调用 POST /api/dsh-graph/accept 的**非 force** 路径（body 仅 {goal}），每目标写 review.requested；
    // - 绝不传 force、绝不直接写 delivered；不新增后端端点；不改状态机契约；
    // - 主管通知由客户端整批聚合为**一条**（服务端不去重）；无 supervisorSession 时静默跳过，不影响接受流程。

    // 纯函数：列头「批量接受」按钮状态（禁用态 + 计数 + 悬停说明）。
    // reviewCount = 当前视图内 status=review 的目标数（由 kanban.js 按当前视图过滤后传入）。
    function batchAcceptButtonState(reviewCount) {
      const count = Number.isFinite(reviewCount) ? Math.max(0, Math.floor(reviewCount)) : 0;
      return {
        disabled: count === 0,
        count,
        label: count > 0 ? dgT("batchAccept.buttonWithCount", { count }) : dgT("batchAccept.button"),
        title: count === 0 ? dgT("batchAccept.disabledTip") : dgT("batchAccept.enabledTip", { count }),
      };
    }

    // 纯函数：单项勾选/取消切换。
    function batchAcceptToggleId(selected, id) {
      return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    }

    // 纯函数（g-273 att-002）：按所属版本（versionLabel）分组，保持 items 首现顺序
    //（= 看板泳道顺序，版本语义降序，与 g-264 一致），组内保持 items 原序。
    // 无 versionLabel / 空串 / 非字符串的目标归入 standaloneLabel 兜底组
    //（调用方传 dgT("lane.standalone")，函数本身不依赖 i18n 全局）；
    // 任何其他无版本情形（undefined/null/数字等）同样落入该兜底组。
    // 分组仅由 items 派生：只产出至少含 1 个目标的组，绝不产出空组占位。
    function batchAcceptGroupByVersion(items, standaloneLabel) {
      const fallback = typeof standaloneLabel === "string" ? standaloneLabel : "";
      const groups = [];
      const byLabel = new Map();
      for (const it of Array.isArray(items) ? items : []) {
        if (!it) continue;
        const raw = typeof it.versionLabel === "string" ? it.versionLabel.trim() : "";
        const label = raw || fallback;
        let g = byLabel.get(label);
        if (!g) { g = { label, items: [] }; byLabel.set(label, g); groups.push(g); }
        g.items.push(it);
      }
      return groups;
    }

    // 纯函数（g-273 att-003）：组级三态 —— 由该组 ids 的选中情况派生。
    // 返回 { all, some, none }：all=组内全部选中（checked）、some=部分选中（indeterminate）、
    // none=全未选（unchecked）。空组 ids → 全未选（组级开关语义对空组无意义，弹窗本就零渲染空组）。
    function batchAcceptGroupState(selected, ids) {
      const sel = new Set(Array.isArray(selected) ? selected : []);
      const list = Array.isArray(ids) ? ids.filter((x) => typeof x === "string" && x) : [];
      const on = list.filter((id) => sel.has(id)).length;
      const all = list.length > 0 && on === list.length;
      return { all, some: on > 0 && !all, none: on === 0 };
    }

    // 纯函数（g-273 att-003）：组级全选/取消全选切换 —— 只影响该组 ids，其他组选中态原样保留。
    // 组未全选 → 追加该组缺失项（保持既有 selected 顺序，组内新项按 ids 顺序追加）；
    // 组已全选 → 移除该组全部项。
    function batchAcceptToggleGroup(selected, ids) {
      const prev = Array.isArray(selected) ? selected : [];
      const list = Array.isArray(ids) ? ids.filter((x) => typeof x === "string" && x) : [];
      const all = list.length > 0 && list.every((id) => prev.includes(id));
      if (all) {
        const drop = new Set(list);
        return prev.filter((id) => !drop.has(id));
      }
      const have = new Set(prev);
      return [...prev, ...list.filter((id) => !have.has(id))];
    }

    // 核心提交：限流分批 Promise.allSettled（默认并发 4，防瞬时连接爆炸）。
    // 单目标失败（状态冲突/网络错误）不中断其余目标；返回 { ok, failed } 结构化结果。
    // opts: { concurrency, fetchImpl, urlOf } —— fetchImpl/urlOf 可注入（测试与 kanban 的 graphUrlForActive）。
    async function runBatchAccept(goalIds, opts = {}) {
      const ids = Array.isArray(goalIds) ? goalIds.filter((x) => typeof x === "string" && x) : [];
      const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 4));
      const fetchImpl = opts.fetchImpl ?? fetch;
      const urlOf = opts.urlOf ?? ((p) => graphUrl(p));
      const ok = [];
      const failed = [];
      for (let i = 0; i < ids.length; i += concurrency) {
        const chunk = ids.slice(i, i + concurrency);
        const results = await Promise.allSettled(chunk.map(async (goalId) => {
          const r = await fetchImpl(urlOf("/api/dsh-graph/accept"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            // 非 force 路径契约：body 仅 {goal}——服务端走 requestAcceptReview 写 review.requested。
            body: JSON.stringify({ goal: goalId }),
          });
          const data = await r.json();
          if (data && (data.pending || data.ok)) return { goal: goalId, data };
          const err = new Error((data && data.error) || "unknown error");
          err.status = r.status;
          throw err;
        }));
        for (let j = 0; j < results.length; j++) {
          const res = results[j];
          if (res.status === "fulfilled") ok.push(res.value);
          else failed.push({ goal: chunk[j], error: String(res.reason?.message ?? res.reason), status: res.reason?.status });
        }
      }
      return { ok, failed };
    }

    // 聚合主管通知文案：整批一条（含目标清单与总数），与单卡【负责人交付复核请求】同系列话术。
    function batchAcceptSupervisorMessage(goalIds) {
      // i18n-keep(category-b)：发往主管会话的提示词模板（session.prompt 载荷），非 UI 文案，按 g-272 att-002 约定保留中文。
      return `【负责人批量交付复核请求】负责人已对目标 ${goalIds.join(", ")}（共 ${goalIds.length} 个）确认交付。请检查其质量判据与产出物，完成复核并执行交付收口。`;
    }

    // 发送聚合主管通知：整批**一条** queue 消息；无 supervisorSession / 会话不可用 → 静默跳过（返回 false），
    // 绝不影响接受流程本身；不得产生 N 条刷屏。
    async function notifySupervisorBatchAccept(supervisorSession, goalIds) {
      if (!supervisorSession || !Array.isArray(goalIds) || goalIds.length === 0) return false;
      try {
        const rt = sessionsRt ?? appCtx?.get?.("sessions");
        const session = rt?.binding?.(supervisorSession)?.session ?? rt?.get?.(supervisorSession);
        if (!session?.prompt) return false;
        await session.prompt([{ type: "text", text: batchAcceptSupervisorMessage(goalIds) }], "queue");
        return true;
      } catch (err) {
        console.warn("[dsh-graph-host] batch accept: prompt supervisorSession failed:", err);
        return false;
      }
    }

    // 勾选式二次确认弹窗（Human Gate）。
    // props: { items: [{id, title, versionLabel}], loading, failures: null|[{goal,error}], onConfirm(ids), onCancel() }
    // 清单按 versionLabel 分组渲染（组头含版本标签与该组目标数；无版本归入独立目标兜底组；空组不渲染）；
    // 取消、✕、Esc、点击遮罩关闭均为零副作用（零网络请求、零状态变化，仅触发 onCancel）；
    // loading（提交中）期间所有关闭路径与按钮一并锁定，防重复点击。
    function BatchAcceptModal(props) {
      const items = Array.isArray(props.items) ? props.items : [];
      const allIds = items.map((it) => it.id);
      const [selected, setSelected] = React.useState(() => allIds.slice());
      // 部分失败后由父级回填 failures：勾选重置为仅失败项，便于直接重试
      const failKey = JSON.stringify((props.failures ?? []).map((f) => f.goal));
      React.useEffect(() => {
        if (props.failures && props.failures.length) setSelected(props.failures.map((f) => f.goal));
      }, [failKey]);
      // Esc 关闭（loading 期间锁定）；纯取消路径，零副作用
      const loadingRef = React.useRef(false);
      loadingRef.current = !!props.loading;
      React.useEffect(() => {
        const onKey = (e) => {
          if (e.key !== "Escape") return;
          if (loadingRef.current) return;
          e.stopPropagation();
          props.onCancel?.();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, []);
      const loading = !!props.loading;
      const closeIfIdle = () => { if (!loading) props.onCancel?.(); };
      const backdropGuard = useBackdropClose(closeIfIdle);
      const allChecked = allIds.length > 0 && selected.length === allIds.length;
      // 全局三态（g-273 att-003）：部分选中 → indeterminate（DOM 属性，须经 ref 赋值，React 不托管）
      const globalSome = !allChecked && selected.length > 0;
      const globalCbRef = (el) => { if (el) el.indeterminate = globalSome; };
      const toggleAll = () => setSelected(allChecked ? [] : allIds.slice());
      const toggleOne = (id) => setSelected((prev) => batchAcceptToggleId(prev, id));
      const confirm = () => { if (!loading && selected.length > 0) props.onConfirm?.(selected.slice()); };
      // g-273 att-002：按所属版本分组（组顺序 = items 首现顺序 = 看板泳道顺序）；
      // 无版本目标归入 dgT("lane.standalone") 独立目标兜底组；空版本组绝不渲染（分组仅由 items 派生）。
      const groups = batchAcceptGroupByVersion(items, dgT("lane.standalone"));

      const cbStyle = { flexShrink: 0, cursor: "pointer", width: 16, height: 16, margin: 0 };
      return h("div", { style: S.overlay, ...backdropGuard },
        h("div", { style: { ...S.modal, maxWidth: 560 }, onClick: (e) => e.stopPropagation() },
          h("span", { className: "dg-close", style: { ...S.close, ...(loading ? { opacity: 0.4, pointerEvents: "none" } : {}) }, onClick: closeIfIdle }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 14, marginBottom: 6 } }, dgT("batchAccept.title")),
          h("div", { style: { ...S.meta, marginBottom: 8 } }, dgT("batchAccept.desc")),
          // 全选行 + 选中计数
          h("div", {
            style: { display: "flex", alignItems: "center", gap: 8, padding: "4px 6px", marginBottom: 4,
                     borderBottom: "1px solid rgba(128,128,128,.25)", fontSize: 12, fontWeight: 600 },
          },
            h("input", {
              type: "checkbox", style: cbStyle, checked: allChecked, disabled: loading,
              ref: globalCbRef,
              "aria-label": dgT("batchAccept.selectAll"),
              onChange: toggleAll, onClick: (e) => e.stopPropagation(),
            }),
            h("span", { style: { cursor: loading ? "default" : "pointer" }, onClick: () => { if (!loading) toggleAll(); } },
              dgT("batchAccept.selectAll")),
            h("span", { style: { ...S.meta, marginLeft: "auto" } },
              dgT("batchAccept.selectedCount", { selected: selected.length, total: allIds.length }))),
          // 目标清单：按版本分组渲染（组头 = 组级三态开关 + 版本标签 + 该组待接受目标数），可滚动；
          // 组内行 = 复选框 + id + 标题（不再重复显示版本列）；全选/已选计数仍为跨组全局。
          // 组级三态（g-273 att-003）：组内全选中=checked、部分选中=indeterminate（ref 赋值 DOM 属性）、
          // 全未选=unchecked；点击只影响该组（未全选→全选本组、已全选→取消本组），loading 期间锁定。
          h("div", { style: { maxHeight: 260, overflowY: "auto", marginBottom: 8 } },
            groups.flatMap((g) => {
              const groupIds = g.items.map((it) => it.id);
              const gState = batchAcceptGroupState(selected, groupIds);
              const toggleGroup = () => setSelected((prev) => batchAcceptToggleGroup(prev, groupIds));
              const groupAria = dgT(gState.all ? "batchAccept.unselectGroup" : "batchAccept.selectGroup", { label: g.label });
              return [
              h("div", {
                key: "vh-" + g.label,
                style: { ...S.meta, display: "flex", alignItems: "center", gap: 8,
                         padding: "5px 6px 2px", fontSize: 11, fontWeight: 700,
                         borderTop: "1px solid rgba(128,128,128,.18)" },
              },
                h("input", {
                  type: "checkbox", style: cbStyle, checked: gState.all, disabled: loading,
                  ref: (el) => { if (el) el.indeterminate = gState.some; },
                  "aria-label": groupAria, title: groupAria,
                  onChange: () => { if (!loading) toggleGroup(); }, onClick: (e) => e.stopPropagation(),
                }),
                h("span", { style: { cursor: loading ? "default" : "pointer" }, title: groupAria,
                            onClick: () => { if (!loading) toggleGroup(); } },
                  dgT("batchAccept.groupHeader", { label: g.label, count: g.items.length }))),
              ...g.items.map((it) => {
                const on = selected.includes(it.id);
                // g-273 att-004 层级缩进契约：目标行 paddingLeft=22px，比组头（6px）大 16px，
                // 与组头形成一眼可辨的「组头 → 组内目标」层级，不再左对齐并列；
                // 纯样式差异，行为零变更（g273 测试含源契约断言，防重构退回并列）。
                return h("div", {
                  key: it.id,
                  style: { display: "flex", alignItems: "center", gap: 8, padding: "3px 6px 3px 22px", fontSize: 12,
                           cursor: loading ? "default" : "pointer", borderRadius: 4,
                           background: on ? "rgba(58,166,117,.08)" : "transparent" },
                  onClick: () => { if (!loading) toggleOne(it.id); },
                },
                  h("input", {
                    type: "checkbox", style: cbStyle, checked: on, disabled: loading,
                    "aria-label": it.id,
                    onChange: () => toggleOne(it.id), onClick: (e) => e.stopPropagation(),
                  }),
                  h("span", { style: { fontFamily: "monospace", flexShrink: 0 } }, it.id),
                  h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                              title: it.title }, it.title ?? it.id));
              }),
              ];
            })),
          // 部分失败清单（持久展示，不整体崩溃；其余目标已正常提交）
          props.failures && props.failures.length
            ? h("div", { style: { marginBottom: 8, padding: "6px 8px", borderRadius: 4, fontSize: 12,
                                  background: "rgba(214,102,102,.12)", border: "1px solid rgba(214,102,102,.35)" } },
                h("div", { style: { fontWeight: 600, marginBottom: 3, color: "var(--dsw-alias-state-error-primary, #f08080)" } },
                  dgT("batchAccept.failedListTitle")),
                props.failures.map((f) => h("div", { key: f.goal, style: { padding: "1px 0", wordBreak: "break-all" } },
                  `• ${f.goal}: ${f.error}`)))
            : null,
          // 动作行：确认接受 / 取消（loading 期间双锁，防重复提交）
          h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
            h("button", {
              style: { ...S.btnAccept, padding: "4px 14px", fontSize: 13 }, className: "dg-btn-accept",
              disabled: loading || selected.length === 0,
              onClick: confirm,
            }, loading ? dgT("common.submitting") : dgT("batchAccept.confirmBtn", { count: selected.length })),
            h("button", {
              style: { ...S.btn, padding: "4px 12px", fontSize: 12 }, className: "dg-btn",
              disabled: loading,
              onClick: closeIfIdle,
            }, dgT("common.cancel")))));
    }

// >>>ESM-EXPORTS-START>>> (build script strips this block for browser bundle)
export { batchAcceptButtonState, batchAcceptToggleId, batchAcceptGroupByVersion, batchAcceptGroupState, batchAcceptToggleGroup, runBatchAccept, batchAcceptSupervisorMessage, notifySupervisorBatchAccept, BatchAcceptModal };
// <<<ESM-EXPORTS-END<<<
