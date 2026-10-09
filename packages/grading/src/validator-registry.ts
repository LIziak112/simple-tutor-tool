import {
  type Question,
  questionCapabilityBindings,
  type StudentAnswer,
} from "@tutor/contract";
import { judgeOf } from "./normalize.ts";
import { equivalent } from "./rational.ts";

/**
 * 服务端校验器注册表（T7.5，方案 §4.3「题型与校验器的桥接」）：
 * 按契约题型表（questionCapabilityBindings）的 validatorId 登记纯函数，
 * grade() 经题型表查找后执行；rubric / unverifiable 形态在 grade 侧直接
 * 返回 null（人工批改），exact 才进入此处登记的校验器。
 *
 * 纪律（清单边界）：不增加 reason 载荷、部分得分、自动步骤判分、题目级
 * 判分策略或学生校验 API；校验器为纯函数（无 IO、无异常出口）。
 *
 * 内置登记在模块加载期完成（与 contract/directives.ts 注册表同款模式）；
 * 机制 API（registerValidator 等）不进包桶导出，测试直连本文件使用。
 */

/** 校验器签名：接受教师侧完整题目（含 answers）与可缺省的学生答案（未作答） */
export type GradeValidator = (
  question: Question,
  answer?: StudentAnswer,
) => boolean | null;

const validators = new Map<string, GradeValidator>();

/** 登记一个校验器；validatorId 重复即抛错（注册冲突在登记期暴露） */
export function registerValidator(id: string, fn: GradeValidator): void {
  if (validators.has(id)) {
    throw new Error(`校验器 ${id} 重复注册：validatorId 必须唯一`);
  }
  validators.set(id, fn);
}

/** 按 validatorId 查找校验器；未登记返回 undefined（grade 侧兜底 null） */
export function getValidator(id: string): GradeValidator | undefined {
  return validators.get(id);
}

/** 已登记的 validatorId 清单（测试与完备性检查用） */
export function listValidatorIds(): string[] {
  return [...validators.keys()];
}

/**
 * 注册完备性检查（启动/测试期调用）：契约题型表引用的 validatorId 必须
 * 全部有服务端实现——缺失即注册遗漏（开发错误），不能让正常题静默换成
 * 另一种判分。服务器入口（apps/server/src/index.ts）启动时调用本函数；
 * 正常 grade 路径不调用它，继续保持无异常行为。
 */
export function assertValidatorCoverage(): void {
  const missing = Object.values(questionCapabilityBindings)
    .map((binding) => binding.validatorId)
    .filter((id) => !validators.has(id));
  if (missing.length > 0) {
    throw new Error(
      `契约题型表引用的校验器缺少服务端实现：${missing.join("、")}（注册遗漏，属开发错误）`,
    );
  }
}

// ---------- 七个内置校验器（自 grade.ts 迁入，判分算法一行未动） ----------
// 签名扩展为可缺省 answer：原 grade 的 unansweredCorrect 未作答分派吸收进
// 各校验器（客观题 false，fill/手写 null），grade 不再单独分派。

/** 判断题：学生答案归一化为布尔（旧版 judgeOf 写法全集；无法识别返回 null） */
function judgeValueOf(value: boolean | string): boolean | null {
  if (typeof value === "boolean") return value;
  const normalized = judgeOf(value);
  if (normalized === null) return null;
  return normalized === "正确";
}

/** 判断题校验器：answers.value 与学生布尔/写法归一结果比较；未作答 → false（D1） */
function gradeJudge(
  question: Question,
  answer?: StudentAnswer,
): boolean | null {
  if (answer === undefined) return false; // D1：未作答客观题判错（原 unansweredCorrect 迁入）
  const answers = question.answers;
  if (answers?.kind !== "judge" || answer.kind !== "judge") return null;
  const picked = judgeValueOf(answer.value);
  if (picked === null) return null; // 写法无法归一化 → 待批
  return picked === answers.value;
}

/** 单选题校验器：下标比较；越界（相对 options 数量）判 false 而非异常；未作答 → false（D1） */
function gradeChoice(
  question: Question,
  answer?: StudentAnswer,
): boolean | null {
  if (answer === undefined) return false; // D1：未作答客观题判错
  const answers = question.answers;
  if (answers?.kind !== "choice" || answer.kind !== "choice") return null;
  const optionCount = question.options?.length;
  if (optionCount !== undefined && answer.index >= optionCount) return false; // 索引越界
  return answer.index === answers.index;
}

/**
 * 多选题校验器：全对才 true（§5.6）；空选=未作答判 false（D1）、任一越界 false；
 * 未作答（answer 缺省）→ false（D1）。
 * TODO(T2.6+ 需要时)：部分得分配置位——漏选/多选按比例给分，本任务先保持全对制，
 * 预留 question 级 scoring 配置（partialCredit: "none" | "proportional"）接入点。
 */
function gradeMulti(
  question: Question,
  answer?: StudentAnswer,
): boolean | null {
  if (answer === undefined) return false; // D1：未作答客观题判错
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

/**
 * 填空题校验器：恒返回 null——fill 全人工批改（2026-10-02 产品决策，
 * 等价形式长尾误判风险的完整理由单点见 grade.ts 路由第 2 步）。
 * T7.5 起 fill 的 validation.shape=rubric，grade 在路由层即短路返回 null，
 * 本校验器经 grade 不可达——照常登记以维持「契约表引用全部有服务端实现」
 * 的完备性一致（两路同 null）。
 */
function gradeFill(
  _question: Question,
  _answer?: StudentAnswer,
): boolean | null {
  return null; // 2026-10-02：fill 全人工批改，待批队列/scoreAuto/状态机天然支持 null 路径
}

/**
 * 手写题（solve/apply/find-error）校验器：三题型共享同一实现（清单要求，
 * 不复制算法）；有最终答案且题目给了 :::answer 才自动判，否则 null 待批。
 * 未作答（answer 缺省，含只写笔迹未填最终答案）→ null。
 */
function gradeHandwritten(
  question: Question,
  answer?: StudentAnswer,
): boolean | null {
  if (answer === undefined) return null; // 未作答（含只写笔迹）→ 待批（原 unansweredCorrect 迁入）
  const answers = question.answers;
  if (answers?.kind !== "final" || answer.kind !== "final") return null;
  const finalAnswer = answer.finalAnswer.trim();
  if (finalAnswer.length === 0) return null; // 未填最终答案（只写笔迹）→ 待批（验收项）
  return equivalent(finalAnswer, answers.answer);
}

// 内置登记：validatorId 与契约题型表同名（judge/choice/multi/fill/solve/
// apply/find-error）；字面量书写，与契约的漂移由测试的集合相等断言拦截。
registerValidator("judge", gradeJudge);
registerValidator("choice", gradeChoice);
registerValidator("multi", gradeMulti);
registerValidator("fill", gradeFill);
registerValidator("solve", gradeHandwritten);
registerValidator("apply", gradeHandwritten);
registerValidator("find-error", gradeHandwritten);
