import { fireEvent, render, screen } from "@testing-library/react";
import type { QuestionAnswers, StudentAnswer } from "@tutor/contract";
import { formatQuestionAnswers, lettersOf } from "@tutor/contract";
import { createContext, Fragment, type ReactNode, useContext } from "react";
import { describe, expect, it, vi } from "vitest";
import { withBlankValue } from "../attempt/answer-format";
import type { QuestionCompletion } from "../attempt/question-completion";

/**
 * TT-02（UA-00）呈现层接口原型——**测试局部代码，不进生产源码**：
 * AnswerKindView 五呈现 + completion、mode 联合（edit/readonly/public-base）、
 * 旧壳参数转换与槽位命名空间（方案 §8.2）的测试内原型与扩展演练（§11.3）。
 * 生产落地（UA-02/03）时迁入 features/answering/{types,views,index}.tsx。
 *
 * 原型阶段两份原型文件（本文件与 packages/contract/src/answer-kinds.prototype.test.ts）
 * 各自自包含：不跨 vitest project 导入对方测试文件（测试文件被当模块加载会
 * 重复注册其用例），因此 AnswerOf/ReferenceOf 与演练假类型在两文件局部重复
 * 声明——生产落地时纯层类型收归 contract answer-kinds，web 从 contract 导入（方案 §10）。
 *
 * 接口调整点（相对方案 §4.3 草案，理由见决策记录「TT-02 接口调整」）：
 * 1. 登记表按答案/模型/参考三个联合的交集键参数化（K ∈ U∩P∩R），演练不
 *    绑定生产 AnswerKind（§11.3）；
 * 2. Input 增加可选 disabled：原位锁定要求同一组件类型承载 edit/readonly 而
 *    不切换 Input/ReadOnly（§5），锁定信号必须能到达输入控件；权限控制仍在
 *    数据流（readonly/public-base 的 update 换成稳定无副作用回调），disabled
 *    不是唯一权限控制；
 * 3. PreparedQuestion 增加 scopeId（题面实例标识）：radio name 实例隔离与槽位
 *    作用域身份（§8.2「不生成持久化版本」），由宿主提供。
 */

// ---------- 局部纯类型（与 contract 原型文件同形，见文件头说明） ----------

type AnswerOf<
  K extends string,
  U extends { kind: string } = StudentAnswer,
> = Extract<U, { kind: K }>;
type ReferenceOf<
  K extends string,
  R extends { kind: string } = QuestionAnswers,
> = Extract<R, { kind: K }>;

/** 服务端已给出的判定（呈现层只显示，不计算——方案 §4.3/§6） */
interface ServerVerdicts {
  /** 题级判定；null = 服务端明确给出「未判定」（待批） */
  readonly overall?: "correct" | "wrong" | null;
  /** 逐槽/逐位判定（fill 逐空、ordering 逐位），键由 kind 自定 */
  readonly byKey?: Readonly<Record<string, "correct" | "wrong">>;
}

// ---------- 派生模型 PreparedQuestion（方案 §4.2） ----------

/** 选项项：身份与正文（§4.1 修订 {key,index,text}，修复重复选项文本的 key 冲突） */
interface PreparedOption {
  readonly key: string;
  readonly index: number;
  readonly text: string;
}

/** 填空槽位：旧空位 slotId 由序号派生，order 即旧数组下标 */
interface PreparedSlot {
  readonly slotId: string;
  readonly slotKind: "text";
  readonly order: number;
}

/**
 * 以 kind 判别的只读公开模型（不是新的服务器真相）：只持明确挑选的公开内容
 * 与结构，不存参考答案、解析、回调或控制器；答案变化不重新准备。
 * scopeId 为题面实例标识（radio name 隔离 + 槽位作用域），不持久化。
 */
type PreparedQuestion =
  | {
      readonly kind: "judge";
      readonly scopeId: string;
      readonly stemMd: string;
      /** 尾部空标记展示方式（[[正确]] 脱敏后的 [[]] 渲染为「（　）」） */
      readonly tailMarker: "paren" | "none";
    }
  | {
      readonly kind: "choice";
      readonly scopeId: string;
      readonly stemMd: string;
      readonly options: readonly PreparedOption[];
    }
  | {
      readonly kind: "multi";
      readonly scopeId: string;
      readonly stemMd: string;
      readonly options: readonly PreparedOption[];
    }
  | {
      readonly kind: "fill";
      readonly scopeId: string;
      readonly stemMd: string;
      /** 题干分段（槽位 i 渲染在分段 i 与 i+1 之间；分析产物，非持久化） */
      readonly stemParts: readonly string[];
      readonly slots: readonly PreparedSlot[];
    }
  | {
      readonly kind: "final";
      readonly scopeId: string;
      readonly stemMd: string;
    };

type PreparedOf<
  K extends string,
  P extends { kind: string } = PreparedQuestion,
> = Extract<P, { kind: K }>;

// ---------- 呈现登记表接口（方案 §4.3 呈现层草案的参数化形态） ----------

/**
 * 每个 kind 的五种呈现 + 完整度。参数为该 kind 的**三个具体形态**：答案 A、
 * 模型 M、参考 Rf——三者由登记表的交集键映射保证关联，错配在编译期拒绝。
 * （接口调整：原草案按 kind+三个联合参数化，但联合类型参数出现在方法签名
 * 内会被 TS 方差度量判为不变，扩展联合复用生产视图实例时编译失败；改为
 * 在登记表映射层做 Extract，接口只接收已解析的具体形态。见决策记录。）
 */
interface AnswerKindView<A extends { kind: string }, M, Rf> {
  Input(p: {
    model: M;
    answer: A | undefined;
    update: (answer: A, defer?: boolean) => void;
    /** 原位锁定信号（disabled 属性用）；权限控制在数据流，不以此为唯一防线 */
    disabled?: boolean;
  }): ReactNode;
  /** 独立的结果材料呈现入口（不是原位锁定的替身——§5） */
  ReadOnly(p: { model: M; answer: A | undefined }): ReactNode;
  Reference(p: { model: M; reference: Rf }): ReactNode;
  Comparison(p: {
    model: M;
    answer: A | undefined;
    reference: Rf;
    /** 服务端已给出的判定；呈现层只显示，不计算（§6） */
    verdicts?: ServerVerdicts;
  }): ReactNode;
  completion(
    model: M,
    answer: A | undefined,
    formalInk: boolean,
  ): QuestionCompletion;
}

/**
 * 呈现登记表：键 = 答案联合 ∩ 模型联合 ∩ 参考联合 的交集 kind——三者必须
 * 对同一 kind 集体提供呈现（答案/模型/参考的关联性表达）：交集外 kind
 * 无法进入登记表（登记即编译失败）；三联合不一致靠 contract 调度穷尽
 * 与生产三联合一致性兜底；
 * 每个键的视图绑定该 kind 经 Extract 解析后的三个具体形态。
 */
type AnswerKindViewTable<
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

/** 唯一调度边界收尾（§4.4：中央 switch + assertNever，不追求零 switch） */
function assertNever(kind: never): never {
  throw new Error(`未登记的题面 kind：${String(kind)}`);
}

// ---------- mode 联合与旧壳参数转换（方案 §5） ----------

/**
 * 互斥模式联合：类型上 edit 必须有更新函数，readonly/public-base 不能有；
 * public-base 不携带本人答案（即使误传也须从数据流剔除——类型层先拒绝）。
 */
type AnswerSurfaceMode<U extends { kind: string }> =
  | {
      readonly mode: "edit";
      readonly answer: U | undefined;
      readonly update: (answer: U, defer?: boolean) => void;
    }
  | { readonly mode: "readonly"; readonly answer: U | undefined }
  | { readonly mode: "public-base" };

/** 稳定无副作用回调：旧壳缺 onAnswer（预览）与锁定态的兼容形态（§5） */
const STABLE_NOOP_UPDATE: (answer: StudentAnswer, _defer?: boolean) => void =
  () => {};

/**
 * 旧壳参数转换（§5 优先级）：mode=export 总是 public-base；否则 readOnly=true
 * 为 readonly；其余 edit。export 优先于 readOnly；答案在 public-base 一律剔除。
 */
