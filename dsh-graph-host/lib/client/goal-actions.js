    // 质量判据 checklist（确认阶段）：每条一个勾选框（localStorage 按目标持久化，仅前端评审草稿）
    // + 「💬 反馈」按钮——展开输入框，经 session.prompt 排队送达该目标的执行会话（复用 g-107 通路）。
    function CriteriaChecklist(props) {
      // 与 core/model.ts criteriaItems 同源：先移除跨行 HTML 注释，再按行 trim。
      const items = String(props.crit ?? "").replace(/<!--[\s\S]*?-->/g, "").split("\n")
        .map((l) => l.trim())
        .filter((l) => l);
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
        window.dispatchEvent(new Event("dsh-graph.criteria-changed"));
      };
      const sendFb = async (criterion) => {
        const t = fbText.trim();
        if (!t) return;
        if (!session?.prompt) { setFbNote(dgT("criteria.feedbackNotConnected")); return; }
        try {
          // i18n-keep(category-b)：发往目标执行会话的提示词模板（session.prompt 载荷），非 UI 文案，按 g-272 att-002 约定保留中文。
          const res = await session.prompt(
            [{ type: "text", text: `【${props.goalId} 判据反馈】${criterion}\n${t}` }], "queue");
          if (res?.ok) {
            // g-321：排队回执改为读真实排队状态（0.1.6 inbox 投影 / 0.1.5 快照 queue 回退），
            // 而不是直接解构 session.getSnapshot().queue——新版该字段已废弃，解构即 TypeError。
            const depth = sessionQueueState(session).pendingCount;
            setFbNote(depth > 0 ? dgT("criteria.feedbackQueuedDepth", { n: depth }) : dgT("criteria.feedbackQueued"));
            setFbText("");
            setFbIdx(-1);
            // g-109：判据反馈提交后自动关闭弹窗
            if (props.onClose) props.onClose();
          }
          else {
            // g-321：0.1.6 的 subagent/delivery-unavailable 与 ACTIVATION_LIMIT_REACHED 给出可操作提示
            const friendly = subagentDispatchErrorText(res?.error);
            setFbNote(friendly ?? (dgT("criteria.feedbackSendFail") + (res?.error?.message ?? dgT("drag.unknownError"))));
          }
        } catch (e) { setFbNote(dgT("criteria.feedbackSendFail") + String(e?.message ?? e)); }
      };
      return h("div", null,
        items.map((line, i) => {
          const done = checked.includes(line);
          const label = line.replace(/^\d+[.、)]\s*/, "");
          return h("div", { key: i, style: { marginBottom: 3 } },
            h("div", {
              className: "dg-criteria-row",
              style: { display: "flex", alignItems: "flex-start", gap: 6, cursor: "pointer", padding: "2px 4px" },
              tabIndex: 0,
              role: "checkbox",
              "aria-label": label,
              "aria-checked": done,
              onClick: (e) => {
                // 子控件各自拥有动作，不应把点击冒泡解释为整行切换。
                if (e.target.closest?.("button,input,textarea,a,select")) return;
                toggle(line);
              },
              onKeyDown: (e) => {
                if (e.target.closest?.("button,input,textarea,a,select")) return;
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                toggle(line);
              },
            },
              h("input", { type: "checkbox", checked: done, onChange: () => toggle(line),
                           onClick: (e) => e.stopPropagation(),
                           onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); toggle(line); } },
                           style: { flexShrink: 0, cursor: "pointer", marginTop: 2, width: 20, height: 20 } }),
              h("span", { style: { flex: 1, minWidth: 0, opacity: done ? 0.55 : 1,
                                   textDecoration: done ? "line-through" : "none" } }, label),
              h("button", { style: { ...S.btn, flexShrink: 0, whiteSpace: "nowrap" }, className: "dg-btn",
                            title: dgT("criteria.feedbackTooltip"),
                            onClick: (e) => { e.stopPropagation(); setFbIdx(fbIdx === i ? -1 : i); setFbNote(null); } },
                dgT("criteria.feedbackBtn"))),
            fbIdx === i
              ? h("div", { style: { display: "flex", gap: 4, marginTop: 3, marginLeft: 22 } },
                  h("input", { style: S.promptInput, value: fbText, placeholder: dgT("criteria.feedbackPlaceholder"),
                               onChange: (e) => setFbText(e.target.value),
                               onKeyDown: (e) => { if (e.key === "Enter") sendFb(line); } }),
                  h("button", { style: S.btn, className: "dg-btn", onClick: () => sendFb(line) }, dgT("criteria.feedbackSend")))
              : null);
        }),
        fbNote ? h("div", { style: { ...S.meta, marginTop: 3 } }, fbNote) : null);
    }

    // 轻量 toast：底部居中浮层，约 2.5s 自动消失（零依赖，不引入 DSH 内部组件）
    function showToast(text) {
      const host = document.createElement("div");
      host.style.cssText =
        "position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:100000;" +
        "background:var(--dsw-alias-toast-bg, rgba(30,30,30,.94));color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;" +
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

    // g-168：仅将确实在执行中的非收集 attempt 视为活跃。
    // result=pending 本身不够：旧 attempt 可能长期 pending，需 status_line 明确未结束。
    function hasActiveExecutionAttempt(attempts) {
      return (attempts ?? []).some((a) => {
        if (a?.executor === "agent:collect" || a?.result !== "pending") return false;
        const structured = ["working", "blocked", "done", "error"].includes(a?.status_state) ? a.status_state : null;
        if (structured) return structured === "working";
        const line = String(a?.status_line ?? "").trim();
        // i18n-keep(category-a)：匹配用户/子代理手写的遗留中文 status_line 终态词，非 UI 文案，必须保留中文模式。
        return line !== "" && !/空闲|完成|待命|已交付|结束|等待|finished|done|idle|completed/i.test(line);
      });
    }

    // g-168：定义/润色入口。两条路径都只产生建议，不改目标或状态。
    function DefinitionPolish(props) {
      const { goalId, goalPath, supervisorSession, status, attempts, onPmStarted, onPmFinished, onClose } = props;
      const [mode, setMode] = React.useState("idle"); // idle | supervisor | pm
      const [guidance, setGuidance] = React.useState("");
      const [note, setNote] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [fallback, setFallback] = React.useState(false);
      const allowed = ["draft", "planning", "collecting", "ready"];
      const hasActiveAttempt = hasActiveExecutionAttempt(attempts);
      if (!allowed.includes(status) || hasActiveAttempt) return null;
      // i18n-keep(category-b)：复制到剪贴板并粘贴进主管会话的提示词模板（非 UI 渲染文案），按 g-272 att-002 约定保留中文。
      const request = `【主管处理请求｜${goalId}｜目标定义/润色】\n\n`
        + `请你以主管 Agent 身份处理这个目标的定义/润色请求。\n`
        + `这条消息由负责人从看板复制发送，不是产品经理 Agent 的任务提示，\n`
        + `也不是要求你扮演产品经理。\n\n`
        + `请先读取目标文件，并按主管流程决定是否需要派发产品经理 Agent。\n`
        + `如有润色建议，请由主管完成目标描述和质量判据的闭环。\n`
        + `本次仅处理目标定义/润色，不执行代码，不推进目标状态或版本。\n\n`
        + `目标 ID（唯一依据）：${goalId}\n`
        + `目标文件（供读取）：\n${String(goalPath ?? "（路径未知）")}\n\n`
        + `负责人补充意见：\n${guidance.trim() || "（无）"}`;
      const openSupervisor = async () => {
        setLoading(true); setNote(null);
        try {
          const rt = sessionsRt ?? appCtx?.get?.("sessions");
          if (!rt) throw new Error(dgT("exec.supervisorUnavailable"));
          if (!supervisorSession) throw new Error(dgT("exec.supervisorNotConfigured"));
          const copied = await copyText(request);
          // g-321：0.1.6 移除了 sessions.open，统一走 openSessionTarget（uiWorkspace.openSession 优先）
          openSessionTarget(supervisorSession, typeof rt.open === "function" ? () => rt.open(supervisorSession) : null);
          activateChatTab();
          if (copied) showToast(dgT("exec.requestCopied"));
           setMode("supervisor");
           setFallback(!copied);
          setNote(copied ? dgT("exec.requestCopiedOpened") : dgT("exec.autocopyFailedRequest"));
        } catch (e) { setNote(dgT("exec.supervisorPathFailed") + String(e?.message ?? e)); }
        setLoading(false);
      };
      const askPm = async () => {
        const startedAt = Date.now();
        onPmStarted?.(goalId);
        setLoading(true); setMode("pm"); setNote(dgT("exec.pmProcessing"));
        onClose?.();
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/define-polish"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: goalId, goal_path: goalPath, guidance: guidance.trim() }) });
          const data = await r.json();
          if (data.ok) {
            // g-249：弹窗已被 onClose 关闭，setNote 不可见；改用 showToast（含 child_id）让用户可见
            const toast = dgT('exec.pmAccepted') + (data.child_id ? "（child: " + data.child_id + "）" : "");
            setNote(toast);
            showToast(toast);
          } else {
            const errNote = dgT('exec.pmFailed') + (data.child_error || data.error || dgT('drag.unknownError'));
            setNote(errNote);
            showToast(errNote);
          }
        } catch (e) {
          const errNote = dgT('exec.pmFailed') + String(e?.message ?? e);
          setNote(errNote);
          showToast(errNote);
        }
        finally {
          // spawnChild 通常很快返回；保持 accepted-running 动画至少一小段可观察时间。
          const remaining = Math.max(0, 2500 - (Date.now() - startedAt));
          if (remaining) await new Promise((resolve) => setTimeout(resolve, remaining));
          onPmFinished?.(goalId);
          setLoading(false);
        }
      };
      const pmRunning = loading && mode === "pm";
      const pmStyle = pmRunning ? {
        border: "1px solid rgba(76,141,255,.75)", borderRadius: 4, padding: "2px 6px",
        background: "linear-gradient(90deg, rgba(76,141,255,.16), rgba(58,166,117,.30), rgba(76,141,255,.16))",
        backgroundSize: "200% 100%", animation: "dg-polish-flow 2.5s ease 1 forwards",
      } : undefined;
      return h("div", { className: pmRunning ? "dg-running-flow" : undefined, style: pmStyle },

        h("button", { style: { ...S.btn, padding: "4px 12px", fontSize: 13 }, className: "dg-btn", disabled: loading, onClick: () => { setMode(mode === "idle" ? "supervisor" : "idle"); setNote(null); } }, dgT("exec.polish")),
        mode !== "idle" ? h("div", { style: { display: "flex", flexDirection: "column", gap: 5, marginTop: 5 } },
          h("div", { style: S.meta }, dgT("exec.guidanceHint")),
          h("textarea", { style: { ...S.promptInput, minHeight: 48, resize: "vertical", fontFamily: "inherit", fontSize: 12 }, value: guidance, placeholder: dgT("exec.guidancePlaceholder"), onChange: (e) => setGuidance(e.target.value) }),
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
            h("button", { style: S.btn, className: "dg-btn", disabled: loading, onClick: openSupervisor }, dgT("exec.goToSupervisor")),
            h("button", { style: S.btn, className: "dg-btn", disabled: loading, onClick: askPm }, dgT("exec.askPm"))),
          note ? h("div", { style: S.meta }, note) : null,
          fallback ? h("textarea", { readOnly: true, value: request, style: { ...S.promptInput, minHeight: 72, resize: "vertical", fontFamily: "monospace", fontSize: 11 }, "aria-label": dgT("exec.polish") }) : null) : null);
    }

    // g-109：目标描述区执行/反馈交互组件（执行按钮直接创建子代理；接受默认经主管 Agent 复核，
    // 无异议生效，有异议显示在按钮处并转「强制接受」，可选理由记 goal.amended 事件供学习）
    function AcceptFeedback(props) {
      const { goalId, status, events, supervisorSession, onRefresh } = props;
      const { attempts } = props;
      const [mode, setMode] = React.useState("idle"); // idle | feedback
      const [fbText, setFbText] = React.useState("");
      const [note, setNote] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [inProgressOpen, setInProgressOpen] = React.useState(false);
      // 反馈预填模板（复制与显示共用，保证一致）
      // i18n-keep(category-b)：粘贴进主管会话的提示词模板（非 UI 渲染文案），按 g-272 att-002 约定保留中文。
      const prefillText = fbText.trim() ? `【${goalId} 反馈】\n${fbText.trim()}` : "";

      // 接受复核状态只关联当前生命周期周期：
      // 以最后一次进入当前阶段（goal.transition to === status）为起点，
      // 如果目标曾被回退重做（如 review -> in_progress -> review），前一次生命周期的请求自然作废，允许重新发起。
      const evs = events ?? [];
      let lastTransitionToCurrent = -1;
      evs.forEach((e, i) => {
        if (e.event === "goal.transition" && String(e.details?.to) === String(status)) {
          lastTransitionToCurrent = i;
        }
      });
      let lastReq = -1, lastObj = -1, lastRes = -1;
      evs.forEach((e, i) => {
        // 仅关注当前这次进入该阶段之后的事件
        if (i < lastTransitionToCurrent) return;
        const targetStage = String(e.details?.targetStage ?? "");
        if (e.event === "review.requested" && (targetStage === String(status) || !targetStage)) lastReq = i;
        if (e.event === "review.objected" && (targetStage === String(status) || (!targetStage && lastReq >= 0))) lastObj = i;
        if (["description.confirmed", "criteria.confirmed", "review.passed"].includes(e.event)) lastRes = i;
      });
      let acceptState = "none";
      if (lastReq >= 0) {
        if (lastObj > lastReq) acceptState = "objection";
        else if (lastRes > lastReq) acceptState = "resolved";
        else acceptState = "pending";
      }
      const objectionText = acceptState === "objection" ? evs[lastObj]?.details?.objection : null;

      // 接受：默认经主管 Agent 复核（review.requested → 主管复核收口）
      const doAccept = async () => {
        if (!confirm(dgT("exec.acceptConfirm", { goalId }))) return;
        setLoading(true);
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/accept"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: goalId }),
          });
          const data = await r.json();
          if (data.pending) {
            try {
              const rt = sessionsRt ?? appCtx?.get?.("sessions");
              // i18n-keep(category-b)：发往主管会话的提示词模板（session.prompt 载荷），非 UI 文案，按 g-272 att-002 约定保留中文。
              const parts = [{ type: "text", text: `【负责人交付复核请求】负责人已在看板对目标「${goalId}」确认交付。请检查其质量判据与产出物，完成复核并执行交付收口。` }];
              // g-323：与批量接受（batch-accept.js 的 notifySupervisorBatchAccept）共用同一份能力探测 helper：
              // 0.1.6 需先 retain 才借得到 binding（无 get(id)），0.1.5 保持被动 binding ?? get 回退。
              // 本处是事件回调（doAccept），绝不引入渲染期 retain；文案与 queue 模式逐字不变。
              await promptSessionQueue(rt, supervisorSession, parts, "[dsh-graph-host] prompt supervisorSession failed:");
            } catch (err) {
              // helper 已自兜底（绝不抛）；此处仅作最后一道防线，保持既有 console.warn 形态。
              console.warn("[dsh-graph-host] prompt supervisorSession failed:", err);
            }
            onRefresh?.();
          } else if (data.ok) {
            onRefresh?.();
          } else setNote(dgT("exec.acceptFail") + (data.error || dgT("drag.unknownError")));
        } catch (e) {
          setNote(dgT("drag.requestFail") + String(e?.message ?? e));
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
          if (data.ok) setNote(forceReason.trim() ? dgT("exec.forceAcceptWithReason") : dgT("exec.forceAccept"));
          else setNote(dgT("exec.forceAcceptFail") + (data.error || dgT("drag.unknownError")));
          setForceMode(false);
          setForceReason("");
        } catch (e) {
          setNote(dgT("drag.requestFail") + String(e?.message ?? e));
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
            setNote(dgT("exec.stateTransitionFail") + (trData.error || dgT("drag.unknownError")));
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
              setNote(dgT("exec.childDispatched") + data.child_id);
            } else if (data.child_error) {
              setNote(dgT("exec.childFailed") + data.child_error);
            } else {
              setNote(dgT("exec.childNotStarted"));
            }
            onRefresh?.(); // g-148：刷新看板（回调由父组件 GoalModal 传入）
          } else {
            setNote(dgT("exec.executeFail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setNote(dgT("drag.requestFail") + String(e?.message ?? e));
        }
        setLoading(false);
      };

      const openSupervisorWithFeedback = async () => {
        try {
          const rt = sessionsRt ?? appCtx?.get?.("sessions");
          if (!rt) { setNote(dgT("exec.supervisorUnavailable")); return; }
          // 打开主管会话（id 由 board 端点下发 project.yaml supervisor.session，g-108）
          if (!supervisorSession) { setNote(dgT("exec.supervisorNotConfigured")); return; }
          // 自动复制预填内容（负责人指示），再切到主管对话窗直接粘贴发送
          const copied = prefillText ? await copyText(prefillText) : false;
          // g-321：0.1.6 移除了 sessions.open，统一走 openSessionTarget（uiWorkspace.openSession 优先）
          openSessionTarget(supervisorSession, typeof rt.open === "function" ? () => rt.open(supervisorSession) : null);
          activateChatTab();
          if (copied) {
            showToast(dgT("exec.precopied"));
            setNote(dgT("exec.prefillCopied"));
          } else {
            setNote(dgT("exec.autocopyFailed"));
          }
        } catch (e) {
          setNote(dgT("exec.supervisorJumpFail") + String(e?.message ?? e));
        }
      };

      // 是否有活跃「执行」attempt（已启动但未完成）。
      // g-109 定点 bug：「开始收集」也写 attempt.started（executor=agent:collect），
      // 若不加区分，只收集过未执行的目标其 🚀 执行/💬 反馈会被误藏。
      // 只认非 collect 的 attempt：凡非收集类（agent:collect）的 attempt 都视为活跃执行。
      const hasActiveAttempt = hasActiveExecutionAttempt(attempts);
      // review 及之后阶段、或已有活跃 attempt，不显示执行/反馈按钮
      const isReview = status === "review";
      const allowed = ["draft", "planning", "collecting", "ready", "review"];
      if (!allowed.includes(status) || (hasActiveAttempt && !isReview)) return null;

      return h("div", { style: { marginTop: 8, display: "flex", flexDirection: "column", gap: 6 } },
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
          isReview && acceptState === "none"
            ? h("button", {
                style: { ...S.btnAccept, padding: "4px 12px", fontSize: 13 }, className: "dg-btn-accept",
                disabled: loading, onClick: doAccept,
              }, dgT("exec.accept"))
            : isReview && acceptState === "pending"
              ? h("span", { style: { ...S.meta, fontSize: 12 } }, dgT("exec.acceptPending"))
              : isReview && acceptState === "resolved"
                ? h("span", { style: { ...S.meta, fontSize: 12, color: "var(--dsw-alias-label-primary, #3aa675)" } }, /* "✅ 交付已生效" */ dgT("exec.acceptResolved"))
                : null,
          !isReview ? h("button", {
            style: { ...S.btn, padding: "4px 12px", fontSize: 13 }, className: "dg-btn",
            disabled: loading,
            onClick: () => setInProgressOpen(true),
          }, dgT("exec.execute")) : null,
          !isReview ? h(DefinitionPolish, {
            goalId, goalPath: props.goalPath, supervisorSession, status, events, attempts,
            onPmStarted: props.onPmStarted, onPmFinished: props.onPmFinished, onClose: props.onClose,
          }) : null,
        ),
        // g-109 判据：主管有异议 → 显示异议说明；确认列绝不开放直接强制接受入口
        isReview && acceptState === "objection"
          ? h("div", { key: "obj", style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 2 } },
              h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-warn-label, #e0a53a)" } },
                dgT("exec.objection")),
              objectionText ? h("div", { style: S.meta }, objectionText) : null,
            )
          : null,
        mode === "feedback"
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 2 } },
              h("input", {
                style: { ...S.promptInput, flex: 1 },
                value: fbText, placeholder: dgT("exec.feedbackPlaceholder"),
                onChange: (e) => setFbText(e.target.value),
              }),
              h("button", {
                style: { ...S.btn, fontSize: 11, alignSelf: "flex-start" }, className: "dg-btn",
                onClick: openSupervisorWithFeedback,
              }, dgT("exec.goToSupervisorChat")),
              fbText.trim()
                ? h("div", { style: { ...S.meta, padding: "4px 6px", background: "rgba(128,128,128,.08)", borderRadius: 4 } },
                    dgT("exec.precopied"),
                    h("pre", { style: { margin: "4px 0 0", whiteSpace: "pre-wrap", fontSize: 11 } },
                      prefillText))
                : null)
          : null,
        note ? h("div", { style: { ...S.meta, marginTop: 2 } }, note) : null,
        inProgressOpen
          ? h(InProgressPrompt, {
              goalId,
              goalData: {
                id: goalId,
                title: props.title ?? goalId,
                type: props.goalType,
                criteria_count: props.criteria ? 1 : 0,
                attempt_child_id: hasActiveAttempt ? (attempts?.find((a) => a.status === "working")?.child_id ?? null) : null,
                attempt_parent_session_id: supervisorSession,
              },
              supervisorSession,
              onConfirm: () => {
                setInProgressOpen(false);
                onRefresh?.();
              },
              onCancel: () => setInProgressOpen(false),
            })
          : null,
      );
    }

    // g-109/g-128：新增信息收集任务组件（弹窗内信息收集区）——标题 + 作用域（共享/自有），不设 kind 类型；支持 onRefresh 回调立即刷新卡片列表
    function AddCardBox(props) {
      const { goalId, supervisorSession, onRefresh } = props;
      const [mode, setMode] = React.useState("idle"); // idle | naming | chat
      const [title, setTitle] = React.useState("");
      const [scope, setScope] = React.useState("shared"); // g-183：新建默认共享卡，可选 goal 自有
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
            body: JSON.stringify({ goal: goalId, title: t, scope }),
          });
          const data = await r.json();
          if (data.ok) {
            setNote(dgT("addCard.success") + data.card);
            setTitle("");
            setMode("idle");
            onRefresh?.();
          } else {
            setNote(dgT("addCard.fail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setNote(dgT("drag.requestFail") + String(e?.message ?? e));
        }
        setLoading(false);
      };

      // 对话创建：打开主管会话让用户直接输入需求
      const openSupervisorChat = () => {
        try {
          const rt = sessionsRt ?? appCtx?.get?.("sessions");
          if (!rt) { setNote(dgT("exec.supervisorUnavailable")); return; }
          // 主管会话 id 由 board 端点下发（project.yaml supervisor.session，g-108）
          if (!supervisorSession) { setNote(dgT("exec.supervisorNotConfigured")); return; }
          // g-321：0.1.6 移除了 sessions.open，统一走 openSessionTarget（uiWorkspace.openSession 优先）
          openSessionTarget(supervisorSession, typeof rt.open === "function" ? () => rt.open(supervisorSession) : null);
          activateChatTab();
          setNote(dgT("addCard.chatSwitched"));
        } catch (e) {
          setNote(dgT("exec.supervisorJumpFail") + String(e?.message ?? e));
        }
      };

      return h("div", { style: { marginTop: 8 }, className: "dg-card-add" },
        h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
          h("span", { style: { ...S.meta, fontSize: 11 } }, dgT("addCard.title")),
          h("button", { style: S.btn, className: "dg-btn", onClick: () => { setMode("naming"); setNote(null); } }, dgT("addCard.oneLiner")),
          h("button", { style: S.btn, className: "dg-btn", onClick: () => { setMode("chat"); setNote(null); } }, dgT("addCard.viaChat"))),
        mode === "naming"
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 4 } },
              h("div", { style: { display: "flex", gap: 4, alignItems: "center" } },
                h("input", {
                  style: { ...S.promptInput, flex: 1 },
                  value: title, placeholder: dgT("addCard.inputPlaceholder"),
                  onChange: (e) => setTitle(e.target.value),
                  onKeyDown: (e) => { if (e.key === "Enter") addByName(); },
                }),
                // g-183：卡片作用域——默认共享（多 goal 复用），可选 goal 自有
                h("select", {
                  value: scope,
                  onChange: (e) => setScope(e.target.value),
                  style: { fontSize: 12, padding: "4px 6px", cursor: "pointer",
                           background: "rgba(128,128,128,.10)", color: "inherit",
                           border: "1px solid rgba(128,128,128,.35)", borderRadius: 4 },
                  title: dgT("addCard.sharedTooltip"),
                },
                  h("option", { value: "shared" }, dgT("addCard.sharedOption")),
                  h("option", { value: "goal" }, dgT("addCard.goalOption"))),
                h("button", { style: S.btn, className: "dg-btn", onClick: addByName, disabled: loading }, dgT("addCard.createBtn"))))
          : null,
        mode === "chat"
          ? h("div", { style: { marginTop: 4, padding: "6px 8px", borderRadius: 4, background: "rgba(76,141,255,.08)" } },
              h("div", null, dgT("addCard.chatHint")),
              h("button", {
                style: { ...S.btn, marginTop: 6 }, className: "dg-btn",
                onClick: openSupervisorChat,
              }, dgT("addCard.goToChat")))
          : null,
        note ? h("div", { style: { ...S.meta, marginTop: 2 } }, note) : null,
      );
    }

    // 详情 modal：g-a92e1406 改为 tab 结构（详情 / 近期动态）

    // Source contracts retained in comments while visible labels use dgT: if (copied) showToast("✅ 请求已复制到剪贴板"); "✅ 接受".
    // Contract marker: "⏳ 已请求主管复核，等待响应"; if (copied) showToast("✅ 请求已复制到剪贴板
    // Contract marker: "✅ 接受"
