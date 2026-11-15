import type { AttemptQuestionPublic } from "@tutor/contract";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { useAttemptEditor } from "@/features/answering/AttemptEditorContext";
import { canvasToPngBlob } from "@/features/ink/engine/canvas-png";
import type { InkPenColor, InkPenSize } from "@/features/ink/engine/index";
import { PAPER_KEEPALIVE_MS } from "@/features/ink/use-retained-paper";
import { NoteToolbar } from "@/features/notes/NoteToolbar";
import { useAttemptSnapshotToken } from "@/features/persistence/AttemptSnapshotScope";
import { attemptMaterialsEditable } from "@/features/persistence/attempt-material-recovery";
import { prepareAnnotationForPwaUpdate } from "@/features/persistence/pwa-draft-safety";
import { useDraftSyncRecovery } from "@/features/persistence/use-draft-sync";
import {
  processStrokes,
  readProcessSurfaces,
  useQuestionProcessContext,
} from "@/features/question-process/session";
import { measureStage } from "@/lib/performance-stages";
import { usePwaUpdateGuard } from "@/lib/pwa-update-safety";
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
  QuestionAnnotationFrame,
  type QuestionAnnotationFrameHandle,
  type QuestionFrameGeometry,
  questionFrameIdentity,
} from "./QuestionAnnotationFrame";
import { prepareQuestionAnnotationBase } from "./question-annotation-base";
import { prepareQuestionAnnotationContinuation } from "./question-annotation-continuation";
import { resolveQuestionSurface } from "./question-surface-resolver";
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
    hidden = false,
    annotationReadOnly = false,
    phase = "scratch",
  } = props;
  const editor = useAttemptEditor(question.id);
  const recovery = useDraftSyncRecovery();
  const session = useAnnotationSessionRef();
  const expectedFrozenAt = useAttemptSnapshotToken(attemptId);
  const record = useAnnotationRecord(attemptId, question.id, phase);
  const process = useQuestionProcessContext();
  const processRef = useRef(process);
  processRef.current = process;
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
    question.questionRevisionId,
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
  const frame = useRef<QuestionAnnotationFrameHandle>(null);
  const [geometry, setGeometry] = useState<QuestionFrameGeometry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const resolution = resolveQuestionSurface(
    record ?? null,
    question.questionRevisionId,
    annotationReadOnly,
  );
  const layout = resolution.source?.layout ?? null;
  const frameIdentity = questionFrameIdentity(question, layout, openIdentity);
  const sameGeometryIdentity = geometry?.identity === frameIdentity;
  const geometryReady = sameGeometryIdentity && geometry.status === "ready";
  const frozenReady =
    sameGeometryIdentity &&
    (geometryReady || geometry.preserveInk === true) &&
    resolution.source !== null &&
    resolution.status !== "blocked";
  const cssWidth = layout?.cssWidth;
  const cssHeight = layout?.cssHeight;
  const baseWidth = resolution.source?.pixelWidth ?? 0;
  const baseHeight = resolution.source?.pixelHeight ?? 0;
  const localPng = record?.localBase?.png ?? null;
  const cloudBaseId =
    localPng === null ? (resolution.source?.baseId ?? null) : null;
  const selected =
    editor?.active?.questionId === question.id &&
    editor.active.kind === "annotation";
  const opening = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 新作用域独立准备，旧请求的迟到 finally 不得覆盖新会话
  useEffect(() => {
    opening.current = false;
    setLoading(false);
  }, [openIdentity]);
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
  const active =
    selected && !hidden && geometryReady && frozenReady && !resolution.readOnly;
  const visible = frozenReady && !hidden;
  const [mountedOnce, setMountedOnce] = useState(false);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewVersion = useRef<number | null>(null);
  const scope = {
    attemptId,
    questionId: question.id,
    phase,
  };
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

  useImperativeHandle(ref, () => ({
    async start() {
      if (!editor || !session || loading) return;
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
      if (resolution.status === "blocked") {
        setError(resolution.reason);
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
            if (prepared.kind === "legacy")
              throw new Error("旧版 v1 原稿缺少真实题面位置证据，原记录已保留");
            if (!element) throw new Error("题面尚未就绪，请重试");
            await prepareQuestionAnnotationContinuation(
              session,
              scope,
              question,
              element,
              prepared.localBase,
              signal,
            );
            if (
              signal.aborted ||
              openingFacts.current.identity !== openIdentity ||
              openingFacts.current.readOnly ||
              openingFacts.current.hidden
            )
              return false;
            const saved = await getAnnotationRecord(session, scope, {
              strictRead: true,
            });
            const candidate = resolveQuestionSurface(
              saved,
              question.questionRevisionId,
              openingFacts.current.readOnly,
            );
            if (
              !candidate.source ||
              candidate.status === "blocked" ||
              candidate.readOnly
            )
              throw new Error(
                candidate.reason ?? "原稿尚未就绪或已封存，请重试",
              );
            const matches = await frame.current?.verify(
              candidate.source.layout,
              signal,
            );
            if (!matches)
              throw new Error(
                "题面与保存基准偏差超过 10px 或区域不符，原稿已保留，请恢复原排版后重试",
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
            const ready = resolveQuestionSurface(
              latest,
              question.questionRevisionId,
              openingFacts.current.readOnly,
            );
            if (
              !ready.source ||
              ready.status === "blocked" ||
              ready.readOnly ||
              latest?.local !== "saved" ||
              JSON.stringify(ready.source.layout) !==
                JSON.stringify(candidate.source.layout)
            )
              throw new Error(
                ready.reason ?? "原稿尚未可靠保存或已变化，请重试",
              );
            return true;
          },
        );
      } catch (cause) {
        if (openingFacts.current.identity === openIdentity)
          setError(
            cause instanceof Error ? cause.message : "标画准备失败，请重试",
          );
      } finally {
        if (openingFacts.current.identity === openIdentity) {
          opening.current = false;
          setLoading(false);
        }
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
      inputMode: "pen",
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
    current.onChange((doc, reason, finish) => {
      const latest = recordRef.current;
      if (
        reason === "load" ||
        openingFacts.current.identity !== openIdentity ||
        (latest?.localBase?.png ?? null) !== localPng ||
        (localPng === null ? (latest?.base?.baseId ?? null) : null) !==
          cloudBaseId ||
        (recordRef.current?.resetVersion ?? 0) !== resetVersion
      )
        return;
      if (processRef.current && phase === "scratch") {
        const before = readProcessSurfaces(attemptId, question.id).annotation;
        processRef.current.ink(
          question.id,
          "annotation",
          reason,
          before,
          {
            ...before,
            width: doc.baseWidth,
            height: doc.baseHeight,
            strokes: processStrokes(doc.strokes),
          },
          finish,
        );
      }
      loadedVersion.current = writeAnnotationDoc(
        session,
        { attemptId, questionId: question.id, phase },
        doc,
        sealedFinalization.current ? "sealed-finalization" : undefined,
        expectedFrozenAt,
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
    openIdentity,
    phase,
    cssWidth,
    cssHeight,
    baseWidth,
    baseHeight,
    localPng,
    cloudBaseId,
    frozenReady,
    finishSurface,
    expectedFrozenAt,
  ]);
  useEffect(() => {
    if (!mountedOnce) return;
    if (!active && recordRef.current?.sealedAt != null) finishSurface();
    surface.current?.setInputEnabled(active);
    surface.current?.setTool(
      tool === "pen" ? { type: "pen", color, size } : { type: "eraser" },
    );
  }, [active, tool, color, size, mountedOnce, finishSurface]);
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
      <QuestionAnnotationFrame
        ref={frame}
        question={question}
        layout={layout}
        scopeKey={openIdentity}
        active={active}
        onBeforeResize={finishSurface}
        onGeometryChange={setGeometry}
        inkLayer={
          <div
            data-slot="question-annotation-overlay"
            data-drawing={active}
            className="absolute inset-0"
            hidden={!visible}
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
        }
      >
        {children}
      </QuestionAnnotationFrame>
      {geometry?.identity === frameIdentity &&
        geometry.status === "blocked" && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {geometry.reason}
          </p>
        )}
      {resolution.status === "blocked" && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {resolution.reason}
        </p>
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
      {active &&
        createPortal(
          <div
            data-slot="attempt-bottom-bar"
            className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]"
          >
            <div className="mx-auto flex min-h-16 max-w-[1120px] items-center justify-center gap-1 px-2 py-2">
              <NoteToolbar
                compact
                label={`${label}标画`}
                tool={tool}
                onToolChange={setTool}
                color={color}
                onColorChange={setColor}
                size={size}
                onSizeChange={setSize}
                canUndo={surface.current?.canUndo() ?? false}
                canRedo={surface.current?.canRedo() ?? false}
                onUndo={() => surface.current?.undo()}
                onRedo={() => surface.current?.redo()}
                onClearRequest={() => surface.current?.clear()}
                clearLabel="清空标画（可撤销）"
                moreLabel="更多标画操作"
              >
                <Button
                  className="h-11 w-16 shrink-0 px-2"
                  onClick={() => {
                    void editor?.request(null);
                  }}
                >
                  完成标画
                </Button>
              </NoteToolbar>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
});
