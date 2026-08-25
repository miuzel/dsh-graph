    // g-150：handoff 组件（显示当前有效 handoff + 登记新 handoff）
    function HandoffBox(props) {
      const { goalId, handoff, attempts, onRefresh } = props;
      const [showForm, setShowForm] = React.useState(false);
      const [form, setForm] = React.useState({ source_attempts: "", failures: "", constraints: "", baseline: "", verification: "" });
      const [note, setNote] = React.useState(null);
      const [loading, setLoading] = React.useState(false);

      const doRecord = async () => {
        const src = form.source_attempts.split(",").map((s) => s.trim()).filter(Boolean);
        if (!src.length) { setNote("⚠️ 来源 attempt 不能为空"); return; }
        if (!form.failures.trim() || !form.constraints.trim() || !form.baseline.trim() || !form.verification.trim()) {
          setNote("⚠️ 所有字段必填"); return;
        }
        setLoading(true);
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/record-handoff"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: goalId, source_attempts: src, ...form }),
          });
          const data = await r.json();
          if (data.ok) {
            setNote("✅ handoff 已登记");
            setShowForm(false);
            setForm({ source_attempts: "", failures: "", constraints: "", baseline: "", verification: "" });
            onRefresh?.();
          } else {
            setNote("⚠️ 登记失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setLoading(false);
      };

      const hasHf = handoff && handoff.failures;
      const attOptions = (attempts ?? []).map((a) => a.id);

      return h("div", { style: S.modalSection },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
          h("div", { style: S.modalH },
            "🔄 返工 Handoff",
            hasHf ? h("span", { style: { ...S.meta, fontSize: 11, marginLeft: 4, fontWeight: 400 } },
              `（rev ${handoff.revision}，来源：${(handoff.source_attempts ?? []).join(", ")}）`) : null),
          h("button", {
            style: { ...S.btn, fontSize: 11, padding: "1px 6px" }, className: "dg-btn",
            onClick: () => { setShowForm(!showForm); setNote(null); },
          }, showForm ? "取消" : hasHf ? "✏️ 更新 Handoff" : "📝 登记 Handoff")),
        // 显示当前 handoff
        hasHf
          ? h("div", { style: { marginTop: 6, display: "flex", flexDirection: "column", gap: 4, fontSize: 12 } },
              h("div", { style: { opacity: 0.65, fontSize: 11 } },
                `确认人：${handoff.confirmed_by}　｜　时间：${handoff.confirmed_at}`),
              h("div", null,
                h("strong", null, "已核实失败/风险："),
                h("div", { style: { whiteSpace: "pre-wrap", lineHeight: 1.4, marginTop: 2 } }, handoff.failures)),
              h("div", null,
                h("strong", null, "返工约束（禁止项）："),
                h("div", { style: { whiteSpace: "pre-wrap", lineHeight: 1.4, marginTop: 2 } }, handoff.constraints)),
              h("div", null,
                h("strong", null, "推荐基线/必须保留项："),
                h("div", { style: { whiteSpace: "pre-wrap", lineHeight: 1.4, marginTop: 2 } }, handoff.baseline)),
              h("div", null,
                h("strong", null, "验收命令："),
                h("div", { style: { whiteSpace: "pre-wrap", lineHeight: 1.4, marginTop: 2 } }, handoff.verification)))
          : h("div", { style: { ...S.meta, fontSize: 12, opacity: 0.6, marginTop: 4 } }, "（无已登记 handoff）"),
        // 登记表单
        showForm
          ? h("div", { style: { marginTop: 8, display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", borderRadius: 6, background: "rgba(128,128,128,.08)" } },
              h("div", { style: { fontSize: 11, opacity: 0.7 } }, hasHf ? "更新将覆盖当前 handoff（revision 递增）" : "登记后新 attempt 派发时自动注入"),
              h("div", null,
                h("label", { style: { fontSize: 11, opacity: 0.8 } }, "来源 attempt（逗号分隔）"),
                attOptions.length
                  ? h("div", { style: { display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 } },
                      ...attOptions.map((a) =>
                        h("button", {
                          key: a, style: { ...S.btn, fontSize: 11, padding: "1px 6px",
                            background: form.source_attempts.includes(a) ? "rgba(76,141,255,.25)" : undefined },
                          className: "dg-btn",
                          onClick: () => {
                            const cur = form.source_attempts.split(",").map((s) => s.trim()).filter(Boolean);
                            const next = cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a];
                            setForm({ ...form, source_attempts: next.join(", ") });
                          },
                        }, a)))
                  : null,
                h("input", {
                  style: { ...S.promptInput, fontSize: 12, marginTop: 2 }, value: form.source_attempts,
                  onChange: (e) => setForm({ ...form, source_attempts: e.target.value }),
                  placeholder: "att-001, att-002",
                })),
              ...[
                ["failures", "已核实失败/风险"],
                ["constraints", "返工约束（禁止项）"],
                ["baseline", "推荐基线/必须保留项"],
                ["verification", "验收命令"],
              ].map(([key, label]) =>
                h("div", { key },
                  h("label", { style: { fontSize: 11, opacity: 0.8 } }, label),
                  h("textarea", {
                    style: { ...S.promptInput, minHeight: 36, resize: "vertical", fontFamily: "inherit", fontSize: 12, marginTop: 2, width: "100%", boxSizing: "border-box" },
                    value: form[key],
                    onChange: (e) => setForm({ ...form, [key]: e.target.value }),
                    placeholder: label,
                  }))),
              h("button", {
                style: { ...S.btn, fontSize: 12, alignSelf: "flex-start" }, className: "dg-btn",
                disabled: loading, onClick: doRecord,
              }, "✅ 登记 Handoff"))
          : null,
        note ? h("div", { style: { ...S.meta, marginTop: 2, fontSize: 11 } }, note) : null);
    }

    // g-150：最近指令组件（显示 + 编辑）
    function DirectiveBox(props) {
      const { goalId, directive, onRefresh } = props;
      const [editing, setEditing] = React.useState(false);
      const [text, setText] = React.useState(directive ?? "");
      const [note, setNote] = React.useState(null);
      const [loading, setLoading] = React.useState(false);

      // 同步外部 directive 变化
      React.useEffect(() => { setText(directive ?? ""); }, [directive]);

      const doSave = async () => {
        setLoading(true);
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/set-directive"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: goalId, directive: text }),
          });
          const data = await r.json();
          if (data.ok) {
            setNote("✅ 指令已更新");
            setEditing(false);
            onRefresh?.();
          } else {
            setNote("⚠️ 更新失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setLoading(false);
      };

      const doClear = async () => {
        setLoading(true);
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/set-directive"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: goalId, directive: "" }),
          });
          const data = await r.json();
          if (data.ok) {
            setNote("✅ 指令已清空");
            setText("");
            setEditing(false);
            onRefresh?.();
          } else {
            setNote("⚠️ 清空失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setLoading(false);
      };

      const hasContent = (directive ?? "").trim().length > 0;

      return h("div", { style: S.modalSection },
        h("div", { style: S.modalH },
          "📌 最近指令",
          h("span", { style: { ...S.meta, fontSize: 11, marginLeft: 6, fontWeight: 400 } },
            "（下次 attempt 自动注入；小范围修复优先 send_message 续办已有会话）")),
        editing
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
              h("textarea", {
                style: { ...S.promptInput, minHeight: 60, resize: "vertical", fontFamily: "inherit", fontSize: 12 },
                value: text,
                onChange: (e) => setText(e.target.value),
                placeholder: "输入对下次 attempt 的补充任务、边界和验收要求…",
              }),
              h("div", { style: { display: "flex", gap: 6 } },
                h("button", {
                  style: { ...S.btn, fontSize: 12 }, className: "dg-btn",
                  disabled: loading, onClick: doSave,
                }, "💾 保存"),
                text.trim()
                  ? h("button", {
                      style: { ...S.btn, fontSize: 12 }, className: "dg-btn",
                      disabled: loading, onClick: doClear,
                    }, "🗑 清空")
                  : null,
                h("button", {
                  style: { ...S.btn, fontSize: 12 }, className: "dg-btn",
                  disabled: loading, onClick: () => { setEditing(false); setText(directive ?? ""); setNote(null); },
                }, "取消")))
          : h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
              hasContent
                ? h("div", { style: { ...S.meta, whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.5, padding: "4px 0" } }, directive)
                : h("div", { style: { ...S.meta, fontSize: 12, opacity: 0.6 } }, "（无最近指令）"),
              h("button", {
                style: { ...S.btn, fontSize: 11, alignSelf: "flex-start" }, className: "dg-btn",
                onClick: () => { setEditing(true); setText(directive ?? ""); setNote(null); },
              }, hasContent ? "✏️ 编辑指令" : "📝 设置指令")),
        note ? h("div", { style: { ...S.meta, marginTop: 2, fontSize: 11 } }, note) : null);
    }

    // g-150：评论组件（历史查看 + 追加）
    function CommentsBox(props) {
      const { goalId, comments, onRefresh } = props;
      const [expanded, setExpanded] = React.useState(false);
      const [showAdd, setShowAdd] = React.useState(false);
      const [text, setText] = React.useState("");
      const [note, setNote] = React.useState(null);
      const [loading, setLoading] = React.useState(false);

      const doAdd = async () => {
        const t = text.trim();
        if (!t) return;
        setLoading(true);
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/add-comment"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: goalId, text: t }),
          });
          const data = await r.json();
          if (data.ok) {
            setNote("✅ 评论已添加");
            setText("");
            setShowAdd(false);
            onRefresh?.();
          } else {
            setNote("⚠️ 添加失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setLoading(false);
      };

      const count = comments.length;

      return h("div", { style: S.modalSection },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
          h("div", { style: S.modalH },
            "💬 评论",
            count > 0 ? h("span", { style: { ...S.meta, fontSize: 11, marginLeft: 4, fontWeight: 400 } }, `（${count} 条）`) : null),
          count > 0
            ? h("button", {
                style: { ...S.btn, fontSize: 11, padding: "1px 6px" }, className: "dg-btn dg-chevron",
                onClick: () => setExpanded(!expanded),
              }, expanded ? "▲" : "▼")
            : null,
          h("button", {
            style: { ...S.btn, fontSize: 11, padding: "1px 6px" }, className: "dg-btn",
            onClick: () => { setShowAdd(!showAdd); setNote(null); },
          }, showAdd ? "取消" : "➕ 添加评论")),
        // 评论历史（可展开/收起）
        expanded && count > 0
          ? h("div", { style: { marginTop: 6, maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 } },
              comments.map((c, i) =>
                h("div", { key: i, style: { padding: "6px 8px", borderRadius: 4, background: "rgba(128,128,128,.08)", fontSize: 12 } },
                  h("div", { style: { fontSize: 11, opacity: 0.65, marginBottom: 2 } }, `${c.ts} ｜ ${c.author}`),
                  h("div", { style: { whiteSpace: "pre-wrap", lineHeight: 1.4 } }, c.text))))
          : null,
        // 添加评论输入
        showAdd
          ? h("div", { style: { marginTop: 6, display: "flex", flexDirection: "column", gap: 4 } },
              h("textarea", {
                style: { ...S.promptInput, minHeight: 50, resize: "vertical", fontFamily: "inherit", fontSize: 12 },
                value: text,
                onChange: (e) => setText(e.target.value),
                placeholder: "输入评论内容…（可追溯的历史讨论/反馈）",
              }),
              h("button", {
                style: { ...S.btn, fontSize: 12, alignSelf: "flex-start" }, className: "dg-btn",
                disabled: loading || !text.trim(), onClick: doAdd,
              }, "💬 发表评论"))
          : null,
        note ? h("div", { style: { ...S.meta, marginTop: 2, fontSize: 11 } }, note) : null);
    }

    function GoalModal(props) {
      const [state, setState] = React.useState({ loading: true });
      const [tab, setTab] = React.useState("detail"); // "detail" | "context" | "activity"
      const [logSort, setLogSort] = React.useState("desc"); // "desc" | "asc"
      const [logFilter, setLogFilter] = React.useState(""); // "" 全部 / 事件名
      const [relaunchRoute, setRelaunchRoute] = React.useState(null); // g-109：最近一次重新执行的模型路由（显示兜底）
      const [criteriaOpen, setCriteriaOpen] = React.useState(false); // g-170：判据编辑弹窗（详情内「质量判据」标题处入口）
      const [renaming, setRenaming] = React.useState(false);
      const [newTitle, setNewTitle] = React.useState("");
      const [renameNote, setRenameNote] = React.useState(null);
      // g-158：类型编辑状态
      const [typeEditing, setTypeEditing] = React.useState(false);
      const [typeNote, setTypeNote] = React.useState(null);
      // g-148：load 提升到组件体，供 AcceptFeedback 通过 onRefresh 回调刷新详情
      const aliveRef = React.useRef(true);
      const load = React.useCallback(() =>
        fetch(graphUrl("/api/dsh-graph/goal", { id: props.id }))
          .then((r) => r.json())
          .then((data) => aliveRef.current && setState({ loading: false, data }))
          .catch((e) => aliveRef.current && setState({ loading: false, error: String(e) })),
      [props.id]);
      React.useEffect(() => {
        aliveRef.current = true;
        load();
        const t = setInterval(load, 20000);
        return () => { aliveRef.current = false; clearInterval(t); };
      }, [load]);

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
        // g-170：titleExtra 渲染在小节标题右侧（判据编辑入口用）
        function sectionBlock(key, title, body, extra, hideBodyWhenExtra, titleExtra) {
          const { isPh, marker, body: content } = parsePlaceholder(body);
          return h("div", { key, style: S.modalSection },
            h("div", { style: S.modalH },
              title,
              isPh && !content ? h("span", { style: { ...S.meta, fontSize: 12, marginLeft: 6, fontWeight: 400 } }, marker) : null,
              titleExtra ?? null),
            hideBodyWhenExtra && extra != null ? null : (isPh && !content ? null : content),
            extra ?? null);
        }
        // 判断是否是 backlog 目标（backlog 目标不能建卡）
        const isBacklog = d.goalFile && d.goalFile.includes("/backlog/") && !d.goalFile.endsWith("/goal.md");
        const detailTab = [
          desc != null ? sectionBlock("d", "📋 目标描述", desc,
            h(AcceptFeedback, { goalId: props.id, goalPath: String(d.goalFile ?? "").replace(/^.*?(?=\.dsh-graph[\\/])/, ""), title: d.title ?? props.title, description: desc, criteria: crit, status, events: d.events, attempts: d.attempts, supervisorSession: props.supervisorSession, onRefresh: load, onPmStarted: props.onPmStarted, onPmFinished: props.onPmFinished, onClose: props.onClose })) : null,
          // g-109：判据栏只在 ready 及之后阶段显示 checklist（已确认可勾选），早期阶段只显示纯文本
          // g-170：「✏️ 判据」编辑入口放在小节标题处（负责人 2026-08-25 指示），点击打开判据编辑弹窗
          crit != null ? sectionBlock("c", "✅ 质量判据", crit,
            !isPlaceholder(crit) && ["ready", "in_progress", "review", "delivered"].includes(status)
              ? h(CriteriaChecklist, { goalId: props.id, crit, att, onClose: props.onClose })
              : null, true,
            h("button", {
              style: { ...S.btnPrimary, fontSize: 11, padding: "1px 6px", marginLeft: 6, verticalAlign: "middle", opacity: 1 },
              className: "dg-btn",
              title: "编辑质量判据（保存后清空该目标已有勾选）",
              onClick: (e) => { e.stopPropagation(); setCriteriaOpen(true); },
            }, "✏️ 判据")) : null,
          (d.cards ?? []).length
            ? h("div", { key: "k", style: S.modalSection },
                h("div", { style: S.modalH }, "🗂 信息收集"),
                d.cards.map((c) => h("div", {
                  key: c.id,
                  style: { ...S.subCard, cursor: "pointer" },
                  className: "dg-sub",
                  title: "点击打开上下文抽屉",
                  onClick: (e) => {
                    e.stopPropagation();
                    if (props.onOpenCard) {
                      props.onOpenCard(props.id, c.id);
                    }
                  },
                }, `${CARD_STATUS_ICON[c.status] ?? c.status} ｜ ${c.title}（${c.kind}）`)),
                isBacklog
                  ? h("div", { style: { ...S.meta, marginTop: 4 } }, "（backlog 目标不能创建上下文卡片，请先排期）")
                  : h(AddCardBox, { goalId: props.id, supervisorSession: props.supervisorSession }))
            : h("div", { key: "k", style: S.modalSection },
                h("div", { style: S.modalH }, "🗂 信息收集"),
                h("div", { style: S.meta }, "（暂无上下文卡片）"),
                isBacklog
                  ? h("div", { style: { ...S.meta, marginTop: 4 } }, "（backlog 目标不能创建上下文卡片，请先排期）")
                  : h(AddCardBox, { goalId: props.id, supervisorSession: props.supervisorSession })),
        ];
        // g-150：执行上下文 tab（handoff + 最近指令 + 评论）
        const contextTab = [
          h(HandoffBox, { key: "hf", goalId: props.id, handoff: d.handoff, attempts: d.attempts, onRefresh: load }),
          h(DirectiveBox, { key: "dir", goalId: props.id, directive: d.directive, onRefresh: load }),
          h(CommentsBox, { key: "cmt", goalId: props.id, comments: d.comments ?? [], onRefresh: load }),
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
                style: S.select,
                className: "dg-select",
              },
                h("option", { value: "" }, "全部类型"), ...typeOptions),
              h("button", {
                onClick: () => setLogSort(logSort === "asc" ? "desc" : "asc"),
                style: { ...S.btn },
                className: "dg-btn",
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
            h("button", {
              style: {
                fontSize: 12, padding: "5px 14px", cursor: "pointer",
                marginBottom: -1, borderRadius: "6px 6px 0 0",
                border: "1px solid " + (tab === "context" ? "rgba(128,128,128,.35)" : "transparent"),
                borderBottom: "none",
                background: tab === "context" ? "rgba(128,128,128,.10)" : "transparent",
                fontWeight: tab === "context" ? 700 : 400,
                color: tab === "context" ? "#8ab4ff" : "inherit",
                opacity: tab === "context" ? 1 : 0.7,
              },
              onClick: () => setTab("context"),
            }, "📌 执行上下文"),
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
          }, tab === "detail" ? detailTab : tab === "context" ? contextTab : activityTab),
        ];
      }

      const doRename = async () => {
        const t = newTitle.trim();
        if (!t) { setRenameNote("标题不能为空"); return; }
        if (t === (props.title ?? props.id)) { setRenaming(false); return; }
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/rename-goal"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: props.id, title: t }),
          });
          const data = await r.json();
          if (data.ok) {
            setRenaming(false);
            setRenameNote(null);
            // 刷新详情数据
            const goalRes = await fetch(graphUrl("/api/dsh-graph/goal", { id: props.id }));
            const goalData = await goalRes.json();
            if (!goalData.error) setState({ loading: false, data: goalData });
            // 触发父组件刷新看板
            if (props.onRenamed) props.onRenamed(props.id, t);
          } else {
            setRenameNote("⚠️ 重命名失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setRenameNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
      };

      // g-158：设置目标类型（只改 type，不改变量生命周期语义）
      const doSetType = async (newType) => {
        setTypeNote(null);
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/set-goal-type"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: props.id, type: newType }),
          });
          const data = await r.json();
          if (data.ok) {
            setTypeEditing(false);
            setTypeNote(null);
            // 刷新详情数据
            const goalRes = await fetch(graphUrl("/api/dsh-graph/goal", { id: props.id }));
            const goalData = await goalRes.json();
            if (!goalData.error) setState({ loading: false, data: goalData });
            if (props.onRenamed) props.onRenamed(); // 刷新看板
          } else {
            setTypeNote("⚠️ 设置失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setTypeNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
      };

      // g-110: 归档/取消归档操作
      const [archiveNote, setArchiveNote] = React.useState(null);
      const isArchived = state.data?.meta?.archived === true;
      const canArchive = ["draft", "planning", "delivered"].includes(state.data?.meta?.status);
      // g-140: 删除操作（仅已归档目标可删除，二次确认）
      const [deleteConfirm, setDeleteConfirm] = React.useState(false);
      const [deleteNote, setDeleteNote] = React.useState(null);

      const doArchive = async () => {
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/archive"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: props.id }),
          });
          const data = await r.json();
          if (data.ok) {
            setArchiveNote("✅ 已归档");
            showToast("✅ 目标已归档");
            props.onArchived?.(); // 刷新看板：归档后卡片立即消失
            // 刷新详情
            const goalRes = await fetch(graphUrl("/api/dsh-graph/goal", { id: props.id }));
            const goalData = await goalRes.json();
            if (!goalData.error) setState({ loading: false, data: goalData });
          } else {
            setArchiveNote("⚠️ 归档失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setArchiveNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
      };

      const doUnarchive = async () => {
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/unarchive"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: props.id }),
          });
          const data = await r.json();
          if (data.ok) {
            setArchiveNote("✅ 已取消归档");
            showToast("✅ 已取消归档");
            props.onArchived?.(); // 刷新看板：取消归档后卡片回到看板
            // 刷新详情
            const goalRes = await fetch(graphUrl("/api/dsh-graph/goal", { id: props.id }));
            const goalData = await goalRes.json();
            if (!goalData.error) setState({ loading: false, data: goalData });
          } else {
            setArchiveNote("⚠️ 取消归档失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setArchiveNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
      };

      // g-140: 删除已归档目标（仅已归档目标可删除，二次确认）
      const doDelete = async () => {
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/delete"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: props.id }),
          });
          const data = await r.json();
          if (data.ok) {
            setDeleteNote("✅ 已删除");
            showToast("✅ 目标已删除");
            props.onArchived?.(); // 刷新看板：删除后卡片立即消失
            setDeleteConfirm(false);
          } else {
            setDeleteNote("⚠️ 删除失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setDeleteNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
      };

      // g-158：当前目标类型（从 state.data.meta.type 读取，回退 task）与类型色
      const currentType = normalizeGoalType(state.data?.meta?.type);
      const currentTypeColor = goalTypeColor(currentType);

      const titleEl = renaming
        ? h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 4 } },
            h("span", null, "🎯"),
            h("input", {
              style: { ...S.promptInput, flex: 1, fontSize: 15, fontWeight: 700 },
              value: newTitle,
              onChange: (e) => setNewTitle(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") doRename(); if (e.key === "Escape") setRenaming(false); },
              autoFocus: true,
            }),
            h("button", {
              style: { ...S.btn, padding: "2px 10px" }, className: "dg-btn",
              onClick: doRename,
            }, "确认"),
            h("button", {
              style: { ...S.btn, padding: "2px 10px" }, className: "dg-btn",
              onClick: () => { setRenaming(false); setRenameNote(null); },
            }, "取消"),
            renameNote ? h("span", { style: { ...S.meta, fontSize: 11, marginLeft: 4 } }, renameNote) : null)
        : h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
            // g-158：类型标记 badge（标题最左侧，颜色与弹窗顶部边框、卡片左栏同源）
            h("span", {
              style: {
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, lineHeight: "20px", borderRadius: 4, fontSize: 12, fontWeight: 700,
                background: currentTypeColor, color: "#fff", cursor: "pointer", flexShrink: 0,
              },
              title: `类型：${GOAL_TYPE_LABELS[currentType]}（点击切换）`,
              onClick: (e) => { e.stopPropagation(); setTypeEditing(!typeEditing); setTypeNote(null); },
            }, GOAL_TYPE_ABBREV[currentType]),
            // g-158：类型选择器弹出（点击 badge 展开）
            typeEditing
              ? h("div", { style: { display: "flex", gap: 3, alignItems: "center" } },
                  ...GOAL_TYPES.map((t) =>
                    h("button", {
                      key: t,
                      style: {
                        fontSize: 11, padding: "1px 6px", cursor: "pointer",
                        border: "1px solid " + (t === currentType ? goalTypeColor(t) : "rgba(128,128,128,.4)"),
                        borderRadius: 3, background: t === currentType ? goalTypeColor(t) : "rgba(128,128,128,.1)",
                        color: t === currentType ? "#fff" : "inherit", fontWeight: t === currentType ? 700 : 400,
                      },
                      className: "dg-btn",
                      title: GOAL_TYPE_LABELS[t],
                      onClick: () => doSetType(t),
                    }, GOAL_TYPE_ABBREV[t])),
                  h("button", {
                    style: { ...S.btn, fontSize: 10, padding: "0 4px" }, className: "dg-btn",
                    onClick: () => { setTypeEditing(false); setTypeNote(null); },
                  }, "✕"))
              : null,
            h("span", { style: { fontWeight: 700, fontSize: 15 } }, `🎯 ${props.title ?? props.id}`),
            h("button", {
              style: { ...S.btn, fontSize: 11, padding: "1px 6px", opacity: 0.7 }, className: "dg-btn",
              title: "重命名目标",
              onClick: (e) => { e.stopPropagation(); setNewTitle(props.title ?? props.id); setRenaming(true); setRenameNote(null); },
            }, "✏️"),
            // g-110: 归档/取消归档按钮
            isArchived
              ? h("button", {
                  style: { ...S.btn, fontSize: 11, padding: "1px 6px", background: "rgba(58,166,117,.2)" }, className: "dg-btn",
                  title: "取消归档（恢复到原位置）",
                  onClick: doUnarchive,
                }, "📤 取消归档")
              : canArchive
                ? h("button", {
                    style: { ...S.btn, fontSize: 11, padding: "1px 6px", background: "rgba(128,128,128,.2)" }, className: "dg-btn",
                    title: "归档目标（仅 draft/planning/delivered 可归档）",
                    onClick: doArchive,
                  }, "📦 归档")
                : null,
            // g-140: 删除按钮（仅已归档目标显示，二次确认）
            isArchived
              ? (deleteConfirm
                ? h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 2 } },
                    h("span", { style: { ...S.meta, fontSize: 11, color: "#d66" } }, "确认删除？"),
                    h("button", {
                      style: { ...S.btnDanger, fontSize: 11, padding: "1px 6px" }, className: "dg-btn-danger",
                      title: "确认删除（不可恢复）",
                      onClick: doDelete,
                    }, "🗑 确认"),
                    h("button", {
                      style: { ...S.btn, fontSize: 11, padding: "1px 6px" }, className: "dg-btn",
                      onClick: () => { setDeleteConfirm(false); setDeleteNote(null); },
                    }, "取消"))
                : h("button", {
                    style: { ...S.btnDanger, fontSize: 11, padding: "1px 6px" }, className: "dg-btn-danger",
                    title: "删除目标（仅已归档目标可删除，含卡片/attempts）",
                    onClick: () => { setDeleteConfirm(true); setDeleteNote(null); },
                  }, "🗑 删除"))
              : null,
            archiveNote ? h("span", { style: { ...S.meta, fontSize: 11, marginLeft: 4 } }, archiveNote) : null,
            deleteNote ? h("span", { style: { ...S.meta, fontSize: 11, marginLeft: 4 } }, deleteNote) : null,
            typeNote ? h("span", { style: { ...S.meta, fontSize: 11, marginLeft: 4 } }, typeNote) : null);

      return h(React.Fragment, null,
        h("div",
          { style: S.overlay, onClick: props.onClose },
          // g-158：弹窗顶部边框使用类型色（与卡片左侧色条、标题 badge 同色）
          h("div", { style: { ...S.modal, borderTop: `3px solid ${currentTypeColor}` }, onClick: (e) => e.stopPropagation() },
            h("span", { style: S.close, onClick: props.onClose }, "✕"),
            titleEl,
            headMeta,
            livePanel,
            content),
        ),
        // g-170：判据编辑弹窗（详情内「质量判据」标题处入口打开）——保存后刷新详情
        criteriaOpen
          ? h(CriteriaModal, { goalId: props.id, onClose: () => setCriteriaOpen(false), onSaved: () => { setCriteriaOpen(false); load(); } })
          : null,
      );
    }

    // g-77647351：回退询问理由弹窗（后→前方向拖动时）
    // 判据 4：有子代理 → 作为子代理消息补充（send_message）；无子代理 → 补充给主管
