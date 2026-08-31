/** g-207：REST schema 严格校验测试——类型拒绝、隐式 coercion、未知字段、枚举/边界。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSchema,
  assertSchema,
  schemaErrorResponse,
  settingsPostSchema,
  transitionPostSchema,
  createGoalPostSchema,
  setCriteriaPostSchema,
  goalIdSchema,
  strictBooleanSchema,
  positiveIntegerSchema,
  SchemaError,
  type ObjectSchema,
} from "../schema.ts";

// ---- 基础类型校验 ----

test("validateSchema：合法对象通过", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      age: { type: "integer", minimum: 0 },
    },
    required: ["name"],
    additionalProperties: false,
  };
  const result = validateSchema({ name: "Alice", age: 30 }, schema);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("validateSchema：拒绝非对象（数组）", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
  const result = validateSchema([], schema);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "type");
});

test("validateSchema：拒绝未知字段", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: { name: { type: "string" } },
    additionalProperties: false,
  };
  const result = validateSchema({ name: "Alice", extra: "bad" }, schema);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "additionalProperties");
  assert.equal(result.errors[0].path, "extra");
});

test("validateSchema：必填字段缺失", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  };
  const result = validateSchema({}, schema);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "required");
  assert.equal(result.errors[0].path, "name");
});

// ---- 隐式 coercion 拒绝 ----

test("validateSchema：拒绝字符串形式的布尔值（\"false\" → boolean）", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: { active: strictBooleanSchema },
    additionalProperties: false,
  };
  const result = validateSchema({ active: "false" }, schema);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "coercion");
});

test("validateSchema：拒绝字符串形式的数字（\"42\" → number）", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: { count: { type: "number" } },
    additionalProperties: false,
  };
  const result = validateSchema({ count: "42" }, schema);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "coercion");
});

test("validateSchema：真正的布尔值通过", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: { active: strictBooleanSchema },
    additionalProperties: false,
  };
  const result = validateSchema({ active: false }, schema);
  assert.equal(result.valid, true);
});

// ---- 枚举校验 ----

test("validateSchema：枚举值匹配通过", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: { status: { type: "string", enum: ["draft", "ready"] } },
    additionalProperties: false,
  };
  const result = validateSchema({ status: "ready" }, schema);
  assert.equal(result.valid, true);
});

test("validateSchema：枚举值不匹配拒绝", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: { status: { type: "string", enum: ["draft", "ready"] } },
    additionalProperties: false,
  };
  const result = validateSchema({ status: "bogus" }, schema);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "enum");
});

// ---- 数值边界 ----

test("validateSchema：整数范围校验", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: { lanes: positiveIntegerSchema },
    additionalProperties: false,
  };
  assert.equal(validateSchema({ lanes: 1 }, schema).valid, true);
  assert.equal(validateSchema({ lanes: 0 }, schema).valid, false);
  assert.equal(validateSchema({ lanes: -1 }, schema).valid, false);
  assert.equal(validateSchema({ lanes: 3.5 }, schema).valid, false); // 非整数
});

// ---- null 处理 ----

test("validateSchema：nullable 字段允许 null", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: { name: { type: "string", nullable: true } },
    additionalProperties: false,
  };
  assert.equal(validateSchema({ name: null }, schema).valid, true);
});

test("validateSchema：非 nullable 字段拒绝 null", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: { name: { type: "string" } },
    additionalProperties: false,
  };
  const result = validateSchema({ name: null }, schema);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "type");
});

// ---- 嵌套对象 ----

test("validateSchema：嵌套对象递归校验", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: {
      executor: {
        type: "object",
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  };
  const result = validateSchema({ executor: { provider: "kimi", model: "k1", extra: "bad" } }, schema);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].path, "executor.extra");
});

// ---- 数组校验 ----

test("validateSchema：数组元素类型校验", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: {
      items: { type: "array", items: { type: "string", minLength: 1 } },
    },
    additionalProperties: false,
  };
  assert.equal(validateSchema({ items: ["a", "b"] }, schema).valid, true);
  const result = validateSchema({ items: ["a", ""] }, schema);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].path, "items[1]");
});

// ---- assertSchema 抛错 ----

test("assertSchema：合法值返回对象", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  };
  const result = assertSchema({ name: "test" }, schema);
  assert.equal(result.name, "test");
});

test("assertSchema：非法值抛 SchemaError", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  };
  assert.throws(() => assertSchema({}, schema), SchemaError);
});

// ---- schemaErrorResponse 不泄漏原始值 ----

test("schemaErrorResponse：不泄漏原始输入值", () => {
  const errors = [
    { path: "password", message: "太短", code: "minLength" },
    { path: "token", message: "无效", code: "type" },
  ];
  const resp = schemaErrorResponse(errors);
  assert.ok(!resp.error.includes("password"));
  assert.ok(!resp.error.includes("token"));
  assert.equal(resp.details.length, 2);
  assert.equal(resp.details[0].field, "password");
  assert.equal(resp.details[0].code, "minLength");
});

// ---- 预定义 schema 测试 ----

test("settingsPostSchema：合法 project.yaml patch 通过", () => {
  const patch = {
    executor: { provider: "kimi", model: "k1" },
    defaults: {
      review: { reviewer: "human" },
      pk: { lanes: 2 },
    },
    supervisor: {
      automation: {
        scope_planning: null,
        integration_decision: "human",
        rework: "",
        memory_promotion: "ai",
      },
    },
  };
  const result = validateSchema(patch, settingsPostSchema);
  assert.equal(result.valid, true);
});

test("settingsPostSchema：未知顶层字段拒绝", () => {
  const patch = {
    executor: { provider: "kimi" },
    unknown_field: "bad",
  };
  const result = validateSchema(patch, settingsPostSchema);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "additionalProperties");
});

test("settingsPostSchema：未知嵌套字段拒绝", () => {
  const patch = {
    executor: { provider: "kimi", bad_key: "x" },
  };
  const result = validateSchema(patch, settingsPostSchema);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].path, "executor.bad_key");
});

test("settingsPostSchema：automation 非法枚举值拒绝", () => {
  const patch = {
    supervisor: {
      automation: { release: "robot" },
    },
  };
  const result = validateSchema(patch, settingsPostSchema);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "enum");
});

test("settingsPostSchema：lanes 为字符串拒绝（隐式 coercion）", () => {
  const patch = {
    defaults: {
      pk: { lanes: "2" },
    },
  };
  const result = validateSchema(patch, settingsPostSchema);
  assert.equal(result.valid, false);
  // "2" 是字符串，integer 期望整数 → 触发 coercion 错误
  assert.ok(result.errors.some((e) => e.code === "coercion" || e.code === "type"));
});

test("settingsPostSchema：lanes 为 0 拒绝（minimum）", () => {
  const patch = {
    defaults: {
      pk: { lanes: 0 },
    },
  };
  const result = validateSchema(patch, settingsPostSchema);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "minimum");
});

test("settingsPostSchema：null 值允许（nullable 字段）", () => {
  const patch = {
    executor: { provider: null, model: null },
  };
  const result = validateSchema(patch, settingsPostSchema);
  assert.equal(result.valid, true);
});

test("transitionPostSchema：合法 transition 请求通过", () => {
  const result = validateSchema({ goal: "g-001", to: "in_progress", force: true }, transitionPostSchema);
  assert.equal(result.valid, true);
});

test("transitionPostSchema：缺少必填字段拒绝", () => {
  const result = validateSchema({ to: "in_progress" }, transitionPostSchema);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "required" && e.path === "goal"));
});

test("createGoalPostSchema：合法创建目标请求通过", () => {
  const result = validateSchema({ title: "测试", version: "v1.0", type: "feature" }, createGoalPostSchema);
  assert.equal(result.valid, true);
});

test("createGoalPostSchema：非法 type 枚举拒绝", () => {
  const result = validateSchema({ title: "测试", type: "bogus" }, createGoalPostSchema);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, "enum");
});

test("setCriteriaPostSchema：合法判据请求通过", () => {
  const result = validateSchema({ goal: "g-001", items: ["判据1", "判据2"] }, setCriteriaPostSchema);
  assert.equal(result.valid, true);
});

test("setCriteriaPostSchema：items 含空字符串拒绝", () => {
  const result = validateSchema({ goal: "g-001", items: ["判据1", ""] }, setCriteriaPostSchema);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].path, "items[1]");
});

// ---- 综合：多个错误同时报告 ----

test("validateSchema：同时报告多个错误", () => {
  const schema: ObjectSchema = {
    type: "object",
    properties: {
      a: { type: "string", minLength: 5 },
      b: { type: "integer", minimum: 10 },
      c: { type: "string", enum: ["x", "y"] },
    },
    required: ["a", "b", "c"],
    additionalProperties: false,
  };
  const result = validateSchema({ a: "hi", b: 5, c: "z", d: "extra" }, schema);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 4); // a太短, b太小, c枚举错, d未知字段
  const codes = new Set(result.errors.map((e) => e.code));
  assert.ok(codes.has("minLength"));
  assert.ok(codes.has("minimum"));
  assert.ok(codes.has("enum"));
  assert.ok(codes.has("additionalProperties"));
});
