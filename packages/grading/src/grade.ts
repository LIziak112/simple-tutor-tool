import type { Question, StudentAnswer } from "@tutor/contract";
import { judgeOf } from "./normalize.ts";
import { equivalent } from "./rational.ts";

/**
 * 各题型判分主入口（§5.6；D1 口径 T3.2a 修订）：
 * grade(question, answer) → true（对）| false（错）| null（不能自动判定）。
 *
 * null 的语义（D1 之后仅三种，全部进教师待批队列）：
 * 1. 题目侧 answers 缺省（解析不完整 / 手写题未给 :::answer）——无标准答案
 *    不判分；**该判定优先级最高**，先于未作答判定（题目本身没答案时谈不上判错）；
 * 2. 手写题（solve/apply/find-error）未能自动判：整题未作答（answer 缺省，
 *    含只写笔迹未填最终答案）或最终答案为空（空串/纯空白）；
 * 3. 判断题学生写法无法归一化（judgeOf 不识别）——教师裁定。
 *
 * 未作答客观题（judge/choice/multi/fill 完全未作答 answer 缺省，或多选空选
 * indexes=[]）→ **false**（D1 用户定，T3.2a：未作答判错，不进待批队列，
 * scoreAuto 分母从此计入未作答客观题）。
 *
 * 客观题判错（false）而非抛异常的边界：未作答（含多选空选）、choice 索引越界、
 * multi 部分选错/任一越界、fill 部分空错。
 * 纯函数：无 IO、无异常出口，任何输入形态错位返回 null。
 */

/** 判断题：学生答案归一化为布尔（旧版 judgeOf 写法全集；无法识别返回 null） */
function judgeValueOf(value: boolean | string): boolean | null {
  if (typeof value === "boolean") return value;
  const normalized = judgeOf(value);
  if (normalized === null) return null;
  return normalized === "正确";
}

/** 判断题判分：answers.value 与学生布尔/写法归一结果比较 */
function gradeJudge(question: Question, answer: StudentAnswer): boolean | null {
  const answers = question.answers;
  if (answers?.kind !== "judge" || answer.kind !== "judge") return null;
  const picked = judgeValueOf(answer.value);
  if (picked === null) return null; // 写法无法归一化 → 待批
  return picked === answers.value;
}

/** 单选题判分：下标比较；越界（相对 options 数量）判 false 而非异常 */
function gradeChoice(
  question: Question,
  answer: StudentAnswer,
): boolean | null {
  const answers = question.answers;
  if (answers?.kind !== "choice" || answer.kind !== "choice") return null;
  const optionCount = question.options?.length;
  if (optionCount !== undefined && answer.index >= optionCount) return false; // 索引越界
  return answer.index === answers.index;
}

/**
 * 多选题判分：全对才 true（§5.6）。
 * TODO(T2.6+ 需要时)：部分得分配置位——漏选/多选按比例给分，本任务先保持全对制，
 * 预留 question 级 scoring 配置（partialCredit: "none" | "proportional"）接入点。
 */
function gradeMulti(question: Question, answer: StudentAnswer): boolean | null {
  const answers = question.answers;
  if (answers?.kind !== "multi" || answer.kind !== "multi") return null;
  if (answer.indexes.length === 0) return false; // D1：空选 = 未作答 → 判错（学生选后又全部取消即落此态）
  const optionCount = question.options?.length;
  if (
    optionCount !== undefined &&
    answer.indexes.some((i) => i >= optionCount)
  ) {
    return false; // 任一越界 → false
  }
  const expected = new Set(answers.indexes);
  // 集合相等：长度一致且学生所选项全部在正确集合内（学生答案无去重要求，按集合语义）
  const picked = new Set(answer.indexes);
  if (picked.size !== expected.size) return false;
  for (const index of picked) {
    if (!expected.has(index)) return false;
  }
  return true;
}

/** 填空题判分：逐空对等价答案列表（[[0.5|1/2]] 任一匹配即该空对），全部空对才 true */
function gradeFill(question: Question, answer: StudentAnswer): boolean | null {
  const answers = question.answers;
  if (answers?.kind !== "fill" || answer.kind !== "fill") return null;
  for (const [i, candidates] of answers.blanks.entries()) {
    // 学生答案比 blanks 短时缺失的空按空串（旧版 parts.length > i ? parts[i] : '' 口径）
    const value = answer.values[i] ?? "";
    const blankCorrect = candidates.some((candidate) =>
      equivalent(value, candidate),
    );
    if (!blankCorrect) return false; // 任一空错即整题 false（部分错误判错）
  }
  return true;
}

/** 手写题（solve/apply/find-error）判分：有最终答案且题目给了 :::answer 才自动判，否则 null 待批 */
function gradeHandwritten(
  question: Question,
  answer: StudentAnswer,
): boolean | null {
  const answers = question.answers;
  if (answers?.kind !== "final" || answer.kind !== "final") return null;
  const finalAnswer = answer.finalAnswer.trim();
  if (finalAnswer.length === 0) return null; // 未填最终答案（只写笔迹）→ 待批（验收项）
  return equivalent(finalAnswer, answers.answer);
}

/**
 * 客观题「未作答」的判分结果（D1，T3.2a）：judge/choice/multi/fill 未提交答案
 * 对象 → false（自动判错）；手写题未作答 → null（进待批，教师批改）。
 * 仅在题目**有**标准答案时被调用（无标准答案的判定优先，见 grade）。
 */
function unansweredCorrect(question: Question): boolean | null {
  switch (question.type) {
    case "judge":
    case "choice":
    case "multi":
    case "fill":
      return false; // D1：未作答客观题判错
    case "solve":
    case "apply":
    case "find-error":
      return null; // 手写题未作答（含只写笔迹）→ 待批
  }
}

/**
 * 判分主函数（服务端交卷时执行，客户端结果不可信）。
 * @param question 教师侧完整题目（含 answers）
 * @param answer   学生答案（缺省=未作答：客观题 false（D1）、手写题 null）
 * @returns true 判对 / false 判错 / null 不能自动判定（进教师待批队列）
 */
export function grade(
  question: Question,
  answer?: StudentAnswer,
): boolean | null {
  if (question.answers === undefined) return null; // 题目无标准答案 → 不自动判分（优先级高于未作答判定）
  if (answer === undefined) return unansweredCorrect(question); // D1：未作答按题型分派

  switch (question.type) {
    case "judge":
      return gradeJudge(question, answer);
    case "choice":
      return gradeChoice(question, answer);
    case "multi":
      return gradeMulti(question, answer);
    case "fill":
      return gradeFill(question, answer);
    case "solve":
    case "apply":
    case "find-error":
      return gradeHandwritten(question, answer);
  }
}
