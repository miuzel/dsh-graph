    // ===== g-481：「使用说明」弹窗 =====
    // 看板标题栏原「🧩 Graph 设计」入口升格为「📖 使用说明」；原独立的「Graph 设计」弹窗**不再是
    // 独立入口**，它的两张交互图成为本弹窗的第 5 个页签（图部分逐字沿用 g-462 的实现）。
    // 五个页签：使用说明 / 提示词模板 / 工具清单 / 常见问题 / Graph 设计。
    //
    // 单一真源（不新增平行硬编码清单）：
    //   · 版本号 = constants.js 的 PLUGIN_VERSION（本模块不写任何版本字面量）；
    //   · 工具清单 / 提示词资产清单 = 宿主 `/api/dsh-graph/help/catalog`（注册真源投影）——
    //     本模块**不硬编码任何工具名或资产名**，只为资产配 i18n 展示标签（缺标签则回退资产基名，
    //     故宿主新增资产时界面上仍可见，不会静默丢项）；
    //   · 提示词资产正文 = 宿主只读路由 `/api/dsh-graph/help/asset/<name>`（随包产物同源，只读）。
    // 本模块位于工厂作用域（build-client.sh 中排在 drag-prompts 之前）⇒ 组件身份稳定：
    // 切页签或父级重渲染都不会卸载重建子树，Graph 页签的 iframe 因此不会反复重载。
    const HELP_TABS = [
      { key: "usage", labelKey: "help.tab.usage" },
      { key: "prompts", labelKey: "help.tab.prompts" },
      { key: "tools", labelKey: "help.tab.tools" },
      { key: "faq", labelKey: "help.tab.faq" },
      { key: "design", labelKey: "help.tab.design" },
    ];
    // Graph 页签：与 g-462 逐字一致的两张**随包发布**交互图（白名单同源，见宿主 DESIGN_DIAGRAM_FILES）。
    const DESIGN_DIAGRAM_TABS = [
      { key: "lifecycle", file: "design-philosophy.lifecycle.html", labelKey: "design.tab.lifecycle" },
      { key: "workflow", file: "design-philosophy.workflow.html", labelKey: "design.tab.workflow" },
    ];
    const HELP_ASSET_URL = "/api/dsh-graph/help/asset/";
    const HELP_CATALOG_URL = "/api/dsh-graph/help/catalog";
    // g-493：**开篇点题章节**（「为什么叫 dsh-graph：图工程与看板视图」）的正文键，顺序即阅读顺序。
    // 本清单渲染在 HELP_USAGE_KEYS **之前**（点题在先、原有使用说明在后），九个子项逐条落在这些
    // 可见段落里：命名由来 / 逐字定义 + mcp.so 来源 / 任务状态机（简易 Jira + Confluence）/ 角色
    // 自然形成 / 生命周期链与两条回路 / dsh-graph core 与同一套 core 的后续视图 / 看板只是视图与
    // 「不是 DSL」的可编程 / 心中有图 + 看板解决的两件事 / 如实路线图。
    const HELP_USAGE_TOPIC_KEYS = [
      "help.topic.naming", "help.topic.definition", "help.topic.definitionSource",
      "help.topic.stateMachine", "help.topic.roles", "help.topic.lifecycle",
      "help.topic.core", "help.topic.kanbanIsView", "help.topic.programmable",
      "help.topic.stateOfMind", "help.topic.solves", "help.topic.roadmap",
    ];
    // 「使用说明」页签的段落（顺序即阅读顺序；文案全部走 i18n，zh/en 对称）。
    const HELP_USAGE_KEYS = [
      "help.usage.what", "help.usage.board", "help.usage.flow",
      "help.usage.dispatch", "help.usage.review", "help.usage.tabs",
    ];
    // FAQ 项编号（只用于取 i18n 键与 React key，界面上不显示编号）。
    // g-493 追加第 8 条：点题问答（问答正文即负责人原话口径，键在 i18n 里）。
    const HELP_FAQ_ITEMS = [1, 2, 3, 4, 5, 6, 7, 8];
    // g-489：使用说明页签的**分模块章节**（顺序即展示顺序：看板/目标/版本管理/泳道/侧边栏/
    // 上下文卡片与项目知识库/记忆系统/子代理与 agent teams/常用设置）。每章三要素缺一即判红
    //（core/tests/g489-help-content.test.ts）。
    const HELP_MODULE_CHAPTERS = [
      "board", "goal", "version", "lane", "sidebar", "cards", "memory", "subagents", "settings",
    ];
    // 章内三要素：是什么 / 怎么用 / 关键操作（后缀 → 展示标签键）。
    const HELP_CHAPTER_FIELDS = [
      { key: "what", labelKey: "help.mod.what" },
      { key: "how", labelKey: "help.mod.how" },
      { key: "ops", labelKey: "help.mod.ops" },
    ];

    /** 资产展示标签：优先 i18n（`help.asset.<base>`）；缺键时回退到资产基名 ⇒ 新资产仍可见。 */
    function helpAssetLabel(base) {
      const key = "help.asset." + base;
      const label = dgT(key);
      return label === key ? base : label;
    }

    /** 宿主帮助目录（工具清单 + 资产清单 + 生效提示词语言）。只读 GET，失败给可读错误。 */
    function useHelpCatalog() {
      const [state, setState] = React.useState({ status: "loading", catalog: null, error: "" });
      React.useEffect(() => {
        let alive = true;
        fetch(HELP_CATALOG_URL, { headers: { accept: "application/json" } })
          .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
          .then((data) => { if (alive) setState({ status: "ready", catalog: data, error: "" }); })
          .catch((e) => { if (alive) setState({ status: "error", catalog: null, error: String(e?.message ?? e) }); });
        return () => { alive = false; };
      }, []);
      return state;
    }

    /** 目录里生效的资产语言（宿主按提示词语言设置解析；缺省中文，与引擎降级口径一致）。 */
    function helpCatalogLanguage(catalog) {
      return catalog && catalog.prompt_language === "en" ? "en" : "zh";
    }

    /** 目录条目里的双语字段取值（生效语言优先，缺该语言回落 zh；两者都缺给空串）。 */
    function helpCatalogText(field, lang) {
      if (!field || typeof field !== "object") return "";
      return field[lang] || field.zh || field.en || "";
    }

    // g-498：提示词模板的**稳定身份**是资产基名（`base`，如 `discipline`），不是完整文件名。
    // 完整名（`<基名>.<语言>.md`）随语言变化 ⇒ 若拿它当选中态，切语言就会被判成「不在当前集合」
    // 而回落到首项（负责人目视到的「切 zh/en 跳回首条」）。选中态改存 base 后，切换语言只是
    // 换一份同 base 的资产正文，选择**不丢**。
    /** 按基名 + 当前语言解析完整资产名（维护提示词**语言优先级**）。 */
    function helpAssetNameOf(list, base, lang) {
      if (!base) return "";
      const rows = (Array.isArray(list) ? list : []).filter((e) => e && e.base === base);
      if (!rows.length) return "";
      const byLang = (code) => rows.find((e) => e.lang === code);
      const hit = byLang(lang) || byLang("zh") || byLang("en") || rows[0];
      return hit ? hit.name : "";
    }

    /** 语言候选顺序：请求语言优先，其余语言**透明回落**（缺译文时不至于丢项或空白）。 */
    function helpAssetLangOrder(lang) {
      const all = ["zh", "en"];
      return [lang].concat(all.filter((c) => c !== lang));
    }

    /** g-498：把目录投影按**注册元数据**里的分类分组（客户端不新增文件清单）。
     *  分类顺序取自宿主 `prompt_categories`（不重排）；未分类条目归入「未分类」且**仍然可见**；
     *  每个资产**恰出现一次**（分组键唯一 ⇒ 由构造保证，见 g498 回归测试）。 */
    function helpPromptGroups(entries, categories, lang) {
      const rows = Array.isArray(entries) ? entries : [];
      const cats = Array.isArray(categories) ? categories : [];
      const groups = cats.map((c) => ({
        key: c.key,
        label: helpCatalogText(c.label, lang) || String(c.key),
        rows: rows.filter((e) => e && e.category === c.key),
      })).filter((g) => g.rows.length);
      const orphan = rows.filter((e) => !e || !cats.some((c) => c.key === e.category));
      if (orphan.length) groups.push({ key: "help-prompts-orphan", label: dgT("help.prompts.orphan"), rows: orphan });
      return groups;
    }

    /** g-489 入门第一步：先指定主管 Agent（技能名 + 接管这一步 + 可直接复制的示例提示词）。
     *  g-496：**示例提示词正文**改由宿主只读资产提供（`gui-help-takeover-example.*.md`），
     *  i18n 字典只留展示标签（`help.entry.promptLabel`）。读取失败**不得**静默显示空示例：
     *  明确提示不可用并禁用复制按钮（避免把空串复制进剪贴板）。 */
    function HelpEntryStep() {
      const [note, setNote] = React.useState("");
      // g-496：示例提示词异步取自宿主资产（跟随界面语言）；null = 尚未取到，"" = 读取失败。
      const [prompt, setPrompt] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        loadGuiPromptAsset("gui-help-takeover-example")
          .then((text) => { if (alive) setPrompt(text); })
          .catch((e) => {
            console.warn("[dsh-graph-host] help entry: prompt asset load failed:", e);
            if (alive) setPrompt("");
          });
        return () => { alive = false; };
      }, []);
      React.useEffect(() => {
        if (!note) return undefined;
        const timer = setTimeout(() => setNote(""), 2400);
        return () => clearTimeout(timer);
      }, [note]);
      const promptReady = typeof prompt === "string" && prompt.length > 0;
      return h("div", {
        className: "dg-help-entry",
        style: {
          marginTop: 12, padding: "10px 12px", borderRadius: 6,
          background: "rgba(76,141,255,.10)", border: "1px solid rgba(76,141,255,.35)",
        },
      },
        h("div", { className: "dg-help-entry-title", style: { fontWeight: 700, fontSize: 13 } }, dgT("help.entry.title")),
        h("p", {
          className: "dg-help-p dg-help-entry-body",
          style: { margin: "6px 0 0", fontSize: 12.5, lineHeight: 1.75 },
        }, dgT("help.entry.body")),
        h("div", {
          style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 8 },
        },
          h("div", { className: "dg-help-entry-label", style: { ...S.meta, marginRight: "auto" } }, dgT("help.entry.promptLabel")),
          h("button", {
            className: "dg-btn dg-help-entry-copy",
            style: { ...S.btn, padding: "2px 10px", fontSize: 12 },
            // 资产未就绪 / 读取失败时禁用：绝不把空串或半截文本复制进剪贴板。
            disabled: !promptReady,
            onClick: async () => {
              if (!promptReady) return;
              // 复用工厂作用域既有的复制实现（Clipboard API + execCommand 回退），不新增第二套。
              const ok = await copyText(prompt);
              setNote(ok ? dgT("help.entry.copied") : dgT("help.entry.copyFail"));
            },
          }, dgT("help.entry.copy")),
          note
            ? h("span", { className: "dg-help-entry-note", style: S.meta }, note)
            : null),
        h("pre", {
          className: "dg-help-entry-prompt",
          style: {
            margin: "6px 0 0", padding: "8px 10px", borderRadius: 6, fontSize: 12, lineHeight: 1.7,
            whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit",
            background: "rgba(128,128,128,.10)",
          },
        }, promptReady ? prompt : dgT("gui.promptAssetLoadFail")));
    }

    /** g-489 分模块章节：一章一块，三要素逐行标出（是什么 / 怎么用 / 关键操作）。 */
    function HelpModuleChapter(props) {
      const chapter = props.chapter;
      return h("div", {
        className: "dg-help-chapter",
        style: { marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(128,128,128,.22)" },
      },
        h("div", {
          className: "dg-help-chapter-title",
          style: { fontWeight: 700, fontSize: 13 },
        }, dgT("help.mod." + chapter + ".title")),
        ...HELP_CHAPTER_FIELDS.map((f) => h("div", {
          key: "help-mod-" + chapter + "-" + f.key,
          className: "dg-help-chapter-row dg-help-chapter-" + f.key,
          style: { display: "flex", gap: 8, marginTop: 4, fontSize: 12, lineHeight: 1.75 },
        },
          h("span", {
            className: "dg-help-chapter-label",
            style: { ...S.meta, flex: "0 0 56px", whiteSpace: "nowrap" },
          }, dgT(f.labelKey)),
          h("span", {
            className: "dg-help-chapter-text",
            style: { flex: "1 1 auto", minWidth: 0, opacity: 0.92 },
          }, dgT("help.mod." + chapter + "." + f.key)))));
    }

    /** g-498：点题章节的**语义小标题分组**（「命名与定义 / 当前工作机制 / 看板定位 / 未来路线图」）。
     *  组名走 i18n（zh/en 对称）；组内顺序即 `HELP_USAGE_TOPIC_KEYS` 的顺序。
     *  未列入任何组的键**不会消失** —— 渲染时归入末尾的「未分组」兜底组（不静默丢项）。 */
    const HELP_TOPIC_SECTIONS = [
      { key: "naming", labelKey: "help.topic.section.naming", keys: ["help.topic.naming", "help.topic.definition", "help.topic.definitionSource"] },
      { key: "mechanism", labelKey: "help.topic.section.mechanism", keys: ["help.topic.stateMachine", "help.topic.roles", "help.topic.lifecycle", "help.topic.core"] },
      { key: "board", labelKey: "help.topic.section.board", keys: ["help.topic.kanbanIsView", "help.topic.programmable", "help.topic.stateOfMind", "help.topic.solves"] },
      { key: "roadmap", labelKey: "help.topic.section.roadmap", keys: ["help.topic.roadmap"] },
    ];

    /** g-498：**引文单独呈现**的键（blockquote 引用块，而不是混在正文段落里）。 */
    const HELP_TOPIC_QUOTE_KEYS = ["help.topic.definition"];

    /** g-498：点题段落的分组视图。
     *  组内顺序沿用传入清单的顺序；清单里**未登记**的键追加到末尾兜底组（保证每条恰一次、不丢项）。 */
    function helpTopicSections(topKeys) {
      const keys = Array.isArray(topKeys) ? topKeys : [];
      const assigned = new Set(HELP_TOPIC_SECTIONS.flatMap((s) => s.keys));
      const sections = HELP_TOPIC_SECTIONS
        .map((s) => ({ key: s.key, labelKey: s.labelKey, keys: keys.filter((k) => s.keys.includes(k)) }))
        .filter((s) => s.keys.length);
      const rest = keys.filter((k) => !assigned.has(k));
      if (rest.length) sections.push({ key: "more", labelKey: "help.topic.section.more", keys: rest });
      return sections;
    }

    /** g-498：三段式 Markdown 渲染 —— 段落 + `>` 引用块，行内一律走**安全的 React 节点**。
     *  正文（i18n 字符串）里的 `**粗体**` / `` `代码` `` / 链接由 `parseInlineMarkdown` 解析成
     *  React 元素（`strong` / `code` / `a`），**不用 innerHTML / dangerouslySetInnerHTML**；
     *  引文用独立 blockquote（左竖线 + 缩进）与正文分开呈现。 */
    function HelpRichText(props) {
      const text = String(props.text ?? "");
      const blocks = [];
      let paragraph = [];
      const flush = () => {
        if (!paragraph.length) return;
        blocks.push({ type: "p", text: paragraph.join("\n") });
        paragraph = [];
      };
      for (const line of text.split("\n")) {
        const quote = /^>\s?(.*)$/.exec(line);
        if (quote) { flush(); blocks.push({ type: "quote", text: quote[1] }); } else if (!line.trim()) { flush(); } else { paragraph.push(line); }
      }
      flush();
      return h("div", { className: "dg-help-rich" },
        ...blocks.map((b, i) => (b.type === "quote"
          ? h("blockquote", {
            key: `help-quote-${i}`,
            className: "dg-help-quote",
            style: {
              margin: "8px 0", padding: "6px 12px", fontSize: 13, lineHeight: 1.8,
              borderLeft: "3px solid rgba(128,128,128,.45)", background: "rgba(128,128,128,.07)",
              borderRadius: 4, opacity: 0.95,
            },
          }, parseInlineMarkdown(b.text))
          : h("p", {
            key: `help-paragraph-${i}`,
            className: "dg-help-p dg-help-rich-p",
            style: { margin: "0 0 8px", fontSize: 13, lineHeight: 1.75 },
          }, parseInlineMarkdown(b.text)))));
    }

    function HelpUsageTab() {
      const sections = helpTopicSections(HELP_USAGE_TOPIC_KEYS);
      const bodyStyle = { maxWidth: 760, margin: "0 auto" };
      return h("div", { className: "dg-help-usage", style: bodyStyle },
        h("div", {
          className: "dg-help-version",
          style: { ...S.meta, marginBottom: 8 },
        }, dgT("help.version", { version: PLUGIN_VERSION })),
        // g-493：开篇点题章节（命名由来 / 图工程定义逐字引用 / 看板只是视图 / 看板解决的两件事 /
        // 如实路线图）。数据驱动、渲染在原有使用说明段落之前 —— 「点题」必须开篇可见。
        // g-498：正文按语义分小标题呈现，行内 Markdown 走**安全 React 节点**（不再原样显示星号）；
        // 逐字引文单独用 blockquote 呈现，原文与来源逐字不变。
        h("div", { className: "dg-help-topic", key: "help-topic" },
          h("div", {
            className: "dg-help-topic-title",
            style: { fontWeight: 700, fontSize: 14, marginBottom: 6 },
          }, dgT("help.topic.title")),
          ...sections.map((section) => h("div", {
            key: "help-topic-section-" + section.key,
            className: "dg-help-topic-section dg-help-topic-section-" + section.key,
          },
            h("div", {
              className: "dg-help-topic-section-title",
              style: { fontWeight: 600, fontSize: 13.5, margin: "12px 0 5px", opacity: 0.95 },
            }, dgT(section.labelKey)),
            ...section.keys.map((key) => (HELP_TOPIC_QUOTE_KEYS.includes(key)
              ? h("div", {
                key: "help-topic-" + key,
                className: "dg-help-quote-wrap dg-help-topic-p " + key.replace(/\./g, "-"),
              }, h(HelpRichText, { text: dgT(key) }))
              : h(HelpRichText, {
                key: "help-topic-" + key,
                className: "dg-help-topic-p " + key.replace(/\./g, "-"),
                text: dgT(key),
              })))))),
        ...HELP_USAGE_KEYS.map((key) => h("p", {
          key: "help-usage-" + key,
          className: "dg-help-p",
          style: { margin: "0 0 8px", fontSize: 13, lineHeight: 1.7 },
        }, dgT(key))),
        h(HelpEntryStep, { key: "help-entry-step" }),
        h("div", {
          className: "dg-help-mod-title",
          style: { fontWeight: 700, fontSize: 14, marginTop: 16 },
        }, dgT("help.mod.title")),
        h("p", {
          className: "dg-help-p dg-help-mod-intro",
          style: { margin: "4px 0 0", fontSize: 13, lineHeight: 1.7 },
        }, dgT("help.mod.intro")),
        ...HELP_MODULE_CHAPTERS.map((chapter) => h(HelpModuleChapter, {
          key: "help-chapter-" + chapter,
          chapter,
        })));
    }

    function HelpPromptsTab(props) {
      const state = props.catalogState || {};
      const catalog = state.catalog;
      const entries = (catalog && Array.isArray(catalog.prompts)) ? catalog.prompts : [];
      const categories = (catalog && Array.isArray(catalog.prompt_categories)) ? catalog.prompt_categories : [];
      const hostLang = helpCatalogLanguage(catalog);
      const [pickedLang, setPickedLang] = React.useState(null);
      // g-498：选中态是**基名**（稳定身份），不是完整资产名 ⇒ 切换语言不再丢选择。
      const [pickedBase, setPickedBase] = React.useState("");
      const [asset, setAsset] = React.useState({ status: "idle", text: "", error: "", lang: "" });
      const lang = pickedLang ?? hostLang;
      const visible = entries.filter((e) => e.lang === lang);
      // 当前语言**有**条目时，选中项必须留在该语言集合内（首开 / 该语言缺此资产 ⇒ 回落到该语言首项）。
      // 该语言**完全没有**条目时（整批缺译文）不把选择清空 —— 退到全量清单的首项，由
      // `helpAssetNameOf` 按「请求语言 → zh → en」取到实际存在的那一份，并如实标注实际语言。
      const pool = visible.length ? visible : entries;
      const base = pool.some((e) => e.base === pickedBase) ? pickedBase : ((pool[0] && pool[0].base) || "");
      // g-498：清单只展示**当前语言**的条目（`visible`）；分组同样只对 `visible` 分组，
      // 否则两种语言的条目会一起出现（每项不止一次）。总量守恒 = 当前语言资产数。
      const groups = helpPromptGroups(visible, categories, lang);
      // 请求路径永远与界面语言一致：`<base>.<当前语言>.md`（列表项、按钮高亮与正文据此三者一致）。
      const selected = helpAssetNameOf(entries, base, lang);
      const selectedEntry = entries.find((e) => e.name === selected) || null;
      // 正文里的实际语言 = 完整名后缀（缺译文时宿主回落，UI 如实标注，不假装是请求语言）。
      const shownLang = selectedEntry && selectedEntry.lang ? selectedEntry.lang : lang;
      React.useEffect(() => {
        if (!selected) { setAsset({ status: "idle", text: "", error: "", lang: "" }); return undefined; }
        let alive = true;
        setAsset({ status: "loading", text: "", error: "", lang: "" });
        fetch(HELP_ASSET_URL + selected, { headers: { accept: "text/markdown" } })
          .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
          .then((text) => { if (alive) setAsset({ status: "ready", text, error: "", lang: shownLang }); })
          .catch((e) => { if (alive) setAsset({ status: "error", text: "", error: String(e?.message ?? e), lang: "" }); });
        // alive 守卫：快速切换语言时，**旧请求的响应不得覆盖**新选择的结果。
        return () => { alive = false; };
      }, [selected]);
      return h("div", { className: "dg-help-prompts" },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 8 } },
          h("div", { style: { ...S.meta, marginRight: "auto" } }, dgT("help.prompts.intro")),
          ...["zh", "en"].map((code) => h("button", {
            key: "help-lang-" + code,
            className: "dg-help-lang-btn dg-btn" + (code === lang ? " dg-btn-active" : ""),
            style: { ...(code === lang ? S.btnPrimary : S.btn), padding: "2px 10px", fontSize: 12 },
            onClick: () => setPickedLang(code),
          }, dgT("help.lang." + code)))),
        state.status === "loading"
          ? h("div", { className: "dg-help-loading", style: { ...S.meta, padding: "8px 0" } }, dgT("help.prompts.loading"))
          : state.status === "error"
            ? h("div", { className: "dg-help-error", style: { fontSize: 12, padding: "8px 0" } }, dgT("help.prompts.error", { error: String(state.error ?? "") }))
            : h("div", { style: { display: "flex", gap: 12, alignItems: "flex-start", minHeight: 0 } },
          h("div", {
            className: "dg-help-prompt-list",
            style: { flex: "0 0 190px", display: "flex", flexDirection: "column", gap: 4 },
          }, ...groups.map((g) => h("div", {
            key: "help-prompt-group-" + g.key,
            className: "dg-help-prompt-group",
            style: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 6 },
          },
            h("div", {
              className: "dg-help-prompt-group-title",
              style: { ...S.meta, fontWeight: 600, marginBottom: 2, opacity: 0.95 },
            }, g.label + "（" + g.rows.length + "）"),
            ...g.rows.map((e) => h("button", {
              key: "help-asset-" + e.name,
              // g-498：高亮按**语言无关的基名**判定 —— 切语言后当前项仍然高亮（不再跳回首条）。
              className: "dg-help-asset-btn dg-btn" + (e.base === base ? " dg-btn-active" : ""),
              style: { ...(e.base === base ? S.btnPrimary : S.btn), textAlign: "left", padding: "4px 10px", fontSize: 12 },
              onClick: () => setPickedBase(e.base),
            }, helpAssetLabel(e.base)))))),
          h("div", { className: "dg-help-prompt-body", style: { flex: "1 1 auto", minWidth: 0 } },
            h("div", { style: { ...S.meta, marginBottom: 6 } },
              (selectedEntry ? helpAssetLabel(selectedEntry.base) + " · " : "")
                + dgT("help.prompts.source")
                // 缺译文透明回落：实际展示的不是请求语言时**如实标注**，不假装。
                + (shownLang !== lang ? " " + dgT("help.prompts.langFallback", { lang: dgT("help.lang." + shownLang) }) : "")),
            asset.status === "loading"
              ? h("div", { className: "dg-help-loading", style: { ...S.meta, padding: "8px 0" } }, dgT("help.prompts.loading"))
              : asset.status === "error"
                ? h("div", { className: "dg-help-error", style: { fontSize: 12, padding: "8px 0" } }, dgT("help.prompts.error", { error: asset.error }))
                : h("div", {
                  className: "dg-help-prompt-md",
                  style: { padding: "8px 10px", borderRadius: 6, background: "rgba(128,128,128,.06)" },
                }, h(GoalMarkdown, { text: asset.text })))));
    }

    /** g-489 工具清单页签：按宿主分类真源分**表格**呈现（简称 / 工具名 / 用途），每类一张表。
     *  分类、简称、用途全部来自 `/help/catalog`（本模块零硬编码工具名/分类名/简称）；
     *  宿主的结构守卫（分类表 ≡ 注册真源）报红时，页签顶部显示红条并列出红因。
     *  g-493：每行加一个「展开说明」的**点击/hover 自绘浮层**（原生 title 之外的可发现路径），
     *  内容 = 该工具的完整注册说明 + i18n 里 `help.toolTopic.<name>` 的补充（无则只显示注册说明）。 */
    function HelpToolsTab(props) {
      const state = props.catalogState || {};
      const catalog = state.catalog;
      const tools = (catalog && Array.isArray(catalog.tools)) ? catalog.tools : [];
      const categories = (catalog && Array.isArray(catalog.categories)) ? catalog.categories : [];
      const problems = (catalog && Array.isArray(catalog.taxonomy_problems)) ? catalog.taxonomy_problems : [];
      const lang = helpCatalogLanguage(catalog);
      const thStyle = { textAlign: "left", fontSize: 12, fontWeight: 600, padding: "4px 8px 4px 0", borderBottom: "1px solid rgba(128,128,128,.35)" };
      const tdStyle = { fontSize: 12, lineHeight: 1.6, padding: "5px 8px 5px 0", verticalAlign: "top" };
      // g-495：逐行「展开说明」折叠面板已移除 —— 展开面板首行只是把同列的 description
      // 再渲染一遍（与折叠列重复），且工具用法以 harness 注入的工具定义为准。
      // 分类顺序来自宿主（不重排）；每类的行取自同一份 tools 投影。
      const groups = categories.map((c) => ({
        key: c.key,
        label: helpCatalogText(c.label, lang),
        rows: tools.filter((t) => t.category === c.key),
      }));
      // 未归类（分类键缺失/未登记）也必须可见 —— 不许静默丢项。
      const orphan = tools.filter((t) => !categories.some((c) => c.key === t.category));
      if (orphan.length) groups.push({ key: "__orphan__", label: dgT("help.tools.orphan"), rows: orphan });
      const body = state.status === "loading"
        ? [h("div", { key: "help-tools-loading", className: "dg-help-loading", style: { ...S.meta, padding: "8px 0" } }, dgT("help.tools.loading"))]
        : state.status === "error"
          ? [h("div", { key: "help-tools-error", className: "dg-help-error", style: { fontSize: 12, padding: "8px 0" } }, dgT("help.tools.error", { error: String(state.error ?? "") }))]
          : [
            problems.length
              ? h("div", {
                key: "help-tools-problems",
                className: "dg-help-tools-problems",
                style: {
                  fontSize: 12, lineHeight: 1.7, marginBottom: 8, padding: "6px 8px", borderRadius: 4,
                  color: "var(--dsw-alias-state-error-primary, #ff6b6b)",
                  background: "rgba(255,107,107,.12)", border: "1px solid rgba(255,107,107,.45)",
                },
              }, dgT("help.tools.problems") + " " + problems.join("；"))
              : null,
            ...groups.map((g) => h("div", {
              key: "help-tools-group-" + g.key,
              className: "dg-help-tools-group",
              style: { marginBottom: 12 },
            },
              h("div", {
                className: "dg-help-tools-group-title",
                style: { fontWeight: 600, fontSize: 12.5, marginBottom: 4, opacity: 0.95 },
              }, g.label + "（" + g.rows.length + "）"),
              h("table", {
                className: "dg-help-tools-table",
                style: { width: "100%", borderCollapse: "collapse" },
              },
                h("thead", null, h("tr", null,
                  h("th", { style: { ...thStyle, width: 96 } }, dgT("help.tools.colShort")),
                  h("th", { style: { ...thStyle, width: 210 } }, dgT("help.tools.colName")),
                  h("th", { style: thStyle }, dgT("help.tools.colUse")))),
                h("tbody", null, ...g.rows.map((t) => h("tr", {
                  key: "help-tool-" + t.name,
                  className: "dg-help-tool",
                },
                  h("td", {
                    className: "dg-help-tool-short",
                    style: { ...tdStyle, fontWeight: 600 },
                  }, helpCatalogText(t.short, lang)),
                  h("td", { style: tdStyle },
                    h("code", {
                      className: "dg-help-tool-name",
                      style: { fontSize: 12, fontWeight: 600 },
                    }, t.name)),
                  h("td", {
                    className: "dg-help-tool-desc",
                    style: { ...tdStyle, opacity: 0.9 },
                  },
                    helpCatalogText(t.description, lang)))))))),
          ];
      return h("div", { className: "dg-help-tools" },
        h("div", { style: { ...S.meta, marginBottom: 8 } },
          dgT("help.tools.intro", { count: String(tools.length) }) + " " + dgT("help.tools.langHint", { lang: dgT("help.lang." + lang) })),
        ...body);
    }

    function HelpFaqTab() {
      return h("div", { className: "dg-help-faq" },
        h("div", { style: { ...S.meta, marginBottom: 8 } }, dgT("help.faq.intro")),
        ...HELP_FAQ_ITEMS.map((n) => {
          // g-493：第 8 条是**点题问答**（问答正文由 i18n 提供）。为避免同一句话两处维护而漂移，
          // 这一条从 help.topic.faqQ / help.topic.faqA 取；两条 i18n 键都必须在 zh/en 存在。
          const key = n === 8 ? "help.topic.faq" : "help.faq.";
          const q = n === 8 ? dgT("help.topic.faqQ") : dgT("help.faq.q" + n);
          const a = n === 8 ? dgT("help.topic.faqA") : dgT("help.faq.a" + n);
          if (n === 8 && (!String(q).trim() || !String(a).trim())) return null;
          return h("div", {
            key: "help-faq-" + n,
            className: "dg-help-faq-item" + (n === 8 ? " dg-help-faq-topic" : ""),
            style: { marginBottom: 10 },
          },
            h("div", { style: { fontWeight: 600, fontSize: 13 } }, q),
            h("div", { style: { fontSize: 12, lineHeight: 1.7, marginTop: 3, opacity: 0.9 } }, a));
        }));
    }

    /** Graph 页签：g-462 的设计哲学弹窗内容（notice → roadmap → 图页签 → iframe），只读展示。 */
    function HelpDesignTab() {
      const [tab, setTab] = React.useState("lifecycle");
      const active = DESIGN_DIAGRAM_TABS.find((t) => t.key === tab) ?? DESIGN_DIAGRAM_TABS[0];
      const src = "/api/dsh-graph/diagram/" + active.file;
      return h("div", {
        className: "dg-help-design",
        style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 },
      },
        // 如实声明（醒目）：暂不支持自定义；后续将开放 graph 语义调整与可视化自定义。
        h("div", {
          className: "dg-design-notice",
          style: {
            padding: "6px 8px", borderRadius: 4, fontSize: 12, flexShrink: 0,
            background: "rgba(224,165,58,.14)", border: "1px solid rgba(224,165,58,.4)",
          },
        }, dgT("design.notice")),
        // g-493 去重归属：命名由来与「看板只是视图」**详述在使用说明页签开篇**，本页签只保留一处
        // **引用**（可见正文 + 可点击跳到「使用说明」页签），两处不得互相矛盾。
        h("div", {
          className: "dg-design-crossref",
          style: {
            marginTop: 6, padding: "6px 8px", borderRadius: 4, fontSize: 12, flexShrink: 0,
            opacity: 0.9, background: "rgba(128,128,128,.08)",
          },
        }, dgT("help.topic.designCrossref")),
        // 后续路线（尚未实现）：独立小节 —— 不画进图里、也不新增页签。只指路设计哲学文档的
        // **章节名**，不用会随改版漂移的章节序号。
        h("div", {
          className: "dg-design-roadmap",
          style: {
            marginTop: 6, padding: "6px 8px", borderRadius: 4, fontSize: 12, flexShrink: 0,
            opacity: 0.85, border: "1px dashed rgba(128,128,128,.4)",
          },
        }, dgT("design.roadmap")),
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginTop: 10, flexShrink: 0 } },
          ...DESIGN_DIAGRAM_TABS.map((t) => h("button", {
            key: "design-tab-" + t.key,
            className: "dg-btn" + (t.key === active.key ? " dg-btn-active" : ""),
            style: { ...(t.key === active.key ? S.btnPrimary : S.btn), padding: "4px 12px", fontSize: 12 },
            onClick: () => setTab(t.key),
          }, dgT(t.labelKey))),
          h("a", {
            className: "dg-design-open",
            href: src,
            target: "_blank",
            rel: "noreferrer",
            style: { ...S.meta, marginLeft: "auto", whiteSpace: "nowrap" },
          }, dgT("design.openNewTab"))),
        h("div", {
          style: {
            flex: "1 1 auto", minHeight: 0, marginTop: 8, borderRadius: 6, overflow: "hidden",
            border: "1px solid rgba(128,128,128,.35)", background: "#fff",
          },
        },
          // g-493 顺手收口：此处原有原生 `title` 提示（g-489 评审残余，负责人批 2 裁决
          // 「不要用 title、用点击/hover 自绘浮层」）已**删除** —— iframe 的 `name` 属性
          // 不属于原生提示（不产生悬停 tooltip），仅用于 iframe 可访问名。
          h("iframe", {
            key: "design-frame-" + active.key,
            className: "dg-design-frame",
            name: dgT("design.title") + " · " + dgT(active.labelKey),
            src,
            style: { display: "block", width: "100%", height: "100%", border: "none" },
          })));
    }

    function HelpModal(props) {
      useLocaleRevision();
      const { onClose } = props;
      // g-181：backdrop 误关保护（与其它弹窗同一 guard）
      const backdropGuard = useBackdropClose(onClose);
      const [tab, setTab] = React.useState("usage");
      const current = HELP_TABS.some((t) => t.key === tab) ? tab : "usage";
      // 目录只取一次，由「提示词模板」「工具清单」两个页签共享（同一份注册真源投影）。
      const catalogState = useHelpCatalog();
      return dgOverlay({ style: S.overlay, ...backdropGuard },
        h("div", {
          className: "dg-help-modal",
          style: {
            ...S.modal, width: "min(1080px, 94vw)", maxWidth: "94vw",
            height: "min(780px, 90vh)", maxHeight: "90vh",
            display: "flex", flexDirection: "column", overflow: "hidden", padding: "14px 16px",
          },
          onClick: (e) => e.stopPropagation(),
        },
          h("span", { className: "dg-close", style: S.close, onClick: onClose }, "✕"),
          h("div", { style: { fontWeight: 700, fontSize: 15, flexShrink: 0 } }, dgT("help.title")),
          h("div", {
            className: "dg-help-tabs",
            style: { display: "flex", alignItems: "center", gap: 6, marginTop: 10, flexShrink: 0, flexWrap: "wrap" },
          }, ...HELP_TABS.map((t) => h("button", {
            key: "help-tab-" + t.key,
            className: "dg-btn" + (t.key === current ? " dg-btn-active" : ""),
            style: { ...(t.key === current ? S.btnPrimary : S.btn), padding: "4px 12px", fontSize: 12 },
            onClick: () => setTab(t.key),
          }, dgT(t.labelKey)))),
          h("div", {
            className: "dg-help-body",
            style: { flex: "1 1 auto", minHeight: 0, marginTop: 10, overflow: "auto" },
          },
            current === "usage" ? h(HelpUsageTab, { key: "help-tab-body-usage" })
              : current === "prompts" ? h(HelpPromptsTab, { key: "help-tab-body-prompts", catalogState })
                : current === "tools" ? h(HelpToolsTab, { key: "help-tab-body-tools", catalogState })
                  : current === "faq" ? h(HelpFaqTab, { key: "help-tab-body-faq" })
                    : h(HelpDesignTab, { key: "help-tab-body-design" }))));
    }
