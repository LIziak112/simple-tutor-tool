/**
 * 材料圈画的橡皮：命中，以及擦掉的什么时候存进草稿仓。
 *
 * 材料圈画没有撤销：一次手势里每个落点各算各的，画面立即跟上；存进草稿仓
 * 等这一次手势结束、只存一次——草稿仓一变，整个作答页跟着重渲染，局部橡皮
 * 几乎每个落点都有改动，逐点存会卡。擦空了的话，材料的冻结基准也到那时才清
 * （宿主的 save 负责）：手势途中不换排版。
 *
 * 两种情况下这一次擦掉的不算数（往「笔迹还在」的方向失败）：
 * - 组件在手势途中被卸载：不补存，和在途的一笔一样；
 * - 草稿仓在手势期间被别处改过（同一份材料的另一个实例写了一笔）：这边手里
 *   是落笔时的旧稿，存回去会盖掉别处的改动——不存，改为跟上草稿仓。按稿的
 *   变更时间判断，不比数组对象：草稿仓落盘后会把内存里的稿换成克隆件，内容
 *   没变对象也不同。
 */
import type { InkDoc, InkStroke } from "@tutor/contract";
import { useRef, useState } from "react";
import { createEraseSession } from "@/features/ink/engine/erase-session.ts";
import type { InkGesture } from "@/features/ink/engine/types.ts";

type EraseGesture = Extract<InkGesture, { kind: "erase" }>;
type Point = { x: number; y: number };

export interface MaterialEraseHost {
  /** 画面上现在的笔画 */
  strokes(): InkStroke[];
  /** 换成新的笔画，画面跟上 */
  show(next: InkStroke[]): void;
  /** 草稿仓里这份材料现在的稿；没有是 null */
  stored(): Extract<InkDoc, { engine: "atrament" }> | null;
  /** 把笔画存进草稿仓 */
  save(strokes: InkStroke[]): void;
  /** 橡皮圈跟到这个落点（坐标、半径都是 1000 宽坐标域里的逻辑单位） */
  ring(x: number, y: number, radius: number): void;
}

export interface MaterialErase {
  /** 一次橡皮手势开始（落笔）：记下草稿仓此刻的稿，擦第一个落点 */
  begin(point: Point, eraser: EraseGesture): void;
  /**
   * 橡皮划到下一个落点：从上一个落点扫到这里，碰到的笔画整笔拿掉（整笔
   * 模式）或只切掉碰到的一段（局部模式）
   */
  sweep(point: Point, eraser: EraseGesture): void;
  /** 手势结束（抬起、被打断、应用更新前）：这一次擦掉的存一次 */
  end(): void;
}

export function useMaterialErase(host: MaterialEraseHost): MaterialErase {
  const hostRef = useRef(host);
  hostRef.current = host;
  const [erase] = useState((): MaterialErase => {
    /** 上一个落点 */
    let last: Point | null = null;
    /** 这一次手势擦掉了东西、还没存 */
    let dirty = false;
    /** 落笔时草稿仓里这份稿的变更时间（没有稿是 null） */
    let baseStamp: number | null = null;
    const sweep = (point: Point, eraser: EraseGesture): void => {
      const current = hostRef.current;
      current.ring(point.x, point.y, eraser.radius);
      const session = createEraseSession(current.strokes(), eraser.mode);
      const changed = session.sweep(
        point.x,
        point.y,
        eraser.radius,
        last ?? undefined,
      );
      last = point;
      if (changed === null) return;
      current.show(session.visible().map((item) => item.stroke));
      dirty = true;
    };
    return {
      begin(point, eraser): void {
        last = null;
        baseStamp = hostRef.current.stored()?.updatedAt ?? null;
        sweep(point, eraser);
      },
      sweep,
      end(): void {
        last = null;
        if (!dirty) return;
        dirty = false;
        const current = hostRef.current;
        const latest = current.stored();
        if ((latest?.updatedAt ?? null) !== baseStamp) {
          current.show(latest?.data.strokes ?? []);
          return;
        }
        current.save(current.strokes());
      },
    };
  });
  return erase;
}
