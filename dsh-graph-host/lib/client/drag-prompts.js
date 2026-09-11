    function BackwardReasonPrompt(props) {
      const { goalId, toStatus, hasChild, childId, parentId, onConfirm, onCancel } = props;
      const [reason, setReason] = React.useState("");
      const [sending, setSending] = React.useState(false);
      const [sent, setSent] = React.useState(false);
      // 如果有子代理，通过 session.prompt 发送理由
      const { session } = useBoundSession(parentId, childId);
      // g-181：overlay backdrop 误关保护（内容起点后释放到 backdrop 的合成 click 吞掉）
      const backdropGuard = useBackdropClose(onCancel);
      const sendReason = async () => {
        if (!reason.trim()) { onConfirm(""); return; }
        if (hasChild && session?.prompt) {
          setSending(true);
          try {
            await session.prompt(
              [{ type: "text", text: `【${goalId} 回退理由】${reason.trim()}` }], "queue");
            setSent(true);
            setTimeout(() => onConfirm(reason.trim()), 800);
          } catch {
            onConfirm(reason.trim());
          }
          setSending(false);
        } else {
          onConfirm(reason.trim());
        }
      };
      return h("div", { style: S.overlay, ...backdropGuard },
        h("div", { style: { ...S.modal, maxWidth: 480 }, onClick: (e) => e.stopPropagation() },
          h("span", { className: "dg-close", style: S.close, onClick: onCancel }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 14, marginBottom: 8 } },
            dgT("backward.title", { status: STATUS_LABEL[toStatus] ?? toStatus })),
          h("div", { style: { ...S.meta, marginBottom: 8 } },
            dgT("backward.desc", { goalId, status: STATUS_LABEL[toStatus] ?? toStatus }),
            h("br"),
            hasChild
              ? dgT("backward.withChild")
              : dgT("backward.withoutChild")),
          h("textarea", {
            style: { ...S.promptInput, width: "100%", minHeight: 80, resize: "vertical", marginTop: 4 },
            value: reason,
            placeholder: dgT("backward.reasonPlaceholder"),
            onChange: (e) => setReason(e.target.value),
          }),
          h("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
            h("button", {
              style: { ...S.btnPrimary, padding: "4px 14px", fontSize: 13 }, className: "dg-btn-primary",
              disabled: sending, onClick: sendReason,
            }, sending ? dgT("common.sending") : (sent ? dgT("common.sent") : dgT("backward.confirmBtn"))),
            h("button", {
              style: { ...S.btn, padding: "4px 12px", fontSize: 12 }, className: "dg-btn",
              onClick: onCancel,
            }, dgT("common.cancel"))),
        ),
      );
    }

    // g-77647351：进执行列确认弹窗
    // 无子代理 → force transition + start-execution 派新子代理
    // 有子代理 → force transition + 通过 session.prompt 给旧子代理排队重新执行（不派新）
    function InProgressPrompt(props) {
      const { goalId, goalData, supervisorSession, onConfirm, onCancel } = props;
      const [loading, setLoading] = React.useState(false);
      const [note, setNote] = React.useState(null);
      const hasChild = !!(goalData?.attempt_child_id);
      const hasCriteria = !!(goalData?.criteria_count);
      const oldChildId = goalData?.attempt_child_id ?? null;
      const oldParentId = goalData?.attempt_parent_session_id ?? null;

      // 有子代理时用 session.prompt 排队重新执行，无子代理时派新
      const { session: oldSession } = useBoundSession(oldParentId, oldChildId);

      // g-181：overlay backdrop 误关保护（内容起点后释放到 backdrop 的合成 click 吞掉）
      const backdropGuard = useBackdropClose(onCancel);

      const startExec = async () => {
        if (!supervisorSession) {
          setNote(dgT("inProgress.supervisorNotConfigured"));
          return;
        }
        setLoading(true);
        try {
          // Step 1: force transition 到 in_progress（人工拖动视为授权）
          setNote(dgT("inProgress.migrating"));
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

          if (hasChild && oldSession?.prompt) {
            // 有子代理 → 排队发"重新执行"消息，不派新子代理
            setNote(dgT("inProgress.dispatchingReExec"));
            try {
              const res = await oldSession.prompt(
                [{ type: "text", text: `【重新执行】用户从看板拖放触发重新执行目标 ${goalId}。请从头开始执行目标描述和质量判据中的任务。` }],
                "queue",
              );
              if (res?.ok) {
                setNote(dgT("inProgress.reExecSent"));
                showToast(dgT("inProgress.reExecSent"));
              } else {
                setNote(dgT("inProgress.reExecFail") + (res?.error?.message ?? dgT("drag.unknownError")));
              }
            } catch (e) {
              setNote(dgT("inProgress.reExecFail") + String(e?.message ?? e));
            }
            setTimeout(() => { onConfirm(); }, 1500);
          } else {
            // 无子代理 → 派发新执行子代理
            setNote(dgT("inProgress.dispatching"));
            const r = await fetch(graphUrl("/api/dsh-graph/start-execution"), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ goal: goalId }),
            });
            const data = await r.json();
            if (data.ok) {
              if (data.child_id) {
                setNote(dgT("exec.childDispatched") + data.child_id);
                showToast(dgT("exec.childDispatched"));
              } else if (data.child_error) {
                setNote(dgT("exec.childFailed") + data.child_error);
              } else {
                setNote(dgT("exec.childNotStarted"));
              }
              setTimeout(() => { onConfirm(); }, 1200);
            } else {
              setNote(dgT("exec.executeFail") + (data.error || dgT("drag.unknownError")));
            }
          }
        } catch (e) {
          setNote(dgT("drag.requestFail") + String(e?.message ?? e));
        }
        setLoading(false);
      };

      return h("div", { style: S.overlay, ...backdropGuard },
        h("div", { style: { ...S.modal, maxWidth: 480 }, onClick: (e) => e.stopPropagation() },
          h("span", { className: "dg-close", style: S.close, onClick: onCancel }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 14, marginBottom: 8 } },
            dgT("inProgress.title", { title: goalData?.title ?? goalId })),
          h("div", { style: { ...S.meta, marginBottom: 8 } },
            hasChild
              ? dgT("inProgress.hasChild")
              : dgT("inProgress.noChild")),
          // 有子代理时：提供链接让用户自己打开会话管理
          hasChild && oldChildId
            ? h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 } },
                h("span", { style: { fontSize: 12 } }, dgT("inProgress.subagent")),
                h("button", {
                  style: { ...S.btn, fontSize: 12, padding: "2px 8px" }, className: "dg-btn",
                  onClick: (e) => {
                    e.stopPropagation();
                    if (oldParentId) openChildSession(oldParentId, oldChildId);
                  },
                }, oldChildId.slice(0, 8) + "… ↗"))
            : null,
          !hasCriteria
            ? h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-warn-label, #e0a53a)", marginBottom: 4 } },
                dgT("inProgress.noCriteria"))
            : null,
          h("div", { style: { display: "flex", gap: 8, marginTop: 4 } },
            h("button", {
              style: { ...S.btnPrimary, padding: "4px 14px", fontSize: 13 }, className: "dg-btn-primary",
              disabled: loading, onClick: startExec,
            }, loading ? dgT("common.processing") : (hasChild ? dgT("inProgress.reExecute") : dgT("inProgress.confirmExec"))),
            h("button", {
              style: { ...S.btn, padding: "4px 12px", fontSize: 12 }, className: "dg-btn",
              onClick: onCancel,
            }, dgT("common.cancel"))),
          note ? h("div", { style: { ...S.meta, marginTop: 6 } }, note) : null,
        ),
      );
    }

    // g-77647351：交付确认弹窗——告知主管需做代码合并等交付工作，提供跳转主管会话按钮
    function DeliverPrompt(props) {
      const { goalId, goalTitle, supervisorSession, onConfirm, onCancel } = props;
      // g-181：overlay backdrop 误关保护（内容起点后释放到 backdrop 的合成 click 吞掉）
      const backdropGuard = useBackdropClose(onCancel);
      const promptText = `【交付通知】目标「${goalTitle ?? goalId}」（${goalId}）即将标记为已交付。请进行最终复核：代码合并、文档更新等交付工作。`;
      const jumpToSupervisor = async () => {
        try {
          const copied = await copyText(promptText);
          const rt = sessionsRt ?? appCtx?.get?.("sessions");
          if (rt && supervisorSession) {
            rt.open?.(supervisorSession);
            activateChatTab();
          }
          if (copied) {
            showToast(dgT("exec.precopied"));
          }
        } catch { /* 静默 */ }
      };
      return h("div", { style: S.overlay, ...backdropGuard },
        h("div", { style: { ...S.modal, maxWidth: 520 }, onClick: (e) => e.stopPropagation() },
          h("span", { className: "dg-close", style: S.close, onClick: onCancel }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 14, marginBottom: 8 } },
            dgT("deliver.title", { title: goalTitle ?? goalId })),
          h("div", { style: { ...S.meta, marginBottom: 8, lineHeight: 1.8 } },
            dgT("deliver.checklist"), h("br"),
            dgT("deliver.item1"), h("br"),
            dgT("deliver.item2"), h("br"),
            dgT("deliver.item3"), h("br"),
            h("br"),
            h("span", { style: { color: "var(--dsw-alias-state-warn-label, #e0a53a)" } },
              dgT("deliver.warn"))),
          h("div", { style: { display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" } },
            supervisorSession
              ? h("button", {
                  style: { ...S.btn, padding: "4px 14px", fontSize: 13 }, className: "dg-btn",
                  onClick: jumpToSupervisor,
                }, dgT("deliver.notifySupervisor"))
              : null,
            h("button", {
              style: { ...S.btnAccept, padding: "4px 14px", fontSize: 13 }, className: "dg-btn-accept",
              onClick: () => onConfirm(),
            }, dgT("deliver.confirmDeliver")),
            h("button", {
              style: { ...S.btn, padding: "4px 12px", fontSize: 12 }, className: "dg-btn",
              onClick: onCancel,
            }, dgT("common.cancel"))),
        ),
      );
    }


    // g-105：记忆管理面板组件（手工增删改查常驻记忆与按需记忆，支持开关禁用工具）
    function MemoryManagementModal(props) {
      const [entries, setEntries] = React.useState([]);
      const [toolsEnabled, setToolsEnabled] = React.useState(true);
      const [loading, setLoading] = React.useState(true);
      const [note, setNote] = React.useState(null);
      const [tab, setTab] = React.useState("standing"); // "standing" | "on_demand"
      const [searchQuery, setSearchQuery] = React.useState("");
      const [page, setPage] = React.useState(1);
      const [totalCount, setTotalCount] = React.useState(0);
      const [totalPages, setTotalPages] = React.useState(1);
      const [showAdd, setShowAdd] = React.useState(false);
      const [newText, setNewText] = React.useState("");
      const [newScope, setNewScope] = React.useState("standing");
      const [saving, setSaving] = React.useState(false);
      const memoryGuard = useBackdropClose(props.onClose);

      const load = React.useCallback(() => {
        setLoading(true);
        const params = {
          scope: tab,
          page: String(page),
          page_size: "15",
          query: searchQuery.trim(),
        };
        fetch(graphUrl("/api/dsh-graph/memory/list", params, props.workspace))
          .then((r) => r.json())
          .then((d) => {
            setLoading(false);
            if (d.ok) {
              setEntries(Array.isArray(d.memory) ? d.memory : []);
              setTotalCount(d.total ?? 0);
              setTotalPages(d.total_pages ?? 1);
              setToolsEnabled(d.tools_enabled !== false);
            } else {
              setNote(dgT("memory.loadFail") + (d.error || dgT("drag.unknownError")));
            }
          })
          .catch((e) => {
            setLoading(false);
            setNote(dgT("memory.networkError") + String(e?.message ?? e));
          });
      }, [props.workspace, tab, page, searchQuery]);

      React.useEffect(() => { load(); }, [load]);

      const toggleTools = async () => {
        const next = !toolsEnabled;
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/memory/toggle-tools", {}, props.workspace), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: next }),
          });
          const d = await r.json();
          if (d.ok) {
            setToolsEnabled(d.tools_enabled);
            showToast(d.tools_enabled ? dgT("memory.toolsEnabledToast") : dgT("memory.toolsDisabledToast"));
          }
        } catch (e) {
          showToast(dgT("memory.toggleFail") + String(e?.message ?? e));
        }
      };

      const addMem = async () => {
        const text = newText.trim();
        if (!text) return;
        if (newScope === "standing" && [...text].length > 200) {
          setNote(dgT("memory.standingCharsExceeded", { count: [...text].length }));
          return;
        }
        setSaving(true);
        setNote(null);
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/memory/add", {}, props.workspace), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind: "project", scope: newScope, text, importance: 3 }),
          });
          const d = await r.json();
          setSaving(false);
          if (d.ok) {
            setNewText("");
            setShowAdd(false);
            showToast(dgT("memory.addSuccess"));
            load();
          } else {
            setNote(dgT("memory.addFail") + (d.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          setSaving(false);
          setNote(dgT("drag.requestFail") + String(e?.message ?? e));
        }
      };

      const delMem = async (id) => {
        if (!confirm(dgT("memory.deleteConfirm"))) return;
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/memory/delete", {}, props.workspace), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id, reason: dgT("memory.deletedByUser") }),
          });
          const d = await r.json();
          if (d.ok) {
            showToast(dgT("memory.deleteSuccess"));
            load();
          } else {
            showToast(dgT("memory.deleteFail") + (d.error || dgT("drag.unknownError")));
          }
        } catch (e) {
          showToast(dgT("memory.deleteFail") + String(e?.message ?? e));
        }
      };

      const standingList = entries.filter((e) => (e.scope ?? "on_demand") === "standing");
      const onDemandList = entries.filter((e) => (e.scope ?? "on_demand") === "on_demand");
      const currentList = tab === "standing" ? standingList : onDemandList;

      return h("div", { style: S.overlay, ...memoryGuard },
        h("div", { style: { ...S.modal, minWidth: 460, maxWidth: 640, maxHeight: "85vh", display: "flex", flexDirection: "column" }, onClick: (e) => e.stopPropagation() },
          h("span", { className: "dg-close", style: S.close, onClick: props.onClose }, "✕"),
          h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, paddingRight: 24 } },
            h("div", { style: { fontWeight: 700, fontSize: 16, display: "flex", alignItems: "center", gap: 8 } },
              dgT("memory.title"),
              h("span", { style: { ...S.meta, fontSize: 11, fontWeight: 400 } }, "(memory.jsonl)")),
            h("label", { style: { display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 12, opacity: 0.9 }, title: dgT("memory.toolsToggleTooltip") },
              h("input", { type: "checkbox", checked: toolsEnabled, onChange: toggleTools }),
              toolsEnabled ? dgT("memory.toolsEnabled") : dgT("memory.toolsDisabled"))),

          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(128,128,128,.2)", marginBottom: 10 } },
            h("div", { style: { display: "flex", gap: 8 } },
              h("button", {
                className: "dg-btn",
                style: { ...S.btn, borderBottom: tab === "standing" ? "2px solid #4c8dff" : "none", borderRadius: 0, fontWeight: tab === "standing" ? 700 : 400, padding: "6px 12px" },
                onClick: () => { setTab("standing"); setPage(1); setShowAdd(false); },
              }, dgT("memory.standingType")),
              h("button", {
                className: "dg-btn",
                style: { ...S.btn, borderBottom: tab === "on_demand" ? "2px solid #4c8dff" : "none", borderRadius: 0, fontWeight: tab === "on_demand" ? 700 : 400, padding: "6px 12px" },
                onClick: () => { setTab("on_demand"); setPage(1); setShowAdd(false); },
              }, dgT("memory.onDemandType"))),
            h("div", { style: { display: "flex", gap: 4, alignItems: "center" } },
              h("input", {
                value: searchQuery,
                style: { ...S.promptInput, width: 140, height: 26, fontSize: 11, padding: "2px 6px" },
                placeholder: dgT("memory.searchPlaceholder"),
                onChange: (e) => { setSearchQuery(e.target.value); setPage(1); },
              }),
              searchQuery ? h("button", { className: "dg-btn", style: { ...S.btn, fontSize: 11, padding: "1px 5px" }, onClick: () => { setSearchQuery(""); setPage(1); } }, "✕") : null)),

          h("div", { style: { ...S.meta, marginBottom: 8, fontSize: 11, lineHeight: 1.5 } },
            tab === "standing"
              ? dgT("memory.standingHint")
              : dgT("memory.onDemandHint")),

          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
            h("span", { style: { ...S.meta, fontSize: 12 } }, dgT("memory.total", { count: totalCount, page, totalPages })),
            h("button", {
              className: "dg-btn",
              style: { ...S.btnPrimary, fontSize: 12, padding: "2px 8px" },
              onClick: () => { setShowAdd(!showAdd); setNewScope(tab); setNote(null); },
            }, showAdd ? dgT("tags.collapse") : dgT("memory.addBtn"))),

          showAdd ? h("div", { style: { ...S.subCard, marginBottom: 12, padding: 10 } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
              h("span", { style: { fontSize: 12, fontWeight: 600 } }, dgT("memory.typeLabel")),
              h("label", { style: { fontSize: 12, cursor: "pointer" } },
                h("input", { type: "radio", name: "mem_scope", checked: newScope === "standing", onChange: () => setNewScope("standing") }), " " + dgT("memory.standingLabel")),
              h("label", { style: { fontSize: 12, cursor: "pointer", marginLeft: 8 } },
                h("input", { type: "radio", name: "mem_scope", checked: newScope === "on_demand", onChange: () => setNewScope("on_demand") }), " " + dgT("memory.onDemandLabel"))),
            h("textarea", {
              value: newText,
              style: { ...S.promptInput, width: "100%", height: 60, boxSizing: "border-box", fontSize: 12, resize: "vertical" },
              placeholder: newScope === "standing" ? dgT("memory.standingPlaceholder") : dgT("memory.onDemandPlaceholder"),
              onChange: (e) => setNewText(e.target.value),
            }),
            h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 } },
              h("span", { style: { ...S.meta, fontSize: 11, color: newScope === "standing" && [...newText].length > 200 ? "#e74c3c" : undefined } },
                dgT("memory.charCount", { count: [...newText].length, limit: newScope === "standing" ? 200 : 500 })),
              h("button", {
                className: "dg-btn",
                style: { ...S.btnPrimary, fontSize: 12 },
                disabled: saving || !newText.trim(),
                onClick: addMem,
              }, saving ? dgT("common.saving") : dgT("memory.saveBtn")))) : null,

          note ? h("div", { style: { ...S.meta, color: "#e74c3c", marginBottom: 8 } }, note) : null,

          h("div", { style: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, minHeight: 120 } },
            loading ? h("div", { style: S.meta }, dgT("memory.loading")) : (!entries.length ? h("div", { style: { ...S.meta, textAlign: "center", padding: "20px 0" } }, dgT("memory.noEntries")) : entries.map((m) =>
              h("div", { key: m.id, style: { ...S.subCard, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 } },
                h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
                  h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                    h("span", { style: { fontSize: 11, fontFamily: "monospace", opacity: 0.7 } }, m.id),
                    h("span", { style: { fontSize: 10, padding: "0 4px", borderRadius: 4, background: m.scope === "standing" ? "rgba(76,175,80,.15)" : "rgba(33,150,243,.15)", color: m.scope === "standing" ? "#4caf50" : "#2196f3" } }, m.scope === "standing" ? dgT("memory.standing") : dgT("memory.onDemand")),
                    m.source_goal ? h("span", { style: { fontSize: 10, opacity: 0.6 } }, dgT("memory.from") + m.source_goal) : null),
                  h("button", {
                    className: "dg-btn",
                    style: { ...S.btn, fontSize: 11, padding: "1px 6px", color: "#e74c3c" },
                    title: dgT("memory.deleteConfirm"),
                    onClick: () => delMem(m.id),
                  }, dgT("common.delete"))),
                h("div", { style: { fontSize: 12, lineHeight: 1.5, wordBreak: "break-word" } }, m.text))))),
          totalPages > 1 ? h("div", { style: { display: "flex", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 10, borderTop: "1px solid rgba(128,128,128,.15)", paddingTop: 8 } },
            h("button", { className: "dg-btn", style: { ...S.btn, fontSize: 11, padding: "2px 8px" }, disabled: page <= 1, onClick: () => setPage(page - 1) }, dgT("memory.prevPage")),
            h("span", { style: { ...S.meta, fontSize: 11 } }, page + " / " + totalPages),
            h("button", { className: "dg-btn", style: { ...S.btn, fontSize: 11, padding: "2px 8px" }, disabled: page >= totalPages, onClick: () => setPage(page + 1) }, dgT("memory.nextPage"))) : null,
        )
      );
    }

    function KanbanView(props) {
      useLocaleRevision();
      const [state, setState] = React.useState({ loading: true });
