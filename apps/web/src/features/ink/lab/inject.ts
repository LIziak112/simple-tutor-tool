import type { InkEngine } from "../engine/index.ts";
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
}

/**
 * 驱动一组合成笔画进入引擎。
 *
 * 测量语义约定：
 * - 每笔重取 canvas.getBoundingClientRect()——进度行渲染/布局变化会推移画布
 *   位置，用陈旧 rect 会把 clientY 系统性偏移；测量必须贴真实布局（与真实
 *   输入受布局影响是同一件事）；
 * - 坐标换算以 INK_LOGICAL_WIDTH 为基准（y 同以宽度为基准，与适配器一致）；
 * - setTool 仅在笔画工具配置变化时下发（含一次 touchAction 写，省掉冗余调用）。
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

  /** 上一次下发的工具配置键（color/weight/tool 全等的字符串指纹） */
  let lastToolKey = "";
  for (let s = 0; s < strokes.length; s++) {
    const stroke = strokes[s];
    if (stroke === undefined) continue;
    const tool = toolConfigFromStroke(stroke);
    const toolKey =
      tool.type === "pen" ? `pen|${stroke.color}|${stroke.weight}` : tool.type;
    if (toolKey !== lastToolKey) {
      engine.setTool(tool);
      lastToolKey = toolKey;
    }
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / INK_LOGICAL_WIDTH;
    const toClient = (p: {
      x: number;
      y: number;
    }): {
      clientX: number;
      clientY: number;
    } => ({
      clientX: rect.left + p.x * scale,
      clientY: rect.top + p.y * scale,
    });
    const dispatch = (
      phase: "pointerdown" | "pointermove" | "pointerup",
      p: { x: number; y: number; p: number },
      isUp: boolean,
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
        buttons: isUp ? 0 : 1,
        pressure: p.p,
        clientX,
        clientY,
      });
      sampler.measure(() => canvas.dispatchEvent(evt));
    };
    for (let i = 0; i < stroke.points.length; i++) {
      const p = stroke.points[i];
      if (!p) continue;
      dispatch(i === 0 ? "pointerdown" : "pointermove", p, false);
    }
    const last = stroke.points[stroke.points.length - 1];
    if (last) dispatch("pointerup", last, true);

    if (s === 0 || (s + 1) % progressEvery === 0 || s === strokes.length - 1) {
      opts.onProgress?.(s + 1, strokes.length);
      await opts.yieldFrame?.();
    }
  }
  return { down, move, up };
}
