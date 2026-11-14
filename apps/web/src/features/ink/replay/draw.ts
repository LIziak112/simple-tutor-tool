/**
 * 回放的 atrament canvas 绘制薄层（T3.3）。
 *
 * 只负责「把 frameAt 的结果画上 canvas」：清屏 → 按可见点数截断每笔 → 复用
 * 引擎层导出的 replayAtramentStrokes（与实时书写/全量重绘同一绘制原语）。
 * 按绘制顺序到达的普通笔段可直接追加；回退或替换旧笔时按矢量重建。
 * 在途的荧光笔（整笔一条路径）不能逐段追加，放在临时层上，收笔后整笔落到
 * 画布（engine/live-layer.ts）。
 *
 * 已有的笔画一律成串交给 replayAtramentStrokes：同一笔被局部橡皮切出来的
 * 荧光笔各段要合在一起上一次色（engine/paint-runs.ts），逐笔画会把它们重叠
 * 的地方叠深。
 */
import {
  beginAtramentStroke,
  createProgrammaticAtrament,
  replayAtramentStrokes,
} from "../engine/atrament-replay.ts";
import { isOnePathStroke } from "../engine/highlighter-paint.ts";
import type { InkStroke } from "../engine/index.ts";
import { createInkLiveLayer, type InkLiveLayer } from "../engine/live-layer.ts";
import { toLogical } from "../engine/normalize.ts";
import { inSamePaintRun } from "../engine/paint-runs.ts";
import { INK_LOGICAL_WIDTH } from "../engine/types.ts";

/** devicePixelRatio 上限 2（与 atrament-adapter 同口径，控制内存） */
const MAX_DPR = 2;

/** 回放画布句柄（组件持有；drawFrame 传入 frameAt 的截断结果） */
export interface AtramentReplayCanvas {
  /** 把「每笔可见点数」画上画布（全量重绘；strokes 与 visiblePoints 一一对应） */
  drawFrame(
    strokes: readonly InkStroke[],
    visiblePoints: readonly number[],
  ): void;
  /** 已完成的笔画前缀，加上至多一笔正在绘制的普通 Atrament 笔迹。 */
  drawOrdered(
    strokes: readonly InkStroke[],
    completed: number,
    active: InkStroke | null,
    points: number,
  ): void;
  /**
   * LR-PR4：墓碑淡色虚线（教师「看擦改」开关）。可选方法——既有 mock/消费方
   * 不实现时组件安全跳过。tombstones 来自 model.deletedSlots；startMs ≤ t <
   * deletedAtMs 的墓碑按已走过点数绘制。
   */
  drawDeleted?(
    tombstones: readonly {
      stroke: InkStroke;
      startMs: number;
      deletedAtMs: number;
      pointTimesMs: number[];
    }[],
    timeMs: number,
  ): void;
  /**
   * 盖在画布上的临时层（与笔画同一坐标域），供拿这块画布书写的一方画
   * 拖动中的图形预览和橡皮圈。可选方法——既有 mock/消费方不实现时就没有
   * 预览。
   */
  previewLayer?(): Pick<
    InkLiveLayer,
    "showOutline" | "clear" | "showRing" | "hideRing"
  >;
  destroy(): void;
}

type OrderedFrame = Parameters<AtramentReplayCanvas["drawOrdered"]>;

function samePrefix(
  previous: readonly InkStroke[],
  next: readonly InkStroke[],
  count: number,
): boolean {
  if (previous === next) return true;
  for (let i = 0; i < count; i++) {
    if (previous[i] !== next[i]) return false;
  }
  return true;
}

/**
 * 接下来要画的那一笔，和画布上已有的最后一笔是不是同一组（同一笔切出来的
 * 荧光笔段）。是的话不能往上追加——同组要合在一起上一次色，得整张重画。
 */
function continuesPaintedRun(
  strokes: readonly InkStroke[],
  painted: number,
  completed: number,
): boolean {
  if (painted <= 0 || painted >= completed) return false;
  const last = strokes[painted - 1];
  const next = strokes[painted];
  return last !== undefined && next !== undefined && inSamePaintRun(last, next);
}

