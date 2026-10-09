import {
  type Question,
  questionCapabilityBindings,
  type StudentAnswer,
} from "@tutor/contract";
import { getValidator } from "./validator-registry.ts";

/**
 * 各题型判分主入口（§5.6；D1 口径 T3.2a 修订；2026-10-02 修订：fill 全人工批改；
 * T7.5 起经契约题型表路由，外部签名与输出不变）：
 * grade(question, answer) → true（对）| false（错）| null（不能自动判定）。
 *
 * 路由（T7.5，方案 §4.3）：
 * 1. 题目无标准答案（answers 缺省）→ null——**该判定优先级最高**，先于其余一切；
 * 2. 题型表 validation.shape 非 exact（rubric/unverifiable）→ null 恒人工
 *    （fill = rubric：2026-10-02 产品决策，数学答案等价形式长尾误判风险高，
 *    不自动判、交老师批改；无论答对、答错、部分空错还是未作答）；
 * 3. exact：按题型表 validatorId 查注册表执行既有校验器（judge/choice/multi/
 *    solve/apply/find-error，见 validator-registry.ts）；查不到 → null 兜底
 *    （正常路径无异常；完备性由 assertValidatorCoverage 在服务器启动与测试期保证，
 *    兜底语义 = 落人工待批，不换判分）。
 *
 * null 的语义（2026-10-02 之后共四种，全部进教师待批队列）：
 * 1. 题目侧 answers 缺省（解析不完整 / 手写题未给 :::answer）；
 * 2. 手写题（solve/apply/find-error）未能自动判：整题未作答（answer 缺省，
 *    含只写笔迹未填最终答案）或最终答案为空（空串/纯空白）；
 * 3. 判断题学生写法无法归一化（judgeOf 不识别）——教师裁定；
 * 4. 填空题（fill）一律 null（rubric 恒人工，见路由第 2 步）。
 *
 * 未作答客观题（judge/choice/multi 完全未作答 answer 缺省，或多选空选
 * indexes=[]）→ **false**（D1 用户定，T3.2a：未作答判错，不进待批队列，
 * scoreAuto 分母从此计入未作答客观题）——分派在注册表的各题型校验器内
 * 处理（validator-registry.ts，原 grade 的 unansweredCorrect 迁入）。
 * 原 D1 对 fill 的「未作答判错」口径于 2026-10-02 废止（fill 全人工，
 * 未作答亦进待批由老师裁量）；历史决策记录见 docs/技术架构与实施方案.md §5.6。
 *
 * 客观题判错（false）而非抛异常的边界：未作答（含多选空选）、choice 索引越界、
 * multi 部分选错/任一越界（fill 部分空错原在此列，2026-10-02 起改判 null）。
 * 纯函数：无 IO、无异常出口，任何输入形态错位返回 null。
 */

/**
 * 判分主函数（服务端交卷时执行，客户端结果不可信）。
 * @param question 教师侧完整题目（含 answers）
 * @param answer   学生答案（缺省=未作答：judge/choice/multi → false（D1）、
 *                 fill 与手写题 → null（2026-10-02 修订：fill 全人工批改））
 * @returns true 判对 / false 判错 / null 不能自动判定（进教师待批队列）
 */
export function grade(
  question: Question,
  answer?: StudentAnswer,
): boolean | null {
  if (question.answers === undefined) return null; // 题目无标准答案 → 不自动判分（优先级高于未作答判定）
  const binding = questionCapabilityBindings[question.type];
  if (binding.validation.shape !== "exact") return null; // rubric/unverifiable → 恒人工（fill）
  const validator = getValidator(binding.validatorId);
  if (validator === undefined) return null; // 注册遗漏兜底：不换判分、不抛异常（完备性由启动/测试期检查保证）
  return validator(question, answer);
}
