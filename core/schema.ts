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

import { GraphError } from "./machine.ts";

/** Schema 校验错误。 */
export class SchemaError extends GraphError {
  path: string;
  code: string;
  constructor(message: string, path: string, code: string) {
    super(message);
    this.path = path;
    this.code = code;
  }
}

/** 字段类型枚举。 */
export type SchemaType = "string" | "number" | "integer" | "boolean" | "null" | "object" | "array";

/** 字段 schema 定义。 */
export interface FieldSchema {
  type: SchemaType | SchemaType[];
  /** 枚举值（仅对 string/number 有效）。 */
  enum?: (string | number | boolean | null)[];
  /** 字符串最小长度。 */
  minLength?: number;
  /** 字符串最大长度。 */
  maxLength?: number;
  /** 字符串正则约束（JS 正则源，整体匹配 `^...$` 语义；不匹配即拒绝）。 */
  pattern?: string;
  /** 数值最小值（含）。 */
  minimum?: number;
  /** 数值最大值（含）。 */
  maximum?: number;
  /** 整数倍数校验。 */
  multipleOf?: number;
  /** 对象字段定义（type 含 object 时）。 */
  properties?: Record<string, FieldSchema>;
  /** 是否允许未知字段（默认 false = 严格模式）。 */
  additionalProperties?: boolean;
  /** 数组元素 schema（type 含 array 时）。 */
  items?: FieldSchema;
  /** 必填字段列表（对象时）。 */
  required?: string[];
  /** 默认值（仅用于文档，不自动填充）。 */
  default?: unknown;
  /** 字段描述（文档用）。 */
  description?: string;
  /** 是否可为 null（等价于 type: [T, "null"]）。 */
  nullable?: boolean;
}

/** 对象根 schema。 */
export interface ObjectSchema {
  type: "object";
  properties: Record<string, FieldSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

/** 校验结果。 */
export interface ValidationResult {
  valid: boolean;
  errors: Array<{ path: string; message: string; code: string }>;
}

/** 严格校验入口：拒绝未知字段、拒绝隐式 coercion、检查所有边界。
 *  返回 ValidationResult（不抛错），调用方根据 valid 决定响应。 */
export function validateSchema(value: unknown, schema: ObjectSchema): ValidationResult {
  const errors: Array<{ path: string; message: string; code: string }> = [];

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push({ path: "", message: "必须是对象", code: "type" });
    return { valid: false, errors };
  }

  const obj = value as Record<string, unknown>;
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
    if (!(key in obj)) continue; // 缺失已由 required 处理
    const v = obj[key];
    validateField(v, fieldSchema, key, errors);
  }

  return { valid: errors.length === 0, errors };
}

/** 校验并抛错（用于 core 层直接调用）。 */
export function assertSchema(value: unknown, schema: ObjectSchema): Record<string, unknown> {
  const result = validateSchema(value, schema);
  if (!result.valid) {
    const first = result.errors[0];
    throw new SchemaError(`${first.path}: ${first.message}`, first.path, first.code);
  }
  return value as Record<string, unknown>;
}

/** 将校验结果转换为稳定 4xx 响应体（不泄漏原始值）。 */
export function schemaErrorResponse(errors: Array<{ path: string; message: string; code: string }>): {
  error: string;
  details: Array<{ field: string; code: string }>;
} {
  return {
    error: `请求参数校验失败（${errors.length} 处）`,
    details: errors.map((e) => ({ field: e.path, code: e.code })),
  };
}

// ---- 内部实现 ----

function validateField(
  value: unknown,
  schema: FieldSchema,
  path: string,
  errors: Array<{ path: string; message: string; code: string }>,
): void {
  // 显式 undefined（非 JSON 来源的调用，如工具参数）按「缺失」处理：对象层的 required 已负责报错，
  // 继续走字符串分支会在 `s.length` 处抛 TypeError（getActualType 对 undefined 落入 default）。
  if (value === undefined) return;

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
      if (typeof ev !== typeof value) return false;
      return ev === value;
    });
    if (!match) {
      errors.push({ path, message: `必须是允许值之一`, code: "enum" });
    }
  }

  // 字符串边界
  if (actualType === "string") {
    const s = value as string;
    if (schema.minLength !== undefined && s.length < schema.minLength) {
      errors.push({ path, message: `长度不能小于 ${schema.minLength}`, code: "minLength" });
    }
    if (schema.maxLength !== undefined && s.length > schema.maxLength) {
      errors.push({ path, message: `长度不能大于 ${schema.maxLength}`, code: "maxLength" });
    }
    // g-404：正则约束——格式规则（如版本 slug）与字段 schema 同源，不再散落为各入口的手写检查
    if (schema.pattern !== undefined && !patternRegex(schema.pattern).test(s)) {
      errors.push({ path, message: `不符合格式要求（需匹配 ${schema.pattern}）`, code: "pattern" });
    }
  }

  // 数值边界
  if (actualType === "number" || actualType === "integer") {
    const n = value as number;
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
    const subSchema: ObjectSchema = {
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
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) {
      validateField(arr[i], schema.items, `${path}[${i}]`, errors);
    }
  }
}

