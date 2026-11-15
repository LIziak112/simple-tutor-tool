import type { NoteBackground } from "@tutor/contract";
import { CircleAlert, LoaderCircle, Pointer } from "lucide-react";
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
  create,
  type InkChangeReason,
  type InkDoc,
  type InkEngine,
  type InkEngineKind,
} from "./engine/index.ts";
import { fromLogical } from "./engine/normalize.ts";
import {
  PAPER_GROW_STEP_CSS_PX,
  PAPER_GROW_TRIGGER_CSS_PX,
} from "./engine/paper-style.ts";
import { createInkToolbox, toolConfigOf } from "./engine/toolbox.ts";
import type { InkToolType } from "./engine/types.ts";
import { useInkProfileSelection } from "./ink-profile-store";
import {
  getSessionInputPreference,
  type InkSessionInputPreference,
  onSessionInputPreferenceChange,
  setSessionInputPreference,
} from "./input-preference.ts";
import { InkToolbar, inkToolButtonClass } from "./toolbar/InkToolbar.tsx";

/**
 * <InkPad>：手写引擎的 React 外壳（T2.7，架构 §5.4.1 "组件拆为两层"）。
 *
 * - 引擎与输入处理在 features/ink/engine（纯 TS）；本组件只负责工具栏、
 *   清空二次确认、自动加高、加载/错误态等 UI；
 * - 每笔结束（含撤销/重做/清空/load）经 onDocChange 上抛 InkDoc 与变化原因
 *   （reason，T4.0b ink_edit_batch 分型；缺省 "stroke"，老回调忽略零影响）；
 * - 自动加高（§5.4.1 绘制层第 4 条）：最后一笔接近答题区底部时自动增高；
 * - 输入模式：缺省 "auto" 自动探测；"pen" 固定笔写、手指滚动；
 *   "session" 订阅会话偏好并提供「手指书写」切换。
 * - 内置工具栏就是共用的 InkToolbar（toolbar/InkToolbar.tsx）。页内引擎提供
 *   笔、荧光笔、橡皮、形状、滚动；历史 Excalidraw 画布只认笔、橡皮、选择，
 *   不认颜色和粗细，所以不带选项面板。线上的页内纸面（草稿纸、正式手写、
 *   随笔）都由 PaperEditor 在外层出工具栏（showToolbar=false），内置工具栏
 *   目前只有历史 Excalidraw 画布在用；外层出工具栏时工具也只由外层下发。
 */
