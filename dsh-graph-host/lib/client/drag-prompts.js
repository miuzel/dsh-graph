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
            `⬅️ 回退到「${STATUS_LABEL[toStatus] ?? toStatus}」`),
          h("div", { style: { ...S.meta, marginBottom: 8 } },
            `目标 ${goalId} 将从当前状态回退到「${STATUS_LABEL[toStatus] ?? toStatus}」。`,
            h("br"),
            hasChild
              ? "理由将作为消息发送给执行子代理。"
              : "理由将作为补充信息记录（无执行子代理时供主管参考）。"),
          h("textarea", {
            style: { ...S.promptInput, width: "100%", minHeight: 80, resize: "vertical", marginTop: 4 },
            value: reason,
            placeholder: "请输入回退理由（可选）…",
            onChange: (e) => setReason(e.target.value),
          }),
          h("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
            h("button", {
              style: { ...S.btnPrimary, padding: "4px 14px", fontSize: 13 }, className: "dg-btn-primary",
              disabled: sending, onClick: sendReason,
            }, sending ? "发送中…" : (sent ? "✅ 已发送" : "确认回退")),
            h("button", {
              style: { ...S.btn, padding: "4px 12px", fontSize: 12 }, className: "dg-btn",
              onClick: onCancel,
            }, "取消")),
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
          setNote("⚠️ 该 workspace 未配置 supervisor.session（project.yaml）。请先在此 workspace 运行 graph_claim_supervisor() 完成主管会话接管，再执行。");
          return;
        }
        setLoading(true);
        try {
          // Step 1: force transition 到 in_progress（人工拖动视为授权）
          setNote("迁移中…");
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

          if (hasChild && oldSession?.prompt) {
            // 有子代理 → 排队发"重新执行"消息，不派新子代理
            setNote("发送重新执行指令…");
            try {
              const res = await oldSession.prompt(
                [{ type: "text", text: `【重新执行】用户从看板拖放触发重新执行目标 ${goalId}。请从头开始执行目标描述和质量判据中的任务。` }],
                "queue",
              );
              if (res?.ok) {
                setNote("✅ 已向子代理排队发送重新执行指令");
                showToast("✅ 已向子代理发送重新执行指令");
              } else {
                setNote("⚠️ 发送失败：" + (res?.error?.message ?? "未知错误") + "。请打开子代理会话手动操作。");
              }
            } catch (e) {
              setNote("⚠️ 发送失败：" + String(e?.message ?? e) + "。请打开子代理会话手动操作。");
            }
            setTimeout(() => { onConfirm(); }, 1500);
          } else {
            // 无子代理 → 派发新执行子代理
            setNote("派发子代理…");
            const r = await fetch(graphUrl("/api/dsh-graph/start-execution"), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ goal: goalId }),
            });
            const data = await r.json();
            if (data.ok) {
              if (data.child_id) {
                setNote("✅ 已派发执行子代理，id：" + data.child_id);
                showToast("✅ 已派发执行子代理");
              } else if (data.child_error) {
                setNote("⚠️ 子代理启动失败：" + data.child_error);
              } else {
                setNote("⚠️ 子代理未启动（无 child_id）");
              }
              setTimeout(() => { onConfirm(); }, 1200);
            } else {
              setNote("⚠️ 执行失败：" + (data.error || "未知错误"));
            }
          }
        } catch (e) {
          setNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setLoading(false);
      };

      return h("div", { style: S.overlay, ...backdropGuard },
        h("div", { style: { ...S.modal, maxWidth: 480 }, onClick: (e) => e.stopPropagation() },
          h("span", { className: "dg-close", style: S.close, onClick: onCancel }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 14, marginBottom: 8 } },
            `🚀 执行「${goalData?.title ?? goalId}」`),
          h("div", { style: { ...S.meta, marginBottom: 8 } },
            hasChild
              ? "该目标已有执行子代理。将向其发送重新执行指令（排队），不另起新子代理。"
              : "将为目标创建执行子代理，状态迁移到「执行中」。"),
          // 有子代理时：提供链接让用户自己打开会话管理
          hasChild && oldChildId
            ? h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 } },
                h("span", { style: { fontSize: 12 } }, "🔗 子代理："),
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
                "⚠️ 质量判据尚未登记——将以授权模式强制迁移到执行列。")
            : null,
          h("div", { style: { display: "flex", gap: 8, marginTop: 4 } },
            h("button", {
              style: { ...S.btnPrimary, padding: "4px 14px", fontSize: 13 }, className: "dg-btn-primary",
              disabled: loading, onClick: startExec,
            }, loading ? "处理中…" : (hasChild ? "🔄 重新执行" : "🚀 确认执行")),
            h("button", {
              style: { ...S.btn, padding: "4px 12px", fontSize: 12 }, className: "dg-btn",
              onClick: onCancel,
            }, "取消")),
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
            showToast("✅ 预填内容已复制，到主管对话窗 Ctrl+V 直接粘贴发送");
          }
        } catch { /* 静默 */ }
      };
      return h("div", { style: S.overlay, ...backdropGuard },
        h("div", { style: { ...S.modal, maxWidth: 520 }, onClick: (e) => e.stopPropagation() },
          h("span", { className: "dg-close", style: S.close, onClick: onCancel }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 14, marginBottom: 8 } },
            `📦 交付「${goalTitle ?? goalId}」`),
          h("div", { style: { ...S.meta, marginBottom: 8, lineHeight: 1.8 } },
            "交付前请确保以下工作已完成：", h("br"),
            "• 代码已合并到主分支", h("br"),
            "• 相关文档/配置已更新", h("br"),
            "• 已通知主管进行最终复核", h("br"),
            h("br"),
            h("span", { style: { color: "var(--dsw-alias-state-warn-label, #e0a53a)" } },
              "⚠️ 标记为「已交付」后需主管评审通过才能正式完成。")),
          h("div", { style: { display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" } },
            supervisorSession
              ? h("button", {
                  style: { ...S.btn, padding: "4px 14px", fontSize: 13 }, className: "dg-btn",
                  onClick: jumpToSupervisor,
                }, "↗ 告知主管")
              : null,
            h("button", {
              style: { ...S.btnAccept, padding: "4px 14px", fontSize: 13 }, className: "dg-btn-accept",
              onClick: () => onConfirm(),
            }, "📦 确认交付"),
            h("button", {
              style: { ...S.btn, padding: "4px 12px", fontSize: 12 }, className: "dg-btn",
              onClick: onCancel,
            }, "取消")),
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
              setNote("⚠️ 加载失败：" + (d.error || "未知错误"));
            }
          })
          .catch((e) => {
            setLoading(false);
            setNote("⚠️ 网络错误：" + String(e?.message ?? e));
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
            showToast(d.tools_enabled ? "✅ 已启用 Agent 记忆工具" : "🔒 已禁用 Agent 记忆工具（纯手工管理模式）");
          }
        } catch (e) {
          showToast("⚠️ 切换失败：" + String(e?.message ?? e));
        }
      };

      const addMem = async () => {
        const text = newText.trim();
        if (!text) return;
        if (newScope === "standing" && [...text].length > 200) {
          setNote("⚠️ 常驻记忆硬上限为 200 字符，当前已输入 " + [...text].length + " 字");
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
            showToast("✅ 记忆添加成功");
            load();
          } else {
            setNote("⚠️ 添加失败：" + (d.error || "未知错误"));
          }
        } catch (e) {
          setSaving(false);
          setNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
      };

      const delMem = async (id) => {
        if (!confirm("确认删除该条记忆？")) return;
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/memory/delete", {}, props.workspace), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id, reason: "用户在管理面板手动删除" }),
          });
          const d = await r.json();
          if (d.ok) {
            showToast("✅ 已删除记忆");
            load();
          } else {
            showToast("⚠️ 删除失败：" + (d.error || "未知错误"));
          }
        } catch (e) {
          showToast("⚠️ 删除失败：" + String(e?.message ?? e));
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
              "🧠 长期记忆管理",
              h("span", { style: { ...S.meta, fontSize: 11, fontWeight: 400 } }, "(memory.jsonl)")),
            h("label", { style: { display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 12, opacity: 0.9 }, title: "关闭后，所有子代理将无法调用记忆工具，避免意外修改或插件冲突" },
              h("input", { type: "checkbox", checked: toolsEnabled, onChange: toggleTools }),
              toolsEnabled ? "允许 Agent 工具调用" : "🔒 纯手工模式(工具已禁用)")),

          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(128,128,128,.2)", marginBottom: 10 } },
            h("div", { style: { display: "flex", gap: 8 } },
              h("button", {
                className: "dg-btn",
                style: { ...S.btn, borderBottom: tab === "standing" ? "2px solid #4c8dff" : "none", borderRadius: 0, fontWeight: tab === "standing" ? 700 : 400, padding: "6px 12px" },
                onClick: () => { setTab("standing"); setPage(1); setShowAdd(false); },
              }, "常驻记忆 (固定植入)"),
              h("button", {
                className: "dg-btn",
                style: { ...S.btn, borderBottom: tab === "on_demand" ? "2px solid #4c8dff" : "none", borderRadius: 0, fontWeight: tab === "on_demand" ? 700 : 400, padding: "6px 12px" },
                onClick: () => { setTab("on_demand"); setPage(1); setShowAdd(false); },
              }, "按需记忆 (分页检索)")),
            h("div", { style: { display: "flex", gap: 4, alignItems: "center" } },
              h("input", {
                value: searchQuery,
                style: { ...S.promptInput, width: 140, height: 26, fontSize: 11, padding: "2px 6px" },
                placeholder: "搜索记忆内容…",
                onChange: (e) => { setSearchQuery(e.target.value); setPage(1); },
              }),
              searchQuery ? h("button", { className: "dg-btn", style: { ...S.btn, fontSize: 11, padding: "1px 5px" }, onClick: () => { setSearchQuery(""); setPage(1); } }, "✕") : null)),

          h("div", { style: { ...S.meta, marginBottom: 8, fontSize: 11, lineHeight: 1.5 } },
            tab === "standing"
              ? "💡【常驻记忆】：作为系统 Prompt 独立章节固定植入每个会话（单条硬上限 ≤ 200 字），适合记录工作区核心硬性约束与安全铁律。"
              : "💡【按需记忆】：平时不植入会话、不占 token；仅在检索或手动调用时按需提取，适合技术方案决策与参考事实。"),

          h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
            h("span", { style: { ...S.meta, fontSize: 12 } }, "共 " + totalCount + " 条（第 " + page + " / " + totalPages + " 页）"),
            h("button", {
              className: "dg-btn",
              style: { ...S.btnPrimary, fontSize: 12, padding: "2px 8px" },
              onClick: () => { setShowAdd(!showAdd); setNewScope(tab); setNote(null); },
            }, showAdd ? "收起输入框" : "＋ 新增记忆")),

          showAdd ? h("div", { style: { ...S.subCard, marginBottom: 12, padding: 10 } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
              h("span", { style: { fontSize: 12, fontWeight: 600 } }, "类型："),
              h("label", { style: { fontSize: 12, cursor: "pointer" } },
                h("input", { type: "radio", name: "mem_scope", checked: newScope === "standing", onChange: () => setNewScope("standing") }), " 常驻记忆(≤200字)"),
              h("label", { style: { fontSize: 12, cursor: "pointer", marginLeft: 8 } },
                h("input", { type: "radio", name: "mem_scope", checked: newScope === "on_demand", onChange: () => setNewScope("on_demand") }), " 按需记忆(≤500字)")),
            h("textarea", {
              value: newText,
              style: { ...S.promptInput, width: "100%", height: 60, boxSizing: "border-box", fontSize: 12, resize: "vertical" },
              placeholder: newScope === "standing" ? "输入要沉淀的常驻约束（硬上限 200 字符）…" : "输入按需参考记忆…",
              onChange: (e) => setNewText(e.target.value),
            }),
            h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 } },
              h("span", { style: { ...S.meta, fontSize: 11, color: newScope === "standing" && [...newText].length > 200 ? "#e74c3c" : undefined } },
                [...newText].length + " / " + (newScope === "standing" ? "200" : "500") + " 字"),
              h("button", {
                className: "dg-btn",
                style: { ...S.btnPrimary, fontSize: 12 },
                disabled: saving || !newText.trim(),
                onClick: addMem,
              }, saving ? "保存中…" : "确认保存"))) : null,

          note ? h("div", { style: { ...S.meta, color: "#e74c3c", marginBottom: 8 } }, note) : null,

          h("div", { style: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, minHeight: 120 } },
            loading ? h("div", { style: S.meta }, "正在读取记忆…") : (!entries.length ? h("div", { style: { ...S.meta, textAlign: "center", padding: "20px 0" } }, "（当前分类下暂无记忆条目）") : entries.map((m) =>
              h("div", { key: m.id, style: { ...S.subCard, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 } },
                h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
                  h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                    h("span", { style: { fontSize: 11, fontFamily: "monospace", opacity: 0.7 } }, m.id),
                    h("span", { style: { fontSize: 10, padding: "0 4px", borderRadius: 4, background: m.scope === "standing" ? "rgba(76,175,80,.15)" : "rgba(33,150,243,.15)", color: m.scope === "standing" ? "#4caf50" : "#2196f3" } }, m.scope === "standing" ? "常驻" : "按需"),
                    m.source_goal ? h("span", { style: { fontSize: 10, opacity: 0.6 } }, "来自: " + m.source_goal) : null),
                  h("button", {
                    className: "dg-btn",
                    style: { ...S.btn, fontSize: 11, padding: "1px 6px", color: "#e74c3c" },
                    title: "删除该条记忆",
                    onClick: () => delMem(m.id),
                  }, "删除")),
                h("div", { style: { fontSize: 12, lineHeight: 1.5, wordBreak: "break-word" } }, m.text))))),
          totalPages > 1 ? h("div", { style: { display: "flex", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 10, borderTop: "1px solid rgba(128,128,128,.15)", paddingTop: 8 } },
            h("button", { className: "dg-btn", style: { ...S.btn, fontSize: 11, padding: "2px 8px" }, disabled: page <= 1, onClick: () => setPage(page - 1) }, "上一页"),
            h("span", { style: { ...S.meta, fontSize: 11 } }, page + " / " + totalPages),
            h("button", { className: "dg-btn", style: { ...S.btn, fontSize: 11, padding: "2px 8px" }, disabled: page >= totalPages, onClick: () => setPage(page + 1) }, "下一页")) : null,
        )
      );
    }

    function KanbanView(props) {
      const [state, setState] = React.useState({ loading: true });
