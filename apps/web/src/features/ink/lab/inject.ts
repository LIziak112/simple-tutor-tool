import type { InkEngine } from "../engine/index.ts";
import { fromLogicalPoint } from "../engine/normalize.ts";
import {
  INK_LOGICAL_WIDTH,
  type InkStroke,
  toolConfigFromStroke,
} from "../engine/types.ts";
import { createDurationSampler, type DurationSampler } from "./measure.ts";

/**
 * 合成输入驱动器（T6R.1 从面板下沉的通用实验原语）：
 * 在真实画布上逐笔派发 pointerdown/move/up（pointerType=pen、带压感），
 * dispatchEvent 同步执行适配器的真实输入热路径——"事件处理 p50/p95"即真实
 * 输入路径耗时。T6R.8 队列实验复用时不再复制本段。
 *
 * 已知限制：合成 PointerEvent 的 getCoalescedEvents() 为空 → 走单点回退
 * 路径；合并采样批次的真实耗时只能真机测。
 */

export interface InjectionOptions {
  /** 进度回调（节流到每 progressEvery 笔一次；首笔与末笔必报） */
  onProgress?: (done: number, total: number) => void;
  /** 进度节流粒度（默认 25 笔；每笔都报会把深层 setTimeout clamp 到 4ms/笔） */
  progressEvery?: number;
  /** 报进度前让出主线程一拍（刷新 UI；让出不在计时区间内） */
  yieldFrame?: () => Promise<void>;
}

export interface InjectionResult {
  /** 落笔（pointerdown）耗时采样 */
  down: DurationSampler;
  /** 移动（pointermove）耗时采样 */
  move: DurationSampler;
  /** 收笔（pointerup）耗时采样 */
  up: DurationSampler;
  /**
   * 被画布边界校验静默丢弃的笔画数（整笔的 CSS 坐标全部落在画布外）。
   * 适配器对越界 pointerdown 直接拒绝（move/up 因无活动指针全部无效）——
   * 本计数把这些"注定丢弃"的笔画显式化并跳过派发，避免测量数据无告警失真。
   */
  droppedStrokes: number;
}

/**
 * 驱动一组合成笔画进入引擎。
 *
 * 测量语义约定：
 * - 每笔重取 canvas.getBoundingClientRect()——进度行渲染/布局变化会推移画布
 *   位置，用陈旧 rect 会把 clientY 系统性偏移；测量必须贴真实布局（与真实
 *   输入受布局影响是同一件事）；
 * - 坐标换算用引擎 normalize 层的 fromLogicalPoint（与真实记录路径
 *   toLogicalPoint 同源，y 同以宽度为基准）；
 * - **画布尺寸约束**：逻辑纸高 × (画布 CSS 宽 / 1000) 不得超过画布 CSS 高，
 *   否则纸底笔画会整笔越界被丢（计入 droppedStrokes 并在报告可见）；
 * - setTool 在工具配置变化时下发，且每个进度节流边界重设一次——注入期间
 *   InkPad 工具栏仍可交互（其禁用条件不含 busy），用户点击会改引擎工具，
 *   批边界重设让失配至多存活 progressEvery 笔而非整场。
 */
export async function drivePointerEvents(
  engine: InkEngine,
  canvas: HTMLCanvasElement,
  strokes: readonly InkStroke[],
  opts: InjectionOptions = {},
): Promise<InjectionResult> {
  const progressEvery = Math.max(1, opts.progressEvery ?? 25);
  const down = createDurationSampler();
  const move = createDurationSampler();
  const up = createDurationSampler();
  let droppedStrokes = 0;

  /** 上一次下发的工具配置键（color/weight/tool 全等的字符串指纹） */
  let lastToolKey = "";
  for (let s = 0; s < strokes.length; s++) {
    const stroke = strokes[s];
    if (stroke === undefined) continue;
    const reportable =
      s === 0 || (s + 1) % progressEvery === 0 || s === strokes.length - 1;
    const tool = toolConfigFromStroke(stroke);
    const toolKey =
      tool.type === "pen" ? `pen|${stroke.color}|${stroke.weight}` : tool.type;
    if (toolKey !== lastToolKey || reportable) {
      engine.setTool(tool);
      lastToolKey = toolKey;
    }
    const rect = canvas.getBoundingClientRect();
    const toClient = (p: {
      x: number;
      y: number;
    }): {
      clientX: number;
      clientY: number;
    } => {
      const css = fromLogicalPoint(rect.width, p.x, p.y);
      return { clientX: rect.left + css.x, clientY: rect.top + css.y };
    };
    // 整笔越界检测：全部点都落在画布外 → 适配器必拒，跳过派发并计数
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const p of stroke.points) {
      const x = (p.x * rect.width) / INK_LOGICAL_WIDTH;
      const y = (p.y * rect.width) / INK_LOGICAL_WIDTH;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const fullyOutside =
      stroke.points.length > 0 &&
      (maxX < 0 || minX > rect.width || maxY < 0 || minY > rect.height);
    if (fullyOutside) {
      droppedStrokes++;
      if (reportable) {
        opts.onProgress?.(s + 1, strokes.length);
        await opts.yieldFrame?.();
      }
      continue;
    }
    const dispatch = (
      phase: "pointerdown" | "pointermove" | "pointerup",
      p: { x: number; y: number; p: number },
    ): void => {
      const { clientX, clientY } = toClient(p);
      const sampler =
        phase === "pointerdown" ? down : phase === "pointerup" ? up : move;
      const evt = new PointerEvent(phase, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 1,
        pointerType: "pen", // 模拟 Apple Pencil（pressure 走真实压感值）
        isPrimary: true,
        buttons: phase === "pointerup" ? 0 : 1,
        pressure: p.p,
        clientX,
        clientY,
      });
      sampler.measure(() => canvas.dispatchEvent(evt));
    };
    for (let i = 0; i < stroke.points.length; i++) {
      const p = stroke.points[i];
      if (!p) continue;
      dispatch(i === 0 ? "pointerdown" : "pointermove", p);
    }
    const last = stroke.points[stroke.points.length - 1];
    if (last) dispatch("pointerup", last);

    if (reportable) {
      opts.onProgress?.(s + 1, strokes.length);
      await opts.yieldFrame?.();
    }
  }
  return { down, move, up, droppedStrokes };
}
