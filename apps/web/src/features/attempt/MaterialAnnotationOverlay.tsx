import type { InkDoc, InkStroke, InkStrokePoint } from "@tutor/contract";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { useCoordinatedAnnotation } from "@/features/annotation/coordinated-annotation-context";
import { eraseHit } from "@/features/ink/engine/erase.ts";
import { toLogicalPoint } from "@/features/ink/engine/normalize.ts";
import {
  advancePointerMachine,
  createPointerMachineState,
  isSampleMove,
  type PointerDecision,
  type PointerMachineState,
  touchActionForInput,
} from "@/features/ink/engine/pointer-machine.ts";
import {
  INK_ERASE_RADIUS,
  INK_LOGICAL_WIDTH,
  INK_PEN_COLORS,
  INK_PEN_SIZES,
} from "@/features/ink/engine/types.ts";
import { useSessionInputPreference } from "@/features/ink/input-preference";
import {
  type AtramentReplayCanvas,
  createAtramentReplayCanvas,
} from "@/features/ink/replay/draw.ts";
import { useAttemptEditor } from "./AttemptEditorContext";
import { draftStore, type MaterialInkBaseMeta } from "./draft-store";

/** 首笔前材料就绪等待上限（同题面 STEP_TIMEOUT_MS 口径） */
const MATERIAL_READY_TIMEOUT_MS = 15_000;

/**
 * 材料表面就绪等待（题面 awaitQuestionSurfaceReady 的材料版，不栅格化）：
 * 字体就绪 + 图片解码/收尾 + 连续 3 帧宽高测量不变，任一阶段超时返回 false。
 */
