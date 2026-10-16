import type {
  AiHelpQuestionFactsContract,
  AiTeacherTaskRecord,
} from "@tutor/contract";

/**
 * SAI-24 教师督学标签模型（B13；需求规格 §9.2）。
 *
 * 组合成教学标签是教师 UI 的职责（服务端摘要只输出事实分桶，SAI-14 完成条件
 * ②）。本模块是纯函数单源：
 * - 保留客观判分原值，标签旁置——对错/待批/分数不在本模型内；
 * - 无记录只说「无平台作答中求助记录」，不断言「独立完成」；任何标签不出现
 *   「盲区/重度/已获帮助」等推测性结论（B13 失败用例①）；
 * - 仅入队未外发 =「作答中求助·未处理」，不显示为确定获得 AI 帮助；
 * - 完成后求助 =「AI 复盘」，不染为作答中辅助；提交前发起、提交后才外发/
 *   回信如实呈现（SAI-14 摘要样例的教师侧口径）。
 */

/** 标签种类（供配色/图标分派；文字承担完整含义，颜色只是辅助） */
export type AiHelpLabelKind =
  | "none"
  | "review"
  | "queued"
  | "unknown-outbound"
  | "late-outbound"
  | "helped";

export interface AiHelpLabel {
  readonly kind: AiHelpLabelKind;
  /** 完整中文标签（颜色之外承担全部含义，§11 完成条件③） */
  readonly text: string;
}

/** 作答中出站任务的当时模式名（open_study → 开放；其余保守按仅启发） */
function modeNameOf(tasks: readonly AiTeacherTaskRecord[]): string {
  const relevant = tasks.filter((task) => task.beforeSubmit);
  const pool = relevant.length > 0 ? relevant : tasks;
  return pool.some((task) => task.modeAtSend === "open_study")
    ? "开放"
    : "仅启发";
}

/**
 * 单题标签：facts 为 undefined（无记录的题）或 requested=false 都按零态。
 * 四态可区分（失败用例②）：未处理 / 已外发·回信未到达 / 已回信·学生未查看 /
 * 已回信·学生已查看。
 */
export function aiHelpLabelOf(
  facts: AiHelpQuestionFactsContract | undefined,
  tasks: readonly AiTeacherTaskRecord[],
): AiHelpLabel {
  if (facts === undefined || !facts.requested) {
    return { kind: "none", text: "无平台作答中求助记录" };
  }
  if (!facts.requestedBeforeSubmit) {
    return { kind: "review", text: "AI 复盘（完成后求助，不计作答中辅助）" };
  }
  if (facts.queuedOnly) {
    return { kind: "queued", text: "作答中求助·未处理（仅入队未外发）" };
  }
  const gotBeforeSubmit =
    facts.dispatchedBeforeSubmit ||
    facts.repliedBeforeSubmit ||
    facts.platformOpenedBeforeSubmit ||
    facts.externalViewedUnknown;
  if (gotBeforeSubmit) {
    const state = facts.platformOpened
      ? "已回信·学生已查看"
      : facts.replyReceived
        ? "已回信·学生未查看"
        : facts.dispatched
          ? "已外发·回信未到达"
          : "外部读取情况未知";
    return {
      kind: "helped",
      text: `作答中 AI 求助（${modeNameOf(tasks)}）·${state}`,
    };
  }
  if (facts.outboundStatusUnknown) {
    return { kind: "unknown-outbound", text: "作答中求助·出站状态未确认" };
  }
  return {
    kind: "late-outbound",
    text: "作答中发起·提交后才外发或收到回信",
  };
}
