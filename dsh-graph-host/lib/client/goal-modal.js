    // g-150：handoff 组件（显示当前有效 handoff + 登记新 handoff）
    function HandoffBox(props) {
      const { goalId, handoff, attempts, onRefresh } = props;
      const [showForm, setShowForm] = React.useState(false);
      const [form, setForm] = React.useState({ source_attempts: "", failures: "", constraints: "", baseline: "", verification: "" });
      const [note, setNote] = React.useState(null);
      const [loading, setLoading] = React.useState(false);

      const doRecord = async () => {
        const src = form.source_attempts.split(",").map((s) => s.trim()).filter(Boolean);
        if (!src.length) { setNote(dgT("handoff.sourceRequired")); return; }
        if (!form.failures.trim() || !form.constraints.trim() || !form.baseline.trim() || !form.verification.trim()) {
          setNote(dgT("handoff.allRequired")); return;
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
            setNote(dgT("handoff.success"));
            setShowForm(false);
            setForm({ source_attempts: "", failures: "", constraints: "", baseline: "", verification: "" });
            onRefresh?.();
          } else {
            setNote(dgT("handoff.registerFail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setNote(dgT("drag.requestFail") + String(e?.message ?? e));
        }
        setLoading(false);
      };

      const hasHf = handoff && handoff.failures;
      const attOptions = (attempts ?? []).map((a) => a.id);

      return h("div", { style: S.modalSection },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
          h("div", { style: S.modalH },
            dgT("handoff.title"),
            hasHf ? h("span", { style: { ...S.meta, fontSize: 11, marginLeft: 4, fontWeight: 400 } },
              dgT("handoff.rev", { revision: handoff.revision, sources: (handoff.source_attempts ?? []).join(", ") })) : null),
          h("button", {
            style: { ...S.btn, fontSize: 11, padding: "1px 6px" }, className: "dg-btn",
            onClick: () => { setShowForm(!showForm); setNote(null); },
          }, showForm ? dgT("common.cancel") : hasHf ? dgT("handoff.update") : dgT("handoff.register"))),
        // 显示当前 handoff
        hasHf
          ? h("div", { style: { marginTop: 6, display: "flex", flexDirection: "column", gap: 4, fontSize: 12 } },
              h("div", { style: { opacity: 0.65, fontSize: 11 } },
                dgT("handoff.confirmedBy", { by: handoff.confirmed_by, at: handoff.confirmed_at })),
              h("div", null,
                h("strong", null, dgT("handoff.failures")),
                h("div", { style: { whiteSpace: "pre-wrap", lineHeight: 1.4, marginTop: 2 } }, handoff.failures)),
              h("div", null,
                h("strong", null, dgT("handoff.constraints")),
                h("div", { style: { whiteSpace: "pre-wrap", lineHeight: 1.4, marginTop: 2 } }, handoff.constraints)),
              h("div", null,
                h("strong", null, dgT("handoff.baseline")),
                h("div", { style: { whiteSpace: "pre-wrap", lineHeight: 1.4, marginTop: 2 } }, handoff.baseline)),
              h("div", null,
                h("strong", null, dgT("handoff.verification")),
                h("div", { style: { whiteSpace: "pre-wrap", lineHeight: 1.4, marginTop: 2 } }, handoff.verification)))
          : h("div", { style: { ...S.meta, fontSize: 12, opacity: 0.6, marginTop: 4 } }, dgT("handoff.noHandoff")),
        // 登记表单
        showForm
          ? h("div", { style: { marginTop: 8, display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", borderRadius: 6, background: "rgba(128,128,128,.08)" } },
              h("div", { style: { fontSize: 11, opacity: 0.7 } }, hasHf ? dgT("handoff.updateHint") : dgT("handoff.registerHint")),
              h("div", null,
                h("label", { style: { fontSize: 11, opacity: 0.8 } }, dgT("handoff.sourceAttempts")),
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
              }, dgT("handoff.registerBtn")))
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
            setNote(dgT("directive.success"));
            setEditing(false);
            onRefresh?.();
          } else {
            setNote(dgT("directive.updateFail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setNote(dgT("drag.requestFail") + String(e?.message ?? e));
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
            setNote(dgT("directive.clearSuccess"));
            setText("");
            setEditing(false);
            onRefresh?.();
          } else {
            setNote(dgT("directive.clearFail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setNote(dgT("drag.requestFail") + String(e?.message ?? e));
        }
        setLoading(false);
      };

      const hasContent = (directive ?? "").trim().length > 0;

      return h("div", { style: S.modalSection },
        h("div", { style: S.modalH },
          dgT("directive.title"),
          h("span", { style: { ...S.meta, fontSize: 11, marginLeft: 6, fontWeight: 400 } },
            dgT("directive.hint"))),
        editing
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
              h("textarea", {
                style: { ...S.promptInput, minHeight: 60, resize: "vertical", fontFamily: "inherit", fontSize: 12 },
                value: text,
                onChange: (e) => setText(e.target.value),
                placeholder: dgT("directive.placeholder"),
              }),
              h("div", { style: { display: "flex", gap: 6 } },
                h("button", {
                  style: { ...S.btn, fontSize: 12 }, className: "dg-btn",
                  disabled: loading, onClick: doSave,
                }, dgT("directive.save")),
                text.trim()
                  ? h("button", {
                      style: { ...S.btn, fontSize: 12 }, className: "dg-btn",
                      disabled: loading, onClick: doClear,
                    }, dgT("directive.clear"))
                  : null,
                h("button", {
                  style: { ...S.btn, fontSize: 12 }, className: "dg-btn",
                  disabled: loading, onClick: () => { setEditing(false); setText(directive ?? ""); setNote(null); },
                }, dgT("common.cancel"))))
          : h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
              hasContent
                ? h("div", { style: { ...S.meta, whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.5, padding: "4px 0" } }, directive)
                : h("div", { style: { ...S.meta, fontSize: 12, opacity: 0.6 } }, dgT("directive.noContent")),
              h("button", {
                style: { ...S.btn, fontSize: 11, alignSelf: "flex-start" }, className: "dg-btn",
                onClick: () => { setEditing(true); setText(directive ?? ""); setNote(null); },
              }, hasContent ? dgT("directive.editBtn") : dgT("directive.setBtn"))),
        note ? h("div", { style: { ...S.meta, marginTop: 2, fontSize: 11 } }, note) : null);
    }

    // g-260：目标描述组件（只读态↔编辑态切换，就地 markdown 编辑）
    function DescriptionBox(props) {
      const { goalId, description, onRefresh, extra } = props;
      const [editing, setEditing] = React.useState(false);
      const [text, setText] = React.useState(description ?? "");
      const [note, setNote] = React.useState(null);
      const [loading, setLoading] = React.useState(false);

      React.useEffect(() => { setText(description ?? ""); }, [description]);

      const doSave = async () => {
        setLoading(true);
        setNote(null);
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/set-description"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: goalId, description: text }),
          });
          const data = await r.json();
          if (data.ok) {
            setNote(dgT("description.saved"));
            setEditing(false);
            onRefresh?.();
          } else {
            setNote(dgT("description.saveFail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setNote(dgT("description.requestFail") + String(e?.message ?? e));
        }
        setLoading(false);
      };

      const doCancel = () => {
        setEditing(false);
        setText(description ?? "");
        setNote(null);
      };
      const hasContent = (description ?? "").trim().length > 0;

      return h("div", { style: S.modalSection },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
          h("div", { style: S.modalH }, dgT("section.description")),
          !editing
            ? h("button", {
                style: { ...S.btn, fontSize: 11, padding: "1px 6px" }, className: "dg-btn",
                title: dgT("description.editInPlace"),
                onClick: () => { setEditing(true); setText(description ?? ""); setNote(null); },
              }, hasContent ? dgT("description.edit") : dgT("description.editEmpty"))
            : null),
        editing
          ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
              h("textarea", {
                style: { ...S.promptInput, minHeight: 80, resize: "vertical", fontFamily: "inherit", fontSize: 12 },
                value: text,
                onChange: (e) => setText(e.target.value),
                placeholder: dgT("description.placeholder"),
                autoFocus: true,
              }),
              h("div", { style: { display: "flex", gap: 6 } },
                h("button", {
                  style: { ...S.btn, fontSize: 12 }, className: "dg-btn",
                  disabled: loading, onClick: doSave,
                }, loading ? dgT("common.saving") : dgT("description.save")),
                h("button", {
                  style: { ...S.btn, fontSize: 12 }, className: "dg-btn",
                  disabled: loading, onClick: doCancel,
                }, dgT("common.cancel"))))
          : h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
              hasContent
                ? h("div", { style: { whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.5, padding: "4px 0" } }, description)
                : h("div", { style: { ...S.meta, fontSize: 12, opacity: 0.6 } }, dgT("description.empty"))),
        extra ?? null,
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
            setNote(dgT("comments.success"));
            setText("");
            setShowAdd(false);
            onRefresh?.();
          } else {
            setNote(dgT("comments.addFail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setNote(dgT("drag.requestFail") + String(e?.message ?? e));
        }
        setLoading(false);
      };

      const count = comments.length;

      return h("div", { style: S.modalSection },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
          h("div", { style: S.modalH },
            dgT("comments.title"),
            count > 0 ? h("span", { style: { ...S.meta, fontSize: 11, marginLeft: 4, fontWeight: 400 } }, dgT("comments.count", { count })) : null),
          count > 0
            ? h("button", {
                style: { ...S.btn, fontSize: 11, padding: "1px 6px" }, className: "dg-btn dg-chevron",
                onClick: () => setExpanded(!expanded),
              }, expanded ? "▲" : "▼")
            : null,
          h("button", {
            style: { ...S.btn, fontSize: 11, padding: "1px 6px" }, className: "dg-btn",
            onClick: () => { setShowAdd(!showAdd); setNote(null); },
          }, showAdd ? dgT("common.cancel") : dgT("comments.add"))),
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
                placeholder: dgT("comments.placeholder"),
              }),
              h("button", {
                style: { ...S.btn, fontSize: 12, alignSelf: "flex-start" }, className: "dg-btn",
                disabled: loading || !text.trim(), onClick: doAdd,
              }, dgT("comments.publish")))
          : null,
        note ? h("div", { style: { ...S.meta, marginTop: 2, fontSize: 11 } }, note) : null);
    }

    // g-187：客户端标签编辑器，所有变更通过 host 持久化到 goal.md。
    function GoalTagsEditor(props) {
      const [tags, setTags] = React.useState(Array.isArray(props.tags) ? props.tags : []);
      const [showAdd, setShowAdd] = React.useState(false);
      const [text, setText] = React.useState("");
      const [note, setNote] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      React.useEffect(() => { setTags(Array.isArray(props.tags) ? props.tags : []); }, [props.tags]);
      const save = async (next) => {
        if (saving) return;
        const clean = [...new Set(next.map((x) => String(x).trim().replace(/^#/, "")))];
        setSaving(true); setNote(null);
        try {
          // 如果常规 CAS 冲突（比如弹窗刚打开时状态还未同步），如果当前只有本地这一个客户端在操作，允许重试覆盖
          let r = await fetch(graphUrl("/api/dsh-graph/set-goal-tags"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: props.goalId, tags: clean, base_tags: tags }),
          });
          let data = await r.json();
          if (r.status === 409) {
            // CAS 冲突时自动带当前最新 base 再次更新或带 force 写入
            r = await fetch(graphUrl("/api/dsh-graph/set-goal-tags"), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ goal: props.goalId, tags: clean, force: true }),
            });
            data = await r.json();
          }
          if (!r.ok) throw new Error(data.error || dgT("tags.saveFail"));
          const saved = Array.isArray(data.new_tags) ? data.new_tags : clean;
          setTags(saved);
          props.onChange?.(saved);
          setNote(dgT("common.savingDone"));
        } catch (e) { setNote(String(e?.message ?? e)); }
        finally { setSaving(false); }
      };
      const add = () => {
        const value = text.trim();
        if (!value) return;
        save([...tags, ...value.split(/[,，\s]+/)]);
        setText("");
        setShowAdd(false);
      };
      return h("div", { style: { ...S.modalSection, minWidth: 0, maxWidth: "100%", overflow: "hidden" } },
        h("div", { style: { ...S.modalH, display: "flex", alignItems: "center", justifyContent: "space-between" } },
          h("span", null, dgT("tags.title")),
          h("button", {
            className: "dg-btn",
            style: { ...S.btn, fontSize: 11, padding: "1px 6px" },
            title: showAdd ? dgT("tags.collapse") : dgT("tags.addTooltip"),
            onClick: () => { setShowAdd(!showAdd); setNote(null); },
          }, showAdd ? dgT("common.cancel") : dgT("tags.add"))),
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4, minWidth: 0, maxWidth: "100%" } },
          tags.length
            ? tags.map((tag) => h("button", { key: tag, className: "dg-btn", style: { ...S.btn, fontSize: 11, padding: "1px 6px", minWidth: 0, maxWidth: "100%", overflowWrap: "anywhere", wordBreak: "break-word", whiteSpace: "normal" }, title: dgT("tags.removeTooltip"), disabled: saving, onClick: () => save(tags.filter((x) => x !== tag)) }, "#" + tag + " ×"))
            : (!showAdd ? h("span", { style: S.meta }, dgT("tags.noTags")) : null)),
        showAdd ? h("div", { style: { display: "flex", gap: 4, marginTop: 6 } },
          h("input", { autoFocus: true, value: text, style: { ...S.promptInput, flex: 1, fontSize: 12 }, placeholder: dgT("tags.inputPlaceholder"), onChange: (e) => setText(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") setShowAdd(false); } }),
          h("button", { className: "dg-btn", style: { ...S.btn, fontSize: 12 }, disabled: saving || !text.trim(), onClick: add }, saving ? dgT("common.saving") : dgT("tags.save"))) : null,
        note ? h("div", { style: { ...S.meta, color: note === dgT("common.savingDone") ? undefined : "#e57373", marginTop: 4 } }, note) : null);
    }

    // g-197：展示 delivered 目标已识别的清理候选与显式清理操作
    function WorktreeCandidates(props) {
      const [items, setItems] = React.useState([]);
      const [note, setNote] = React.useState(null);
      const load = React.useCallback(() =>
        fetch(graphUrl("/api/dsh-graph/worktrees", { goal: props.goalId }))
          .then((r) => r.json())
          .then((x) => setItems(Array.isArray(x.worktrees) ? x.worktrees : []))
          .catch((e) => setNote(String(e))),
      [props.goalId]);
      React.useEffect(() => { load(); }, [load]);
      const clean = async (id) => {
        if (!window.confirm(dgT("worktree.confirmDelete"))) return;
        setNote(null);
        const r = await fetch(graphUrl("/api/dsh-graph/worktrees/clean"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, confirm: true }),
        });
        const x = await r.json();
        if (!r.ok) setNote(x.reason || x.error || dgT("worktree.cleanFail"));
        else { setNote(dgT("worktree.cleaned")); load(); }
      };
      if (!items.length && !note) return null;
      return h("div", { style: S.modalSection },
        h("div", { style: S.modalH }, dgT("worktree.title")),
        items.map((x) =>
          h("div", { key: x.id, style: { ...S.subCard, marginTop: 4 } },
            h("div", null, `${x.status === "candidate" ? "✅" : "🔒"} ${x.path}`),
            h("div", { style: S.meta }, `${x.branch || "(detached)"} · ${x.head || "unknown"} · ${x.reason || dgT("worktree.defaultReason")}`),
            x.status === "candidate"
              ? h("button", { className: "dg-btn", style: S.btnPrimary, onClick: () => clean(x.id) }, dgT("worktree.confirmClean"))
              : null,
          ),
        ),
        note ? h("div", { style: S.meta }, note) : null,
      );
    }

    // g-189：只展示服务端按 canonical workspace 只读发现的 worktree；不自行执行 git。
    function AttemptWorktrees(props) {
      const attempts = props.attempts ?? [];
      const discovery = props.worktrees ?? { status: "unavailable", items: {} };
      const [expanded, setExpanded] = React.useState(false);
      if (!attempts.length) return null;
      const latest = [...attempts].reverse().find((a) => discovery.items?.[a.id]);
      const copyButton = (item) => item ? h("button", { className: "dg-btn", style: { ...S.btn, fontSize: 11, padding: "1px 6px" }, title: dgT("worktree.copyPathTooltip"), onClick: async () => { if (await copyText(item.path)) showToast(dgT("worktree.pathCopied")); } }, dgT("common.copy")) : null;
      const row = (a) => {
        const item = discovery.items?.[a.id];
        return h("div", { key: a.id, style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0, marginTop: 4 } },
          h("span", { style: { flex: "0 0 auto", fontSize: 12 } }, a.id),
          item ? h("span", { title: item.path, style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, fontFamily: "monospace", fontSize: 11 } }, `${item.path} ｜ ${item.status}`) : h("span", { style: { ...S.meta, flex: 1, fontSize: 11 } }, dgT("worktree.notCreated")),
          copyButton(item));
      };
      return h("div", { key: "worktrees", style: S.modalSection },
        h("div", { style: { ...S.modalH, display: "flex", alignItems: "center", justifyContent: "space-between" } },
          h("span", null, "🌿 Attempt worktree"),
          h("button", { className: "dg-btn", style: { ...S.btn, fontSize: 12, padding: "0 5px" }, title: expanded ? dgT("worktree.collapseTooltip") : dgT("worktree.expandTooltip"), "aria-label": expanded ? dgT("worktree.collapseTooltip") : dgT("worktree.expandTooltip"), onClick: () => setExpanded((v) => !v) }, expanded ? "▲" : "▼")),
        discovery.status !== "ok" ? h("div", { style: { ...S.meta, fontSize: 12 } }, dgT("worktree.unavailable")) : expanded ? attempts.map(row) : latest ? row(latest) : h("div", { style: { ...S.meta, fontSize: 11, marginTop: 4 } }, dgT("worktree.notCreated")));
    }

    function GoalModal(props) {
      useLocaleRevision();
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
      const lastWorktreesRef = React.useRef({});
      const removedWorktreesRef = React.useRef({});
      const load = React.useCallback(() =>
        fetch(graphUrl("/api/dsh-graph/goal", { id: props.id }))
          .then((r) => r.json())
          .then((data) => {
            if (!aliveRef.current) return;
            const wt = data.worktrees;
            if (wt?.status === "ok") {
              const next = { ...wt, items: { ...wt.items } };
              for (const [id, old] of Object.entries(lastWorktreesRef.current)) {
                if (!next.items[id]) {
                  const removed = { ...old, status: "已移除" };
                  removedWorktreesRef.current[id] = removed;
                  next.items[id] = removed;
                }
              }
              for (const [id, removed] of Object.entries(removedWorktreesRef.current)) {
                if (!next.items[id]) next.items[id] = removed;
              }
              lastWorktreesRef.current = Object.fromEntries(Object.entries(next.items).filter(([, v]) => v.status !== "已移除"));
              data = { ...data, worktrees: next };
            }
            setState({ loading: false, data });
          })
          .catch((e) => aliveRef.current && setState({ loading: false, error: String(e) })),
      [props.id]);
      React.useEffect(() => {
        aliveRef.current = true;
        load();
        const t = setInterval(load, 20000);
        return () => { aliveRef.current = false; clearInterval(t); };
      }, [load]);

      // g-219：删除卡片后局部移除（不整体重新 load 弹窗，避免丢未保存状态/闪烁/焦点丢失）。
      // kanban 侧在 delete-card 返回 ok 后下发 deletedCardSignal，此处按事件结果过滤本地 cards，
      // 幂等：卡片已不存在则不动；信号带 ts，重复消费同一信号无副作用。
      React.useEffect(() => {
        const sig = props.deletedCardSignal;
        if (!sig || sig.goalId !== props.id) return;
        setState((s) => {
          if (!s.data || !Array.isArray(s.data.cards)) return s;
          const cards = s.data.cards.filter((c) => c.id !== sig.cardId);
          if (cards.length === (s.data.cards ?? []).length) return s; // 幂等：不存在则不动
          return { ...s, data: { ...s.data, cards } };
        });
        props.onDeletedCardHandled?.();
      }, [props.deletedCardSignal, props.id]);

      // g-181：主 overlay backdrop 误关保护（内容起点后释放到 backdrop 的合成 click 吞掉）
      const backdropGuard = useBackdropClose(props.onClose);

      const section = (body, name) => {
        const m = new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(body ?? "");
        return m ? m[1].trim() : null;
      };

      let content;
      let headMeta = null;   // 标题下 1-2 行：状态/泳道/版本/评审 + 等待/状态摘要
      let livePanel = null;  // 📡 会话实时：紧随摘要行
      if (state.loading) content = dgT("common.loading");
      else if (state.error) content = dgT("goal.requestFail") + state.error;
      else if (state.data.error) content = dgT("goal.requestFail") + state.data.error;
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
        const isVersionHidden = meta.version && Array.isArray(props.hiddenVersionSlugs) && props.hiddenVersionSlugs.includes(meta.version);
        const bits = [
          props.id,
          dgT("status.label") + (STATUS_LABEL[status] ?? status),
          stage ? dgT("stage.label") + stage.label : null,
          dgT("goal.ownership") + (meta.version ? dgT("modal.ownershipVersion", { version: meta.version }) : dgT("modal.ownershipStandalone")),
          meta.review?.reviewer === "human" ? dgT("modal.humanReview") : meta.review?.reviewer === "ai" ? dgT("modal.aiReview") : null,
        ].filter(Boolean);
        const pendingDeps = deps.filter((d) => props.goalStatus?.[d] !== "delivered");
        const metDeps = deps.filter((d) => props.goalStatus?.[d] === "delivered");
        headMeta = [
          h("div", { key: "m1", style: S.meta }, bits.join(" ｜ ")),
          // g-223：归属版本在看板中被隐藏时的友好提示与恢复显示入口
          isVersionHidden
            ? h("div", {
                key: "m-hidden-warn",
                style: {
                  ...S.meta,
                  color: "var(--dsw-alias-state-warn-label, #e0a53a)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 2,
                },
              },
                dgT("modal.versionHidden", { version: meta.version }),
                props.onUnhideVersion
                  ? h("button", {
                      style: { ...S.btn, fontSize: 11, padding: "1px 6px" },
                      className: "dg-btn",
                      title: dgT("modal.unhideVersion"),
                      onClick: () => props.onUnhideVersion(meta.version),
                    }, dgT("modal.unhideVersion"))
                  : null)
            : null,
          pendingDeps.length
            ? h("div", { key: "m2", style: { ...S.meta, color: "var(--dsw-alias-state-warn-label, #e0a53a)" } }, dgT("card.waitingDep", { deps: pendingDeps.join(", ") }))
            : null,
          metDeps.length
            ? h("div", { key: "m2b", style: { ...S.meta, color: "var(--dsw-alias-label-primary, #3aa675)" } }, dgT("card.depsSatisfied", { deps: metDeps.join(", ") }))
            : null,
          status === "blocked" && meta.blocked_reason
            ? h("div", { key: "m3", style: { ...S.meta, color: "var(--dsw-alias-state-error-primary, #d66)" } }, "⛔ " + meta.blocked_reason)
            : null,
        ];
        // g-107：📡 会话实时面板上移至标题与状态摘要下方（默认折叠，点击展开）
        // g-109 判据反馈：最新 attempt 无 child_id（子代理启动失败）时也给出「重新执行」兜底区
        // g-107 & g-200：实时会话面板（仅展示 Goal 自身的执行 attempt，排除收集子代理）
        const att = (d.attempts ?? []).filter((a) => a.child_id && a.executor !== "agent:collect").slice(-1)[0];
        const anyAtt = (d.attempts ?? []).filter((a) => a.executor !== "agent:collect").length > 0;
        livePanel = att
          ? h(SessionPanel, { parentId: att.parent_session_id, childId: att.child_id, collapsible: true,
                              provider: att.provider, model: att.model, modelRoute: att.model_route,
                              subagentMode: att.mode ?? null,
                              statusLine: lastAtt?.status_line ?? null,
                              goalId: props.id, relaunchKind: "exec",
                              relaunchRoute, onRelaunched: setRelaunchRoute,
                              // g-190：解绑控件数据（attemptId/bindingToken；成功解绑后刷新详情与看板）
                              attemptId: att.id,
                              bindingToken: att.binding_token ?? null,
                              onDetached: () => { load(); props.onRefresh?.(); } })
          : anyAtt
            ? h("div", { key: "relaunch-fallback", style: { ...S.livePanel, marginTop: 6 } },
                h("div", { style: { ...S.meta, marginBottom: 2 } }, dgT("modal.relaunchFallback")),
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
          h(AttemptWorktrees, { key: "worktrees", attempts: d.attempts, worktrees: d.worktrees }),
          status === "delivered" ? h(WorktreeCandidates, { key: "wt-candidates", goalId: props.id }) : null,
          h(GoalTagsEditor, { key: "tags", goalId: props.id, tags: meta.tags ?? props.tags, onChange: () => { load(); props.onTagsChanged?.(); } }),
          desc != null ? h(DescriptionBox, { key: "description", goalId: props.id, description: desc, onRefresh: load,
            extra: h(AcceptFeedback, { goalId: props.id, goalPath: String(d.goalFile ?? "").replace(/^.*?(?=\.dsh-graph[\\/])/, ""), title: d.title ?? props.title, description: desc, criteria: crit, status, events: d.events, attempts: d.attempts, supervisorSession: props.supervisorSession, onRefresh: load, onPmStarted: props.onPmStarted, onPmFinished: props.onPmFinished, onClose: props.onClose }) }) : null,
          // g-109：判据栏只在 ready 及之后阶段显示 checklist（已确认可勾选），早期阶段只显示纯文本
          // g-170：「✏️ 判据」编辑入口放在小节标题处（负责人 2026-08-25 指示），点击打开判据编辑弹窗
          crit != null ? sectionBlock("c", dgT("section.criteria"), crit,
            !isPlaceholder(crit) && ["ready", "in_progress", "review", "delivered"].includes(status)
              ? h(CriteriaChecklist, { goalId: props.id, crit, att, onClose: props.onClose })
              : null, true,
            h("button", {
              style: { ...S.btnPrimary, fontSize: 11, padding: "1px 6px", marginLeft: 6, verticalAlign: "middle", opacity: 1 },
              className: "dg-btn",
              title: dgT("section.criteriaEditTooltip"),
              onClick: (e) => { e.stopPropagation(); setCriteriaOpen(true); },
            }, dgT("common.edit"))) : null,
          (d.cards ?? []).length
            ? h("div", { key: "k", style: S.modalSection },
                h("div", { style: S.modalH }, dgT("section.infoCollect")),
                d.cards.map((c) => h("div", {
                  key: c.id,
                  style: { ...S.subCard, cursor: "pointer" },
                  className: "dg-sub",
                  title: dgT("card.clickToOpenDrawer"),
                  onClick: (e) => {
                    e.stopPropagation();
                    if (props.onOpenCard) {
                      props.onOpenCard(props.id, c.id);
                    }
                  },
                },
                  h("div", { style: { display: "flex", alignItems: "center", gap: 4 } },
                    h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                      `${CARD_STATUS_ICON[c.status] ?? c.status} ｜ ${c.title}`),
                    c.scope === "shared"
                      ? h("span", { style: { flexShrink: 0, fontSize: 10, padding: "0 4px", borderRadius: 3, background: "rgba(58,166,117,.18)", color: "var(--dsw-alias-state-success-label, #3aa675)" } },
                          dgT("card.sharedBadge"))
                      : null))),
                isBacklog
                  ? h("div", { style: { ...S.meta, marginTop: 4 } }, dgT("section.backlogNoCards"))
                  : h(AddCardBox, { goalId: props.id, supervisorSession: props.supervisorSession, onRefresh: load }))
            : h("div", { key: "k", style: S.modalSection },
                h("div", { style: S.modalH }, dgT("section.infoCollect")),
                h("div", { style: S.meta }, dgT("section.noCards")),
                isBacklog
                  ? h("div", { style: { ...S.meta, marginTop: 4 } }, dgT("section.backlogNoCards"))
                  : h(AddCardBox, { goalId: props.id, supervisorSession: props.supervisorSession, onRefresh: load })),
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
            return [h("div", { key: "empty", style: S.meta }, dgT("section.noActivity"))];
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
              h("span", { style: { ...S.meta, fontSize: 11 } }, dgT("activity.total", { count: sorted.length })),
              h("select", {
                value: logFilter,
                onChange: (e) => setLogFilter(e.target.value),
                style: S.select,
                className: "dg-select",
              },
                h("option", { value: "" }, dgT("activity.allTypes")), ...typeOptions),
              h("button", {
                onClick: () => setLogSort(logSort === "asc" ? "desc" : "asc"),
                style: { ...S.btn },
                className: "dg-btn",
              }, logSort === "asc" ? dgT("activity.timeAsc") : dgT("activity.timeDesc"))),
            // 事件日志表格：时间 / 事件 / 执行者
            h("table", { key: "tbl", style: { width: "100%", borderCollapse: "collapse" } },
              h("thead", null, h("tr", null,
                h("th", { style: th }, dgT("activity.colTime")),
                h("th", { style: th }, dgT("activity.colEvent")),
                h("th", { style: th }, dgT("activity.colActor")))),
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
                color: tab === "detail" ? "var(--dsw-alias-label-primary, #8ab4ff)" : "inherit",
                opacity: tab === "detail" ? 1 : 0.7,
              },
              onClick: () => setTab("detail"),
            }, dgT("tab.detail")),
            h("button", {
              style: {
                fontSize: 12, padding: "5px 14px", cursor: "pointer",
                marginBottom: -1, borderRadius: "6px 6px 0 0",
                border: "1px solid " + (tab === "activity" ? "rgba(128,128,128,.35)" : "transparent"),
                borderBottom: "none",
                background: tab === "activity" ? "rgba(128,128,128,.10)" : "transparent",
                fontWeight: tab === "activity" ? 700 : 400,
                color: tab === "activity" ? "var(--dsw-alias-label-primary, #8ab4ff)" : "inherit",
                opacity: tab === "activity" ? 1 : 0.7,
              },
              onClick: () => setTab("activity"),
            }, dgT("tab.activity")),
            h("button", {
              style: {
                fontSize: 12, padding: "5px 14px", cursor: "pointer",
                marginBottom: -1, borderRadius: "6px 6px 0 0",
                border: "1px solid " + (tab === "context" ? "rgba(128,128,128,.35)" : "transparent"),
                borderBottom: "none",
                background: tab === "context" ? "rgba(128,128,128,.10)" : "transparent",
                fontWeight: tab === "context" ? 700 : 400,
                color: tab === "context" ? "var(--dsw-alias-label-primary, #8ab4ff)" : "inherit",
                opacity: tab === "context" ? 1 : 0.7,
              },
              onClick: () => setTab("context"),
            }, dgT("tab.context")),
            // g-129: goal.md 链接放在 tab 行右侧
            d.goalFile
              ? h("div", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, marginBottom: 1 } },
                  h("span", { style: { fontSize: 11, opacity: 0.7 } }, "📄 goal.md"),
                  h("button", {
                    style: { ...S.btn, fontSize: 11, padding: "1px 6px" },
                    className: "dg-btn",
                    title: dgT("tab.openFile"),
                    onClick: async (e) => {
                      e.stopPropagation();
                      // g-222：统一走共享 openHostPath（0.1.2+ session.openWorkspacePath 优先），
                      // 失败透出可理解错误（C3/C4），不再静默回退为"路径已复制"
                      const r = await openHostPath(d.goalFile);
                      if (r.opened) { showToast(dgT("tab.fileOpened")); return; }
                      await copyText(d.goalFile);
                      if (r.error) { showToast(dgT("tab.openFailed") + openErrorText(r.error)); }
                      else { showToast(dgT("tab.pathCopiedNoOpen")); }
                    },
                  }, dgT("tab.openFile")),
                  h("button", {
                    style: { ...S.btn, fontSize: 11, padding: "1px 6px" },
                    className: "dg-btn",
                    title: dgT("tab.copyPath"),
                    onClick: async (e) => { e.stopPropagation(); const ok = await copyText(d.goalFile); if (ok) showToast(dgT("tab.pathCopied")); },
                  }, dgT("tab.copyPath")))
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
        if (!t) { setRenameNote(dgT("goal.renameEmpty")); return; }
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
            setRenameNote("⚠️ 重命名失败：" + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setRenameNote(dgT("drag.requestFail") + String(e?.message ?? e));
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
            setTypeNote(dgT("goal.typeSetFail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setTypeNote(dgT("drag.requestFail") + String(e?.message ?? e));
        }
      };

      // g-110: 归档/取消归档操作
      const [archiveNote, setArchiveNote] = React.useState(null);
      const isArchived = state.data?.meta?.archived === true;
      const canArchive = ["draft", "planning", "delivered"].includes(state.data?.meta?.status);
      // g-138：暂缓操作（仅版本/standalone 目标，二次确认）
      const [postponeConfirm, setPostponeConfirm] = React.useState(false);
      const [postponeNote, setPostponeNote] = React.useState(null);
      const goalFile = String(state.data?.goalFile ?? "");
      const isBacklogGoal = goalFile.includes("/backlog/") || goalFile.includes("\\\\backlog\\\\");
      const canPostpone = !isArchived && !isBacklogGoal && Boolean(state.data?.meta?.status);
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
            setArchiveNote(dgT("goal.archivedSuccess"));
            showToast(dgT("goal.archivedSuccess"));
            props.onArchived?.(); // 刷新看板：归档后卡片立即消失
            // 刷新详情
            const goalRes = await fetch(graphUrl("/api/dsh-graph/goal", { id: props.id }));
            const goalData = await goalRes.json();
            if (!goalData.error) setState({ loading: false, data: goalData });
          } else {
            setArchiveNote(dgT("goal.archiveFail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setArchiveNote(dgT("drag.requestFail") + String(e?.message ?? e));
        }
      };

      // g-138：二次确认后调用单向暂缓接口，成功后关闭详情并刷新看板
      const doPostpone = async () => {
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/postpone"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: props.id }),
          });
          const data = await r.json();
          if (data.ok) {
            setPostponeNote(dgT("goal.postponeSuccess"));
            showToast(dgT("goal.postponeSuccessMsg"));
            setPostponeConfirm(false);
            props.onArchived?.();
            props.onClose?.();
          } else {
            setPostponeNote(dgT("goal.postponeFail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setPostponeNote(dgT("drag.requestFail") + String(e?.message ?? e));
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
            setArchiveNote(dgT("goal.unarchivedSuccess"));
            showToast(dgT("goal.unarchivedSuccess"));
            props.onArchived?.(); // 刷新看板：取消归档后卡片回到看板
            // 刷新详情
            const goalRes = await fetch(graphUrl("/api/dsh-graph/goal", { id: props.id }));
            const goalData = await goalRes.json();
            if (!goalData.error) setState({ loading: false, data: goalData });
          } else {
            setArchiveNote(dgT("goal.unarchiveFail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setArchiveNote(dgT("drag.requestFail") + String(e?.message ?? e));
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
            setDeleteNote(dgT("goal.deleteSuccess"));
            showToast(dgT("goal.deleteSuccessMsg"));
            props.onArchived?.(); // 刷新看板：删除后卡片立即消失
            setDeleteConfirm(false);
          } else {
            setDeleteNote(dgT("goal.deleteFail") + (data.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setDeleteNote(dgT("drag.requestFail") + String(e?.message ?? e));
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
            }, dgT("common.confirm")),
            h("button", {
              style: { ...S.btn, padding: "2px 10px" }, className: "dg-btn",
              onClick: () => { setRenaming(false); setRenameNote(null); },
            }, dgT("common.cancel")),
            renameNote ? h("span", { style: { ...S.meta, fontSize: 11, marginLeft: 4 } }, renameNote) : null)
        : h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
            // g-158：类型标记 badge（标题最左侧，颜色与弹窗顶部边框、卡片左栏同源）
            h("span", {
              style: {
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, lineHeight: "20px", borderRadius: 4, fontSize: 12, fontWeight: 700,
                background: currentTypeColor, color: "#fff", cursor: "pointer", flexShrink: 0,
              },
              title: dgT("goal.typeLabel", { type: GOAL_TYPE_LABELS[currentType] }),
              onClick: (e) => { e.stopPropagation(); setTypeEditing(!typeEditing); setTypeNote(null); },
            }, GOAL_TYPE_ABBREV[currentType]),
            // g-158：类型选择器弹出（点击 badge 展开）
            typeEditing
              ? h("div", { style: { display: "inline-flex", gap: 4, alignItems: "center", verticalAlign: "middle" } },
                  ...GOAL_TYPES.map((t) =>
                    h("button", {
                      key: t,
                      style: {
                        width: 20,
                        height: 20,
                        boxSizing: "border-box",
                        padding: 0,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                        fontSize: 11,
                        fontWeight: 700,
                        lineHeight: 1,
                        borderRadius: 4,
                        border: "1px solid " + (t === currentType ? goalTypeColor(t) : goalTypeColor(t) + "66"),
                        background: t === currentType ? goalTypeColor(t) : goalTypeColor(t) + "18",
                        color: t === currentType ? "#fff" : goalTypeColor(t),
                        boxShadow: t !== currentType ? "inset 0 0 4px " + goalTypeColor(t) + "22" : "none",
                        flexShrink: 0,
                      },
                      className: "dg-btn",
                      title: GOAL_TYPE_LABELS[t],
                      onClick: () => doSetType(t),
                    }, GOAL_TYPE_ABBREV[t])),
                  h("button", {
                    style: {
                      width: 20,
                      height: 20,
                      boxSizing: "border-box",
                      padding: 0,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                      fontSize: 11,
                      lineHeight: 1,
                      borderRadius: 4,
                      border: "1px solid rgba(128,128,128,.35)",
                      background: "rgba(128,128,128,.15)",
                      color: "inherit",
                      opacity: 0.7,
                      flexShrink: 0,
                    },
                    className: "dg-btn",
                    title: dgT("goal.closeSelector"),
                    onClick: () => { setTypeEditing(false); setTypeNote(null); },
                  }, "✕"))
              : null,
            h("span", { style: { fontWeight: 700, fontSize: 15 } }, `🎯 ${props.title ?? props.id}`),
            h("button", {
              style: { ...S.btn, fontSize: 11, padding: "1px 6px", opacity: 0.7 }, className: "dg-btn",
              title: dgT("goal.renameTitle"),
              onClick: (e) => { e.stopPropagation(); setNewTitle(props.title ?? props.id); setRenaming(true); setRenameNote(null); },
            }, "✏️"),
            // g-110: 归档/取消归档按钮
            isArchived
              ? h("button", {
                  style: { ...S.btn, fontSize: 11, padding: "1px 6px", background: "rgba(58,166,117,.2)" }, className: "dg-btn",
                  title: dgT("goal.unarchiveTooltip"),
                  onClick: doUnarchive,
                }, dgT("goal.unarchive"))
              : canArchive
                ? h("button", {
                    style: { ...S.btn, fontSize: 11, padding: "1px 6px", background: "rgba(128,128,128,.2)" }, className: "dg-btn",
                    title: dgT("goal.archiveTooltip"),
                    onClick: doArchive,
                  }, dgT("goal.archive"))
                : null,
            // g-138：暂缓按钮位于归档按钮右侧，点击后要求二次确认
            canPostpone
              ? (postponeConfirm
                ? h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 2 } },
                    h("span", { style: { ...S.meta, fontSize: 11, color: "var(--dsw-alias-state-error-primary, #d66)" } }, dgT("goal.postponeConfirm")),
                    h("button", {
                      style: { ...S.btn, fontSize: 11, padding: "1px 6px", background: "rgba(224,165,58,.2)" }, className: "dg-btn",
                      title: dgT("goal.postponeConfirmed"),
                      onClick: doPostpone,
                    }, dgT("goal.postpone")),
                    h("button", {
                      style: { ...S.btn, fontSize: 11, padding: "1px 6px" }, className: "dg-btn",
                      onClick: () => { setPostponeConfirm(false); setPostponeNote(null); },
                    }, dgT("common.cancel")))
                : h("button", {
                    style: { ...S.btn, fontSize: 11, padding: "1px 6px", background: "rgba(224,165,58,.2)" }, className: "dg-btn",
                    title: dgT("goal.postponeTooltip"),
                    onClick: () => { setPostponeConfirm(true); setPostponeNote(null); },
                  }, dgT("goal.postpone")))
              : null,
            // g-140: 删除按钮（仅已归档目标显示，二次确认）
            isArchived
              ? (deleteConfirm
                ? h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 2 } },
                    h("span", { style: { ...S.meta, fontSize: 11, color: "var(--dsw-alias-state-error-primary, #d66)" } }, dgT("goal.deleteConfirm")),
                    h("button", {
                      style: { ...S.btnDanger, fontSize: 11, padding: "1px 6px" }, className: "dg-btn-danger",
                      title: dgT("goal.deleteConfirmed"),
                      onClick: doDelete,
                    }, dgT("goal.delete")),
                    h("button", {
                      style: { ...S.btn, fontSize: 11, padding: "1px 6px" }, className: "dg-btn",
                      onClick: () => { setDeleteConfirm(false); setDeleteNote(null); },
                    }, dgT("common.cancel")))
                : h("button", {
                    style: { ...S.btnDanger, fontSize: 11, padding: "1px 6px" }, className: "dg-btn-danger",
                    title: dgT("goal.deleteTooltip"),
                    onClick: () => { setDeleteConfirm(true); setDeleteNote(null); },
                  }, dgT("goal.delete")))
              : null,
            archiveNote ? h("span", { style: { ...S.meta, fontSize: 11, marginLeft: 4 } }, archiveNote) : null,
            postponeNote ? h("span", { style: { ...S.meta, fontSize: 11, marginLeft: 4 } }, postponeNote) : null,
            deleteNote ? h("span", { style: { ...S.meta, fontSize: 11, marginLeft: 4 } }, deleteNote) : null,
            typeNote ? h("span", { style: { ...S.meta, fontSize: 11, marginLeft: 4 } }, typeNote) : null);

      return h(React.Fragment, null,
        h("div",
          { style: S.overlay, ...backdropGuard },
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
