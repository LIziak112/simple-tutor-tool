/**
 * 擦除手势：书写面上橡皮从落下到抬起这一段的共用流程——把落点记进擦除会话
 * （erase-session.ts）、只重画改动到的那一块（region-redraw.ts）、橡皮圈
 * 跟着走。草稿纸、自然笔感书写面与圈画共用；各书写面只负责换算坐标、提供
 * 画法，并在抬笔时把 end() 给出的结果提交进自己的笔画仓。
 */
import { type StrokeBounds, unionOfBoxes } from "./bounds.ts";
import {
  createEraseSession,
  type EraseResult,
  type EraseSession,
  type EraseSessionOptions,
  type EraseVisible,
} from "./erase-session.ts";
import type { InkLiveLayer } from "./live-layer.ts";
import { type RepaintTarget, repaintRegion } from "./region-redraw.ts";
import type { InkEraserMode, InkStroke } from "./types.ts";

/** 橡皮的一个落点：坐标与半径都用笔画的坐标单位 */
export interface ErasePoint {
  x: number;
  y: number;
  radius: number;
}

export interface EraseGestureHost {
  /**
   * 局部重画往哪儿画。返回 null 表示这一刻做不了局部重画（还没挂载，或画布
   * 与笔画不在同一个坐标域），改为 redraw 整张重画。
   */
  repaintTarget(): RepaintTarget | null;
  /** 把一笔画到画布上（局部重画时裁剪区已经设好） */
  paint(item: EraseVisible): void;
  /** 整张重画；擦除途中画的是 visible() */
  redraw(): void;
  /** 橡皮圈画在哪一层 */
  ring(): Pick<InkLiveLayer, "showRing" | "hideRing"> | null;
}

export interface EraseGesture {
  /** 橡皮是否正按着（落下之后、抬起之前） */
  readonly active: boolean;
  /** 橡皮落下：按此刻的笔画开始一次擦除 */
  begin(
    strokes: readonly InkStroke[],
    mode: InkEraserMode,
    options?: EraseSessionOptions,
  ): void;
  /**
   * 橡皮依次经过这些落点（一批采样）：相邻落点之间按线段扫过，一批只重画
   * 一次。橡皮圈显示在 ring 处，缺省为最后一个落点（画布与笔画不同域时，
   * 由书写面另给画布上的位置）。
   */
  through(points: readonly ErasePoint[], ring?: ErasePoint): void;
  /** 擦除途中画面上该有的笔画；橡皮没按着时为 null */
  visible(): readonly EraseVisible[] | null;
  /**
   * 橡皮抬起（或这次擦除作废）：收起橡皮圈，返回要提交的改动；什么都没擦到、
   * 或橡皮本来就没按着，返回 null。
   */
  end(): EraseResult | null;
}

export function createEraseGesture(host: EraseGestureHost): EraseGesture {
  let session: EraseSession | null = null;
  let previous: ErasePoint | undefined;

  return {
    get active(): boolean {
      return session !== null;
    },
    begin(strokes, mode, options): void {
      session = createEraseSession(strokes, mode, options);
      previous = undefined;
    },
    through(points, ring = points.at(-1)): void {
      if (session === null) return;
      const dirty: Array<StrokeBounds | null> = [];
      for (const point of points) {
        dirty.push(session.sweep(point.x, point.y, point.radius, previous));
        previous = point;
      }
      const region = unionOfBoxes(dirty);
      if (region !== null) {
        const target = host.repaintTarget();
        if (target === null) host.redraw();
        else repaintRegion(target, region, session.visible(), host.paint);
      }
      if (ring) host.ring()?.showRing(ring.x, ring.y, ring.radius);
    },
    visible(): readonly EraseVisible[] | null {
      return session?.visible() ?? null;
    },
    end(): EraseResult | null {
      const result = session?.result() ?? null;
      session = null;
      previous = undefined;
      host.ring()?.hideRing();
      return result;
    },
  };
}