function surfaceModeOf(props: {
  readonly mode?: "answer" | "export";
  readonly readOnly?: boolean;
  readonly answer?: StudentAnswer | undefined;
  readonly onAnswer?:
    | ((answer: StudentAnswer, defer?: boolean) => void)
    | undefined;
}): AnswerSurfaceMode<StudentAnswer> {
  if (props.mode === "export") return { mode: "public-base" };
  if (props.readOnly === true) {
    return { mode: "readonly", answer: props.answer };
  }
  return {
    mode: "edit",
    answer: props.answer,
    update: props.onAnswer ?? STABLE_NOOP_UPDATE,
  };
}

// ---------- 槽位命名空间原型（方案 §8.2，测试局部） ----------

/** 槽位控件类型：本阶段生产只 text；cloze 的 choice / matching 的 match 预留 */
type SlotKind = "text" | "choice" | "match";

/** 槽位绑定：值 + 无副作用可替换的更新；null 渲染展示空框 */
interface SlotBinding {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
}

/** §8.2 草案接口：scopeId 标识当前题目或材料的公开作用域，不生成持久化版本 */
interface DirectiveSlotsState {
  readonly scopeId: string;
  readonly get: (slotId: string, slotKind: SlotKind) => SlotBinding | null;
  readonly disabled: boolean;
}

const SlotsContext = createContext<DirectiveSlotsState | null>(null);

function SlotsProvider(props: {
  readonly scopeId: string;
  readonly disabled: boolean;
  readonly get: (slotId: string, slotKind: SlotKind) => SlotBinding | null;
  readonly children: ReactNode;
}) {
  const state: DirectiveSlotsState = {
    scopeId: props.scopeId,
    get: props.get,
    disabled: props.disabled,
  };
  return (
    <SlotsContext.Provider value={state}>
      {props.children}
    </SlotsContext.Provider>
  );
}

/**
 * 槽位解析：身份为 (scopeId, slotId)。最近的 Provider 优先（内层公开副本
 * 遮蔽外层真实答案）；Provider 缺失或作用域不匹配 → null（展示空框）。
 */
function useSlotBinding(
  scopeId: string,
  slotId: string,
  slotKind: SlotKind,
): SlotBinding | null {
  const state = useContext(SlotsContext);
  if (state === null || state.scopeId !== scopeId) return null;
  return state.get(slotId, slotKind);
}

/** 槽位输入：绑定缺失（显式 null / 作用域不匹配）时渲染同宽展示空框 */
function SlotInput(props: {
  readonly scopeId: string;
  readonly slotId: string;
  readonly slotKind: SlotKind;
  readonly label: string;
}) {
  const binding = useSlotBinding(props.scopeId, props.slotId, props.slotKind);
  if (binding === null) {
    return (
      <span role="img" aria-label={props.label} data-slot="blank-display">
        {"　"}
      </span>
    );
  }
  return (
    <input
      type="text"
      aria-label={props.label}
      value={binding.value}
      disabled={binding.disabled}
      onChange={(event) => binding.onChange(event.target.value)}
      data-slot="blank-input"
    />
  );
}

// ---------- 生产五 kind 的呈现实现（原型，从 QuestionSurface 语义抽取） ----------

/** 判断题：对/错按钮（原生 radio 语义；I03 false 是有效输入） */
const judgeView: AnswerKindView<
  AnswerOf<"judge">,
  PreparedOf<"judge">,
  ReferenceOf<"judge">
> = {
  Input: ({ model, answer, update, disabled }) => {
    const picked =
      answer !== undefined && typeof answer.value === "boolean"
        ? answer.value
        : undefined;
    const name = `judge-${model.scopeId}`;
    return (
      <div role="radiogroup" aria-label="判断对错">
        {[true, false].map((value) => (
          <label key={String(value)}>
            <input
              type="radio"
              name={name}
              aria-label={value ? "对" : "错"}
              checked={picked === value}
              disabled={disabled}
              onChange={() => update({ kind: "judge", value })}
            />
            <span>{value ? "对" : "错"}</span>
          </label>
        ))}
      </div>
    );
  },
  ReadOnly: ({ answer }) => (
    <span>
      {answer === undefined
        ? "未作答"
        : typeof answer.value === "boolean"
          ? answer.value
            ? "对"
            : "错"
          : answer.value}
    </span>
  ),
  Reference: ({ reference }) => (
    <span>参考答案：{reference.value ? "对" : "错"}</span>
  ),
  Comparison: ({ answer, reference, verdicts }) => (
    <div>
      <span>
        你的答案：
        {answer === undefined ? "未作答" : String(answer.value)}
      </span>
      <span>参考答案：{reference.value ? "对" : "错"}</span>
      {verdicts?.overall !== undefined ? (
        <span>
          判定：
          {verdicts.overall === null
            ? "待批"
            : verdicts.overall === "correct"
              ? "对"
              : "错"}
        </span>
      ) : null}
    </div>
  ),
  completion: (_model, answer) =>
    answer !== undefined
      ? { state: "filled", filledSlots: 1, expectedSlots: 1 }
      : { state: "empty", filledSlots: 0, expectedSlots: 1 },
};

/** 单选：选项按钮 + 字母标注（key 用 option.key，重复文本不冲突） */
const choiceView: AnswerKindView<
  AnswerOf<"choice">,
  PreparedOf<"choice">,
  ReferenceOf<"choice">
> = {
  Input: ({ model, answer, update, disabled }) => {
    const picked = answer?.kind === "choice" ? answer.index : undefined;
    const name = `choice-${model.scopeId}`;
    return (
      <div role="radiogroup" aria-label="选项">
        {model.options.map((option) => (
          <label key={option.key}>
            <input
              type="radio"
              name={name}
              aria-label={`${lettersOf(option.index)} ${option.text}`}
              checked={picked === option.index}
              disabled={disabled}
              onChange={() => update({ kind: "choice", index: option.index })}
            />
            <span>
              {lettersOf(option.index)}. {option.text}
            </span>
          </label>
        ))}
      </div>
    );
  },
  ReadOnly: ({ model, answer }) => (
    <span>
      {answer === undefined ? "未作答" : lettersOf(answer.index)}
      {answer !== undefined
        ? `（${model.options.find((option) => option.index === answer.index)?.text ?? "越界选项"}）`
        : ""}
    </span>
  ),
  Reference: ({ reference }) => (
    <span>参考答案：{lettersOf(reference.index)}</span>
  ),
  Comparison: ({ model, answer, reference }) => (
    <div>
      <span>
        你的答案：
        {answer === undefined
          ? "未作答"
          : `${lettersOf(answer.index)}（${model.options.find((option) => option.index === answer.index)?.text ?? "越界选项"}）`}
      </span>
      <span>参考答案：{lettersOf(reference.index)}</span>
    </div>
  ),
  completion: (model, answer) => {
    const filled =
      answer?.kind === "choice" &&
      model.options.some((option) => option.index === answer.index);
    return filled
      ? { state: "filled", filledSlots: 1, expectedSlots: 1 }
      : { state: "empty", filledSlots: 0, expectedSlots: 1 };
  },
};

/** 多选：原生 checkbox（I04 勾选顺序不排序不改写；空数组合法） */
const multiView: AnswerKindView<
  AnswerOf<"multi">,
  PreparedOf<"multi">,
  ReferenceOf<"multi">
