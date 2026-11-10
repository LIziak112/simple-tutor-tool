import type { MemoAnchor, MemoKind } from "@tutor/contract";
import {
  formatMemoDuration,
  MEMO_ANCHOR_NONE,
  MEMO_IMAGE_MAX_BYTES,
  MEMO_TAGS_MAX,
  MEMO_TEXT_MAX,
  normalizeMemoTags,
} from "@tutor/contract";
import {
  ImagePlus,
  Loader2,
  MapPin,
  Mic,
  PenLine,
  Send,
  Square,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLearningFocus } from "./learning-focus-store";
import {
  detectMemoDevice,
  memoAnchorLabel,
  splitMemoTagInput,
} from "./memo-format";
import { enqueueMemo, type MemoOutboxInput } from "./memo-outbox";
import { useVoiceRecorder, type VoiceRecording } from "./use-voice-recorder";

const MemoInkSheet = lazy(() => import("./MemoInkSheet"));

/** 入队失败提示里指代媒体内容的词（text 走输入框恢复，不在此列） */
const MEDIA_KIND_LABEL: Record<Exclude<MemoKind, "text">, string> = {
  voice: "这段录音",
  image: "这张图片",
  ink: "这页手写",
};

/**
 * 随笔记录端（模块 5 第一步）：一个输入框 + 三个媒体入口（语音 / 图片 / 手写）。
 * - 上下文锚自动取「我现在在哪」（learning-focus-store），可一键去掉；
 * - 标签用逗号 / 空格分隔，最多 5 个；
 * - 每条先入本机待传队列再上传（memo-outbox）：离线也能记；
 * - 语音：点一下开始、再点停止（≤ 10 分钟自动停，建议 ≤ 5 分钟）；
 * - 图片：手机上直接调相机（capture）或选图；
 * - 手写：抽屉里的纸面（复用笔迹能力），完成后渲染 PNG 入队。
 */
