import type { AttemptQuestionPublic } from "@tutor/contract";
import { Eraser, MoreHorizontal, PenLine, Redo2, Undo2 } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAttemptEditor } from "@/features/attempt/AttemptEditorContext";
import { attemptMaterialsEditable } from "@/features/attempt/attempt-material-recovery";
import { useDraftSyncRecovery } from "@/features/attempt/use-draft-sync";
import { canvasToPngBlob } from "@/features/ink/engine/canvas-png";
import type { InkPenColor, InkPenSize } from "@/features/ink/engine/index";
import { SessionPrefToggleButton } from "@/features/ink/InkPad";
import {
  getSessionInputPreference,
  useSessionInputPreference,
} from "@/features/ink/input-preference";
import { PAPER_KEEPALIVE_MS } from "@/features/ink/use-retained-paper";
import { measureStage } from "@/lib/performance-stages";
import {
  getAnnotationRecord,
  settleAnnotationRecordPersistence,
  writeAnnotationDoc,
} from "./annotation-store";
import {
  type AnnotationSurface,
  createAnnotationSurface,
} from "./annotation-surface";
import { prepareQuestionAnnotationBase } from "./question-annotation-base";
import { questionSurfaceMatchesLayout } from "./question-base-image";
import { scheduleQuestionBasePrewarm } from "./schedule-question-base-prewarm";
import {
  useAnnotationRecord,
  useAnnotationSessionRef,
} from "./use-annotation-record";

export interface QuestionAnnotationOverlayHandle {
  start(): Promise<void>;
}

/** 已标画题面保持逻辑排版，题面与透明笔迹同域等比显示。 */
export const QuestionAnnotationOverlay = forwardRef<
  QuestionAnnotationOverlayHandle,
  {
    attemptId: string;
    question: AttemptQuestionPublic;
    label: string;
    children: ReactNode;
    fallbackAnswer?: ReactNode;
    hidden?: boolean;
  }
