import type { InkDoc } from "@tutor/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  type AtramentSurface,
  createAtramentSurface,
} from "@/features/ink/engine/atrament-adapter";
import type { ToolAwareSurface } from "@/features/ink/engine/surface";
import type {
  InkInputMode,
  InkPenColor,
  InkPenSize,
  InkToolType,
} from "@/features/ink/engine/types";
import {
  type FeelDraft,
  type FeelLane,
  readFeelDraft,
  writeFeelDraft,
} from "@/features/ink/lab/feel-storage";
import {
  createFeelSurface,
  DEFAULT_FEEL_PARAMS,
  FEEL_PRESETS,
  type FeelParams,
  type FeelStats,
  type FeelSurface,
} from "@/features/ink/lab/feel-surface";
import { PaperPresentation } from "@/features/ink/PaperPresentation";

const LANES: Array<{ id: FeelLane; title: string; description: string }> = [
  {
    id: "baseline",
    title: "当前手写",
    description: "Atrament 默认平滑，作为当前项目的对照。",
  },
  {
    id: "responsive",
    title: "低平滑手写",
    description: "沿用 Atrament，降低平滑强度，比较小字与转折。",
  },
  {
    id: "freehand",
    title: "自然手写",
    description: "perfect-freehand 压感轮廓，支持临时预测与三种笔感。",
  },
];
const SLIDERS: Array<{
  key: "thinning" | "smoothing" | "streamline" | "sizeScale";
  label: string;
  min: number;
  max: number;
}> = [
  { key: "thinning", label: "压感变宽", min: 0, max: 1 },
  { key: "smoothing", label: "边缘平滑", min: 0, max: 1 },
  { key: "streamline", label: "轨迹平滑", min: 0, max: 1 },
  { key: "sizeScale", label: "笔宽倍率", min: 0.5, max: 2 },
];
const selectClass =
  "min-h-11 rounded-md border border-input bg-background px-3 text-sm";

export default function InkFeelPage() {
  const [lane, setLane] = useState<FeelLane>("baseline");
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="space-y-2">
        <Link
          to="/dev/ink"
          className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4"
        >
          返回手写开发页
        </Link>
        <h1 className="text-2xl font-semibold">手写手感实验室</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          用同一支笔、同一组字比较跟手度与小字清晰度。每组实验稿单独保存在本机，可刷新恢复。
        </p>
        <p className="text-sm leading-6 text-muted-foreground">
          试写：永、三、月；x²、分数、根号、小数点；快速波浪线与轻重压感。先比较原始笔感，再打开预测。
        </p>
      </header>
      <fieldset aria-label="书写对照组" className="grid gap-2 sm:grid-cols-3">
        {LANES.map((item) => (
          <Button
            key={item.id}
            className="h-auto min-h-16 justify-start whitespace-normal text-left"
            variant={lane === item.id ? "default" : "outline"}
            aria-pressed={lane === item.id}
            onClick={() => setLane(item.id)}
          >
            <span>
              <span className="block font-medium">{item.title}</span>
              <span className="mt-1 block text-xs font-normal">
                {item.description}
              </span>
            </span>
          </Button>
        ))}
      </fieldset>
      <FeelBoard key={lane} lane={lane} />
      <p className="text-xs leading-6 text-muted-foreground">
        采样与预测以实际事件为准，不承诺固定采样率。iPad
        的合并采样和预测依赖浏览器能力，建议通过 HTTPS 访问；电脑 localhost
        也可测试。此页不连接正式作答接口。
      </p>
    </main>
  );
}

