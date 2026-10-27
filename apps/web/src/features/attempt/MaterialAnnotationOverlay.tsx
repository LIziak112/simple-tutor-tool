import type { InkDoc, InkStroke, InkStrokePoint } from "@tutor/contract";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
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
import { draftStore } from "./draft-store";

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
 * 材料圈画手写图层（协同标画）。与题面圈画（annotation-surface）复用同一批
 * 引擎单源，不在本组件重写第二份：
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
  const replayRef = useRef<AtramentReplayCanvas | null>(null);

  const [strokes, setStrokes] = useState<InkStroke[]>(() => {
    const existing = draftStore.getMaterialInk(attemptId, storeKey);
    if (existing?.engine === "atrament") {
      return existing.data.strokes;
    }
    return [];
  });
  const strokesRef = useRef<InkStroke[]>(strokes);
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
  const strokeStartRef = useRef(0);
  const activePointerIdRef = useRef<number | null>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const lastEraseRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  // 恢复材料草稿（内存命中立即读取；硬刷新冷启动时异步回源 IndexedDB）
  useEffect(() => {
    let active = true;
    const load = async () => {
      const fromMem = draftStore.getMaterialInk(attemptId, storeKey);
      if (fromMem?.engine === "atrament") {
        if (active) setStrokesBoth(fromMem.data.strokes);
        return;
      }
      const record = await draftStore.loadDraft(attemptId);
      if (!active) return;
      const stored = record?.materialInks?.[storeKey];
      if (stored?.engine === "atrament") {
        setStrokesBoth(stored.data.strokes);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [attemptId, storeKey, setStrokesBoth]);

  // 绘制层：复用回放画布（canvas 创建/DPR 上限/ResizeObserver 重画一体）
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    try {
      replayRef.current = createAtramentReplayCanvas(el);
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
  }, []);

  const drawCurrent = useCallback(() => {
    const replay = replayRef.current;
    if (!replay) return;
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

  const cancelRedraw = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // 笔迹变动即重绘（冷启动异步恢复同样触发——修复「恢复后画布空白」）；
  // strokes 是触发器，绘制读 ref 以连带在途笔
  useEffect(() => {
    if (strokesRef.current !== strokes) strokesRef.current = strokes;
    scheduleRedraw();
    return cancelRedraw;
  }, [strokes, scheduleRedraw, cancelRedraw]);

  const saveToDraftStore = useCallback(
    (nextStrokes: InkStroke[]) => {
      const doc: InkDoc = {
        engine: "atrament",
        version: 1,
        data: { width: INK_LOGICAL_WIDTH, strokes: nextStrokes },
        updatedAt: Date.now(),
      };
      draftStore.saveMaterialInk(attemptId, storeKey, doc);
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
      const el = inputRef.current;
      if (el) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // 部分环境（如单测 jsdom）未实现指针捕获，防御忽略
        }
      }
      activePointerIdRef.current = e.pointerId;
      // 同键双实例（同 materialId 被两个锚渲染）兜底：落笔前对齐草稿仓最新
      const latest = draftStore.getMaterialInk(attemptId, storeKey);
      if (
        latest?.engine === "atrament" &&
        latest.data.strokes !== strokesRef.current
      ) {
        setStrokesBoth(latest.data.strokes);
      }
      rectRef.current = el?.getBoundingClientRect() ?? null;
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

  // 窗口失焦与材料列宽变化（分栏拖拽/排版切换/窗口缩放）：在途一笔按已收
  // 采样收笔——一笔绝不混用两个宽度基准（「分栏宽度变化后先收笔」约定）
  useEffect(() => {
    const feedInterrupt = () => {
      const result = advancePointerMachine(machineRef.current, {
        kind: "blur",
      });
      machineRef.current = result.state;
      applyDecisions(result.decisions);
    };
    window.addEventListener("blur", feedInterrupt);
    let lastWidth = inputRef.current?.clientWidth ?? 0;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? lastWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      const result = advancePointerMachine(machineRef.current, {
        kind: "layoutchange",
      });
      machineRef.current = result.state;
      applyDecisions(result.decisions);
    });
    if (inputRef.current) observer.observe(inputRef.current);
    return () => {
      window.removeEventListener("blur", feedInterrupt);
      observer.disconnect();
    };
  }, [applyDecisions]);

  // 会话输入偏好切换（笔写/手指书写）：在途笔先收，再按新模式重建状态机
  useEffect(() => {
    const result = advancePointerMachine(machineRef.current, {
      kind: "layoutchange",
    });
    machineRef.current = result.state;
    applyDecisions(result.decisions);
    machineRef.current = createPointerMachineState(inputMode);
  }, [inputMode, applyDecisions]);

  return (
    <div
      data-slot="material-annotation-overlay"
      data-drawing={isAnnotationActive}
      data-material-id={materialId}
      data-stroke-count={strokes.length}
      className="relative min-w-0"
    >
      {children}
      <div
        ref={inputRef}
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
    </div>
  );
}
