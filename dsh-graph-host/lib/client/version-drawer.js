    // ===== g-223：版本管理抽屉（左侧展开，版本显隐过滤、全选/取消/仅活跃快捷操作） =====
    function VersionDrawer(props) {
      useLocaleRevision();
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
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "dg-version-drawer-title",
          "aria-label": dgT("versionDrawer.title"),
          onClick: (e) => e.stopPropagation(),
        },
          h("button", {
            type: "button",
            style: { ...S.close, background: "none", border: "none", padding: 0, color: "inherit", font: "inherit" },
            title: dgT("common.close"),
            "aria-label": dgT("common.close"),
            onClick: onClose,
          }, "✕"),
          h("div", { id: "dg-version-drawer-title", style: { fontWeight: 700, fontSize: 16, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 } },
            h("span", null, dgT("versionDrawer.title")),
            h("span", { style: { ...S.meta, fontSize: 12, fontWeight: 400 } },
              dgT("versionDrawer.displayCount", { visible: visibleCount, total: allVersions.length }))),
          h("div", { style: { ...S.meta, fontSize: 12, opacity: 0.8, marginBottom: 12, lineHeight: 1.4 } },
            dgT("versionDrawer.hint")),

          // 便捷操作按钮栏
          h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 } },
            h("button", {
              style: { ...S.btn, fontSize: 12, padding: "3px 8px" },
              className: "dg-btn",
              title: dgT("versionDrawer.showAll"),
              onClick: onShowAll,
            }, dgT("versionDrawer.showAll")),
            h("button", {
              style: { ...S.btn, fontSize: 12, padding: "3px 8px" },
              className: "dg-btn",
              title: dgT("versionDrawer.showActiveTooltip"),
              onClick: onShowActiveOnly,
            }, dgT("versionDrawer.showActive")),
            h("button", {
              style: { ...S.btn, fontSize: 12, padding: "3px 8px" },
              className: "dg-btn",
              title: dgT("versionDrawer.hideAllTooltip"),
              onClick: onHideAll,
            }, dgT("versionDrawer.hideAll"))),

          // 搜索过滤框（版本很多时快速定位）
          allVersions.length > 8
            ? h("div", { style: { marginBottom: 10 } },
                h("input", {
                  style: { ...S.promptInput, width: "100%", fontSize: 12, padding: "4px 8px" },
                  placeholder: dgT("versionDrawer.searchPlaceholder"),
                  "aria-label": dgT("versionDrawer.searchPlaceholder"),
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
              maxHeight: "calc(100% - 190px)",
              overflowY: "auto",
              paddingRight: 4,
            },
          },
            filteredVersions.length === 0
              ? h("div", { style: { ...S.meta, textAlign: "center", padding: "20px 0" } },
                  allVersions.length === 0 ? dgT("versionDrawer.noVersions") : dgT("versionDrawer.noMatch"))
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
                          }, isReleased ? dgT("versionDrawer.released") : (v.status === "active" ? dgT("versionDrawer.active") : (STATUS_LABEL[v.status] ?? v.status ?? dgT("versionDrawer.active"))))),
                        h("div", { style: { ...S.meta, fontSize: 11, marginTop: 2 } },
                          v.slug + " ｜ " + dgT("versionDrawer.goalCount", { count: goalsCount })))),
                    h("button", {
                      style: { ...S.btn, fontSize: 11, padding: "2px 6px", flexShrink: 0 },
                      className: "dg-btn",
                      title: dgT("versionDrawer.detailTooltip"),
                      onClick: (e) => {
                        e.stopPropagation();
                        onOpenVersionDetail?.(v);
                      },
                    }, dgT("versionDrawer.detail")));
                })),
        )
      );
    }
    // Contract marker: 已隐藏全部 X 个版本（包含已发布版本）; title: "版本管理（显隐过滤与版本列表）"
