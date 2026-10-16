import type { AiChannel } from "@tutor/contract";
import { Button } from "@/components/ui/button";
import { CHANNEL_LABEL } from "./ai-channel-label";
import { useStudentQuickButtons } from "./quick-buttons-queries";
import {
  type AiSendController,
  EMPTY_AI_SELECTION,
  studentModeReasonText,
} from "./use-ai-send-controller";

/**
 * SAI-20 伴学栏会话组件（B11 顺序实施第 3、4 条的视图侧）：
 * - AiCompanionStatusPanel：顶部题号/模式原因/通道/当前快照。通道为本地
 *   会话选择（换通道零出站、不重发）；需要设置（未连接/需首次知情）时给
 *   设置入口且如实禁用发送（引导去设置，回题不自动出站）。
 * - AiCompanionQuickButtons：仅渲染启用项，点击即发（用其 prompt 与附件
 *   偏好，单次语义——不回写草稿选择，也不产生第二个同义「发送」按钮）。
 * - AiCompanionComposer：按题输入区（正文/附件选择）。主按钮按通道显示
 *   发送/加入求助队列/复制链接，全栏只有一个主动作；模式被教师关闭时
 *   按钮保持可点——点击即给出原因并刷新状态（见控制器第 7 条）。
 * 输入隔离、幂等重试、在途守卫与迟到回执守卫都在 useAiSendController；
 * 本文件只做呈现与转发，路由往返见 route-integration。
 */

/** 手写题的纸面材料名（正式手写）；其余题型的纸面材料为「草稿」 */
export const FORMAL_INK_PAPER_LABEL = "正式手写";
/** 非手写题的纸面材料名（草稿纸面） */
export const DRAFT_PAPER_LABEL = "草稿";

/** 本地会话可切换的通道（link 的票据流归 SAI-28/B15，先不提供切换项） */
const SWITCHABLE_CHANNELS: readonly AiChannel[] = ["inapp", "mcp"];

/** 主按钮按通道换文案（单主动作，不出现两个同义按钮） */
function mainActionLabel(channel: AiChannel | null): string {
  if (channel === "mcp") return "加入求助队列";
  if (channel === "link") return "复制链接";
  return "发送";
}

/**
 * 顶部状态区：题号（可选，由接线方按绑定题提供）、模式原因、通道与
 * 本题任务快照。只读呈现，不产生任何任务调用。
 */
