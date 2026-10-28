import type { AnswerOf, ReferenceOf } from "@tutor/contract";
import type { ReactNode } from "react";
import type { QuestionCompletion } from "../attempt/question-completion";
import type { PreparedQuestion } from "./prepare-question";

/**
 * 呈现登记表接口（方案 §4.3 呈现层，经 TT-02 §6.1 调整后形态；UA-03 生产
 * 落地）。与纯行为登记表（contract answer-kinds）分文件：共用 AnswerKind，
 * 本层允许 React/RichMarkdown，但仍不引入结果回看重模块与纸面引擎（I14）。
 *
 * 接口形态（决策记录 §6.1 调整 2）：每个 kind 的视图以**三个具体形态参数**
 * (A, M, Rf) 声明——联合类型参数出现在方法签名内会被 TS 方差度量判为不变，
 * 扩展联合下复用生产视图实例编译失败；登记表映射层做 Extract 收口。
 */

/** 服务端已给出的判定（呈现层只显示，不计算——方案 §4.3/§6；本阶段生产未接） */
export interface ServerVerdicts {
  /** 题级判定；null = 服务端明确给出「未判定」（待批） */
  readonly overall?: "correct" | "wrong" | null;
  /** 逐槽/逐位判定（fill 逐空、ordering 逐位），键由 kind 自定 */
  readonly byKey?: Readonly<Record<string, "correct" | "wrong">>;
}

/**
 * 授权参考材料（方案 §6）：以判别联合表达「服务器允许显示什么」，不以
 * 「answers 对象存在」替代公布权限——available 只说明服务器允许显示，不
 * 等于有参考答案（no-reference 是已公布但缺参考的原有空态），更不等于
 * AI 可用。unavailable 下类型上无法携带参考内容（I09 未公布内容不进模型）。
 */
export type ReferenceMaterial<Rf> =
  /** 未公布（宿主按 §6 授权分支裁决：pending/restricted/answersReleased=false 等） */
  | { readonly status: "unavailable" }
  /** 已公布但无参考答案（answers === null 的原有空态「暂无参考答案」） */
  | { readonly status: "no-reference" }
  /** 已公布且有参考（错配 kind 的历史参考由兼容宿主在派发前走通用回退，§6.1 调整 7） */
  | { readonly status: "available"; readonly reference: Rf };

/** 每个 kind 的五种呈现 + 完整度（A/M/Rf 为该 kind 的答案/模型/参考具体形态） */
export interface AnswerKindView<A extends { kind: string }, M, Rf> {
  /**
   * 原位题面（题干 + 题内输入；同一稳定组件类型承载 edit/readonly，锁定
   * 信号经 disabled 到达输入控件，权限控制在数据流——§5）。fill 经槽位
   * 命名空间把输入注入题干；final 的题面输入区仅渲染题干（最终答案输入
   * 由纸面控件区托管，题面不重复——§10）。
   */
  Input(p: {
    model: M;
    answer: A | undefined;
    update: (answer: A, defer?: boolean) => void;
    /** 原位锁定信号（disabled 属性用）；readonly/public-base 的 update 已被宿主换成稳定无副作用回调 */
    disabled?: boolean;
  }): ReactNode;
  /** 独立的结果材料呈现入口（不是原位锁定的替身——§5；不含参考答案） */
  ReadOnly(p: { model: M; answer: A | undefined }): ReactNode;
  /** 参考答案呈现（仅授权反馈入口按 §6 分支调用；后台/导出不走此入口） */
  Reference(p: { model: M; reference: Rf }): ReactNode;
  /** 本人/参考对照（公布三态由 ReferenceMaterial 携带；呈现层只显示不计算判定） */
  Comparison(p: {
    model: M;
    answer: A | undefined;
    reference: ReferenceMaterial<Rf>;
    /** 服务端已给出的判定；本阶段生产未接（§4.3 预留） */
    verdicts?: ServerVerdicts;
  }): ReactNode;
  completion(
    model: M,
    answer: A | undefined,
    formalInk: boolean,
  ): QuestionCompletion;
}

/**
 * 呈现登记表类型：键 = 答案联合 ∩ 模型联合 ∩ 参考联合 的交集 kind——三者
 * 必须对同一 kind 集体提供呈现（关联性表达），交集外 kind 无法登记。
 */
export type AnswerKindViewTable<
  U extends { kind: string },
  P extends { kind: string },
  R extends { kind: string },
> = {
  readonly [K in U["kind"] & P["kind"] & R["kind"]]: AnswerKindView<
    Extract<U, { kind: K }>,
    Extract<P, { kind: K }>,
    Extract<R, { kind: K }>
  >;
};

/** 生产三联合的便捷别名（登记表与调度边界的参数） */
export type StudentAnswerOfKind<K extends string> = AnswerOf<K>;
export type PreparedOf<K extends string> = Extract<
  PreparedQuestion,
  { kind: K }
>;
export type ReferenceOfKind<K extends string> = ReferenceOf<K>;

/** 唯一调度边界收尾（§4.4：中央 switch + assertNever，不追求零 switch） */
export function assertNeverView(kind: never): never {
  throw new Error(`未登记的题面 kind：${String(kind)}`);
}
