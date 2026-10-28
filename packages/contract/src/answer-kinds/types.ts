import type { QuestionAnswers } from "../content.ts";
import type { StudentAnswer } from "../grading.ts";

/**
 * 纯行为登记表的接口类型（统一作答适配层方案 §4.3 定稿形态，经 TT-02
 * UA-00 原型演练并按决策记录 §6.1 七项调整修订；生产实现见同目录各文件）。
 *
 * 纯层约束：无 React/DOM 依赖（I14），server/web 共用；结构参数 S 是该 kind
 * 的公开结构（不含参考答案、解析或教师私注——§4.2 PreparedQuestion 的结构面），
 * 形状检查不接触正确顺序、正确配对或标准答案。
 */

/** 答案 kind：由学生答案联合推导（五个生产 kind：judge/choice/multi/fill/final） */
export type AnswerKind = StudentAnswer["kind"];

/**
 * 某个 kind 的学生答案形态。第二参数默认绑定生产联合，扩展演练传入
 * 扩展联合（§11.3「不继续绑定生产 AnswerKind」；决策记录 §6.1 调整 1/2）。
 */
export type AnswerOf<
  K extends string,
  U extends { kind: string } = StudentAnswer,
> = Extract<U, { kind: K }>;

/**
 * 某个 kind 的参考答案形态：由 QuestionAnswers 推导，不手抄成员。
 * 第二参数默认绑定生产参考联合；演练的 fake kind 传入演练自己的参考联合
 * （决策记录 §6.1 调整 1：ReferenceOf 必须参数化，写死 QuestionAnswers 时
 * fake 参考无法接入）。
 */
export type ReferenceOf<
  K extends string,
  R extends { kind: string } = QuestionAnswers,
> = Extract<R, { kind: K }>;

/** 文本口径（方案 §2：三种口径有意不同，收口=同文件同穷尽表，不合并输出） */
export type AnswerTextProfile = "display" | "teacher-queue" | "ai-context";

/**
 * 结构形状问题（inspectShape 的产物）：只报告、不修复、不阻止保存（§8.3），
 * 本阶段不接入保存拦截。code 用字符串而非封闭枚举——扩展 kind 自带新诊断
 * 不应要求修改生产枚举（DSL 兼容规则 11 的精神）。
 */
export interface ShapeIssue {
  readonly code: string;
  readonly message: string;
}

/**
 * 每种答案的纯行为。三种文本口径对齐三个现网消费点（I15 差分锁定的对象）：
 * - display：web answer-format formatStudentAnswer（结果视图「你的答案」行）；
 * - teacher-queue：server mark-response serializeStudentAnswer（待批队列/CSV）；
 * - ai-context：server student-ai-context studentAnswerTextOf（AI 受控出口）。
 * null/undefined 的无答案口径不在登记表内，由兼容入口处理（§4.3：展示
 * 「未作答」、队列与 AI 保持原 null，不伪造某个 kind 的空答案）。
 */
export interface AnswerKindBehavior<A extends { kind: string }, S> {
  /** 已答判定（旧 isAnswered 口径：fill 至少一空非空、final 非空文本；I06 与完整度分离） */
  isAnswered(answer: A): boolean;
  /** 本人答案 → 按口径文本化；三口径输出各自锁定（I15）。null 仅 teacher-queue
   *  口径的空结构「未做」（#6980-3：judge 空串/multi 空选/fill 全空/final 空文本
   *  → null，待批队列与 CSV 不伪造空答案）；display/ai-context 恒返回 string */
  formatStudent(
    answer: A,
    profile: AnswerTextProfile,
    structure: S,
  ): string | null;
  /** 结构形状检查：未知引用/重复/越界等，只报告不拦截 */
  inspectShape(answer: A, structure: S): readonly ShapeIssue[];
}

/**
 * 穷尽登记表：U 的每个 kind 必须登记，且行为签名与该 kind 的答案形态
 * （Extract 窄化）和 Structures[K] 的结构形态精确相关——错配结构编译失败。
 */