export function AiCompanionStatusPanel({
  send,
  settingsHref,
  questionLabel,
}: {
  send: AiSendController;
  /** 连接设置入口（含 ?from= 回跳原题路径） */
  settingsHref: string;
  /** 绑定题的显示名（如「第 3 题」）；接线方未提供时不显示题号行 */
  questionLabel?: string | null;
}) {
  const { status } = send;
  return (
    <div className="flex flex-col gap-1">
      {questionLabel != null && (
        <p className="text-xs font-medium">{questionLabel}</p>
      )}
      {send.statusLoading ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          正在确认 AI 状态…
        </p>
      ) : send.statusError ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            AI 状态读取失败，无法确认当前设置
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-9 self-start px-2"
            onClick={() => send.refreshStatus()}
          >
            重试读取
          </Button>
        </div>
      ) : status === undefined ? null : (
        <>
          <p className="text-xs text-muted-foreground">
            {studentModeReasonText(status)}
          </p>
          <p className="text-xs text-muted-foreground">
            {send.channelOverride !== null
              ? `通道：${CHANNEL_LABEL[send.channelOverride]}`
              : `默认：${
                  status.channelDefault === null
                    ? "未配置"
                    : CHANNEL_LABEL[status.channelDefault]
                }`}
          </p>
          {send.needsSetup ? (
            // 无可用连接/需首次知情：给设置入口，主动作由输入区如实禁用
            <a
              href={settingsHref}
              className="min-h-11 self-start text-xs font-medium text-primary underline-offset-4 hover:underline"
            >
              去设置连接
            </a>
          ) : (
            // 通道为本地会话选择：换通道零出站，在途任务保持创建时通道
            <fieldset aria-label="选择通道" className="flex flex-wrap gap-1">
              {SWITCHABLE_CHANNELS.map((channel) => (
                <Button
                  key={channel}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-9 px-2"
                  aria-pressed={send.effectiveChannel === channel}
                  onClick={() => send.setChannelOverride(channel)}
                >
                  {CHANNEL_LABEL[channel]}
                </Button>
              ))}
            </fieldset>
          )}
          {status.taskSummary.total > 0 && (
            <p className="text-xs text-muted-foreground">
              本题已求助 {status.taskSummary.total} 次
              {status.taskSummary.active > 0
                ? `，处理中 ${status.taskSummary.active}`
                : ""}
              {status.taskSummary.unreadReplies > 0
                ? `，未读回信 ${status.taskSummary.unreadReplies}`
                : ""}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 快捷按钮区：仅渲染启用项（停用项不出现），点击即发——用按钮自己的
 * prompt 与附件偏好，不回写本题的草稿选择（单次语义）。
 */
export function AiCompanionQuickButtons({ send }: { send: AiSendController }) {
  const query = useStudentQuickButtons();
  if (query.isPending)
    return (
      <p className="text-xs text-muted-foreground" aria-live="polite">
        正在载入快捷按钮…
      </p>
    );
  if (query.isError)
    return <p className="text-xs text-muted-foreground">快捷按钮读取失败</p>;
  const buttons = (query.data?.buttons ?? []).filter(
    (button) => button.enabled,
  );
  if (buttons.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        暂无启用的快捷按钮，可在设置中添加
      </p>
    );
  const disabled =
    send.boundQuestionId === null || send.sendState.phase === "sending";
  return (
    <div className="flex flex-wrap gap-1">
      {buttons.map((button) => (
        <Button
          key={button.id}
          type="button"
          variant="outline"
          size="sm"
          className="min-h-9 px-2"
          title={button.prompt}
          disabled={disabled}
          onClick={() => void send.send({ quick: button })}
        >
          {button.name}
        </Button>
      ))}
    </div>
  );
}

/**
 * 按题输入区：正文 + 附件选择（圈画 + 纸面材料）+ 主按钮。纸面材料按题型
 * 呈现——手写题为「正式手写」，其余为「草稿」（paperLabel 由接线方按绑定
 * 题题型给出，两值即本模块导出的两个常量）。
 */
export function AiCompanionComposer({
  send,
  paperLabel,
}: {
  send: AiSendController;
  paperLabel: string;
}) {
  const boundQuestionId = send.boundQuestionId;
  const bound = boundQuestionId !== null;
  // 未绑定时按空草稿呈现（输入全部禁用，不产生默认值副作用）
  const draft =
    boundQuestionId === null
      ? { text: "", selection: EMPTY_AI_SELECTION, presetId: null }
      : send.draftOf(boundQuestionId);
  // 纸面材料键随题型二选一：手写题采集正式手写，其余采集草稿
  const paperKind: "draft" | "formalInk" =
    paperLabel === FORMAL_INK_PAPER_LABEL ? "formalInk" : "draft";
  const sending = send.sendState.phase === "sending";
  // 失败/成功提示只对当前绑定题显示（切题不带旧题消息）
  const message =
    boundQuestionId !== null && send.sendState.questionId === boundQuestionId
      ? send.sendState.message
      : null;
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium">补充问题</span>
        <textarea
          rows={2}
          className="min-h-11 w-full resize-y rounded-lg border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          placeholder="写下你想问的问题"
          value={draft.text}
          disabled={!bound || sending}
          onChange={(event) => send.setText(event.target.value)}
        />
      </label>
      <fieldset
        aria-label="随信材料"
        className="flex flex-wrap items-center gap-x-3 gap-y-1"
      >
        <label className="flex min-h-9 items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            className="size-4"
            checked={draft.selection.annotation}
            disabled={!bound || sending}
            onChange={() => send.toggleMaterial("annotation")}
          />
          圈画
        </label>
        <label className="flex min-h-9 items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            className="size-4"
            checked={draft.selection[paperKind]}
            disabled={!bound || sending}
            onChange={() => send.toggleMaterial(paperKind)}
          />
          {paperLabel}
        </label>
      </fieldset>
      <Button
        type="button"
        className="min-h-11 w-full"
        disabled={!bound || sending || send.needsSetup}
        onClick={() => void send.send()}
      >
        {sending ? "发送中…" : mainActionLabel(send.effectiveChannel)}
      </Button>
      {message !== null && (
        <p
          role={send.sendState.phase === "failed" ? "alert" : "status"}
          className="text-xs text-muted-foreground"
        >
          {message}
        </p>
      )}
    </div>
  );
}