async function awaitMaterialSurfaceReady(
  surface: HTMLElement,
  isCancelled: () => boolean,
): Promise<boolean> {
  const deadline = performance.now() + MATERIAL_READY_TIMEOUT_MS;
  const frames = async () => {
    let previous = "";
    let unchanged = 0;
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      if (isCancelled()) return false;
      const rect = surface.getBoundingClientRect();
      const signature = `${rect.width}x${rect.height}`;
      if (signature === previous) {
        unchanged += 1;
        if (unchanged >= 3) return true;
      } else {
        unchanged = 0;
        previous = signature;
      }
    }
    return false;
  };
  const body = async () => {
    if (document.fonts) await document.fonts.ready;
    if (isCancelled()) return false;
    const images = [...surface.querySelectorAll("img")];
    await Promise.all(
      images.map(
        (image) =>
          new Promise<void>((resolve) => {
            if (image.complete) {
              if (typeof image.decode === "function") {
                image.decode().then(
                  () => resolve(),
                  () => resolve(),
                );
              } else {
                resolve();
              }
              return;
            }
            image.addEventListener("load", () => resolve(), { once: true });
            image.addEventListener("error", () => resolve(), { once: true });
          }),
      ),
    );
    if (isCancelled()) return false;
    return frames();
  };
  const timeout = new Promise<false>((resolve) => {
    setTimeout(() => resolve(false), MATERIAL_READY_TIMEOUT_MS);
  });
  return Promise.race([body(), timeout]);
}

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
 *   变化先收笔等决策矩阵与其单测共用），输入偏好沿用会话级
 *   getSessionInputPreference（笔写／手指滚动）；
 * - 绘制：ink/replay/draw 的 createAtramentReplayCanvas（与回放/导出同一
 *   atrament 绘制原语、DPR 上限 2、尺寸变化自重画）；
 * - 笔色/笔粗/橡皮半径：INK_PEN_COLORS / INK_PEN_SIZES / INK_ERASE_RADIUS，
 *   橡皮命中走 eraseHit（半径内含半笔宽，与题面圈画同手感）；
 * - 矢量坐标一律按 INK_LOGICAL_WIDTH(1000) 归一化存储（normalize.ts）。
 * 笔迹按 attemptId + inkKey 合并存入 draftStore（本机稿；交卷不清除，
 * 结果页只读回看——见 clearDraft 的保稿分支）。
 *
 * 冻结作用域（与题面「永久冻结排版」的关键差异——材料是整组题共享的长
 * 阅读面，列宽是学生用中缝主动调节的阅读旋钮，不能被一次圈画永久接管）：
 * - 默认阅读恒为活排版：正文随列宽自然回流，永不因有笔迹而固定宽度；
 * - 圈画态挂冻结工作框（固定逻辑宽 + transform 等比适配，题面同款形态）：
 *   已有冻结基准立即挂框（旧笔迹对齐显示、几何稳定）；无基准材料保持
 *   活排版，首笔收笔时按落笔矩形捕获基准并随稿存 materialInkBases
 *   （cssWidth/cssHeight）；首笔前有就绪门控（字体/图片/连续 3 帧稳定，
 *   未就绪禁墨提示），冻结宽此后锁定，拖中缝先收笔、只整体缩放不回流；
 * - 非圈画态笔迹按「排版匹配自显」：活排版宽高与冻结基准 ±1px 匹配
 *   （questionSurfaceMatchesLayout 同口径）时笔迹直接叠在活正文上；
 *   不匹配（分栏拖动/材料改版/字体变化）时隐藏笔迹，提供「按圈画时排版
 *   查看」只读冻结框——禁止旧笔迹静默叠到新排版（手写与同步约定）；
 * - 圈画态 fitScale<0.85 提供「放大材料」1:1 横滚逃生（同题面「放大题面」）；
 * - 不栅格化底图 PNG：长材料受 Safari canvas 面积上限约束
 *   （material-export-pages 分块先例），以冻结框 + 宽高匹配替代底图兜底。
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
  const tool = coordinated?.tool ?? "pen";
  const color = coordinated?.color ?? "red";
  const size = coordinated?.size ?? "thin";
  const storeKey = inkKey ?? materialId;

  const isAssociated =
    associatedQuestionIds === undefined ||
    (editor?.active?.questionId !== undefined &&
      associatedQuestionIds.includes(editor.active.questionId));
  const isAnnotationActive =
    editor?.active?.kind === "annotation" && isAssociated;

  const inputRef = useRef<HTMLDivElement>(null);
  // 输入层元素进 state：冻结框切换会改变其在树中的位置（重挂），画布创建
  // effect 需感知新元素重建
  const [inputElement, setInputElement] = useState<HTMLDivElement | null>(null);
  const setInputLayer = useCallback((el: HTMLDivElement | null) => {
    inputRef.current = el;
    setInputElement(el);
  }, []);
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  // 冻结基准（首笔落笔时的活排版矩形；空稿清除后下次首笔重冻）
  const [frozen, setFrozen] = useState<MaterialInkBaseMeta | null>(() =>
    draftStore.getMaterialInkBase(attemptId, storeKey),
  );
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;
  /** 根（活排版/冻结框占位）的观察尺寸：宽用于框缩放，宽高用于排版匹配 */
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const liveSizeRef = useRef(containerSize);
  liveSizeRef.current = containerSize;
  /** 冻结框内容高（未缩放布局高，transform 不参与布局须显式占位） */
  const [frameHeight, setFrameHeight] = useState(0);
  /** 只读回看态（「按圈画时排版查看」；圈画态本身也走冻结框渲染） */
  const [reviewMode, setReviewMode] = useState(false);
  /** 1:1 放大态（fitScale<0.85 的逃生口；宽度变化即复位，同题面） */
  const [expanded, setExpanded] = useState(false);
  /** 首笔就绪门控（无基准材料的圈画态；有基准即视为就绪） */
  const [surfaceReady, setSurfaceReady] = useState(false);
  const surfaceReadyRef = useRef(false);
  surfaceReadyRef.current = surfaceReady;
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
  const inputMode = useSessionInputPreference();
  const machineRef = useRef<PointerMachineState>(
    createPointerMachineState(inputMode),
  );
  const currentStrokeRef = useRef<InkStroke | null>(null);
  /** 本笔落笔矩形：首笔冻结基准的捕获源（一笔不混用两个排版基准） */
  const strokeBaseRef = useRef<{ width: number; height: number } | null>(null);
  const strokeStartRef = useRef(0);
  const activePointerIdRef = useRef<number | null>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const lastEraseRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  // ── 派生态（渲染分支与匹配自显） ──
  // 活排版匹配：±1px 口径与题面 questionSurfaceMatchesLayout 一致；宽高任一
  // 漂移（拖中缝回流、晚到图片下推）都视为不匹配，撤下笔迹不静默叠
  const layoutMatch =
    frozen !== null &&
    containerSize.width > 0 &&
    Math.abs(containerSize.width - frozen.cssWidth) <= 1 &&
    (frozen.cssHeight === undefined ||
      Math.abs(containerSize.height - frozen.cssHeight) <= 1);
  const frameMode = frozen !== null && (isAnnotationActive || reviewMode);
  const showInk = frameMode || layoutMatch || isAnnotationActive;
  const showInkRef = useRef(showInk);
  showInkRef.current = showInk;
  const fitScale =
    frozen !== null &&
    frozen.cssWidth > 0 &&
    containerSize.width > 0 &&
    containerSize.width < frozen.cssWidth
      ? containerSize.width / frozen.cssWidth
      : 1;
  const scale = expanded ? 1 : fitScale;

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

  // 圈画态入口对齐：已有冻结基准（本机或他实例已存）立即采用挂框；无基准
  // 旧笔迹（冻结机制落盘前的数据）按当前活排版收养基准；干净材料不冻结，
  // 保持活排版（全组材料不因一点圈画被接管）
  useEffect(() => {
    if (!isAnnotationActive || frozenRef.current !== null) return;
    const base = draftStore.getMaterialInkBase(attemptId, storeKey);
    if (base !== null) {
      frozenRef.current = base;
      setFrozen(base);
      return;
    }
    if (strokes.length > 0 && containerSize.width > 0) {
      const adopted: MaterialInkBaseMeta = {
        cssWidth: containerSize.width,
        ...(containerSize.height > 0
          ? { cssHeight: containerSize.height }
          : {}),
      };
      frozenRef.current = adopted;
      setFrozen(adopted);
      draftStore.saveMaterialInkBase(attemptId, storeKey, adopted);
    }
  }, [isAnnotationActive, attemptId, storeKey, strokes.length, containerSize]);

  // 首笔就绪门控：无基准材料的圈画态等材料表面稳定（字体/图片/连续 3 帧），
  // 未就绪禁墨并提示；有基准（冻结框强制几何）不门控
  useEffect(() => {
    if (!isAnnotationActive || frozen !== null) return;
    let active = true;
    setSurfaceReady(false);
    void (async () => {
      const el = rootRef.current;
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
    const all = currentStrokeRef.current
      ? [...strokesRef.current, currentStrokeRef.current]
      : strokesRef.current;
    replay.drawFrame(
      all,
      all.map((s) => s.points.length),
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
  // 依赖输入层元素而非仅挂载时读一次 ref：冻结框切换会重挂输入层
  useEffect(() => {
    const el = inputElement;
    if (!el) return;
    try {
      const replay = createAtramentReplayCanvas(el);
      replayRef.current = replay;
      // 挂载即画一帧：重挂后的新画布须立即恢复既有笔迹（stroke 变动效应
      // 不会为同一份 strokes 再触发）；不匹配隐藏态画空帧
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
      // 隐藏态立即清屏，不排队 rAF（排版不匹配时禁止旧笔迹叠新排版）
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
        setReviewMode(false);
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

  const eraseAt = useCallback(
    (point: { x: number; y: number }) => {
      const hits = eraseHit(
        strokesRef.current,
        point.x,
        point.y,
        INK_ERASE_RADIUS,
        undefined,
        lastEraseRef.current ?? undefined,
      );
      lastEraseRef.current = point;
      if (hits.length === 0) return;
      const hitSet = new Set(hits);
      const remaining = strokesRef.current.filter(
        (_, index) => !hitSet.has(index),
      );
      setStrokesBoth(remaining);
      saveToDraftStore(remaining);
    },
    [saveToDraftStore, setStrokesBoth],
  );

  const beginInteraction = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // 就绪门控：无基准首笔前材料表面未稳定不落墨（晚到图片会把内容
      // 下推，冻结基准与笔迹一起错位）
      if (frozenRef.current === null && !surfaceReadyRef.current) return;
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
      if (tool === "eraser") {
        lastEraseRef.current = null;
        eraseAt(point);
        return;
      }
      currentStrokeRef.current = {
        tool: "pen",
        color: INK_PEN_COLORS[color],
        weight: INK_PEN_SIZES[size],
        points: [point],
      };
    },
    [attemptId, storeKey, tool, color, size, pointOf, eraseAt, setStrokesBoth],
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
    rectRef.current = null;
    lastEraseRef.current = null;
    const stroke = currentStrokeRef.current;
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
  }, [releaseCapture, saveToDraftStore, setStrokesBoth]);

  const applyDecisions = useCallback(
    (
      decisions: readonly PointerDecision[],
      e?: ReactPointerEvent<HTMLDivElement>,
    ) => {
      for (const decision of decisions) {
        if (decision.action === "start" && e) {
          beginInteraction(e);
        } else if (decision.action === "commit") {
          finishInteraction();
        } else if (decision.action === "discard") {
          releaseCapture();
          currentStrokeRef.current = null;
        }
      }
    },
    [beginInteraction, finishInteraction, releaseCapture],
  );

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!isAnnotationActive || e.button !== 0) return;
      e.preventDefault();
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
      if (!isSampleMove(machineRef.current, e.pointerId)) return;
      if (tool === "eraser") {
        eraseAt(pointOf(e));
        return;
      }
      const stroke = currentStrokeRef.current;
      if (!stroke) return;
      stroke.points.push(pointOf(e));
      scheduleRedraw();
    },
    [tool, pointOf, eraseAt, scheduleRedraw],
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

  // 窗口失焦与根尺寸变化（分栏拖拽/排版切换/窗口缩放/晚到图片下推）：
  // 在途一笔按已采样收笔——指针→逻辑的换算矩形随布局变化，一笔不混用
  // 两个排版基准（「布局变化先收笔」约定）；宽度变化同时复位 1:1 放大
  useEffect(() => {
    const feedInterrupt = () => {
      const result = advancePointerMachine(machineRef.current, {
        kind: "blur",
      });
      machineRef.current = result.state;
      applyDecisions(result.decisions);
    };
    window.addEventListener("blur", feedInterrupt);
    const el = rootRef.current;
    const initial = el?.getBoundingClientRect();
    let lastWidth = initial?.width ?? 0;
    let lastHeight = initial?.height ?? 0;
    if (lastWidth > 0)
      setContainerSize({ width: lastWidth, height: lastHeight });
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      const width = rect?.width || el?.getBoundingClientRect().width || 0;
      const height = rect?.height || el?.getBoundingClientRect().height || 0;
      if (width === lastWidth && height === lastHeight) return;
      const widthChanged = width !== lastWidth;
      lastWidth = width;
      lastHeight = height;
      if (width > 0) setContainerSize({ width, height });
      if (widthChanged) setExpanded(false);
      const result = advancePointerMachine(machineRef.current, {
        kind: "layoutchange",
      });
      machineRef.current = result.state;
      applyDecisions(result.decisions);
    });
    if (el) observer.observe(el);
    return () => {
      window.removeEventListener("blur", feedInterrupt);
      observer.disconnect();
    };
  }, [applyDecisions]);

  // 冻结框内容高跟踪：transform 不参与布局，sizer 须以「内容高 × 缩放」
  // 显式占位（contentRect 为未缩放布局高）
  useEffect(() => {
    if (!frameMode) return;
    const el = frameRef.current;
    if (!el) return;
    let lastHeight = -1;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0;
      if (height <= 0 || height === lastHeight) return;
      lastHeight = height;
      setFrameHeight(height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [frameMode]);

  // 会话输入偏好切换（笔写/手指书写）：在途笔先收，再按新模式重建状态机
  useEffect(() => {
    const result = advancePointerMachine(machineRef.current, {
      kind: "layoutchange",
    });
    machineRef.current = result.state;
    applyDecisions(result.decisions);
    machineRef.current = createPointerMachineState(inputMode);
  }, [inputMode, applyDecisions]);

  const inputLayer = (
    <div
      ref={setInputLayer}
      data-slot="material-annotation-input"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(e) => handlePointerEnd(e, "pointerup")}
      onPointerCancel={(e) => handlePointerEnd(e, "pointercancel")}
      onLostPointerCapture={(e) => handlePointerEnd(e, "lostpointercapture")}
      style={{
        pointerEvents: isAnnotationActive ? "auto" : "none",
        // 会话输入偏好：pen=手指滚动（pan-y）、finger=手指书写（none），
        // 与题面圈画 touchActionForInput 同源
        touchAction: touchActionForInput(inputMode, true, false),
        zIndex: 10,
      }}
      className={`absolute inset-0 ${
        isAnnotationActive
          ? tool === "eraser"
            ? "cursor-cell"
            : "cursor-crosshair"
          : ""
      }`}
    />
  );

  const frameMounted = frameMode && frozen !== null;
  const heightDrift =
    frameMounted &&
    frozen.cssHeight !== undefined &&
    frameHeight > 0 &&
    Math.abs(frameHeight - frozen.cssHeight) > 1;

  return (
    <div
      ref={rootRef}
      data-slot="material-annotation-overlay"
      data-drawing={isAnnotationActive}
      data-material-id={materialId}
      data-stroke-count={strokes.length}
      data-ink-visible={showInk}
      data-ink-ready={frozen !== null || surfaceReady}
      className={`relative min-w-0 ${frameMode ? "overflow-x-auto" : ""}`}
    >
      {frameMounted ? (
        <>
          <div
            data-slot="material-ink-frame-sizer"
            className="relative mx-auto min-w-0"
            style={{
              width: frozen.cssWidth * scale,
              height: frameHeight > 0 ? frameHeight * scale : undefined,
            }}
          >
            <div
              ref={frameRef}
              data-slot="material-ink-frame"
              className="relative min-w-0"
              style={{
                width: frozen.cssWidth,
                transform: scale !== 1 ? `scale(${scale})` : undefined,
                transformOrigin: "top left",
              }}
            >
              {children}
              {inputLayer}
            </div>
          </div>
          {heightDrift && (
            <p
              role="note"
              className="mt-2 text-xs text-amber-600 dark:text-amber-400"
            >
              材料排版与圈画时略有差异，笔迹位置可能偏移
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {fitScale < 0.85 && (
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
            {reviewMode && !isAnnotationActive && (
              <Button
                type="button"
                variant="ghost"
                className="h-11"
                onClick={() => setReviewMode(false)}
              >
                回到当前排版查看
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          {children}
          {inputLayer}
          {frozen !== null &&
            !isAnnotationActive &&
            containerSize.width > 0 &&
            !layoutMatch && (
              <Button
                type="button"
                variant="ghost"
                className="mt-2 h-11"
                onClick={() => setReviewMode(true)}
              >
                按圈画时排版查看
              </Button>
            )}
          {isAnnotationActive && frozen === null && !surfaceReady && (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              正在准备圈画…
            </p>
          )}
        </>
      )}
    </div>
  );
}
