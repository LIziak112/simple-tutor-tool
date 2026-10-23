import type {
  AnswerKind,
  PaperRole,
  QuestionType,
} from "@tutor/contract";
import { questionEvidenceBindings } from "@tutor/contract";

/**
 * 题型绑定（统一作答适配层方案 §4.1，UA-02 落地）：web 内部穷尽映射
 * `questionBindings satisfies Record<QuestionType, QuestionBinding>`——题型 →
 * 答案 kind / 输入位置 placement / 纸面角色 paperRole 的唯一 UI 绑定，
 * 不另存 interactionKind 到每道题。
 *
 * 单源纪律：answerKind 与 paperRole 逐项从 contract `questionEvidenceBindings`
 * （跨端证据角色绑定）派生，**不复制字面量成第二真相**（一致性测试
 * question-binding.test.ts 锁死）；paperRole 不能从 answer kind 推导（§4.1：
 * 后续 response 是正文+正式手写并存）。placement 仅属 web（contract 不感知
 * UI），是本文件唯一的本地真相。TT-05 新题型枚举扩容时 Record 穷尽约束
 * 编译期强制补绑定。
 *
 * 纸面角色兼容入口 HANDWRITTEN_TYPES 仍在 attempt/answer-format（由 contract
 * HANDWRITTEN_QUESTION_TYPES 派生），与本表 paperRole 的一致性由测试锁死；
 * 四个消费现场的字面量替换属 UA-03。
 */

/** 输入位置（web UI 专属，§4.1 表 placement 列的枚举化） */
export type InputPlacement =
  /** 判断题：题干下方对/错按钮（题干尾部空标记替换为「（　）」） */
  | "judge-buttons"
  /** 单选：题干下方 radio 选项 */
  | "options-radio"
  /** 多选：题干下方 checkbox 选项 */
  | "options-checkbox"
  /** 填空：题干内联槽位（§8 槽位命名空间注入题干） */
  | "inline-slots"
  /** solve/apply/find-error：原 HandwrittenControls 的最终答案位置 */
  | "handwritten-final";

/** 单个题型的绑定项（answer kind / 输入位置 / 纸面角色） */
export interface QuestionBinding {
  readonly answerKind: AnswerKind;
  readonly placement: InputPlacement;
  readonly paperRole: PaperRole;
}

/** 七旧型穷尽绑定（§4.1 定稿表；response/matching/ordering 按 D2 在 TT-05 落地枚举后由编译期强制补键） */
export const questionBindings = {
  judge: {
    answerKind: questionEvidenceBindings.judge.answerKind,
    placement: "judge-buttons",
    paperRole: questionEvidenceBindings.judge.paperRole,
  },
  choice: {
    answerKind: questionEvidenceBindings.choice.answerKind,
    placement: "options-radio",
    paperRole: questionEvidenceBindings.choice.paperRole,
  },
  multi: {
    answerKind: questionEvidenceBindings.multi.answerKind,
    placement: "options-checkbox",
    paperRole: questionEvidenceBindings.multi.paperRole,
  },
  fill: {
    answerKind: questionEvidenceBindings.fill.answerKind,
    placement: "inline-slots",
    paperRole: questionEvidenceBindings.fill.paperRole,
  },
  solve: {
    answerKind: questionEvidenceBindings.solve.answerKind,
    placement: "handwritten-final",
    paperRole: questionEvidenceBindings.solve.paperRole,
  },
  apply: {
    answerKind: questionEvidenceBindings.apply.answerKind,
    placement: "handwritten-final",
    paperRole: questionEvidenceBindings.apply.paperRole,
  },
  "find-error": {
    answerKind: questionEvidenceBindings["find-error"].answerKind,
    placement: "handwritten-final",
    paperRole: questionEvidenceBindings["find-error"].paperRole,
  },
} satisfies Record<QuestionType, QuestionBinding>;
