import {
  INK_LOGICAL_WIDTH,
  type InkDoc,
  type InkStroke,
  type InkStrokePoint,
} from "@tutor/contract";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useCoordinatedAnnotation } from "@/features/annotation/coordinated-annotation-context";
import { fromLogical, toLogical } from "@/features/ink/engine/normalize";
import { useAttemptEditor } from "./AttemptEditorContext";
import { draftStore } from "./draft-store";

export interface MaterialAnnotationOverlayProps {
  attemptId: string;
  materialId: string;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  /**
   * 本材料关联的题目 ID 列表（QM-15/题组/solo 关联单源）：
   * 仅当当前题卡处于标注态且属于本材料时，才激活手写圈画；
   * 未传入时宽容降级为任意题目圈画时激活（兼容单测）。
   */
  associatedQuestionIds?: readonly string[] | undefined;
}

const COLOR_MAP: Record<string, string> = {
  red: "#ef4444",
  blue: "#3b82f6",
  black: "#1f2937",
  green: "#10b981",
  yellow: "#eab308",
};

const SIZE_MAP: Record<string, number> = {
  thin: 2,
  medium: 4,
  thick: 7,
};

function resolveWeight(size: string | number): number {
  if (typeof size === "number") return size;
  return SIZE_MAP[size] ?? 3;
}

function resolveColor(color: string): string {
  return COLOR_MAP[color] ?? color;
}

function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1)));
}

function strokeHits(
  stroke: InkStroke,
  x: number,
  y: number,
  radius: number,
): boolean {
  const points = stroke.points;
  if (!points || points.length === 0) return false;
  const p0 = points[0];
  if (!p0) return false;
  if (points.length === 1) {
    return Math.hypot(p0.x - x, p0.y - y) <= radius;
  }
  for (let i = 0; i < points.length - 1; i++) {
    const pA = points[i];
    const pB = points[i + 1];
    if (pA && pB && distToSegment(x, y, pA.x, pA.y, pB.x, pB.y) <= radius) {
      return true;
    }
  }
  return false;
}

/**
 * 材料圈画手写图层（协同标画）：
 * - 当题卡点击「圈画」进入标注态时，仅关联题目的材料区同步激活手写/圈画图层；
 * - 与题目使用统一的画笔/橡皮/颜色/粗细（useCoordinatedAnnotation）；
 * - 矢量笔迹一律按 INK_LOGICAL_WIDTH (1000) 归一化存储，分栏比例变化与屏幕缩放绝不变形；
 * - 笔迹采用统一合并存储（按 attemptId + materialId 存入 draftStore）；
 * - 支持冷启动异步从 IndexedDB 加载已有笔迹；
 * - 非标注态时以只读形式呈现笔迹，支持学生在答题时随时对照材料标画。
 */