function getActualType(value: unknown): SchemaType {
  if (value === null) return "null";
  const t = typeof value;
  switch (t) {
    case "string": return "string";
    case "number": return Number.isInteger(value) ? "integer" : "number";
    case "boolean": return "boolean";
    case "object": return Array.isArray(value) ? "array" : "object";
    default: return "string"; // 不应到达
  }
}

/** pattern 编译缓存（schema 为常量，避免每次校验重复构造 RegExp）。 */
const patternCache = new Map<string, RegExp>();
function patternRegex(src: string): RegExp {
  let re = patternCache.get(src);
  if (!re) {
    re = new RegExp(src);
    patternCache.set(src, re);
  }
  return re;
}

// ---- 预定义 schema（供各 endpoint 复用） ----

/** goal ID：非空字符串。 */
export const goalIdSchema: FieldSchema = { type: "string", minLength: 1, description: "目标 ID" };

/** 状态枚举。 */
export const statusSchema: FieldSchema = {
  type: "string",
  enum: ["draft", "planning", "collecting", "ready", "in_progress", "review", "delivered", "blocked"],
  description: "目标状态",
};

/** 卡片类型枚举。 */
export const cardKindSchema: FieldSchema = {
  type: "string",
  enum: ["text", "file", "image", "data"],
  description: "卡片类型",
};

/** 版本 slug 的**唯一规则**（单一真源）：非空，且不含路径分隔符 `/` 与反斜杠 `\`、
 *  单独的 `.`/`..` 段、绝对路径与空段（后两者均被分隔符规则覆盖）、控制字符（C0 与 DEL，含 NUL）。
 *  由 `validateField` 的 pattern 分支执行；运行时写入口经 `assertVersionSlug` 复用同一 schema，
 *  不再各写一套手检（g-404）。 */
export const VERSION_SLUG_PATTERN = "^(?!\\.{1,2}$)[^/\\\\\\u0000-\\u001F\\u007F]+$";

/** 版本 slug：非空字符串，不含路径分隔符/上跳段/控制字符。 */
export const versionSlugSchema: FieldSchema = {
  type: "string",
  minLength: 1,
  pattern: VERSION_SLUG_PATTERN,
  description: "版本标识（非空；不含路径分隔符、单独的 . 或 .. 段、绝对路径、空段、控制字符）",
};

/** 版本 slug 是否合法（**只读判定**，不抛错；与 assertVersionSlug / versionSlugSchema 同一规则）。
 *  供 validate 的只读诊断使用——诊断绝不能因历史非法数据而抛错中断整轮校验。 */
export function isVersionSlug(value: unknown): boolean {
  const probe: Record<string, unknown> = {};
  if (value !== undefined) probe.version = value;
  return validateSchema(probe, {
    type: "object",
    properties: { version: versionSlugSchema },
    required: ["version"],
    additionalProperties: false,
  }).valid;
}

/** 版本 slug 的运行时守卫（**复用 versionSlugSchema**，非第二套规则）。
 *  所有接收 version/slug 的写入口必须在产生任何副作用之前调用；非法即抛 GraphError（REST 面映射 400）。
 *  错误信息回显**磁盘上的实际 slug**（JSON 转义 ⇒ 控制字符/NUL 可见）与它会被拼出的路径。 */
