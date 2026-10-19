import type { AiChannel, StudentQuickButton } from "@tutor/contract";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { AiLinkShareBox } from "./AiLinkShareBox";
import { CHANNEL_LABEL } from "./ai-channel-label";
import { useStudentQuickButtons } from "./quick-buttons-queries";
import {
  type AiMaterialAvailability,
  type AiSendController,
  DEFAULT_AI_MATERIALS,
  EMPTY_AI_SELECTION,
  studentModeReasonText,
} from "./use-ai-send-controller";

/**
 * SAI-20 伴学栏会话组件（B11 顺序实施第 3、4 条的视图侧）：
 * - AiCompanionStatusPanel：顶部题号/模式原因/通道/当前快照。通道为本地
 *   会话选择（换通道零出站、不重发）；需要设置（未连接/需首次知情）时给
 *   设置入口且如实禁用发送（引导去设置，回题不自动出站）。
 * - AiCompanionQuickButtons：仅渲染启用项，点击只填入当前题提问框；实际
 *   出站统一由主按钮执行，避免快捷按钮绕过用户确认。
 * - AiCompanionComposer：按题输入区（正文/附件选择）。主按钮按通道显示
 *   发送/加入求助队列/复制链接，全栏只有一个主动作；模式被教师关闭时
 *   按钮保持可点——点击即给出原因并刷新状态（见控制器第 7 条）。
 * 输入隔离、幂等重试、在途守卫与迟到回执守卫都在 useAiSendController；
 * 本文件只做呈现与转发，路由往返见 route-integration。
 */

export const DEFAULT_HELP_PROMPT = "请给我一点提示，帮助我自己试出下一步。";

/** 手写题的纸面材料名（正式手写）；其余题型的纸面材料为「草稿」 */
export const FORMAL_INK_PAPER_LABEL = "正式手写";
/** 非手写题的纸面材料名（草稿纸面） */
export const DRAFT_PAPER_LABEL = "草稿";

/** 本地会话可切换的通道（SAI-30 起含 link：票据流见 use-ai-send-controller） */
const SWITCHABLE_CHANNELS: readonly AiChannel[] = ["inapp", "mcp", "link"];

