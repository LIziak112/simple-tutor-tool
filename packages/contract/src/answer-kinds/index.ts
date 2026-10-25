import type { StudentAnswer } from "../grading.ts";
import { choiceMultiBehavior } from "./choice.ts";
import { fillBehavior } from "./fill.ts";
import { finalBehavior } from "./final.ts";
import { judgeBehavior } from "./judge.ts";
import { matchingBehavior } from "./matching.ts";
import { multiBehavior } from "./multi.ts";
import { orderingBehavior } from "./ordering.ts";
import { responseBehavior } from "./response.ts";
import type {
  AnswerKindBehaviorTable,
  AnswerTextProfile,
  MatchingPublicStructure,
  OptionsPublicStructure,
  OrderingPublicStructure,
  PublicStructureByKind,
  ShapeIssue,
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
export { matchingBehavior } from "./matching.ts";
export { multiBehavior } from "./multi.ts";
export { orderingBehavior } from "./ordering.ts";
export { countResponseWords, responseBehavior } from "./response.ts";
export * from "./types.ts";

/**
 * 生产登记表：八 kind 全配（satisfies 强制穷尽——漏 kind/错配签名编译失败，
 * I01 编译期证据）。choice/multi 两键引用同一份实现（见 ./multi.ts）；
 * response/matching/ordering 三键为 TT-05a 域②接入（§11.1 触点①纯层，
 * 呈现层留 TT-08）。
 */
export const answerKindBehaviors = {
  judge: judgeBehavior,
  choice: choiceMultiBehavior,
  multi: multiBehavior,
  fill: fillBehavior,
  final: finalBehavior,
  response: responseBehavior,
  matching: matchingBehavior,
  ordering: orderingBehavior,
} satisfies AnswerKindBehaviorTable<StudentAnswer, PublicStructureByKind>;

/**
 * 无公开结构时的占位结构：display/teacher-queue 口径不读任何结构；
 * choice/multi 在 ai-context 口径下用它即等价旧实现「题面无 options」的
 * 字母兜底分支（选项缺失回落字母）；matching/ordering 用空池即文本化回落
 * 裸 id（结构不可用时 inspectShape 不校验，见各行为注释）。
 */
export const emptyPublicStructure: PublicStructureByKind = {
  judge: null,
  choice: { options: [] },
  multi: { options: [] },
  fill: { slots: [] },
  final: null,
  response: null,
  matching: { options: [], slotIds: [], allowRepeat: false },
  ordering: { items: [] },
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
    case "response":
      return table.response.formatStudent(answer, profile, structures.response);
    case "matching":
      return table.matching.formatStudent(answer, profile, structures.matching);
    case "ordering":
      return table.ordering.formatStudent(answer, profile, structures.ordering);
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
    case "response":
      return table.response.isAnswered(answer);
    case "matching":
      return table.matching.isAnswered(answer);
    case "ordering":
      return table.ordering.isAnswered(answer);
    default:
      return assertNever(answer);
  }
}

/**
 * 结构形状检查的调度边界（QM-13 细项 4）：服务端保存路径（saveDraftAnswer）
 * 的结构校验唯一入口——按 kind 窄化后委托登记表 inspectShape。**只报告结构
 * 问题（未知引用/重复/越界/固定项错位），永不比对参考答案**；拦截与否由
 * 调用方裁决（保存路径对新题型非法结构整体拒绝，历史题面数据只读不改写）。
 * 与 dispatchBehavior/dispatchIsAnswered 同文件同纪律（§4.4 唯一调度边界）。
 */
export function inspectShapeOfAnswer(
  answer: StudentAnswer,
  structures: PublicStructureByKind,
): readonly ShapeIssue[] {
  const table: AnswerKindBehaviorTable<StudentAnswer, PublicStructureByKind> =
    answerKindBehaviors;
  switch (answer.kind) {
    case "judge":
      return table.judge.inspectShape(answer, structures.judge);
    case "choice":
      return table.choice.inspectShape(answer, structures.choice);
    case "multi":
      return table.multi.inspectShape(answer, structures.multi);
    case "fill":
      return table.fill.inspectShape(answer, structures.fill);
    case "final":
      return table.final.inspectShape(answer, structures.final);
    case "response":
      return table.response.inspectShape(answer, structures.response);
    case "matching":
      return table.matching.inspectShape(answer, structures.matching);
    case "ordering":
      return table.ordering.inspectShape(answer, structures.ordering);
    default:
      return assertNever(answer);
  }
}

/**
 * 旧题选项文本数组 → 公开选项结构（§4.2：旧题选项 key 由序号派生 opt-0…，
 * 新结构可用稳定 optionId；答案格式不变仍存 index）。snapshot.options→
 * OptionsPublicStructure 的唯一构造入口，key 派生规则不散落各消费点。
 * 不变量：产出的 option.index 必须等于数组下标（本函数按 map 序号保证）；
 * ai-context 按 index 字段查找仅在此不变量下等价旧实现按位置取值。UA-02
 * 引入稀疏选项（删除选项后 index 跳号）时不得直接字面构造违反此不变量。
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

/**
 * matching 公开结构构造入口（TT-05a 域②）：从题目抽取副本（content.ts
 * matchingOptionsSchema 形态）+ 声明槽位集合（题内 ::ref slots= 或题干槽区，
 * TT-06 解析产物）构造；key 即选项稳定 id（opt-…），不另派生。
 */
export function matchingPublicStructureOf(
  pool: {
    readonly allowRepeat?: boolean;
    readonly options: readonly {
      id: string;
      text: string;
      distractor?: boolean;
    }[];
  },
  slotIds: readonly string[],
  slotOrdinals?: Readonly<Record<string, number>>,
): MatchingPublicStructure {
  return {
    allowRepeat: pool.allowRepeat ?? false,
    slotIds: [...slotIds],
    options: pool.options.map((option) => ({
      key: option.id,
      text: option.text,
      distractor: option.distractor ?? false,
    })),
    ...(slotOrdinals !== undefined ? { slotOrdinals } : {}),
  };
}

/**
 * ordering 公开结构构造入口：从题目抽取副本（content.ts orderingItemSchema
 * 形态）构造；fixedPosition/distractor 归一缺省（null/false）。
 */
export function orderingPublicStructureOf(
  items: readonly {
    id: string;
    text: string;
    fixedPosition?: number | null;
    distractor?: boolean;
  }[],
): OrderingPublicStructure {
  return {
    items: items.map((item) => ({
      key: item.id,
      text: item.text,
      fixedPosition: item.fixedPosition ?? null,
      distractor: item.distractor ?? false,
    })),
  };
}