export type AnswerKindBehaviorTable<
  U extends { kind: string },
  Structures extends { readonly [K in U["kind"]]: unknown },
> = {
  readonly [K in U["kind"]]: AnswerKindBehavior<
    Extract<U, { kind: K }>,
    Structures[K]
  >;
};

// ---------- 公开结构映射（生产五 kind，方案 §4.2） ----------

/**
 * 选项项：身份与正文（§4.1 修订：{key,index,text}，修复重复选项文本的 key 冲突）。
 * 不变量：option.index 必须等于 options 数组下标（唯一构造入口
 * optionsPublicStructureOf 按序号生成）；ai-context 口径按 index 字段查找，
 * 仅在该不变量成立时与旧实现按数组位置取值等价。UA-02 引入稳定 optionId/
 * 稀疏选项时不得直接字面构造违反此不变量（差分测试已用非稠密结构显式锁定
 * 「按 index 字段查找」语义）。
 */
export interface PublicOption {
  readonly key: string;
  readonly index: number;
  readonly text: string;
}

/** 填空槽位：旧空位 slotId 由序号派生（slot-1…），order 即旧数组下标 */
export interface PublicSlot {
  readonly slotId: string;
  readonly slotKind: "text";
  readonly order: number;
}

/** choice/multi 的公开结构：有序选项项（含选项身份与正文） */
export interface OptionsPublicStructure {
  readonly options: readonly PublicOption[];
}

/** fill 的公开结构：有序槽位与旧数组下标映射（UA-02 analyzeSlots 的产物形态） */
export interface SlotsPublicStructure {
  readonly slots: readonly PublicSlot[];
}

/**
 * matching 选项项（§5.2.2 选项池；key 即选项稳定 id opt-…）。distractor 是
 * 公开结构标记（§6.1 调整 6）：干扰选项在池内、学生可选——选错是答案错误
 * 而非形状错误，inspectShape 不报。
 */
export interface PublicMatchingOption {
  readonly key: string;
  readonly text: string;
  readonly distractor: boolean;
}

/** matching 的公开结构：选项池 + 声明槽位集合 + 是否允许重复占用 */
export interface MatchingPublicStructure {
  readonly options: readonly PublicMatchingOption[];
  readonly slotIds: readonly string[];
  readonly allowRepeat: boolean;
  /**
   * 槽位 → 材料槽位序 ordinal（QM-16，可选）：携带时文本化槽位标签用
   * 「第 N 空」（与材料面板 {{slot}} 的（N） 编号、题卡配对视图同一口径），
   * 缺省（含 emptyPublicStructure）回落裸槽位 id——结构不完整不猜位置。
   * 键集 ⊆ slotIds 之外的答案槽位同样回落裸 id。
   */
  readonly slotOrdinals?: Readonly<Record<string, number>>;
}

/**
 * ordering 项。fixedPosition 为固定项锁定显示位置（1 起来自参考序列声明位，
 * §6.1 调整 3：公开来源，不泄露其余项顺序）；distractor 标记公开但形状检查
 * 口径与 matching 相反——干扰项不得进入序列。
 */
export interface PublicOrderingItem {
  readonly key: string;
  readonly text: string;
  readonly fixedPosition: number | null;
  readonly distractor: boolean;
}

/** ordering 的公开结构：题内声明的全部项（含固定项与干扰项） */
export interface OrderingPublicStructure {
  readonly items: readonly PublicOrderingItem[];
}

/**
 * 生产 kind 的公开结构映射：judge/final/response 的纯行为只读答案本身，无
 * 结构需求（null 显式表达「无」而不是可选结构——登记表仍是全键穷尽）。
 * TT-05a 域②新增 matching/ordering/response 三键。
 */
export interface PublicStructureByKind {
  readonly judge: null;
  readonly choice: OptionsPublicStructure;
  readonly multi: OptionsPublicStructure;
  readonly fill: SlotsPublicStructure;
  readonly final: null;
  readonly response: null;
  readonly matching: MatchingPublicStructure;
  readonly ordering: OrderingPublicStructure;
}