function FeelBoard({ lane }: { lane: FeelLane }) {
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<ToolAwareSurface | null>(null);
  const freehand = useRef<FeelSurface | null>(null);
  const responsive = useRef<AtramentSurface | null>(null);
  const [params, setParams] = useState<FeelParams>(DEFAULT_FEEL_PARAMS);
  const [smoothing, setSmoothing] = useState(0.3);
  const [input, setInput] = useState<InkInputMode>("pen");
  const [tool, setTool] = useState<InkToolType>("pen");
  const [color, setColor] = useState<InkPenColor>("black");
  const [size, setSize] = useState<InkPenSize>("medium");
  const [doc, setDoc] = useState<InkDoc | null>(null);
  const [stats, setStats] = useState<FeelStats | null>(null);
  const [status, setStatus] = useState("尚未书写");
  const [error, setError] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const draftRef = useRef<Omit<FeelDraft, "doc">>({
    params: DEFAULT_FEEL_PARAMS,
    smoothing: 0.3,
  });
  const save = useCallback(
    (snapshot: InkDoc) => {
      setDoc(snapshot);
      setCanUndo(surface.current?.canUndo() ?? false);
      setCanRedo(surface.current?.canRedo() ?? false);
      try {
        if (snapshot.engine !== "atrament") throw new Error("实验稿形态不正确");
        writeFeelDraft(lane, { doc: snapshot, ...draftRef.current });
        setStatus("已存本机");
        setError(null);
      } catch {
        setStatus("本机保存失败");
        setError("浏览器未能保存实验稿，请先导出图片；当前页面内的笔迹仍在。");
      }
    },
    [lane],
  );
  useEffect(() => {
    if (!host.current) return;
    let stored: FeelDraft | null = null;
    try {
      stored = readFeelDraft(lane);
    } catch {
      setError("上次实验稿无法读取；开始新稿前可在其他浏览器继续测试。");
    }
    const draft = stored ?? { params: DEFAULT_FEEL_PARAMS, smoothing: 0.3 };
    draftRef.current = { params: draft.params, smoothing: draft.smoothing };
    setParams(draft.params);
    setSmoothing(draft.smoothing);
    const active =
      lane === "freehand"
        ? createFeelSurface(draft.params)
        : createAtramentSurface({
            inputMode: "pen",
            ...(lane === "responsive" ? { smoothing: draft.smoothing } : {}),
          });
    surface.current = active;
    freehand.current = lane === "freehand" ? (active as FeelSurface) : null;
    responsive.current =
      lane === "responsive" ? (active as AtramentSurface) : null;
    active.mount(host.current, stored?.doc);
    setDoc(active.getDoc());
    setCanUndo(active.canUndo());
    setCanRedo(active.canRedo());
    if (stored) setStatus("已恢复本机实验稿");
    const off = active.onChange(save);
    const timer = setInterval(() => {
      if (freehand.current) setStats(freehand.current.getStats());
    }, 400);
    const stop = () => active.finish?.();
    window.addEventListener("pagehide", stop);
    return () => {
      active.finish?.();
      off();
      clearInterval(timer);
      window.removeEventListener("pagehide", stop);
      active.destroy();
      surface.current = null;
      freehand.current = null;
      responsive.current = null;
    };
  }, [lane, save]);
  const updateParams = (next: FeelParams) => {
    freehand.current?.setParams(next);
    draftRef.current.params = next;
    setParams(next);
    if (surface.current) save(surface.current.getDoc());
  };
  const updateSmoothing = (next: number) => {
    responsive.current?.setSmoothing(next);
    draftRef.current.smoothing = next;
    setSmoothing(next);
    if (surface.current) save(surface.current.getDoc());
  };
  const applyTool = (next: InkToolType, nextColor = color, nextSize = size) => {
    surface.current?.setTool(
      next === "pen"
        ? { type: "pen", color: nextColor, size: nextSize }
        : { type: next },
    );
    setTool(next);
    setColor(nextColor);
    setSize(nextSize);
  };
  const close = () => {
    surface.current?.finish?.();
    setFullscreen(false);
  };
  const exportImage = async () => {
    try {
      const blob = await surface.current?.exportPng();
      if (!blob) throw new Error("画布尚未就绪");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `OwnClass-手写实验-${lane}.png`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setError(null);
    } catch {
      setError("图片导出失败，请保持页面打开后重试。");
    }
  };
  const strokes = doc?.engine === "atrament" ? doc.data.strokes : [];
  const count = strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
  return (
    <section aria-label="书写测试台" className="space-y-4">
      <PaperPresentation
        fullscreen={fullscreen}
        label="全屏手写实验"
        heading="手写手感实验"
        context={
          <p className="text-sm">永、三、月 · x² · 分数与根号 · 快速连笔</p>
        }
        onClose={close}
      >
        <div className="space-y-3">
          <div
            role="toolbar"
            aria-label="实验手写工具"
            className="flex flex-wrap items-center gap-2"
          >
            {(["pen", "eraser", "highlighter"] as const).map((value, index) => (
              <Button
                key={value}
                className="h-11"
                variant={tool === value ? "default" : "outline"}
                aria-pressed={tool === value}
                onClick={() => applyTool(value)}
              >
                {["笔", "整笔橡皮", "荧光笔"][index]}
              </Button>
            ))}
            <select
              className={selectClass}
              aria-label="笔颜色"
              value={color}
              onChange={(event) =>
                applyTool("pen", event.target.value as InkPenColor)
              }
            >
              <option value="black">黑色</option>
              <option value="blue">蓝色</option>
              <option value="red">红色</option>
            </select>
            <select
              className={selectClass}
              aria-label="笔粗细"
              value={size}
              onChange={(event) =>
                applyTool("pen", color, event.target.value as InkPenSize)
              }
            >
              <option value="thin">细笔</option>
              <option value="medium">中笔</option>
              <option value="thick">粗笔</option>
            </select>
            <Button
              variant="outline"
              className="h-11"
              disabled={!canUndo}
              onClick={() => surface.current?.undo()}
            >
              撤销
            </Button>
            <Button
              variant="outline"
              className="h-11"
              disabled={!canRedo}
              onClick={() => surface.current?.redo()}
            >
              重做
            </Button>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => surface.current?.clear()}
            >
              清空（可撤销）
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="书写方式"
              className={selectClass}
              value={input}
              onChange={(event) => {
                const next = event.target.value as InkInputMode;
                surface.current?.setInputMode?.(next);
                setInput(next);
              }}
            >
              <option value="pen">笔写／手指滚动</option>
              <option value="finger">手指也可书写</option>
              <option value="auto">自动识别触控笔</option>
            </select>
            {!fullscreen && (
              <Button
                variant="outline"
                className="h-11"
                onClick={() => {
                  surface.current?.finish?.();
                  setFullscreen(true);
                }}
              >
                全屏书写
              </Button>
            )}
            <Button
              variant="outline"
              className="h-11"
              onClick={() => void exportImage()}
            >
              导出 PNG
            </Button>
          </div>
          <div
            ref={host}
            data-testid="feel-paper"
            className="relative h-[420px] w-full overflow-hidden rounded-lg border border-border bg-white"
            style={{ touchAction: "pan-y" }}
          />
          <div
            role="status"
            aria-label="实验稿状态"
            className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
          >
            <span>笔画：{strokes.length}</span>
            <span>总点数：{count}</span>
            <span>{status}</span>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {lane === "responsive" && (
            <label className="flex flex-wrap items-center gap-3 text-sm">
              Atrament 平滑强度 <output>{smoothing.toFixed(2)}</output>
              <input
                className="min-h-11 flex-1 accent-primary"
                type="range"
                min="0"
                max="1.5"
                step="0.05"
                value={smoothing}
                onChange={(event) =>
                  updateSmoothing(Number(event.target.value))
                }
              />
            </label>
          )}
          {lane === "freehand" && (
            <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex flex-wrap gap-2">
                {FEEL_PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    variant="outline"
                    className="h-11"
                    onClick={() => updateParams({ ...preset.params })}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {SLIDERS.map((slider) => (
                  <label key={slider.key} className="text-sm">
                    {slider.label}{" "}
                    <output>{params[slider.key].toFixed(2)}</output>
                    <input
                      className="block min-h-11 w-full accent-primary"
                      type="range"
                      min={slider.min}
                      max={slider.max}
                      step="0.05"
                      value={params[slider.key]}
                      onChange={(event) =>
                        updateParams({
                          ...params,
                          [slider.key]: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap gap-x-6">
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={params.prediction}
                    onChange={(event) =>
                      updateParams({
                        ...params,
                        prediction: event.target.checked,
                      })
                    }
                  />
                  临时预测笔迹
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={params.simulatePressure}
                    onChange={(event) =>
                      updateParams({
                        ...params,
                        simulatePressure: event.target.checked,
                      })
                    }
                  />
                  按速度模拟压感（鼠标对照）
                </label>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                参数会重新渲染本组已有实验稿。平滑越高越圆润，也可能让转折拖尾；预测只显示，不保存到笔迹。
              </p>
              {stats && (
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                  <span>采样：{stats.sampleRate} 点/秒</span>
                  <span>绘制：{stats.renderRate} 次/秒</span>
                  <span>本笔：{stats.livePoints} 点</span>
                  <span>预测段：{stats.predictionPoints} 点</span>
                  <span>raw：{stats.rawSeen ? "已观测" : "未观测"}</span>
                  <span>
                    合并采样：{stats.coalescedSeen ? "已观测" : "未观测"}
                  </span>
                  <span>
                    系统预测：{stats.predictedSeen ? "已观测" : "未观测"}
                  </span>
                  <span>最近绘制：{stats.renderMs.toFixed(2)} ms</span>
                </div>
              )}
            </div>
          )}
        </div>
      </PaperPresentation>
    </section>
  );
}
