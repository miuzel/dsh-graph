    }

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

    // g-168：仅将确实在执行中的非收集 attempt 视为活跃。
    // result=pending 本身不够：旧 attempt 可能长期 pending，需 status_line 明确未结束。
    function hasActiveExecutionAttempt(attempts) {
      return (attempts ?? []).some((a) => {
        if (a?.executor === "agent:collect" || a?.result !== "pending") return false;
        const line = String(a?.status_line ?? "").trim();
        return line !== "" && !/空闲|完成|待命|已交付|结束|等待|finished|done|idle|completed/i.test(line);
      });
    }

    // g-168：定义/润色入口。两条路径都只产生建议，不改目标或状态。
    function DefinitionPolish(props) {
      const { goalId, goalPath, supervisorSession, status, attempts } = props;
      const [mode, setMode] = React.useState("idle"); // idle | supervisor | pm
      const [guidance, setGuidance] = React.useState("");
      const [note, setNote] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [fallback, setFallback] = React.useState(false);
      const allowed = ["draft", "planning", "collecting", "ready"];
      const hasActiveAttempt = hasActiveExecutionAttempt(attempts);
      if (!allowed.includes(status) || hasActiveAttempt) return null;
      const request = `【${goalId} 定义/润色请求】\n目标 ID：${goalId}\ngoal.md 工作区相对路径：${String(goalPath ?? "（路径未知）")}\n人工指导意见：${guidance.trim() || "（无）"}`;
      const openSupervisor = async () => {
        setLoading(true); setNote(null);
        try {
          const rt = sessionsRt ?? appCtx?.get?.("sessions");
          if (!rt) throw new Error("会话服务不可用");
          if (!supervisorSession) throw new Error("未配置主管会话（project.yaml 的 supervisor.session）");
          const copied = await copyText(request);
          rt.open?.(supervisorSession); activateChatTab();
          setMode("supervisor");
           setFallback(!copied);
          setNote(copied ? "✅ 请求已复制，已打开主管会话，请粘贴发送" : "⚠️ 自动复制失败，请手动复制下方请求");
        } catch (e) { setNote("⚠️ 主管路径失败：" + String(e?.message ?? e)); }
        setLoading(false);
      };
      const askPm = async () => {
        setLoading(true); setMode("pm"); setNote("⏳ 产品经理 Agent 正在处理…");
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/define-polish"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: goalId, goal_path: goalPath, guidance: guidance.trim() }) });
          const data = await r.json();
          if (data.ok) setNote("✅ 产品经理 Agent 已受理，建议将返回主管会话");
          else setNote("⚠️ 产品经理 Agent 失败：" + (data.child_error || data.error || "未知错误"));
        } catch (e) { setNote("⚠️ 产品经理 Agent 失败：" + String(e?.message ?? e)); }
        setLoading(false);
      };
      return h("div", null,
        h("button", { style: { ...S.btn, padding: "4px 12px", fontSize: 13 }, className: "dg-btn", disabled: loading, onClick: () => { setMode(mode === "idle" ? "supervisor" : "idle"); setNote(null); } }, "📝 定义/润色"),
        mode !== "idle" ? h("div", { style: { display: "flex", flexDirection: "column", gap: 5, marginTop: 5 } },
          h("div", { style: S.meta }, "可填写额外指导意见，再选择处理方式："),
          h("textarea", { style: { ...S.promptInput, minHeight: 48, resize: "vertical", fontFamily: "inherit", fontSize: 12 }, value: guidance, placeholder: "人工指导意见（可选）…", onChange: (e) => setGuidance(e.target.value) }),
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
            h("button", { style: S.btn, className: "dg-btn", disabled: loading, onClick: openSupervisor }, "发送给主管（复制请求）"),
            h("button", { style: S.btn, className: "dg-btn", disabled: loading, onClick: askPm }, "交给产品经理 Agent")),
          note ? h("div", { style: S.meta }, note) : null,
          fallback ? h("textarea", { readOnly: true, value: request, style: { ...S.promptInput, minHeight: 72, resize: "vertical", fontFamily: "monospace", fontSize: 11 }, "aria-label": "定义润色请求手动复制内容" }) : null) : null);
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
            onRefresh?.(); // g-148：刷新看板（回调由父组件 GoalModal 传入）
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
      const hasActiveAttempt = hasActiveExecutionAttempt(attempts);
      // review 及之后阶段、或已有活跃 attempt，不显示执行/反馈按钮
      const allowed = ["draft", "planning", "collecting", "ready"];
      if (!allowed.includes(status) || hasActiveAttempt) return null;

      return h("div", { style: { marginTop: 8, display: "flex", flexDirection: "column", gap: 6 } },
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
          acceptState === "none"
            ? h("button", {
                style: { ...S.btnAccept, padding: "4px 12px", fontSize: 13 }, className: "dg-btn-accept",
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
          h(DefinitionPolish, {
            goalId, goalPath: props.goalPath, supervisorSession, status, events, attempts,
          })),
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
                        style: { ...S.btnAccept, fontSize: 12 }, className: "dg-btn-accept",
                        disabled: loading, onClick: doForceAccept,
                      }, "确认强制接受"),
                      h("button", {
                        style: { ...S.btn, fontSize: 12 }, className: "dg-btn",
                        disabled: loading, onClick: () => { setForceMode(false); setForceReason(""); },
                      }, "取消")),
                  ]
                : h("button", {
                    style: { ...S.btnAccept, fontSize: 12, alignSelf: "flex-start" }, className: "dg-btn-accept",
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
    // g-128：新增信息收集任务组件（弹窗内信息收集区）——支持标题+kind 选择
    function AddCardBox(props) {
      const { goalId, supervisorSession } = props;
      const [mode, setMode] = React.useState("idle"); // idle | naming | chat
      const [title, setTitle] = React.useState("");
      const [kind, setKind] = React.useState("text"); // g-128：卡片类型可选
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
            body: JSON.stringify({ goal: goalId, title: t, kind }),
          });
          const data = await r.json();
          if (data.ok) {
            setNote("✅ 已创建任务：" + data.card);
            setTitle("");
            setKind("text");
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

      // g-128：kind 选项标签
      const kindLabels = { text: "📝 文本", file: "📄 文件", image: "🖼 图片", data: "📊 数据" };

      return h("div", { style: { marginTop: 8 }, className: "dg-card-add" },
        h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
          h("span", { style: { ...S.meta, fontSize: 11 } }, "新增信息收集任务："),
          h("button", { style: S.btn, className: "dg-btn", onClick: () => { setMode("naming"); setNote(null); } }, "📝 一句话任务"),
          h("button", { style: S.btn, className: "dg-btn", onClick: () => { setMode("chat"); setNote(null); } }, "💬 通过对话创建")),
        mode === "naming"
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 4 } },
              h("div", { style: { display: "flex", gap: 4, alignItems: "center" } },
                h("input", {
                  style: { ...S.promptInput, flex: 1 },
                  value: title, placeholder: "输入任务描述…",
                  onChange: (e) => setTitle(e.target.value),
                  onKeyDown: (e) => { if (e.key === "Enter") addByName(); },
                }),
                // g-128：kind 选择下拉框
                h("select", {
                  value: kind,
                  onChange: (e) => setKind(e.target.value),
                  style: { fontSize: 12, padding: "4px 6px", cursor: "pointer",
                           background: "rgba(128,128,128,.10)", color: "inherit",
                           border: "1px solid rgba(128,128,128,.35)", borderRadius: 4 },
                },
                  ...Object.entries(kindLabels).map(([k, v]) =>
                    h("option", { key: k, value: k }, v))),
                h("button", { style: S.btn, className: "dg-btn", onClick: addByName, disabled: loading }, "创建")))
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
