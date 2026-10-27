import {
  type AttemptQuestionPublic,
  annotationSurfaceLayoutCore,
} from "@tutor/contract";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAttemptEditor } from "@/features/attempt/AttemptEditorContext";
import { attemptMaterialsEditable } from "@/features/attempt/attempt-material-recovery";
import { StableQuestionPixelGridContext } from "@/features/attempt/QuestionSurfaceFrame";
import { useDraftSyncRecovery } from "@/features/attempt/use-draft-sync";
import { canvasToPngBlob } from "@/features/ink/engine/canvas-png";
import type { InkPenColor, InkPenSize } from "@/features/ink/engine/index";
import { SessionPrefToggleButton } from "@/features/ink/InkPad";
import {
  getSessionInputPreference,
  useSessionInputPreference,
} from "@/features/ink/input-preference";
import { PAPER_KEEPALIVE_MS } from "@/features/ink/use-retained-paper";
import { withTimeout } from "@/features/notes/rasterize-utils";
import { measureStage } from "@/lib/performance-stages";
import {
  AnnotationContinuation,
  annotationContinuationBaseSource,
} from "./AnnotationContinuation";
import { AnnotationOriginal } from "./AnnotationOriginal";
import { blocksInBaseDomain } from "./annotation-anchor";
import {
  getAnnotationRecord,
  retryAnnotationPersistence,
  settleAnnotationRecordPersistence,
  writeAnnotationDoc,
} from "./annotation-store";
import {
  type AnnotationSurface,
  createAnnotationSurface,
} from "./annotation-surface";
import { prepareQuestionAnnotationBase } from "./question-annotation-base";
import { prepareQuestionAnnotationContinuation } from "./question-annotation-continuation";
import {
  awaitQuestionSurfaceReady,
  questionSurfaceMatchesLayout,
} from "./question-base-image";
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
    hidden?: boolean;
  }