> = {
  Input: ({ model, answer, update, disabled }) => {
    const picked = answer?.kind === "multi" ? answer.indexes : [];
    return (
      <fieldset aria-label="多选题选项">
        {model.options.map((option) => (
          <label key={option.key}>
            <input
              type="checkbox"
              aria-label={`${lettersOf(option.index)} ${option.text}`}
              checked={picked.includes(option.index)}
              disabled={disabled}
              onChange={() => {
                const next = picked.includes(option.index)
                  ? picked.filter((index) => index !== option.index)
                  : [...picked, option.index];
                update({ kind: "multi", indexes: next });
              }}
            />
            <span>
              {lettersOf(option.index)}. {option.text}
            </span>
          </label>
        ))}
      </fieldset>
    );
  },
  ReadOnly: ({ answer }) => (
    <span>
      {answer === undefined
        ? "未作答"
        : [...answer.indexes]
            .sort((a, b) => a - b)
            .map(lettersOf)
            .join("")}
    </span>
  ),
  Reference: ({ reference }) => (
    <span>
      参考答案：
      {[...reference.indexes]
        .sort((a, b) => a - b)
        .map(lettersOf)
        .join("")}
    </span>
  ),
  Comparison: ({ answer, reference }) => (
    <div>
      <span>
        你的答案：
        {answer === undefined
          ? "未作答"
          : answer.indexes.map(lettersOf).join("")}
      </span>
      <span>
        参考答案：
        {[...reference.indexes]
          .sort((a, b) => a - b)
          .map(lettersOf)
          .join("")}
      </span>
    </div>
  ),
  completion: (model, answer) => {
    const filled =
      answer?.kind === "multi" &&
      answer.indexes.some((index) =>
        model.options.some((option) => option.index === index),
      );
    return filled
      ? { state: "filled", filledSlots: 1, expectedSlots: 1 }
      : { state: "empty", filledSlots: 0, expectedSlots: 1 };
  },
};

/** 填空：内联槽位经槽位命名空间注入题干（defer=true，I05） */
const fillView: AnswerKindView<
  AnswerOf<"fill">,
  PreparedOf<"fill">,
  ReferenceOf<"fill">
> = {
  Input: ({ model, answer, update, disabled = false }) => {
    const values = answer?.kind === "fill" ? answer.values : [];
    return (
      <SlotsProvider
        scopeId={model.scopeId}
        disabled={disabled}
        get={(slotId, slotKind) => {
          const slot = model.slots.find(
            (entry) => entry.slotId === slotId && entry.slotKind === slotKind,
          );
          if (slot === undefined) return null;
          return {
            value: values[slot.order] ?? "",
            onChange: (value) =>
              update(
                {
                  kind: "fill",
                  values: withBlankValue(values, slot.order, value),
                },
                true,
              ),
            disabled,
          };
        }}
      >
        <p>
          {model.slots.map((slot, index) => (
            <Fragment key={slot.slotId}>
              <span>{model.stemParts[index] ?? ""}</span>
              <SlotInput
                scopeId={model.scopeId}
                slotId={slot.slotId}
                slotKind="text"
                label={`第${index + 1}空`}
              />
            </Fragment>
          ))}
          <span>{model.stemParts[model.slots.length] ?? ""}</span>
        </p>
      </SlotsProvider>
    );
  },
  ReadOnly: ({ answer }) => (
    <span>
      {answer === undefined
        ? "未作答"
        : answer.values
            .map((value) => (value.trim() === "" ? "（空）" : value))
            .join("；")}
    </span>
  ),
  Reference: ({ reference }) => (
    <span>
      参考答案：{reference.blanks.map((blank) => blank.join(" 或 ")).join("；")}
    </span>
  ),
  Comparison: ({ model, answer, reference, verdicts }) => {
    const own = answer?.kind === "fill" ? answer.values : [];
    // 行数 = max(结构空位数, 本人项数, 参考空数)——历史多余项有独立行（现状口径）
    const length = Math.max(
      model.slots.length,
      own.length,
      reference.blanks.length,
    );
    return (
      <section aria-label="填空对照">
        {Array.from({ length }, (_, index) => index + 1).map((no) => {
          const verdict = verdicts?.byKey?.[String(no)];
          const value = own[no - 1] ?? "";
          return (
            <div key={no} data-slot="fill-compare-row">
              <span>第{no}空</span>
              <span>{value.trim() === "" ? "未填" : value}</span>
              <span>
                {(reference.blanks[no - 1] ?? []).join(" 或 ") || "—"}
              </span>
              {verdict !== undefined ? (
                <span>{verdict === "correct" ? "对" : "错"}</span>
              ) : null}
            </div>
          );
        })}
      </section>
    );
  },
  completion: (model, answer) => {
    // I06/§7.1：完整度按有效空位计，额外数组项不能填补空位
    const values = answer?.kind === "fill" ? answer.values : [];
    const expectedSlots = model.slots.length;
    let filledSlots = 0;
    for (let index = 0; index < expectedSlots; index++) {
      if ((values[index] ?? "").trim() !== "") filledSlots++;
    }
    return {
      state:
        filledSlots === 0
          ? "empty"
          : filledSlots === expectedSlots
            ? "filled"
            : "partial",
      filledSlots,
      expectedSlots,
    };
  },
};

/** final：最终答案文本输入（正式手写由原宿主管辖，登记表不接管引擎——§2/§10） */
const finalView: AnswerKindView<
  AnswerOf<"final">,
  PreparedOf<"final">,
  ReferenceOf<"final">
> = {
  Input: ({ answer, update, disabled }) => (
    <textarea
      aria-label="最终答案"
      value={answer?.kind === "final" ? answer.finalAnswer : ""}
      disabled={disabled}
      onChange={(event) =>
        update({ kind: "final", finalAnswer: event.target.value })
      }
    />
  ),
  ReadOnly: ({ answer }) => (
    <span>{answer === undefined ? "未作答" : answer.finalAnswer}</span>
  ),
  Reference: ({ reference }) => <span>参考答案：{reference.answer}</span>,
  Comparison: ({ answer, reference }) => (
    <div>
      <span>
        你的答案：{answer === undefined ? "未作答" : answer.finalAnswer}
      </span>
      <span>参考答案：{reference.answer}</span>
    </div>
  ),
  completion: (_model, answer, formalInk) => {
    // I06：有正式笔迹未填最终答案 = partial（本次不改成 filled）
    const filled = answer?.kind === "final" && answer.finalAnswer.trim() !== "";
    if (filled) return { state: "filled", filledSlots: 1, expectedSlots: 1 };
    if (formalInk)
      return { state: "partial", filledSlots: 0, expectedSlots: 1 };
    return { state: "empty", filledSlots: 0, expectedSlots: 1 };
  },
};

/** 生产呈现登记表：五 kind 全配（漏 kind / 三联合不交集即编译失败） */
const productionViews: AnswerKindViewTable<
  StudentAnswer,
  PreparedQuestion,
  QuestionAnswers
> = {
  judge: judgeView,
  choice: choiceView,
  multi: multiView,
  fill: fillView,
  final: finalView,
};

// ---------- 原位题面与唯一调度边界原型（§4.4/§5） ----------

/**
 * 原位题面：同一稳定组件类型接收模式联合（不切换 Input/ReadOnly 实现锁定）。
 * 题型/答案 kind 不匹配时按 I02 现状口径——渲染为未作答、原值留在会话层，
 * 不自动保存、不改写；readonly/public-base 的 update 换成稳定无副作用回调
 * （权限控制在数据流，inert/disabled 不是唯一防线）。
 */
function ProductionSurface(props: {
  readonly views: AnswerKindViewTable<
    StudentAnswer,
    PreparedQuestion,
    QuestionAnswers
  >;
  readonly model: PreparedQuestion;
  readonly mode: AnswerSurfaceMode<StudentAnswer>;
}) {
  const { views, model, mode } = props;
  const locked = mode.mode !== "edit";
  const answer = mode.mode === "public-base" ? undefined : mode.answer;
  const update = mode.mode === "edit" ? mode.update : STABLE_NOOP_UPDATE;
  let content: ReactNode;
  switch (model.kind) {
    case "judge":
      content = (
        <views.judge.Input
          model={model}
          answer={answer?.kind === "judge" ? answer : undefined}
          update={update}
          disabled={locked}
        />
      );
      break;
    case "choice":
      content = (
        <views.choice.Input
          model={model}
          answer={answer?.kind === "choice" ? answer : undefined}
          update={update}
          disabled={locked}
        />
      );
      break;
    case "multi":
      content = (
        <views.multi.Input
          model={model}
          answer={answer?.kind === "multi" ? answer : undefined}
          update={update}
          disabled={locked}
        />
      );
      break;
    case "fill":
      content = (
        <views.fill.Input
          model={model}
          answer={answer?.kind === "fill" ? answer : undefined}
          update={update}
          disabled={locked}
        />
      );
      break;
    case "final":
      content = (
        <views.final.Input
          model={model}
          answer={answer?.kind === "final" ? answer : undefined}
          update={update}
          disabled={locked}
        />
      );
      break;
    default:
      return assertNever(model);
  }
  return (
    <div data-slot="question-surface" inert={locked}>
      {/* fill 的题干与槽位由视图整体渲染（内联注入）；其余题干在输入区上方 */}
      {model.kind !== "fill" ? <p>{model.stemMd}</p> : null}
      {content}
    </div>
  );
}