/** 在容器内创建回放画布（canvas 撑满容器；容器负责纵横比/尺寸） */
export function createAtramentReplayCanvas(
  container: HTMLElement,
): AtramentReplayCanvas {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("data-slot", "ink-replay-canvas");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  container.appendChild(canvas);

  let cssWidth = 0;
  let cssHeight = 0;
  let clientWidth = -1;
  let clientHeight = -1;
  let orderedFrame: OrderedFrame | null = null;
  let activePen: ReturnType<typeof beginAtramentStroke> = null;
  /**
   * 在途荧光笔、图形预览的临时层：第一次用到才创建，纯回放页不多出这个元素
   */
  let liveLayer: InkLiveLayer | null = null;
  /** 最近一次 drawFrame 的入参（resize 后原样重画） */
  let lastFrame: {
    strokes: readonly InkStroke[];
    visiblePoints: readonly number[];
  } | null = null;
  /** 最近一次 drawDeleted 的入参（resize 后在 drawFrame 之上重画墓碑） */
  let lastDeleted: {
    tombstones: readonly {
      stroke: InkStroke;
      startMs: number;
      deletedAtMs: number;
      pointTimesMs: number[];
    }[];
    timeMs: number;
  } | null = null;

  function sizeCanvas(): boolean {
    const width = container.clientWidth;
    const height = container.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const pixelsWide = Math.max(1, Math.round((width || 300) * dpr));
    const pixelsHigh = Math.max(1, Math.round((height || 200) * dpr));
    if (
      width === clientWidth &&
      height === clientHeight &&
      canvas.width === pixelsWide &&
      canvas.height === pixelsHigh
    )
      return false;
    clientWidth = width;
    clientHeight = height;
    cssWidth = width || 300;
    cssHeight = height || 200;
    canvas.width = pixelsWide;
    canvas.height = pixelsHigh;
    sizeLiveLayer();
    return true;
  }

  /** 临时层的坐标域与笔画同为逻辑宽 1000 */
  function sizeLiveLayer(): void {
    liveLayer?.setViewBox(INK_LOGICAL_WIDTH, toLogical(cssWidth, cssHeight));
  }

  function ensureLiveLayer(): InkLiveLayer {
    if (liveLayer === null) {
      liveLayer = createInkLiveLayer(container);
      sizeLiveLayer();
    }
    return liveLayer;
  }

  sizeCanvas();
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    throw new Error("无法创建 canvas 2d 上下文（当前环境不支持回放）");
  }
  // 程序化重放实例（构造即配置画笔状态并解绑输入监听，见
  // engine/atrament-replay.createProgrammaticAtrament 的唯一注释段）
  const atrament = createProgrammaticAtrament(canvas);
  // 收窄后的 context 引用（const + 早退后声明箭头函数，类型收窄才能进闭包）
  const ctx2d = ctx;

  function clear(): void {
    // 清屏（transform 安全口径，同 adapter.redraw；随后恢复画笔状态）
    ctx2d.save();
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.restore();
    ctx2d.globalCompositeOperation = "source-over";
    ctx2d.globalAlpha = 1;
    ctx2d.lineCap = "round";
    ctx2d.lineJoin = "round";
  }

  function resetOrdered(): void {
    activePen?.end();
    activePen = null;
    liveLayer?.clear();
    orderedFrame = null;
  }

  const drawOrdered: AtramentReplayCanvas["drawOrdered"] = (
    strokes,
    completed,
    active,
    points,
  ) => {
    const previous = orderedFrame;
    let painted = previous?.[1] ?? 0;
    const previousActive = previous?.[2];
    const promoted =
      previousActive != null &&
      completed > painted &&
      previousActive === strokes[painted];
    const continuing =
      previousActive === active &&
      completed === painted &&
      points >= (previous?.[3] ?? 0);
    if (
      previous === null ||
      completed < painted ||
      !samePrefix(previous[0], strokes, painted) ||
      (previousActive != null && !promoted && !continuing) ||
      continuesPaintedRun(strokes, painted, completed)
    ) {
      resetOrdered();
      clear();
      painted = 0;
    } else if (promoted && !isOnePathStroke(previousActive)) {
      activePen?.appendThrough(previousActive.points.length);
      activePen?.end();
      activePen = null;
      painted++;
    }
    // 刚收笔的荧光笔书写中不在画布上：和其余已完成笔画一样在这里整笔画出
    if (painted < completed) {
      replayAtramentStrokes(
        atrament,
        cssWidth,
        strokes.slice(painted, completed),
      );
    }
    if (active !== null && isOnePathStroke(active)) {
      ensureLiveLayer().showStroke(active, points);
    } else {
      liveLayer?.clear();
      if (active !== null) {
        activePen ??= beginAtramentStroke(atrament, cssWidth, active);
        activePen?.appendThrough(points);
      }
    }
    lastFrame = null;
    lastDeleted = null;
    orderedFrame = [strokes, completed, active, points];
  };

  const drawFrame = (
    strokes: readonly InkStroke[],
    visiblePoints: readonly number[],
  ): void => {
    resetOrdered();
    lastFrame = { strokes, visiblePoints };
    lastDeleted = null;
    clear();
    const shown: InkStroke[] = [];
    for (let i = 0; i < strokes.length; i++) {
      const stroke = strokes[i];
      const visible = visiblePoints[i];
      if (!stroke || !visible || visible <= 0) continue;
      // 截断到当前时刻已走过的点（slice 产生短数组，原笔画不可变）
      shown.push({ ...stroke, points: stroke.points.slice(0, visible) });
    }
    replayAtramentStrokes(atrament, cssWidth, shown);
  };

  // LR-PR4：墓碑淡色虚线（教师「看擦改」）。startMs ≤ t < deletedAtMs 可见，
  // 点数按 pointTimesMs 截断到当前时刻；样式在 save/restore 内局部生效。
  // 注意：freehand 渲染器（学生设置可选）走多边形填充，setLineDash 不生效、
  // 只剩 alpha 淡化——虚线承诺仅对 atrament 主路径成立
  const drawDeleted = (
    tombstones: readonly {
      stroke: InkStroke;
      startMs: number;
      deletedAtMs: number;
      pointTimesMs: number[];
    }[],
    timeMs: number,
  ): void => {
    lastDeleted = { tombstones, timeMs };
    ctx2d.save();
    ctx2d.globalCompositeOperation = "source-over";
    ctx2d.setLineDash([6, 6]);
    ctx2d.globalAlpha = 0.35;
    ctx2d.lineCap = "round";
    ctx2d.lineJoin = "round";
    const shown: InkStroke[] = [];
    for (const tomb of tombstones) {
      if (timeMs < tomb.startMs || timeMs >= tomb.deletedAtMs) continue;
      let visible = 0;
      for (const t of tomb.pointTimesMs) {
        if (t <= timeMs - tomb.startMs) visible += 1;
        else break;
      }
      if (visible <= 0) continue;
      shown.push({
        ...tomb.stroke,
        points: tomb.stroke.points.slice(0, visible),
      });
    }
    replayAtramentStrokes(atrament, cssWidth, shown);
    ctx2d.restore();
  };

  // 尺寸变化（iPad 旋转、窗口缩放）：重设位图并重画当前帧（归一化坐标保证比例正确）。
  // 评审 #11771 必改②：先取 lastDeleted 再 drawFrame——drawFrame 会清它，
  // 顺序颠倒会让 resize 后墓碑消失到下一次播放头变化。
  const observer = new ResizeObserver(() => {
    if (!sizeCanvas()) return;
    if (orderedFrame !== null) {
      const frame = orderedFrame;
      resetOrdered();
      drawOrdered(...frame);
      return;
    }
    const deleted = lastDeleted;
    if (lastFrame) drawFrame(lastFrame.strokes, lastFrame.visiblePoints);
    if (deleted) drawDeleted(deleted.tombstones, deleted.timeMs);
  });
  observer.observe(container);

  return {
    drawFrame,
    drawOrdered,
    drawDeleted,
    previewLayer: ensureLiveLayer,
    destroy(): void {
      observer.disconnect();
      resetOrdered();
      liveLayer?.destroy();
      liveLayer = null;
      atrament.destroy();
      canvas.remove();
    },
  };
}
