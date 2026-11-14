import type { MemoAnchor } from "@tutor/contract";
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
import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  captureLearningSource,
  type LearningSource,
} from "@/features/learning-context/learning-context-store";
import { LearningPrincipalContext } from "@/features/learning-context/learning-principal";
import { MemoTagPicker } from "./MemoTagPicker";
import {
  detectMemoDevice,
  MEDIA_KIND_LABEL,
  memoAnchorLabel,
  splitMemoTagInput,
} from "./memo-format";
import { enqueueMemo, type MemoOutboxInput } from "./memo-outbox";
import { memoSourceFields } from "./memo-source-fields";
import { useVoiceRecorder, type VoiceRecording } from "./use-voice-recorder";

const MemoInkSheet = lazy(() => import("./MemoInkSheet"));

/**
 * 随笔记录端（模块 5 第一步）：一个输入框 + 三个媒体入口（语音 / 图片 / 手写）。
 * - 来源在本次记录打开时捕获，可一键去掉；滚动不改写本条来源；
 * - 标签用逗号 / 空格分隔，最多 5 个；
 * - 每条先入本机待传队列再上传（memo-outbox）：离线也能记；
 * - 语音：点一下开始、再点停止（≤ 10 分钟自动停，建议 ≤ 5 分钟）；
 * - 图片：手机上直接调相机（capture）或选图；
 * - 手写：抽屉里的纸面（复用笔迹能力），完成后渲染 PNG 入队。
 */
export function MemoComposer({
  onQueued,
  autoFocus = false,
  source: initialSource,
}: {
  /** 一条已入队（本机已保存）后回调，如关闭浮层 */
  onQueued?: (() => void) | undefined;
  autoFocus?: boolean;
  source?: LearningSource | undefined;
}) {
  const principal = useContext(LearningPrincipalContext);
  const [source] = useState(() =>
    structuredClone(initialSource ?? captureLearningSource(principal)),
  );
  const focus = source.anchor;
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
  const [failedMedia, setFailedMedia] = useState<
    readonly {
      readonly input: MemoOutboxInput;
      readonly message: string;
    }[]
  >([]);
  const failedText = useRef<{
    readonly payload: string;
    readonly input: MemoOutboxInput;
  } | null>(null);
  const [inkOpen, setInkOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
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

  async function queue(
    raw: MemoOutboxInput,
    retryMedia = false,
  ): Promise<void> {
    if (saving.current) return;
    const payload = JSON.stringify(raw);
    const retryText =
      raw.kind === "text" && failedText.current?.payload === payload
        ? failedText.current.input
        : undefined;
    const input: MemoOutboxInput = retryText ?? {
      ...raw,
      clientId: raw.clientId ?? crypto.randomUUID(),
      recordedAt: raw.recordedAt ?? new Date().toISOString(),
    };
    const remaining = failedMedia.filter(
      (entry) => entry.input.clientId !== input.clientId,
    );
    saving.current = true;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await enqueueMemo(input);
      if (input.kind === "text") failedText.current = null;
      if (retryMedia) {
        setFailedMedia(remaining);
      } else {
        setText("");
        setTagsRaw("");
      }
      if (
        remaining.length === 0 &&
        (!retryMedia || (text === "" && tagsRaw === ""))
      ) {
        onQueued?.();
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "本机保存失败，请重试";
      if (input.kind === "text") {
        failedText.current = { input, payload };
        setError(message);
      } else {
        if (!retryMedia) {
          setText("");
          setTagsRaw("");
        }
        setFailedMedia([
          ...remaining,
          {
            input,
            message: `${message}；${MEDIA_KIND_LABEL[input.kind]}还在本页，可点「重新保存」再试`,
          },
        ]);
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  const base = () => ({
    ...memoSourceFields(source, anchorDropped),
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
        disabled={busy}
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
      <MemoTagPicker
        id={tagsId}
        value={tagsRaw}
        onChange={setTagsRaw}
        disabled={busy}
        account={principal ?? null}
      />
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
      {failedMedia.map(({ input, message }) => (
        <div
          key={input.clientId}
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-destructive"
        >
          <span>{message}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || recording}
            onClick={() => void queue(input, true)}
          >
            重新保存
          </Button>
        </div>
      ))}
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
