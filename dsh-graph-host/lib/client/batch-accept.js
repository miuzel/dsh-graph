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
      const toggleAll = () => setSelected(allChecked ? [] : allIds.slice());
      const toggleOne = (id) => setSelected((prev) => batchAcceptToggleId(prev, id));
      const confirm = () => { if (!loading && selected.length > 0) props.onConfirm?.(selected.slice()); };

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
              "aria-label": dgT("batchAccept.selectAll"),
              onChange: toggleAll, onClick: (e) => e.stopPropagation(),
            }),
            h("span", { style: { cursor: loading ? "default" : "pointer" }, onClick: () => { if (!loading) toggleAll(); } },
              dgT("batchAccept.selectAll")),
            h("span", { style: { ...S.meta, marginLeft: "auto" } },
              dgT("batchAccept.selectedCount", { selected: selected.length, total: allIds.length }))),
          // 目标清单（id / 标题 / 所属版本），可滚动
          h("div", { style: { maxHeight: 260, overflowY: "auto", marginBottom: 8 } },
            items.map((it) => {
              const on = selected.includes(it.id);
              return h("div", {
                key: it.id,
                style: { display: "flex", alignItems: "center", gap: 8, padding: "3px 6px", fontSize: 12,
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
                            title: it.title }, it.title ?? it.id),
                h("span", { style: { ...S.meta, flexShrink: 0, fontSize: 11 } }, it.versionLabel ?? ""));
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
export { batchAcceptButtonState, batchAcceptToggleId, runBatchAccept, batchAcceptSupervisorMessage, notifySupervisorBatchAccept, BatchAcceptModal };
// <<<ESM-EXPORTS-END<<<
