import type { InkDoc, InkStroke, InkStrokePoint } from "@tutor/contract";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  createAnnotationToolbox,
  useCoordinatedAnnotation,
} from "@/features/annotation/coordinated-annotation-context";
import { createEraseSession } from "@/features/ink/engine/erase-session.ts";
import { toLogical, toLogicalPoint } from "@/features/ink/engine/normalize.ts";
import {
  advancePointerMachine,
  createPointerMachineState,
  isSampleMove,
  type PointerDecision,
  type PointerMachineState,
  touchActionForInput,
} from "@/features/ink/engine/pointer-machine.ts";
import { createShapeGesture } from "@/features/ink/engine/shape-gesture.ts";
import { toolConfigOf } from "@/features/ink/engine/toolbox.ts";
import {
  INK_LOGICAL_WIDTH,
  type InkGesture,
  resolveGesture,
} from "@/features/ink/engine/types.ts";
import {
  type AtramentReplayCanvas,
  createAtramentReplayCanvas,
} from "@/features/ink/replay/draw.ts";
import { usePwaUpdateGuard } from "@/lib/pwa-update-safety";
import { useAttemptEditor } from "./AttemptEditorContext";
import {
  draftStore,
  getDraftSessionEpoch,
  type MaterialInkBaseMeta,
  subscribeLocalDraftChoice,
} from "./draft-store";
import { useMaterialEraserRing } from "./material-eraser-ring";
import { awaitMaterialSurfaceReady } from "./material-surface-ready";
import { prepareDraftForPwaUpdate } from "./pwa-draft-safety";

/** 无共享工具箱（单测、独立挂载）时用圈画缺省：红色细笔 */
const FALLBACK_TOOLBOX = createAnnotationToolbox();

export interface MaterialAnnotationOverlayProps {
  attemptId: string;
  materialId: string;
  children: ReactNode;
  /**
   * 笔迹存储键：必须用 MaterialPanel 的 materialVersionKey(material)（含
   * sourceVersion）——同 materialId 双版本卷（QM-15）两份面板各存各的笔迹，
   * 不互相覆盖；缺省退回裸 materialId 仅供单测。
   */
  inkKey?: string | undefined;
  /**
   * 本材料关联的题目 ID 列表（QM-15/题组/solo 关联单源）：
   * 仅当当前题卡处于标注态且属于本材料时，才激活手写圈画。
   */
  associatedQuestionIds?: readonly string[] | undefined;
}

/**
 * 材料圈画手写图层（协同标画）。引擎与题面圈画（annotation-surface）单源：
 * - 输入：engine/pointer-machine 状态机（第二指针/pointercancel/失焦/布局
 *   变化先收笔等决策矩阵与其单测共用），固定笔写、手指滚动；
 * - 绘制：ink/replay/draw 的 createAtramentReplayCanvas（与回放/导出同一
 *   atrament 绘制原语、DPR 上限 2、尺寸变化自重画）；
 * - 笔色/笔粗/橡皮大小与擦除方式：跟随协同工具箱，经 resolveGesture 换成
 *   落笔规格；橡皮走 erase-session（整笔或局部，命中半径内含半笔宽，与题面
 *   圈画同手感），悬停和擦除时有橡皮圈跟着指针；
 * - 矢量坐标一律按 INK_LOGICAL_WIDTH(1000) 归一化存储（normalize.ts）。
 * 笔迹按 attemptId + inkKey 合并存入 draftStore（本机稿；交卷不清除，
 * 结果页只读回看——见 clearDraft 的保稿分支）。
 *
 * 已有基准的真实阅读框常驻固定 CSS 宽度，分栏只整体等比缩放，笔迹常显；
 * 无基准的新材料在首笔前保持自然排版，收笔时捕获落笔矩形；旧稿缺少基准
 * 无法证明历史位置，保稿并停止续画。材料只存本机，不使用题卡 PNG 坐标域。
 * fitScale<0.85 时提供「放大材料」1:1 横滚，宽高变化超过 10 CSS px 停写。
 */
