    // ===== g-280：上下文卡片抽屉拖拽调宽纯函数与常量 =====
    const DEFAULT_CARD_DRAWER_WIDTH = 400;
    const MIN_CARD_DRAWER_WIDTH = 380;
    const MAX_CARD_DRAWER_WIDTH = 1200;
    const CARD_DRAWER_STORAGE_KEY = "dg-card-drawer-width";

    /**
     * 钳位卡片抽屉宽度（g-280 纯函数）
     * 约束：
     * - 最小 380px、最大 min(1200, window.innerWidth * 0.9)
     * - 视口缩小时自适应不溢出
     * - 非法值（NaN/非数值）安全回退默认 400px 并钳位
     *
     * @param {number|string} rawWidth - 待钳位宽度
     * @param {number} [windowWidth] - 可选视口宽度（默认读 window.innerWidth，Node/无 window 则默认 1920）
     * @returns {number} 钳位后的有效像素宽度
     */
    function clampDrawerWidth(rawWidth, windowWidth) {
      const winW = typeof windowWidth === "number" && !isNaN(windowWidth) && windowWidth > 0
        ? windowWidth
        : (typeof window !== "undefined" && typeof window.innerWidth === "number" && window.innerWidth > 0
          ? window.innerWidth
          : 1920);

      const max = Math.min(MAX_CARD_DRAWER_WIDTH, winW * 0.9);
      const min = Math.min(MIN_CARD_DRAWER_WIDTH, max);

      const parsed = typeof rawWidth === "number" ? rawWidth : parseFloat(rawWidth);
      const num = !isNaN(parsed) ? parsed : DEFAULT_CARD_DRAWER_WIDTH;

      return Math.min(max, Math.max(min, Math.round(num)));
    }

    /**
     * 从 localStorage 读取持久化抽屉宽度并安全钳位（g-280 纯函数）
     *
     * @param {Storage|null} [storage] - 可选 storage 实例（默认 window.localStorage）
     * @param {number} [windowWidth] - 可选视口宽度
     * @returns {number} 安全钳位后的宽度
     */
    function readDrawerWidth(storage, windowWidth) {
      const s = storage !== undefined ? storage : (typeof window !== "undefined" ? window.localStorage : null);
      if (!s) return clampDrawerWidth(DEFAULT_CARD_DRAWER_WIDTH, windowWidth);
      try {
        const raw = s.getItem(CARD_DRAWER_STORAGE_KEY);
        if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
          return clampDrawerWidth(DEFAULT_CARD_DRAWER_WIDTH, windowWidth);
        }
        const val = Number(raw);
        if (isNaN(val) || val <= 0) {
          return clampDrawerWidth(DEFAULT_CARD_DRAWER_WIDTH, windowWidth);
        }
        return clampDrawerWidth(val, windowWidth);
      } catch (_e) {
        return clampDrawerWidth(DEFAULT_CARD_DRAWER_WIDTH, windowWidth);
      }
    }

    /**
     * 将抽屉宽度持久化至 localStorage（g-280 纯函数）
     *
     * @param {number} width - 待保存宽度
     * @param {Storage|null} [storage] - 可选 storage 实例（默认 window.localStorage）
     * @param {number} [windowWidth] - 可选视口宽度
     * @returns {number} 实际保存的钳位宽度
     */
    function writeDrawerWidth(width, storage, windowWidth) {
      const clamped = clampDrawerWidth(width, windowWidth);
      const s = storage !== undefined ? storage : (typeof window !== "undefined" ? window.localStorage : null);
      if (s) {
        try {
          s.setItem(CARD_DRAWER_STORAGE_KEY, String(clamped));
        } catch (_e) {
          // 容错：localStorage 禁用或超限时不阻断 UI
        }
      }
      return clamped;
    }

    // 上下文抽屉：摘要 + 全文 + 子代理 id/链接 + g-109 收集提示词编辑 + g-128 删除按钮 + g-275 共享卡支持
    function CardDrawer(props) {
      useLocaleRevision();
      const [width, setWidth] = React.useState(() => readDrawerWidth());
      const [isDragging, setIsDragging] = React.useState(false);
      const [isHovered, setIsHovered] = React.useState(false);

      // g-280：视口缩小时自适应，防止抽屉宽度溢出视口 90%
      React.useEffect(() => {
        function handleResize() {
          setWidth((prev) => {
            const clamped = clampDrawerWidth(prev, window.innerWidth);
            return clamped !== prev ? clamped : prev;
          });
        }
        window.addEventListener("resize", handleResize);
        return () => {
          window.removeEventListener("resize", handleResize);
        };
      }, []);

      // g-280：拖拽宽度监听：mousemove/mouseup 必须挂在 window 上（快速甩出仍可追踪），
      // 释放后平滑结束；组件卸载时必须解绑（无幽灵拖拽、无泄漏）
      React.useEffect(() => {
        if (!isDragging) return;

        function handleMouseMove(e) {
          const nextWidth = clampDrawerWidth(window.innerWidth - e.clientX, window.innerWidth);
          setWidth(nextWidth);
        }

        function handleMouseUp(e) {
          const finalWidth = clampDrawerWidth(window.innerWidth - e.clientX, window.innerWidth);
          setWidth(finalWidth);
          writeDrawerWidth(finalWidth);
          setIsDragging(false);
        }

        const prevUserSelect = document.body.style.userSelect;
        const prevCursor = document.body.style.cursor;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);

        return () => {
          window.removeEventListener("mousemove", handleMouseMove);
          window.removeEventListener("mouseup", handleMouseUp);
          document.body.style.userSelect = prevUserSelect;
          document.body.style.cursor = prevCursor;
        };
      }, [isDragging]);

      const handleResizeMouseDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(true);
      };

      const handleResizeDoubleClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const resetW = clampDrawerWidth(DEFAULT_CARD_DRAWER_WIDTH, window.innerWidth);
        setWidth(resetW);
        writeDrawerWidth(resetW);
      };
      const [state, setState] = React.useState({
        loading: props.goalId ? true : !props.cardData,
        card: props.cardData ?? null,
      });
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
        if (props.goalId) {
          setState((s) => ({ ...s, loading: true }));
          fetch(graphUrl("/api/dsh-graph/goal", { id: props.goalId }))
            .then((r) => r.json())
            .then((data) => alive && setState({ loading: false, data, card: null }))
            .catch((e) => alive && setState({ loading: false, error: String(e) }));
        } else if (props.cardId) {
          // 共享卡无 goalId 场景
          if (!props.cardData || props.cardData.id !== props.cardId) {
            setState({ loading: true, card: null });
          }
          fetch(graphUrl("/api/dsh-graph/card", { id: props.cardId }))
            .then((r) => r.json())
            .then((data) => {
              if (!alive) return;
              if (data.ok && data.card) {
                setState({ loading: false, card: data.card });
              } else {
                setState((prev) => {
                  if (prev.card) return { ...prev, loading: false };
                  return { loading: false, error: data?.error || dgT("drawer.cardNotExist") + props.cardId };
                });
              }
            })
            .catch((e) => {
              if (!alive) return;
              setState((prev) => {
                if (prev.card) return { ...prev, loading: false };
                return { loading: false, error: String(e) };
              });
            });
        }
        return () => { alive = false; };
      }, [props.goalId, props.cardId]);

      let inner;
      if (state.loading) inner = dgT("common.loading");
      else if (state.error) inner = dgT("drawer.loadFail") + state.error;
      else {
        const card = state.card ?? (state.data?.cards ?? []).find((c) => c.id === props.cardId);
        if (!card) inner = dgT("drawer.cardNotExist") + props.cardId;
        else {
          // g-145：生成完整的收集提示词，注入仓库根、goal/card 元数据、canonical 附件根、回填模板和禁区
          // g-275 修正（主管真机复核）：共享卡路径无 goalId → 不发 /goal 请求，state.data 恒为 undefined，
          // 三处必须可选链解引用，否则渲染期抛 "Cannot read properties of undefined (reading 'meta')"（抽屉打不开）
          const goalTitle = state.data?.meta?.title ?? props.goalId ?? "";
          const cardTitle = card.title;
          const root = state.data?.root ?? dgT("drawer.unknownRoot");
          const attRoot = state.data?.attachmentsDir ?? (root !== dgT("drawer.unknownRoot") ? root + "/attachments" : dgT("drawer.unknownAttachmentRoot"));

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
          // g-109：收集提示词编辑区（空卡片显示；共享卡无 goal 属主时隐藏 goal 专属收集操作）
          const collectPanel = (props.goalId && (card.status === "empty" || card.status === "collecting"))
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

          // g-275: 共享卡展示被引用目标清单（若数据可得）
          const refs = Array.isArray(card.referencingGoals) ? card.referencingGoals : [];
          const referencingGoalsList = card.scope === "shared" || refs.length > 0
            ? h("div", { key: "refs", style: S.drawerSection },
                h("div", { style: S.drawerH }, dgT("shared.refGoals")),
                refs.length === 0
                  ? h("div", { style: { ...S.meta, fontSize: 11 } }, dgT("shared.noRefGoals"))
                  : h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" } },
                      refs.map((ref) => {
                        const label = ref.title ? `${ref.title}${ref.archived ? " (" + dgT("card.archived") + ")" : ""}` : ref.id;
                        return h("span", {
                          key: ref.id,
                          style: {
                            ...S.meta,
                            fontSize: 11,
                            padding: "2px 6px",
                            borderRadius: 4,
                            background: "var(--dsw-alias-bg-hover, rgba(128,128,128,0.15))",
                            border: "1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,0.2))",
                          },
                        }, label);
                      })))
            : null;

          // g-128：卡片删除/转换操作区（仅属于特定目标时可用；共享卡无 goal 属主时隐藏）
          const goalActionsPanel = !props.goalId
            ? null
            : h("div", { key: "del", style: { ...S.drawerSection, borderTop: "1px solid rgba(128,128,128,.25)", paddingTop: 8 } },
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
                deleteNote ? h("div", { style: { ...S.meta, marginTop: 4, fontSize: 11, color: deleteNote.startsWith("⚠️") ? "var(--dsw-alias-state-error-primary, #d66)" : undefined } }, deleteNote) : null);

          inner = [
            h("div", { key: "t", style: { fontWeight: 700, fontSize: 14 } },
              `📇 ${card.title}`),
            h("div", { key: "m", style: S.meta },
              `${card.id} ｜ ${card.scope === "shared" ? dgT("drawer.sharedEntry") : dgT("drawer.ownedEntry")} ｜ ${CARD_STATUS_ICON[card.status] ?? card.status}${card.filled_by ? " ｜ " + dgT("drawer.filledBy") + card.filled_by : ""}`),
            cardFileEntry,
            childLink,
            referencingGoalsList,
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
            goalActionsPanel,
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
      const resizeHandle = h("div", {
        className: isDragging ? "dg-card-drawer-resize-handle dg-dragging" : "dg-card-drawer-resize-handle",
        "data-testid": "card-drawer-resize-handle",
        title: dgT("drawer.resizeTip"),
        style: {
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          width: 6,
          cursor: "col-resize",
          zIndex: 20,
          userSelect: "none",
          background: (isHovered || isDragging)
            ? "var(--dsw-alias-state-business-primary, rgba(76,141,255,0.35))"
            : "transparent",
          boxShadow: (isHovered || isDragging)
            ? "inset 2px 0 0 0 var(--dsw-alias-state-business-primary, #4c8dff)"
            : "none",
          transition: "background 0.15s ease, box-shadow 0.15s ease",
        },
        onMouseEnter: () => setIsHovered(true),
        onMouseLeave: () => setIsHovered(false),
        onMouseDown: handleResizeMouseDown,
        onDoubleClick: handleResizeDoubleClick,
        onClick: (e) => e.stopPropagation(),
      });

      return h(
        "div",
        null,
        h("div", { style: { ...S.overlay, background: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,.35))" }, onClick: props.onClose }),
        h("div", {
            style: { ...S.drawer, width },
            onClick: (e) => e.stopPropagation(),
          },
          resizeHandle,
          h("span", { style: S.close, onClick: props.onClose }, "✕"),
          inner),
      );
    }

    // Source contract: sessionLinkBtn(card.parent_session_id, card.child_id, "↗ 转到对话").

// >>>ESM-EXPORTS-START>>> (build script strips this block for browser bundle)
export {
  DEFAULT_CARD_DRAWER_WIDTH,
  MIN_CARD_DRAWER_WIDTH,
  MAX_CARD_DRAWER_WIDTH,
  CARD_DRAWER_STORAGE_KEY,
  clampDrawerWidth,
  readDrawerWidth,
  writeDrawerWidth,
  CardDrawer,
};
// <<<ESM-EXPORTS-END<<<
