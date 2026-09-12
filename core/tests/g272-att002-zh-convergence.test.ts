import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { init, createGoal, startAttempt, findGoalFile, resolveAccept } from "../ops.ts";
import { listWorktrees, cleanWorktree } from "../worktree.ts";

// g-272 att-002：worktree reason 稳定枚举 + 客户端 dgT 双语映射 + 全 client 模块硬编码中文收敛回归。

const hostRoot = join(import.meta.dirname, "../../dsh-graph-host");
const i18nSource = readFileSync(join(hostRoot, "lib/client/i18n.js"), "utf8");
const worktreeTs = readFileSync(join(import.meta.dirname, "../worktree.ts"), "utf8");
const worktreeJs = readFileSync(join(hostRoot, "core/worktree.js"), "utf8");

// 与 core/worktree.ts 及 goal-modal.js WORKTREE_REASON_ENUMS 同源的唯一清单。
const REASON_ENUMS = [
  "path_not_canonical_name", "branch_not_canonical_name", "path_branch_mismatch",
  "outside_canonical_worktrees", "reuse_suspected", "snapshot_drift", "missing_attempt_evidence",
  "not_delivered", "attempt_active", "worktree_dirty", "not_merged",
  "externally_removed", "user_cleaned",
  "confirm_required", "unknown_candidate", "protected", "git_unavailable",
  "git_worktree_list_unavailable", "live_record_drift", "realpath_unavailable",
  "realpath_escape", "state_changed",
];
// 主管复核点名要求逐字保留的中文 reason 文案（zh 映射必须与原中文句子一致）。
const LEGACY_ZH_REASONS = {
  not_delivered: "目标未交付",
  attempt_active: "attempt 活跃",
  externally_removed: "worktree 已从 Git 实时列表消失（外部删除）",
  user_cleaned: "已由用户清理",
  worktree_dirty: "工作树有未提交改动",
  confirm_required: "需要用户明确确认",
  unknown_candidate: "未知候选 id",
  protected: "候选受保护",
  git_unavailable: "Git 不可用",
  snapshot_drift: "登记后的 path/branch/HEAD 已漂移",
  missing_attempt_evidence: "缺少匹配的 attempt.md 证据",
  outside_canonical_worktrees: "路径不在 canonical workspace/.worktrees",
  not_merged: "HEAD 未由目标分支祖先链证明合入",
  state_changed: "目标或 attempt 状态已变化",
  path_branch_mismatch: "路径与分支的 goal/attempt 不一致",
  reuse_suspected: "路径/attempt 已有清理历史，疑似复用",
  path_not_canonical_name: "worktree 路径不是规范 goal-attempt 名称",
  branch_not_canonical_name: "worktree 分支不是规范 goal-attempt 名称",
  git_worktree_list_unavailable: "Git worktree 列表不可用",
  live_record_drift: "worktree 实时记录已漂移",
  realpath_unavailable: "worktree realpath 不可用",
  realpath_escape: "worktree realpath 越界或为符号链接",
};

