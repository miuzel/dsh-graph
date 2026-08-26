    // g-183：共享上下文卡管理面板——创建/查看共享卡、挂到 goal、解除引用、零引用显式删除。
    // 单个共享权威内容可被多个 goal 引用，避免每个 goal 复制、内容分叉。
    function SharedCardsModal(props) {
      const { onClose, onRefresh, sharedCards, goals } = props;
      const [cards, setCards] = React.useState(Array.isArray(sharedCards) ? sharedCards : []);
      const [title, setTitle] = React.useState("");
      const [kind, setKind] = React.useState("text");
      const [note, setNote] = React.useState(null);
      const [attachGoalId, setAttachGoalId] = React.useState("");
      const byId = new Map((goals ?? []).map((g) => [g.id, g]));
      const kindLabels = { text: "📝 文本", file: "📄 文件", image: "🖼 图片", data: "📊 数据" };

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
            body: JSON.stringify({ title: t, kind }),
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
        const refStr = `${c.refCount} 个 goal 引用`;
        return h("div", { key: c.id, style: { ...S.subCard, marginBottom: 6 } },
          h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
            h("span", { style: { flex: 1 } }, `${CARD_STATUS_ICON[c.status] ?? c.status} ｜ ${c.title}`),
            h("span", { style: { ...S.meta, fontSize: 11 } }, refStr)),
          h("div", { style: { ...S.meta, fontSize: 11 } },
            `id=${c.id} ｜ kind=${c.kind}${c.summary ? " ｜ " + c.summary : ""}`),
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 } },
            h("select", {
              value: attachGoalId,
              onChange: (e) => setAttachGoalId(e.target.value),
              style: { fontSize: 11, padding: "2px 4px" },
            },
              h("option", { value: "" }, "┅ 挂到目标…"),
              ...(goals ?? []).map((g) => h("option", { key: g.id, value: g.id }, `${g.id} ${g.title}`))),
            h("button", { style: S.btn, className: "dg-btn", onClick: () => attachToGoal(c.id) }, "⇄ 挂到 goal"),
            ...(c.refCount > 0 ? [] : [
              h("button", { style: S.btn, className: "dg-btn", onClick: () => removeCard(c.id) }, "🗑 显式删除"),
            ]),
            h("button", {
              style: S.btn, className: "dg-btn",
              title: c.refCount === 1 ? "转为 goal 自有卡（引用计数为 1）" : "引用计数>1 无法转自有",
              onClick: () => unreferenceRef(c.id),
            }, "↘ 解除引用")));
      };

      // 引用计数为 1 时一键解除全部引用并转自有（走核心层守卫）
      const unreferenceRef = async (cardId) => {
        const refs = (cards.find((c) => c.id === cardId)?.refCount ?? 0);
        if (refs === 1) {
          const gid = attachGoalId || (goals && goals[0] && goals[0].id);
          if (!gid) { setNote("⚠️ 请选择目标以执行转自有"); return; }
          try {
            const r = await fetch(graphUrl("/api/dsh-graph/convert-card-to-owned"), {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ goal: gid, card: cardId }),
            });
            const d = await r.json();
            if (d.ok) { setNote("✅ 已转为 " + gid + " 自有卡"); refresh(); onRefresh?.(); }
            else setNote("⚠️ 转换失败：" + (d.error || "未知错误"));
          } catch (e) { setNote("⚠️ 请求失败：" + String(e?.message ?? e)); }
        } else {
          setNote("⚠️ 引用计数 " + refs + "，需先解除其余引用（在目标详情可解除）");
        }
      };

      return h("div", { style: S.overlay, ...backdropGuard },
        h("div", { style: { ...S.modal, maxWidth: 640, maxHeight: "80vh", overflowY: "auto" }, onClick: (e) => e.stopPropagation() },
          h("div", { style: S.modalH }, "🔗 共享上下文管理面板"),
          h("div", { style: { ...S.meta, marginBottom: 6 } },
            "共享卡只保存一份权威内容，可被多个 goal 引用；被引用时不可删除，解除全部引用后仅可显式删除。"),
          // 新建共享卡
          h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginBottom: 8 } },
            h("input", {
              style: { ...S.promptInput, flex: 1 },
              value: title, placeholder: "新建共享卡标题…",
              onChange: (e) => setTitle(e.target.value),
              onKeyDown: (e) => { if (e.key === "Enter") createCard(); },
            }),
            h("select", {
              value: kind, onChange: (e) => setKind(e.target.value),
              style: { fontSize: 12, padding: "4px 6px" },
            }, ...Object.entries(kindLabels).map(([k, v]) => h("option", { key: k, value: k }, v))),
            h("button", { style: S.btn, className: "dg-btn", onClick: createCard }, "＋ 新建共享卡")),
          note ? h("div", { style: { ...S.meta, marginBottom: 6 } }, note) : null,
          (cards.length === 0)
            ? h("div", { style: S.meta }, "（暂无共享卡）")
            : h("div", { style: { marginTop: 4 } }, cards.map(cardRow)),
          h("div", { style: { marginTop: 10, display: "flex", justifyContent: "flex-end" } },
            h("button", { style: S.btn, className: "dg-btn", onClick: onClose }, "关闭"))));
    }