/** 主按钮按通道换文案（单主动作，不出现两个同义按钮） */
function mainActionLabel(channel: AiChannel | null): string {
  if (channel === "mcp") return "加入求助队列";
  if (channel === "link") return "复制 AI 链接";
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
            className="min-h-11 self-start px-2"
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
            <Link
              to={settingsHref}
              className="min-h-11 self-start text-xs font-medium text-primary underline-offset-4 hover:underline"
            >
              去设置连接
            </Link>
          ) : (
            // 通道为本地会话选择：换通道零出站，在途任务保持创建时通道
            <fieldset aria-label="选择通道" className="flex flex-wrap gap-1">
              {SWITCHABLE_CHANNELS.map((channel) => (
                <Button
                  key={channel}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 px-2"
                  aria-pressed={send.effectiveChannel === channel}
                  onClick={() => send.setChannelOverride(channel)}
                >
                  {CHANNEL_LABEL[channel]}
                </Button>
              ))}
            </fieldset>
          )}
          {!send.needsSetup && (
            <Link
              to={settingsHref}
              className="flex min-h-11 self-start items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              管理 AI 连接
            </Link>
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
 * 快捷问法作为意图独立保存，保留学生自写问题；选择阶段不发送。
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
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">
          快捷问法读取失败，也可以直接输入问题。
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => void query.refetch()}
        >
          重新加载问法
        </Button>
      </div>
    );
  const buttons = (query.data?.buttons ?? []).filter(
    (button) => button.enabled,
  );
  if (buttons.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        默认给一点提示，也可以直接补充问题。
      </p>
    );
  const disabled =
    send.boundQuestionId === null || send.sendState.phase === "sending";
  const renderButton = (button: StudentQuickButton) => (
    <Button
      key={button.id}
      type="button"
      variant="outline"
      size="sm"
      className="min-h-11 px-3"
      title={button.prompt}
      disabled={disabled}
      aria-pressed={
        send.boundQuestionId !== null &&
        send.draftOf(send.boundQuestionId).presetId === button.id
      }
      onClick={() => send.selectPreset(button.id, button.prompt)}
    >
      {button.name}
    </Button>
  );
  return (
    <div className="flex flex-wrap gap-2">
      {buttons.slice(0, 2).map(renderButton)}
      {buttons.length > 2 && (
        <details className="min-w-0">
          <summary className="flex min-h-11 cursor-pointer items-center rounded-lg border border-border px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring">
            更多问法
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {buttons.slice(2).map(renderButton)}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * 按题输入区：正文 + 附件选择（圈画 + 纸面材料）+ 主按钮。纸面材料按题型
 * 呈现——手写题为「正式手写」，其余为「草稿」（paperLabel 由接线方按绑定
 * 题题型给出，两值即本模块导出的两个常量）。材料可选面（SAI-22）：讲练
 * 题卡无圈画层 → 只呈纸面；结果页复盘不采集 → 整组隐藏（纯文字求助）。
 */
export function AiCompanionComposer({
  send,
  paperLabel,
  questionLabel = null,
  materials = DEFAULT_AI_MATERIALS,
}: {
  send: AiSendController;
  paperLabel: string;
  /** 绑定题显示名（链接结果区呈现题号，帮助识别缓存旧内容） */
  questionLabel?: string | null;
  /** 材料可选面（缺省圈画+纸面）；控制器侧同口径过滤为双保险 */
  materials?: AiMaterialAvailability | undefined;
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
      <p className="text-sm text-muted-foreground">
        本次会发送：题目与当前作答{draft.selection.annotation ? " · 圈画" : ""}
        {draft.selection[paperKind] ? ` · ${paperLabel}（发送时核对）` : ""}
      </p>
      <p className="text-sm font-medium">
        问法：{draft.intentPrompt ?? DEFAULT_HELP_PROMPT}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[min(100%,12rem)] flex-1">
          <span className="sr-only">补充问题</span>
          <textarea
            rows={2}
            className="max-h-40 min-h-11 w-full resize-none rounded-xl border border-input bg-background px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            placeholder="补充卡住的地方（可不填）"
            value={draft.text}
            disabled={!bound || sending}
            onChange={(event) => send.setText(event.target.value)}
          />
        </label>
        <Button
          type="button"
          className="min-h-11 shrink-0 px-4"
          disabled={!bound || sending || send.needsSetup}
          onClick={() => {
            // link 通道且当前题已有链接、正文为空：主按钮「复制 AI 链接」做它
            // 说的事（重试复制），不落进空正文拦截把成功提示覆盖成失败告警；
            // 写了新正文则照常新发送（新任务新快照）
            if (
              send.effectiveChannel === "link" &&
              boundQuestionId !== null &&
              send.linkShare?.questionId === boundQuestionId &&
              draft.text.trim() === ""
            ) {
              void send.retryCopyLink();
              return;
            }
            const prompt = draft.intentPrompt;
            void send.send({
              requireSteps: draft.presetId === "check-current",
              questionText: prompt
                ? `${prompt}${draft.text.trim() ? `\n\n我的问题：${draft.text.trim()}` : ""}`
                : draft.text.trim() || DEFAULT_HELP_PROMPT,
            });
          }}
        >
          {sending ? "发送中…" : mainActionLabel(send.effectiveChannel)}
        </Button>
      </div>
      {(materials.annotation || materials.paper) && (
        <fieldset
          aria-label="随信材料"
          className="flex flex-wrap items-center gap-x-4 gap-y-1"
        >
          {materials.annotation && (
            <label className="flex min-h-11 items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={draft.selection.annotation}
                disabled={!bound || sending}
                onChange={() => send.toggleMaterial("annotation")}
              />
              圈画
            </label>
          )}
          {materials.paper && (
            <label className="flex min-h-11 items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={draft.selection[paperKind]}
                disabled={!bound || sending}
                onChange={() => send.toggleMaterial(paperKind)}
              />
              {paperLabel}
            </label>
          )}
        </fieldset>
      )}
      {message !== null && (
        <p
          role={send.sendState.phase === "failed" ? "alert" : "status"}
          className="text-xs text-muted-foreground"
        >
          {message}
        </p>
      )}
      {/* 链接通道结果区（SAI-30）：题级匹配才呈现（换题不携带上一题链接）；
          key=URL——重新生成即重挂，降级区不残留旧票据解析内容 */}
      {bound && send.linkShare?.questionId === boundQuestionId && (
        <AiLinkShareBox
          key={send.linkShare.url}
          questionLabel={questionLabel}
          link={send.linkShare}
          sending={sending}
          onRegenerate={() => void send.regenerateLink()}
          onRevoke={() => void send.revokeLink()}
          onRetryCopy={() => void send.retryCopyLink()}
        />
      )}
    </div>
  );
}