export function assertVersionSlug(slug: unknown, field = "version"): string {
  // 只在确有值时才放入探针对象：`{ [field]: undefined }` 会落进 validateField 的字符串分支。
  const probe: Record<string, unknown> = {};
  if (slug !== undefined) probe[field] = slug;
  const result = validateSchema(probe, {
    type: "object",
    properties: { [field]: versionSlugSchema },
    required: [field],
    additionalProperties: false,
  });
  if (result.valid) return slug as string;
  const first = result.errors[0];
  const shown = typeof slug === "string" ? JSON.stringify(slug) : String(JSON.stringify(slug));
  const reason =
    first.code === "required" ? "不能为空或缺失"
    : first.code === "minLength" ? "不能为空"
    : first.code === "type" ? `必须是字符串（实际类型 ${slug === null ? "null" : typeof slug}）`
    : "含被禁止的字符或段（路径分隔符 / 或 \\、单独的 . 或 .. 段、绝对路径、空段、控制字符）";
  throw new GraphError(
    `非法版本 slug ${shown}：${reason}。该值会被拼进版本泳道路径 <board>/versions/<slug>` +
      `（必须严格落在 versions/ 内，当前已阻止任何写入）；请改用不含路径分隔符、上跳段与控制字符的名称`,
  );
}

/** 布尔值（严格，拒绝字符串）。 */
export const strictBooleanSchema: FieldSchema = {
  type: "boolean",
  description: "布尔值",
};

/** 正整数（≥1）。 */
export const positiveIntegerSchema: FieldSchema = {
  type: "integer",
  minimum: 1,
  description: "正整数",
};

/** 可空字符串。 */
export const nullableStringSchema: FieldSchema = {
  type: "string",
  nullable: true,
  description: "可空字符串",
};

/** 字符串数组（元素为非空字符串）。 */
export const stringArraySchema: FieldSchema = {
  type: "array",
  items: { type: "string", minLength: 1 },
  description: "字符串数组",
};

/** project.yaml 配置 patch schema（g-132 写配置端点用）。 */
export const projectConfigPatchSchema: ObjectSchema = {
  type: "object",
  properties: {
    executor: {
      type: "object",
      properties: {
        provider: { type: "string", nullable: true },
        model: { type: "string", nullable: true },
        mode: { type: "string", nullable: true },
        reasoning_effort: { type: "string", nullable: true },
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
    // g-311：顶层 review.policy（分级评审机制）。三值之外一律拒绝（含 "" 与大小写不符），
    // null 表示「未配置」→ 由 core/review-policy.ts 按目标类型派生。
    review: {
      type: "object",
      properties: {
        policy: { type: "string", enum: ["auto", "strict", "none"], nullable: true },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/** /api/dsh-graph/settings POST body schema。 */
export const settingsPostSchema: ObjectSchema = projectConfigPatchSchema;

/** /api/dsh-graph/transition POST body schema。 */
export const transitionPostSchema: ObjectSchema = {
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
export const createGoalPostSchema: ObjectSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1 },
    version: { type: "string", nullable: true },
    description: { type: "string", nullable: true },
    type: { type: "string", enum: ["feature", "bug", "task", "improvement", "patch", "chore"], nullable: true },
  },
  required: ["title"],
  additionalProperties: false,
};

/** /api/dsh-graph/set-criteria POST body schema（g-170）。 */
export const setCriteriaPostSchema: ObjectSchema = {
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

/** /api/dsh-graph/unbind POST body schema（g-190/g-282）。
 *  严格白名单：additionalProperties=false；selector 二选一（attempt | child_id）由 handler 校验；
 *  遗留绑定支持 legacy: true；workspace/root 为 root 解析参数（与其余写端点一致）。 */
export const unbindPostSchema: ObjectSchema = {
  type: "object",
  properties: {
    goal: goalIdSchema,
    token: { type: "string", minLength: 1, nullable: true },
    legacy: { type: "boolean", nullable: true },
    attempt: { type: "string", minLength: 1 },
    child_id: { type: "string", minLength: 1 },
    reason: { type: "string", nullable: true },
    workspace: { type: "string", nullable: true },
    root: { type: "string", nullable: true },
  },
  required: ["goal"],
  additionalProperties: false,
};

/** /api/dsh-graph/abandon-attempt POST body schema（g-282）。
 *  严格白名单：additionalProperties=false；goal + attempt + reason 为必填参数。 */
export const abandonAttemptPostSchema: ObjectSchema = {
  type: "object",
  properties: {
    goal: goalIdSchema,
    attempt: { type: "string", minLength: 1 },
    reason: { type: "string", minLength: 1 },
    workspace: { type: "string", nullable: true },
    root: { type: "string", nullable: true },
  },
  required: ["goal", "attempt", "reason"],
  additionalProperties: false,
};
