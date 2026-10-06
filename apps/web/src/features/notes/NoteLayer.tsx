/**
 * 题卡级草稿层（T6R.9，方案 §4.3/§5.3）：非手写题（选择/多选/判断/填空）
 * 的演算草稿纸。手写题不走本组件（继续 HandwrittenControls 的作答 ink）。
 *
 * 形态：
 * - **收起**：只显示「草稿纸 · N 笔」标记按钮（有笔迹时含笔数与待处理
 *   提示）；纸面隐藏保留（复审⑦：收起后引擎保活 NOTE_ENGINE_KEEPALIVE_MS，
 *   重开零重建；超时才卸载）；
 * - **展开**：精简工具条（笔/橡皮/撤销/手指书写/更多——「手指书写」按钮
 *   归属本工具条，T6R.7 衔接注记①定案：本形态下 InkPad 内置工具条不渲染，
 *   按钮在彼处不可达，且无笔设备的切换是首要高频动作，不藏进「更多」；
 *   会话偏好 store 两侧共用不变）+ 纸面（InkPad 隐藏工具条形态）+ 四维
 *   状态区。
 *
 * 纸高（方案 §4.3 / T6R.7 衔接注记②定案）：逻辑高持久化在 NoteDoc，
 * CSS 高 = paperCssHeight(逻辑高, 纸宽) 每次换算；自动加高统一走
 * paper-geometry 逻辑口径（触发 72 CSS px 经换算判定、步长 240/scale 逻辑
 * 单位；InkPad 内置 CSS px 直增在本形态被禁用）；load 不触发 dirty
 * （reason 过滤）；grownPaperHeight 返回 null 即不落库（防棘轮）。触底
 * 包围盒增量维护（复审⑥：每笔 max(prev, 新笔底)，全稿重扫只在载入/挂载
 * 冷路径）。
 *
 * 自写自载守卫（复审②）：比对 note-store 的**正文版本令牌 docVersion**
 * （record.doc 整体替换次数）——我们写入后记下当前令牌，视图令牌相同即
 * 引擎已持有最新内容（跳过 load）；不同即外部换稿（服务端播种/冲突裁决）
 * → 载入引擎。不依赖 store 拷贝深度的任何隐式约定。
 *
 * 多题隔离：正文键含 questionId（note-store 五元键），各题各自一份；布局
 * 切换只改外框宽度——逻辑坐标笔画恒在纸内，不新建笔记、不改正文身份。
 */
import type { NoteDoc } from "@tutor/contract";
import { NOTE_PAPER_HEIGHT_DEFAULT } from "@tutor/contract";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Eraser,
  LoaderCircle,
  MoreHorizontal,
  NotebookPen,
  PenLine,
  Pointer,
  Redo2,
  Trash,
  Undo2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { strokeBounds } from "@/features/ink/engine/bounds.ts";
import type {
  InkChangeReason,
  InkDoc,
  InkEngine,
  InkPenColor,
  InkPenSize,
} from "@/features/ink/engine/index.ts";
import { InkPad } from "@/features/ink/InkPad";
import {
  getSessionInputPreference,
  onSessionInputPreferenceChange,
  setSessionInputPreference,
} from "@/features/ink/input-preference.ts";
import { recoverNoteImages } from "@/features/notes/image-sync";
import { docOf } from "@/features/notes/note-fixtures";
import {
  type NoteLayoutPreference,
  setNoteLayoutPreference,
  useNoteLayoutPreference,
} from "@/features/notes/note-layout";
import {
  ensureNoteLoaded,
  peekNoteRecord,
  writeNoteDoc,
} from "@/features/notes/note-store";
import {
  resolveNoteConflictKeepCloud,
  resolveNoteConflictKeepLocal,
  retryNoteUpload,
} from "@/features/notes/note-sync";
import {
  grownPaperHeight,
  paperCssHeight,
  strokesBottomLogical,
} from "@/features/notes/paper-geometry";
import { useNoteHead, useNoteSessionRef } from "@/features/notes/use-note-head";
import { useNoteRecord } from "@/features/notes/use-note-record";
import { useObservedCssWidth } from "@/lib/use-observed-css-width";

/** 触控目标硬性尺寸（ui-conventions）：工具条按钮统一 h-11 */
const TOOL_BUTTON_CLASS =
  "h-11 min-w-11 px-2.5 gap-1.5 rounded-lg border border-border text-sm font-medium select-none transition-colors";

