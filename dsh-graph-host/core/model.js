/**
 * 目标文件的解析与写回：Markdown 正文 + JSON frontmatter。
 * frontmatter 采用 JSON（YAML 的子集），Node 标准库直接可解析（R-01 零依赖）。
 */
// g-158：四种固定类型、默认 task、非法值回退 task
export const GOAL_TYPES = ["feature", "bug", "task", "improvement"];
export const DEFAULT_GOAL_TYPE = "task";
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
/** 提取 `## <name>` 小节到下一 `## ` 之间的原文（不含标题行）；不存在返回 null。 */
export function sectionText(body, name) {
    const lines = body.split("\n");
    const head = `## ${name}`;
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === head) {
            start = i;
            break;
        }
    }
    if (start < 0)
        return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].startsWith("## ")) {
            end = i;
            break;
        }
    }
    return lines.slice(start + 1, end).join("\n");
}
/** 替换 `## <name>` 小节内容（保留标题行与其余小节）。 */
export function replaceSection(body, name, content) {
    const lines = body.split("\n");
    const head = `## ${name}`;
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === head) {
            start = i;
            break;
        }
    }
    if (start < 0)
        throw new Error(`小节不存在：${head}`);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].startsWith("## ")) {
            end = i;
            break;
        }
    }
    const next = [...lines.slice(0, start + 1), content, ...lines.slice(end)];
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
