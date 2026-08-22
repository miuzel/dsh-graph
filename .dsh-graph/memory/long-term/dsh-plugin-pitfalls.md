---
{
  "id": "mem-002",
  "type": "failure-pattern",
  "source_goal": "g-101",
  "promoted_by": "supervisor",
  "promoted_at": "2026-08-20T22:20:00+08:00",
  "status": "active"
}
---

## DSH 插件开发反模式（v0.2 dogfood 实证）

1. **工具返回值绝不写 `undefined` 字段**——registry 输出校验要求无损 JSON，
   `undefined` 直接拒绝（发现#12）。构造返回对象时条件性添加字段；
2. **副作用先于输出校验是事故配方**——attempt 已创建、子 agent 已派发，模型却收到
   错误 → 重试 → 重复派发（发现#11）。要么先验证输出形态再执行副作用，要么在报错
   文案中明确"副作用已发生"；
3. **外部 API 的 spec 形态以类型定义（.d.ts）为准**，不要凭直觉平铺字段
   （startContinuable 的 parent 在 request 内，发现#10）；
4. **移动目录形态实体时必须整体移动**（cards/attempts 附件随目录走，发现#13）；
5. **`--help` 会吞掉插件加载失败**（loader 结算前 exit 0）——验证加载必须跑真实
   任务路径；
6. **热加载注册的工具不进既有会话的工具目录**（发现#8）——验证新工具要开新会话；
   插件源码变更可被 cordis HMR 热重载，无需重启 GUI。

## 成功模式补充

- 隔离 DSH_HOME + headless + `--patch` overlay = 不碰用户环境的插件验收台；
- 插件加载自测 marker 文件：在 apply 里写"注册了什么 + core validate 结果"，让验收
  脚本断言进程内真实状态；
- 新会话 dogfood 是检验"模型真实调用工具"的唯一可信路径。

## 发布认证：负责人用 2FA 设备验证，不用 OTP 参数（2026-08-22）

- 负责人发布 npm 用 **2FA 设备验证**（pnpm publish 不带 --otp，走交互式/设备验证；
  若提示 OTP 在终端输入 2FA 码）；unpublish 是敏感操作 npm 强制 2FA（仍需 OTP 参数或交互输入）；
- 不要再给负责人发带 `--otp=<码>` 占位的发布命令——用交互式 2FA 版本：
  `pnpm publish --registry=https://registry.npmjs.org --no-git-checks`；
- 相关：发布由负责人自执行（OTP/2FA 在负责人侧），supervisor 负责发布后核验 registry。
