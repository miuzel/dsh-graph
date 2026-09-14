    // 上下文抽屉：摘要 + 全文 + 子代理 id/链接 + g-109 收集提示词编辑 + g-128 删除按钮
    function CardDrawer(props) {
      useLocaleRevision();
      const [state, setState] = React.useState({ loading: true });
      const [promptText, setPromptText] = React.useState("");
      const [collectNote, setCollectNote] = React.useState(null);
      const [collecting, setCollecting] = React.useState(false);
      const [relaunchRoute, setRelaunchRoute] = React.useState(null); // g-109：最近一次重新收集的模型路由
      // g-128：删除确认状态
      const [deleteConfirm, setDeleteConfirm] = React.useState(false);
      const [deleteIdInput, setDeleteIdInput] = React.useState("");
      const [deleteNote, setDeleteNote] = React.useState(null);
      // g-219：删除请求进行中标记（防双击重复提交）
      const [deleting, setDeleting] = React.useState(false);
      // g-275：卡片正文展示模式——markdown 渲染（默认） / 原文
      const [viewMode, setViewMode] = React.useState("markdown");
      React.useEffect(() => {
        setViewMode("markdown");
      }, [props.cardId]);
      React.useEffect(() => {
        let alive = true;
        fetch(graphUrl("/api/dsh-graph/goal", { id: props.goalId }))
          .then((r) => r.json())
          .then((data) => alive && setState({ loading: false, data }))
          .catch((e) => alive && setState({ loading: false, error: String(e) }));
        return () => { alive = false; };
      }, [props.goalId]);

      let inner;
      if (state.loading) inner = dgT("common.loading");
      else if (state.error) inner = dgT("drawer.loadFail") + state.error;
      else {
        const card = (state.data.cards ?? []).find((c) => c.id === props.cardId);
        if (!card) inner = dgT("drawer.cardNotExist") + props.cardId;
        else {
          // g-145：生成完整的收集提示词，注入仓库根、goal/card 元数据、canonical 附件根、回填模板和禁区
          const goalTitle = state.data.meta?.title ?? props.goalId;
          const cardTitle = card.title;
          const root = state.data.root ?? dgT("drawer.unknownRoot");
          const attRoot = state.data.attachmentsDir ?? (root !== dgT("drawer.unknownRoot") ? root + "/attachments" : dgT("drawer.unknownAttachmentRoot"));

          // 可编辑的收集信息目标部分
          const editablePart = [
            dgT("drawer.collectContext"),
            ``,
            dgT("drawer.collectScope"),
            dgT("drawer.collectHint", { title: cardTitle }),
          ].join("\n");

          // 只读的规范约束部分
          const readonlyPart = [
            ``,
            dgT("drawer.canonicalAttRoot") + " " + attRoot,
            ``,
            dgT("drawer.goalInfoLabel"),
            `- id: \`${props.goalId}\``,
            `- ${dgT("createGoal.titleLabel")}: ${goalTitle}`,
            ``,
            dgT("drawer.cardInfoLabel"),
            `- id: \`${card.id}\``,
            `- ${dgT("createGoal.titleLabel")}: ${cardTitle}`,
            ``,
            dgT("drawer.backfillReq"),
            dgT("prompt.collect.backfillText"),
            dgT("prompt.collect.attachments"),
            dgT("prompt.collect.reference"),
            dgT("prompt.collect.finish"),
            `\`\`\``,
            dgT("prompt.collect.command", { goalId: props.goalId, cardId: card.id }),
            `\`\`\``,
            ``,
            dgT("prompt.collect.securityTitle"),
            dgT("prompt.collect.security"),
            ``,
            dgT("prompt.collect.forbiddenTitle"),
            dgT("prompt.collect.forbiddenGoal", { cardId: card.id }),
            dgT("prompt.collect.forbiddenReview"),
            dgT("prompt.collect.forbiddenWorkspace"),
          ].join("\n");

          const autoPrompt = editablePart + readonlyPart;
          const childLink = card.child_id
            ? h("div", { style: S.drawerSection, key: "child" },
                h("div", { style: { ...S.drawerH, display: "flex", alignItems: "center", justifyContent: "space-between" } },
                  dgT("drawer.subagent"),
                  sessionLinkBtn(card.parent_session_id, card.child_id, dgT("card.goToSession"))),
                h("div", { style: S.meta }, `id：${card.child_id}`))
            : null;
          // g-109：收集提示词编辑区（空卡片显示）
          const collectPanel = card.status === "empty" || card.status === "collecting"
            ? h("div", { style: S.drawerSection, key: "collect", className: "dg-collect-prompt" },
                h("div", { style: S.drawerH }, dgT("drawer.collectTitle")),
                // 可编辑的收集信息目标部分
                h("div", { style: { marginTop: 4, marginBottom: 8 } },
                  h("div", { style: { fontWeight: 600, fontSize: 12, opacity: 0.9, marginBottom: 4 } }, dgT("drawer.collectInfoTarget")),
                  h("textarea", {
                    style: { ...S.promptInput, width: "100%", minHeight: 150, resize: "vertical", marginTop: 2 },
                    value: promptText ? promptText.split(readonlyPart)[0] : editablePart,
                    onChange: (e) => {
                      const newEditable = e.target.value;
                      setPromptText(newEditable + readonlyPart);
                    },
                  })),
                // 只读的规范约束部分
                h("div", { style: { marginTop: 4, marginBottom: 8 } },
                  h("div", { style: { fontWeight: 600, fontSize: 12, opacity: 0.9, marginBottom: 4 } }, dgT("drawer.collectConstraints")),
                  h("div", {
                    style: {
                      ...S.promptInput,
                      width: "100%",
                      minHeight: 80,
                      maxHeight: 200,
                      overflowY: "auto",
                      marginTop: 2,
                      whiteSpace: "pre-wrap",
                      opacity: 0.7,
                      pointerEvents: "none",
                      userSelect: "none",
                    },
                  }, readonlyPart)),
                h("button", {
                  style: { ...S.btn, marginTop: 6, padding: "4px 14px" }, className: "dg-btn",
                  disabled: collecting,
                  onClick: async () => {
                    setCollecting(true);
                    setCollectNote(dgT("drawer.dispatching"));
                    try {
                      const r = await fetch(graphUrl("/api/dsh-graph/start-collection"), {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                          goal: props.goalId,
                          card: props.cardId,
                          prompt: promptText || autoPrompt,
                        }),
                      });
                      const data = await r.json();
                      if (data.ok) {
                        if (data.child_error) {
                          setCollectNote(dgT("drawer.collectChildFailed") + data.child_error);
                        } else if (data.child_id) {
                          setCollectNote(dgT("drawer.collectSuccess") + data.child_id);
                        } else {
                          setCollectNote(dgT("drawer.collectChildNotStarted"));
                        }
                      } else {
                        setCollectNote(dgT("drawer.collectFail") + (data.error || dgT("drag.unknownError")));
                      }
                    } catch (e) {
                      setCollectNote(dgT("drag.requestFail") + String(e?.message ?? e));
                    }
                    setCollecting(false);
                  },
                }, dgT("drawer.startCollect")),
                collectNote ? h("div", { style: { ...S.meta, marginTop: 4 } }, collectNote) : null)
            : null;
          // g-154: 卡片文件入口（复用 goal.md 同类的 file-link/open-file 机制）
          const cardFileEntry = card.cardFile
            ? h("div", { key: "f", style: { ...S.drawerSection, display: "flex", alignItems: "center", gap: 6 } },
                h("span", { style: { fontSize: 11, opacity: 0.7 } }, dgT("drawer.cardFile")),
                h("button", {
                  style: { ...S.btn, fontSize: 11, padding: "1px 6px" },
                  className: "dg-btn",
                  title: dgT("drawer.openCardFile"),
                  onClick: async (e) => {
                    e.stopPropagation();
                    // g-222：统一走共享 openHostPath，失败透出可理解错误（C3/C4）
                    const r = await openHostPath(card.cardFile);
                    if (r.opened) { showToast(dgT("drawer.cardFileOpened")); return; }
                    await copyText(card.cardFile);
                    if (r.error) { showToast(dgT("tab.openFailed") + openErrorText(r.error)); }
                    else { showToast(dgT("tab.pathCopiedNoOpen")); }
                  },
                }, dgT("tab.openFile")),
                h("button", {
                  style: { ...S.btn, fontSize: 11, padding: "1px 6px" },
                  className: "dg-btn",
                  title: dgT("drawer.copyCardPath"),
                  onClick: async (e) => { e.stopPropagation(); const ok = await copyText(card.cardFile); if (ok) showToast(dgT("tab.pathCopied")); },
                }, dgT("tab.copyPath")))
            : h("div", { key: "f", style: { ...S.drawerSection, display: "flex", alignItems: "center", gap: 6, opacity: 0.5 } },
                h("span", { style: { fontSize: 11 } }, dgT("drawer.cardFile")),
                h("span", { style: { fontSize: 11 } }, dgT("drawer.noFilePath")));

          const rawContent = card.content?.trim() || "";
          const hasCardContent = rawContent.length > 0;

          inner = [
            h("div", { key: "t", style: { fontWeight: 700, fontSize: 14 } },
              `📇 ${card.title}`),
            h("div", { key: "m", style: S.meta },
              `${card.id} ｜ ${card.scope === "shared" ? dgT("drawer.sharedEntry") : dgT("drawer.ownedEntry")} ｜ ${CARD_STATUS_ICON[card.status] ?? card.status}${card.filled_by ? " ｜ " + dgT("drawer.filledBy") + card.filled_by : ""}`),
            cardFileEntry,
            childLink,
            card.summary ? h("div", { key: "s", style: S.drawerSection },
              h("div", { style: S.drawerH }, dgT("drawer.summary")), card.summary) : null,
            // 附件引用（安全下载链接，不内联渲染用户 Markdown/HTML/SVG）
            (Array.isArray(card.attachments) && card.attachments.length)
              ? h("div", { key: "att", style: S.drawerSection },
                  h("div", { style: S.drawerH }, dgT("drawer.attachmentRefs")),
                  card.attachments.map((a) =>
                    h("div", { key: a, style: { ...S.meta, fontSize: 12 } },
                      h("a", {
                        href: graphUrl("/api/dsh-graph/attachment?name=" + encodeURIComponent(a)),
                        target: "_blank", rel: "noopener noreferrer",
                        style: { color: "var(--dsw-alias-label-link, #4c8dff)", textDecoration: "underline" },
                      }, `@att/${a}`),
                      " (" + dgT("common.open") + ")")))
              : null,
            h("div", { key: "body", style: S.drawerSection },
              h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 6 } },
                h("div", { style: { ...S.drawerH, marginBottom: 0 } }, dgT("drawer.fullText")),
                h("div", { style: { flex: 1 } }),
                hasCardContent
                  ? h(MarkdownViewToggle, {
                      viewMode,
                      onChange: setViewMode,
                      tipMarkdown: dgT("drawer.viewMarkdownTip"),
                      tipRaw: dgT("drawer.viewRawTip"),
                    })
                  : null),
              hasCardContent
                ? h(GoalMarkdown, { text: card.content, viewMode })
                : h("div", { style: { ...S.meta, fontSize: 12, opacity: 0.6 } }, dgT("drawer.noContent"))),
            collectPanel,
            // g-128：卡片删除按钮（二次确认 + 输入卡片 id 防误删）
            h("div", { key: "del", style: { ...S.drawerSection, borderTop: "1px solid rgba(128,128,128,.25)", paddingTop: 8 } },
              deleteConfirm
                ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                    h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-error-primary, #d66)", fontSize: 12 } },
                      dgT("drawer.deleteConfirm", { title: card.title })),
                    h("div", { style: { ...S.meta, fontSize: 11, opacity: 0.7 } },
                      `id：${card.id}`),
                    h("input", {
                      style: { ...S.promptInput, fontSize: 12 },
                      value: deleteIdInput,
                      placeholder: dgT("drawer.deleteIdPlaceholder"),
                      onChange: (e) => setDeleteIdInput(e.target.value),
                    }),
                    h("div", { style: { display: "flex", gap: 6 } },
                      h("button", {
                        style: { ...S.btnDanger, fontSize: 11, padding: "2px 8px" },
                        className: "dg-btn-danger",
                        disabled: deleteIdInput.trim() !== card.id || deleting,
                        onClick: async () => {
                          if (deleting) return; // g-219：防双击重复提交
                          setDeleting(true);
                          try {
                            const r = await fetch(graphUrl("/api/dsh-graph/delete-card"), {
                              method: "POST",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify({ goal: props.goalId, card: props.cardId }),
                            });
                            const data = await r.json();
                            if (data.ok) {
                              setDeleteNote(dgT("drawer.cardDeleted"));
                              showToast(dgT("drawer.cardDeleted"));
                              setDeleteConfirm(false);
                              setDeleteIdInput("");
                              // g-219：事件结果为准——先通知外部局部移除，再关抽屉
                              if (props.onDeleted) props.onDeleted(card.id);
                              props.onClose?.();
                            } else {
                              // g-219：删除被拒（如 collecting）——明确提示并保留确认态
                              const msg = (data.error || dgT("drag.unknownError"));
                              setDeleteNote("⚠️ " + msg);
                              showToast(dgT("drawer.deleteFail") + msg);
                            }
                          } catch (e) {
                            setDeleteNote(dgT("drag.requestFail") + String(e?.message ?? e));
                          } finally {
                            setDeleting(false);
                          }
                        },
                      }, dgT("drawer.deleteConfirmBtn")),
                      h("button", {
                        style: { ...S.btn, fontSize: 11, padding: "2px 8px" },
                        className: "dg-btn",
                        onClick: () => { setDeleteConfirm(false); setDeleteIdInput(""); setDeleteNote(null); },
                      }, dgT("common.cancel")))
                  )
                : h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
                    // g-183：共享/自有转换 + 解除引用（goal 详情方向独立；核心层守卫引用计数与归属）
                    card.scope === "shared"
                      ? h("button", {
                          style: { ...S.btn, fontSize: 11, padding: "2px 8px" },
                          className: "dg-btn",
                          disabled: card.status === "collecting",
                          title: card.status === "collecting" ? dgT("drawer.unrefCollecting") : dgT("drawer.unrefTooltip"),
                          onClick: async () => {
                            try {
                              const r = await fetch(graphUrl("/api/dsh-graph/unreference-shared-card"), {
                                method: "POST", headers: { "content-type": "application/json" },
                                body: JSON.stringify({ goal: props.goalId, card: props.cardId }),
                              });
                              const data = await r.json();
                              if (data.ok) { showToast(dgT("drawer.unrefSuccess")); props.onDeleted?.(); }
                              else setDeleteNote(dgT("drawer.deleteRefFail") + (data.error || dgT("drag.unknownError")));
                            } catch (e) { setDeleteNote(dgT("drag.requestFail") + String(e?.message ?? e)); }
                          },
                        }, dgT("drawer.unrefBtn"))
                      : h("button", {
                          style: { ...S.btn, fontSize: 11, padding: "2px 8px" },
                          className: "dg-btn",
                          disabled: card.status === "collecting",
                          title: card.status === "collecting" ? dgT("drawer.convertCollecting") : dgT("drawer.convertToSharedTooltip"),
                          onClick: async () => {
                            try {
                              const r = await fetch(graphUrl("/api/dsh-graph/convert-card-to-shared"), {
                                method: "POST", headers: { "content-type": "application/json" },
                                body: JSON.stringify({ goal: props.goalId, card: props.cardId }),
                              });
                              const data = await r.json();
                              if (data.ok) { showToast(dgT("drawer.convertedToShared")); (props.onConverted ?? props.onDeleted)?.(); }
                              else setDeleteNote(dgT("drawer.convertFail") + (data.error || dgT("drag.unknownError")));
                            } catch (e) { setDeleteNote(dgT("drag.requestFail") + String(e?.message ?? e)); }
                          },
                        }, dgT("drawer.convertToShared")),
                    card.scope === "shared"
                      ? h("button", {
                          style: { ...S.btn, fontSize: 11, padding: "2px 8px" },
                          className: "dg-btn",
                          disabled: card.status === "collecting",
                          title: card.status === "collecting" ? dgT("drawer.convertCollecting") : dgT("drawer.convertToOwnedTooltip"),
                          onClick: async () => {
                            try {
                              const r = await fetch(graphUrl("/api/dsh-graph/convert-card-to-owned"), {
                                method: "POST", headers: { "content-type": "application/json" },
                                body: JSON.stringify({ goal: props.goalId, card: props.cardId }),
                              });
                              const data = await r.json();
                              if (data.ok) { showToast(dgT("drawer.convertedToOwned")); (props.onConverted ?? props.onDeleted)?.(); }
                              else setDeleteNote(dgT("drawer.convertFail") + (data.error || dgT("drag.unknownError")));
                            } catch (e) { setDeleteNote(dgT("drag.requestFail") + String(e?.message ?? e)); }
                          },
                        }, dgT("drawer.convertToOwned"))
                      : null,
                    // 仅 goal 自有卡可删除（共享卡走解除引用/共享面板显式删除，避免必然报错）
                    card.scope !== "shared"
                      ? h("button", {
                          style: { ...S.btnDanger, fontSize: 11, padding: "2px 8px" },
                          className: "dg-btn-danger",
                          disabled: card.status === "collecting",
                          title: card.status === "collecting" ? dgT("drawer.deleteCollecting") : dgT("drawer.deleteCardTooltip"),
                          onClick: () => { setDeleteConfirm(true); setDeleteIdInput(""); setDeleteNote(null); },
                        }, dgT("drawer.deleteCard"))
                      : null),
              deleteNote ? h("div", { style: { ...S.meta, marginTop: 4, fontSize: 11, color: deleteNote.startsWith("⚠️") ? "var(--dsw-alias-state-error-primary, #d66)" : undefined } }, deleteNote) : null),
            // g-107：卡片会话内嵌——实时状态/模型/直达指令/最近记录
            // g-109 判据反馈：收集子代理出错时在实时会话控件内换 provider/model 重新收集
            card.child_id
              ? h(SessionPanel, { key: "live", parentId: card.parent_session_id, childId: card.child_id, collapsible: true,
                                  provider: card.provider, model: card.model,
                                  goalId: props.goalId, relaunchKind: "collect",
                                  relaunchCardId: props.cardId, relaunchPrompt: promptText || autoPrompt,
                                  relaunchRoute, onRelaunched: setRelaunchRoute })
              : null,
          ];
        }
      }
      return h(
        "div",
        null,
        h("div", { style: { ...S.overlay, background: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,.35))" }, onClick: props.onClose }),
        h("div", { style: S.drawer, onClick: (e) => e.stopPropagation() },
          h("span", { style: S.close, onClick: props.onClose }, "✕"),
          inner),
      );

    // Source contract: sessionLinkBtn(card.parent_session_id, card.child_id, "↗ 转到对话").
