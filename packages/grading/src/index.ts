/**
 * 纯函数判分包（§5.6）：服务端交卷时权威执行，客户端结果不可信（AGENTS.md 硬性规则 4）。
 * 无 IO、无服务端依赖：依赖 @tutor/contract 的类型（Question / StudentAnswer）与
 * T7.4 题型能力表 questionCapabilityBindings（T7.5 起判分路由的数据源）。
 *
 * 组成：
 * - normalize/judgeOf：归一化（严格沿用旧版规则）与判断题写法归一；
 * - parseRational/equivalent：数值等价（0.5 = 1/2 = \frac{1}{2}）与答案等价比较；
 * - grade：各题型判分主入口 grade(question, answer) → true | false | null，
 *   经题型表 validation.shape 与 validatorId 路由（T7.5）；
 * - validator-registry：七个内置校验器（算法沿用既有实现）与注册完备性检查
 *   assertValidatorCoverage（服务器启动期调用，防注册遗漏静默换判分）。
 */
export { grade } from "./grade.ts";
export { judgeOf, normalize } from "./normalize.ts";
export type { Rational } from "./rational.ts";
export { equivalent, parseRational } from "./rational.ts";
export { assertValidatorCoverage } from "./validator-registry.ts";
