    // ===== g-223：版本管理抽屉（左侧展开，版本显隐过滤、全选/取消/仅活跃快捷操作） =====
    function VersionDrawer(props) {
      const {
        versions,
        hiddenVersionSlugs,
        onToggleVersion,
        onShowAll,
        onHideAll,
        onShowActiveOnly,
        onClose,
        onOpenVersionDetail,
      } = props;

      const [search, setSearch] = React.useState("");
      const backdropGuard = useBackdropClose(onClose);

      const allVersions = Array.isArray(versions) ? versions : [];
      const hiddenSet = new Set(hiddenVersionSlugs ?? []);

      const visibleCount = allVersions.filter((v) => !hiddenSet.has(v.slug)).length;

      const filteredVersions = allVersions.filter((v) => {
        if (!search.trim()) return true;
        const q = search.trim().toLowerCase();
        return String(v.name ?? "").toLowerCase().includes(q) || String(v.slug ?? "").toLowerCase().includes(q);
      });

      return h(
        "div",
        null,
        h("div", {
          style: { ...S.overlay, background: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,.35))" },
          ...backdropGuard,
        }),
        h("div", {
          style: S.drawerLeft,
          className: "dg-version-drawer",
          onClick: (e) => e.stopPropagation(),
        },
          h("span", {
            style: S.close,
            title: "关闭",
            onClick: onClose,
          }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 16, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 } },
            h("span", null, "🏷️ 版本管理"),
            h("span", { style: { ...S.meta, fontSize: 12, fontWeight: 400 } },
              "（显示 " + visibleCount + "/" + allVersions.length + "）")),
          h("div", { style: { ...S.meta, fontSize: 12, opacity: 0.8, marginBottom: 12, lineHeight: 1.4 } },
            "勾选控制版本在看板中的显隐过滤；设置自动保存在本地，不影响底层版本数据。"),

          // 便捷操作按钮栏
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 } },
            h("button", {
              style: { ...S.btn, fontSize: 12, padding: "3px 8px" },
              className: "dg-btn",
              title: "显示全部版本",
              onClick: onShowAll,
            }, "显示全部"),
            h("button", {
              style: { ...S.btn, fontSize: 12, padding: "3px 8px" },
              className: "dg-btn",
              title: "仅显示活跃版本（planning / ready / in_progress / review 等未发布版本）",
              onClick: onShowActiveOnly,
            }, "仅活跃版本"),
            h("button", {
              style: { ...S.btn, fontSize: 12, padding: "3px 8px" },
              className: "dg-btn",
              title: "隐藏全部版本泳道",
              onClick: onHideAll,
            }, "隐藏全部")),

          // 搜索过滤框（版本很多时快速定位）
          allVersions.length > 8
            ? h("div", { style: { marginBottom: 10 } },
                h("input", {
                  style: { ...S.promptInput, width: "100%", fontSize: 12, padding: "4px 8px" },
                  placeholder: "搜索版本名称或 slug…",
                  value: search,
                  onChange: (e) => setSearch(e.target.value),
                }))
            : null,

          // 版本列表
          h("div", {
            style: {
              display: "flex",
              flexDirection: "column",
              gap: 6,
              marginTop: 4,
              maxHeight: "calc(100vh - 190px)",
              overflowY: "auto",
              paddingRight: 4,
            },
          },
            filteredVersions.length === 0
              ? h("div", { style: { ...S.meta, textAlign: "center", padding: "20px 0" } },
                  allVersions.length === 0 ? "暂无版本" : "未找到匹配版本")
              : filteredVersions.map((v) => {
                  const isVisible = !hiddenSet.has(v.slug);
                  const isReleased = v.status === "released";
                  const isActive = !isReleased;
                  const goalsCount = (v.goals ?? []).length;

                  return h("div", {
                    key: v.slug,
                    style: {
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "8px 10px",
                      borderRadius: 6,
                      background: isVisible ? "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12))" : "rgba(128,128,128,.04)",
                      border: "1px solid " + (isVisible ? "var(--dsw-alias-border-l2, rgba(128,128,128,.30))" : "rgba(128,128,128,.15)"),
                      opacity: isVisible ? 1 : 0.65,
                      transition: "all .12s ease",
                    },
                    className: "dg-version-item",
                  },
                    h("label", {
                      style: {
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        cursor: "pointer",
                        flex: 1,
                        minWidth: 0,
                        marginRight: 6,
                      },
                    },
                      h("input", {
                        type: "checkbox",
                        checked: isVisible,
                        style: { cursor: "pointer" },
                        onChange: (e) => onToggleVersion(v.slug, e.target.checked),
                      }),
                      h("div", { style: { display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" } },
                        h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
                          h("span", {
                            style: {
                              fontWeight: 600,
                              fontSize: 13,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            },
                            title: v.name,
                          }, v.name),
                          h("span", {
                            style: {
                              fontSize: 10,
                              padding: "1px 5px",
                              borderRadius: 3,
                              fontWeight: 600,
                              background: isReleased
                                ? "var(--dsw-alias-state-success-tertiary, rgba(58,166,117,.2))"
                                : "var(--dsw-alias-state-business-tertiary, rgba(76,141,255,.2))",
                              color: isReleased
                                ? "var(--dsw-alias-state-success-primary, #6ee7a0)"
                                : "var(--dsw-alias-state-business-primary, #8ab4ff)",
                            },
                          }, isReleased ? "已发布" : (v.status === "active" ? "进行中" : (STATUS_LABEL[v.status] ?? v.status ?? "活跃")))),
                        h("div", { style: { ...S.meta, fontSize: 11, marginTop: 2 } },
                          v.slug + " ｜ " + goalsCount + " 个目标"))),
                    h("button", {
                      style: { ...S.btn, fontSize: 11, padding: "2px 6px", flexShrink: 0 },
                      className: "dg-btn",
                      title: "查看版本详情",
                      onClick: (e) => {
                        e.stopPropagation();
                        onOpenVersionDetail?.(v);
                      },
                    }, "详情 ↗"));
                })),
        )
      );
    }
