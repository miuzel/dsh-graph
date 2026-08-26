    // g-183：共享上下文卡管理面板——创建/查看共享卡、挂到 goal、解除引用、零引用显式删除。
    // 单个共享权威内容可被多个 goal 引用，避免每个 goal 复制、内容分叉。
    function SharedCardsModal(props) {
      const { onClose, onRefresh, sharedCards, goals } = props;
      const [cards, setCards] = React.useState(Array.isArray(sharedCards) ? sharedCards : []);
      const [title, setTitle] = React.useState("");
      const [note, setNote] = React.useState(null);
      const [attachGoalId, setAttachGoalId] = React.useState("");
      const byId = new Map((goals ?? []).map((g) => [g.id, g]));

      const refresh = async () => {
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/shared-cards"));
          const d = await r.json();
          if (d && Array.isArray(d.cards)) setCards(d.cards);
        } catch { /* 静默 */ }
      };

      const createCard = async () => {
        const t = title.trim();
        if (!t) { setNote("请输入标题"); return; }
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/create-shared-card"), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: t }),
          });
          const d = await r.json();
          if (d.ok) { setNote("✅ 已创建共享卡：" + d.card); setTitle(""); refresh(); onRefresh?.(); }
          else setNote("⚠️ 创建失败：" + (d.error || "未知错误"));
        } catch (e) { setNote("⚠️ 请求失败：" + String(e?.message ?? e)); }
      };

      const attachToGoal = async (cardId) => {
        const gid = attachGoalId || (goals && goals[0] && goals[0].id);
        if (!gid) { setNote("⚠️ 请先选择要挂载的目标"); return; }
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/attach-shared-card"), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: gid, card: cardId }),
          });
          const d = await r.json();
          if (d.ok) { setNote("✅ 已挂到 " + gid); refresh(); onRefresh?.(); }
          else setNote("⚠️ 挂载失败：" + (d.error || "未知错误"));
        } catch (e) { setNote("⚠️ 请求失败：" + String(e?.message ?? e)); }
      };

      const unreference = async (cardId, gid) => {
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/unreference-shared-card"), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: gid, card: cardId }),
          });
          const d = await r.json();
          if (d.ok) { setNote("✅ 已解除 " + gid + " 引用"); refresh(); onRefresh?.(); }
          else setNote("⚠️ 解除失败：" + (d.error || "未知错误"));
        } catch (e) { setNote("⚠️ 请求失败：" + String(e?.message ?? e)); }
      };

      const removeCard = async (cardId) => {
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/delete-shared-card"), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ card: cardId }),
          });
          const d = await r.json();
          if (d.ok) { setNote("✅ 已删除共享卡：" + cardId); refresh(); onRefresh?.(); }
          else setNote("⚠️ 删除失败：" + (d.error || "未知错误"));
        } catch (e) { setNote("⚠️ 请求失败：" + String(e?.message ?? e)); }
      };

      const backdropGuard = useBackdropClose(onClose);
      const cardRow = (c) => {
        const refs = Array.isArray(c.referencingGoals) ? c.referencingGoals : [];
        const installing = c.status === "collecting";
        return h("div", { key: c.id, style: { ...S.subCard, marginBottom: 6 } },
          h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
            h("span", { style: { flex: 1 } }, `${CARD_STATUS_ICON[c.status] ?? c.status} ｜ ${c.title}`),
            h("span", { style: { ...S.meta, fontSize: 11 } }, `${c.refCount} 个 goal 引用`)),
          h("div", { style: { ...S.meta, fontSize: 11 } },
            `id=${c.id}${c.summary ? " ｜ " + c.summary : ""}`),
          // 正文引用附件（安全下载链接，不内联渲染）
          (Array.isArray(c.attachments) && c.attachments.length)
            ? h("div", { style: { ...S.meta, fontSize: 11 } },
                "📎 附件：" + c.attachments.map((a) =>
                  h("a", {
                    key: a,
                    href: graphUrl("/api/dsh-graph/attachment?name=" + encodeURIComponent(a)),
                    target: "_blank", rel: "noopener noreferrer",
                    style: { color: "var(--dsw-alias-label-link, #4c8dff)", textDecoration: "underline", marginRight: 4 },
                  }, `@att/${a}`)).join("，"))
            : null,
          // 引用它的 goal 清单：每项一个真实解除引用（只移除该 goal 引用，保留共享卡与其他引用；零引用仅显式删除）
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", marginTop: 4 } },
            h("span", { style: { ...S.meta, fontSize: 11 } }, "🔎 引用 goal："),
            refs.length === 0
              ? h("span", { style: { ...S.meta, fontSize: 11 } }, "（无引用 goal）")
              : refs.map((ref) => {
                  const label = ref.title ? `${ref.title}${ref.archived ? "（归档）" : ""}` : ref.id;
                  return h("button", {
                    key: ref.id,
                    style: { ...S.btn, fontSize: 11, padding: "1px 6px" },
                    className: "dg-btn",
                    disabled: installing,
                    title: installing ? "收集中不可解除引用" : `移除 ${label} 对这张共享卡的引用（保留共享卡本身）`,
                    onClick: () => unreference(c.id, ref.id),
                  }, "➖ " + label);
                })),
          installing
            ? h("div", { style: { ...S.meta, fontSize: 11, marginTop: 2 } },
                "🔒 收集中：仅解除引用/不可删除；绑定 goal 不可解除（已禁用）")
            : null,
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4, alignItems: "center" } },
            h("select", {
              value: attachGoalId,
              onChange: (e) => setAttachGoalId(e.target.value),
              style: { fontSize: 11, padding: "2px 4px" },
            },
              h("option", { value: "" }, "┅ 挂到目标…"),
              ...(goals ?? []).map((g) => h("option", { key: g.id, value: g.id }, `${g.id} ${g.title}`))),
            h("button", { style: S.btn, className: "dg-btn", onClick: () => attachToGoal(c.id) }, "⇄ 挂到 goal"),
            ...(c.refCount === 0 && !installing ? [
              h("button", { style: S.btn, className: "dg-btn", onClick: () => removeCard(c.id) }, "🗑 显式删除"),
            ] : []),
            installing
              ? h("span", { style: { ...S.meta, fontSize: 11 } }, "🔒 收集中，仅解除引用/不可删除")
              : null));
      };

      return h("div", { style: S.overlay, ...backdropGuard },
        h("div", { style: { ...S.modal, maxWidth: 640, maxHeight: "80vh", overflowY: "auto" }, onClick: (e) => e.stopPropagation() },
          h("div", { style: S.modalH }, "🔗 共享上下文管理面板"),
          h("div", { style: { ...S.meta, marginBottom: 6 } },
            "共享卡只保存一份权威内容，可被多个 goal 引用；被引用时不可删除，解除全部引用后仅可显式删除。"),
          // 新建共享卡（正文 + 可选附件引用，不设 kind 类型）
          h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 8 } },
            h("input", {
              style: { ...S.promptInput, flex: 1 },
              value: title, placeholder: "新建共享卡标题…",
              onChange: (e) => setTitle(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") createCard(); },
            }),
            h("button", { style: S.btn, className: "dg-btn", onClick: createCard }, "＋ 新建共享卡")),
          note ? h("div", { style: { ...S.meta, marginBottom: 6 } }, note) : null,
          (cards.length === 0)
            ? h("div", { style: S.meta }, "（暂无共享卡）")
            : h("div", { style: { marginTop: 4 } }, cards.map(cardRow)),
          h("div", { style: { marginTop: 10, display: "flex", justifyContent: "flex-end" } },
            h("button", { style: S.btn, className: "dg-btn", onClick: onClose }, "关闭"))));
    }