// ---------- 扩展演练（§11.3）：fake-ordering / fake-matching ----------

/** 排序答案（演练用形态：字段名 itemKeys 仅为演练代号，TT-01 定稿字段名为 sequence，决策记录 5.3；与 contract 原型文件同形） */
interface FakeOrderingAnswer {
  readonly kind: "fake-ordering";
  readonly itemKeys: string[];
}

/** 排序参考：完整序列（含固定项；可发布校验=非干扰项恰一次、固定项在位） */
interface FakeOrderingReference {
  readonly kind: "fake-ordering";
  readonly sequence: string[];
}

/**
 * 排序公开模型：itemId→正文、固定位置与干扰项标记。
 * 固定项锁定位置来自参考序列（语料 valid-05 两例固定项均在首序）——对学生是
 * 可见的既定位置提示，属公开结构而非答案秘密；fixedPosition>0 的草稿空洞
 * 表示（string[] 无法表达空位）留 TT-10 定稿，见决策记录「TT-02 接口调整」。
 */
interface OrderingPrepared {
  readonly kind: "fake-ordering";
  readonly scopeId: string;
  readonly stemMd: string;
  readonly items: readonly {
    readonly itemId: string;
    readonly text: string;
    readonly fixed: boolean;
    readonly fixedPosition: number | null;
    readonly distractor: boolean;
  }[];
}

/** 配对答案：slotId → optionId（部分配对 = 草稿，合法） */
interface FakeMatchingAnswer {
  readonly kind: "fake-matching";
  readonly pairs: Record<string, string>;
}

/** 配对参考：同形映射（提供时全覆盖槽位） */
interface FakeMatchingReference {
  readonly kind: "fake-matching";
  readonly pairs: Record<string, string>;
}

/**
 * 配对公开模型：槽位、选项池与重复约束。干扰选项在池内（七选五可选——
 * 选错是答案错误不是形状错误），与排序干扰项不得入序不对称。
 */
interface MatchingPrepared {
  readonly kind: "fake-matching";
  readonly scopeId: string;
  readonly stemMd: string;
  readonly slots: readonly {
    readonly slotId: string;
    readonly text: string;
  }[];
  readonly optionPool: readonly {
    readonly optionId: string;
    readonly text: string;
  }[];
  readonly allowRepeat: boolean;
}

type DrillAnswer = StudentAnswer | FakeOrderingAnswer | FakeMatchingAnswer;
type DrillPrepared = PreparedQuestion | OrderingPrepared | MatchingPrepared;
type DrillReference =
  | QuestionAnswers
  | FakeOrderingReference
  | FakeMatchingReference;

/** 在固定项不移动的前提下与最近的非固定邻居交换；无可交换位返回 null（不触发更新） */
function moveWithin(
  model: OrderingPrepared,
  keys: readonly string[],
  position: number,
  direction: -1 | 1,
): string[] | null {
  const next = [...keys];
  let target = position + direction;
  while (target >= 0 && target < next.length) {
    const targetItem = model.items.find(
      (entry) => entry.itemId === next[target],
    );
    if (targetItem !== undefined && !targetItem.fixed) {
      const current = next[position];
      const other = next[target];
      if (current === undefined || other === undefined) return null;
      next[position] = other;
      next[target] = current;
      return next;
    }
    target += direction;
  }
  return null;
}

const orderingView: AnswerKindView<
  FakeOrderingAnswer,
  OrderingPrepared,
  FakeOrderingReference
> = {
  Input: ({ model, answer, update, disabled }) => {
    const itemOf = (itemId: string) =>
      model.items.find((entry) => entry.itemId === itemId);
    const placed = answer?.kind === "fake-ordering" ? answer.itemKeys : [];
    const inSequence = new Set(placed);
    return (
      <section aria-label="排序作答区">
        <ol>
          {placed.map((itemId, position) => {
            const item = itemOf(itemId);
            const text = item === undefined ? `未知项 ${itemId}` : item.text;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: 重复项历史数据下 itemId 单独不唯一，行身份需要位置成分
              <li key={`${itemId}-${position}`}>
                <span>{text}</span>
                {item?.fixed === true ? (
                  <span role="img" aria-label="固定项">
                    （固定）
                  </span>
                ) : null}
                {item !== undefined && !item.fixed && !disabled ? (
                  <>
                    <button
                      type="button"
                      aria-label={`上移 ${text}`}
                      onClick={() => {
                        const next = moveWithin(model, placed, position, -1);
                        if (next !== null) {
                          update({ kind: "fake-ordering", itemKeys: next });
                        }
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`下移 ${text}`}
                      onClick={() => {
                        const next = moveWithin(model, placed, position, 1);
                        if (next !== null) {
                          update({ kind: "fake-ordering", itemKeys: next });
                        }
                      }}
                    >
                      ↓
                    </button>
                  </>
                ) : null}
              </li>
            );
          })}
        </ol>
        <section aria-label="待放置项">
          {model.items
            .filter((item) => !item.fixed && !inSequence.has(item.itemId))
            .map((item) => (
              <div key={item.itemId}>
                <span>{item.text}</span>
                {item.distractor ? (
                  <span>（干扰项，请勿选用）</span>
                ) : (
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`放入 ${item.text}`}
                    onClick={() =>
                      update({
                        kind: "fake-ordering",
                        itemKeys: [...placed, item.itemId],
                      })
                    }
                  >
                    放入
                  </button>
                )}
              </div>
            ))}
        </section>
      </section>
    );
  },
  ReadOnly: ({ model, answer }) => (
    <ol aria-label="本人排序">
      {(answer?.kind === "fake-ordering" ? answer.itemKeys : []).map(
        (itemId, position) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 重复项历史数据下 itemId 单独不唯一，行身份需要位置成分
          <li key={`${itemId}-${position}`}>
            {model.items.find((entry) => entry.itemId === itemId)?.text ??
              `未知项 ${itemId}`}
          </li>
        ),
      )}
    </ol>
  ),
  Reference: ({ model, reference }) => (
    <ol aria-label="参考排序">
      {reference.sequence.map((itemId, position) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 重复项历史数据下 itemId 单独不唯一，行身份需要位置成分
        <li key={`${itemId}-${position}`}>
          {model.items.find((entry) => entry.itemId === itemId)?.text ??
            `未知项 ${itemId}`}
        </li>
      ))}
    </ol>
  ),
  Comparison: ({ model, answer, reference, verdicts }) => {
    const own = answer?.kind === "fake-ordering" ? answer.itemKeys : [];
    const textOf = (itemId: string) =>
      model.items.find((entry) => entry.itemId === itemId)?.text ??
      `未知项 ${itemId}`;
    const length = Math.max(own.length, reference.sequence.length);
    return (
      <section aria-label="排序对照">
        {Array.from({ length }, (_, index) => index + 1).map((no) => {
          const verdict = verdicts?.byKey?.[String(no)];
          const ownId = own[no - 1];
          const refId = reference.sequence[no - 1];
          return (
            <div key={no} data-slot="ordering-compare-row">
              <span>位置{no}</span>
              <span>{ownId === undefined ? "未放" : textOf(ownId)}</span>
              <span>{refId === undefined ? "—" : textOf(refId)}</span>
              {verdict !== undefined ? (
                <span>{verdict === "correct" ? "对" : "错"}</span>
              ) : null}
            </div>
          );
        })}
      </section>
    );
  },
  completion: (model, answer) => {
    // 已放项/应放项（应放 = 非干扰项数）；干扰项与未知项不计入已放
    const placed = answer?.kind === "fake-ordering" ? answer.itemKeys : [];
    const expected = model.items.filter((item) => !item.distractor);
    const knownIds = new Set(expected.map((item) => item.itemId));
    const filledSlots = new Set(placed.filter((itemId) => knownIds.has(itemId)))
      .size;
    return {
      state:
        filledSlots === 0
          ? "empty"
          : filledSlots === expected.length
            ? "filled"
            : "partial",
      filledSlots,
      expectedSlots: expected.length,
    };
  },
};