/** 宽度观察未就绪（jsdom/首帧/纸面隐藏）的纸高回退（暂定：与 InkPad 初始高同量级） */
const NOTE_CSS_HEIGHT_FALLBACK = 320;

/**
 * 收起后的引擎保活时长（复审⑦暂定 45s，区间 30-60s）：收起题卡高频发生在
 * 「先做选项再回草稿」的往返里，立即卸载会让重开整段重建（引擎实例 + 笔迹
 * 重放）。超时（确无回写意图）才真正卸载释放画布内存。
 */
export const NOTE_ENGINE_KEEPALIVE_MS = 45_000;

const PEN_COLOR_LABEL: Record<InkPenColor, string> = {
  black: "黑",
  blue: "蓝",
  red: "红",
};
const PEN_SIZE_LABEL: Record<InkPenSize, string> = {
  thin: "细",
  medium: "中",
  thick: "粗",
};
const LAYOUT_LABEL: Record<NoteLayoutPreference, string> = {
  auto: "自动（按宽度）",
  side: "左右分栏",
  below: "上下排列",
};

/** 空稿默认形态（未建记录时的起笔口径；首次书写才真正建记录） */
const EMPTY_NOTE_DOC: NoteDoc = docOf([]);

/** NoteDoc.ink → 引擎 InkDoc（atrament；updatedAt 无语义位补 0） */
function inkDocOf(doc: NoteDoc): InkDoc {
  return { engine: "atrament", version: 1, data: doc.ink, updatedAt: 0 };
}

export interface NoteLayerProps {
  attemptId: string;
  questionId: string;
  /** 展开/收起受控（题卡持有：side 布局展开时才分栏） */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 无障碍标签前缀（如「第 3 题」），空格拼接「草稿纸」 */
  ariaPrefix?: string;
}