>((props, ref) => {
  const {
    attemptId,
    question,
    label,
    children,
    fallbackAnswer,
    hidden = false,
  } = props;
  const editor = useAttemptEditor(question.id);
  const recovery = useDraftSyncRecovery();
  const inputPreference = useSessionInputPreference();
  const session = useAnnotationSessionRef();
  const record = useAnnotationRecord(attemptId, question.id);
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<AnnotationSurface | null>(null);
  const recordRef = useRef(record);
  recordRef.current = record;
  const loadedVersion = useRef<number | null>(null);
  const [compatible, setCompatible] = useState<boolean | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const scale = expanded ? 1 : fitScale;
  const viewport = useRef<HTMLDivElement>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [originalLoaded, setOriginalLoaded] = useState(false);
  const [imageRetry, setImageRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [color, setColor] = useState<InkPenColor>("red");
  const [size, setSize] = useState<InkPenSize>("thin");
  const [, setHistory] = useState(0);
  const layout = record?.localBase?.layout ?? record?.base?.layout;
  const legacy = !layout && record?.base?.state === "ready";
  const cssWidth = layout?.cssWidth ?? (legacy ? 720 : undefined);
  const cssHeight =
    layout?.cssHeight ??
    (legacy && record?.base?.pixelHeight && record.base.pixelWidth
      ? (record.base.pixelHeight / record.base.pixelWidth) * 720
      : undefined);
  const baseWidth = layout
    ? Math.ceil(layout.cssWidth * layout.pixelRatio)
    : (record?.base?.pixelWidth ?? 0);
  const baseHeight = layout
    ? Math.ceil(layout.cssHeight * layout.pixelRatio)
    : (record?.base?.pixelHeight ?? 0);
  const original = legacy || (layout !== undefined && compatible === false);
  const localPng = record?.localBase?.png;
  const selected =
    editor?.active?.questionId === question.id &&
    editor.active.kind === "annotation";
  const active =
    selected && !hidden && (original ? originalLoaded : compatible === true);
  const visible = (original || compatible === true) && !hidden;
  const [mountedOnce, setMountedOnce] = useState(false);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewVersion = useRef<number | null>(null);
  const scope = {
    attemptId,
    questionId: question.id,
    phase: "scratch" as const,
  };

  const getActiveEditor = editor?.getActive;
  const getPaperEditor = editor?.getPaper;
  useEffect(() => {
    if (session)
      void getAnnotationRecord(session, {
        attemptId,
        questionId: question.id,
        phase: "scratch",
      });
  }, [session, attemptId, question.id]);

  const finish = useCallback(async () => {
    surface.current?.finish();
    if (session) {
      await settleAnnotationRecordPersistence(session, {
        attemptId,
        questionId: question.id,
        phase: "scratch",
      });
      const saved = await getAnnotationRecord(session, {
        attemptId,
        questionId: question.id,
        phase: "scratch",
      });
      if (saved?.local === "failed")
        throw new Error(saved.localError ?? "本机标画未保存");
    }
  }, [session, attemptId, question.id]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !cssWidth) return;
    let previousWidth = 0;
    const resize = () => {
      const width = element.getBoundingClientRect().width;
      if (width <= 0 || width === previousWidth) return;
      surface.current?.finish();
      // 分栏或容器宽度变化后重新适配，不能沿用上一列宽下的放大状态。
      if (previousWidth > 0) setExpanded(false);
      previousWidth = width;
      setFitScale(Math.min(1, width / cssWidth));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [cssWidth]);

  useEffect(() => {
    const element = root.current?.querySelector<HTMLElement>(
      '[data-slot="question-surface"]',
    );
    if (
      !session ||
      !getActiveEditor ||
      !getPaperEditor ||
      !element ||
      hidden ||
      record?.localBase ||
      record?.base ||
      !recovery ||
      !attemptMaterialsEditable(recovery)
    )
      return;
    return scheduleQuestionBasePrewarm(
      session,
      { attemptId, questionId: question.id, phase: "scratch" },
      question,
      element,
      () => getActiveEditor() !== null || getPaperEditor() !== null,
    );
  }, [
    session,
    getActiveEditor,
    getPaperEditor,
    attemptId,
    question,
    hidden,
    record?.localBase,
    record?.base,
    recovery,
  ]);
  useEffect(
    () => editor?.register(question.id, finish),
    [editor?.register, question.id, finish],
  );

  useImperativeHandle(ref, () => ({
    async start() {
      if (recovery && !attemptMaterialsEditable(recovery)) {
        setError(
          recovery.state === "failed"
            ? "标画恢复失败，请在顶部重试"
            : "正在恢复标画，请稍候",
        );
        return;
      }
      if (!editor || !session || loading) return;
      setLoading(true);
      setError(null);
      try {
        await editor.request(
          { questionId: question.id, kind: "annotation" },
          async (signal) => {
            const element = root.current?.querySelector<HTMLElement>(
              '[data-slot="question-surface"]',
            );
            if (!element) throw new Error("题面尚未就绪，请重试");
            const prepared = await prepareQuestionAnnotationBase(
              session,
              scope,
              question,
              element,
              signal,
            );
            if (signal.aborted) return false;
            if (prepared.kind === "legacy") {
              if (prepared.base.state !== "ready")
                throw new Error("历史标画底图尚未就绪，请重试");
              return true;
            }
            if (prepared.kind === "sealed")
              throw new Error("标画已随交卷固定，请刷新查看");
            const matches = await measureStage("annotation:layout-match", () =>
              questionSurfaceMatchesLayout(
                question,
                element,
                prepared.localBase.layout,
              ),
            );
            if (signal.aborted) return false;
            setCompatible(matches);
            return true;
          },
        );
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "标画准备失败，请重试",
        );
      } finally {
        setLoading(false);
      }
    },
  }));

  // 缩放由 React 更新变换属性，必须在新比例落入 DOM 后重新核对。
  // biome-ignore lint/correctness/useExhaustiveDependencies: scale 是布局验证的代际键
  useEffect(() => {
    const element = root.current?.querySelector<HTMLElement>(
      '[data-slot="question-surface"]',
    );
    if (!layout || !element) return;
    let generation = 0;
    let alive = true;
    let frame = 0;
    const check = () => {
      // 布局尚在核对时先结束当前笔，不能向已重排的题面继续写入。
      if (selected && !original) {
        surface.current?.finish();
        surface.current?.setInputEnabled(false);
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const current = ++generation;
        void questionSurfaceMatchesLayout(question, element, layout)
          .then((matches) => {
            if (!alive || current !== generation) return;
            setCompatible(matches);
            if (matches && selected && !original && !hidden)
              surface.current?.setInputEnabled(true);
            if (!matches && selected && !original)
              surface.current?.setInputEnabled(false);
          })
          .catch(() => {
            if (!alive || current !== generation) return;
            setCompatible(false);
            if (selected && !original) surface.current?.setInputEnabled(false);
          });
      });
    };
    check();
    const resize = new ResizeObserver(check);
    resize.observe(element);
    const mutation = new MutationObserver(check);
    mutation.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "src"],
    });
    document.fonts?.addEventListener("loadingdone", check);
    return () => {
      alive = false;
      generation++;
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      document.fonts?.removeEventListener("loadingdone", check);
    };
  }, [layout, question, selected, original, hidden, scale]);

  useEffect(() => {
    const element = root.current?.querySelector<HTMLElement>(
      '[data-slot="question-surface"]',
    );
    if (!element) return;
    const previous = element.hasAttribute("inert");
    element.toggleAttribute("inert", active && !original);
    return () => {
      element.toggleAttribute("inert", previous);
    };
  }, [active, original]);

  useEffect(() => {
    if (
      visible &&
      record?.doc &&
      (!original || originalLoaded) &&
      (active || previewBlob === null)
    )
      setMountedOnce(true);
  }, [visible, record?.doc, original, originalLoaded, active, previewBlob]);
  useEffect(() => {
    if (active || !mountedOnce || !session) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        await finish();
        const canvas = host.current?.querySelector("canvas");
        const current = recordRef.current;
        if ((current?.doc?.strokes.length ?? 0) > 0 && !canvas) return;
        const blob = canvas ? await canvasToPngBlob(canvas) : null;
        if (cancelled) return;
        previewVersion.current = current?.docVersion ?? null;
        setPreviewBlob(blob);
        setMountedOnce(false);
      })().catch(() => undefined);
    }, PAPER_KEEPALIVE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, mountedOnce, session, finish]);
  useEffect(() => {
    if (!previewBlob) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(previewBlob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [previewBlob]);
  useEffect(() => {
    if (
      previewVersion.current !== null &&
      record?.docVersion !== previewVersion.current
    )
      setPreviewBlob(null);
  }, [record?.docVersion]);
  useEffect(() => {
    if (
      !mountedOnce ||
      !host.current ||
      !session ||
      !cssWidth ||
      !cssHeight ||
      !baseWidth ||
      !baseHeight ||
      !recordRef.current?.doc
    )
      return;
    const current = createAnnotationSurface({
      baseWidth,
      baseHeight,
      inputEnabled: false,
      inputMode: getSessionInputPreference(),
    });
    surface.current = current;
    current.mount(host.current, recordRef.current.doc);
    loadedVersion.current = recordRef.current.docVersion;
    current.onChange((doc, reason) => {
      if (reason === "load") return;
      loadedVersion.current = writeAnnotationDoc(
        session,
        { attemptId, questionId: question.id, phase: "scratch" },
        doc,
      );
      setHistory((value) => value + 1);
    });
    return () => {
      current.finish();
      current.destroy();
      surface.current = null;
    };
  }, [
    mountedOnce,
    session,
    attemptId,
    question.id,
    cssWidth,
    cssHeight,
    baseWidth,
    baseHeight,
  ]);
  useEffect(() => {
    if (!mountedOnce) return;
    surface.current?.setInputMode(inputPreference);
    surface.current?.setInputEnabled(active);
    surface.current?.setTool(
      tool === "pen" ? { type: "pen", color, size } : { type: "eraser" },
    );
  }, [active, tool, color, size, mountedOnce, inputPreference]);
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "z"
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, [contenteditable="true"]')
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          '[data-slot="note-layer"], [data-slot="handwritten-controls"]',
        )
      )
        return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"][data-state="open"]',
        )
      )
        return;
      event.preventDefault();
      if (event.shiftKey) surface.current?.redo();
      else surface.current?.undo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);
  useEffect(() => {
    if (
      record?.doc &&
      loadedVersion.current !== null &&
      record.docVersion > loadedVersion.current
    ) {
      surface.current?.load(record.doc);
      loadedVersion.current = record.docVersion;
    }
  }, [record]);
  useEffect(() => {
    if (!original) return;
    const url = localPng
      ? URL.createObjectURL(localPng)
      : record?.base?.downloadUrl;
    if (!url) return;
    setOriginalUrl(url);
    setOriginalLoaded(false);
    return () => {
      if (localPng) URL.revokeObjectURL(url);
      setOriginalUrl(null);
    };
  }, [original, localPng, record?.base?.downloadUrl]);

  return (
    <div
      ref={root}
      className="relative mx-auto w-full min-w-0"
      data-slot="annotated-question"
    >
      <div
        ref={viewport}
        data-slot="annotation-viewport"
        className={`relative mx-auto w-full min-w-0 overflow-x-auto ${active ? "outline outline-2 outline-offset-4 outline-sky-200" : ""}`}
        style={cssWidth && cssHeight ? { maxWidth: cssWidth } : undefined}
      >
        <div
          className="relative overflow-clip"
          style={
            cssWidth && cssHeight
              ? { width: cssWidth * scale, height: cssHeight * scale }
              : undefined
          }
        >
          <div
            data-slot="annotation-logical-frame"
            data-annotation-scale={cssWidth ? scale : 1}
            style={
              cssWidth
                ? {
                    width: cssWidth,
                    transform: `scale(${scale})`,
                    transformOrigin: "top left",
                    visibility:
                      original && originalLoaded ? "hidden" : undefined,
                  }
                : undefined
            }
            inert={original}
            aria-hidden={(original && originalLoaded) || undefined}
          >
            {children}
          </div>
          {cssWidth && cssHeight && (
            <div
              data-slot="question-annotation-overlay"
              data-drawing={active}
              className="pointer-events-none absolute left-0 top-0 z-10"
              hidden={!visible && !original}
              style={{ width: cssWidth * scale, height: cssHeight * scale }}
            >
              {original && originalUrl && (
                <img
                  key={imageRetry}
                  src={originalUrl}
                  alt={`${label}原标画底图`}
                  className={`absolute inset-0 h-full w-full ${originalLoaded ? "" : "opacity-0"}`}
                  onLoad={() => setOriginalLoaded(true)}
                  onError={() => {
                    setOriginalLoaded(false);
                    setError("原底图加载失败，请重新加载");
                  }}
                />
              )}
              <div
                ref={host}
                className="absolute inset-0"
                hidden={hidden || (original && !originalLoaded)}
                style={{ pointerEvents: active ? "auto" : "none" }}
              />
              {!hidden &&
                (!original || originalLoaded) &&
                !mountedOnce &&
                previewUrl && (
                  <img
                    src={previewUrl}
                    alt="本题标画笔迹"
                    className="pointer-events-none absolute inset-0 h-full w-full"
                  />
                )}
            </div>
          )}
        </div>
      </div>
      {fitScale < 0.85 && (
        <Button
          variant="ghost"
          className="mt-2 h-11"
          aria-pressed={expanded}
          onClick={async () => {
            try {
              await finish();
              setExpanded((value) => !value);
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "本机标画未保存，请重试",
              );
            }
          }}
        >
          {expanded ? "适应宽度" : "放大题面"}
        </Button>
      )}
      {original && (
        <div
          className="mt-3"
          data-slot="annotation-fallback-answer"
          inert={active}
        >
          <p className="mb-2 text-xs text-muted-foreground">
            已保留原标画题面的排版，可直接圈画；答案在下方填写。
          </p>
          {fallbackAnswer}
        </div>
      )}
      {loading && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          正在准备标画，仍可作答…
        </p>
      )}
      {error && (
        <div role="alert" className="mt-2 text-sm text-destructive">
          {error}
          {original && originalUrl && (
            <Button
              variant="outline"
              className="ml-2 h-11"
              onClick={() => {
                setOriginalLoaded(false);
                setError(null);
                setImageRetry((value) => value + 1);
              }}
            >
              重新加载标画
            </Button>
          )}
        </div>
      )}
      {active && (
        <div
          data-slot="attempt-bottom-bar"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]"
        >
          <div
            role="toolbar"
            aria-label={`${label}标画工具栏`}
            className="mx-auto flex min-h-16 max-w-[1120px] items-center justify-center gap-1 px-2 py-2"
          >
            <Button
              title="画笔"
              aria-label="画笔"
              aria-pressed={tool === "pen"}
              variant={tool === "pen" ? "secondary" : "ghost"}
              className="size-11 shrink-0 p-0"
              onClick={() => setTool("pen")}
            >
              <PenLine />
            </Button>
            <Button
              title="橡皮"
              aria-label="橡皮"
              aria-pressed={tool === "eraser"}
              variant={tool === "eraser" ? "secondary" : "ghost"}
              className="size-11 shrink-0 p-0"
              onClick={() => setTool("eraser")}
            >
              <Eraser />
            </Button>
            <Button
              title="撤销"
              aria-label="撤销"
              variant="ghost"
              className="size-11 shrink-0 p-0"
              disabled={!surface.current?.canUndo()}
              onClick={() => surface.current?.undo()}
            >
              <Undo2 />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="更多标画操作"
                title="颜色、粗细、清空"
                className="flex size-11 shrink-0 items-center justify-center rounded-md"
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem
                  disabled={!surface.current?.canRedo()}
                  onSelect={() => surface.current?.redo()}
                >
                  <Redo2 aria-hidden />
                  重做
                </DropdownMenuItem>
                {(["red", "blue", "black"] as const).map((value) => (
                  <DropdownMenuItem key={value} onClick={() => setColor(value)}>
                    <span
                      aria-hidden
                      className="size-3 rounded-full"
                      style={{ backgroundColor: value }}
                    />
                    {{ red: "红色", blue: "蓝色", black: "黑色" }[value]}
                    {color === value ? "（当前）" : ""}
                  </DropdownMenuItem>
                ))}
                {(["thin", "medium", "thick"] as const).map((value) => (
                  <DropdownMenuItem key={value} onClick={() => setSize(value)}>
                    {{ thin: "细笔", medium: "中笔", thick: "粗笔" }[value]}
                    {size === value ? "（当前）" : ""}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem onSelect={() => surface.current?.clear()}>
                  清空标画（可撤销）
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <SessionPrefToggleButton
              iconOnly
              className="size-11 shrink-0 p-0"
            />
            <Button
              className="h-11 w-16 shrink-0 px-2"
              onClick={() => void editor?.request(null)}
            >
              作答
            </Button>
          </div>
        </div>
      )}
    </div>
  );
});