const matchingView: AnswerKindView<
  FakeMatchingAnswer,
  MatchingPrepared,
  FakeMatchingReference
> = {
  Input: ({ model, answer, update, disabled }) => {
    const pairs = answer?.kind === "fake-matching" ? answer.pairs : {};
    const usedCount = new Map<string, number>();
    for (const optionId of Object.values(pairs)) {
      usedCount.set(optionId, (usedCount.get(optionId) ?? 0) + 1);
    }
    return (
      <section aria-label="配对作答区">
        {model.slots.map((slot) => {
          const chosen = pairs[slot.slotId] ?? "";
          const repeated =
            !model.allowRepeat &&
            chosen !== "" &&
            (usedCount.get(chosen) ?? 0) > 1;
          return (
            <label key={slot.slotId}>
              <span>{slot.text}</span>
              <select
                aria-label={slot.text}
                disabled={disabled}
                value={chosen}
                onChange={(event) => {
                  const next = { ...pairs };
                  if (event.target.value === "") {
                    delete next[slot.slotId];
                  } else {
                    next[slot.slotId] = event.target.value;
                  }
                  update({ kind: "fake-matching", pairs: next });
                }}
              >
                <option value="">未选择</option>
                {model.optionPool.map((option) => (
                  <option key={option.optionId} value={option.optionId}>
                    {option.text}
                  </option>
                ))}
              </select>
              {repeated ? (
                <span role="img" aria-label="重复占用">
                  ⚠ 该选项已被多个空位使用
                </span>
              ) : null}
            </label>
          );
        })}
      </section>
    );
  },
  ReadOnly: ({ model, answer }) => (
    <ul aria-label="本人配对">
      {Object.entries(answer?.kind === "fake-matching" ? answer.pairs : {}).map(
        ([slotId, optionId]) => (
          <li key={slotId}>
            {model.slots.find((slot) => slot.slotId === slotId)?.text ?? slotId}
            {" = "}
            {model.optionPool.find((option) => option.optionId === optionId)
              ?.text ?? optionId}
          </li>
        ),
      )}
    </ul>
  ),
  Reference: ({ model, reference }) => (
    <ul aria-label="参考配对">
      {Object.entries(reference.pairs).map(([slotId, optionId]) => (
        <li key={slotId}>
          {model.slots.find((slot) => slot.slotId === slotId)?.text ?? slotId}
          {" = "}
          {model.optionPool.find((option) => option.optionId === optionId)
            ?.text ?? optionId}
        </li>
      ))}
    </ul>
  ),
  Comparison: ({ model, answer, reference }) => (
    <section aria-label="配对对照">
      {model.slots.map((slot) => {
        const own =
          answer?.kind === "fake-matching"
            ? (answer.pairs[slot.slotId] ?? "")
            : "";
        const ref = reference.pairs[slot.slotId] ?? "";
        const textOf = (optionId: string) =>
          model.optionPool.find((option) => option.optionId === optionId)
            ?.text ?? optionId;
        return (
          <div key={slot.slotId} data-slot="matching-compare-row">
            <span>{slot.text}</span>
            <span>{own === "" ? "未配" : textOf(own)}</span>
            <span>{ref === "" ? "—" : textOf(ref)}</span>
          </div>
        );
      })}
    </section>
  ),
  completion: (model, answer) => {
    const pairs = answer?.kind === "fake-matching" ? answer.pairs : {};
    const slotIds = new Set(model.slots.map((slot) => slot.slotId));
    const optionIds = new Set(
      model.optionPool.map((option) => option.optionId),
    );
    let filledSlots = 0;
    for (const [slotId, optionId] of Object.entries(pairs)) {
      if (slotIds.has(slotId) && optionIds.has(optionId)) filledSlots++;
    }
    return {
      state:
        filledSlots === 0
          ? "empty"
          : filledSlots === model.slots.length
            ? "filled"
            : "partial",
      filledSlots,
      expectedSlots: model.slots.length,
    };
  },
};

/** 演练呈现登记表：生产五项原样复用 + 两个假 kind（§11.3：业务宿主保持原样） */
const drillViews: AnswerKindViewTable<
  DrillAnswer,
  DrillPrepared,
  DrillReference
> = {
  ...productionViews,
  "fake-ordering": orderingView,
  "fake-matching": matchingView,
};

// ---------- 宿主授权分支与空态原型（方案 §6） ----------

/** 参考材料判别联合：available 只说明服务器允许显示，不等于有参考答案 */
type ReferenceMaterial<R> =
  | { readonly state: "unavailable" }
  | { readonly state: "available"; readonly reference: R | null };

/** 宿主空态保持现状文案（ResultAnswerComparison 同款）：未公布锁定 / 无参考 */
function ReferencePanel<R>(props: {
  readonly material: ReferenceMaterial<R>;
  readonly render: (reference: R) => ReactNode;
}) {
  if (props.material.state === "unavailable") {
    return <p>参考答案与详解将在截止后公布 🔒</p>;
  }
  if (props.material.reference === null) {
    return <p>暂无参考答案</p>;
  }
  return <>{props.render(props.material.reference)}</>;
}

/** 兼容宿主原型：快照题型与参考 kind 错配时按参考自身 kind 呈现（现状策略） */
function CompatReferenceFallback(props: {
  readonly model: PreparedQuestion;
  readonly reference: QuestionAnswers;
}) {
  if (props.model.kind === "fill" && props.reference.kind === "fill") {
    return (
      <fillView.Reference model={props.model} reference={props.reference} />
    );
  }
  // 现状：ResultAnswerComparison 对非 fill 参考走 formatQuestionAnswers 通用文本
  return <span>{formatQuestionAnswers(props.reference)}</span>;
}

// ---------- 测试用模型 ----------

const judgeModel: PreparedOf<"judge"> = {
  kind: "judge",
  scopeId: "q-judge",
  stemMd: "判断：地球绕太阳公转。",
  tailMarker: "paren",
};

const choiceModel: PreparedOf<"choice"> = {
  kind: "choice",
  scopeId: "q-choice",
  stemMd: "选出正确的说法。",
  options: [
    { key: "opt-0", index: 0, text: "设问开篇" },
    { key: "opt-1", index: 1, text: "承上启下" },
    { key: "opt-2", index: 2, text: "总结收束" },
  ],
};

const duplicateTextModel: PreparedOf<"choice"> = {
  ...choiceModel,
  scopeId: "q-choice-dup",
  options: [
    { key: "opt-0", index: 0, text: "相同选项文本" },
    { key: "opt-1", index: 1, text: "相同选项文本" },
  ],
};

const multiModel: PreparedOf<"multi"> = {
  kind: "multi",
  scopeId: "q-multi",
  stemMd: "选出所有正确的说法。",
  options: choiceModel.options,
};

const fillModel: PreparedOf<"fill"> = {
  kind: "fill",
  scopeId: "q-fill",
  stemMd: "甲 [[]]，乙 [[]]。",
  stemParts: ["甲 ", "，乙 ", "。"],
  slots: [
    { slotId: "slot-1", slotKind: "text", order: 0 },
    { slotId: "slot-2", slotKind: "text", order: 1 },
  ],
};

const finalModel: PreparedOf<"final"> = {
  kind: "final",
  scopeId: "q-final",
  stemMd: "计算最终结果。",
};