export function NoteLayer({
  attemptId,
  questionId,
  open,
  onOpenChange,
  ariaPrefix = "本题",
}: NoteLayerProps) {
  const session = useNoteSessionRef();
  const view = useNoteRecord(attemptId, questionId);
  const headQuery = useNoteHead(attemptId, questionId);
  const layoutPref = useNoteLayoutPreference();

  // ---- 本地载入（刷新/重进的恢复路径；区分「尚未加载」与「无记录」） ----
  const [localLoaded, setLocalLoaded] = useState(false);
  useEffect(() => {
    if (session === null) return;
    let cancelled = false;
    void ensureNoteLoaded(session, {
      attemptId,
      questionId,
      phase: "scratch",
    }).then(() => {
      if (!cancelled) setLocalLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [session, attemptId, questionId]);

  const doc = view?.doc ?? null;
  const strokeCount = doc?.ink.strokes.length ?? 0;

  // 有笔迹自动展开一次（本地恢复或服务端播种到达后；用户手动收起不复活）
  const autoExpandedRef = useRef(false);
  useEffect(() => {
    if (autoExpandedRef.current || strokeCount === 0) return;
    autoExpandedRef.current = true;
    onOpenChange(true);
  }, [strokeCount, onOpenChange]);

  // ---- 纸面几何（逻辑高持久化、CSS 高换算；宽度经 ResizeObserver） ----
  const paperWrapRef = useRef<HTMLDivElement | null>(null);
  const cssWidth = useObservedCssWidth(paperWrapRef);
  const cssHeight =
    cssWidth > 0
      ? paperCssHeight(
          doc?.paperHeightLogical ?? NOTE_PAPER_HEIGHT_DEFAULT,
          cssWidth,
        )
      : NOTE_CSS_HEIGHT_FALLBACK;
  const cssWidthRef = useRef(cssWidth);
  cssWidthRef.current = cssWidth;

  // ---- 引擎接线（纸面隐藏保留保活；卸载只发生在保活超时/组件卸载） ----
  const engineRef = useRef<InkEngine | null>(null);
  /** 自写自载守卫令牌（复审②）：最近一次「引擎已持有」的正文版本 */
  const lastWriteVersionRef = useRef<number | null>(null);
  /** 触底包围盒底（逻辑，含半线宽；复审⑥：每笔增量，载入/挂载重算） */
  const bottomLogicalRef = useRef<number | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [penColor, setPenColor] = useState<InkPenColor>("black");
  const [penSize, setPenSize] = useState<InkPenSize>("medium");
  const [clearOpen, setClearOpen] = useState(false);

  // 本地写入 + 逻辑口径自动加高（注记②定案；load 不写回——reason 过滤）
  const scopeRef = useRef({ attemptId, questionId, phase: "scratch" as const });
  scopeRef.current = { attemptId, questionId, phase: "scratch" };
  const handleDocChange = useCallback(
    (inkDoc: InkDoc, reason: InkChangeReason) => {
      if (inkDoc.engine !== "atrament" || session === null) return;
      // load 不写回（paper-geometry 口径：载入恢复不算编辑、不触发 dirty）
      if (reason === "load") return;
      const strokes = inkDoc.data.strokes;
      // 写前 peek 补纸高/背景（复审②：不再持有引擎侧快照——store 是唯一真相）
      const record = peekNoteRecord(session, scopeRef.current);
      let logical = record?.doc.paperHeightLogical ?? NOTE_PAPER_HEIGHT_DEFAULT;
      const background = record?.doc.background ?? "grid";
      if (reason === "stroke") {
        // 触底加高：统一 paper-geometry 逻辑口径。包围盒增量（复审⑥）——
        // 只看新笔（含半线宽），与既有底取 max；全稿重扫只在载入/挂载
        const last = strokes[strokes.length - 1];
        if (last !== undefined) {
          const bb = strokeBounds(last, last.weight / 2);
          if (bb !== null) {
            bottomLogicalRef.current = Math.max(
              bottomLogicalRef.current ?? 0,
              bb.maxY,
            );
          }
        }
        if (bottomLogicalRef.current !== null) {
          const grown = grownPaperHeight({
            paperHeightLogical: logical,
            cssWidth: cssWidthRef.current,
            strokeMaxYLogical: bottomLogicalRef.current,
          });
          if (grown !== null) logical = grown; // null=无需增高 ⇒ 不落库（防棘轮）
        }
      }
      writeNoteDoc(session, scopeRef.current, {
        version: 1,
        ink: inkDoc.data,
        paperHeightLogical: logical,
        background,
      });
      // 登记守卫令牌（复审②）：写入后的正文版本——同令牌的视图变化即自写
      lastWriteVersionRef.current =
        peekNoteRecord(session, scopeRef.current)?.docVersion ?? null;
      setCanUndo(engineRef.current?.canUndo() ?? false);
      setCanRedo(engineRef.current?.canRedo() ?? false);
    },
    [session],
  );

  // 外部正文变化 → 载入引擎（服务端播种/冲突裁决后）。比对版本令牌
  // （复审②）：视图 docVersion 与最近一次「引擎已持有」令牌相同 → 跳过；
  // 不同 → 外部换稿，载入。挂载首帧登记令牌（initial 已带 store 当前内容）。
  useEffect(() => {
    if (!open || session === null) return;
    const engine = engineRef.current;
    if (engine === null) return;
    const version = view?.docVersion ?? 0;
    const target = view?.doc ?? EMPTY_NOTE_DOC;
    if (lastWriteVersionRef.current === null) {
      lastWriteVersionRef.current = version;
      bottomLogicalRef.current = strokesBottomLogical(target.ink.strokes);
      return;
    }
    if (version === lastWriteVersionRef.current) return; // 最新变化是我们自己的写
    engine.load(inkDocOf(target));
    lastWriteVersionRef.current = version;
    bottomLogicalRef.current = strokesBottomLogical(target.ink.strokes);
    setCanUndo(engine.canUndo());
    setCanRedo(engine.canRedo());
  }, [open, view, session]);

  // 工具下发（挂载与切换时；InkPad 挂载后父 effect 晚于子 effect——引擎已就绪）
  // biome-ignore lint/correctness/useExhaustiveDependencies(open): open 变化=纸面隐藏/显示切换，需重发当前工具
  useEffect(() => {
    engineRef.current?.setTool(
      tool === "pen"
        ? { type: "pen", color: penColor, size: penSize }
        : { type: "eraser" },
    );
  }, [tool, penColor, penSize, open]);

  // ---- 会话输入偏好（注记①：按钮在本工具条；store 与 InkPad 两侧共用） ----
  const sessionPref = useSyncExternalStore(
    onSessionInputPreferenceChange,
    getSessionInputPreference,
  );

  // ---- 收起保活（复审⑦）：展开即清计时；收起计时到点才卸载纸面 ----
  const [paperAlive, setPaperAlive] = useState(false);
  const keepaliveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (open) {
      setPaperAlive(true);
      if (keepaliveRef.current !== null) {
        clearTimeout(keepaliveRef.current);
        keepaliveRef.current = null;
      }
      return;
    }
    keepaliveRef.current = setTimeout(() => {
      keepaliveRef.current = null;
      setPaperAlive(false);
    }, NOTE_ENGINE_KEEPALIVE_MS);
    return () => {
      if (keepaliveRef.current !== null) {
        clearTimeout(keepaliveRef.current);
        keepaliveRef.current = null;
      }
    };
  }, [open]);

  // ---- 冲突裁决 / 被拒重试 / 补图重试 ----
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [imageRetrying, setImageRetrying] = useState(false);

  const keepLocal = useCallback(() => {
    if (session === null) return;
    setResolveError(null);
    void resolveNoteConflictKeepLocal(session, scopeRef.current).catch(
      (err: unknown) => {
        setResolveError(err instanceof Error ? err.message : "操作失败");
      },
    );
  }, [session]);

  const keepCloud = useCallback(() => {
    if (session === null) return;
    setResolveError(null);
    void resolveNoteConflictKeepCloud(session, scopeRef.current).catch(
      (err: unknown) => {
        setResolveError(err instanceof Error ? err.message : "操作失败");
      },
    );
  }, [session]);

  const retryDenied = useCallback(() => {
    if (session === null) return;
    void retryNoteUpload(session, scopeRef.current);
  }, [session]);

  /** 正文 synced 且图片 failed/missing 的手动补图入口（重进入已自动触发过） */
  const retryImages = useCallback(() => {
    const versionId = headQuery.data?.note?.currentVersionId ?? null;
    if (versionId === null) return;
    setImageRetrying(true);
    void recoverNoteImages({ role: "student", versionId })
      .catch((err: unknown) => {
        console.warn("手动补图失败", err);
      })
      .then(() => headQuery.refetch())
      .finally(() => setImageRetrying(false));
  }, [headQuery]);

  const label = `${ariaPrefix}草稿纸`;

  // ---- 纸面节点（收起时隐藏保留——位置恒定，开合零重挂载，复审⑦） ----
  const paperNode = paperAlive ? (
    localLoaded ? (
      <InkPad
        engine="atrament"
        showToolbar={false}
        inputMode="session"
        label={label}
        engineRef={engineRef}
        background={doc?.background ?? "grid"}
        paperHeight={cssHeight}
        initial={inkDocOf(doc ?? EMPTY_NOTE_DOC)}
        onDocChange={handleDocChange}
      />
    ) : null
  ) : null;

  return (
    <div data-slot="note-layer" className="flex min-w-0 flex-col gap-2">
      {/* 收起形态：标记按钮（有笔迹只显示标记——纸面隐藏不占布局） */}
      {!open && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 gap-1.5"
            onClick={() => onOpenChange(true)}
            aria-label={
              strokeCount > 0 ? `${label}（已有 ${strokeCount} 笔）` : label
            }
          >
            <NotebookPen aria-hidden className="size-4" />
            草稿纸
            {strokeCount > 0 && (
              <span className="text-muted-foreground">· {strokeCount} 笔</span>
            )}
            <ChevronDown aria-hidden className="size-4" />
          </Button>
          {(view?.conflict != null ||
            view?.denied != null ||
            view?.local === "failed") && (
            <span
              role="status"
              className="flex items-center gap-1 text-xs text-amber-600"
            >
              <CircleAlert aria-hidden className="size-3.5" />
              草稿同步需处理，点开查看
            </span>
          )}
        </div>
      )}

      {/* 展开形态：标题行 + 精简工具条（方案 §4.3：常驻笔/橡皮/撤销/更多＋
          手指书写；44px 触控目标） */}
      {open && (
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <NotebookPen aria-hidden className="size-4" />
            草稿纸
            {strokeCount > 0 && (
              <span className="font-normal text-muted-foreground">
                {strokeCount} 笔
              </span>
            )}
          </p>
          <Button
            type="button"
            variant="ghost"
            className="h-11 gap-1 px-2.5"
            onClick={() => onOpenChange(false)}
            aria-label={`收起${label}`}
          >
            <ChevronDown aria-hidden className="size-4" />
            收起
          </Button>
        </div>
      )}
      {open && (
        <div
          role="toolbar"
          aria-label={`${label}工具栏`}
          className="flex flex-wrap items-center gap-1.5"
        >
          <Button
            type="button"
            variant={tool === "pen" ? "secondary" : "ghost"}
            aria-pressed={tool === "pen"}
            onClick={() => setTool("pen")}
            className={TOOL_BUTTON_CLASS}
            title="笔"
          >
            <PenLine aria-hidden />笔
          </Button>
          <Button
            type="button"
            variant={tool === "eraser" ? "secondary" : "ghost"}
            aria-pressed={tool === "eraser"}
            onClick={() => setTool("eraser")}
            className={TOOL_BUTTON_CLASS}
            title="橡皮（整笔擦除）"
          >
            <Eraser aria-hidden />
            橡皮
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!canUndo}
            onClick={() => engineRef.current?.undo()}
            className={TOOL_BUTTON_CLASS}
            title="撤销"
          >
            <Undo2 aria-hidden />
            撤销
          </Button>
          {/* 手指书写（注记①定案：归属本工具条，一次点击可达） */}
          <Button
            type="button"
            variant={sessionPref === "finger" ? "secondary" : "ghost"}
            aria-pressed={sessionPref === "finger"}
            onClick={() =>
              setSessionInputPreference(
                sessionPref === "pen" ? "finger" : "pen",
              )
            }
            className={TOOL_BUTTON_CLASS}
            title={
              sessionPref === "pen"
                ? "手指书写（无笔设备：手指直接书写；本会话内所有草稿画布生效）"
                : "切回笔写／手指滚动（本会话内所有草稿画布生效）"
            }
          >
            <Pointer aria-hidden />
            手指书写
          </Button>

          <div className="ml-auto">
            <DropdownMenu>
              <DropdownMenuTrigger
                type="button"
                aria-label={`更多操作（${label}）`}
                title="更多（重做/颜色/粗细/清空/布局）"
                className={`${TOOL_BUTTON_CLASS} border-transparent`}
              >
                <MoreHorizontal aria-hidden />
                更多
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={!canRedo}
                  onSelect={() => engineRef.current?.redo()}
                >
                  <Redo2 aria-hidden />
                  重做
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {(Object.keys(PEN_COLOR_LABEL) as InkPenColor[]).map((c) => (
                  <DropdownMenuItem
                    key={c}
                    aria-checked={penColor === c}
                    onSelect={() => {
                      setPenColor(c);
                      setTool("pen");
                    }}
                  >
                    <Check
                      aria-hidden
                      className={penColor === c ? "visible" : "invisible"}
                    />
                    颜色：{PEN_COLOR_LABEL[c]}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                {(Object.keys(PEN_SIZE_LABEL) as InkPenSize[]).map((s) => (
                  <DropdownMenuItem
                    key={s}
                    aria-checked={penSize === s}
                    onSelect={() => {
                      setPenSize(s);
                      setTool("pen");
                    }}
                  >
                    <Check
                      aria-hidden
                      className={penSize === s ? "visible" : "invisible"}
                    />
                    粗细：{PEN_SIZE_LABEL[s]}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setClearOpen(true)}
                >
                  <Trash aria-hidden />
                  清空草稿纸
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {(Object.keys(LAYOUT_LABEL) as NoteLayoutPreference[]).map(
                  (p) => (
                    <DropdownMenuItem
                      key={p}
                      aria-checked={layoutPref === p}
                      onSelect={() => setNoteLayoutPreference(p)}
                    >
                      <Check
                        aria-hidden
                        className={layoutPref === p ? "visible" : "invisible"}
                      />
                      布局：{LAYOUT_LABEL[p]}
                    </DropdownMenuItem>
                  ),
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}

      {/* 纸面（位置恒定：收起 hidden 保留、保活期后卸载；不在未恢复的纸面上起笔） */}
      <div
        ref={paperWrapRef}
        data-slot="note-paper"
        className="w-full"
        hidden={!open}
      >
        {open || paperAlive
          ? (paperNode ?? (
              <div
                role="status"
                className="flex h-20 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground"
              >
                <LoaderCircle aria-hidden className="size-4 animate-spin" />
                正在打开草稿…
              </div>
            ))
          : null}
      </div>

      {/* 四维状态区 + 冲突/被拒/补图面板（方案 §5.3：正交、可理解、可操作） */}
      {open && (
        <NoteStatusArea
          view={view}
          localLoaded={localLoaded}
          resolveError={resolveError}
          onKeepLocal={keepLocal}
          onKeepCloud={keepCloud}
          onRetryDenied={retryDenied}
          imageRetrying={imageRetrying}
          onRetryImages={retryImages}
        />
      )}

      {/* 清空二次确认（清空=空稿作为新正文版本保存——覆盖语义同 ink 通道） */}
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清空草稿纸？</DialogTitle>
            <DialogDescription>
              将清除本题草稿的全部笔迹，清空后可用「撤销」恢复；已同步到服务端
              的旧版本不受影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => setClearOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-11"
              onClick={() => {
                engineRef.current?.clear();
                setClearOpen(false);
              }}
            >
              清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * 四维状态区（方案 §5.3「状态必须正交」）：本地正文（saving/saved/failed）、
 * 服务端正文（dirty/uploading/synced；conflict/denied 走面板）、派生图片
 * （pending/failed/missing——仅正文已同步时提及，「图片待生成」≠「未保存」；
 * failed/missing 的判定内聚于此，复审⑩）。证据维度（evidence）草稿期恒
 * none，交卷固定后由 T6R.10 展示。
 */
function NoteStatusArea({
  view,
  localLoaded,
  resolveError,
  onKeepLocal,
  onKeepCloud,
  onRetryDenied,
  imageRetrying,
  onRetryImages,
}: {
  view: ReturnType<typeof useNoteRecord>;
  localLoaded: boolean;
  resolveError: string | null;
  onKeepLocal: () => void;
  onKeepCloud: () => void;
  onRetryDenied: () => void;
  imageRetrying: boolean;
  onRetryImages: () => void;
}) {
  if (view === null) {
    return localLoaded ? null : (
      <p role="status" className="text-xs text-muted-foreground">
        草稿状态加载中…
      </p>
    );
  }
  const parts: string[] = [];
  // 本地维度（IDB 事务）
  if (view.local === "saving") parts.push("本机保存中…");
  if (view.local === "failed") {
    return (
      <p role="alert" className="text-xs text-destructive">
        本机保存失败：{view.localError ?? "存储不可用"}。可继续书写（内容暂存
        内存）；请检查设备存储空间，空间恢复后新笔迹会重新落盘。
      </p>
    );
  }
  // 服务端维度（同步队列视角；conflict/denied 走面板，不与文案混排）
  if (view.server === "uploading") parts.push("同步中…");
  else if (view.server === "dirty") parts.push("等待同步");
  // 图片维度（仅正文已同步时提示——派生任务不阻塞作答与交卷）
  if (view.server === "synced" && view.overview.images === "pending") {
    parts.push("图片待生成");
  }
  const imagesFailed =
    view.server === "synced" &&
    (view.overview.images === "failed" || view.overview.images === "missing");

  return (
    <div className="flex flex-col gap-1.5">
      {parts.length > 0 && (
        <p role="status" className="text-xs text-muted-foreground">
          {parts.join(" · ")}
        </p>
      )}
      {view.conflict !== null && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900"
        >
          <p className="font-medium">草稿内容冲突</p>
          <p className="break-words">{view.conflict.reason}</p>
          <p className="text-amber-700">
            本机与服务端各保留了一份草稿，请选择保留哪一份（未被保留的一份仍
            可在导出材料中找回）。
          </p>
          {resolveError !== null && (
            <p className="text-destructive">{resolveError}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={onKeepLocal}
            >
              保留本机内容
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={onKeepCloud}
            >
              保留服务端内容
            </Button>
          </div>
        </div>
      )}
      {view.denied !== null && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-border bg-muted/60 px-3 py-2.5 text-xs"
        >
          <p className="font-medium">
            {view.denied.kind === "access" ? "草稿已停止同步" : "草稿内容被拒"}
          </p>
          <p className="break-words text-muted-foreground">
            {view.denied.reason}
            {view.denied.kind === "content"
              ? "。继续书写产生新内容后会自动重试上传。"
              : "。本机草稿已保留，若权限恢复可重试同步。"}
          </p>
          {view.denied.kind === "access" && (
            <Button
              type="button"
              variant="outline"
              className="h-11 self-start"
              onClick={onRetryDenied}
            >
              重试同步
            </Button>
          )}
        </div>
      )}
      {imagesFailed && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
        >
          <span>草稿图片未生成完整（正文已保存，不影响作答与交卷）。</span>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={imageRetrying}
            onClick={onRetryImages}
          >
            {imageRetrying ? "生成中…" : "重新生成图片"}
          </Button>
        </div>
      )}
    </div>
  );
}