function loadClientI18n() {
  const sandbox: any = { React: {} };
  vm.runInNewContext(i18nSource + "; this.zh = zh; this.en = en; this.createTranslator = createTranslator;", sandbox);
  return { zh: sandbox.zh, en: sandbox.en };
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-wt-enum-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "README"), "x");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  init(join(dir, ".dsh-graph"));
  return dir;
}
function setupGoalAttempt(dir: string, status: string, statusLine: string) {
  const root = join(dir, ".dsh-graph");
  const goal = createGoal(root, { title: "enum", version: "v-test", actor: "test" });
  const attempt = startAttempt(root, goal, { executor: "test", actor: "test" });
  const path = join(dir, ".worktrees", `${goal}-att-01`);
  execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-01`, path], { cwd: dir });
  const af = findGoalFile(root, goal).replace(/goal\.md$/, `attempts/${attempt}/attempt.md`);
  writeFileSync(af, readFileSync(af, "utf8").replace('"status_line": null', `"status_line": "${statusLine}"`));
  const gf = findGoalFile(root, goal);
  writeFileSync(gf, readFileSync(gf, "utf8").replace('"status": "planning"', `"status": "${status}"`));
  return { root, goal, attempt, path };
}

test("g-272 att-002: worktree 候选 reason 全部输出稳定枚举（无中文句）", () => {
  // 未交付 → not_delivered
  {
    const dir = repo(); const { root, goal } = setupGoalAttempt(dir, "review", "等待 review");
    const row = listWorktrees(root, goal)[0];
    assert.equal(row.reason, "not_delivered");
  }
  // 已交付但 attempt 活跃 → attempt_active
  {
    const dir = repo(); const { root, goal } = setupGoalAttempt(dir, "delivered", "正在执行测试");
    const row = listWorktrees(root, goal)[0];
    assert.equal(row.reason, "attempt_active");
  }
  // 已交付+静止+干净但未合入 → not_merged
  {
    const dir = repo(); const { root, goal, path } = setupGoalAttempt(dir, "delivered", "等待 review");
    writeFileSync(join(path, "new"), "x");
    execFileSync("git", ["add", "."], { cwd: path });
    execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "unmerged"], { cwd: path });
    const row = listWorktrees(root, goal)[0];
    assert.equal(row.status, "unknown"); assert.equal(row.reason, "not_merged");
  }
  // 外部删除 → externally_removed
  {
    const dir = repo(); const { root, goal, path } = setupGoalAttempt(dir, "review", "等待 review");
    resolveAccept(root, goal, { actor: "supervisor:test", verdict: "accept" });
    assert.equal(listWorktrees(root, goal)[0].status, "candidate");
    execFileSync("git", ["worktree", "remove", path], { cwd: dir });
    const row = listWorktrees(root, goal)[0];
    assert.equal(row.reason, "externally_removed");
  }
});

test("g-272 att-002: cleanWorktree 枚举判断回归（不再用 外部删除 字符串包含判断）", () => {
  // 源与编译产物均不得残留中文字符串包含判断；必须是枚举等值判断。
  assert.ok(!worktreeTs.includes('includes("外部删除")'), "core/worktree.ts 仍含 外部删除 字符串判断");
  assert.ok(!worktreeJs.includes('includes("外部删除")'), "dsh-graph-host/core/worktree.js 仍含 外部删除 字符串判断");
  assert.ok(worktreeTs.includes('c.reason === "externally_removed"'), "core/worktree.ts 缺少枚举判断");
  assert.ok(worktreeJs.includes('c.reason === "externally_removed"'), "dsh-graph-host/core/worktree.js 缺少枚举判断");

  const dir = repo(); const { root, goal, path } = setupGoalAttempt(dir, "review", "等待 review");
  resolveAccept(root, goal, { actor: "supervisor:test", verdict: "accept" });
  const candidate = listWorktrees(root, goal)[0];
  // 未确认 → confirm_required（枚举，不再中文）
  assert.equal(cleanWorktree(root, candidate.id, "human:test", false).reason, "confirm_required");
  // 外部删除后 clean → already_cleaned no-op（枚举判断路径）
  execFileSync("git", ["worktree", "remove", path], { cwd: dir });
  const external = listWorktrees(root, goal)[0];
  assert.equal(external.reason, "externally_removed");
  const res = cleanWorktree(root, external.id, "human:test", true);
  assert.equal(res.ok, true); assert.equal(res.reason, "already_cleaned");
  // 未知 id → unknown_candidate
  assert.equal(cleanWorktree(root, "nope", "human:test", true).reason, "unknown_candidate");
});

test("g-272 att-002: reason 枚举 → i18n 双语映射（zh 逐字保留、en 零 CJK、键对称）", () => {
  const { zh, en } = loadClientI18n();
  for (const e of REASON_ENUMS) {
    const key = `worktree.reason.${e}`;
    assert.ok(zh[key] !== undefined, `zh 缺少 ${key}`);
    assert.ok(en[key] !== undefined, `en 缺少 ${key}`);
    assert.doesNotMatch(String(en[key]), /[\u3400-\u9fff]/, `en ${key} 含 CJK: ${en[key]}`);
    if (LEGACY_ZH_REASONS[e]) assert.equal(zh[key], LEGACY_ZH_REASONS[e], `zh ${key} 未逐字保留原文案`);
  }
  // 本次新增的其他词条键对称 + en 零 CJK
  for (const key of ["exec.requestCopiedOpened", "exec.autocopyFailedRequest", "settings.readProfileFail", "settings.saveProfileFail", "goal.renameFail", "exec.acceptConfirm"]) {
    assert.ok(zh[key] !== undefined, `zh 缺少 ${key}`);
    assert.ok(en[key] !== undefined, `en 缺少 ${key}`);
    assert.doesNotMatch(String(en[key]), /[\u3400-\u9fff]/, `en ${key} 含 CJK`);
  }
});

// —— client 模块复扫：非注释代码中的 CJK 必须全部带 i18n-keep 标记（禁止静默遗留）——

const CLIENT_DIR = join(hostRoot, "lib/client");
// 从一行代码中剔除注释后的「代码部分」（够用的近似：先去 /* */ 块，再去非 : 后的 // 行注释）。
function codePart(line: string): string {
  let s = line.replace(/\/\*[\s\S]*?\*\//g, " ");
  s = s.replace(/(^|[^:"'`])\/\/.*$/, "$1");
  return s;
}
function cjkLines(file: string): { line: number; text: string }[] {
  const lines = readFileSync(file, "utf8").split("\n");
  let inBlock = false;
  const out: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i];
    if (inBlock) {
      const end = text.indexOf("*/");
      if (end === -1) continue;
      text = text.slice(end + 2); inBlock = false;
    }
    // 多行块注释起点（行内无结束的）
    const start = text.indexOf("/*");
    if (start !== -1 && text.indexOf("*/", start + 2) === -1) {
      const before = text.slice(0, start);
      if (/[\u3400-\u9fff]/.test(codePart(before))) out.push({ line: i + 1, text: lines[i].trim() });
      inBlock = true; continue;
    }
    const code = codePart(text);
    if (/[\u3400-\u9fff]/.test(code)) out.push({ line: i + 1, text: lines[i].trim() });
  }
  return out;
}

