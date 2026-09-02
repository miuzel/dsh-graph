/**
 * g-207：REST schema 公共入口。
 *
 * 严格对象字段、additionalProperties 拒绝、枚举/boolean/null/数值边界校验，
 * 拒绝字符串 "false" 等隐式 coercion，统一稳定 4xx 错误映射，不泄漏 secret。
 *
 * 设计原则：
 * - 纯函数：不依赖外部状态，输入 → 校验结果。
 * - 可组合：各 endpoint 声明并复用 schema 定义。
 * - 稳定 4xx：校验失败统一返回 400，类型错误明确到字段路径。
 * - 安全：错误消息不泄漏原始输入值（尤其是可能含 secret 的字段）。
 */
import { GraphError } from "./machine.js";
/** Schema 校验错误。 */
export class SchemaError extends GraphError {
    path;
    code;
    constructor(message, path, code) {
        super(message);
        this.path = path;
        this.code = code;
    }
}
/** 严格校验入口：拒绝未知字段、拒绝隐式 coercion、检查所有边界。
 *  返回 ValidationResult（不抛错），调用方根据 valid 决定响应。 */
export function validateSchema(value, schema) {
    const errors = [];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        errors.push({ path: "", message: "必须是对象", code: "type" });
        return { valid: false, errors };
    }
    const obj = value;
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const allowAdditional = schema.additionalProperties ?? false;
    // 1. 检查未知字段（严格模式）
    if (!allowAdditional) {
        for (const key of Object.keys(obj)) {
            if (!(key in props)) {
                errors.push({ path: key, message: "未知字段", code: "additionalProperties" });
            }
        }
    }
    // 2. 检查必填字段
    for (const key of required) {
        if (!(key in obj) || obj[key] === undefined) {
            errors.push({ path: key, message: "必填字段缺失", code: "required" });
        }
    }
    // 3. 逐字段校验
    for (const [key, fieldSchema] of Object.entries(props)) {
        if (!(key in obj))
            continue; // 缺失已由 required 处理
        const v = obj[key];
        validateField(v, fieldSchema, key, errors);
    }
    return { valid: errors.length === 0, errors };
}
/** 校验并抛错（用于 core 层直接调用）。 */
export function assertSchema(value, schema) {
    const result = validateSchema(value, schema);
    if (!result.valid) {
        const first = result.errors[0];
        throw new SchemaError(`${first.path}: ${first.message}`, first.path, first.code);
    }
    return value;
}
/** 将校验结果转换为稳定 4xx 响应体（不泄漏原始值）。 */
export function schemaErrorResponse(errors) {
    return {
        error: `请求参数校验失败（${errors.length} 处）`,
        details: errors.map((e) => ({ field: e.path, code: e.code })),
    };
}
// ---- 内部实现 ----
function validateField(value, schema, path, errors) {
    // 处理 nullable
    const types = Array.isArray(schema.type)
        ? schema.type
        : [schema.type];
    const isNullable = schema.nullable || (schema.enum && schema.enum.includes(null));
    const allowedTypes = isNullable && !types.includes("null")
        ? [...types, "null"]
        : types;
    // null 值特殊处理
    if (value === null) {
        if (!allowedTypes.includes("null")) {
            errors.push({ path, message: `不能为 null（期望类型：${allowedTypes.join("|")}）`, code: "type" });
        }
        return;
    }
    // 确定实际类型
    const actualType = getActualType(value);
    // 类型校验（拒绝隐式 coercion）
    if (!allowedTypes.includes(actualType)) {
        // 特殊拒绝：字符串形式的布尔/数字
        if (actualType === "string" && allowedTypes.some((t) => t === "boolean" || t === "number" || t === "integer")) {
            errors.push({ path, message: `类型不匹配（拒绝字符串隐式转换："${String(value).slice(0, 20)}"）`, code: "coercion" });
            return;
        }
        errors.push({ path, message: `类型必须是 ${allowedTypes.join("|")}，实际为 ${actualType}`, code: "type" });
        return;
    }
    // 枚举校验
    if (schema.enum !== undefined && actualType !== "null") {
        // 枚举值必须精确匹配（含类型）
        const match = schema.enum.some((ev) => {
            if (typeof ev !== typeof value)
                return false;
            return ev === value;
        });
        if (!match) {
            errors.push({ path, message: `必须是允许值之一`, code: "enum" });
        }
    }
    // 字符串边界
    if (actualType === "string") {
        const s = value;
        if (schema.minLength !== undefined && s.length < schema.minLength) {
            errors.push({ path, message: `长度不能小于 ${schema.minLength}`, code: "minLength" });
        }
        if (schema.maxLength !== undefined && s.length > schema.maxLength) {
            errors.push({ path, message: `长度不能大于 ${schema.maxLength}`, code: "maxLength" });
        }
    }
    // 数值边界
    if (actualType === "number" || actualType === "integer") {
        const n = value;
        if (schema.minimum !== undefined && n < schema.minimum) {
            errors.push({ path, message: `不能小于 ${schema.minimum}`, code: "minimum" });
        }
        if (schema.maximum !== undefined && n > schema.maximum) {
            errors.push({ path, message: `不能大于 ${schema.maximum}`, code: "maximum" });
        }
        if (schema.multipleOf !== undefined && !Number.isInteger(n / schema.multipleOf)) {
            errors.push({ path, message: `必须是 ${schema.multipleOf} 的整数倍`, code: "multipleOf" });
        }
        if (actualType === "integer" && !Number.isInteger(n)) {
            errors.push({ path, message: `必须是整数`, code: "integer" });
        }
    }
    // 对象递归校验
    if (actualType === "object" && schema.properties) {
        const subSchema = {
            type: "object",
            properties: schema.properties,
            required: schema.required,
            additionalProperties: schema.additionalProperties ?? false,
        };
        const subResult = validateSchema(value, subSchema);
        for (const e of subResult.errors) {
            errors.push({ path: e.path ? `${path}.${e.path}` : path, message: e.message, code: e.code });
        }
    }
    // 数组元素校验
    if (actualType === "array" && schema.items) {
        const arr = value;
        for (let i = 0; i < arr.length; i++) {
            validateField(arr[i], schema.items, `${path}[${i}]`, errors);
        }
    }
}
function getActualType(value) {
    if (value === null)
        return "null";
    const t = typeof value;
    switch (t) {
        case "string": return "string";
        case "number": return Number.isInteger(value) ? "integer" : "number";
        case "boolean": return "boolean";
        case "object": return Array.isArray(value) ? "array" : "object";
        default: return "string"; // 不应到达
    }
}
// ---- 预定义 schema（供各 endpoint 复用） ----
/** goal ID：非空字符串。 */
export const goalIdSchema = { type: "string", minLength: 1, description: "目标 ID" };
/** 状态枚举。 */
export const statusSchema = {
    type: "string",
    enum: ["draft", "planning", "collecting", "ready", "in_progress", "review", "delivered", "blocked"],
    description: "目标状态",
};
/** 卡片类型枚举。 */
export const cardKindSchema = {
    type: "string",
    enum: ["text", "file", "image", "data"],
    description: "卡片类型",
};
/** 版本 slug：非空字符串，不含路径分隔符。 */
export const versionSlugSchema = {
    type: "string",
    minLength: 1,
    description: "版本标识",
};
/** 布尔值（严格，拒绝字符串）。 */
export const strictBooleanSchema = {
    type: "boolean",
    description: "布尔值",
};
/** 正整数（≥1）。 */
export const positiveIntegerSchema = {
    type: "integer",
    minimum: 1,
    description: "正整数",
};
/** 可空字符串。 */
export const nullableStringSchema = {
    type: "string",
    nullable: true,
    description: "可空字符串",
};
/** 字符串数组（元素为非空字符串）。 */
export const stringArraySchema = {
    type: "array",
    items: { type: "string", minLength: 1 },
    description: "字符串数组",
};
/** project.yaml 配置 patch schema（g-132 写配置端点用）。 */
export const projectConfigPatchSchema = {
    type: "object",
    properties: {
        executor: {
            type: "object",
            properties: {
                provider: { type: "string", nullable: true },
                model: { type: "string", nullable: true },
            },
            additionalProperties: false,
        },
        defaults: {
            type: "object",
            properties: {
                review: {
                    type: "object",
                    properties: {
                        reviewer: { type: "string", nullable: true },
                        prompt: { type: "string", nullable: true },
                    },
                    additionalProperties: false,
                },
                pk: {
                    type: "object",
                    properties: {
                        lanes: { type: "integer", nullable: true, minimum: 1 },
                        sandbox: { type: "string", nullable: true },
                    },
                    additionalProperties: false,
                },
            },
            additionalProperties: false,
        },
        supervisor: {
            type: "object",
            properties: {
                automation: {
                    type: "object",
                    properties: {
                        scope_planning: { type: "string", enum: ["human", "ai", ""], nullable: true },
                        integration_decision: { type: "string", enum: ["human", "ai", ""], nullable: true },
                        rework: { type: "string", enum: ["human", "ai", ""], nullable: true },
                        memory_promotion: { type: "string", enum: ["human", "ai", ""], nullable: true },
                        skill_proposal: { type: "string", enum: ["human", "ai", ""], nullable: true },
                        release: { type: "string", enum: ["human", "ai", ""], nullable: true },
                    },
                    additionalProperties: false,
                },
            },
            additionalProperties: false,
        },
        prompt_overrides: {
            type: "object",
            properties: {
                subagent: {
                    type: "object",
                    properties: {
                        state: { type: "string", enum: ["default", "override", "disable"] },
                        value: { type: "string", nullable: true },
                    },
                    additionalProperties: false,
                },
            },
            additionalProperties: false,
        },
    },
    additionalProperties: false,
};
/** /api/dsh-graph/settings POST body schema。 */
export const settingsPostSchema = projectConfigPatchSchema;
/** /api/dsh-graph/transition POST body schema。 */
export const transitionPostSchema = {
    type: "object",
    properties: {
        goal: goalIdSchema,
        to: statusSchema,
        reason: { type: "string", nullable: true },
        force: { type: "boolean", nullable: true },
    },
    required: ["goal", "to"],
    additionalProperties: false,
};
/** /api/dsh-graph/create-goal POST body schema。 */
export const createGoalPostSchema = {
    type: "object",
    properties: {
        title: { type: "string", minLength: 1 },
        version: { type: "string", nullable: true },
        description: { type: "string", nullable: true },
        type: { type: "string", enum: ["feature", "bug", "task", "improvement"], nullable: true },
    },
    required: ["title"],
    additionalProperties: false,
};
/** /api/dsh-graph/set-criteria POST body schema（g-170）。 */
export const setCriteriaPostSchema = {
    type: "object",
    properties: {
        goal: goalIdSchema,
        items: stringArraySchema,
        base_items: { type: "array", items: { type: "string" }, nullable: true },
        force: { type: "boolean", nullable: true },
    },
    required: ["goal", "items"],
    additionalProperties: false,
};
/** /api/dsh-graph/unbind POST body schema（g-190）。
 *  严格白名单：additionalProperties=false；selector 二选一（attempt | child_id）由 handler 校验；
 *  workspace/root 为 root 解析参数（与其余写端点一致）。 */
export const unbindPostSchema = {
    type: "object",
    properties: {
        goal: goalIdSchema,
        token: { type: "string", minLength: 1 },
        attempt: { type: "string", minLength: 1 },
        child_id: { type: "string", minLength: 1 },
        reason: { type: "string", nullable: true },
        workspace: { type: "string", nullable: true },
        root: { type: "string", nullable: true },
    },
    required: ["goal", "token"],
    additionalProperties: false,
};
