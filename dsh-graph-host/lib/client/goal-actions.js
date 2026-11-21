    // 质量判据 checklist（确认阶段）：每条一个勾选框（localStorage 按目标持久化，仅前端评审草稿）
    // + 「💬 反馈」按钮——展开输入框，经 session.prompt 排队送达该目标的执行会话（复用 g-107 通路）；
    //   无活执行会话时按 g-478 回退直发主管会话（promptSessionQueue），不再丢弃反馈。
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
        // g-478（负责人 2026-10-11 钦定）：**无活执行会话时不再丢弃反馈，改回退直发主管会话**。
        // 该分支命中的场景：目标当前没有在跑的 attempt / 执行子代理已结束·已解绑·已删除 /
        // 任务由主管自做或由别的子代理完成 —— 此时 useBoundSession 必然为空。
        // 三段式：①有活执行会话 → 下方原逻辑逐字不变；②无活执行会话 → 转主管（本分支）；
        // ③主管会话也不可用/投递未获正向回执 → 明确报错，绝不谎报成功。
        if (!session?.prompt) {
          const rt = sessionsRt ?? appCtx?.get?.("sessions");
          if (!rt || !props.supervisorSession) { setFbNote(dgT("criteria.feedbackNotConnected")); return; }
          try {
            // g-496：模板正文取自宿主只读资产（**先取模板再投递**）；读取失败 → 明确报错、保持输入，绝不发空串。
            let text;
            try {
              text = await renderGuiPrompt("gui-criteria-feedback-supervisor",
                { goalId: props.goalId, criterion, feedback: t });
            } catch (e) {
              console.warn("[dsh-graph-host] criteria feedback: prompt asset load failed:", e);
              setFbNote(dgT("gui.promptAssetLoadFail"));
              return;
            }
            // 投递裁决一律交给共享 helper promptSessionQueue（session-hooks.js，全仓唯一裁决点）：
            // 能力探测（using / retain / 0.1.5 被动回退）由它内部分流，本处**绝不**写第二份探测或版本号分支。
            const delivered = await promptSessionQueue(rt, props.supervisorSession,
              [{ type: "text", text }],
              "[dsh-graph-host] criteria feedback: prompt supervisorSession failed:");
            // 仅正向回执（res.ok === true，已由 helper 收口）算送达；负回执 / 空回执 / 取不到会话一律未送达。
            if (!delivered) { setFbNote(dgT("criteria.feedbackNotConnected")); return; }
            setFbNote(dgT("criteria.feedbackSupervisorDelivered"));
            setFbText("");
            setFbIdx(-1);
            // 与既有主管直发 UX（AcceptFeedback.openSupervisor）一致：打开主管会话并切到对话页便于跟进；
            // 不关弹窗 —— 区分性提示需留在原地可见（g-478 与既有 g-109 关弹窗行为的差异点）。
            openSessionTarget(props.supervisorSession);
            activateChatTab();
            showToast(dgT("criteria.feedbackSupervisorDelivered"));
          } catch (e) {
            // promptSessionQueue 自身绝不抛（内部兜底）；此处仅最后一道防线：明示未送达，绝不谎报成功。
            console.warn("[dsh-graph-host] criteria feedback: prompt supervisorSession failed:", e);
            setFbNote(dgT("criteria.feedbackNotConnected"));
          }
          return;
        }
        try {
          // g-496：模板取自宿主只读资产（先取模板再投递）；失败保持输入、明确报错，绝不发空串。
          let text;
          try {
            text = await renderGuiPrompt("gui-criteria-feedback-executor",
              { goalId: props.goalId, criterion, feedback: t });
          } catch (e) {
            console.warn("[dsh-graph-host] criteria feedback: prompt asset load failed:", e);
            setFbNote(dgT("gui.promptAssetLoadFail"));
            return;
          }
          const res = await session.prompt([{ type: "text", text }], "queue");
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
      // g-496：复制失败时的手动复制预览正文（模板改为异步取资产后，渲染期不再能同步算出它，
      // 故用 state 承接；`request` 这个**契约名**保留给「可复制的请求正文」这一语义，
      // 使既有的复制兜底契约（copyText(request) / value: request）逐字不变）。
      const [request, setRequest] = React.useState("");
      const allowed = ["draft", "planning", "collecting", "ready"];
      const hasActiveAttempt = hasActiveExecutionAttempt(attempts);
      if (!allowed.includes(status) || hasActiveAttempt) return null;
      const openSupervisor = async () => {
        setLoading(true); setNote(null);
        try {
          const rt = sessionsRt ?? appCtx?.get?.("sessions");
          if (!rt) throw new Error(dgT("exec.supervisorUnavailable"));
          if (!supervisorSession) throw new Error(dgT("exec.supervisorNotConfigured"));
          // g-496：模板正文取自宿主只读资产（宿主专属层 md），**先取模板再投递/复制**。
          // 读取失败 → 明确报错、保持用户补充意见，绝不发送空串或半截正文。
          // 路径未知时的「（路径未知）」占位与「（无）」占位是**插值变量**（UI 层语义，随 locale），
          // 不进资产正文：资产只持有模板骨架。
          const text = await renderGuiPrompt("gui-define-polish-request", {
            goalId,
            goalPath: String(goalPath ?? dgT("exec.goalPathUnknown")),
            guidance: guidance.trim() || dgT("exec.guidanceNone"),
          });
          // g-327：能直发就直发——先尝试投递恰好一条 queue 消息给主管会话。
          // 能力探测（using / retain / 0.1.5 被动回退）全部由共享 helper promptSessionQueue 内部分流，
          // 本处只按它的返回值判定，**绝不**写版本号分支、也绝不自带第二份 using/retain 探测。
          const delivered = await promptSessionQueue(rt, supervisorSession,
            [{ type: "text", text }],
            "[dsh-graph-host] define/polish: prompt supervisorSession failed:");
          if (delivered) {
            // 直发成功：消息已投递给主管会话，不再写剪贴板（负责人要求「直接发不需要复制一份」）；
            // 仍打开主管会话便于负责人跟进。
            openSessionTarget(supervisorSession);
            activateChatTab();
            setMode("supervisor");
            setFallback(false);
            // g-496：直发成功即清掉手动复制预览正文（避免上一次失败残留的旧文本被展示）。
            setRequest("");
            showToast(dgT("exec.requestDelivered"));
            setNote(dgT("exec.requestDeliveredOpened"));
            setLoading(false);
            return;
          }
          // 投递不可用（无会话服务 / 未配置 supervisor.session / 会话取不到 / 无 prompt / 任意异常）
          // → 以下完整退回 g-168 原复制契约，逐字不变（含复制失败时的手动复制预览）。
          const copied = await copyText(text);
          // 会话导航统一走 openSessionTarget（uiWorkspace.openSession）
          openSessionTarget(supervisorSession);
          activateChatTab();
          if (copied) showToast(dgT("exec.requestCopied"));
           setMode("supervisor");
           setFallback(!copied);
          // g-496：复制失败时的**手动复制预览**必须显示刚渲染出的同一份正文
          // （模板现在异步取资产，不再是渲染期同步可读的）⇒ 存入 state 供预览读取。
          if (!copied) setRequest(text);
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

    // g-109：目标描述区执行/接受交互组件（执行按钮打开 InProgressPrompt 创建子代理；接受默认经主管
    // Agent 复核，异议在按钮处显示说明；确认列不提供强制接受入口）
    function AcceptFeedback(props) {
      const { goalId, status, events, supervisorSession, onRefresh } = props;
      const { attempts } = props;
      const [note, setNote] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [inProgressOpen, setInProgressOpen] = React.useState(false);

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
              // g-496：模板正文取自宿主只读资产（**先取模板再投递**）。注意：**接受本身已成功**
              // （服务端已写 review.requested），因此模板读取失败**只**降级为「通知未送达」的可见
              // 警告，**绝不**回滚/改判已成功的接受（与下方 pending 投递失败同一口径）。
              let parts;
              try {
                const text = await renderGuiPrompt("gui-accept-review-request", { goalId });
                parts = [{ type: "text", text }];
              } catch (e) {
                console.warn("[dsh-graph-host] accept: prompt asset load failed:", e);
                if (supervisorSession) setNote(dgT("exec.acceptNotifyFail"));
                onRefresh?.();
                setLoading(false);
                return;
              }
              // g-323：与批量接受（batch-accept.js 的 notifySupervisorBatchAccept）共用同一份能力探测 helper：
              // 0.1.6 需先 retain 才借得到 binding（无 get(id)），0.1.5 保持被动 binding ?? get 回退。
              // 本处是事件回调（doAccept），绝不引入渲染期 retain；文案与 queue 模式逐字不变。
              // g-386：消费投递回执。接受本身已成功（服务端已写 review.requested），此处**只补可见提示**，
              // 绝不回滚/改判接受结果（`data.pending` 分支照常 onRefresh）。
              const notified = await promptSessionQueue(rt, supervisorSession, parts, "[dsh-graph-host] prompt supervisorSession failed:");
              if (supervisorSession && !notified) setNote(dgT("exec.acceptNotifyFail"));
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
      // 是否有活跃「执行」attempt（已启动但未完成）。
      // g-109 定点 bug：「开始收集」也写 attempt.started（executor=agent:collect），
      // 若不加区分，只收集过未执行的目标其 🚀 执行入口会被误藏。
      // 只认非 collect 的 attempt：凡非收集类（agent:collect）的 attempt 都视为活跃执行。
      const hasActiveAttempt = hasActiveExecutionAttempt(attempts);
      // review 及之后阶段、或已有活跃 attempt，不显示执行入口
      const isReview = status === "review";
      const allowed = ["draft", "planning", "collecting", "ready", "review"];
      if (!allowed.includes(status) || (hasActiveAttempt && !isReview)) return null;

      // g-436：独立评审可见化（**只标注、不阻断**）。strict 目标当前候选没有可审计的独立评审
      // PASS 记录时，在 accept 交互处如实显示「未独立评审」——但不隐藏/禁用接受按钮，
      // 默认 accept 路径与结果逐字不变（可见化只读 `review_state` 投影，不改任何写入语义）。
      const rs = props.reviewState ?? null;
      // r3（Lane A R2-1）：徽标与 independent_ok 针对 **current_candidate_sha**（最近一次被请求评审的候选），
      // **不等于 HEAD** —— 把该候选短 SHA 直接显示在徽标旁（tooltip 说明口径），避免读板者误以为
      // 「这个 PASS 就是对当前 HEAD 的」。仍是只读可见化：不改任何写入语义、不禁用接受按钮。
      const rvSha = typeof rs?.current_candidate_sha === "string" && rs.current_candidate_sha.trim()
        ? rs.current_candidate_sha.trim().slice(0, 7)
        : null;
      const rvShaTitle = rvSha ? `${dgT("exec.reviewCandidateTitle")} ${rvSha}` : null;
      const rvBadge = (() => {
        if (!rs) return null;
        if (rs.independent_missing) {
          return { text: dgT("exec.reviewMissing"), title: dgT("exec.reviewMissingTitle"), className: "dg-review-missing", color: "var(--dsw-alias-state-warn-label, #e0a53a)" };
        }
        if (rs.status === "pass" && rs.independent_ok) {
          return { text: dgT("exec.reviewPass"), title: null, className: "dg-review-pass", color: "var(--dsw-alias-label-primary, #3aa675)" };
        }
        if (rs.status === "block") return { text: dgT("exec.reviewBlock"), title: null, className: "dg-review-block", color: "var(--dsw-alias-state-warn-label, #e0a53a)" };
        if (rs.status === "in_progress") return { text: dgT("exec.reviewInProgress"), title: null, className: "dg-review-pending", color: null };
        if (rs.status === "unverified" || rs.status === "failed") {
          return { text: dgT("exec.reviewUnverified"), title: null, className: "dg-review-unverified", color: "var(--dsw-alias-state-warn-label, #e0a53a)" };
        }
        return null;
      })();

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
          // g-436：独立评审状态标注（位于接受入口旁，如实可见）
          isReview && rvBadge
            ? h("span", {
                style: { ...S.meta, fontSize: 12, ...(rvBadge.color ? { color: rvBadge.color } : {}) },
                className: rvBadge.className,
                ...(rvBadge.title || rvShaTitle ? { title: rvBadge.title ?? rvShaTitle } : {}),
              }, rvBadge.text)
            : null,
          // r3：被评审候选短 SHA（可见化口径 —— PASS 是对这个提交的，不是对 HEAD 的）
          isReview && rvBadge && rvSha
            ? h("span", {
                style: { ...S.meta, fontSize: 11, opacity: 0.75 },
                className: "dg-review-sha",
                title: rvShaTitle,
              }, `@${rvSha}`)
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
          // 会话导航统一走 openSessionTarget（uiWorkspace.openSession）
          openSessionTarget(supervisorSession);
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