export interface InkPadProps {
  /** 底层引擎：atrament（页内答题区，默认）/ excalidraw（全屏作答） */
  engine?: InkEngineKind;
  /** 保活纸面收起时停止输入，默认开启以兼容其他调用方。 */
  inputEnabled?: boolean;
  /** 恢复的笔迹（草稿）；exactOptionalPropertyTypes 下显式接受 undefined */
  initial?: InkDoc | undefined;
  /** atrament 初始高度（CSS 像素），写到底部自动加高 */
  initialHeight?: number;
  /** 填满父容器高度（全屏作答形态）：画布占满余下空间，禁用自动加高 */
  fill?: boolean;
  /** 无障碍标签 */
  label?: string;
  /** 每次笔迹变化回调（doc + 变化原因，T4.0b 起带 reason） */
  onDocChange?:
    | ((
        doc: InkDoc,
        reason: InkChangeReason,
        finish?: import("@tutor/contract").QuestionProcessFinish,
      ) => void)
    | undefined;
  /** 引擎实例透出（开发页/草稿保存等需要命令式访问 getData/load/exportPng） */
  engineRef?: React.RefObject<InkEngine | null> | undefined;
  /** 草稿固定笔写；正式手写可订阅会话偏好。 */
  inputMode?: InkPadInputMode;
  /**
   * 纸张背景（T6R.9 NoteLayer 传入 doc.background）：透传引擎（格线/横线
   * 由适配器设置；缺省不设置任何背景样式=旧作答白底零变化）。
   */
  background?: NoteBackground;
  /**
   * 是否渲染内置工具条（默认开启）。纸面由外层提供工具栏时关闭。
   */
  showToolbar?: boolean;
  /**
   * 受控纸高（CSS px，T6R.9 NoteLayer 专用）：提供时画布容器高度恒为此值、
   * **禁用内部 CSS px 直增自动加高**——新草稿的加高决策统一走
   * notes/paper-geometry 逻辑口径（触发 72/步长 240 经逻辑换算，T6R.7 衔接
   * 注记②定案），外层换算出 CSS 高后回填本 prop。缺省=旧行为（initialHeight
   * 起步 + 内部自动加高，手写作答链路语义不变）。
   */
  paperHeight?: number;
  /**
   * 引擎（重）建完成通知（T6R.9 复审①⑥）：挂载与背景重建键换引擎后回调
   * 一次——消费方（NoteLayer）据此重跑外部同步 effect（新引擎 initial 可能
   * 陈旧，需按 store 现值重载正文）。
   */
  onEngineRebuild?: (() => void) | undefined;
  /**
   * LR-2：墓碑点数预算透传（InkStore）。正式手写链（HandwrittenControls）
   * 传 INK_MAX_DELETED_POINTS（60k，与服务端 inkDocSchema 限额同值——413 后
   * 无自愈路径，客户端先压实）；草稿链缺省 100k 不传。
   */
  maxDeletedPoints?: number;
}

/** auto=旧行为；pen=手指只滚动；session=会话输入偏好。 */
export type InkPadInputMode = "auto" | "pen" | "session";

/** 内置工具栏提供的工具：页内引擎五种；历史 Excalidraw 画布三种 */
const ATRAMENT_TOOLS: readonly InkToolType[] = [
  "pen",
  "highlighter",
  "eraser",
  "shape",
  "scroll",
];
const EXCALIDRAW_TOOLS: readonly InkToolType[] = ["pen", "eraser", "scroll"];
/** 滚动工具位在 Excalidraw 中是选择（套索移动） */
const EXCALIDRAW_TOOL_LABELS = { scroll: "选择" } as const;

/** 非 session 档的常量订阅（不订阅任何源）与常量快照（恒 pen）——
 * useSyncExternalStore 不得条件调用（复审⑪），非 session 档用稳定常量 */
const SUBSCRIBE_NOTHING = () => () => undefined;
const SNAPSHOT_PEN = (): InkSessionInputPreference => "pen";

/**
 * 「手指书写」切换按钮（T6R.7 衔接注记①定案后的共用件，T6R.9 复审⑭）：
 * 正式手写和 InkPad 内置工具条共用会话偏好、
 * 形态/文案/title 一处维护（与工具栏按钮同形，44px 触控目标）。
 */
export function SessionPrefToggleButton({ disabled }: { disabled?: boolean }) {
  const sessionPref = useSyncExternalStore(
    onSessionInputPreferenceChange,
    getSessionInputPreference,
  );
  return (
    <Button
      type="button"
      variant={sessionPref === "finger" ? "secondary" : "ghost"}
      aria-pressed={sessionPref === "finger"}
      aria-label="手指书写"
      disabled={disabled}
      onClick={() =>
        setSessionInputPreference(sessionPref === "pen" ? "finger" : "pen")
      }
      className={inkToolButtonClass}
      title={
        sessionPref === "pen"
          ? "手指书写（无笔设备：手指直接书写）"
          : "切回笔写／手指滚动"
      }
    >
      <Pointer aria-hidden />
    </Button>
  );
}

