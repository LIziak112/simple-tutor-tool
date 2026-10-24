import type { PublicOption, PublicSlot, QuestionPublic } from "@tutor/contract";
import {
  emptyPublicStructure,
  matchingPublicStructureOf,
  optionsPublicStructureOf,
  orderingPublicStructureOf,
} from "@tutor/contract";
import { processor } from "@tutor/md-dsl";
import { blankSlotIdOf } from "@/features/markdown/directives/session-context";
import type { MdNode } from "@/features/markdown/remark/mdast-interop";
import { remarkBlank } from "@/features/markdown/remark/remark-blank";
import { remarkDirectiveHost } from "@/features/markdown/remark/remark-directive-host";
import { questionBindings } from "./question-binding";

/**
 * 公开内容 → PreparedQuestion 的准备入口（方案 §4.2/§8.1，UA-02 落地）。
 *
 * 该模型不是新的服务器真相：只持明确挑选的公开内容及对应结构，不保存参考
 * 答案、解析、学生草稿、回调、React 元素或控制器；答案变化不重新准备（I13）。
 * 入口必须来自现有服务端公开投影（QuestionPublic），按字段白名单构造，
 * 禁止 {...fullQuestion} 展开；questionRevisionId 等会话身份由宿主携带，
 * 准备过程不生成版本号。scopeId（题面实例标识，radio name 隔离与槽位作用域
 * 身份用）由宿主提供，不持久化（决策记录 §6.1 调整 4/5 后形态）。
 */

// ---------- 槽位结构分析（§8.1） ----------

/**
 * 单一槽位分析入口：复用现有渲染管线节点语义（processor.parse → remarkBlank
 * 把 [[…]] 转 blank 指令 → remarkDirectiveHost 按文档顺序编号），输出有序
 * 槽位 { slotId, slotKind, order }。禁止换成正则统计或另建空位识别规则；
 * 本函数与 RichMarkdown/BlankDirective 是同一套节点语义（I07 槽位统计与真实
 * 渲染同源）。纯函数、无缓存（缓存见 slotsOfQuestion）。
 */
export function analyzeSlots(stemMd: string): readonly PublicSlot[] {
  // 渲染器使用最小AST结构；remark扩展节点的data类型通过此边界适配。
  const tree = processor.parse(stemMd) as unknown as MdNode;
  remarkBlank()(tree);
  remarkDirectiveHost()(tree);
  const slots: PublicSlot[] = [];
  function visit(node: MdNode): void {
    if (
      node.name === "blank" &&
      typeof node.data?.hProperties?.index === "number" &&
      node.data.hProperties.index >= 1
    ) {
      const order = node.data.hProperties.index - 1; // 编号 1 起 → 旧数组下标 0 起
      slots.push({ slotId: blankSlotIdOf(order), slotKind: "text", order });
    }
    node.children?.forEach(visit);
  }
  visit(tree);
  return slots;
}

/** 按题目对象身份缓存的分析结果（I13：同一公开题目对象不因每次输入重新解析） */
const slotsByQuestion = new WeakMap<QuestionPublic, readonly PublicSlot[]>();

/**
 * 带缓存的槽位分析：缓存沿用对象身份 WeakMap（是否改为公开内容哈希留待有
 * 性能证据时单独决定，§8.1）；只存无答案派生结构，不混入账号/attempt 级数据。
 */
export function slotsOfQuestion(
  question: QuestionPublic,
): readonly PublicSlot[] {
  const cached = slotsByQuestion.get(question);
  if (cached !== undefined) return cached;
  const slots = analyzeSlots(question.stemMd);
  slotsByQuestion.set(question, slots);
  return slots;
}

/**
 * 预期空位数：与迁移前 countSlots 口径逐字一致——取空位编号最大值而非槽位
 * 个数（嵌套 question 指令会重置空位计数的历史病理性内容下，两者不同；
 * 完整度口径不随本次迁移改变）。正常连续编号时等于槽位个数。
 */
export function expectedSlotCountOf(slots: readonly PublicSlot[]): number {
  return slots.reduce((max, slot) => Math.max(max, slot.order + 1), 0);
}

