/**
 * 目标文件的解析与写回：Markdown 正文 + JSON frontmatter。
 * frontmatter 采用 JSON（YAML 的子集），Node 标准库直接可解析（R-01 零依赖）。
 */
// g-158/g-232：固定类型、默认 task、非法值回退 task
export const GOAL_TYPES = ["feature", "bug", "task", "improvement", "patch", "chore"];
export const DEFAULT_GOAL_TYPE = "task";
export const MAX_TAG_LEN = 32;
export const MAX_TAGS = 20;
/** 规范化并校验目标标签；返回稳定去重后的标签列表。 */
export function normalizeGoalTags(raw) {
    if (raw == null)
        return [];
    if (!Array.isArray(raw))
        throw new Error("标签必须是数组");
    if (raw.length > MAX_TAGS)
        throw new Error(`标签最多 ${MAX_TAGS} 个`);
    const out = [];
    for (const value of raw) {
        if (typeof value !== "string")
            throw new Error("标签必须是文本");
        const tag = value.trim();
        if (!tag)
            throw new Error("标签不能为空或仅包含空白");
        if ([...tag].length > MAX_TAG_LEN)
            throw new Error(`标签不能超过 ${MAX_TAG_LEN} 个字符`);
        if (/\p{Cc}/u.test(tag))
            throw new Error("标签不能包含控制字符");
        if (!out.includes(tag))
            out.push(tag);
    }
    return out;
}
/** 将任意值规范化为合法类型；非法/空值回退 task（不抛错）。 */
export function normalizeGoalType(raw) {
    const s = String(raw ?? "").trim().toLowerCase();
    if (GOAL_TYPES.includes(s))
        return s;
    return DEFAULT_GOAL_TYPE;
}
const DELIM = "---";
/** 解析 Markdown 文档：第一个 --- 与第二个 --- 之间为 JSON frontmatter。 */
export function parseDoc(text) {
    const lines = text.split("\n");
    if (lines.length === 0 || lines[0].trim() !== DELIM) {
        throw new Error("缺少 frontmatter 起始分隔符 ---");
    }
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === DELIM) {
            end = i;
            break;
        }
    }
    if (end < 0)
        throw new Error("缺少 frontmatter 结束分隔符 ---");
    const raw = lines.slice(1, end).join("\n");
    let meta;
    try {
        meta = JSON.parse(raw);
    }
    catch (e) {
        throw new Error(`frontmatter 不是合法 JSON：${e.message}`);
    }
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
        throw new Error("frontmatter 必须是 JSON 对象");
    }
    return { meta, body: lines.slice(end + 1).join("\n") };
}
/** 序列化：frontmatter 规范化重写，body 逐字节保留。 */
export function serializeDoc(doc) {
    return (DELIM +
        "\n" +
        JSON.stringify(doc.meta, null, 2) +
        "\n" +
        DELIM +
        "\n" +
        doc.body);
}
const FENCE_PATTERN = /^(`{3,}|~{3,})/;
/**
 * 计算文档中所有处于「有效闭合代码围栏」内的行。
 * 未闭合代码围栏（扫到 EOF 仍未遇到匹配闭合标记，或中途遇到新开围栏）不参与判定，
 * 退化为普通文本行，保证后续 ## 小节标题不被吞掉。
 */
export function computeClosedFenceMask(lines) {
    const mask = new Array(lines.length).fill(false);
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const match = line.trimStart().match(FENCE_PATTERN);
        if (match) {
            const fenceChar = match[1][0];
            const fenceLen = match[1].length;
            let closeIdx = -1;
            for (let j = i + 1; j < lines.length; j++) {
                const nextMatch = lines[j].trimStart().match(FENCE_PATTERN);
                if (nextMatch && nextMatch[1][0] === fenceChar && nextMatch[1].length >= fenceLen) {
                    const rest = lines[j].trimStart().slice(nextMatch[1].length).trim();
                    if (rest === "") {
                        closeIdx = j;
                        break;
                    }
                    else {
                        // 同字符同级别或更长的新开围栏（带 info string），说明前序围栏未闭合
                        break;
                    }
                }
            }
            if (closeIdx !== -1) {
                for (let k = i; k <= closeIdx; k++) {
                    mask[k] = true;
                }
                i = closeIdx + 1;
                continue;
            }
        }
        i++;
    }
    return mask;
}
/**
 * 定位 `## <name>` 小节的起止行区间。
 * 处于有效闭合围栏内的 `## ` 不被视作小节标题；未闭合围栏安全降级不影响小节切分。
 * 若小节不存在返回 null。
 */
export function findSectionBounds(body, name) {
    const lines = body.split("\n");
    const head = `## ${name}`;
    const mask = computeClosedFenceMask(lines);
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (!mask[i] && lines[i].trim() === head) {
            start = i;
            break;
        }
    }
    if (start < 0)
        return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (!mask[i] && lines[i].startsWith("## ")) {
            end = i;
            break;
        }
    }
    return { start, end, lines };
}
/** 提取 `## <name>` 小节到下一 `## ` 之间的原文（不含标题行）；不存在返回 null。
 *  代码围栏（``` 或 ~~~）内的 `## ` 标题不被误作为小节分隔符；未闭合围栏安全降级。 */