export function InkPad({
  engine = "atrament",
  initial,
  initialHeight = 280,
  fill = false,
  label = "手写答题区",
  onDocChange,
  engineRef,
  inputMode = "auto",
  background,
  showToolbar = true,
  paperHeight,
  onEngineRebuild,
  maxDeletedPoints,
  inputEnabled = true,
}: InkPadProps) {
  const profile = useInkProfileSelection();
  /** 工具箱：笔的颜色、粗细跟随笔感设置，设置变化时重新取值 */
  const [toolbox, setToolbox] = useState(() =>
    createInkToolbox({
      pen: { color: profile.config.color, size: profile.config.size },
    }),
  );
  useEffect(() => {
    localEngineRef.current?.setProfile?.(profile.config);
    const { color, size } = profile.config;
    setToolbox((current) =>
      current.pen.color === color && current.pen.size === size
        ? current
        : { ...current, pen: { color, size } },
    );
  }, [profile.config]);
  const containerRef = useRef<HTMLDivElement>(null);
  /** 内部引擎实例引用（engineRef prop 为对外透出） */
  const localEngineRef = useRef<InkEngine | null>(null);
  const inputEnabledRef = useRef(inputEnabled);
  inputEnabledRef.current = inputEnabled;
  /** onDocChange 用 ref 转发：父组件传内联函数时不触发引擎重建 */
  const onDocChangeRef = useRef(onDocChange);
  useEffect(() => {
    onDocChangeRef.current = onDocChange;
  }, [onDocChange]);
  const onEngineRebuildRef = useRef(onEngineRebuild);
  onEngineRebuildRef.current = onEngineRebuild;

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [height, setHeight] = useState(initialHeight);
  useEffect(() => {
    setHeight((current) => Math.max(current, initialHeight));
  }, [initialHeight]);
  const [clearOpen, setClearOpen] = useState(false);
  const [ready, setReady] = useState(engine === "atrament");
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 懒加载失败后的重试键：重建引擎 */
  const [retryKey, setRetryKey] = useState(0);
  /** 草稿只在挂载时恢复一次：initial 经 ref 取值，引用变化不重建引擎 */
  const initialRef = useRef(initial);
  /**
   * 引擎挂载期选项（T6R.9）：ref 每渲染刷新为活值，但**只在引擎（重）建时
   * 读取**——受控纸高的运行时变化只经容器样式（下 style）生效，不重建
   * 引擎；背景例外：挂载后变化经重建键触发引擎重建（见下 effect，复审⑥
   * 定案——重建比给引擎加 setBackground 命令便宜，undo 历史随重建清零
   * 可接受：背景只随外部换稿变化，罕见路径；NoteLayer 侧经引擎换实例
   * 检测重载正文）。
   */
  const mountOptsRef = useRef({ background, height: paperHeight });
  mountOptsRef.current = { background, height: paperHeight };
  /** 背景重建键：background 与已挂载值不同 → 引擎重建 */
  const mountedBgRef = useRef(background);
  useEffect(() => {
    if (background !== mountedBgRef.current) {
      mountedBgRef.current = background;
      setRetryKey((k) => k + 1); // 复用重建通道（与懒加载失败重试同机制）
    }
  }, [background]);
  /** 受控纸高的运行时读取（自动加高守卫用）：变化不重建引擎 */
  const paperHeightRef = useRef(paperHeight);
  paperHeightRef.current = paperHeight;
  /**
   * 会话共享输入偏好（T6R.7，多画布同源）：session 档订阅会话 store——
   * 任一画布切换即时同步（跨题/重挂载不重新探测）；非 session 档用常量
   * 订阅+快照（不订阅、不因他人切换重渲染）。useSyncExternalStore 形态
   * 免去手工 subscribe/对齐 effect（复审⑪）。
   */
  const sessionPref = useSyncExternalStore(
    inputMode === "session"
      ? onSessionInputPreferenceChange
      : SUBSCRIBE_NOTHING,
    inputMode === "session" ? getSessionInputPreference : SNAPSHOT_PEN,
  );

  // 引擎创建/销毁（依赖 retryKey 重建）
  // biome-ignore lint/correctness/useExhaustiveDependencies(retryKey): 重试键仅用于强制重建引擎，effect 体内不读取
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let off: (() => void) | null = null;

    try {
      const initial = initialRef.current;
      const mount = mountOptsRef.current;
      const ink = create(container, {
        engine,
        ...(initial !== undefined ? { initial } : {}),
        ...(maxDeletedPoints !== undefined ? { maxDeletedPoints } : {}),
        // T6R.9：受控纸高作为引擎高度提示；背景透传（缺省均不传=旧行为）
        ...(mount.height !== undefined ? { height: mount.height } : {}),
        ...(mount.background !== undefined
          ? { background: mount.background }
          : {}),
        ...(engine === "excalidraw"
          ? {
              onReady: () => {
                if (!disposed) setReady(true);
              },
              onError: (err: Error) => {
                if (!disposed)
                  setLoadError(err.message || "Excalidraw 加载失败");
              },
            }
          : {}),
      });
      localEngineRef.current = ink;
      ink.setInputEnabled?.(inputEnabledRef.current);
      if (engineRef) engineRef.current = ink;
      off = ink.on("change", (doc, reason, finish) => {
        setCanUndo(ink.canUndo());
        setCanRedo(ink.canRedo());
        onDocChangeRef.current?.(doc, reason, finish);
        // 自动加高：最后一笔的最低点接近底部时加高（仅 atrament 页内答题区，
        // 且仅旧作答链路——T6R.9 受控纸高形态禁用，加高统一走 paper-geometry
        // 逻辑口径由外层负责，注记②定案）
        if (
          engine === "atrament" &&
          paperHeightRef.current === undefined &&
          container.clientWidth > 0 &&
          doc.engine === "atrament"
        ) {
          // 泛型联合无法随 engine 字段收窄 data，校验后显式特化
          const strokes = (doc as InkDoc<"atrament">).data.strokes;
          const last = strokes[strokes.length - 1];
          if (last && last.points.length > 0) {
            // 单趟取 maxY（spread+Math.max 在超长笔画下有调用栈上限险，
            // 复审⑪）；逻辑→CSS 换算复用 normalize.fromLogical（不手写 /1000）
            let maxY = Number.NEGATIVE_INFINITY;
            for (const p of last.points) {
              if (p.y > maxY) maxY = p.y;
            }
            const px = fromLogical(container.clientWidth, maxY);
            // 加高 UX 常量与 paper-geometry 同源（engine/paper-style，复审①）
            if (px > container.clientHeight - PAPER_GROW_TRIGGER_CSS_PX) {
              setHeight((h) => h + PAPER_GROW_STEP_CSS_PX);
            }
          }
        }
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "手写引擎初始化失败");
    }

    if (!disposed) onEngineRebuildRef.current?.();
    return () => {
      disposed = true;
      off?.();
      localEngineRef.current?.destroy();
      localEngineRef.current = null;
      if (engineRef) engineRef.current = null;
    };
    // initial 经 initialRef 取值；engineRef 为父组件持有的稳定 ref 对象
  }, [engine, retryKey, engineRef, maxDeletedPoints]);

  // biome-ignore lint/correctness/useExhaustiveDependencies(retryKey): 重试重建后需恢复当前输入门
  useEffect(() => {
    localEngineRef.current?.setInputEnabled?.(inputEnabled);
  }, [inputEnabled, retryKey]);

  // 固定笔写或会话偏好 → 引擎。声明在引擎创建 effect **之后**：挂载时引擎已
  // 就绪、当前偏好即刻下发（否则首帧 localEngineRef 为 null，pen 值又不再
  // 变化会导致永不重发）。引擎重建（retryKey）后同样重发；excalidraw 引擎
  // 的 setInputMode 为安全 no-op（守卫在引擎包装层，复审⑩）。
  // biome-ignore lint/correctness/useExhaustiveDependencies(retryKey): 重试键变化=引擎重建，需重发输入模式，effect 体内不读取
  useEffect(() => {
    if (inputMode === "auto") return;
    localEngineRef.current?.setInputMode(
      inputMode === "session" ? sessionPref : inputMode,
    );
  }, [inputMode, sessionPref, retryKey]);

  // 工具箱变化 → 下发引擎；引擎重建（retryKey）后新实例回到缺省工具，同样重发。
  // excalidraw 未就绪时适配器内部排队，无需依赖 ready。工具栏在外层时
  // （showToolbar=false）工具只由外层下发，这里不写第二份。
  // biome-ignore lint/correctness/useExhaustiveDependencies(retryKey): 重试键变化=引擎重建，需重发当前工具，effect 体内不读取
  useEffect(() => {
    if (!showToolbar) return;
    localEngineRef.current?.setTool(toolConfigOf(toolbox));
  }, [toolbox, retryKey, showToolbar]);

  const handleUndo = useCallback(() => localEngineRef.current?.undo(), []);
  const handleRedo = useCallback(() => localEngineRef.current?.redo(), []);
  const handleClearConfirm = useCallback(() => {
    localEngineRef.current?.clear();
    setClearOpen(false);
  }, []);

  const toolsDisabled = !ready || loadError !== null;

  return (
    <div
      data-slot="ink-pad"
      className={`flex flex-col gap-2 [touch-action:manipulation] ${fill ? "h-full min-h-0" : ""}`}
    >
      {/* 工具栏（T6R.9：showToolbar=false 时整体不渲染——纸面由外层提供工具栏；
          画布与引擎生命周期不受影响） */}
      {showToolbar && (
        <InkToolbar
          label={label}
          toolbox={toolbox}
          onToolboxChange={setToolbox}
          tools={engine === "atrament" ? ATRAMENT_TOOLS : EXCALIDRAW_TOOLS}
          toolOptions={engine === "atrament"}
          {...(engine === "atrament"
            ? {}
            : { toolLabels: EXCALIDRAW_TOOL_LABELS })}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onClearRequest={() => setClearOpen(true)}
          clearLabel="清空画布"
          disabled={toolsDisabled}
          fingerToggle={
            // 输入偏好切换（T6R.7）：会话内共享，多画布同源
            inputMode === "session" && (
              <SessionPrefToggleButton disabled={toolsDisabled} />
            )
          }
        />
      )}

      {/* 画布容器：页内形态高度固定（自动加高）；全屏形态（fill）占满余下空间。
          T6R.9：paperHeight 受控时容器高度恒为受控值（外层 paper-geometry 换算） */}
      <div
        ref={containerRef}
        data-slot="ink-pad-canvas"
        role="img"
        aria-label={label}
        style={
          fill
            ? undefined
            : {
                height: `${paperHeight !== undefined ? paperHeight : height}px`,
              }
        }
        className={`relative w-full overflow-hidden rounded-xl border border-border bg-white ${fill ? "min-h-0 flex-1" : ""}`}
      >
        {/* Excalidraw 懒加载中 / 失败的覆盖层（三种状态，ui-conventions） */}
        {engine === "excalidraw" && !ready && !loadError && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-white text-sm text-muted-foreground">
            <LoaderCircle aria-hidden className="size-6 animate-spin" />
            手写引擎加载中…
          </div>
        )}
        {loadError && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white px-6 text-center text-sm">
            <CircleAlert aria-hidden className="size-6 text-destructive" />
            <p>手写引擎加载失败：{loadError}</p>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => {
                setLoadError(null);
                setReady(false);
                setRetryKey((k) => k + 1);
              }}
            >
              重试
            </Button>
          </div>
        )}
      </div>

      {/* 清空二次确认（§5.4.1 绘制层第 3 条） */}
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清空画布？</DialogTitle>
            <DialogDescription>
              将清除当前答题区的全部笔迹，清空后可用「撤销」恢复。
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
              onClick={handleClearConfirm}
            >
              清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
