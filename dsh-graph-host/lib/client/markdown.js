    // g-270 / g-275：Markdown 共享解析、渲染与模式切换控件模块
    // 供目标描述（goal-modal.js）与卡片抽屉（card-drawer.js）共同复用

    // g-270：轻量行内 Markdown 解析器（纯 React 元素树，零 innerHTML，天然免疫 XSS）
    function parseInlineMarkdown(text) {
      if (!text) return [];
      const tokens = [];
      const regex = /(`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|(@att\/[a-zA-Z0-9_./-]+)|\[([^\]]+)\]\(([^)]+)\))/g;
      let lastIndex = 0;
      let match;
      let key = 0;

      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          tokens.push(text.slice(lastIndex, match.index));
        }
        const [full, , code, bold, italic, attRef, linkText, linkUrl] = match;
        if (code !== undefined) {
          tokens.push(h("code", {
            key: `c-${key++}`,
            style: {
              background: "var(--dsw-alias-fill-tsp-secondary, rgba(128,128,128,.15))",
              padding: "1px 4px",
              borderRadius: 3,
              fontSize: "0.9em",
              fontFamily: "var(--ds-font-family-code, monospace)",
            }
          }, code));
        } else if (bold !== undefined) {
          tokens.push(h("strong", { key: `b-${key++}` }, parseInlineMarkdown(bold)));
        } else if (italic !== undefined) {
          tokens.push(h("em", { key: `i-${key++}` }, italic));
        } else if (attRef !== undefined) {
          const attName = attRef.slice(5);
          tokens.push(h("a", {
            key: `att-${key++}`,
            href: graphUrl("/api/dsh-graph/attachment?name=" + encodeURIComponent(attName)),
            target: "_blank",
            rel: "noopener noreferrer",
            title: dgT("common.open"),
            style: { color: "var(--dsw-alias-label-link, #4c8dff)", textDecoration: "underline" }
          }, attRef));
        } else if (linkText !== undefined && linkUrl !== undefined) {
          const safeUrl = /^(https?:|\/|\.\/|\.\.\/)/i.test(linkUrl.trim()) ? linkUrl.trim() : "#";
          tokens.push(h("a", {
            key: `a-${key++}`,
            href: safeUrl,
            target: "_blank",
            rel: "noopener noreferrer",
            style: { color: "var(--dsw-alias-label-link, #4c8dff)", textDecoration: "underline" }
          }, linkText));
        }
        lastIndex = regex.lastIndex;
      }
      if (lastIndex < text.length) {
        tokens.push(text.slice(lastIndex));
      }
      return tokens.length === 1 && typeof tokens[0] === "string" ? tokens[0] : tokens;
    }

    // g-270：轻量 Markdown 块级解析器（标题、列表、代码块、引用、段落）
    function renderSimpleMarkdown(rawText) {
      if (!rawText) return null;
      const lines = rawText.split("\n");
      const elements = [];
      let key = 0;
      let i = 0;

      while (i < lines.length) {
        const line = lines[i];

        // 1. 代码块 ``` 或 ~~~
        const fenceMatch = /^([ \t]*)(`{3,}|~{3,})(\w*)/.exec(line);
        if (fenceMatch) {
          const fence = fenceMatch[2];
          const codeLines = [];
          i++;
          while (i < lines.length) {
            if (lines[i].trimStart().startsWith(fence)) {
              i++;
              break;
            }
            codeLines.push(lines[i]);
            i++;
          }
          elements.push(
            h("pre", {
              key: `pre-${key++}`,
              style: {
                background: "var(--dsw-alias-fill-tsp-secondary, rgba(128,128,128,.12))",
                padding: "8px 12px",
                borderRadius: 6,
                fontSize: 11,
                fontFamily: "var(--ds-font-family-code, monospace)",
                overflowX: "auto",
                margin: "6px 0",
                whiteSpace: "pre-wrap",
                lineHeight: 1.4,
              }
            }, h("code", null, codeLines.join("\n")))
          );
          continue;
        }

        // 2. 标题（# 至 ######）
        const headingMatch = /^([ \t]{0,3})(#{1,6})[ \t]+(.*)$/.exec(line);
        if (headingMatch) {
          const level = headingMatch[2].length;
          const headingContent = headingMatch[3].trim();
          const fontSize = level === 1 ? 15 : level === 2 ? 14 : level === 3 ? 13 : 12;
          elements.push(
            h("div", {
              key: `h-${key++}`,
              style: {
                fontWeight: 600,
                fontSize,
                margin: "8px 0 4px",
                color: "var(--dsw-alias-label-primary, inherit)",
              }
            }, parseInlineMarkdown(headingContent))
          );
          i++;
          continue;
        }

        // 3. 无序列表（- / * / +）
        const ulMatch = /^([ \t]{0,3})[-*+][ \t]+(.*)$/.exec(line);
        if (ulMatch) {
          const items = [];
          while (i < lines.length) {
            const m = /^([ \t]{0,3})[-*+][ \t]+(.*)$/.exec(lines[i]);
            if (!m) break;
            items.push(m[2]);
            i++;
          }
          elements.push(
            h("ul", {
              key: `ul-${key++}`,
              style: { margin: "4px 0", paddingLeft: 20, listStyleType: "disc" }
            }, items.map((item, idx) => h("li", { key: `li-${idx}`, style: { margin: "2px 0" } }, parseInlineMarkdown(item))))
          );
          continue;
        }

        // 4. 有序列表（1. 2. 等）
        const olMatch = /^([ \t]{0,3})\d+\.[ \t]+(.*)$/.exec(line);
        if (olMatch) {
          const items = [];
          while (i < lines.length) {
            const m = /^([ \t]{0,3})\d+\.[ \t]+(.*)$/.exec(lines[i]);
            if (!m) break;
            items.push(m[2]);
            i++;
          }
          elements.push(
            h("ol", {
              key: `ol-${key++}`,
              style: { margin: "4px 0", paddingLeft: 22, listStyleType: "decimal" }
            }, items.map((item, idx) => h("li", { key: `li-${idx}`, style: { margin: "2px 0" } }, parseInlineMarkdown(item))))
          );
          continue;
        }

        // 5. 引用块（>）
        const bqMatch = /^([ \t]{0,3})>[ \t]?(.*)$/.exec(line);
        if (bqMatch) {
          const quoteLines = [];
          while (i < lines.length) {
            const m = /^([ \t]{0,3})>[ \t]?(.*)$/.exec(lines[i]);
            if (!m) break;
            quoteLines.push(m[2]);
            i++;
          }
          elements.push(
            h("blockquote", {
              key: `bq-${key++}`,
              style: {
                borderLeft: "3px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))",
                margin: "4px 0",
                paddingLeft: 8,
                opacity: 0.85,
              }
            }, parseInlineMarkdown(quoteLines.join(" ")))
          );
          continue;
        }

        // 6. 空行
        if (line.trim() === "") {
          i++;
          continue;
        }

        // 7. 段落
        const pLines = [line];
        i++;
        while (i < lines.length) {
          const next = lines[i];
          if (
            next.trim() === "" ||
            /^([ \t]*)(`{3,}|~{3,})/.test(next) ||
            /^([ \t]{0,3})#{1,6}[ \t]+/.test(next) ||
            /^([ \t]{0,3})[-*+][ \t]+/.test(next) ||
            /^([ \t]{0,3})\d+\.[ \t]+/.test(next) ||
            /^([ \t]{0,3})>[ \t]?/.test(next)
          ) {
            break;
          }
          pLines.push(next);
          i++;
        }
        elements.push(
          h("p", {
            key: `p-${key++}`,
            style: { margin: "4px 0", whiteSpace: "pre-wrap" }
          }, parseInlineMarkdown(pLines.join("\n")))
        );
      }

      return elements;
    }

    // g-270：Markdown 渲染错误边界组件，防止 MarkdownText 原语在异常内容时崩溃卸载整页
    class MarkdownErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { hasError: false };
      }
      static getDerivedStateFromError() {
        return { hasError: true };
      }
      componentDidCatch(err) {
        console.warn("[dsh-graph] MarkdownText failed, fallback to simple markdown:", err);
      }
      render() {
        if (this.state.hasError) {
          const fallbackFn = this.props.fallback || renderSimpleMarkdown;
          return fallbackFn(this.props.text);
        }
        return this.props.children;
      }
    }

    // g-270 / g-275：Markdown 模式切换按键样式（未选中项透明边框+透明底色，选中项 primary 边框+底色+加粗）
    function markdownSegStyle(active) {
      return {
        ...S.btn,
        fontSize: 11,
        padding: "1px 6px",
        background: active ? S.btn.background : "transparent",
        borderColor: active ? "var(--dsw-alias-state-business-primary, rgba(76,141,255,.55))" : "transparent",
        opacity: active ? 1 : 0.6,
        fontWeight: active ? 600 : 400,
      };
    }
    const segStyle = markdownSegStyle;

    // g-275：Markdown 视图切换控件（阅读模式 / Markdown原文），供目标描述与卡片抽屉复用
    function MarkdownViewToggle(props) {
      const {
        viewMode,
        onChange,
        className = "dg-desc-view-toggle",
        tipMarkdown = dgT("description.viewMarkdownTip"),
        tipRaw = dgT("description.viewRawTip"),
      } = props;
      return h("div", { className, style: { display: "inline-flex", gap: 4 } },
        h("button", {
          className: "dg-btn",
          style: markdownSegStyle(viewMode === "markdown"),
          title: tipMarkdown,
          onClick: () => onChange?.("markdown"),
        }, dgT("description.viewMarkdown")),
        h("button", {
          className: "dg-btn",
          style: markdownSegStyle(viewMode === "raw"),
          title: tipRaw,
          onClick: () => onChange?.("raw"),
        }, dgT("description.viewRaw"))
      );
    }

    // g-270 / g-275：Markdown 展示组件（优先 DSH 官方 MarkdownText 并传递完备 props，降级内置解析器）
    // 支持 viewMode="markdown"（默认阅读模式渲染）与 viewMode="raw"（原文态），统一容器与底纹样式
    function GoalMarkdown(props) {
      const { text, viewMode = "markdown", className = "", style = {} } = props;
      if (!text) return null;

      // 组装 DSH MarkdownText 必需的 labels 与 streaming 等 props（避免 Lg 在非空代码块读 copyLabel 崩溃）
      const markdownLabels = React.useMemo(() => ({
        code: {
          copyLabel: dgT("markdown.copy") || "Copy",
          copiedLabel: dgT("markdown.copied") || "Copied",
        },
        footnotes: dgT("markdown.footnotes") || "Footnotes",
      }), []);

      const isRaw = viewMode === "raw";
      const content = isRaw
        ? text
        : (MarkdownText
            ? h(MarkdownErrorBoundary, { text, fallback: renderSimpleMarkdown },
                h(MarkdownText, {
                  text,
                  streaming: false,
                  labels: markdownLabels,
                })
              )
            : renderSimpleMarkdown(text));

      const classes = ["dg-markdown-body", "dg-description-preview", className].filter(Boolean).join(" ");

      return h("div", {
        className: classes,
        style: {
          whiteSpace: isRaw ? "pre-wrap" : "normal",
          fontSize: 12,
          lineHeight: 1.6,
          overflowWrap: "anywhere",
          wordBreak: "break-word",
          color: "var(--dsw-alias-label-primary, inherit)",
          ...style,
        }
      }, content);
    }

    const MarkdownViewer = GoalMarkdown;

// >>>ESM-EXPORTS-START>>> (build script strips this block for browser bundle)
export {
  parseInlineMarkdown,
  renderSimpleMarkdown,
  MarkdownErrorBoundary,
  GoalMarkdown,
  MarkdownViewer,
  markdownSegStyle,
  segStyle,
  MarkdownViewToggle,
};
// <<<ESM-EXPORTS-END<<<
