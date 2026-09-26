/**
 * 纯函数判分包（§5.6）：服务端交卷时权威执行，客户端结果不可信（AGENTS.md 硬性规则 4）。
 * 无 IO、无服务端依赖：只依赖 @tutor/contract 的类型（Question / StudentAnswer）。
 *
 * 组成：
 * - normalize/judgeOf：归一化（严格沿用旧版规则）与判断题写法归一；
 * - parseRational/equivalent：数值等价（0.5 = 1/2 = \frac{1}{2}）与答案等价比较；
 * - grade：各题型判分主入口 grade(question, answer) → true | false | null。
 */
export { grade } from "./grade.ts";
export { judgeOf, normalize } from "./normalize.ts";
export { equivalent, parseRational } from "./rational.ts";
export type { Rational } from "./rational.ts";