>((props, ref) => {
  const { attemptId, question, label, children, hidden = false } = props;
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [originalScope, setOriginalScope] = useState<string | null>(null);
  const originalScopeKey = JSON.stringify([
    session?.origin,
    session?.studentId,
    attemptId,
    question.id,
    record?.resetVersion ?? 0,
  ]);
  const originalOpen = originalScope === originalScopeKey && !hidden;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 会话与显示范围变化必须清除旧弹窗，不能在返回旧题或账号时复开
  useEffect(() => {
    // 换题、换账号、维护重置或隐藏后，不恢复前一会话的查看弹窗。
    setOriginalScope(null);
  }, [session, originalScopeKey, hidden]);
  const originalBlob = originalOpen ? record?.localBase?.png : undefined;
  const [originalImage, setOriginalImage] = useState<{
    blob: Blob;
    url: string;
  } | null>(null);
  const originalBlobUrl =
    originalImage?.blob === originalBlob ? originalImage?.url : null;
  useEffect(() => {
    if (!originalBlob) {
      setOriginalImage(null);
      return;
    }
    const url = URL.createObjectURL(originalBlob);
    setOriginalImage({ blob: originalBlob, url });
    return () => URL.revokeObjectURL(url);
  }, [originalBlob]);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [color, setColor] = useState<InkPenColor>("red");
  const [size, setSize] = useState<InkPenSize>("thin");
  const [, setHistory] = useState(0);
  const layout = record?.localBase?.layout ?? record?.base?.layout;
  const pixelGridKey = JSON.stringify([
    session?.origin,
    session?.studentId,
    attemptId,
    question.id,
    record?.resetVersion ?? 0,
    layout ? annotationSurfaceLayoutCore(layout) : null,
  ]);
  const [canonicalGridKey, setCanonicalGridKey] = useState<string | null>(null);
  const usingCanonicalGrid = !layout || canonicalGridKey === pixelGridKey;
  const pixelGridRef = useRef({
    key: pixelGridKey,
    canonical: usingCanonicalGrid,
  });
  pixelGridRef.current = { key: pixelGridKey, canonical: usingCanonicalGrid };
  const rejectedLayout = compatible === false;
  // 校验失败也保留保存时的逻辑宽度，否则下次校验会在另一套排版上永久失败。
  const displayLayout = layout;
  const cssWidth = displayLayout?.cssWidth;
  const cssHeight = displayLayout?.cssHeight;
  const baseWidth = displayLayout
    ? Math.ceil(displayLayout.cssWidth * displayLayout.pixelRatio)
    : 0;
  const baseHeight = displayLayout
    ? Math.ceil(displayLayout.cssHeight * displayLayout.pixelRatio)
    : 0;
  const selected =
    editor?.active?.questionId === question.id &&
    editor.active.kind === "annotation";
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const layoutChecking = useRef(false);
  const opening = useRef(false);
  const active = selected && !hidden && compatible === true;
  const visible = compatible === true && !hidden;
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
      await retryAnnotationPersistence(session, {
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
      () =>
        opening.current ||
        getActiveEditor() !== null ||
        getPaperEditor() !== null,
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
  // 固定底图续画（布局不匹配且底图可读）：本机 PNG 优先，云端 ready 底图需带
  // layout（v1 无 layout 不支持续画，维持只读原稿弹窗）。
  const continuationSource = annotationContinuationBaseSource(
    record,
    attemptId,
  );
  const continuationVisible =
    compatible === false && !hidden && continuationSource !== null;
  const [continuationExpandSignal, setContinuationExpandSignal] = useState(0);
  const [continuationWorkspaceActive, setContinuationWorkspaceActive] =
    useState(false);
  // 续画工作台挂载期间由其持有 annotation 键的收笔注册（其 finish 含画布收笔，
  // register 的整体替换语义）；工作台卸载删除该键后这里重新注册自己的 finish，
  // 保证「展开续画→收起→切题 flush(questionId)」仍会收笔并 settle 本题标画。
  useEffect(() => {
    if (continuationWorkspaceActive) return;
    return editor?.register(question.id, finish);
  }, [editor?.register, question.id, finish, continuationWorkspaceActive]);

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
      // 查看原稿不重新生成底图，也不进入原位编辑的布局准入流程。
      if ((record?.localBase || record?.base) && !layout) {
        if (await editor.request(null)) {
          setError(null);
          setOriginalScope(originalScopeKey);
        }
        return;
      }
      if (rejectedLayout) setCompatible(null);
      opening.current = true;
      setLoading(true);
      setError(null);
      try {
        await editor.request(
          { questionId: question.id, kind: "annotation" },
          async (signal) => {
            if (rejectedLayout) {
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
            }
            if (signal.aborted) return false;
            const element = root.current?.querySelector<HTMLElement>(
              '[data-slot="question-surface"]',
            );
            if (!element) throw new Error("题面尚未就绪，请重试");
            const prepared = await measureStage("annotation:prepare", () =>
              prepareQuestionAnnotationBase(
                session,
                scope,
                question,
                element,
                signal,
              ),
            );
            if (signal.aborted) return false;
            if (prepared.kind === "sealed")
              throw new Error("标画已随交卷固定，请刷新查看");
            if (prepared.kind === "legacy") {
              // v1 旧版底图（无 layout）：直接转只读原圈画查看，不报错、
              // 不进原位编辑（不重建底图、不创建待传空稿）。
              setOriginalScope(originalScopeKey);
              return false;
            }
            const awaitReady = () =>
              measureStage("annotation:surface-ready", () =>
                withTimeout(
                  awaitQuestionSurfaceReady(element, () => {
                    if (signal.aborted)
                      throw new DOMException("标画已取消", "AbortError");
                  }),
                  15_000,
                  "题面资源加载超时，请重试",
                ),
              );
            await awaitReady();
            if (signal.aborted) return false;
            const matchContinuation = async () => {
              const continuation = await prepareQuestionAnnotationContinuation(
                session,
                scope,
                question,
                element,
                prepared.localBase,
                signal,
              );
              if (signal.aborted) return false;
              return measureStage("annotation:layout-match", () =>
                questionSurfaceMatchesLayout(
                  question,
                  element,
                  continuation.layout,
                ),
              );
            };
            let matches = await matchContinuation();
            if (!matches && !pixelGridRef.current.canonical) {
              setCanonicalGridKey(pixelGridRef.current.key);
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              );
              if (signal.aborted) return false;
              await awaitReady();
              matches = await matchContinuation();
            }
            if (signal.aborted) return false;
            setCompatible(matches);
            if (!matches) {
              // 有可用冻结底图（本机 PNG 或云端 ready 底图）时不自动弹只读原稿
              // 弹窗，改为展开固定底图续画区块；不可续画（如 v1 底图无 layout，
              // 此处防御兜底）时维持只读弹窗现状。
              const saved = await getAnnotationRecord(session, scope);
              if (annotationContinuationBaseSource(saved, attemptId) === null) {
                setOriginalScope(originalScopeKey);
              } else {
                setContinuationExpandSignal((value) => value + 1);
              }
              return false;
            }
            return true;
          },
        );
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "标画准备失败，请重试",
        );
      } finally {
        opening.current = false;
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
      const current = ++generation;
      layoutChecking.current = true;
      // 布局尚在核对时先结束当前笔，不能向已重排的题面继续写入。
      if (selectedRef.current) {
        surface.current?.finish();
        surface.current?.setInputEnabled(false);
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void withTimeout(
          awaitQuestionSurfaceReady(element, () => {
            if (!alive || current !== generation)
              throw new DOMException("布局核对已取消", "AbortError");
          }),
          15_000,
          "题面资源加载超时，请重试",
        )
          .then(() => questionSurfaceMatchesLayout(question, element, layout))
          .then((matches) => {
            if (!alive || current !== generation) return;
            if (!matches && !usingCanonicalGrid) {
              setCanonicalGridKey(pixelGridKey);
              return;
            }
            layoutChecking.current = false;
            setCompatible(matches);
            if (matches && selectedRef.current && !hidden)
              surface.current?.setInputEnabled(true);
            if (!matches && selectedRef.current)
              surface.current?.setInputEnabled(false);
          })
          .catch(() => {
            if (!alive || current !== generation) return;
            layoutChecking.current = false;
            setCompatible(false);
            if (selectedRef.current) surface.current?.setInputEnabled(false);
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
  }, [layout, question, hidden, scale, pixelGridKey, usingCanonicalGrid]);

  useEffect(() => {
    const element = root.current?.querySelector<HTMLElement>(
      '[data-slot="question-surface"]',
    );
    if (!element) return;
    const previous = element.hasAttribute("inert");
    element.toggleAttribute("inert", active);
    return () => {
      element.toggleAttribute("inert", previous);
    };
  }, [active]);

  useEffect(() => {
    if (visible && record?.doc && (active || previewBlob === null))
      setMountedOnce(true);
  }, [visible, record?.doc, active, previewBlob]);
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
      // LR-6：收笔锚定的布局证据——从 record 活引用取当前 layout（effect
      // 闭包里的 layout 会过期）；无 layout（旧底图）返回 undefined 不锚
      anchorBlocks: () => {
        const layout =
          recordRef.current?.localBase?.layout ??
          recordRef.current?.base?.layout;
        if (layout?.compatibility?.blocks === undefined) return undefined;
        // 评审 #11750 必改①：measure 落盘 CSS 像素，先转底图像素域再锚定
        return blocksInBaseDomain(
          layout.compatibility.blocks,
          layout.pixelRatio,
        );
      },
    });
    surface.current = current;
    const resetVersion = recordRef.current?.resetVersion ?? 0;
    current.mount(host.current, recordRef.current.doc);
    loadedVersion.current = recordRef.current.docVersion;
    current.onChange((doc, reason) => {
      if (
        reason === "load" ||
        (recordRef.current?.resetVersion ?? 0) !== resetVersion
      )
        return;
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
    surface.current?.setInputEnabled(active && !layoutChecking.current);
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

  return (
    <div
      ref={root}
      className="relative mx-auto w-full min-w-0"
      data-slot="annotated-question"
      style={cssWidth ? { maxWidth: cssWidth } : undefined}
    >
      <div
        ref={viewport}
        data-slot="annotation-viewport"
        className={`relative mx-auto w-full min-w-0 overflow-x-auto ${active ? "outline outline-2 outline-offset-4 outline-sky-200" : ""}`}
        style={cssWidth ? { maxWidth: cssWidth } : undefined}
      >
        <div
          className="relative overflow-clip"
          style={
            cssWidth && cssHeight
              ? {
                  width: cssWidth * scale,
                  height: rejectedLayout ? undefined : cssHeight * scale,
                }
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
                  }
                : undefined
            }
          >
            <StableQuestionPixelGridContext value={usingCanonicalGrid}>
              {children}
            </StableQuestionPixelGridContext>
          </div>
          {cssWidth && cssHeight && (
            <div
              data-slot="question-annotation-overlay"
              data-drawing={active}
              className="pointer-events-none absolute left-0 top-0 z-10"
              hidden={!visible}
              style={{ width: cssWidth * scale, height: cssHeight * scale }}
            >
              <div
                ref={host}
                className="absolute inset-0"
                hidden={hidden}
                style={{ pointerEvents: active ? "auto" : "none" }}
              />
              {!hidden && !mountedOnce && previewUrl && (
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
      {continuationVisible && (
        <AnnotationContinuation
          attemptId={attemptId}
          questionId={question.id}
          label={label}
          record={record}
          expandSignal={continuationExpandSignal}
          onWorkspaceActiveChange={setContinuationWorkspaceActive}
        />
      )}
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
      {loading && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          正在准备标画，仍可作答…
        </p>
      )}
      {error && (
        <div role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <Dialog
        open={originalOpen}
        onOpenChange={(open) => {
          if (!open) setOriginalScope(null);
        }}
      >
        <DialogContent
          className="max-w-4xl"
          onCloseAutoFocus={(event) => {
            // 入口由题卡通过 ref 调用，关闭时恢复真实的圈画按钮。
            const button = root.current
              ?.closest("article")
              ?.querySelector<HTMLButtonElement>("[data-annotation-trigger]");
            if (button) {
              event.preventDefault();
              button.focus();
            }
          }}
        >
          <DialogTitle>{label}原圈画</DialogTitle>
          <DialogDescription>
            {layout
              ? "按保存时的题面显示原圈画，仅供查看。关闭后可继续作答。"
              : "此题标画为旧版，仅供查看。关闭后可继续作答。"}
          </DialogDescription>
          {record?.local === "failed" && (
            <p role="alert">
              本机保存失败，当前原稿仍保留在本设备，请恢复保存后再离开。
            </p>
          )}
          {record?.pendingMutationId && (
            <p className="text-sm text-muted-foreground">
              本设备有尚未同步的圈画。
            </p>
          )}
          {record?.conflict && (
            <p role="note">圈画存在同步冲突，当前显示本设备保留的原稿。</p>
          )}
          {record?.base?.stale && (
            <p role="note">这是旧版本题面的原圈画，笔迹保持在保存时的位置。</p>
          )}
          {record?.doc &&
          (originalBlobUrl ||
            (!record.localBase && record.base?.downloadUrl)) ? (
            <AnnotationOriginal
              src={originalBlobUrl ?? record.base?.downloadUrl ?? ""}
              pixelWidth={
                record.localBase
                  ? Math.ceil(
                      record.localBase.layout.cssWidth *
                        record.localBase.layout.pixelRatio,
                    )
                  : (record.base?.pixelWidth ?? 0)
              }
              pixelHeight={
                record.localBase
                  ? Math.ceil(
                      record.localBase.layout.cssHeight *
                        record.localBase.layout.pixelRatio,
                    )
                  : (record.base?.pixelHeight ?? 0)
              }
              doc={record.doc}
              label={`${label}原圈画`}
            />
          ) : (
            <p role={record?.localBase ? "status" : "alert"}>
              {record?.localBase
                ? "正在读取本机原圈画…"
                : "原圈画底图尚未就绪，请重新加载材料；笔迹已保留。"}
            </p>
          )}
        </DialogContent>
      </Dialog>
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