test("g-272 att-002: client 模块复扫——代码中残留 CJK 全部有 i18n-keep 标记（零静默遗留）", () => {
  const files = readdirSync(CLIENT_DIR).filter((f) => f.endsWith(".js") && f !== "i18n.js");
  const violations: string[] = [];
  let kept = 0;
  for (const f of files) {
    const path = join(CLIENT_DIR, f);
    const raw = readFileSync(path, "utf8").split("\n");
    for (const hit of cjkLines(path)) {
      // 允许条件：前 12 行内存在 i18n-keep 标记注释
      const from = Math.max(0, hit.line - 13);
      const window = raw.slice(from, hit.line).join("\n");
      if (/i18n-keep\(category-[ab]\)/.test(window)) { kept++; continue; }
      violations.push(`${f}:${hit.line}: ${hit.text.slice(0, 80)}`);
    }
  }
  assert.deepEqual(violations, [], `发现未标记的硬编码中文残留：\n${violations.join("\n")}`);
  assert.ok(kept > 0, "应存在带标记的保留项（提示词模板/遗留值匹配）");
});

test("g-272 att-002: 保留项锚点——提示词模板与遗留值匹配串必须存在且带标记", () => {
  const anchors: [string, string][] = [
    ["goal-actions.js", "【${props.goalId} 判据反馈】"],
    ["goal-actions.js", "【${goalId} 定义/润色请求】"],
    ["goal-actions.js", "【${goalId} 反馈】"],
    ["goal-actions.js", "【负责人交付复核请求】"],
    ["goal-actions.js", "空闲|完成|待命|已交付|结束|等待"],
    ["drag-prompts.js", "【${goalId} 回退理由】"],
    ["drag-prompts.js", "【重新执行】用户从看板拖放触发重新执行目标"],
    ["drag-prompts.js", "【交付通知】"],
    ["goal-modal.js", 'section(d.body, "目标描述")'],
    ["goal-modal.js", 'status === "正常"'],
    ["goal-modal.js", 'status === "已锁定"'],
    ["goal-modal.js", 'status === "已移除"'],
    ["goal-modal.js", "（待登记；进入 in_progress 前必须非空且已确认）"],
    ["helpers.js", "阻塞|blocked"],
    ["card.js", "空闲|完成|待命|已交付|结束|等待"],
  ];
  for (const [file, needle] of anchors) {
    const raw = readFileSync(join(CLIENT_DIR, file), "utf8");
    const idx = raw.indexOf(needle);
    assert.ok(idx !== -1, `${file} 缺少保留串: ${needle}`);
    const lineNo = raw.slice(0, idx).split("\n").length;
    const window = raw.split("\n").slice(Math.max(0, lineNo - 13), lineNo).join("\n");
    assert.ok(/i18n-keep\(category-[ab]\)/.test(window), `${file}:${lineNo} 保留串 ${needle} 附近缺少 i18n-keep 标记`);
  }
});

test("g-272 att-002: goal-modal.js worktree reason 走枚举映射函数", () => {
  const modal = readFileSync(join(CLIENT_DIR, "goal-modal.js"), "utf8");
  assert.ok(modal.includes("WORKTREE_REASON_ENUMS"), "goal-modal.js 缺少 WORKTREE_REASON_ENUMS 清单");
  assert.ok(modal.includes('dgT("worktree.reason." + reason)'), "goal-modal.js 缺少枚举→dgT 映射");
  // 原主管点名文案已接入 dgT（不再硬编码）
  for (const gone of ["⚠️ 接受失败：", "⚠️ 重命名失败：", "✅ 已派发执行子代理，id：", "确认接受目标「${goalId}」的交付成果？"]) {
    const src = file_for(gone);
    assert.ok(!src.includes(gone), `仍含硬编码文案: ${gone}`);
  }
  function file_for(s: string): string {
    if (s === "⚠️ 重命名失败：") return modal;
    return readFileSync(join(CLIENT_DIR, "goal-actions.js"), "utf8");
  }
});
