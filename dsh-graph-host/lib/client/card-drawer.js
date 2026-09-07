      if (blocked) {
        return h("div", { style: { ...S.statusLine, color: "var(--dsw-alias-state-error-primary, #d66)" } }, "⛔ " + text);
      }
      const animClass = running ? "dg-running-flow" : "";
      return h(
        "div", { className: animClass, style: { ...S.statusLine, marginTop: 3 } },
        h("span", { className: running ? "dg-icon-pulse" : "" }, "⏳ "),
        text,
      );
    }

    // 上下文抽屉：摘要 + 全文 + 子代理 id/链接 + g-109 收集提示词编辑 + g-128 删除按钮
    function CardDrawer(props) {
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
      React.useEffect(() => {
        let alive = true;
        fetch(graphUrl("/api/dsh-graph/goal", { id: props.goalId }))
          .then((r) => r.json())
          .then((data) => alive && setState({ loading: false, data }))
          .catch((e) => alive && setState({ loading: false, error: String(e) }));
        return () => { alive = false; };
      }, [props.goalId]);

      let inner;
      if (state.loading) inner = "加载中…";
      else if (state.error) inner = "获取失败：" + state.error;
      else {
        const card = (state.data.cards ?? []).find((c) => c.id === props.cardId);
        if (!card) inner = "卡片不存在：" + props.cardId;
        else {
          // g-145：生成完整的收集提示词，注入仓库根、goal/card 元数据、canonical 附件根、回填模板和禁区
          const goalTitle = state.data.meta?.title ?? props.goalId;
          const cardTitle = card.title;
          const root = state.data.root ?? "（仓库根未知）";
          const attRoot = state.data.attachmentsDir ?? (root !== "（仓库根未知）" ? root + "/attachments" : "（附件根未知）");

          // 可编辑的收集信息目标部分
          const editablePart = [
            `## 收集任务上下文`,
            ``,
            `**收集范围**：`,
            `请收集与卡片「${cardTitle}」相关的详细上下文信息，用于填充该卡片。`,
          ].join("\n");

          // 只读的规范约束部分
          const readonlyPart = [
            ``,
            `**canonical 附件根（绝对路径）**：\`${attRoot}\``,
            ``,
            `**目标信息**：`,
            `- id: \`${props.goalId}\``,
            `- 标题: ${goalTitle}`,
            ``,
            `**卡片信息**：`,
            `- id: \`${card.id}\``,
            `- 标题: ${cardTitle}`,
            ``,
            `**回填要求**：`,
            `1. 把正文全文写进 \`text\` 参数；\`summary\` 写一句话要点式摘要（≤100 字左右），不长文。`,
            `2. 若收集到文件附件（md/txt、图片、csv/Excel、二进制）用 \`graph_store_attachment\`：文本用 content、二进制/图片用 base64，写入上述 canonical 附件根；返回稳定相对引用名。`,
            `3. 回调正文或 goal.md 时用 \`@att/<相对引用名>\` 引用附件（可含安全子目录）。`,
            `4. 完成后调用以下精确命令回填结果：`,
            `\`\`\``,
            `graph_fill_card(goal="${props.goalId}", card="${card.id}", text=<全文可含 @att/<name>>, summary=<≤100字摘要>)`,
            `\`\`\``,
            ``,
            `**附件安全与边界**：`,
            `只写入上述 canonical 附件根；拒绝绝对路径、./.. 穿越、反斜杠、NUL；不得访问/引用 \`.dsh-graph\` 之外文件；互联网抓取仅限 http(s)，设超时/大小上限，禁 file://、localhost、内网（SSRF）。`,
            ``,
            `**禁区（严格遵守）**：`,
            `1. 不得修改其他 goal 或 card——只能回填当前绑定的卡片 \`${card.id}\``,
            `2. 不得自行调用 \`graph_review_card\`——完成后由 supervisor 复核`,
            `3. 所有 graph 工具操作必须在当前分配的 worktree/当前工作目录下运行`,
          ].join("\n");

          const autoPrompt = editablePart + readonlyPart;
          const childLink = card.child_id
            ? h("div", { style: S.drawerSection, key: "child" },
                h("div", { style: { ...S.drawerH, display: "flex", alignItems: "center", justifyContent: "space-between" } },
                  "🤖 收集子代理",
                  sessionLinkBtn(card.parent_session_id, card.child_id, "↗ 转到对话")),
                h("div", { style: S.meta }, `id：${card.child_id}`))
            : null;
          // g-109：收集提示词编辑区（空卡片显示）
          const collectPanel = card.status === "empty" || card.status === "collecting"
            ? h("div", { style: S.drawerSection, key: "collect", className: "dg-collect-prompt" },
                h("div", { style: S.drawerH }, "📝 收集提示词"),
                // 可编辑的收集信息目标部分
                h("div", { style: { marginTop: 4, marginBottom: 8 } },
                  h("div", { style: { fontWeight: 600, fontSize: 12, opacity: 0.9, marginBottom: 4 } }, "收集信息目标（可编辑）"),
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
                  h("div", { style: { fontWeight: 600, fontSize: 12, opacity: 0.9, marginBottom: 4 } }, "规范约束（只读）"),
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
                    setCollectNote("派发中…");
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
                          setCollectNote("⚠️ 子代理启动失败：" + data.child_error);
                        } else if (data.child_id) {
                          setCollectNote("✅ 已派发收集子代理，id：" + data.child_id);
                        } else {
                          setCollectNote("⚠️ 子代理未启动（无 child_id）");
                        }
                      } else {
                        setCollectNote("⚠️ 派发失败：" + (data.error || "未知错误"));
                      }
                    } catch (e) {
                      setCollectNote("⚠️ 请求失败：" + String(e?.message ?? e));
                    }
                    setCollecting(false);
                  },
                }, "开始收集"),
                collectNote ? h("div", { style: { ...S.meta, marginTop: 4 } }, collectNote) : null)
            : null;
          // g-154: 卡片文件入口（复用 goal.md 同类的 file-link/open-file 机制）
          const cardFileEntry = card.cardFile
            ? h("div", { key: "f", style: { ...S.drawerSection, display: "flex", alignItems: "center", gap: 6 } },
                h("span", { style: { fontSize: 11, opacity: 0.7 } }, "📄 卡片文件"),
                h("button", {
                  style: { ...S.btn, fontSize: 11, padding: "1px 6px" },
                  className: "dg-btn",
                  title: "用系统默认编辑器打开卡片文件",
                  onClick: async (e) => {
                    e.stopPropagation();
                    // g-222：统一走共享 openHostPath，失败透出可理解错误（C3/C4）
                    const r = await openHostPath(card.cardFile);
                    if (r.opened) { showToast("✅ 已打开卡片文件"); return; }
                    await copyText(card.cardFile);
                    if (r.error) { showToast("⚠️ 打开失败：" + openErrorText(r.error)); }
                    else { showToast("✅ 路径已复制（打开不可用）"); }
                  },
                }, "打开"),
                h("button", {
                  style: { ...S.btn, fontSize: 11, padding: "1px 6px" },
                  className: "dg-btn",
                  title: "复制卡片文件路径",
                  onClick: async (e) => { e.stopPropagation(); const ok = await copyText(card.cardFile); if (ok) showToast("✅ 路径已复制"); },
                }, "复制路径"))
            : h("div", { key: "f", style: { ...S.drawerSection, display: "flex", alignItems: "center", gap: 6, opacity: 0.5 } },
                h("span", { style: { fontSize: 11 } }, "📄 卡片文件"),
                h("span", { style: { fontSize: 11 } }, "（无文件路径）"));

          inner = [
            h("div", { key: "t", style: { fontWeight: 700, fontSize: 14 } },
              `📇 ${card.title}`),
            h("div", { key: "m", style: S.meta },
              `${card.id} ｜ ${card.scope === "shared" ? "📇 共享条目" : "🎯 专属条目"} ｜ ${CARD_STATUS_ICON[card.status] ?? card.status}${card.filled_by ? " ｜ 填充：" + card.filled_by : ""}`),
            cardFileEntry,
            childLink,
            card.summary ? h("div", { key: "s", style: S.drawerSection },
              h("div", { style: S.drawerH }, "摘要"), card.summary) : null,
            // 附件引用（安全下载链接，不内联渲染用户 Markdown/HTML/SVG）
            (Array.isArray(card.attachments) && card.attachments.length)
              ? h("div", { key: "att", style: S.drawerSection },
                  h("div", { style: S.drawerH }, "📎 附件引用"),
                  card.attachments.map((a) =>
                    h("div", { key: a, style: { ...S.meta, fontSize: 12 } },
                      h("a", {
                        href: graphUrl("/api/dsh-graph/attachment?name=" + encodeURIComponent(a)),
                        target: "_blank", rel: "noopener noreferrer",
                        style: { color: "var(--dsw-alias-label-link, #4c8dff)", textDecoration: "underline" },
                      }, `@att/${a}`),
                      "（下载）")))
              : null,
            h("div", { key: "body", style: S.drawerSection },
              h("div", { style: S.drawerH }, "全文"),
              h("div", { style: { whiteSpace: "pre-wrap" } }, card.content?.trim() || "（尚未采集内容）")),
            collectPanel,
            // g-128：卡片删除按钮（二次确认 + 输入卡片 id 防误删）
            h("div", { key: "del", style: { ...S.drawerSection, borderTop: "1px solid rgba(128,128,128,.25)", paddingTop: 8 } },
              deleteConfirm
                ? h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
                    h("div", { style: { ...S.meta, color: "var(--dsw-alias-state-error-primary, #d66)", fontSize: 12 } },
                      `⚠️ 确认删除卡片「${card.title}」？请输入卡片 id 确认：`),
                    h("div", { style: { ...S.meta, fontSize: 11, opacity: 0.7 } },
                      `id：${card.id}`),
                    h("input", {
                      style: { ...S.promptInput, fontSize: 12 },
                      value: deleteIdInput,
                      placeholder: "输入卡片 id 确认删除…",
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
                              setDeleteNote("✅ 卡片已删除");
                              showToast("✅ 卡片已删除");
                              setDeleteConfirm(false);
                              setDeleteIdInput("");
                              // g-219：事件结果为准——先通知外部局部移除，再关抽屉
                              if (props.onDeleted) props.onDeleted(card.id);
                              props.onClose?.();
                            } else {
                              // g-219：删除被拒（如 collecting）——明确提示并保留确认态
                              const msg = (data.error || "未知错误");
                              setDeleteNote("⚠️ " + msg);
                              showToast("⚠️ 删除被拒：" + msg);
                            }
                          } catch (e) {
                            setDeleteNote("⚠️ 请求失败：" + String(e?.message ?? e));
                          } finally {
                            setDeleting(false);
                          }
                        },
                      }, "🗑 确认删除"),
                      h("button", {
                        style: { ...S.btn, fontSize: 11, padding: "2px 8px" },
                        className: "dg-btn",
                        onClick: () => { setDeleteConfirm(false); setDeleteIdInput(""); setDeleteNote(null); },
                      }, "取消"))
                  )
                : h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
                    // g-183：共享/自有转换 + 解除引用（goal 详情方向独立；核心层守卫引用计数与归属）
                    card.scope === "shared"
                      ? h("button", {
                          style: { ...S.btn, fontSize: 11, padding: "2px 8px" },
                          className: "dg-btn",
                          disabled: card.status === "collecting",
                          title: card.status === "collecting" ? "收集中不可解除引用" : "移除当前 goal 对这张共享卡的引用（保留共享卡与其他引用；零引用仅可在共享面板显式删除）",
                          onClick: async () => {
                            try {
                              const r = await fetch(graphUrl("/api/dsh-graph/unreference-shared-card"), {
                                method: "POST", headers: { "content-type": "application/json" },
                                body: JSON.stringify({ goal: props.goalId, card: props.cardId }),
                              });
                              const data = await r.json();
                              if (data.ok) { showToast("✅ 已解除本 goal 引用"); props.onDeleted?.(); }
                              else setDeleteNote("⚠️ 解除失败：" + (data.error || "未知错误"));
                            } catch (e) { setDeleteNote("⚠️ 请求失败：" + String(e?.message ?? e)); }
                          },
                        }, "➖ 解除引用")
                      : h("button", {
                          style: { ...S.btn, fontSize: 11, padding: "2px 8px" },
                          className: "dg-btn",
                          disabled: card.status === "collecting",
                          title: card.status === "collecting" ? "收集中不可转换" : "转为共享条目（原目标保留引用，条目进入项目知识库供多目标复用）",
                          onClick: async () => {
                            try {
                              const r = await fetch(graphUrl("/api/dsh-graph/convert-card-to-shared"), {
                                method: "POST", headers: { "content-type": "application/json" },
                                body: JSON.stringify({ goal: props.goalId, card: props.cardId }),
                              });
                              const data = await r.json();
                              if (data.ok) { showToast("📇 已转为共享条目"); props.onDeleted?.(); }
                              else setDeleteNote("⚠️ 转换失败：" + (data.error || "未知错误"));
                            } catch (e) { setDeleteNote("⚠️ 请求失败：" + String(e?.message ?? e)); }
                          },
                        }, "📇 转为共享条目"),
                    card.scope === "shared"
                      ? h("button", {
                          style: { ...S.btn, fontSize: 11, padding: "2px 8px" },
                          className: "dg-btn",
                          disabled: card.status === "collecting",
                          title: card.status === "collecting" ? "收集中不可解除引用" : "仅可在引用计数恰为 1 时转回当前目标专属条目（其余引用请先在项目知识库中解除）",
                          onClick: async () => {
                            try {
                              const r = await fetch(graphUrl("/api/dsh-graph/convert-card-to-owned"), {
                                method: "POST", headers: { "content-type": "application/json" },
                                body: JSON.stringify({ goal: props.goalId, card: props.cardId }),
                              });
                              const data = await r.json();
                              if (data.ok) { showToast("🎯 已转为专属条目"); props.onDeleted?.(); }
                              else setDeleteNote("⚠️ 转换失败：" + (data.error || "未知错误"));
                            } catch (e) { setDeleteNote("⚠️ 请求失败：" + String(e?.message ?? e)); }
                          },
                        }, "🎯 转为专属条目")
                      : null,
                    // 仅 goal 自有卡可删除（共享卡走解除引用/共享面板显式删除，避免必然报错）
                    card.scope !== "shared"
                      ? h("button", {
                          style: { ...S.btnDanger, fontSize: 11, padding: "2px 8px" },
                          className: "dg-btn-danger",
                          disabled: card.status === "collecting",
                          title: card.status === "collecting" ? "收集中卡片不可删除" : "删除此卡片（需输入卡片 id 确认）",
                          onClick: () => { setDeleteConfirm(true); setDeleteIdInput(""); setDeleteNote(null); },
                        }, "🗑 删除卡片")
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