export function sectionText(body, name) {
    const bounds = findSectionBounds(body, name);
    if (!bounds)
        return null;
    return bounds.lines.slice(bounds.start + 1, bounds.end).join("\n");
}
/** 替换 `## <name>` 小节内容（保留标题行与其余小节）。
 *  代码围栏（``` 或 ~~~）内的 `## ` 标题不被误作为小节分隔符；未闭合围栏安全降级。 */
export function replaceSection(body, name, content) {
    const bounds = findSectionBounds(body, name);
    const head = `## ${name}`;
    if (!bounds)
        throw new Error(`小节不存在：${head}`);
    const next = [...bounds.lines.slice(0, bounds.start + 1), content, ...bounds.lines.slice(bounds.end)];
    return next.join("\n");
}
const CRITERIA_PLACEHOLDERS = new Set([
    "（待登记）",
    "（待登记；进入 in_progress 前必须非空且已确认）",
    "（待填写）",
]);
/** 判据小节是否有实质内容（去掉 HTML 注释和模板占位行）。 */
export function criteriaPresent(body) {
    return criteriaItems(body).length > 0;
}
/** 质量判据的稳定有序 key：与客户端 checklist 使用同一规范化行文本。 */
export function criteriaItems(body) {
    const t = sectionText(body, "质量判据");
    if (t === null)
        return [];
    const stripped = t.replace(/<!--[\s\S]*?-->/g, "");
    return stripped.split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && !CRITERIA_PLACEHOLDERS.has(l));
}
/** 判据小节的实质内容行数（去掉 HTML 注释后非空行；≥1 即视为已登记判据）。g-77647351 看板用。 */
export function countCriteria(body) {
    return criteriaItems(body).length;
}
/**
 * g-170：重写质量判据小节内容（不含 `## 质量判据` 标题行，与 sectionText 同构）。
 * 只替换「判据项行」（与 criteriaItems 同源定义：非空、非 HTML 注释、非模板占位行），
 * 其余内容——HTML 注释、空行——原样保留；有实质判据时模板占位行一并移除。
 * newItems 为空时仅删除判据项行（占位行保留，草稿清空后仍提示登记）。
 * 返回新小节内容。
 */
export function rebuildCriteriaSection(raw, newItems) {
    // 先屏蔽 HTML 注释（可跨行），避免注释内形似判据的行被误判
    const comments = [];
    let cIdx = 0;
    const masked = raw.replace(/<!--[\s\S]*?-->/g, (m) => {
        comments.push(m);
        return `\u0000DG_COMMENT_${cIdx++}\u0000`;
    });
    const lines = masked.split("\n");
    const isCommentSentinel = (t) => /^\u0000DG_COMMENT_\d+\u0000$/.test(t);
    const out = [];
    let inserted = false;
    for (const line of lines) {
        const trimmed = line.trim();
        const sentinel = isCommentSentinel(trimmed);
        // 判据项行：非注释、非空、非模板占位；有实质判据时占位行也一并删除（脚手架不再需要）
        const droppable = !sentinel && trimmed !== "" &&
            (newItems.length > 0 || !CRITERIA_PLACEHOLDERS.has(trimmed));
        if (droppable) {
            if (!inserted && newItems.length > 0) {
                newItems.forEach((it, i) => out.push(`${i + 1}. ${it}`));
                inserted = true;
            }
            continue; // 判据项行（及有实质判据时的占位行）不保留
        }
        out.push(line);
    }
    if (!inserted && newItems.length > 0) {
        // 没有既有判据项行（空节/纯注释/纯占位）：文末补空行后插入新列表
        if (out.length > 0 && out[out.length - 1] !== "")
            out.push("");
        newItems.forEach((it, i) => out.push(`${i + 1}. ${it}`));
    }
    let result = out.join("\n");
    for (let i = 0; i < comments.length; i++) {
        result = result.replace(`\u0000DG_COMMENT_${i}\u0000`, comments[i]);
    }
    return result;
}
