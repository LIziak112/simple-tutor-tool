/**
 * 图形手势：书写面上用图形工具（或直线荧光笔）从落下到抬起这一段的共用
 * 流程——落笔定起点，拖动途中在临时层上画预览（live-layer.ts），抬笔给出
 * 这一笔的点列（shape-points.ts）。草稿纸、自然笔感书写面、题面圈画与材料
 * 圈画共用；各书写面只负责换算坐标，并把 end() 给出的点列装成一笔提交进
 * 自己的笔画仓。
 */
import type { InkLiveLayer } from "./live-layer.ts";
import {
  SHAPE_MIN_SPAN,
  type ShapeOutline,
  type ShapeXY,
  shapeOutline,
  shapeSpan,
  shapeStrokePoints,
  shapeVertexPoints,
  snapShapeEnd,
} from "./shape-points.ts";
import type { InkShapeKind, InkStrokePoint } from "./types.ts";

export interface ShapeGestureHost {
  /** 预览画在哪一层（与笔画同一坐标域）；没有就不预览 */
  layer(): Pick<InkLiveLayer, "showOutline" | "clear"> | null;
}

export interface ShapeGestureStart {
  shape: InkShapeKind;
  /** 落笔点（坐标单位） */
  from: ShapeXY;
  /** 这一笔的颜色与线宽（坐标单位） */
  brush: { color: string; weight: number };
  /** 一个逻辑单位（宽 1000 的纸）合多少坐标单位，缺省 1 */
  unit?: number;
  /** 画布范围（坐标单位）：指针拖出界也只画到边上，点不出界 */
  bounds?: { width: number; height: number };
  /** 只留起止点、不加密：整笔一条路径的笔（荧光笔）画的就是连线本身 */
  sparse?: boolean;
  /** 预览的线宽，缺省同这一笔的线宽（自然笔感落到画布时另有缩放） */
  previewWeight?: number;
}

export interface ShapeGesture {
  /** 当前这次手势是不是在画图形 */
  readonly active: boolean;
  begin(start: ShapeGestureStart): void;
  /** 指针到了 to；elapsedMs 为距落笔的毫秒数 */
  through(to: ShapeXY, elapsedMs: number): void;
  /**
   * 结束手势、收起预览，给出这一笔的点列。没拖出大小（只点了一下、拖得太
   * 短）返回 null，不落笔。丢弃在途的图形也调它，不用返回值即可。
   */
  end(): InkStrokePoint[] | null;
}

export function createShapeGesture(host: ShapeGestureHost): ShapeGesture {
  let current: (ShapeGestureStart & { to: ShapeXY; elapsedMs: number }) | null =
    null;

  function clamp(p: ShapeXY): ShapeXY {
    const bounds = current?.bounds;
    if (!bounds) return p;
    return {
      x: Math.min(bounds.width, Math.max(0, p.x)),
      y: Math.min(bounds.height, Math.max(0, p.y)),
    };
  }

  /** 拖到当前位置的骨架；还没拖出大小时为 null */
  function outline(): ShapeOutline | null {
    if (!current) return null;
    const unit = current.unit ?? 1;
    if (shapeSpan(current.from, current.to) < SHAPE_MIN_SPAN * unit)
      return null;
    const shape = shapeOutline(
      current.shape,
      current.from,
      current.to,
      current.brush.weight,
      unit,
    );
    // 起止点已在界内；箭翼可能伸出去，收到边上
    return { ...shape, points: shape.points.map(clamp) };
  }

  return {
    get active(): boolean {
      return current !== null;
    },
    begin(start): void {
      current = { ...start, to: start.from, elapsedMs: 0 };
      current.from = clamp(start.from);
      current.to = current.from;
      host.layer()?.clear();
    },
    through(to, elapsedMs): void {
      if (!current) return;
      current.to = snapShapeEnd(current.shape, current.from, clamp(to));
      current.elapsedMs = Math.max(current.elapsedMs, elapsedMs);
      const shape = outline();
      const layer = host.layer();
      if (!shape) {
        layer?.clear();
        return;
      }
      layer?.showOutline(shape.points, {
        color: current.brush.color,
        weight: current.previewWeight ?? current.brush.weight,
      });
    },
    end(): InkStrokePoint[] | null {
      const finished = current;
      // 没在画图形：什么都不动（临时层上可能是别的笔，比如在途的荧光笔）
      if (!finished) return null;
      const shape = outline();
      current = null;
      host.layer()?.clear();
      if (!shape) return null;
      return finished.sparse
        ? shapeVertexPoints(shape, finished.elapsedMs)
        : shapeStrokePoints(shape, finished.elapsedMs, finished.unit ?? 1);
    },
  };
}
