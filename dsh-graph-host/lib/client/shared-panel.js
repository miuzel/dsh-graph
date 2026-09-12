    // g-183：项目知识库管理面板——创建/查看共享条目、挂到目标、解除引用、零引用显式删除。
    function SharedCardsModal(props) {
      useLocaleRevision();
      const { onClose, onRefresh, sharedCards, goals } = props;
      const [cards, setCards] = React.useState(Array.isArray(sharedCards) ? sharedCards : []);
      const [title, setTitle] = React.useState("");
      const [note, setNote] = React.useState(null);
      const [attachGoalInputs, setAttachGoalInputs] = React.useState({});
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
        if (!t) { setNote(dgT("shared.titleRequired")); return; }
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/create-shared-card"), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: t }),
          });
          const d = await r.json();
          if (d.ok) { setNote(dgT("shared.created") + d.card); setTitle(""); refresh(); onRefresh?.(); }
          else setNote(dgT("shared.createFail") + (d.error || dgT("drag.unknownError")));
        } catch (e) { setNote(dgT("drag.requestFail") + String(e?.message ?? e)); }
      };

      const attachToGoal = async (cardId, targetGoalId) => {
        const gid = targetGoalId || (goals && goals[0] && goals[0].id);
        if (!gid) { setNote(dgT("shared.attachGoalRequired")); return; }
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/attach-shared-card"), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: gid, card: cardId }),
          });
          const d = await r.json();
          if (d.ok) {
            setNote(dgT("shared.attached") + gid);
            setAttachGoalInputs((prev) => ({ ...prev, [cardId]: "" }));
            refresh();
            onRefresh?.();
          } else {
            setNote(dgT("shared.attachFail") + (d.error || dgT("drag.unknownError")));
          }
        } catch (e) { setNote(dgT("drag.requestFail") + String(e?.message ?? e)); }
      };

      const unreference = async (cardId, gid) => {
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/unreference-shared-card"), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ goal: gid, card: cardId }),
          });
          const d = await r.json();
          if (d.ok) { setNote(dgT("shared.unreferenced", { goalId: gid })); refresh(); onRefresh?.(); }
          else setNote(dgT("shared.unrefFail") + (d.error || dgT("drag.unknownError")));
        } catch (e) { setNote(dgT("drag.requestFail") + String(e?.message ?? e)); }
      };

      const removeCard = async (cardId) => {
        try {
          const r = await fetch(graphUrl("/api/dsh-graph/delete-shared-card"), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ card: cardId }),
          });
          const d = await r.json();
          if (d.ok) { setNote(dgT("shared.deleted") + cardId); refresh(); onRefresh?.(); }
          else setNote(dgT("shared.deleteFail") + (d.error || dgT("drag.unknownError")));
        } catch (e) { setNote(dgT("drag.requestFail") + String(e?.message ?? e)); }
      };

      const backdropGuard = useBackdropClose(onClose);
      const cardRow = (c) => {
        const refs = Array.isArray(c.referencingGoals) ? c.referencingGoals : [];
        const installing = c.status === "collecting";
        return h("div", { key: c.id, style: { ...S.subCard, marginBottom: 6 } },
          h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
            h("span", { style: { flex: 1 } }, `${CARD_STATUS_ICON[c.status] ?? c.status} ｜ ${c.title}`),
            h("span", { style: { ...S.meta, fontSize: 11 } }, `${c.refCount} ${dgT("shared.goalRef")}`)),
          h("div", { style: { ...S.meta, fontSize: 11 } },
            `id=${c.id}${c.summary ? " ｜ " + c.summary : ""}`),
          // 正文引用附件（安全下载链接，不内联渲染）——逐项渲染为节点（勿拼接 React 元素为字符串）
          (Array.isArray(c.attachments) && c.attachments.length)
            ? h("div", { style: { ...S.meta, fontSize: 11 } },
                dgT("shared.attachments"),
                ...c.attachments.map((a) => [
                  h("a", {
                    key: a,
                    href: graphUrl("/api/dsh-graph/attachment?name=" + encodeURIComponent(a)),
                    target: "_blank", rel: "noopener noreferrer",
                    style: { color: "var(--dsw-alias-label-link, #4c8dff)", textDecoration: "underline", marginRight: 4 },
                  }, `@att/${a}`),
                  "，",
                ]))
            : null,
          // 引用它的 goal 清单：每项一个真实解除引用（只移除该 goal 引用，保留共享卡与其他引用；零引用仅显式删除）
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", marginTop: 4 } },
            h("span", { style: { ...S.meta, fontSize: 11 } }, dgT("shared.refGoals")),
            refs.length === 0
              ? h("span", { style: { ...S.meta, fontSize: 11 } }, dgT("shared.noRefGoals"))
              : refs.map((ref) => {
                  const label = ref.title ? `${ref.title}${ref.archived ? " (" + dgT("card.archived") + ")" : ""}` : ref.id;
                  return h("button", {
                    key: ref.id,
                    style: { ...S.btn, fontSize: 11, padding: "1px 6px" },
                    className: "dg-btn",
                    disabled: installing,
                    title: installing ? dgT("drawer.unrefCollecting") : dgT("shared.unrefGoalTooltip", { label }),
                    onClick: () => unreference(c.id, ref.id),
                  }, "➖ " + label);
                })),
          installing
            ? h("div", { style: { ...S.meta, fontSize: 11, marginTop: 2 } },
                dgT("shared.collecting"))
            : null,
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6, alignItems: "center" } },
            h("input", {
              style: { ...S.promptInput, width: 220, fontSize: 11, padding: "2px 6px" },
              placeholder: dgT("shared.searchGoalPlaceholder"),
              list: `goal-list-${c.id}`,
              value: attachGoalInputs[c.id] ?? "",
              onChange: (e) => setAttachGoalInputs((prev) => ({ ...prev, [c.id]: e.target.value })),
            }),
            h("datalist", { id: `goal-list-${c.id}` },
              (goals ?? []).map((g) =>
                h("option", { key: g.id, value: g.id }, `${g.id} ${g.title}`))),
            h("button", {
              style: S.btnPrimary,
              className: "dg-btn",
              disabled: !(attachGoalInputs[c.id] ?? "").trim(),
              onClick: () => {
                const raw = (attachGoalInputs[c.id] ?? "").trim();
                const matched = (goals ?? []).find((g) => g.id === raw || `${g.id} ${g.title}` === raw || g.id === raw.split(" ")[0]);
                const targetId = matched ? matched.id : raw;
                attachToGoal(c.id, targetId);
              },
            }, dgT("shared.attachBtn")),
            ...(c.refCount === 0 && !installing ? [
              h("button", { style: S.btn, className: "dg-btn", onClick: () => removeCard(c.id) }, dgT("shared.deleteBtn")),
            ] : []),
            installing
              ? h("span", { style: { ...S.meta, fontSize: 11 } }, dgT("shared.collecting"))
              : null));
      };

      return h("div", { style: S.overlay, ...backdropGuard },
        h("div", { style: { ...S.modal, maxWidth: 640, maxHeight: "80vh", overflowY: "auto" }, onClick: (e) => e.stopPropagation() },
          h("div", { style: S.modalH }, dgT("shared.title")),
          h("div", { style: { ...S.meta, marginBottom: 6 } },
            dgT("shared.desc")),
          // 新建共享条目
          h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 8 } },
            h("input", {
              style: { ...S.promptInput, flex: 1 },
              value: title, placeholder: dgT("shared.newTitlePlaceholder"),
              onChange: (e) => setTitle(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") createCard(); },
            }),
            h("button", { style: S.btn, className: "dg-btn", onClick: createCard }, dgT("shared.createBtn"))),
          note ? h("div", { style: { ...S.meta, marginBottom: 6 } }, note) : null,
          (cards.length === 0)
            ? h("div", { style: S.meta }, dgT("shared.noCards"))
            : h("div", { style: { marginTop: 4 } }, cards.map(cardRow)),
          h("div", { style: { marginTop: 10, display: "flex", justifyContent: "flex-end" } },
            h("button", { style: S.btn, className: "dg-btn", onClick: onClose }, dgT("common.close")))));
    }