/** 语料 valid-05 px-2 的最小复刻：it-3 固定首序，it-5 干扰项 */
const orderingModel: OrderingPrepared = {
  kind: "fake-ordering",
  scopeId: "q-ordering",
  stemMd: "Arrange the steps of a titration in the correct order.",
  items: [
    {
      itemId: "it-3",
      text: "Rinse the burette with the standard solution.",
      fixed: true,
      fixedPosition: 0,
      distractor: false,
    },
    {
      itemId: "it-2",
      text: "Add the indicator to the flask.",
      fixed: false,
      fixedPosition: null,
      distractor: false,
    },
    {
      itemId: "it-1",
      text: "Record the initial reading of the burette.",
      fixed: false,
      fixedPosition: null,
      distractor: false,
    },
    {
      itemId: "it-4",
      text: "Titrate until the endpoint colour persists.",
      fixed: false,
      fixedPosition: null,
      distractor: false,
    },
    {
      itemId: "it-5",
      text: "Heat the flask to boiling for ten minutes.",
      fixed: false,
      fixedPosition: null,
      distractor: true,
    },
  ],
};

/** 语料 valid-04 七选五的最小复刻：槽位与选项池（含干扰选项），allowRepeat=false */
const matchingModel: MatchingPrepared = {
  kind: "fake-matching",
  scopeId: "q-matching",
  stemMd: "从选项中为每个空白选择最合适的内容。",
  slots: [
    { slotId: "slot-1", text: "第一空" },
    { slotId: "slot-2", text: "第二空" },
  ],
  optionPool: [
    { optionId: "opt-1", text: "深度睡眠清理废物蛋白" },
    { optionId: "opt-3", text: "以少睡为荣即以劣绩为荣" },
    { optionId: "opt-6", text: "尊重这张床：只用来睡觉" },
    { optionId: "opt-7", text: "干扰选项" },
  ],
  allowRepeat: false,
};

// ---------- 编译期负例（@ts-expect-error 带原因；tsc 消费） ----------

const _publicWithAnswer: AnswerSurfaceMode<StudentAnswer> = {
  mode: "public-base",
  // @ts-expect-error: public-base 不得携带本人答案（即使误传也须从数据流剔除）
  answer: { kind: "judge", value: true },
};
const _readonlyWithUpdate: AnswerSurfaceMode<StudentAnswer> = {
  mode: "readonly",
  answer: undefined,
  // @ts-expect-error: readonly 分支不能有更新函数（锁定不提供更新能力）
  update: () => {},
};
// @ts-expect-error: edit 分支必须有更新函数
const _editWithoutUpdate: AnswerSurfaceMode<StudentAnswer> = {
  mode: "edit",
  answer: undefined,
};
void _publicWithAnswer;
void _readonlyWithUpdate;
void _editWithoutUpdate;

const _wrongModelJsx = (
  <productionViews.choice.Input
    // @ts-expect-error: choice 输入不接受 fill 模型（PreparedOf 相关性）
    model={fillModel}
    answer={undefined}
    update={() => {}}
  />
);
const _noReferenceJsx = (
  // @ts-expect-error: Comparison 必须携带参考（无参考走宿主空态，不进视图）
  <productionViews.judge.Comparison model={judgeModel} answer={undefined} />
);
const _wrongUpdateJsx = (
  <productionViews.fill.Input
    model={fillModel}
    answer={undefined}
    // @ts-expect-error: fill 输入的 update 不接受 judge 答案（答案形态与 kind 相关）
    update={(answer: AnswerOf<"judge">) => void answer}
  />
);
// @ts-expect-error: 演练登记表漏 fake-matching 键（三联合交集必须穷尽）
const _drillMissingViews: AnswerKindViewTable<
  DrillAnswer,
  DrillPrepared,
  DrillReference
> = {
  ...productionViews,
  "fake-ordering": orderingView,
};
void _wrongModelJsx;
void _noReferenceJsx;
void _wrongUpdateJsx;
void _drillMissingViews;

// ---------- 运行期断言 ----------

