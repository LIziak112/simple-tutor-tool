/**
 * 笔迹回放组件（T3.3，D12）：把 parseInkReplayData 收窄出的模型按时间轴重演。
 *
 * 分层（jsdom 无法测真实 canvas，故逻辑纯函数化 + 绘制薄层可替换）：
 * - 画面 = frameAt(data, tMs)（model.ts 纯函数，本组件只负责照着画）；
 * - 调度 = requestAnimationFrame 驱动 advancePlayhead（倍速只影响这里）；
 * - atrament 绘制 = draw.ts 复用引擎层 replayAtramentStroke；
 * - excalidraw 绘制 = ExcalidrawReplay 复用库的 restore + updateScene。
 *
 * 控制条：播放/暂停、进度条拖动（跳转=重绘到该时刻的累积状态）、1×/2×/4×
 * 倍速、当前时刻/总时长；触控目标均 ≥44px（ui-conventions）。
 */

import { cn } from "cn";
import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type AtramentReplayCanvas,
  createAtramentReplayCanvas,
} from "./draw.ts";
import { ExcalidrawReplay } from "./ExcalidrawReplay.tsx";
import {
  advancePlayhead,
  formatReplayTime,
  frameAt,
  type InkReplayModel,
  REPLAY_SPEEDS,
  type ReplaySpeed,
} from "./model.ts";

/**
 * @param data parseInkReplayData 的产物（null 时调用方走「无回放数据」降级，不进本组件）
 * @param layout embed=卡片内嵌（atrament 按内容纵横比、excalidraw 固定高度）；
 *   fill=放大层填充（占满可用区域）
 */
export function InkReplay({
  data,
  className,
  layout = "embed",
}: {
  data: InkReplayModel;
  className?: string;
  layout?: "embed" | "fill";
}) {
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  /** 时间轴刻度的镜像（rAF 循环闭包里读最新值，避免过期闭包） */
  const timeRef = useRef(0);
  /** atrament 画布句柄（excalidraw 分支为 null） */
  const canvasRef = useRef<AtramentReplayCanvas | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  const durationMs = data.durationMs;
  const empty = durationMs <= 0;

  // 换数据重置回起点（渲染期状态调整模式：数据引用变化即重置，含暂停——
  // 不用 useEffect 是为避免「新一帧先按旧时刻画一次」的中间态）
  const [dataKey, setDataKey] = useState(data);
  if (dataKey !== data) {
    setDataKey(data);
    timeRef.current = 0;
    setTimeMs(0);
    setPlaying(false);
  }

  // 播放循环：rAF 驱动，倍速只作用于「真实流逝时长 × speed」这一步
  useEffect(() => {
    if (!playing || empty) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const next = advancePlayhead(
        timeRef.current,
        now - last,
        speed,
        durationMs,
      );
      last = now;
      timeRef.current = next.timeMs;
      setTimeMs(next.timeMs);
      if (next.ended) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, durationMs, empty]);

  // 画面状态（纯函数产物；组件不自己计算截断逻辑）
  const frame = useMemo(() => frameAt(data, timeMs), [data, timeMs]);

  // atrament 画布：挂载时创建一次（数据换新则重建），每帧全量重绘（见 draw.ts 头注释）
  useEffect(() => {
    if (data.engine !== "atrament") return;
    const host = hostRef.current;
    if (!host) return;
    const handle = createAtramentReplayCanvas(host);
    canvasRef.current = handle;
    return () => {
      handle.destroy();
      canvasRef.current = null;
    };
  }, [data]);

  useEffect(() => {
    if (data.engine !== "atrament") return;
    canvasRef.current?.drawFrame(
      data.strokes,
      frame.engine === "atrament" ? frame.visiblePoints : [],
    );
  }, [data, frame]);

  function seek(next: number): void {
    const clamped = Math.min(Math.max(next, 0), durationMs);
    timeRef.current = clamped;
    setTimeMs(clamped);
  }

  function togglePlay(): void {
    if (empty) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    // 播放到底后再按播放 → 从头重演
    if (timeRef.current >= durationMs) seek(0);
    setPlaying(true);
  }

  // atrament 画布纵横比（内容 maxY 近似，见 model.ts contentHeight）
  const aspectStyle =
    data.engine === "atrament"
      ? { aspectRatio: `1000 / ${data.contentHeight}` }
      : undefined;

  return (
    <fieldset
      data-slot="ink-replay"
      aria-label="笔迹回放"
      className={cn(
        "m-0 flex min-w-0 flex-col gap-2 border-0 p-0",
        layout === "fill" && "h-full min-h-0",
        className,
      )}
    >
      {/* 画面区 */}
      {data.engine === "atrament" ? (
        layout === "fill" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <div
              className="relative mx-auto h-full w-auto max-w-full overflow-hidden rounded-lg border border-border bg-white"
              style={aspectStyle}
            >
              <div ref={hostRef} className="absolute inset-0" />
              {empty && <EmptyNote />}
            </div>
          </div>
        ) : (
          <div
            className="relative w-full overflow-hidden rounded-lg border border-border bg-white"
            style={aspectStyle}
          >
            <div ref={hostRef} className="absolute inset-0" />
            {empty && <EmptyNote />}
          </div>
        )
      ) : (
        <div className="min-h-0 flex-1">
          <ExcalidrawReplay
            elements={data.elements}
            visibleElements={
              frame.engine === "excalidraw" ? frame.visibleElements : 0
            }
            {...(layout === "embed"
              ? { className: "h-80 w-full sm:h-96" }
              : {})}
          />
        </div>
      )}

      {/* 控制条（触控目标 ≥44px） */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11 min-w-15 px-3"
          disabled={empty}
          onClick={togglePlay}
        >
          {playing ? (
            <Pause aria-hidden className="size-4" />
          ) : (
            <Play aria-hidden className="size-4" />
          )}
          {playing ? "暂停" : "播放"}
        </Button>
        <input
          type="range"
          aria-label="回放进度"
          min={0}
          max={durationMs}
          step={50}
          value={timeMs}
          disabled={empty}
          onChange={(e) => seek(Number(e.currentTarget.value))}
          className="h-11 min-w-40 flex-1 accent-primary"
        />
        <fieldset
          aria-label="倍速"
          className="m-0 flex items-center gap-1 border-0 p-0"
        >
          {REPLAY_SPEEDS.map((option) => (
            <Button
              key={option}
              type="button"
              variant={speed === option ? "secondary" : "outline"}
              aria-pressed={speed === option}
              className="min-h-11 px-3"
              disabled={empty}
              onClick={() => setSpeed(option)}
            >
              {option}×
            </Button>
          ))}
        </fieldset>
        <p className="flex min-h-11 items-center px-1 text-sm tabular-nums text-muted-foreground">
          {formatReplayTime(timeMs)} / {formatReplayTime(durationMs)}
        </p>
      </div>
    </fieldset>
  );
}

/** 空数据时的画面占位（有效文档但无笔画，如「有笔迹记录但无笔画」） */
function EmptyNote() {
  return (
    <p className="absolute inset-0 flex items-center justify-center px-3 text-center text-sm text-muted-foreground">
      无笔画可回放
    </p>
  );
}
