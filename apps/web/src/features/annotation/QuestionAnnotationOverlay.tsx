import type { AttemptQuestionPublic, StudentAnswer } from "@tutor/contract";
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
import { createPortal } from "react-dom";
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
import { dispatchFrozenInput } from "@/features/answering";
import { useAttemptEditor } from "@/features/attempt/AttemptEditorContext";
import { attemptMaterialsEditable } from "@/features/attempt/attempt-material-recovery";
import { prepareAnnotationForPwaUpdate } from "@/features/attempt/pwa-draft-safety";
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
import { measureStage } from "@/lib/performance-stages";
import { usePwaUpdateGuard } from "@/lib/pwa-update-safety";
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
import { useCoordinatedAnnotation } from "./coordinated-annotation-context";
import {
  type FrozenQuestionSource,
  resolveFrozenQuestionSurface,
} from "./frozen-surface-resolver";
import { prepareQuestionAnnotationBase } from "./question-annotation-base";
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
    answer?: StudentAnswer | undefined;
    onAnswer?: ((answer: StudentAnswer, defer?: boolean) => void) | undefined;
    hidden?: boolean;
    /** 上层题级锁定或订正封存事实；不依赖可过期的本机底图缓存。 */
    annotationReadOnly?: boolean;
    /** 阶段（答题期 scratch；订正工作台 correction——结果页挂载，2026-10） */
    phase?: "scratch" | "correction";
  }