describe("呈现层接口原型（TT-02）", () => {
  it("旧壳参数转换：export 优先于 readOnly，public-base 不携带本人答案", () => {
    const mode = surfaceModeOf({
      mode: "export",
      readOnly: true,
      answer: { kind: "judge", value: true },
      onAnswer: () => {},
    });
    expect(mode).toEqual({ mode: "public-base" });
  });

  it("旧壳参数转换：readOnly → readonly 携带答案；缺 onAnswer 时用稳定无副作用回调", () => {
    const readonlyMode = surfaceModeOf({
      readOnly: true,
      answer: { kind: "judge", value: false },
    });
    expect(readonlyMode).toEqual({
      mode: "readonly",
      answer: { kind: "judge", value: false },
    });
    const first = surfaceModeOf({});
    const second = surfaceModeOf({});
    if (first.mode !== "edit" || second.mode !== "edit") {
      throw new Error("缺省应为 edit 模式");
    }
    expect(first.update).toBe(second.update); // 稳定同一引用（不擅自改为 disabled）
    expect(() => first.update({ kind: "judge", value: true })).not.toThrow();
    expect(first.answer).toBeUndefined();
  });

  it("判断题输入：对/错即时回调，false 是有效输入（I03/I05）", () => {
    const update = vi.fn();
    render(
      <judgeView.Input model={judgeModel} answer={undefined} update={update} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "对" }));
    expect(update).toHaveBeenCalledWith({ kind: "judge", value: true });
    expect(update.mock.calls[0]?.[1]).toBeUndefined(); // 即时：不带 defer
    fireEvent.click(screen.getByRole("radio", { name: "错" }));
    expect(update).toHaveBeenLastCalledWith({ kind: "judge", value: false });
  });

  it("单选输入：index=0 有效（I03）；重复选项文本经 option.key 区分（修订「选项身份」）", () => {
    const update = vi.fn();
    const { unmount } = render(
      <choiceView.Input
        model={choiceModel}
        answer={undefined}
        update={update}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "A 设问开篇" }));
    expect(update).toHaveBeenCalledWith({ kind: "choice", index: 0 });
    unmount();
    const dupUpdate = vi.fn();
    render(
      <choiceView.Input
        model={duplicateTextModel}
        answer={undefined}
        update={dupUpdate}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "B 相同选项文本" }));
    expect(dupUpdate).toHaveBeenCalledWith({ kind: "choice", index: 1 });
  });

  it("多选输入：勾选顺序保持原样不排序（I04），取消产生子集数组", () => {
    const update = vi.fn();
    const { rerender } = render(
      <multiView.Input model={multiModel} answer={undefined} update={update} />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "C 总结收束" }));
    expect(update).toHaveBeenLastCalledWith({ kind: "multi", indexes: [2] });
    // 宿主按新答案重渲染后继续勾选（顺序保持原样不排序，I04）
    rerender(
      <multiView.Input
        model={multiModel}
        answer={{ kind: "multi", indexes: [2] }}
        update={update}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "A 设问开篇" }));
    expect(update).toHaveBeenLastCalledWith({ kind: "multi", indexes: [2, 0] });
    rerender(
      <multiView.Input
        model={multiModel}
        answer={{ kind: "multi", indexes: [2, 0] }}
        update={update}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "A 设问开篇" }));
    expect(update).toHaveBeenLastCalledWith({ kind: "multi", indexes: [2] });
  });

  it("填空输入：槽位内联注入题干（DOM 顺序），更新 defer=true（I05/I07）", () => {
    const update = vi.fn();
    const { container } = render(
      <fillView.Input model={fillModel} answer={undefined} update={update} />,
    );
    const children = Array.from(container.querySelector("p")?.children ?? []);
    // 槽位输入位于题干分段之间：span、input、span、input、span
    expect(children.map((node) => node.tagName)).toEqual([
      "SPAN",
      "INPUT",
      "SPAN",
      "INPUT",
      "SPAN",
    ]);
    fireEvent.change(screen.getByLabelText("第1空"), {
      target: { value: "甲答" },
    });
    expect(update).toHaveBeenCalledWith(
      { kind: "fill", values: ["甲答"] },
      true,
    );
  });

  it("填空输入：按空位顺序写入既有答案，第二空更新保留第一空（I04）", () => {
    const update = vi.fn();
    render(
      <fillView.Input
        model={fillModel}
        answer={{ kind: "fill", values: ["甲答", ""] }}
        update={update}
      />,
    );
    fireEvent.change(screen.getByLabelText("第2空"), {
      target: { value: "乙答" },
    });
    expect(update).toHaveBeenCalledWith(
      { kind: "fill", values: ["甲答", "乙答"] },
      true,
    );
  });

  it("final 输入与完整度：空文+笔迹=partial，空文无笔迹=empty，有文=filled（I06）", () => {
    const update = vi.fn();
    render(
      <finalView.Input model={finalModel} answer={undefined} update={update} />,
    );
    fireEvent.change(screen.getByLabelText("最终答案"), {
      target: { value: "42" },
    });
    expect(update).toHaveBeenCalledWith({ kind: "final", finalAnswer: "42" });
    expect(
      finalView.completion(
        finalModel,
        { kind: "final", finalAnswer: "" },
        true,
      ),
    ).toEqual({ state: "partial", filledSlots: 0, expectedSlots: 1 });
    expect(
      finalView.completion(
        finalModel,
        { kind: "final", finalAnswer: "" },
        false,
      ),
    ).toEqual({ state: "empty", filledSlots: 0, expectedSlots: 1 });
    expect(
      finalView.completion(
        finalModel,
        { kind: "final", finalAnswer: "42" },
        false,
      ),
    ).toEqual({ state: "filled", filledSlots: 1, expectedSlots: 1 });
  });

  it("填空完整度按有效空位计：额外数组项不能填补空位（I06/§7.1）", () => {
    expect(
      fillView.completion(
        fillModel,
        { kind: "fill", values: ["", "x", "多余"] },
        false,
      ),
    ).toEqual({ state: "partial", filledSlots: 1, expectedSlots: 2 });
    expect(
      fillView.completion(
        fillModel,
        { kind: "fill", values: ["a", "b"] },
        false,
      ),
    ).toEqual({ state: "filled", filledSlots: 2, expectedSlots: 2 });
  });

  it("readonly 模式：输入禁用、本人答案原位保留、交互不触发变更（I08 运行时）", () => {
    render(
      <ProductionSurface
        views={productionViews}
        model={judgeModel}
        mode={{ mode: "readonly", answer: { kind: "judge", value: true } }}
      />,
    );
    const radio = screen.getByRole("radio", { name: "对" });
    expect(radio).toBeDisabled();
    expect(radio).toBeChecked(); // 已提交原位锁定：答案原位呈现
    fireEvent.click(radio);
    expect(screen.getByRole("radio", { name: "对" })).toBeChecked();
  });

  it("public-base 模式：中性呈现，无本人答案选中态（I08/I09 数据面）", () => {
    render(
      <ProductionSurface
        views={productionViews}
        model={choiceModel}
        mode={{ mode: "public-base" }}
      />,
    );
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    for (const radio of radios) {
      expect(radio).not.toBeChecked();
    }
  });

  it("public-base 填空：内层中性绑定遮蔽外层真实答案（§8.2 公开副本）", () => {
    render(
      <SlotsProvider
        scopeId="q-fill"
        disabled={false}
        get={() => ({ value: "真实答案", onChange: () => {}, disabled: false })}
      >
        <fillView.Input
          model={fillModel}
          answer={undefined}
          update={STABLE_NOOP_UPDATE}
          disabled
        />
      </SlotsProvider>,
    );
    const input = screen.getByLabelText("第1空");
    expect(input).toHaveValue(""); // 不继承外层真实答案
    expect(input).toBeDisabled(); // 锁定：无更新能力
  });

  it("双作用域槽位：同名 slotId 跨题独立绑定（§8.2 槽位身份 = (scopeId, slotId)）", () => {
    const updateA = vi.fn();
    const updateB = vi.fn();
    render(
      <div>
        <fillView.Input
          model={{ ...fillModel, scopeId: "q-1" }}
          answer={{ kind: "fill", values: ["", ""] }}
          update={updateA}
        />
        <fillView.Input
          model={{ ...fillModel, scopeId: "q-2" }}
          answer={{ kind: "fill", values: ["", ""] }}
          update={updateB}
        />
      </div>,
    );
    const first = screen.getAllByLabelText("第1空")[0];
    const second = screen.getAllByLabelText("第1空")[1];
    if (first === undefined || second === undefined) {
      throw new Error("双作用域渲染应各有一个第1空输入");
    }
    fireEvent.change(first, { target: { value: "题一的答案" } });
    expect(updateA).toHaveBeenCalledWith(
      { kind: "fill", values: ["题一的答案", ""] },
      true,
    );
    expect(updateB).not.toHaveBeenCalled(); // 题二不受影响
    expect(second).toHaveValue("");
  });

  it("双作用域槽位：独立锁定——题一禁用不影响题二（不同题提交锁定）", () => {
    render(
      <div>
        <fillView.Input
          model={{ ...fillModel, scopeId: "q-1" }}
          answer={{ kind: "fill", values: ["甲", ""] }}
          update={() => {}}
          disabled
        />
        <fillView.Input
          model={{ ...fillModel, scopeId: "q-2" }}
          answer={{ kind: "fill", values: ["", ""] }}
          update={() => {}}
        />
      </div>,
    );
    const inputs = screen.getAllByLabelText("第1空");
    expect(inputs[0]).toBeDisabled();
    expect(inputs[1]).toBeEnabled();
  });

  it("槽位显式 null / 作用域不匹配：渲染展示空框而非输入控件（§8.2）", () => {
    const { unmount } = render(
      <SlotsProvider scopeId="q-1" disabled={false} get={() => null}>
        <SlotInput
          scopeId="q-1"
          slotId="slot-1"
          slotKind="text"
          label="第1空"
        />
      </SlotsProvider>,
    );
    expect(screen.getByLabelText("第1空").tagName).toBe("SPAN");
    unmount();
    render(
      <SlotsProvider
        scopeId="q-other"
        disabled={false}
        get={() => ({ value: "x", onChange: () => {}, disabled: false })}
      >
        <SlotInput
          scopeId="q-1"
          slotId="slot-1"
          slotKind="text"
          label="异域空"
        />
      </SlotsProvider>,
    );
    expect(screen.getByLabelText("异域空").tagName).toBe("SPAN");
  });

  it("排序输入：ID 映射正文按序列渲染，固定项锁定且无移动按钮（演练）", () => {
    const update = vi.fn();
    render(
      <orderingView.Input
        model={orderingModel}
        answer={{ kind: "fake-ordering", itemKeys: ["it-3", "it-1"] }}
        update={update}
      />,
    );
    // ID→正文：渲染的是结构里的正文而不是裸 ID
    expect(
      screen.getByText("Rinse the burette with the standard solution."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Record the initial reading of the burette."),
    ).toBeInTheDocument();
    // 固定项：有锁定标记、无上移按钮
    expect(screen.getByLabelText("固定项")).toBeInTheDocument();
    expect(
      screen.queryByLabelText(
        "上移 Rinse the burette with the standard solution.",
      ),
    ).toBeNull();
    expect(
      screen.getByLabelText("上移 Record the initial reading of the burette."),
    ).toBeInTheDocument();
    // 待放置区：非固定非干扰项有放入入口；干扰项可见但不提供放入
    expect(
      screen.getByRole("button", {
        name: "放入 Add the indicator to the flask.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("（干扰项，请勿选用）")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Heat the flask/ })).toBeNull();
  });

  it("排序移动：与最近非固定邻居交换；固定项不可被越过（演练）", () => {
    const update = vi.fn();
    render(
      <orderingView.Input
        model={orderingModel}
        answer={{ kind: "fake-ordering", itemKeys: ["it-3", "it-1", "it-2"] }}
        update={update}
      />,
    );
    // it-2（位置 2）上移 → 与 it-1（位置 1，非固定）交换
    fireEvent.click(
      screen.getByLabelText("上移 Add the indicator to the flask."),
    );
    expect(update).toHaveBeenCalledWith({
      kind: "fake-ordering",
      itemKeys: ["it-3", "it-2", "it-1"],
    });
    // it-1（位置 1）上移 → 目标位置 0 是固定项 it-3，无可交换位 → 不触发更新
    update.mockClear();
    fireEvent.click(
      screen.getByLabelText("上移 Record the initial reading of the burette."),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("排序放入：新项追加到序列末尾（部分序列 = 草稿，合法）", () => {
    const update = vi.fn();
    render(
      <orderingView.Input
        model={orderingModel}
        answer={{ kind: "fake-ordering", itemKeys: ["it-3"] }}
        update={update}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "放入 Add the indicator to the flask.",
      }),
    );
    expect(update).toHaveBeenCalledWith({
      kind: "fake-ordering",
      itemKeys: ["it-3", "it-2"],
    });
  });

  it("排序只读与公开副本：锁定无更新入口，公开副本无本人答案（演练）", () => {
    const update = vi.fn();
    const { unmount } = render(
      <orderingView.Input
        model={orderingModel}
        answer={{ kind: "fake-ordering", itemKeys: ["it-3", "it-1"] }}
        update={update}
        disabled
      />,
    );
    expect(
      screen.queryByLabelText(
        "上移 Record the initial reading of the burette.",
      ),
    ).toBeNull(); // 锁定态不渲染移动按钮
    unmount();
    render(
      <orderingView.Input
        model={orderingModel}
        answer={undefined}
        update={update}
        disabled
      />,
    );
    // 序列区为空：无本人答案（待放置区用 div 不产生 listitem）
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "放入 Add the indicator to the flask.",
      }),
    ).toBeDisabled();
  });

  it("排序只读材料与参考：本人序/参考序按正文呈现（演练）", () => {
    const { unmount } = render(
      <orderingView.ReadOnly
        model={orderingModel}
        answer={{ kind: "fake-ordering", itemKeys: ["it-3", "it-2"] }}
      />,
    );
    const items = screen.getByLabelText("本人排序").querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe(
      "Rinse the burette with the standard solution.",
    );
    unmount();
    render(
      <orderingView.Reference
        model={orderingModel}
        reference={{
          kind: "fake-ordering",
          sequence: ["it-3", "it-2", "it-1", "it-4"],
        }}
      />,
    );
    expect(
      screen.getByLabelText("参考排序").querySelectorAll("li"),
    ).toHaveLength(4);
  });

  it("排序对照：本人序与参考序逐位对齐，服务端判定只显示（演练）", () => {
    render(
      <orderingView.Comparison
        model={orderingModel}
        answer={{ kind: "fake-ordering", itemKeys: ["it-3", "it-2"] }}
        reference={{
          kind: "fake-ordering",
          sequence: ["it-3", "it-2", "it-1", "it-4"],
        }}
        verdicts={{ byKey: { "1": "correct", "2": "correct" } }}
      />,
    );
    const rows = screen
      .getByLabelText("排序对照")
      .querySelectorAll('[data-slot="ordering-compare-row"]');
    expect(rows).toHaveLength(4); // 行数 = max(本人序, 参考序)
    expect(rows[0]?.textContent).toContain("Rinse the burette");
    expect(rows[0]?.textContent).toContain("对");
    expect(rows[2]?.textContent).toContain("未放");
  });

  it("排序完整度：已放项/应放项（非干扰项数），干扰项不计入（演练）", () => {
    expect(
      orderingView.completion(
        orderingModel,
        { kind: "fake-ordering", itemKeys: ["it-3", "it-2"] },
        false,
      ),
    ).toEqual({ state: "partial", filledSlots: 2, expectedSlots: 4 });
    expect(
      orderingView.completion(
        orderingModel,
        { kind: "fake-ordering", itemKeys: ["it-3", "it-2", "it-1", "it-4"] },
        false,
      ),
    ).toEqual({ state: "filled", filledSlots: 4, expectedSlots: 4 });
    expect(orderingView.completion(orderingModel, undefined, false)).toEqual({
      state: "empty",
      filledSlots: 0,
      expectedSlots: 4,
    });
  });

  it("配对输入：下拉选项来自选项池正文，部分配对草稿合法（演练）", () => {
    const update = vi.fn();
    const { rerender } = render(
      <matchingView.Input
        model={matchingModel}
        answer={{ kind: "fake-matching", pairs: { "slot-1": "opt-1" } }}
        update={update}
      />,
    );
    const second = screen.getByLabelText("第二空");
    const options = Array.from((second as HTMLSelectElement).options).map(
      (option) => option.text,
    );
    expect(options).toEqual([
      "未选择",
      "深度睡眠清理废物蛋白",
      "以少睡为荣即以劣绩为荣",
      "尊重这张床：只用来睡觉",
      "干扰选项",
    ]);
    fireEvent.change(second, { target: { value: "opt-3" } });
    expect(update).toHaveBeenCalledWith({
      kind: "fake-matching",
      pairs: { "slot-1": "opt-1", "slot-2": "opt-3" },
    });
    // 宿主按新答案重渲染后清空第一空：键不写入（部分配对的草稿表示）
    rerender(
      <matchingView.Input
        model={matchingModel}
        answer={{
          kind: "fake-matching",
          pairs: { "slot-1": "opt-1", "slot-2": "opt-3" },
        }}
        update={update}
      />,
    );
    fireEvent.change(screen.getByLabelText("第一空"), {
      target: { value: "" },
    });
    expect(update).toHaveBeenLastCalledWith({
      kind: "fake-matching",
      pairs: { "slot-2": "opt-3" },
    });
  });

  it("配对重复约束：allowRepeat=false 同选项多槽标记，true 不标记（演练）", () => {
    const update = vi.fn();
    const answer: FakeMatchingAnswer = {
      kind: "fake-matching",
      pairs: { "slot-1": "opt-1", "slot-2": "opt-1" },
    };
    const { unmount } = render(
      <matchingView.Input
        model={matchingModel}
        answer={answer}
        update={update}
      />,
    );
    expect(screen.getAllByLabelText("重复占用")).toHaveLength(2);
    unmount();
    render(
      <matchingView.Input
        model={{ ...matchingModel, allowRepeat: true }}
        answer={answer}
        update={update}
      />,
    );
    expect(screen.queryByLabelText("重复占用")).toBeNull();
  });

  it("填空对照：历史多余项有独立行，参考等价答案「或」连接（现状口径）", () => {
    render(
      <fillView.Comparison
        model={fillModel}
        answer={{ kind: "fill", values: ["甲", "", "历史多余"] }}
        reference={{ kind: "fill", blanks: [["0.5", "1/2"], ["x"]] }}
        verdicts={{ byKey: { "1": "correct" } }}
      />,
    );
    const rows = screen
      .getByLabelText("填空对照")
      .querySelectorAll('[data-slot="fill-compare-row"]');
    expect(rows).toHaveLength(3); // max(2 空位, 3 本人项, 2 参考)：多余项有独立行
    expect(rows[0]?.textContent).toContain("0.5 或 1/2");
    expect(rows[0]?.textContent).toContain("对");
    expect(rows[1]?.textContent).toContain("未填");
    expect(rows[2]?.textContent).toContain("历史多余");
  });

  it("错配参考：兼容宿主按参考自身 kind 呈现，不崩溃不改写（现状策略保持）", () => {
    render(
      <CompatReferenceFallback
        model={fillModel}
        reference={{ kind: "choice", index: 0 }}
      />,
    );
    expect(screen.getByText("A")).toBeInTheDocument(); // formatQuestionAnswers(choice)
  });

  it("参考材料宿主分支：未公布锁定、无参考空态（现状文案保持）", () => {
    const { unmount } = render(
      <ReferencePanel
        material={{ state: "unavailable" }}
        render={() => <span>不应渲染</span>}
      />,
    );
    expect(
      screen.getByText("参考答案与详解将在截止后公布 🔒"),
    ).toBeInTheDocument();
    unmount();
    render(
      <ReferencePanel
        material={{ state: "available", reference: null }}
        render={() => <span>不应渲染</span>}
      />,
    );
    expect(screen.getByText("暂无参考答案")).toBeInTheDocument();
  });

  it("演练登记表：生产视图在扩展联合下原样复用（I17 方向）", () => {
    render(
      <drillViews.judge.Input
        model={judgeModel}
        answer={{ kind: "judge", value: false }}
        update={() => {}}
      />,
    );
    expect(screen.getByRole("radio", { name: "错" })).toBeChecked();
  });
});