// ---------- 派生模型 PreparedQuestion（§4.2） ----------

/** 判断题尾部空标记的展示方式（studentStemMd 投影把 [[答案]] 脱敏成 [[]]） */
export type JudgeTailMarker = "paren" | "none";

/**
 * 公开上下文引用（QM-08 材料/题组预留）：只存引用 id 不复制内容；本阶段无
 * 生产构造方，形态由 QM-08 落地时收紧，prepareQuestion 原样透传。
 */
export interface PreparedQuestionContext {
  readonly materialIds: readonly string[];
}

/** 以 kind 判别的只读公开模型（不是新的服务器真相，见文件头） */
export type PreparedQuestion =
  | {
      readonly kind: "judge";
      readonly scopeId: string;
      readonly stemMd: string;
      /** 尾部空标记展示方式：paren=渲染为「（　）」（与 judgeStemOf 同口径检测） */
      readonly tailMarker: JudgeTailMarker;
      readonly context?: PreparedQuestionContext;
    }
  | {
      readonly kind: "choice";
      readonly scopeId: string;
      readonly stemMd: string;
      /** 选项项 {key,index,text}；旧题 key 由序号派生（opt-0…，§4.2） */
      readonly options: readonly PublicOption[];
      readonly context?: PreparedQuestionContext;
    }
  | {
      readonly kind: "multi";
      readonly scopeId: string;
      readonly stemMd: string;
      readonly options: readonly PublicOption[];
      readonly context?: PreparedQuestionContext;
    }
  | {
      readonly kind: "fill";
      readonly scopeId: string;
      readonly stemMd: string;
      /** 有序槽位（§8.1 analyzeSlots 产物；slotId 由序号派生 slot-1…） */
      readonly slots: readonly PublicSlot[];
      readonly context?: PreparedQuestionContext;
    }
  | {
      readonly kind: "final";
      readonly scopeId: string;
      readonly stemMd: string;
      /** 既有最终答案输入描述（FinalAnswerInput 的公开形态：默认标签） */
      readonly finalInput: { readonly label: string };
      readonly context?: PreparedQuestionContext;
    }
  | {
      readonly kind: "response";
      readonly scopeId: string;
      readonly stemMd: string;
      /**
       * 字数建议提示（word-min/word-max，§5.4.1 仅提示不硬校验不截断）；
       * 旧题不携带两键。字数口径单源在契约 countResponseWords。
       */
      readonly wordMin?: number;
      readonly wordMax?: number;
      readonly context?: PreparedQuestionContext;
    }
  | {
      readonly kind: "matching";
      readonly scopeId: string;
      readonly stemMd: string;
      /**
       * matching 公开结构（QM-13 细项 2）：选项池（key/text/distractor——干扰
       * 项在池内可选，§6.1 调整 6）+ 服务端展开的有序槽位集合 + 是否允许重复。
       * 结构不可用（投影防御形态）= 空池空槽，视图显式报错不静默降级。
       */
      readonly options: readonly {
        readonly key: string;
        readonly text: string;
        readonly distractor: boolean;
      }[];
      readonly slotIds: readonly string[];
      readonly allowRepeat: boolean;
      readonly context?: PreparedQuestionContext;
    }
  | {
      readonly kind: "ordering";
      readonly scopeId: string;
      readonly stemMd: string;
      /**
       * ordering 公开结构（QM-13 细项 3）：排序项（key/text/fixedPosition/
       * distractor——固定位与干扰项标记属公开结构，§6.1 调整 3/6）。结构
       * 不可用（投影防御形态）= 空项，视图显式报错不静默降级。
       */
      readonly items: readonly {
        readonly key: string;
        readonly text: string;
        readonly fixedPosition: number | null;
        readonly distractor: boolean;
      }[];
      readonly context?: PreparedQuestionContext;
    };

/** 与 QuestionSurface judgeStemOf 的替换正则同口径（题面呈现形态由视图执行） */
const JUDGE_TAIL_MARKER_RE = /\s*\[\[\]\]\s*$/;

function judgeTailMarkerOf(stemMd: string): JudgeTailMarker {
  return JUDGE_TAIL_MARKER_RE.test(stemMd) ? "paren" : "none";
}

