    // g-170：质量判据编辑弹窗（方案 A）——详情弹窗「质量判据」标题处入口打开。
    // 逐行编辑/新增/删除/上移/下移；保存统一 trim/去重/1..N 重排（服务端 updateCriteria）；
    // D6：进入编辑前明确告知保存后清空该目标已有 localStorage 勾选，保存成功后清空；
    // D8：携带 base_items 乐观并发 token，409 冲突时自动以本地内容覆盖服务器重试（force=true），
    //     不静默丢弃本地修改，并给出可理解反馈。
    function CriteriaModal(props) {
      const { goalId, onClose, onSaved } = props;
      const [state, setState] = React.useState({ loading: true });
      const [rows, setRows] = React.useState([]);
      const [baseItems, setBaseItems] = React.useState(null);
      const [note, setNote] = React.useState(null);
      const [saving, setSaving] = React.useState(false);

      // 与 core criteriaItems 同构的「N. 」编号前缀剥离（编辑行只保留原文）
      const stripNum = (s) => String(s).replace(/^\d+[.、)]\s*/, "");

      React.useEffect(() => {
        fetch(graphUrl("/api/dsh-graph/goal", { id: goalId }))
          .then((r) => r.json())
          .then((data) => {
            if (data.error) { setState({ loading: false, error: data.error }); return; }
            const items = Array.isArray(data.criteria_items) ? data.criteria_items : [];
            setBaseItems(items);
            setRows(items.map(stripNum));
            setState({ loading: false, data });
          })
          .catch((e) => setState({ loading: false, error: String(e) }));
      }, [goalId]);

      const setRow = (i, v) => setRows(rows.map((r, j) => (j === i ? v : r)));
      const removeRow = (i) => setRows(rows.filter((_, j) => j !== i));
      const moveRow = (i, dir) => {
        const j = i + dir;
        if (j < 0 || j >= rows.length) return;
        const next = [...rows];
        [next[i], next[j]] = [next[j], next[i]];
        setRows(next);
      };
      const addRow = () => setRows([...rows, ""]);

      // D8：保存携带 base_items；409 冲突 → 自动以本地内容覆盖服务器重试（force=true）
      const doSave = async () => {
        setSaving(true); setNote(null);
        const items = rows.map((s) => s.trim()).filter((s) => s !== "");
        const post = (force) => fetch(graphUrl("/api/dsh-graph/set-criteria"), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: goalId, items, base_items: baseItems ?? [], force: !!force }),
        });
        try {
          let r = await post(false);
          let data = await r.json();
          if (r.status === 409) {
            // D8：并发变化 → 自动以本地编辑内容覆盖服务器，不静默丢弃本地修改
            setNote("⚠️ 检测到判据已被其他编辑修改，正在以本地内容覆盖服务器…");
            r = await post(true);
            data = await r.json();
            if (data.ok) setNote("✅ 已保存（并发覆盖）");
          }
          if (data.ok) {
            // D6：保存成功后清空该目标已有 localStorage 勾选
            try { localStorage.removeItem("dsh-graph.crit." + goalId); } catch {}
            window.dispatchEvent(new Event("dsh-graph.criteria-changed"));
            showToast("✅ 判据已保存（勾选已清空）");
            onSaved?.();
            onClose?.();
          } else {
            setNote("⚠️ 保存失败：" + (data.error || "未知错误"));
          }
        } catch (e) {
          setNote("⚠️ 请求失败：" + String(e?.message ?? e));
        }
        setSaving(false);
      };

      if (state.loading) {
        return h("div", { style: S.overlay, onClick: onClose },
          h("div", { style: { ...S.modal, maxWidth: 620 }, onClick: (e) => e.stopPropagation() },
            h("span", { style: S.close, onClick: onClose }, "✕"),
            h("div", { style: { fontWeight: 700, fontSize: 15 } }, "✏️ 编辑质量判据"),
            h("div", { style: { ...S.meta, marginTop: 6 } }, "加载中…")));
      }
      if (state.error) {
        return h("div", { style: S.overlay, onClick: onClose },
          h("div", { style: { ...S.modal, maxWidth: 620 }, onClick: (e) => e.stopPropagation() },
            h("span", { style: S.close, onClick: onClose }, "✕"),
            h("div", { style: { fontWeight: 700, fontSize: 15 } }, "✏️ 编辑质量判据"),
            h("div", { style: { ...S.meta, marginTop: 6, color: "var(--dsw-alias-state-error-primary, #d66)" } }, "加载失败：" + state.error)));
      }
      const goalTitle = state.data?.meta?.title ?? null;
      const rowBtn = (label, tip, onClick, extra) => h("button", {
        style: { ...S.btn, fontSize: 11, padding: "0 5px", flexShrink: 0, ...(extra ?? {}) },
        className: "dg-btn",
        title: tip,
        onClick: (e) => { e.stopPropagation(); onClick(); },
      }, label);
      return h("div", { style: S.overlay, onClick: onClose },
        h("div", { style: { ...S.modal, maxWidth: 620 }, onClick: (e) => e.stopPropagation() },
          h("span", { style: S.close, onClick: onClose }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 15 } }, "✏️ 编辑质量判据"),
          goalTitle ? h("div", { style: { ...S.meta, marginTop: 2 } }, `${goalId} ｜ ${goalTitle}`) : null,
          // D6：进入编辑前明确告知保存后果
          h("div", { style: { marginTop: 8, padding: "6px 8px", borderRadius: 4, fontSize: 12,
            background: "rgba(224,165,58,.14)", border: "1px solid rgba(224,165,58,.4)" } },
            "⚠️ 保存后将清空该目标已有的判据勾选状态。"),
          h("div", { style: { marginTop: 10, display: "flex", flexDirection: "column", gap: 4 } },
            rows.length === 0
              ? h("div", { style: { ...S.meta, fontSize: 12, opacity: 0.6, padding: "4px 0" } },
                  "（暂无判据——点击下方「➕ 新增判据」添加）")
              : rows.map((row, i) =>
                  h("div", { key: i, style: { display: "flex", alignItems: "center", gap: 4 } },
                    h("span", { style: { ...S.meta, fontSize: 11, width: 22, flexShrink: 0, textAlign: "right" } },
                      `${i + 1}.`),
                    h("input", {
                      style: { ...S.promptInput, flex: 1 },
                      value: row,
                      placeholder: "判据内容…",
                      onChange: (e) => setRow(i, e.target.value),
                    }),
                    rowBtn("↑", "上移", () => moveRow(i, -1), { opacity: i === 0 ? 0.35 : 1 }),
                    rowBtn("↓", "下移", () => moveRow(i, 1), { opacity: i === rows.length - 1 ? 0.35 : 1 }),
                    rowBtn("🗑", "删除该条", () => removeRow(i))))),
          h("button", {
            style: { ...S.btn, marginTop: 8 }, className: "dg-btn",
            onClick: addRow,
          }, "➕ 新增判据"),
          h("div", { style: { display: "flex", gap: 6, marginTop: 12 } },
            h("button", {
              style: { ...S.btnAccept, padding: "4px 14px", fontSize: 13 }, className: "dg-btn-accept",
              disabled: saving, onClick: doSave,
            }, saving ? "保存中…" : "💾 保存"),
            h("button", {
              style: { ...S.btn, padding: "4px 14px", fontSize: 13 }, className: "dg-btn",
              disabled: saving, onClick: onClose,
            }, "取消")),
          note ? h("div", { style: { ...S.meta, marginTop: 6, fontSize: 11 } }, note) : null));
    }