export function MemoComposer({
  onQueued,
  autoFocus = false,
}: {
  /** 一条已入队（本机已保存）后回调，如关闭浮层 */
  onQueued?: (() => void) | undefined;
  autoFocus?: boolean;
}) {
  const focus = useLearningFocus();
  const [anchorDropped, setAnchorDropped] = useState(false);
  const anchor: MemoAnchor = anchorDropped ? MEMO_ANCHOR_NONE : focus;
  const [text, setText] = useState("");
  const [tagsRaw, setTagsRaw] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  /** 入队失败（本机写不进且传不上去）：红字提示，语音 / 图片 / 手写同样可见 */
  const [error, setError] = useState<string | null>(null);
  /**
   * 媒体随笔入队失败时留住整条（含 Blob）给「重新保存」：录音 / 图片 / 手写没有输入框
   * 可以放回去，不留就等于丢掉本人刚产出的内容。复用同一 clientId，服务端已落库只是
   * 响应丢失的情况下重发不会成两条。
   */
  const [failedMedia, setFailedMedia] = useState<{
    readonly input: MemoOutboxInput;
    readonly message: string;
  } | null>(null);
  const [inkOpen, setInkOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 浮层打开即落焦到输入框（对话框首个可聚焦元素是「去掉锚」小按钮，不是想要的）
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);
  const textId = useId();
  const tagsId = useId();
  const tags = normalizeMemoTags(splitMemoTagInput(tagsRaw));
  const tooManyTags = splitMemoTagInput(tagsRaw).length > MEMO_TAGS_MAX;

  async function queue(raw: MemoOutboxInput): Promise<void> {
    // 先清空输入再落本机：点「保存」立刻有反馈；两边都没存下来再把原文放回来
    //（enqueueMemo 返回即有本机或服务端副本，拒绝 = 没有任何副本）
    const input: MemoOutboxInput = {
      ...raw,
      clientId: raw.clientId ?? crypto.randomUUID(),
      recordedAt: raw.recordedAt ?? new Date().toISOString(),
    };
    const previous = { text, tagsRaw };
    setBusy(true);
    setText("");
    setTagsRaw("");
    setNotice(null);
    setError(null);
    try {
      await enqueueMemo(input);
      if (failedMedia?.input.clientId === input.clientId) setFailedMedia(null);
      onQueued?.();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "本机保存失败，请重试";
      if (input.kind === "text") {
        setText(previous.text);
        setTagsRaw(previous.tagsRaw);
        setError(message);
      } else {
        // 媒体内容留在本页，文字 / 标签不放回输入框（它们随这条一起重新保存）
        setFailedMedia({
          input,
          message: `${message}；${MEDIA_KIND_LABEL[input.kind]}还在本页，可点「重新保存」再试`,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  const base = () => ({
    anchor,
    tags,
    device: detectMemoDevice(),
    durationSec: undefined,
    blob: undefined,
  });

  async function submitText(): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "") {
      setNotice("先写点什么，或者用语音 / 图片 / 手写");
      return;
    }
    if (tooManyTags) {
      setNotice(`标签最多 ${MEMO_TAGS_MAX} 个`);
      return;
    }
    await queue({ ...base(), kind: "text", text: trimmed });
  }

  const recorder = useVoiceRecorder((recording: VoiceRecording) => {
    void queue({
      ...base(),
      kind: "voice",
      text: text.trim() === "" ? undefined : text.trim(),
      durationSec: recording.durationSec,
      blob: recording.blob,
    });
  });

  async function pickImage(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    if (file.size > MEMO_IMAGE_MAX_BYTES) {
      setNotice("图片超过 10 MB，请压缩后重试");
      return;
    }
    await queue({
      ...base(),
      kind: "image",
      text: text.trim() === "" ? undefined : text.trim(),
      blob: file,
    });
  }

  const recorderState = recorder.state;
  const recording = recorderState.status === "recording";
  const anchorLabel = memoAnchorLabel(anchor);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <MapPin aria-hidden className="size-3.5" />
        {anchorLabel === null ? (
          <span>没有上下文锚（只记时间与设备）</span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary">
            锚到：{anchorLabel}
            <button
              type="button"
              aria-label="去掉上下文锚"
              className="rounded-full p-0.5 hover:bg-primary/20"
              onClick={() => setAnchorDropped(true)}
            >
              <X aria-hidden className="size-3" />
            </button>
          </span>
        )}
        {anchorDropped && memoAnchorLabel(focus) !== null && (
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => setAnchorDropped(false)}
          >
            恢复锚
          </button>
        )}
      </div>
      <label htmlFor={textId} className="sr-only">
        随笔内容
      </label>
      <textarea
        id={textId}
        value={text}
        onChange={(event) =>
          setText(event.target.value.slice(0, MEMO_TEXT_MAX))
        }
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submitText();
          }
        }}
        ref={textareaRef}
        rows={3}
        placeholder="随手记一句：想法、疑问、易错点…（⌘/Ctrl+Enter 保存）"
        className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={tagsId} className="sr-only">
          标签
        </label>
        <input
          id={tagsId}
          value={tagsRaw}
          onChange={(event) => setTagsRaw(event.target.value)}
          placeholder="标签（逗号分隔，如 易错, 疑问, 待办）"
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        {tooManyTags && (
          <span className="text-xs text-destructive">
            标签最多 {MEMO_TAGS_MAX} 个
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={recording ? "destructive" : "outline"}
          size="sm"
          aria-pressed={recording}
          disabled={busy || recorderState.status === "requesting"}
          onClick={() => (recording ? recorder.stop() : void recorder.start())}
        >
          {recording ? (
            <Square aria-hidden className="size-4" />
          ) : (
            <Mic aria-hidden className="size-4" />
          )}
          {recorderState.status === "recording"
            ? `停止（${formatMemoDuration(recorderState.elapsedSec)}）`
            : recorderState.status === "requesting"
              ? "准备录音…"
              : "语音"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || recording}
          onClick={() => fileInputRef.current?.click()}
        >
          <ImagePlus aria-hidden className="size-4" />
          图片
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          aria-label="选择或拍摄图片"
          onChange={(event) => {
            void pickImage(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || recording}
          onClick={() => setInkOpen(true)}
        >
          <PenLine aria-hidden className="size-4" />
          手写
        </Button>
        <span className="flex-1" />
        <Button
          type="button"
          size="sm"
          disabled={busy || recording}
          onClick={() => void submitText()}
        >
          {busy ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : (
            <Send aria-hidden className="size-4" />
          )}
          保存
        </Button>
      </div>
      {recording && (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          正在录音，建议单条不超过 5 分钟（10 分钟自动停止）
        </p>
      )}
      {recorderState.status === "error" && (
        <p role="alert" className="text-sm text-destructive">
          {recorderState.message}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {failedMedia !== null && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-destructive"
        >
          <span>{failedMedia.message}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || recording}
            onClick={() => void queue(failedMedia.input)}
          >
            重新保存
          </Button>
        </div>
      )}
      {notice !== null && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {inkOpen && (
        <Suspense fallback={null}>
          <MemoInkSheet
            open={inkOpen}
            onOpenChange={setInkOpen}
            onComplete={(png) => {
              setInkOpen(false);
              void queue({
                ...base(),
                kind: "ink",
                text: text.trim() === "" ? undefined : text.trim(),
                blob: png,
              });
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