export function MaterialAnnotationOverlay({
  attemptId,
  materialId,
  children,
  disabled = false,
  className = "",
  associatedQuestionIds,
}: MaterialAnnotationOverlayProps) {
  const editor = useAttemptEditor();
  const { tool, color, size } = useCoordinatedAnnotation();

  const isAssociated =
    associatedQuestionIds === undefined ||
    (editor?.active?.questionId !== undefined &&
      associatedQuestionIds.includes(editor.active.questionId));

  const isAnnotationActive =
    !disabled && editor?.active?.kind === "annotation" && isAssociated;

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [strokes, setStrokes] = useState<InkStroke[]>(() => {
    const existing = draftStore.getMaterialInk(attemptId, materialId);
    if (existing?.engine === "atrament") {
      return existing.data.strokes;
    }
    return [];
  });

  const strokesRef = useRef<InkStroke[]>(strokes);
  strokesRef.current = strokes;

  const currentStrokeRef = useRef<InkStroke | null>(null);
  const isDrawingRef = useRef(false);

  // 恢复材料草稿（内存命中立即读取；硬刷新冷启动时异步回源 IndexedDB）
  useEffect(() => {
    let active = true;
    const load = async () => {
      const fromMem = draftStore.getMaterialInk(attemptId, materialId);
      if (fromMem?.engine === "atrament") {
        if (active) setStrokes(fromMem.data.strokes);
        return;
      }
      const record = await draftStore.loadDraft(attemptId);
      if (!active) return;
      const stored = record?.materialInks?.[materialId];
      if (stored?.engine === "atrament") {
        setStrokes(stored.data.strokes);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [attemptId, materialId]);

  // 重绘全部笔迹（基于逻辑宽度 1000 动态映射到当前容器像素宽度，并支持 Retina HiDPI）
  const redrawAll = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = container.clientWidth || 300;
    const height = container.clientHeight || 150;
    const dpr =
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const allStrokes = [...strokesRef.current];
    if (currentStrokeRef.current) {
      allStrokes.push(currentStrokeRef.current);
    }

    for (const stroke of allStrokes) {
      if (!stroke.points || stroke.points.length === 0) continue;

      const pts = stroke.points;
      const firstPt = pts[0];
      if (!firstPt) continue;

      ctx.save();
      ctx.strokeStyle = resolveColor(stroke.color);
      ctx.lineWidth = Math.max(1, fromLogical(width, stroke.weight));
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      ctx.beginPath();
      const firstX = fromLogical(width, firstPt.x);
      const firstY = fromLogical(width, firstPt.y);

      if (pts.length === 1) {
        ctx.arc(firstX, firstY, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
      } else {
        ctx.moveTo(firstX, firstY);
        for (let i = 1; i < pts.length; i++) {
          const pt = pts[i];
          if (pt) {
            ctx.lineTo(fromLogical(width, pt.x), fromLogical(width, pt.y));
          }
        }
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }, []);

  // 尺寸随内容及分栏比例调整自适应
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const updateSize = () => {
      const width = container.clientWidth || 300;
      const height = container.clientHeight || 150;
      const dpr =
        typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);

      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      redrawAll();
    };

    updateSize();
    const observer = new ResizeObserver(() => updateSize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [redrawAll]);

  // 笔迹变动时重绘
  useEffect(() => {
    redrawAll();
  }, [redrawAll]);

  const saveToDraftStore = useCallback(
    (newStrokes: InkStroke[]) => {
      const doc: InkDoc = {
        engine: "atrament",
        version: 1,
        data: { width: INK_LOGICAL_WIDTH, strokes: newStrokes },
        updatedAt: Date.now(),
      };
      draftStore.saveMaterialInk(attemptId, materialId, doc);
    },
    [attemptId, materialId],
  );

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!isAnnotationActive || e.button !== 0) return;
      e.preventDefault();
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const width =
        container.clientWidth || canvas.clientWidth || rect.width || 300;
      const logicalX = toLogical(width, screenX);
      const logicalY = toLogical(width, screenY);

      if (tool === "eraser") {
        const logicalRadius = toLogical(width, 16);
        const remaining = strokesRef.current.filter(
          (s) => !strokeHits(s, logicalX, logicalY, logicalRadius),
        );
        if (remaining.length !== strokesRef.current.length) {
          strokesRef.current = remaining;
          setStrokes(remaining);
          saveToDraftStore(remaining);
          redrawAll();
        }
        isDrawingRef.current = true;
        return;
      }

      isDrawingRef.current = true;
      const newPoint: InkStrokePoint = {
        x: logicalX,
        y: logicalY,
        p: e.pressure || 0.5,
        t: Date.now(),
      };

      currentStrokeRef.current = {
        tool: "pen",
        color,
        weight: toLogical(width, resolveWeight(size)),
        points: [newPoint],
      };

      redrawAll();
    },
    [isAnnotationActive, tool, color, size, saveToDraftStore, redrawAll],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!isDrawingRef.current || !isAnnotationActive) return;
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const width =
        container.clientWidth || canvas.clientWidth || rect.width || 300;
      const logicalX = toLogical(width, screenX);
      const logicalY = toLogical(width, screenY);

      if (tool === "eraser") {
        const logicalRadius = toLogical(width, 16);
        const remaining = strokesRef.current.filter(
          (s) => !strokeHits(s, logicalX, logicalY, logicalRadius),
        );
        if (remaining.length !== strokesRef.current.length) {
          strokesRef.current = remaining;
          setStrokes(remaining);
          saveToDraftStore(remaining);
          redrawAll();
        }
        return;
      }

      if (currentStrokeRef.current) {
        currentStrokeRef.current.points.push({
          x: logicalX,
          y: logicalY,
          p: e.pressure || 0.5,
          t: Date.now(),
        });
        redrawAll();
      }
    },
    [isAnnotationActive, tool, saveToDraftStore, redrawAll],
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!isDrawingRef.current) return;
      isDrawingRef.current = false;
      const canvas = canvasRef.current;
      if (canvas) {
        try {
          canvas.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }

      if (currentStrokeRef.current) {
        const nextStrokes = [...strokesRef.current, currentStrokeRef.current];
        currentStrokeRef.current = null;
        strokesRef.current = nextStrokes;
        setStrokes(nextStrokes);
        saveToDraftStore(nextStrokes);
        redrawAll();
      }
    },
    [saveToDraftStore, redrawAll],
  );

  // 全局 pointerup/pointercancel 兜底：防止快速画到画布外部松开导致绘画态残留
  useEffect(() => {
    const handleGlobalPointerUp = () => {
      if (!isDrawingRef.current) return;
      isDrawingRef.current = false;
      if (currentStrokeRef.current) {
        const nextStrokes = [...strokesRef.current, currentStrokeRef.current];
        currentStrokeRef.current = null;
        strokesRef.current = nextStrokes;
        setStrokes(nextStrokes);
        saveToDraftStore(nextStrokes);
        redrawAll();
      }
    };

    window.addEventListener("pointerup", handleGlobalPointerUp);
    window.addEventListener("pointercancel", handleGlobalPointerUp);
    return () => {
      window.removeEventListener("pointerup", handleGlobalPointerUp);
      window.removeEventListener("pointercancel", handleGlobalPointerUp);
    };
  }, [saveToDraftStore, redrawAll]);

  return (
    <div
      ref={containerRef}
      data-slot="material-annotation-overlay"
      data-drawing={isAnnotationActive}
      data-material-id={materialId}
      data-stroke-count={strokes.length}
      className={`relative min-w-0 ${className}`}
    >
      {children}
      <canvas
        ref={canvasRef}
        data-slot="material-annotation-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          pointerEvents: isAnnotationActive ? "auto" : "none",
          touchAction: isAnnotationActive ? "none" : "auto",
        }}
        className={`absolute inset-0 z-10 size-full ${
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
