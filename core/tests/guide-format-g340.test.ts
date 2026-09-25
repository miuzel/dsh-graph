/**
 * g-340：指南格式红线的机器断言（禁 `g-编号` / 禁「本次」/ 标题禁版本号）
 *
 * 为什么需要：这三条红线此前**零机器守护**——`scripts/archived/check_g20{5,6}.sh` 是各自
 * 目标的一次性验收脚本、基线即红，全量测试里也没有任何一条断言它们；而指南是本轮改动最
 * 频繁的文件（g-326/g-312/g-313 合计 +42 行），格式全靠文字纪律。与 g-312「把『改完必须
 * build』从文字纪律变成 dist 新鲜度断言」是同一模式的补漏。
 *
 * 断言打在**源文件**上（不引入 build 依赖）：dist 副本与源码的一致性已由
 * `core/tests/dist-freshness-g312.test.ts` 的逐字复制族覆盖。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "../..");

/** 指南的两个源文件；`side` 只用于失败信息里区分 zh/en。 */
const GUIDES = [
  { side: "zh", file: "dsh-graph-host/supervisor-guide.zh.md" },
  { side: "en", file: "dsh-graph-host/supervisor-guide.en.md" },
] as const;

/** 三条格式红线：`g-<数字>` 编号（占位符 `g-XXX` 不算违规）、「本次」、2–4 级标题行含版本号。 */
const RULES = [
  { name: "禁 g-编号", pattern: /\bg-\d+\b/ },
  { name: "禁「本次」", pattern: /本次/ },
  { name: "标题禁版本号", pattern: /^#{2,4} .*\bv?\d+\.\d+(?:\.\d+)?\b/ },
] as const;

/** 逐行匹配三条红线，返回 `<文件>:<行号> [<侧别>] <规则名>：<违规行>`；空数组即全部合规。 */
function collectViolations(text: string, file: string, side: string): string[] {
  const found: string[] = [];
  text.split("\n").forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        found.push(`${file}:${index + 1} [${side}] ${rule.name}：${line.trim()}`);
      }
    }
  });
  return found;
}

test("g-340：指南两源文件不含 g-编号 / 不出现「本次」/ 标题不含版本号", () => {
  const violations = GUIDES.flatMap(({ file, side }) => {
    const text = readFileSync(join(repoRoot, file), "utf8");
    // 非恒真护栏：文件必须真被读到、且真扫到了足够多的标题，否则「零违规」可能只是空扫。
    assert.ok(text.length > 4000, `${file} 内容过短（${text.length} 字符），扫描结果不可信`);
    assert.ok(
      text.split("\n").filter((line) => /^#{2,4} /.test(line)).length >= 10,
      `${file} 应至少有 10 条 ##/###/#### 标题，否则标题规则形同虚设`,
    );
    return collectViolations(text, file, side);
  });
  assert.deepEqual(violations, [], `指南格式红线违规（文件:行号 [侧别] 规则：违规行）：\n${violations.join("\n")}`);
});

test("g-340 负向对照：同一检查器对注入的违规行必须判红，且行号/侧别/规则名定位正确", () => {
  const injected = ["## 演进 v0.16.0", "主管在 g-340 复核时查实", "本次执行到此结束"].join("\n");
  const violations = collectViolations(injected, "fake/guide.md", "zh");
  assert.deepEqual(violations, [
    "fake/guide.md:1 [zh] 标题禁版本号：## 演进 v0.16.0",
    "fake/guide.md:2 [zh] 禁 g-编号：主管在 g-340 复核时查实",
    "fake/guide.md:3 [zh] 禁「本次」：本次执行到此结束",
  ]);
  // 反向护栏：同一检查器对干净文本零命中，证明上面的报红不是「永远报红」。
  assert.deepEqual(collectViolations("# 标题\n## 干净标题\n正文既无编号也无违禁词。", "fake/guide.md", "zh"), []);
});
