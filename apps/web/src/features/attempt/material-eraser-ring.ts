/**
 * 材料圈画的橡皮圈：橡皮悬停和擦除时跟着指针的圆圈，大小就是命中范围（和
 * 草稿纸、题面圈画是同一个）。画在画布上面的临时层里。
 *
 * - 悬停：笔和鼠标没按下时跟着指针走（手指没有悬停）。位置按当时量到的矩形
 *   算——没在写的时候页面可以滚动，不能用上一笔记下的矩形。
 * - 擦除：每个落点由材料圈画调 show；抬笔、这一笔作废时调 hide。
 * - 当前工具不是橡皮、或已退出圈画：收起，悬停也不再出圈。
 * - 没显示过就不去碰临时层：只用笔的时候不必创建它。
 */
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import type { InkLiveLayer } from "@/features/ink/engine/live-layer.ts";
import { toLogicalPoint } from "@/features/ink/engine/normalize.ts";

type RingLayer = Pick<InkLiveLayer, "showRing" | "hideRing">;

export interface MaterialEraserRing {
  /** 橡皮圈显示在这个位置（坐标、半径都是 1000 宽坐标域里的逻辑单位） */
  show(x: number, y: number, radius: number): void;
  hide(): void;
  /** 指针在材料上移动、此刻没有在写：当前是橡皮就让橡皮圈跟过去 */
  hover(e: ReactPointerEvent<HTMLElement>): void;
}

/**
 * @param layer 橡皮圈所在的临时层；画布还没建好时返回 null
 * @param radius 圈画中且当前工具是橡皮时给出命中半径，否则给 null
 */
export function useMaterialEraserRing(
  layer: () => RingLayer | null,
  radius: number | null,
): MaterialEraserRing {
  const layerRef = useRef(layer);
  layerRef.current = layer;
  const radiusRef = useRef(radius);
  radiusRef.current = radius;
  const [ring] = useState((): MaterialEraserRing => {
    let shown = false;
    const show = (x: number, y: number, r: number): void => {
      const target = layerRef.current();
      if (!target) return;
      target.showRing(x, y, r);
      shown = true;
    };
    return {
      show,
      hide(): void {
        if (!shown) return;
        shown = false;
        layerRef.current()?.hideRing();
      },
      hover(e): void {
        const r = radiusRef.current;
        if (r === null || e.buttons !== 0 || e.pointerType === "touch") return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (!(rect.width > 0)) return;
        const at = toLogicalPoint(
          rect.width,
          e.clientX - rect.left,
          e.clientY - rect.top,
        );
        show(at.x, at.y, r);
      },
    };
  });
  const erasing = radius !== null;
  useEffect(() => {
    if (!erasing) ring.hide();
  }, [erasing, ring]);
  return ring;
}
