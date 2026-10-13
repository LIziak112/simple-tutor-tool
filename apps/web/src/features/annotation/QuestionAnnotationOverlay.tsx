import type { AttemptQuestionPublic } from "@tutor/contract";
import { Eraser, MoreHorizontal, PenLine, Redo2, Undo2 } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
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
import { canvasToPngBlob } from "@/features/ink/engine/canvas-png";
import type { InkPenColor, InkPenSize } from "@/features/ink/engine/index";
import { SessionPrefToggleButton } from "@/features/ink/InkPad";
import {
  getSessionInputPreference,
  useSessionInputPreference,
} from "@/features/ink/input-preference";
import { PAPER_KEEPALIVE_MS } from "@/features/ink/use-retained-paper";
import {
  getAnnotationRecord,
  settleAnnotationPersistence,
  writeAnnotationDoc,
} from "./annotation-store";
import {
  type AnnotationSurface,
  createAnnotationSurface,
} from "./annotation-surface";
import { prepareQuestionAnnotationBase } from "./question-annotation-base";
import { questionSurfaceMatchesLayout } from "./question-base-image";
import {
  useAnnotationRecord,
  useAnnotationSessionRef,
} from "./use-annotation-record";

export interface QuestionAnnotationOverlayHandle {
  start(): Promise<void>;
}

/** 真实题面不替换成图片；原布局不匹配时才开放固定底图工作区。 */
export const QuestionAnnotationOverlay = forwardRef<
  QuestionAnnotationOverlayHandle,
  {
    attemptId: string;
    question: AttemptQuestionPublic;
    label: string;
    children: ReactNode;
    onLegacy(): void;
    hidden?: boolean;
  }
>(({ attemptId, question, label, children, onLegacy, hidden = false }, ref) => {
  const editor = useAttemptEditor(question.id);
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
  const [original, setOriginal] = useState(false);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [originalLoaded, setOriginalLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [color, setColor] = useState<InkPenColor>("red");
  const [size, setSize] = useState<InkPenSize>("thin");
  const [, setHistory] = useState(0);
  const layout = record?.localBase?.layout;
  const localPng = record?.localBase?.png;
  const selected =
    editor?.active?.questionId === question.id &&
    editor.active.kind === "annotation";
  const active =
    selected && (original ? originalLoaded : compatible === true && !hidden);
  const visible = original || (compatible === true && !hidden);
  const [mountedOnce, setMountedOnce] = useState(false);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewVersion = useRef<number | null>(null);
  const scope = {
    attemptId,
    questionId: question.id,
    phase: "scratch" as const,
  };

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
    await settleAnnotationPersistence();
    if (session) {
      const saved = await getAnnotationRecord(session, {
        attemptId,
        questionId: question.id,
        phase: "scratch",
      });
      if (saved?.local === "failed")
        throw new Error(saved.localError ?? "本机标画未保存");
    }
  }, [session, attemptId, question.id]);
  useEffect(
    () => editor?.register(question.id, finish),
    [editor?.register, question.id, finish],
  );

  useImperativeHandle(ref, () => ({
    async start() {
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
            );
            if (signal.aborted) return false;
            if (prepared.kind === "legacy") {
              onLegacy();
              return false;
            }
            if (prepared.kind === "sealed")
              throw new Error("标画已随交卷固定，请刷新查看");
            const matches = await questionSurfaceMatchesLayout(
              question,
              element,
              prepared.localBase.layout,
            );
            if (signal.aborted) return false;
            setCompatible(matches);
            if (!matches) {
              setOriginal(true);
              return false;
            }
            setOriginal(false);
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
            if (!matches && selected && !original) void editor?.request(null);
          })
          .catch(() => {
            if (!alive || current !== generation) return;
            setCompatible(false);
            if (selected && !original) void editor?.request(null);
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
  }, [layout, question, selected, original, hidden, editor?.request]);

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
      !layout ||
      !recordRef.current?.doc
    )
      return;
    const current = createAnnotationSurface({
      baseWidth: Math.ceil(layout.cssWidth * layout.pixelRatio),
      baseHeight: Math.ceil(layout.cssHeight * layout.pixelRatio),
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
  }, [mountedOnce, session, attemptId, question.id, layout]);
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
    if (!original || !localPng) return;
    const url = URL.createObjectURL(localPng);
    setOriginalUrl(url);
    setOriginalLoaded(false);
    return () => {
      URL.revokeObjectURL(url);
      setOriginalUrl(null);
    };
  }, [original, localPng]);

  return (
    <div
      ref={root}
      className="relative mx-auto w-full min-w-0"
      data-slot="annotated-question"
      style={layout && !original ? { maxWidth: layout.cssWidth } : undefined}
    >
      {children}
      {layout && (
        <div
          data-slot="question-annotation-overlay"
          data-drawing={active}
          className={
            original
              ? `relative mt-3 w-full bg-white ${active ? "outline outline-2 outline-offset-4 outline-sky-200" : ""}`
              : `pointer-events-none absolute left-0 top-0 z-10 ${active ? "outline outline-2 outline-offset-4 outline-sky-200" : ""}`
          }
          hidden={!visible}
          style={
            original
              ? { aspectRatio: `${layout.cssWidth} / ${layout.cssHeight}` }
              : { width: layout.cssWidth, height: layout.cssHeight }
          }
        >
          {original && originalUrl && (
            <img
              src={originalUrl}
              alt={`${label}原标画底图`}
              className="absolute inset-0 h-full w-full"
              onLoad={() => setOriginalLoaded(true)}
              onError={() => setError("原底图加载失败，请重新打开")}
            />
          )}
          <div
            ref={host}
            className="absolute inset-0"
            style={{ pointerEvents: active ? "auto" : "none" }}
          />
          {!mountedOnce && previewUrl && (
            <img
              src={previewUrl}
              alt="本题标画笔迹"
              className="pointer-events-none absolute inset-0 h-full w-full"
            />
          )}
        </div>
      )}
      {loading && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          正在准备标画，仍可作答…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {layout && compatible === false && !original && (
        <Button
          variant="outline"
          className="mt-2 h-11"
          onClick={() => setOriginal(true)}
        >
          查看原标画
        </Button>
      )}
      {original && (
        <div className="mt-2 flex gap-2">
          <Button
            variant="outline"
            className="h-11"
            onClick={() =>
              void editor?.request({
                questionId: question.id,
                kind: "annotation",
              })
            }
            disabled={!originalLoaded}
          >
            编辑原标画
          </Button>
          <Button
            variant="ghost"
            className="h-11"
            onClick={async () => {
              if (await editor?.request(null)) setOriginal(false);
            }}
          >
            收起原标画
          </Button>
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