export function MaterialAnnotationOverlay({
  attemptId,
  materialId,
  inkKey,
  children,
  associatedQuestionIds,
}: MaterialAnnotationOverlayProps) {
  const editor = useAttemptEditor();
  const coordinated = useCoordinatedAnnotation();
  const toolbox = coordinated?.toolbox ?? FALLBACK_TOOLBOX;
  /** 当前工具对应的手势（落笔时取快照，见 liveGestureRef） */
  const gesture = useMemo(
    () => resolveGesture(toolConfigOf(toolbox), toolbox.pen).gesture,
    [toolbox],
  );
  /** 本次手势的工具快照：一笔之内的采样都按落笔时的工具分派 */
  const liveGestureRef = useRef<InkGesture>({ kind: "none" });
  const storeKey = inkKey ?? materialId;

  const isAssociated =
    associatedQuestionIds === undefined ||
    (editor?.active?.questionId !== undefined &&
      associatedQuestionIds.includes(editor.active.questionId));
  const isAnnotationActive =
    editor?.active?.kind === "annotation" && isAssociated;

  const inputRef = useRef<HTMLDivElement>(null);
  // 输入层元素进 state：画布创建 effect 感知元素更替（结构常驻后通常只在
  // 挂载时建立一次——冻结/活排版切换不再重挂输入层）
  const [inputElement, setInputElement] = useState<HTMLDivElement | null>(null);
  const setInputLayer = useCallback((el: HTMLDivElement | null) => {
    inputRef.current = el;
    setInputElement(el);
  }, []);
  useEffect(() => {
    if (!inputElement || !isAnnotationActive) return;
    // Safari 的笔触也参与原生平移；只拦笔，手指继续交给材料滚动区。
    const preventStylusScroll = (event: TouchEvent) => {
      if (
        [...event.changedTouches, ...event.touches].some(
          (touch) => touch.touchType === "stylus",
        )
      ) {
        event.preventDefault();
      }
    };
    inputElement.addEventListener("touchstart", preventStylusScroll, {
      passive: false,
    });
    inputElement.addEventListener("touchmove", preventStylusScroll, {
      passive: false,
    });
    return () => {
      inputElement.removeEventListener("touchstart", preventStylusScroll);
      inputElement.removeEventListener("touchmove", preventStylusScroll);
    };
  }, [inputElement, isAnnotationActive]);
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  /** 材料正文壳（children+输入层）：首笔捕获与就绪门控的测量面 */
  const liveSurfaceRef = useRef<HTMLDivElement>(null);

  // 冻结基准（首笔落笔时的活排版矩形；空稿清除后下次首笔重冻）
  const [frozen, setFrozen] = useState<MaterialInkBaseMeta | null>(() =>
    draftStore.getMaterialInkBase(attemptId, storeKey),
  );
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;
  /** 正文壳实测尺寸：首笔捕获兜底（辅助按钮在壳外） */
  const [liveSize, setLiveSize] = useState({ width: 0, height: 0 });
  const liveSizeRef = useRef(liveSize);
  liveSizeRef.current = liveSize;
  /** 根节点列宽：框缩放比与放大复位的观察源 */
  const [columnSize, setColumnSize] = useState({ width: 0, height: 0 });
  /** 冻结框布局尺寸（未缩放 CSS px，transform 不参与布局须显式占位） */
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  /** 1:1 放大态（fitScale<0.85 的逃生口；宽度变化即复位，同题面） */
  const [expanded, setExpanded] = useState(false);
  /** 首笔就绪门控（无基准材料的圈画态；有基准即视为就绪） */
  const [surfaceReady, setSurfaceReady] = useState(false);
  const surfaceReadyRef = useRef(false);
  surfaceReadyRef.current = surfaceReady;
  /** 圈画态挂框就绪（有基准挂框后材料表面仍需稳定——晚到图片会推高内容） */
  const [frameSurfaceReady, setFrameSurfaceReady] = useState(false);
  const replayRef = useRef<AtramentReplayCanvas | null>(null);

  const [strokes, setStrokes] = useState<InkStroke[]>(() => {
    const existing = draftStore.getMaterialInk(attemptId, storeKey);
    if (existing?.engine === "atrament") {
      return existing.data.strokes;
    }
    return [];
  });
  const strokesRef = useRef(strokes);
  const setStrokesBoth = useCallback((next: InkStroke[]) => {
    strokesRef.current = next;
    setStrokes(next);
  }, []);

  // 输入状态机与绘制原语都不进 React 状态：笔势期间零重渲染
  const machineRef = useRef<PointerMachineState>(
    createPointerMachineState("pen"),
  );
  const currentStrokeRef = useRef<InkStroke | null>(null);
  /**
   * 图形工具或直线荧光笔的这一次拖动：预览在画布上面的临时层，抬笔给出
   * 这一笔的点列（拖动期间 currentStrokeRef 是空的，画布上没有在途的一笔）
   */
  const [shaper] = useState(() =>
    createShapeGesture({
      layer: () => replayRef.current?.previewLayer?.() ?? null,
    }),
  );
  /** 橡皮圈：橡皮悬停和擦除时跟着指针的圆圈（material-eraser-ring.ts） */
  const ring = useMaterialEraserRing(
    () => replayRef.current?.previewLayer?.() ?? null,
    isAnnotationActive && gesture.kind === "erase" ? gesture.radius : null,
  );
  /** 本笔落笔矩形：首笔冻结基准的捕获源（一笔不混用两个排版基准） */
  const strokeBaseRef = useRef<{ width: number; height: number } | null>(null);
  const strokeStartRef = useRef(0);
  const activePointerIdRef = useRef<number | null>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const lastEraseRef = useRef<{ x: number; y: number } | null>(null);
  /** 这一次橡皮手势擦掉了东西、还没存进草稿仓（见 flushErase） */
  const eraseDirtyRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  // 壳与材料子树常驻；已有基准在阅读和圈画时共用同一真实固定宽框。
  const frameMounted = frozen !== null;
  const missingBase = frozen === null && strokes.length > 0;
  const showInk = !missingBase && (frameMounted || isAnnotationActive);
  const showInkRef = useRef(showInk);
  showInkRef.current = showInk;
  const fitScale =
    frozen !== null &&
    frozen.cssWidth > 0 &&
    columnSize.width > 0 &&
    columnSize.width < frozen.cssWidth
      ? columnSize.width / frozen.cssWidth
      : 1;
  const scale = expanded ? 1 : fitScale;
  // 只有宽高证据：允许 10px 内尺寸差异，不能据此证明材料内部逐字位置。
  const layoutDrift =
    frozen !== null &&
    ((frameSize.width > 0 &&
      Math.abs(frameSize.width - frozen.cssWidth) > 10) ||
      (frozen.cssHeight !== undefined &&
        frameSize.height > 0 &&
        Math.abs(frameSize.height - frozen.cssHeight) > 10));
  const inputEnabled =
    isAnnotationActive &&
    !missingBase &&
    (frozen === null ? surfaceReady : frameSurfaceReady && !layoutDrift);
  const frameSurfaceReadyRef = useRef(false);
  frameSurfaceReadyRef.current = frameSurfaceReady;
  const layoutDriftRef = useRef(false);
  layoutDriftRef.current = layoutDrift;
  const missingBaseRef = useRef(false);
  missingBaseRef.current = missingBase;

  // 恢复材料草稿（内存命中立即读取；硬刷新冷启动时异步回源 IndexedDB）；
  // 冻结基准随笔迹一并恢复
  useEffect(() => {
    let active = true;
    const applyBase = (base: MaterialInkBaseMeta | null) => {
      if (active && base !== null && frozenRef.current === null) {
        frozenRef.current = base;
        setFrozen(base);
      }
    };
    const fromMem = draftStore.getMaterialInk(attemptId, storeKey);
    if (fromMem?.engine === "atrament") {
      setStrokesBoth(fromMem.data.strokes);
      applyBase(draftStore.getMaterialInkBase(attemptId, storeKey));
      return;
    }
    void (async () => {
      const record = await draftStore.loadDraft(attemptId);
      if (!active) return;
      const stored = record?.materialInks?.[storeKey];
      if (stored?.engine === "atrament") {
        setStrokesBoth(stored.data.strokes);
      }
      applyBase(record?.materialInkBases?.[storeKey] ?? null);
    })();
    return () => {
      active = false;
    };
  }, [attemptId, storeKey, setStrokesBoth]);

  useEffect(
    () =>
      subscribeLocalDraftChoice((scope, conflict) => {
        if (
          scope !== attemptId ||
          conflict.kind !== "material" ||
          conflict.key !== storeKey
        )
          return;
        const doc = draftStore.getMaterialInk(attemptId, storeKey);
        setStrokesBoth(doc?.engine === "atrament" ? doc.data.strokes : []);
        const base = draftStore.getMaterialInkBase(attemptId, storeKey);
        frozenRef.current = base;
        setFrozen(base);
      }),
    [attemptId, storeKey, setStrokesBoth],
  );

  // 同材料的其他实例已存基准时采用原基准；缺基准旧稿不可凭当前排版补造。
  useEffect(() => {
    if (!isAnnotationActive || frozenRef.current !== null) return;
    const base = draftStore.getMaterialInkBase(attemptId, storeKey);
    if (base !== null) {
      frozenRef.current = base;
      setFrozen(base);
    }
  }, [isAnnotationActive, attemptId, storeKey]);

  // 首笔就绪门控：无基准材料的圈画态等材料表面稳定（字体/图片/连续 3 帧），
  // 未就绪禁墨并提示；量活排版壳而非根（辅助按钮不进测量面）
  useEffect(() => {
    if (!isAnnotationActive || frozen !== null) return;
    let active = true;
    setSurfaceReady(false);
    void (async () => {
      const el = liveSurfaceRef.current;
      const ready = el
        ? await awaitMaterialSurfaceReady(el, () => !active)
        : false;
      if (active) setSurfaceReady(ready);
    })();
    return () => {
      active = false;
    };
  }, [isAnnotationActive, frozen]);

  const drawCurrent = useCallback(() => {
    const replay = replayRef.current;
    if (!replay) return;
    if (!showInkRef.current) {
      replay.drawFrame([], []);
      return;
    }
    const strokes = strokesRef.current;
    const active = currentStrokeRef.current;
    replay.drawOrdered(
      strokes,
      strokes.length,
      active,
      active?.points.length ?? 0,
    );
  }, []);

  /** rAF 合帧请求一帧重绘（同帧多次变动只画一次） */
  const scheduleRedraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      drawCurrent();
    });
  }, [drawCurrent]);

  // 绘制层：复用回放画布（canvas 创建/DPR 上限/ResizeObserver 重画一体）。
  // 依赖输入层元素而非仅挂载时读一次 ref；固定框切换不重挂输入层
  useEffect(() => {
    const el = inputElement;
    if (!el) return;
    try {
      const replay = createAtramentReplayCanvas(el);
      replayRef.current = replay;
      // 挂载即恢复既有笔迹，缺基准旧稿不叠在未经核验的正文上
      drawCurrent();
    } catch (err) {
      // 无 2d 上下文（极老浏览器）：保留材料正文可读，圈画层静默不可用
      console.warn("材料圈画画布创建失败", err);
      replayRef.current = null;
      return;
    }
    return () => {
      replayRef.current?.destroy();
      replayRef.current = null;
    };
  }, [inputElement, drawCurrent]);

  const cancelRedraw = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // 笔迹变动即重绘（冷启动异步恢复同样触发）；显隐切换同步清屏/复显
  useEffect(() => {
    if (strokesRef.current !== strokes) strokesRef.current = strokes;
    scheduleRedraw();
    return cancelRedraw;
  }, [strokes, scheduleRedraw, cancelRedraw]);
  useEffect(() => {
    if (!showInk) {
      // 缺基准旧稿立即清屏，不叠在无法核验的当前排版上
      replayRef.current?.drawFrame([], []);
      return;
    }
    scheduleRedraw();
    return cancelRedraw;
  }, [showInk, scheduleRedraw, cancelRedraw]);

  const saveToDraftStore = useCallback(
    (nextStrokes: InkStroke[]) => {
      const doc: InkDoc = {
        engine: "atrament",
        version: 1,
        data: { width: INK_LOGICAL_WIDTH, strokes: nextStrokes },
        updatedAt: Date.now(),
      };
      draftStore.saveMaterialInk(attemptId, storeKey, doc);
      if (nextStrokes.length === 0) {
        // 空稿无对齐负担：冻结基准随稿清除，下次首笔按当前列宽重冻
        draftStore.removeMaterialInkBase(attemptId, storeKey);
        frozenRef.current = null;
        setFrozen(null);
        return;
      }
      const base = frozenRef.current;
      if (base) draftStore.saveMaterialInkBase(attemptId, storeKey, base);
    },
    [attemptId, storeKey],
  );

  const pointOf = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>): InkStrokePoint => {
      const el = inputRef.current;
      const rect = rectRef.current ?? el?.getBoundingClientRect() ?? null;
      if (el && rectRef.current === null && rect) rectRef.current = rect;
      const width = rect?.width || 300;
      const p = toLogicalPoint(
        width,
        e.clientX - (rect?.left ?? 0),
        e.clientY - (rect?.top ?? 0),
      );
      return {
        x: p.x,
        y: p.y,
        p: e.pressure > 0 ? e.pressure : 0.5,
        t: Date.now() - strokeStartRef.current,
      };
    },
    [],
  );

  /**
   * 橡皮经过一个落点：从上一个落点扫到这里，碰到的笔画整笔拿掉（整笔模式）
   * 或只切掉碰到的一段（局部模式）。材料圈画没有撤销，每个落点各算各的，
   * 画面立即跟上；存进草稿仓等这一次手势结束（flushErase）——草稿仓一变，
   * 整个作答页跟着重渲染，局部橡皮几乎每个落点都有改动，逐点存会卡。
   */
  const eraseAt = useCallback(
    (
      point: { x: number; y: number },
      eraser: Extract<InkGesture, { kind: "erase" }>,
    ) => {
      ring.show(point.x, point.y, eraser.radius);
      const session = createEraseSession(strokesRef.current, eraser.mode);
      const changed = session.sweep(
        point.x,
        point.y,
        eraser.radius,
        lastEraseRef.current ?? undefined,
      );
      lastEraseRef.current = point;
      if (changed === null) return;
      setStrokesBoth(session.visible().map((item) => item.stroke));
      eraseDirtyRef.current = true;
    },
    [setStrokesBoth, ring],
  );

  /**
   * 把这一次橡皮手势里擦掉的存进草稿仓，一次手势只存一次（抬起、被打断、
   * 应用更新前都算手势结束）。擦空了的话，冻结基准也在这时才清：手势途中
   * 不换排版。组件在手势途中被卸载时不补存，和在途的一笔一样。
   */
  const flushErase = useCallback(() => {
    if (!eraseDirtyRef.current) return;
    eraseDirtyRef.current = false;
    saveToDraftStore(strokesRef.current);
  }, [saveToDraftStore]);

  const beginInteraction = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // 下面任何一处不接这一笔，随后的移动都不能按上一次的手势（比如橡皮）走
      liveGestureRef.current = { kind: "none" };
      // 就绪门控：旧稿缺基准保稿；新材料等资源稳定，已有基准核验布局。
      if (missingBaseRef.current) return;
      if (frozenRef.current === null && !surfaceReadyRef.current) return;
      if (
        frozenRef.current !== null &&
        (!frameSurfaceReadyRef.current || layoutDriftRef.current)
      ) {
        return;
      }
      // 同键双实例（同 materialId 被两个锚渲染）兜底：落笔前对齐草稿仓最新
      const latest = draftStore.getMaterialInk(attemptId, storeKey);
      if (
        latest?.engine === "atrament" &&
        latest.data.strokes !== strokesRef.current
      ) {
        setStrokesBoth(latest.data.strokes);
      }
      // 他实例已按另一列宽冻结并存基准：采用该基准并丢弃本势（下一笔起
      // 在冻结框内同域落笔；避免本笔以另一排版基准归一化）
      const latestBase = draftStore.getMaterialInkBase(attemptId, storeKey);
      if (latestBase !== null && frozenRef.current === null) {
        frozenRef.current = latestBase;
        setFrozen(latestBase);
        return;
      }
      const el = inputRef.current;
      const rect = el?.getBoundingClientRect() ?? null;
      if (el && rect) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // 部分环境（如单测 jsdom）未实现指针捕获，防御忽略
        }
      }
      activePointerIdRef.current = e.pointerId;
      rectRef.current = rect;
      strokeBaseRef.current =
        rect !== null ? { width: rect.width, height: rect.height } : null;
      strokeStartRef.current = Date.now();
      const point = pointOf(e);
      liveGestureRef.current = gesture;
      if (gesture.kind === "erase") {
        lastEraseRef.current = null;
        eraseAt(point, gesture);
        return;
      }
      if (gesture.kind !== "draw") return;
      if (gesture.shape !== "free") {
        shaper.begin({
          shape: gesture.shape,
          from: point,
          brush: gesture.brush,
          // 指针捕获后可以拖出材料范围：图形只画到边上
          ...(rect !== null && rect.width > 0
            ? {
                bounds: {
                  width: INK_LOGICAL_WIDTH,
                  height: toLogical(rect.width, rect.height),
                },
              }
            : {}),
          // 荧光笔整笔一条路径，画的就是起止点的连线，不用加密
          sparse: gesture.tool === "highlighter",
        });
        return;
      }
      currentStrokeRef.current = {
        tool: gesture.tool,
        color: gesture.brush.color,
        weight: gesture.brush.weight,
        points: [point],
      };
    },
    [attemptId, storeKey, gesture, pointOf, eraseAt, setStrokesBoth, shaper],
  );

  /** 释放指针捕获（收笔/丢弃共用；捕获可能已被浏览器释放，防御忽略） */
  const releaseCapture = useCallback(() => {
    const el = inputRef.current;
    const pointerId = activePointerIdRef.current;
    activePointerIdRef.current = null;
    if (el && pointerId !== null) {
      try {
        el.releasePointerCapture(pointerId);
      } catch {
        // 防御忽略：捕获可能已随指针移出被浏览器释放
      }
    }
  }, []);

  /** 按已收到的真实采样收笔（状态机语义：不补造终点） */
  const finishInteraction = useCallback(() => {
    releaseCapture();
    ring.hide();
    rectRef.current = null;
    lastEraseRef.current = null;
    flushErase();
    // 图形的点列由手势给出（没拖出大小为 null，不落笔）；手写是已收到的采样
    const live = liveGestureRef.current;
    const shapePoints = shaper.end();
    const stroke: InkStroke | null =
      shapePoints !== null && live.kind === "draw"
        ? {
            tool: live.tool,
            color: live.brush.color,
            weight: live.brush.weight,
            points: shapePoints,
          }
        : currentStrokeRef.current;
    if (!stroke) return;
    currentStrokeRef.current = null;
    // 首笔冻结：无基准时按本笔落笔矩形捕获冻结基准并随稿保存——之后
    // 分栏拖拽/排版切换/窗口缩放只整体等比缩放，笔迹与材料逐字对齐
    if (frozenRef.current === null) {
      const base = strokeBaseRef.current;
      const width = base?.width || liveSizeRef.current.width;
      const height = base?.height || liveSizeRef.current.height;
      if (width > 0) {
        const captured: MaterialInkBaseMeta = {
          cssWidth: width,
          ...(height > 0 ? { cssHeight: height } : {}),
        };
        frozenRef.current = captured;
        setFrozen(captured);
      }
    }
    const next = [...strokesRef.current, stroke];
    setStrokesBoth(next);
    saveToDraftStore(next);
    // 图形书写中不在画布上：预览已收起，这里立即把整笔画上去，中间不空一帧
    if (shapePoints !== null) drawCurrent();
  }, [
    releaseCapture,
    saveToDraftStore,
    setStrokesBoth,
    shaper,
    drawCurrent,
    ring,
    flushErase,
  ]);

  usePwaUpdateGuard(
    () =>
      prepareDraftForPwaUpdate(attemptId, async () => {
        finishInteraction();
      }),
    `${getDraftSessionEpoch()}:${attemptId}:material:${storeKey}`,
  );

  const applyDecisions = useCallback(
    (
      decisions: readonly PointerDecision[],
      e?: ReactPointerEvent<HTMLDivElement>,
    ) => {
      for (const decision of decisions) {
        if (decision.action === "start" && e) {
          e.preventDefault();
          beginInteraction(e);
        } else if (decision.action === "commit") {
          finishInteraction();
        } else if (decision.action === "discard") {
          releaseCapture();
          ring.hide();
          currentStrokeRef.current = null;
          shaper.end();
          // 已经擦掉的照旧算数（材料圈画没有撤销），只是到这里才存
          flushErase();
          scheduleRedraw();
        }
      }
    },
    [
      beginInteraction,
      finishInteraction,
      releaseCapture,
      scheduleRedraw,
      shaper,
      ring,
      flushErase,
    ],
  );

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!isAnnotationActive || e.button !== 0) return;
      const result = advancePointerMachine(machineRef.current, {
        kind: "pointerdown",
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        button: e.button,
        inBounds: true,
      });
      machineRef.current = result.state;
      applyDecisions(result.decisions, e);
    },
    [isAnnotationActive, applyDecisions],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // 没在写：当前是橡皮就让橡皮圈跟着指针走
      if (activePointerIdRef.current === null) ring.hover(e);
      if (!isSampleMove(machineRef.current, e.pointerId)) return;
      const live = liveGestureRef.current;
      if (live.kind === "erase") {
        eraseAt(pointOf(e), live);
        return;
      }
      // 图形：只看拖到哪儿，更新预览
      if (shaper.active) {
        const to = pointOf(e);
        shaper.through(to, Math.max(0, to.t));
        return;
      }
      const stroke = currentStrokeRef.current;
      if (!stroke) return;
      stroke.points.push(pointOf(e));
      scheduleRedraw();
    },
    [pointOf, eraseAt, scheduleRedraw, shaper, ring],
  );

  const handlePointerEnd = useCallback(
    (
      e: ReactPointerEvent<HTMLDivElement>,
      kind: "pointerup" | "pointercancel" | "lostpointercapture",
    ) => {
      const result = advancePointerMachine(machineRef.current, {
        kind,
        pointerId: e.pointerId,
      });
      machineRef.current = result.state;
      applyDecisions(result.decisions);
    },
    [applyDecisions],
  );

  // 窗口失焦与尺寸变化（分栏拖拽/排版切换/窗口缩放/晚到图片下推）：
  // 在途一笔按已采样收笔——指针→逻辑的换算矩形随布局变化，一笔不混用
  // 两个排版基准（「布局变化先收笔」约定）；列宽变化同时复位 1:1 放大。
  // 双观察：根节点=列宽（缩放比/放大复位）；正文壳=材料
  // 正文实测（首笔捕获兜底/就绪门控）——辅助按钮在壳外，
  // 量高不被按钮污染
  useEffect(() => {
    const feedInterrupt = () => {
      const result = advancePointerMachine(machineRef.current, {
        kind: "blur",
      });
      machineRef.current = result.state;
      applyDecisions(result.decisions);
    };
    window.addEventListener("blur", feedInterrupt);
    const rootEl = rootRef.current;
    const liveEl = liveSurfaceRef.current;
    const initRoot = rootEl?.getBoundingClientRect();
    const initLive = liveEl?.getBoundingClientRect();
    let lastRootW = initRoot && initRoot.width > 0 ? initRoot.width : 0;
    let lastRootH = initRoot && initRoot.width > 0 ? initRoot.height : 0;
    let lastLiveW = initLive && initLive.width > 0 ? initLive.width : 0;
    let lastLiveH = initLive && initLive.width > 0 ? initLive.height : 0;
    if (lastRootW > 0) setColumnSize({ width: lastRootW, height: lastRootH });
    if (lastLiveW > 0) setLiveSize({ width: lastLiveW, height: lastLiveH });
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const isRoot = entry.target === rootEl;
        const rect = entry.contentRect;
        const width = rect?.width || 0;
        const height = rect?.height || 0;
        const prevW = isRoot ? lastRootW : lastLiveW;
        const prevH = isRoot ? lastRootH : lastLiveH;
        if (width === prevW && height === prevH) continue;
        const widthChanged = width !== prevW;
        if (isRoot) {
          lastRootW = width;
          lastRootH = height;
          if (width > 0) setColumnSize({ width, height });
        } else {
          lastLiveW = width;
          lastLiveH = height;
          if (width > 0) setLiveSize({ width, height });
        }
        if (widthChanged) setExpanded(false);
        const result = advancePointerMachine(machineRef.current, {
          kind: "layoutchange",
        });
        machineRef.current = result.state;
        applyDecisions(result.decisions);
      }
    });
    if (rootEl) observer.observe(rootEl);
    if (liveEl) observer.observe(liveEl);
    return () => {
      window.removeEventListener("blur", feedInterrupt);
      observer.disconnect();
    };
  }, [applyDecisions]);

  // 冻结框观察使用未缩放尺寸：既供占位，也核验资源变化；尺寸变化先收笔。
  useEffect(() => {
    if (!frameMounted) return;
    const el = frameRef.current;
    if (!el) return;
    let previous = { width: 0, height: 0 };
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      if (rect.width === previous.width && rect.height === previous.height)
        return;
      previous = { width: rect.width, height: rect.height };
      const result = advancePointerMachine(machineRef.current, {
        kind: "layoutchange",
      });
      machineRef.current = result.state;
      applyDecisions(result.decisions);
      setFrameSize(previous);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [frameMounted, applyDecisions]);

  // 挂框就绪门控（D）：有基准挂框后材料表面仍需稳定——晚到图片会把冻结
  // 框内容推高（先量到的高度作废）；稳定前与高度漂移期间禁墨，与「不匹配
  // 禁墨」口径一致
  useEffect(() => {
    if (!frameMounted || !isAnnotationActive) return;
    let active = true;
    setFrameSurfaceReady(false);
    void (async () => {
      const el = liveSurfaceRef.current;
      const ready = el
        ? await awaitMaterialSurfaceReady(el, () => !active)
        : false;
      if (active) setFrameSurfaceReady(ready);
    })();
    return () => {
      active = false;
    };
  }, [frameMounted, isAnnotationActive]);

  const inputLayer = (
    <div
      ref={setInputLayer}
      data-slot="material-annotation-input"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => handlePointerEnd(e, "pointerup")}
      onPointerCancel={(e) => handlePointerEnd(e, "pointercancel")}
      onLostPointerCapture={(e) => handlePointerEnd(e, "lostpointercapture")}
      // 悬停留下的橡皮圈：指针离开材料就收起（按着擦的由收笔收起）
      onPointerLeave={() => {
        if (activePointerIdRef.current === null) ring.hide();
      }}
      style={{
        // 输入门控：非标注态不拦截；标注态下未就绪（首笔/挂框门控）或
        // 挂框宽高漂移期间不拦截（与「不匹配禁墨」同口径）
        pointerEvents: inputEnabled ? "auto" : "none",
        // 与题面圈画同口径：手指用于滚动，Pencil 与鼠标可圈画。
        touchAction: touchActionForInput("pen", true, false),
        zIndex: 10,
      }}
      className={`absolute inset-0 [&_canvas]:pointer-events-none ${
        isAnnotationActive
          ? gesture.kind === "erase"
            ? "cursor-cell"
            : "cursor-crosshair"
          : ""
      }`}
    />
  );

  return (
    <div
      ref={rootRef}
      data-slot="material-annotation-overlay"
      data-drawing={isAnnotationActive}
      data-material-id={materialId}
      data-stroke-count={strokes.length}
      data-ink-visible={showInk}
      data-ink-ready={inputEnabled || !isAnnotationActive}
      // 适应宽度只裁剪横向溢出，避免内部滚动口截获材料列的纵向手势。
      className={`relative min-w-0 ${frameMounted ? (expanded ? "overflow-x-auto" : "overflow-x-clip") : ""}`}
    >
      <div
        data-slot="material-ink-frame-sizer"
        className="relative mx-auto min-w-0"
        style={
          frameMounted
            ? {
                width: frozen.cssWidth * scale,
                height:
                  frameSize.height > 0 ? frameSize.height * scale : undefined,
              }
            : undefined
        }
      >
        <div
          ref={frameRef}
          data-slot="material-ink-frame"
          className="relative min-w-0"
          style={
            frameMounted
              ? {
                  width: frozen.cssWidth,
                  transform: scale !== 1 ? `scale(${scale})` : undefined,
                  transformOrigin: "top left",
                }
              : undefined
          }
        >
          <div
            ref={liveSurfaceRef}
            data-slot="material-live-surface"
            className="relative min-w-0"
          >
            {children}
            {inputLayer}
          </div>
        </div>
      </div>
      {layoutDrift && (
        <p
          role="note"
          className="mt-2 text-xs text-amber-600 dark:text-amber-400"
        >
          材料尺寸与圈画基准相差超过
          10px，已暂停圈画并保留原稿；请检查材料内容或图片加载情况。
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {frameMounted && fitScale < 0.85 && (
          <Button
            type="button"
            variant="ghost"
            className="h-11"
            aria-pressed={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "适应宽度" : "放大材料"}
          </Button>
        )}
      </div>
      {missingBase && (
        <p
          role="note"
          className="mt-2 text-xs text-amber-600 dark:text-amber-400"
        >
          旧材料笔迹缺少原排版基准，无法确认位置；已保留原稿并暂停圈画。
        </p>
      )}
      {isAnnotationActive &&
        !missingBase &&
        frozen === null &&
        !surfaceReady && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            正在准备圈画…
          </p>
        )}
    </div>
  );
}
