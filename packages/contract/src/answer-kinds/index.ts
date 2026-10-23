import type { StudentAnswer } from "../grading.ts";
import { choiceMultiBehavior } from "./choice.ts";
import { fillBehavior } from "./fill.ts";
import { finalBehavior } from "./final.ts";
import { judgeBehavior } from "./judge.ts";
import { multiBehavior } from "./multi.ts";
import type {
  AnswerKindBehaviorTable,
  AnswerTextProfile,
  OptionsPublicStructure,
  PublicStructureByKind,
} from "./types.ts";

/**
 * 纯行为登记表（方案 §10 文件设计·contract 侧）：五 kind 穷尽登记（I01）
 * 与唯一调度边界（§4.4 显式 switch + assertNever 收尾）。三口径行为逐字
 * 对齐迁移前的三个现网实现（answer-format / mark-response / student-ai-context），
 * 由 profiles.differential.test.ts 对旧实现副本做 I15 差分锁定。
 *
 * 分界约定（§4.3 定稿）：参考答案文本化唯一入口仍是 content.ts
 * formatQuestionAnswers，本登记表与它不得互相导入。
 */

export { choiceMultiBehavior } from "./choice.ts";
export { fillBehavior } from "./fill.ts";
export { finalBehavior } from "./final.ts";
export { judgeBehavior } from "./judge.ts";
export { multiBehavior } from "./multi.ts";
export * from "./types.ts";

/**
 * 生产登记表：五 kind 全配（satisfies 强制穷尽——漏 kind/错配签名编译失败，
 * I01 编译期证据）。choice/multi 两键引用同一份实现（见 ./multi.ts）。
 */
export const answerKindBehaviors = {
  judge: judgeBehavior,
  choice: choiceMultiBehavior,
  multi: multiBehavior,
  fill: fillBehavior,
  final: finalBehavior,
} satisfies AnswerKindBehaviorTable<StudentAnswer, PublicStructureByKind>;

/**
 * 无公开结构时的占位结构：display/teacher-queue 口径不读任何结构；
 * choice/multi 在 ai-context 口径下用它即等价旧实现「题面无 options」的
 * 字母兜底分支（选项缺失回落字母）。
 */
export const emptyPublicStructure: PublicStructureByKind = {
  judge: null,
  choice: { options: [] },
  multi: { options: [] },
  fill: { slots: [] },
  final: null,
};

/** 唯一调度边界收尾用（§4.4：允许中央 switch + assertNever，不追求零 switch） */
function assertNever(kind: never): never {
  throw new Error(`未登记的答案 kind：${String(kind)}`);
}

/**
 * 唯一调度边界（§4.4）：按 kind 显式 switch 窄化后调用登记表实现，
 * assertNever 收尾。新增 kind 在此增加穷尽分支（§11.1 触点清单）。
 * 调度边界以外，业务代码不得新增按 answer.kind 字面量的分支（I16）。
 */
export function dispatchBehavior(
  answer: StudentAnswer,
  profile: AnswerTextProfile,
  structures: PublicStructureByKind,
): string {
  const table: AnswerKindBehaviorTable<StudentAnswer, PublicStructureByKind> =
    answerKindBehaviors;
  switch (answer.kind) {
    case "judge":
      return table.judge.formatStudent(answer, profile, structures.judge);
    case "choice":
      return table.choice.formatStudent(answer, profile, structures.choice);
    case "multi":
      return table.multi.formatStudent(answer, profile, structures.multi);
    case "fill":
      return table.fill.formatStudent(answer, profile, structures.fill);
    case "final":
      return table.final.formatStudent(answer, profile, structures.final);
    default:
      return assertNever(answer);
  }
}

/** isAnswered 的调度边界（同款显式 switch；与 dispatchBehavior 同文件同纪律） */
export function dispatchIsAnswered(answer: StudentAnswer): boolean {
  const table: AnswerKindBehaviorTable<StudentAnswer, PublicStructureByKind> =
    answerKindBehaviors;
  switch (answer.kind) {
    case "judge":
      return table.judge.isAnswered(answer);
    case "choice":
      return table.choice.isAnswered(answer);
    case "multi":
      return table.multi.isAnswered(answer);
    case "fill":
      return table.fill.isAnswered(answer);
    case "final":
      return table.final.isAnswered(answer);
    default:
      return assertNever(answer);
  }
}

/**
 * 旧题选项文本数组 → 公开选项结构（§4.2：旧题选项 key 由序号派生 opt-0…，
 * 新结构可用稳定 optionId；答案格式不变仍存 index）。snapshot.options→
 * OptionsPublicStructure 的唯一构造入口，key 派生规则不散落各消费点。
 */
export function optionsPublicStructureOf(
  texts: readonly string[],
): OptionsPublicStructure {
  return {
    options: texts.map((text, index) => ({
      key: `opt-${index}`,
      index,
      text,
    })),
  };
}