>((props, ref) => {
  const {
    attemptId,
    question,
    label,
    children,
    answer,
    onAnswer,
    hidden = false,
    annotationReadOnly = false,
    phase = "scratch",
  } = props;
  const editor = useAttemptEditor(question.id);
  const recovery = useDraftSyncRecovery();
  const inputPreference = useSessionInputPreference();
  const session = useAnnotationSessionRef();
  const record = useAnnotationRecord(attemptId, question.id, phase);
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<AnnotationSurface | null>(null);
  const recordRef = useRef(record);
  recordRef.current = record;
  const openIdentity = JSON.stringify([
    session?.origin,
    session?.studentId,
    attemptId,
    question.id,
    phase,
    record?.resetVersion ?? 0,
  ]);
  const openingFacts = useRef({
    readOnly: annotationReadOnly,
    hidden,
    identity: openIdentity,
  });
  openingFacts.current = {
    readOnly: annotationReadOnly,
    hidden,
    identity: openIdentity,
  };
  const loadedVersion = useRef<number | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const [answerMode, setAnswerMode] = useState(false);
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
  // 无 Provider（讲练页、单测）时 coordinated 为 null：本地笔态即唯一事实源，
  // 切换照常生效；有 Provider 时（作答页）共享笔态优先，材料层同步跟随。
  const coordinated = useCoordinatedAnnotation();
  const [localTool, setLocalTool] = useState<"pen" | "eraser">("pen");
  const [localColor, setLocalColor] = useState<InkPenColor>("red");
  const [localSize, setLocalSize] = useState<InkPenSize>("thin");

  const tool = coordinated?.tool ?? localTool;
  const color = coordinated?.color ?? localColor;
  const size = coordinated?.size ?? localSize;

  const setTool = useCallback(
    (t: "pen" | "eraser") => {
      setLocalTool(t);
      coordinated?.setTool(t);
    },
    [coordinated],
  );

  const setColor = useCallback(
    (c: InkPenColor) => {
      setLocalColor(c);
      coordinated?.setColor(c);
    },
    [coordinated],
  );

  const setSize = useCallback(
    (s: InkPenSize) => {
      setLocalSize(s);
      coordinated?.setSize(s);
    },
    [coordinated],
  );

  const [, setHistory] = useState(0);
  const sourceResolution = resolveFrozenQuestionSurface(
    record,
    { sourceUrl: null, decoded: null },
    annotationReadOnly,
  );
  const frozenSource = sourceResolution.source;
  const layout = frozenSource?.layout;
  const frozenBlob = frozenSource?.kind === "local" ? frozenSource.blob : null;
  const [frozenImage, setFrozenImage] = useState<{
    blob: Blob;
    url: string;
  } | null>(null);
  useEffect(() => {
    if (!frozenBlob) {
      setFrozenImage(null);
      return;
    }
    const url = URL.createObjectURL(frozenBlob);
    setFrozenImage({ blob: frozenBlob, url });
    return () => URL.revokeObjectURL(url);
  }, [frozenBlob]);
  const frozenUrl =
    frozenSource?.kind === "cloud"
      ? frozenSource.downloadUrl
      : frozenImage?.blob === frozenBlob
        ? frozenImage.url
        : null;
  const frozenUrlRef = useRef(frozenUrl);
  frozenUrlRef.current = frozenUrl;
  const [decodedImage, setDecodedImage] = useState<{
    url: string;
    blob: Blob | null;
    width: number;
    height: number;
    failed: boolean;
  } | null>(null);
  const decodedRef = useRef<{
    url: string;
    blob: Blob | null;
    width: number;
    height: number;
    failed: boolean;
  } | null>(null);
  const imageWaiters = useRef(new Set<() => void>());
  const resolution = resolveFrozenQuestionSurface(
    record,
    { sourceUrl: frozenUrl, decoded: decodedImage },
    annotationReadOnly,
  );
  const frozenReady = resolution.canReadInk;
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
  const opening = useRef(false);
  const sealedFinalization = useRef(false);
  const finishSurface = useCallback((target?: AnnotationSurface | null) => {
    const current = target ?? surface.current;
    if (!current) return;
    sealedFinalization.current = recordRef.current?.sealedAt != null;
    try {
      current.finish();
    } finally {
      sealedFinalization.current = false;
    }
  }, []);
  const active = selected && !hidden && !answerMode && resolution.canWrite;
  const visible = frozenReady && !hidden && !answerMode;
  const frozenInput =
    frozenReady && displayLayout && onAnswer
      ? dispatchFrozenInput(
          question,
          displayLayout,
          answer,
          onAnswer,
          annotationReadOnly || record?.sealedAt != null || active,
        )
      : null;
  const hasFrozenInput = frozenInput !== null;
  const [mountedOnce, setMountedOnce] = useState(false);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewVersion = useRef<number | null>(null);
  const scope = {
    attemptId,
    questionId: question.id,
    phase,
  };
  // 换题、账号或重置后回到保存原稿，避免沿用上一题的作答视图。
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope 身份变化时重置视图，不跟随每笔 record 变化
  useEffect(
    () => setAnswerMode(false),
    [session, attemptId, question.id, phase, record?.resetVersion],
  );

  const getActiveEditor = editor?.getActive;
  const getPaperEditor = editor?.getPaper;
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setError(null);
    void getAnnotationRecord(
      session,
      {
        attemptId,
        questionId: question.id,
        phase,
      },
      { strictRead: true },
    ).catch((cause: unknown) => {
      if (!cancelled)
        setError(
          cause instanceof Error
            ? cause.message
            : "本机圈画读取失败，原记录已保留",
        );
    });
    return () => {
      cancelled = true;
    };
  }, [session, attemptId, question.id, phase]);
  usePwaUpdateGuard(
    async () => {
      if (loading || (recovery && recovery.state !== "ready"))
        throw new Error("标画恢复尚未完成，请先处理后更新");
      await prepareAnnotationForPwaUpdate(
        session,
        { attemptId, questionId: question.id, phase },
        finish,
      );
    },
    JSON.stringify([
      session?.origin,
      session?.studentId,
      attemptId,
      question.id,
      phase,
      "annotation",
    ]),
  );

  const finish = useCallback(async () => {
    finishSurface();
    if (session) {
      await settleAnnotationRecordPersistence(session, {
        attemptId,
        questionId: question.id,
        phase,
      });
      await retryAnnotationPersistence(session, {
        attemptId,
        questionId: question.id,
        phase,
      });
      const saved = await getAnnotationRecord(session, {
        attemptId,
        questionId: question.id,
        phase,
      });
      if (saved?.local === "failed")
        throw new Error(saved.localError ?? "本机标画未保存");
    }
  }, [session, attemptId, question.id, phase, finishSurface]);

  const enterAnswerView = useCallback(async () => {
    setError(null);
    try {
      if ((await editor?.request(null)) === false) return;
      await finish();
      setAnswerMode(true);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "本机标画未保存，请重试",
      );
    }
  }, [editor, finish]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !cssWidth) return;
    let previousWidth = 0;
    const resize = () => {
      const width = element.getBoundingClientRect().width;
      if (width <= 0 || width === previousWidth) return;
      finishSurface();
      // 分栏或容器宽度变化后重新适配，不能沿用上一列宽下的放大状态。
      if (previousWidth > 0) setExpanded(false);
      previousWidth = width;
      setFitScale(Math.min(1, width / cssWidth));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [cssWidth, finishSurface]);

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
      { attemptId, questionId: question.id, phase },
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
    phase,
    record?.localBase,
    record?.base,
    recovery,
  ]);
  useEffect(() => {
    return editor?.register(question.id, finish);
  }, [editor?.register, question.id, finish]);

  const waitForFrozenImage = useCallback(
    (source: FrozenQuestionSource, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        const finishWait = (cause?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          imageWaiters.current.delete(check);
          signal.removeEventListener("abort", abort);
          if (cause) reject(cause);
          else resolve();
        };
        const check = () => {
          if (openingFacts.current.readOnly || openingFacts.current.hidden) {
            finishWait(new Error("本题圈画已封存，仅供查看"));
            return;
          }
          const decoded = decodedRef.current;
          if (
            !decoded ||
            decoded.url !== frozenUrlRef.current ||
            (source.kind === "local"
              ? decoded.blob !== source.blob
              : decoded.url !== source.downloadUrl || decoded.blob !== null)
          )
            return;
          if (
            decoded.failed ||
            decoded.width !== source.pixelWidth ||
            decoded.height !== source.pixelHeight
          )
            finishWait(
              new Error("原稿图片尺寸与保存的圈画坐标不符，笔迹已保留"),
            );
          else finishWait();
        };
        const abort = () => finishWait(new Error("标画打开已取消"));
        const timer = setTimeout(
          () => finishWait(new Error("原稿图片读取超时，请重试")),
          15_000,
        );
        imageWaiters.current.add(check);
        signal.addEventListener("abort", abort, { once: true });
        check();
      }),
    [],
  );
  useEffect(() => {
    if (annotationReadOnly || hidden)
      imageWaiters.current.forEach((notify) => {
        notify();
      });
  }, [annotationReadOnly, hidden]);

  useImperativeHandle(ref, () => ({
    async start() {
      if (!editor || !session || loading) return;
      // v1 没有可编辑的布局证据；封存只限制写入，不限制查看原稿。
      if (sourceResolution.status === "legacy") {
        if (await editor.request(null)) {
          setAnswerMode(false);
          setError(null);
          setOriginalScope(originalScopeKey);
        }
        return;
      }
      if (
        openingFacts.current.readOnly ||
        recordRef.current?.sealedAt != null
      ) {
        setError("本题圈画已封存，仅供查看");
        return;
      }
      if (recovery && !attemptMaterialsEditable(recovery)) {
        setError(
          recovery.state === "failed"
            ? "标画恢复失败，请在顶部重试"
            : "正在恢复标画，请稍候",
        );
        return;
      }
      setAnswerMode(false);
      if (sourceResolution.status === "blocked") {
        setError(sourceResolution.reason);
        return;
      }
      opening.current = true;
      setLoading(true);
      setError(null);
      try {
        await editor.request(
          { questionId: question.id, kind: "annotation" },
          async (signal) => {
            if (signal.aborted) return false;
            const cached = await getAnnotationRecord(session, scope, {
              strictRead: true,
            });
            if (
              signal.aborted ||
              openingFacts.current.identity !== openIdentity ||
              openingFacts.current.readOnly ||
              openingFacts.current.hidden
            )
              return false;
            const element =
              root.current?.querySelector<HTMLElement>(
                '[data-slot="question-surface"]',
              ) ?? null;
            if (
              !element &&
              !cached?.localBase &&
              cached?.base?.state !== "ready"
            )
              throw new Error("题面尚未就绪，请重试");
            const prepared = await measureStage("annotation:prepare", () =>
              prepareQuestionAnnotationBase(
                session,
                scope,
                question,
                element,
                signal,
              ),
            );
            if (
              signal.aborted ||
              openingFacts.current.identity !== openIdentity ||
              openingFacts.current.readOnly ||
              openingFacts.current.hidden
            )
              return false;
            if (prepared.kind === "sealed")
              throw new Error(
                phase === "correction"
                  ? "订正圈画已随上次保存定格，仅供回看（再修改无新行，草稿纸不受影响）"
                  : "标画已随交卷固定，请刷新查看",
              );
            if (prepared.kind === "legacy") {
              // v1 旧版底图（无 layout）：直接转只读原圈画查看，不报错、
              // 不进原位编辑（不重建底图、不创建待传空稿）。
              setOriginalScope(originalScopeKey);
              return false;
            }
            const saved = await getAnnotationRecord(session, scope, {
              strictRead: true,
            });
            const candidate = resolveFrozenQuestionSurface(
              saved,
              { sourceUrl: frozenUrlRef.current, decoded: decodedRef.current },
              openingFacts.current.readOnly,
            );
            const candidateSource = candidate.source;
            if (candidate.status === "blocked" || candidateSource === null)
              throw new Error(candidate.reason ?? "原稿尚未就绪，请重试");
            await measureStage("annotation:surface-ready", () =>
              waitForFrozenImage(candidateSource, signal),
            );
            if (
              signal.aborted ||
              openingFacts.current.identity !== openIdentity ||
              openingFacts.current.readOnly ||
              openingFacts.current.hidden
            )
              return false;
            const latest = await getAnnotationRecord(session, scope, {
              strictRead: true,
            });
            const ready = resolveFrozenQuestionSurface(
              latest,
              { sourceUrl: frozenUrlRef.current, decoded: decodedRef.current },
              openingFacts.current.readOnly,
            );
            if (
              !ready.canWrite ||
              openingFacts.current.identity !== openIdentity ||
              openingFacts.current.hidden
            )
              throw new Error(ready.reason ?? "原稿尚未就绪或已封存，请重试");
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
        const docVersion = current?.docVersion ?? null;
        const resetVersion = current?.resetVersion ?? 0;
        const baseIdentity =
          current?.localBase?.png ?? current?.base?.baseId ?? null;
        if ((current?.doc?.strokes.length ?? 0) > 0 && !canvas) return;
        const blob = canvas ? await canvasToPngBlob(canvas) : null;
        const latest = recordRef.current;
        if (
          cancelled ||
          latest?.docVersion !== docVersion ||
          (latest?.resetVersion ?? 0) !== resetVersion ||
          (latest?.localBase?.png ?? latest?.base?.baseId ?? null) !==
            baseIdentity
        )
          return;
        previewVersion.current = docVersion;
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
      !frozenReady ||
      !recordRef.current?.doc
    )
      return;
    const current = createAnnotationSurface({
      baseWidth,
      baseHeight,
      inputEnabled: false,
      inputMode: getSessionInputPreference(),
      // LR-6：收笔锚定的布局证据——从 record 活引用取当前 layout（effect
      // 闭包里的 layout 会过期）；无 layout（旧底图）返回 undefined 不锚。
      anchorBlocks: () => {
        const savedLayout =
          recordRef.current?.localBase?.layout ??
          recordRef.current?.base?.layout;
        if (savedLayout?.compatibility?.blocks === undefined) return undefined;
        // 评审 #11750 必改①：measure 落盘 CSS 像素，先转底图像素域再锚定
        return blocksInBaseDomain(
          savedLayout.compatibility.blocks,
          savedLayout.pixelRatio,
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
        { attemptId, questionId: question.id, phase },
        doc,
        sealedFinalization.current ? "sealed-finalization" : undefined,
      );
      setHistory((value) => value + 1);
    });
    return () => {
      finishSurface(current);
      current.destroy();
      surface.current = null;
    };
  }, [
    mountedOnce,
    session,
    attemptId,
    question.id,
    phase,
    cssWidth,
    cssHeight,
    baseWidth,
    baseHeight,
    frozenReady,
    finishSurface,
  ]);
  useEffect(() => {
    if (!mountedOnce) return;
    if (!active && recordRef.current?.sealedAt != null) finishSurface();
    surface.current?.setInputMode(inputPreference);
    surface.current?.setInputEnabled(active);
    surface.current?.setTool(
      tool === "pen" ? { type: "pen", color, size } : { type: "eraser" },
    );
  }, [active, tool, color, size, mountedOnce, inputPreference, finishSurface]);
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
      data-annotation-readonly={annotationReadOnly || record?.sealedAt != null}
      style={cssWidth ? { maxWidth: cssWidth } : undefined}
    >
      <div
        ref={viewport}
        data-slot="annotation-viewport"
        hidden={frozenSource !== null && answerMode}
        className={`relative mx-auto w-full min-w-0 overflow-x-auto ${active ? "outline outline-2 outline-offset-4 outline-sky-200" : ""}`}
        style={cssWidth ? { maxWidth: cssWidth } : undefined}
      >
        <div
          className="relative overflow-clip"
          style={
            cssWidth && cssHeight
              ? {
                  width: cssWidth * scale,
                  height: cssHeight * scale,
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
            {frozenSource !== null ? (
              !answerMode && (
                <div data-slot="annotation-frozen-surface" className="relative">
                  {frozenUrl && (
                    <img
                      src={frozenUrl}
                      alt={`${label}冻结原稿`}
                      className="block select-none"
                      style={
                        cssWidth && cssHeight
                          ? { width: cssWidth, height: cssHeight }
                          : undefined
                      }
                      draggable={false}
                      onLoad={(event) => {
                        const image = event.currentTarget;
                        const decoded = {
                          url: frozenUrl,
                          blob: frozenBlob,
                          width: image.naturalWidth,
                          height: image.naturalHeight,
                          failed: false,
                        };
                        decodedRef.current = decoded;
                        setDecodedImage(decoded);
                        imageWaiters.current.forEach((notify) => {
                          notify();
                        });
                      }}
                      onError={() => {
                        const decoded = {
                          url: frozenUrl,
                          blob: frozenBlob,
                          width: 0,
                          height: 0,
                          failed: true,
                        };
                        decodedRef.current = decoded;
                        setDecodedImage(decoded);
                        imageWaiters.current.forEach((notify) => {
                          notify();
                        });
                      }}
                    />
                  )}
                  {hasFrozenInput && frozenInput}
                </div>
              )
            ) : (
              <StableQuestionPixelGridContext value>
                {children}
              </StableQuestionPixelGridContext>
            )}
          </div>
          {cssWidth && cssHeight && (
            <div
              data-slot="question-annotation-overlay"
              data-drawing={active}
              className="pointer-events-none absolute left-0 top-0 z-10"
              hidden={!visible}
              style={{
                width: cssWidth * scale,
                height: cssHeight * scale,
              }}
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
      {frozenSource !== null && answerMode && (
        <div data-slot="annotation-answer-view" className="mt-3">
          {children}
        </div>
      )}
      {frozenSource !== null && !hasFrozenInput && (
        <Button
          type="button"
          variant="outline"
          className="mt-2 h-11"
          onClick={async () => {
            setError(null);
            if (answerMode) {
              setAnswerMode(false);
              return;
            }
            await enterAnswerView();
          }}
        >
          {answerMode ? "返回原稿" : "进入作答"}
        </Button>
      )}
      {resolution.status === "blocked" && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {resolution.reason}
        </p>
      )}
      {(fitScale < 0.85 || (hasFrozenInput && fitScale < 1)) && (
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
          {phase === "correction" ? "正在准备圈画…" : "正在准备标画，仍可作答…"}
        </p>
      )}
      {error && (
        <div role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {record?.retained?.reason && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {record.retained.reason}
        </p>
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
              ? phase === "correction"
                ? "按保存时的题面显示原圈画，仅供查看。关闭后可继续订正。"
                : "按保存时的题面显示原圈画，仅供查看。关闭后可继续作答。"
              : phase === "correction"
                ? "此题圈画为旧版，仅供查看。关闭后可继续订正。"
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
      {active &&
        createPortal(
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
                    <DropdownMenuItem
                      key={value}
                      onClick={() => setColor(value)}
                    >
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
                    <DropdownMenuItem
                      key={value}
                      onClick={() => setSize(value)}
                    >
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
                onClick={() => {
                  if (phase === "correction" || hasFrozenInput)
                    void editor?.request(null);
                  else void enterAnswerView();
                }}
              >
                {phase === "correction" ? "完成" : "作答"}
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
});
