# 题型表 validatorId 无条件必填与死桩登记待办

来源：T7.5 质量闸门（/simplify 层级角度，2026-10-09）——有据跳过的根治项，记录于此备未来演进。

## 现状

- 契约 `questionCapabilityBindingsSchema`（packages/contract/src/capability.ts）对**全部**题型无条件必填 `validatorId`——包括 validation.shape=rubric 的 fill。
- 于是服务端注册表（packages/grading/src/validator-registry.ts）必须为 fill 登记一个**经 grade 不可达的死桩** `gradeFill`（grade 在路由层对非 exact 形态先行短路 null），「fill 恒人工」由 shape=rubric 路由与死桩体两处表达。
- 当时（T7.5，2026-10-09）不做根治的依据：Phase7 清单 T7.5 明文要求「提供 judge/choice/multi/fill/solve/apply/find-error **七个**内置登记项」（含 fill）；T7.4 契约表已合并 v2 推送冻结；两路同 null 无行为差异。

## 成本（未来显现）

- 每个未来非 exact（rubric/unverifiable）题型都要再写一个死桩登记。
- 若某题型 shape 翻回 exact 而死桩忘改实现（如 fill 翻回自动判分），注册表照常「完备」，无报错，**静默维持全人工**。现有防线：grade.test.ts 若同步补 exact 用例会立即暴露；但契约改 shape 时无机制强制提醒。

## 根治方向（触发条件：出现第二个非 exact 题型，或 fill 判分口径翻案时顺带）

契约侧 `questionCapabilityBindingSchema` 改 discriminated union：validation.shape=exact 才必填 validatorId，rubric/unverifiable 省略该字段；grading 侧 `assertValidatorCoverage` 与集合相等测试随之只对 exact 型核对实现。属契约 schema 收紧（移除非 exact 型的 validatorId 字段），需评估对 T7.6 capabilities.json 生成与既有消费方的兼容影响后独立小任务执行。
