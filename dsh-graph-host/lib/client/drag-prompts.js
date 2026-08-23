    function BackwardReasonPrompt(props) {
      const { goalId, toStatus, hasChild, childId, parentId, onConfirm, onCancel } = props;
      const [reason, setReason] = React.useState("");
      const [sending, setSending] = React.useState(false);
      const [sent, setSent] = React.useState(false);
      // 如果有子代理，通过 session.prompt 发送理由
      const { session } = useBoundSession(parentId, childId);
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
      return h("div", { style: S.overlay, onClick: onCancel },
        h("div", { style: { ...S.modal, maxWidth: 480 }, onClick: (e) => e.stopPropagation() },
          h("span", { style: S.close, onClick: onCancel }, "✕"),
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
              style: { ...S.btn, padding: "4px 14px", fontSize: 13 }, className: "dg-btn",
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

      return h("div", { style: S.overlay, onClick: onCancel },
        h("div", { style: { ...S.modal, maxWidth: 480 }, onClick: (e) => e.stopPropagation() },
          h("span", { style: S.close, onClick: onCancel }, "✕"),
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
            ? h("div", { style: { ...S.meta, color: "#e0a53a", marginBottom: 4 } },
                "⚠️ 质量判据尚未登记——将以授权模式强制迁移到执行列。")
            : null,
          h("div", { style: { display: "flex", gap: 8, marginTop: 4 } },
            h("button", {
              style: { ...S.btn, padding: "4px 14px", fontSize: 13 }, className: "dg-btn",
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
      return h("div", { style: S.overlay, onClick: onCancel },
        h("div", { style: { ...S.modal, maxWidth: 520 }, onClick: (e) => e.stopPropagation() },
          h("span", { style: S.close, onClick: onCancel }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 14, marginBottom: 8 } },
            `📦 交付「${goalTitle ?? goalId}」`),
          h("div", { style: { ...S.meta, marginBottom: 8, lineHeight: 1.8 } },
            "交付前请确保以下工作已完成：", h("br"),
            "• 代码已合并到主分支", h("br"),
            "• 相关文档/配置已更新", h("br"),
            "• 已通知主管进行最终复核", h("br"),
            h("br"),
            h("span", { style: { color: "#e0a53a" } },
              "⚠️ 标记为「已交付」后需主管评审通过才能正式完成。")),
          h("div", { style: { display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" } },
            supervisorSession
              ? h("button", {
                  style: { ...S.btn, padding: "4px 14px", fontSize: 13 }, className: "dg-btn",
                  onClick: jumpToSupervisor,
                }, "↗ 告知主管")
              : null,
            h("button", {
              style: { ...S.btn, padding: "4px 14px", fontSize: 13 }, className: "dg-btn",
              onClick: () => onConfirm(),
            }, "📦 确认交付"),
            h("button", {
              style: { ...S.btn, padding: "4px 12px", fontSize: 12 }, className: "dg-btn",
              onClick: onCancel,
            }, "取消")),
        ),
      );
    }

    function KanbanView(props) {
      const [state, setState] = React.useState({ loading: true });