/**
 * 判断题题干的显示形态：尾部空标记（studentStemMd 投影把 [[答案]] 脱敏成
 * [[]]）替换为「（　）」——与迁移前 QuestionSurface judgeStemOf 逐字一致；
 * 无尾部标记时不匹配不变。与 tailMarker 检测共用同一正则（单源）。
 */
export function judgeDisplayStemOf(stemMd: string): string {
  return stemMd.replace(JUDGE_TAIL_MARKER_RE, "（　）");
}

/** exactOptionalPropertyTypes：未传 context 时不设键 */
function withContext<P extends PreparedQuestion>(
  prepared: P,
  context: PreparedQuestionContext | undefined,
): P {
  return context === undefined ? prepared : { ...prepared, context };
}

/**
 * 公开题目 → PreparedQuestion。按 questionBindings 的 answerKind 中央分发后
 * 逐形态白名单构造（本函数是准备层的唯一分发边界，登记表呈现接入后由
 * dispatchView 消费；调度边界以外不得新增 kind/题型分支，I16）。
 */
export function prepareQuestion(
  question: QuestionPublic,
  scopeId: string,
  context?: PreparedQuestionContext,
): PreparedQuestion {
  const { answerKind } = questionBindings[question.type];
  switch (answerKind) {
    case "judge":
      return withContext(
        {
          kind: "judge",
          scopeId,
          stemMd: question.stemMd,
          tailMarker: judgeTailMarkerOf(question.stemMd),
        },
        context,
      );
    case "choice":
      return withContext(
        {
          kind: "choice",
          scopeId,
          stemMd: question.stemMd,
          // 旧题选项 key 由序号派生（opt-0…），答案格式不变仍存 index
          options: optionsPublicStructureOf(question.options ?? []).options,
        },
        context,
      );
    case "multi":
      return withContext(
        {
          kind: "multi",
          scopeId,
          stemMd: question.stemMd,
          options: optionsPublicStructureOf(question.options ?? []).options,
        },
        context,
      );
    case "fill":
      return withContext(
        {
          kind: "fill",
          scopeId,
          stemMd: question.stemMd,
          slots: slotsOfQuestion(question),
        },
        context,
      );
    case "final":
      return withContext(
        {
          kind: "final",
          scopeId,
          stemMd: question.stemMd,
          // 既有最终答案输入（FinalAnswerInput）的固定公开形态
          finalInput: { label: "最终答案" },
        },
        context,
      );
    case "response":
      // QM-09 细项1：开放作答（可选标题 + 多行正文 + 正式手写并存）。
      // 字数建议两键缺省不携带（exactOptionalPropertyTypes 不设键）
      return withContext(
        {
          kind: "response",
          scopeId,
          stemMd: question.stemMd,
          ...(question.wordMin !== undefined && { wordMin: question.wordMin }),
          ...(question.wordMax !== undefined && { wordMax: question.wordMax }),
        },
        context,
      );
    case "matching":
      // QM-13 细项 2：选项池 + 服务端展开的槽位集合（MatchingPublicStructure
      // 构造入口单源）；结构缺失走空结构防御形态（视图显式报错，§7.1）
      return withContext(
        question.matchingOptions !== undefined &&
          question.matchingSlots !== undefined
          ? {
              kind: "matching",
              scopeId,
              stemMd: question.stemMd,
              ...matchingPublicStructureOf(
                question.matchingOptions,
                question.matchingSlots,
              ),
            }
          : {
              kind: "matching",
              scopeId,
              stemMd: question.stemMd,
              ...emptyPublicStructure.matching,
            },
        context,
      );
    case "ordering":
      // QM-13 细项 3：排序项（OrderingPublicStructure 构造入口单源）
      return withContext(
        question.orderingItems !== undefined
          ? {
              kind: "ordering",
              scopeId,
              stemMd: question.stemMd,
              ...orderingPublicStructureOf(question.orderingItems),
            }
          : {
              kind: "ordering",
              scopeId,
              stemMd: question.stemMd,
              ...emptyPublicStructure.ordering,
            },
        context,
      );
  }
}
