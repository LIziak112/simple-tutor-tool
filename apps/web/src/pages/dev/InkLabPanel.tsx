import { ClipboardCheck, FlaskConical, LoaderCircle, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  create,
  type InkDoc,
  type InkEngine,
} from "@/features/ink/engine/index.ts";
import { InkPad } from "@/features/ink/InkPad.tsx";
import {
  type BudgetRow,
  DEFAULT_BUDGET_RUNGS,
  evaluateBudgetRowForDoc,
  firstCrossing,
} from "@/features/ink/lab/budget.ts";
import {
  createDurationSampler,
  formatBytes,
  type MemorySnapshot,
  measureEncoding,
  observableMemory,
} from "@/features/ink/lab/measure.ts";
import {
  buildSyntheticAtramentDoc,
  totalPoints,
} from "@/features/ink/lab/synthetic-strokes.ts";

/**
 * T6R.1 隔离实验组件（挂 /dev/ink，不进任何学生/教师功能路径）。
 *
 * 四个区块：
 * ① 能力探测面板：协议/合并采样/pointerrawupdate/Ink API/desynchronized/
 *    剪贴板逐项探测——只做运行时能力检测，禁止以 UA 推断；
 * ② 合成书写台：把确定性合成笔迹注入真实引擎并测量；
 * ③ 预算试验：按方案 §7 暂定值跑合成长稿，找"多少笔/多少点触线"；
 * ④ 真机场景清单：12 项待用户 iPad 实测的场景，勾选与备注存 localStorage。
 *
 * 本面板所有数字都是"桌面自动化参考"，不冒充 iPad 真机结论；真机闸门见
 * docs/Phase6任务清单.md T6R.1。
 */
export interface InkLabPanelProps {
  /** 预算试验笔数阶梯（测试可注入小阶梯；缺省 DEFAULT_BUDGET_RUNGS） */
  budgetRungs?: readonly number[];
}

export function InkLabPanel({
  budgetRungs = DEFAULT_BUDGET_RUNGS,
}: InkLabPanelProps) {
  return (
    <div className="space-y-8">
      <CapabilityProbeSection />
      <SyntheticBenchSection />
      <BudgetSection rungs={budgetRungs} />
      <DeviceChecklistSection />
    </div>
  );
}

/** 让出主线程一拍（刷新进度/进度条；不进入单事件计时） */
function yieldFrame(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** 毫秒格式化：小值保留两位、大值一位 */
function fmtMs(ms: number | undefined): string {
  if (ms === undefined || ms === null) return "—";
  return `${ms >= 10 ? ms.toFixed(1) : ms.toFixed(2)} ms`;
}

/** 内存行：不可观测时明说，不填估算 */
function memoryLine(
  before: MemorySnapshot | null,
  after: MemorySnapshot | null,
): string {
  if (before === null || after === null) {
    return "内存：本浏览器不可观测（performance.memory 不存在，属正常）";
  }
  const delta = after.usedJSHeapSize - before.usedJSHeapSize;
  return `内存（usedJSHeapSize）：${formatBytes(before.usedJSHeapSize)} → ${formatBytes(
    after.usedJSHeapSize,
  )}（Δ ${delta >= 0 ? "+" : ""}${formatBytes(delta)}）`;
}

// ---------------------------------------------------------------------------
// ① 能力探测面板
// ---------------------------------------------------------------------------

interface ProbeRow {
  key: string;
  label: string;
  status: "支持" | "不支持" | "未知";
  /** 信息项显示实际值（如协议），不套三态 */
  value?: string;
}

/**
 * 逐项运行时探测。全部基于对象/原型/真实 context 属性的存在性，
 * **不读 navigator.userAgent**（方案 §4.1：不以 UA 推断能力）。
 */
function probeCapabilities(): ProbeRow[] {
  const rows: ProbeRow[] = [];

  // 协议：信息项，显示实际值
  const protocol = typeof location !== "undefined" ? location.protocol : "未知";
  rows.push({
    key: "protocol",
    label: "页面协议",
    status: "未知",
    value: protocol || "未知",
  });

  // 合并采样：PointerEvent 原型上是否有 getCoalescedEvents
  const coalesced =
    typeof PointerEvent !== "undefined" &&
    "getCoalescedEvents" in PointerEvent.prototype;
  rows.push({
    key: "coalesced",
    label: "getCoalescedEvents（合并采样）",
    status: coalesced ? "支持" : "不支持",
  });

  // pointerrawupdate：处理器属性是否存在（Chromium 系；Safari/Firefox 无）
  const rawUpdate =
    typeof window !== "undefined" && "onpointerrawupdate" in window;
  rows.push({
    key: "pointerrawupdate",
    label: "pointerrawupdate（原始高频更新）",
    status: rawUpdate ? "支持" : "不支持",
  });

  // Ink API：navigator.ink（Chromium 旗标级；Safari 无）
  const inkApi = typeof navigator !== "undefined" && "ink" in navigator;
  rows.push({
    key: "ink-api",
    label: "Ink API",
    status: inkApi ? "支持" : "不支持",
  });

  // canvas desynchronized：真实取一次 2d context 读回属性（不猜）
  let desync: ProbeRow["status"] = "未知";
  try {
    const probe = document.createElement("canvas");
    const ctx = probe.getContext("2d", {
      desynchronized: true,
    }) as
      | (CanvasRenderingContext2D & {
          getContextAttributes?: () => { desynchronized?: boolean };
        })
      | null;
    if (ctx) {
      desync =
        typeof ctx.getContextAttributes === "function"
          ? ctx.getContextAttributes().desynchronized
            ? "支持"
            : "不支持"
          : "未知";
    }
  } catch {
    // 探测本身失败：保持"未知"，不抛错
  }
  rows.push({
    key: "desynchronized",
    label: "canvas desynchronized",
    status: desync,
  });

  // 剪贴板：对象存在性（实际可用还取决于安全上下文与用户手势）
  const clipboard =
    typeof navigator !== "undefined" && navigator.clipboard !== undefined;
  rows.push({
    key: "clipboard",
    label: "剪贴板（navigator.clipboard）",
    status: clipboard ? "支持" : "不支持",
    ...(clipboard
      ? {}
      : { value: "HTTP 下通常不可用，以探测为准" }),
  });

  return rows;
}

function CapabilityProbeSection() {
  const rows = useMemo(() => probeCapabilities(), []);
  return (
    <section aria-labelledby="ink-lab-probe" className="space-y-2">
      <h3 id="ink-lab-probe" className="text-sm font-semibold">
        ① 能力探测（运行时逐项检测，不以 UA 推断）
      </h3>
      <ul className="divide-y divide-border rounded-xl border border-border bg-muted/30 text-xs">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex min-h-11 flex-wrap items-center justify-between gap-2 px-3 py-2"
          >
            <span className="font-medium">{row.label}</span>
            <span
              className={
                row.status === "支持"
                  ? "text-green-700"
                  : row.status === "不支持"
                    ? "text-destructive"
                    : "text-muted-foreground"
              }
            >
              {row.value ?? row.status}
              {row.value && row.value !== row.status ? (
                <span className="ml-2 text-muted-foreground">{row.status}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        探测结果只代表当前浏览器与协议；iPad 真机的 HTTP/HTTPS 差异须分别实测。
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ② 合成书写台
// ---------------------------------------------------------------------------

/**
 * 注入方案取舍（任务要求说明）：选「驱动 pointer 事件序列」为主方案——
 * dispatchEvent 同步执行适配器的真实输入热路径（onPointerDown/Move 的坐标
 * 换算、atrament.draw、livePoints 收集、收笔 commitAdd，以及 InkPad 的
 * onDocChange/自动加高开销），因此"事件处理 p50/p95"就是真实输入路径的耗时。
 * 「引擎 load 文档」只走重放重绘，测不到输入热路径，保留为对照按钮。
 * 已知限制：合成 PointerEvent 的 getCoalescedEvents() 为空 → 走单点回退路径；
 * 合并采样批次的真实耗时只能真机测（见验证报告）。
 */
function SyntheticBenchSection() {
  const engineRef = useRef<InkEngine | null>(null);
  const padWrapRef = useRef<HTMLDivElement>(null);
  const [strokeCount, setStrokeCount] = useState(100);
  const [pointsPerStroke, setPointsPerStroke] = useState(40);
  const [seed, setSeed] = useState(20261005);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [liveDoc, setLiveDoc] = useState<InkDoc<"atrament"> | null>(null);

  const liveStrokes = liveDoc?.data.strokes.length ?? 0;
  const livePoints = liveDoc ? totalPoints(liveDoc) : 0;
  const lastStrokePoints = liveDoc?.data.strokes.at(-1)?.points.length ?? 0;

  async function runPointerInjection(): Promise<void> {
    const ink = engineRef.current;
    if (!ink) {
      setError("引擎尚未就绪");
      return;
    }
    const canvas = padWrapRef.current?.querySelector<HTMLCanvasElement>(
      'canvas[data-slot="ink-canvas"]',
    );
    if (!canvas) {
      setError("未找到手写画布（引擎未挂载）");
      return;
    }
    if (typeof PointerEvent === "undefined") {
      setError("当前环境不支持 PointerEvent，无法驱动指针事件");
      return;
    }
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const doc = buildSyntheticAtramentDoc({
        seed,
        strokeCount,
        pointsPerStroke,
      });
      ink.clear();
      await yieldFrame();
      const rect = canvas.getBoundingClientRect();
      const scale = rect.width / 1000; // 逻辑 1000 → CSS 像素（y 同以宽度为基准）
      const toClient = (p: { x: number; y: number }) => ({
        clientX: rect.left + p.x * scale,
        clientY: rect.top + p.y * scale,
      });
      const down = createDurationSampler();
      const move = createDurationSampler();
      const up = createDurationSampler();
      const memBefore = observableMemory();
      const strokes = doc.data.strokes;
      for (let s = 0; s < strokes.length; s++) {
        setProgress(`注入中：第 ${s + 1}/${strokes.length} 笔`);
        await yieldFrame();
        const stroke = strokes[s];
        if (!stroke) continue;
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
      }
      const memAfter = observableMemory();
      const finalDoc = ink.getData();
      const finalStrokes =
        finalDoc.engine === "atrament" ? finalDoc.data.strokes.length : 0;
      const finalPoints =
        finalDoc.engine === "atrament" ? totalPoints(finalDoc) : 0;
      // 全量重绘：load(getData()) 走确定性重放路径（T6R.6 渲染器同款原语）
      const redraw = createDurationSampler();
      redraw.measure(() => ink.load(ink.getData()));
      const ms = move.stats();
      setReport(
        [
          `注入完成：计划 ${strokes.length} 笔 / ${totalPoints(doc)} 点；引擎实际 ${finalStrokes} 笔 / ${finalPoints} 点`,
          `事件处理耗时（pointermove ×${move.sampleCount()}）：p50 ${fmtMs(ms?.p50)}｜p95 ${fmtMs(ms?.p95)}｜max ${fmtMs(ms?.max)}`,
          `落笔（pointerdown ×${down.sampleCount()}）max ${fmtMs(down.stats()?.max)}；收笔（pointerup ×${up.sampleCount()}）max ${fmtMs(up.stats()?.max)}`,
          `全量重绘 load(getData())：${fmtMs(redraw.stats()?.max)}`,
          memoryLine(memBefore, memAfter),
          "限制：合成 PointerEvent 无合并采样（回退单点路径），合并批次真实耗时须真机测量",
        ].join("\n"),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function runLoadInjection(): Promise<void> {
    const ink = engineRef.current;
    if (!ink) {
      setError("引擎尚未就绪");
      return;
    }
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const doc = buildSyntheticAtramentDoc({
        seed,
        strokeCount,
        pointsPerStroke,
      });
      ink.clear();
      await yieldFrame();
      const memBefore = observableMemory();
      const redraw = createDurationSampler();
      redraw.measure(() => ink.load(doc));
      const memAfter = observableMemory();
      const m = await measureEncoding(JSON.stringify(doc));
      setReport(
        [
          `load 注入完成：${doc.data.strokes.length} 笔 / ${totalPoints(doc)} 点`,
          `全量重绘耗时：${fmtMs(redraw.stats()?.max)}`,
          `JSON 原始 ${formatBytes(m.rawBytes)}；gzip ${formatBytes(m.gzipBytes)}（${fmtMs(m.gzipMs)}${m.compressed ? "" : "，本环境未真正压缩，数字仅参考"}）`,
          memoryLine(memBefore, memAfter),
        ].join("\n"),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const numInputClass =
    "h-11 w-24 rounded-lg border border-border bg-background px-2 text-sm";

  return (
    <section aria-labelledby="ink-lab-bench" className="space-y-3">
      <h3
        id="ink-lab-bench"
        className="flex items-center gap-1.5 text-sm font-semibold"
      >
        <FlaskConical aria-hidden className="size-4" />②
        合成书写台（确定性合成笔迹 → 真实引擎）
      </h3>
      <p className="text-xs text-muted-foreground">
        主方案＝驱动 pointer
        事件序列（走真实输入热路径：坐标换算、atrament.draw、 收笔提交、InkPad
        通知与自动加高）；「load 注入」只测重放重绘，作对照。
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          注入笔数
          <input
            type="number"
            min={0}
            max={5000}
            value={strokeCount}
            onChange={(e) => setStrokeCount(Number(e.target.value) || 0)}
            className={numInputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          注入每笔点数
          <input
            type="number"
            min={1}
            max={500}
            value={pointsPerStroke}
            onChange={(e) => setPointsPerStroke(Number(e.target.value) || 1)}
            className={numInputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          随机种子
          <input
            type="number"
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value) || 0)}
            className={numInputClass}
          />
        </label>
        <Button
          type="button"
          className="h-11"
          disabled={busy}
          onClick={() => void runPointerInjection()}
        >
          {busy ? (
            <LoaderCircle aria-hidden className="animate-spin" />
          ) : (
            <Play aria-hidden />
          )}
          注入合成笔迹（驱动指针事件）
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={busy}
          onClick={() => void runLoadInjection()}
        >
          <Play aria-hidden />
          对照：load 注入合成文档
        </Button>
      </div>

      {progress && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          {progress}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          注入失败：{error}
        </div>
      )}

      <div ref={padWrapRef}>
        <InkPad
          engine="atrament"
          initialHeight={720}
          engineRef={engineRef}
          onDocChange={(doc) =>
            setLiveDoc(doc.engine === "atrament" ? doc : null)
          }
          label="合成书写台（真实引擎与工具栏，可手写）"
        />
      </div>

      <div className="rounded-xl border border-border bg-muted/30 p-3 text-xs">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span className="font-medium">实时文档</span>
          <span>笔画：{liveStrokes}</span>
          <span>总点数：{livePoints}</span>
          <span>最近一笔点数：{lastStrokePoints}</span>
        </div>
        {report && (
          <pre className="mt-2 whitespace-pre-wrap font-mono text-xs leading-5">
            {report}
          </pre>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ③ 预算试验
// ---------------------------------------------------------------------------

/** 预算试验行：字节部分（BudgetRow）+ 分析图渲染部分 */
interface BudgetRunRow extends BudgetRow {
  redrawMs: number;
  pngBytes: number;
  pngMs: number;
}

function BudgetSection({ rungs }: { rungs: readonly number[] }) {
  const [pointsPerStroke, setPointsPerStroke] = useState(40);
  const [seed, setSeed] = useState(20261005);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<BudgetRunRow[] | null>(null);
  const [summary, setSummary] = useState<string[] | null>(null);

  /** 分析图渲染宿主：离屏但保持布局（display:none 会让 clientWidth=0） */
  const analysisHostRef = useRef<HTMLDivElement>(null);
  const analysisEngineRef = useRef<InkEngine | null>(null);

  useEffect(() => {
    const host = analysisHostRef.current;
    if (!host) return;
    // 逻辑宽 1000px 的分析图渲染（方案 §7 暂定）：宿主 CSS 宽正好 1000
    analysisEngineRef.current = create(host, {
      engine: "atrament",
      height: 3000,
    });
    return () => {
      analysisEngineRef.current?.destroy();
      analysisEngineRef.current = null;
    };
  }, []);

  async function runExperiment(): Promise<void> {
    setRunning(true);
    setError(null);
    setRows(null);
    setSummary(null);
    try {
      const out: BudgetRunRow[] = [];
      let stoppedEarly = false;
      const memBefore = observableMemory();
      for (const strokeCount of rungs) {
        setProgress(`测量中：${strokeCount} 笔…`);
        await yieldFrame();
        const doc = buildSyntheticAtramentDoc({
          seed,
          strokeCount,
          pointsPerStroke,
          paperHeightLogical: 3000, // 方案 §4.3 首版纸高上限
        });
        const row = await evaluateBudgetRowForDoc(doc);
        const engine = analysisEngineRef.current;
        let redrawMs = 0;
        let pngBytes = 0;
        let pngMs = 0;
        if (engine) {
          const t0 = performance.now();
          engine.load(doc);
          redrawMs = performance.now() - t0;
          const t1 = performance.now();
          const blob = await engine.exportPng();
          pngMs = performance.now() - t1;
          pngBytes = blob.size;
        }
        out.push({ ...row, redrawMs, pngBytes, pngMs });
        // 两条字节线都已触达：更大的阶梯只会更超，提前结束
        if (row.hitsGzipLimit && row.hitsDecompressedLimit) {
          stoppedEarly = true;
          break;
        }
      }
      const memAfter = observableMemory();
      setRows(out);
      setSummary(buildBudgetSummary(out, stoppedEarly, memBefore, memAfter));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  const numInputClass =
    "h-11 w-24 rounded-lg border border-border bg-background px-2 text-sm";

  return (
    <section aria-labelledby="ink-lab-budget" className="space-y-3">
      <h3 id="ink-lab-budget" className="text-sm font-semibold">
        ③ 预算试验（方案 §7 暂定值：正文 gzip ≤2MiB、解压 ≤32MiB、分析图逻辑宽
        1000px）
      </h3>
      <p className="text-xs text-muted-foreground">
        阶梯逐级加倍构建合成长稿，测"多少笔/多少总点触到各预算线"；PNG 为分析图
        规格（逻辑宽 1000px、纸高
        3000）的离屏渲染。全部为暂定值口径，真机定标后修订。
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          预算每笔点数
          <input
            type="number"
            min={1}
            max={500}
            value={pointsPerStroke}
            onChange={(e) => setPointsPerStroke(Number(e.target.value) || 1)}
            className={numInputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          预算随机种子
          <input
            type="number"
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value) || 0)}
            className={numInputClass}
          />
        </label>
        <Button
          type="button"
          className="h-11"
          disabled={running}
          onClick={() => void runExperiment()}
        >
          {running ? (
            <LoaderCircle aria-hidden className="animate-spin" />
          ) : (
            <Play aria-hidden />
          )}
          运行预算试验
        </Button>
      </div>

      {/* 分析图离屏宿主：不可见但参与布局，保证 clientWidth=1000 */}
      <div
        aria-hidden
        ref={analysisHostRef}
        style={{
          position: "absolute",
          left: "-9999px",
          top: "0",
          width: "1000px",
          height: "3000px",
        }}
      />

      {progress && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          {progress}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span>预算试验失败：{error}</span>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={running}
            onClick={() => void runExperiment()}
          >
            重试
          </Button>
        </div>
      )}

      {rows === null && !running && !error && (
        <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          尚未运行——点击「运行预算试验」按暂定预算跑合成长稿。
        </p>
      )}

      {rows && rows.length > 0 && (
        <div className="space-y-2">
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-2 py-2 font-medium">笔数</th>
                  <th className="px-2 py-2 font-medium">总点数</th>
                  <th className="px-2 py-2 font-medium">原始字节</th>
                  <th className="px-2 py-2 font-medium">gzip 字节</th>
                  <th className="px-2 py-2 font-medium">压缩耗时</th>
                  <th className="px-2 py-2 font-medium">重绘耗时</th>
                  <th className="px-2 py-2 font-medium">分析图 PNG</th>
                  <th className="px-2 py-2 font-medium">PNG 编码</th>
                  <th className="px-2 py-2 font-medium">触线</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.strokes} className="tabular-nums">
                    <td className="px-2 py-1.5">{row.strokes}</td>
                    <td className="px-2 py-1.5">{row.points}</td>
                    <td className="px-2 py-1.5">{formatBytes(row.rawBytes)}</td>
                    <td className="px-2 py-1.5">
                      {formatBytes(row.gzipBytes)}
                    </td>
                    <td className="px-2 py-1.5">{fmtMs(row.gzipMs)}</td>
                    <td className="px-2 py-1.5">{fmtMs(row.redrawMs)}</td>
                    <td className="px-2 py-1.5">{formatBytes(row.pngBytes)}</td>
                    <td className="px-2 py-1.5">{fmtMs(row.pngMs)}</td>
                    <td className="px-2 py-1.5">
                      {row.hitsGzipLimit || row.hitsDecompressedLimit ? (
                        <span className="text-destructive">
                          {[
                            row.hitsGzipLimit ? "gzip" : null,
                            row.hitsDecompressedLimit ? "解压" : null,
                          ]
                            .filter(Boolean)
                            .join("＋")}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">未触线</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {summary && (
            <div className="rounded-xl border border-border bg-muted/30 p-3">
              <p className="mb-1 text-xs font-medium">触线结论</p>
              <pre className="whitespace-pre-wrap font-mono text-xs leading-5">
                {summary.join("\n")}
              </pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** 组装触线结论（只陈述事实，不外推到真机） */
function buildBudgetSummary(
  rows: readonly BudgetRunRow[],
  stoppedEarly: boolean,
  memBefore: MemorySnapshot | null,
  memAfter: MemorySnapshot | null,
): string[] {
  const desc = (row: BudgetRow | null): string =>
    row ? `${row.strokes} 笔（${row.points} 点）` : "0 笔";
  const gzipHit = firstCrossing(rows, (r) => r.hitsGzipLimit);
  const rawHit = firstCrossing(rows, (r) => r.hitsDecompressedLimit);
  const last = rows[rows.length - 1] as BudgetRunRow | undefined;
  const lines: string[] = [];
  if (gzipHit === null && rawHit === null) {
    lines.push(`未触任何暂定预算线（最大阶梯 ${desc(last ?? null)}）`);
  } else {
    if (gzipHit) {
      lines.push(
        `正文 gzip ≤2MiB（暂定）：在 ${desc(gzipHit.before)} 与 ${desc(gzipHit.crossing)} 之间触线`,
      );
    } else {
      lines.push(
        `正文 gzip ≤2MiB（暂定）：最大阶梯 ${desc(last ?? null)} 未触线`,
      );
    }
    if (rawHit) {
      lines.push(
        `正文解压 ≤32MiB（暂定）：在 ${desc(rawHit.before)} 与 ${desc(rawHit.crossing)} 之间触线`,
      );
    } else {
      lines.push(
        `正文解压 ≤32MiB（暂定）：最大阶梯 ${desc(last ?? null)} 未触线`,
      );
    }
  }
  const maxPng = rows.reduce((m, r) => Math.max(m, r.pngBytes), 0);
  lines.push(
    `分析图（逻辑宽 1000px、纸高 3000）最大 PNG：${formatBytes(maxPng)}（桌面参考，真机待测）`,
  );
  if (stoppedEarly) {
    lines.push("两条字节线均已触达，更大阶梯已跳过");
  }
  lines.push(memoryLine(memBefore, memAfter));
  return lines;
}

// ---------------------------------------------------------------------------
// ④ 真机场景清单
// ---------------------------------------------------------------------------

/** T6R.1 的 12 个真机场景（docs/Phase6任务清单.md T6R.1「场景」行） */
const DEVICE_SCENARIOS = [
  {
    id: "http-https",
    label: "普通 HTTP 与 HTTPS 分别访问（能力差异与安全上下文）",
  },
  { id: "orientation-split", label: "横竖屏与分屏（笔迹比例与布局）" },
  { id: "first-touch", label: "首次手指触屏（首触是否落墨）" },
  {
    id: "palm-first",
    label: "掌先落／笔先落（手掌先触摸后用笔，误笔画是否被丢弃）",
  },
  { id: "multi-canvas", label: "多画布换题（输入偏好在画布间保持）" },
  { id: "collapse-reopen", label: "收起重开（草稿恢复、不新建文档）" },
  { id: "twenty-questions", label: "连写 20 题（无卡顿、无崩溃、无持续增长）" },
  {
    id: "pointercancel",
    label: "取消指针（pointercancel 途中不粘笔、不补造终点）",
  },
  { id: "rotate-midstroke", label: "旋转时未抬笔（一笔中途旋转的坐标处理）" },
  {
    id: "background-lock-kill",
    label: "切后台／锁屏／终止 Safari 后恢复（只恢复已落盘数据）",
  },
  { id: "low-storage", label: "低存储空间（quota 压力下的保存与提示）" },
  { id: "long-dense", label: "长密集稿（长演算＋密集笔画的手感与内存）" },
] as const;

const STORAGE_KEY = "t6r1-real-device-checklist.v1";

interface ChecklistEntry {
  done: boolean;
  note: string;
}

/** 读取持久化清单（形状异常回退默认，不白屏） */
function loadChecklist(): ChecklistEntry[] {
  const fallback: ChecklistEntry[] = DEVICE_SCENARIOS.map(() => ({
    done: false,
    note: "",
  }));
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    return DEVICE_SCENARIOS.map((_, i): ChecklistEntry => {
      const entry = parsed[i] as { done?: unknown; note?: unknown } | undefined;
      return {
        done: entry?.done === true,
        note: typeof entry?.note === "string" ? entry.note : "",
      };
    });
  } catch {
    return fallback;
  }
}

function persistChecklist(entries: readonly ChecklistEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // 隐私模式等场景写入可能抛错：清单本身仍在内存态可用，不阻断页面
  }
}

function DeviceChecklistSection() {
  const [entries, setEntries] = useState<ChecklistEntry[]>(loadChecklist);

  const doneCount = entries.filter((e) => e.done).length;

  function update(index: number, patch: Partial<ChecklistEntry>): void {
    setEntries((prev) => {
      const next = prev.map((entry, i) =>
        i === index ? { ...entry, ...patch } : entry,
      );
      persistChecklist(next);
      return next;
    });
  }

  return (
    <section aria-labelledby="ink-lab-checklist" className="space-y-2">
      <h3
        id="ink-lab-checklist"
        className="flex items-center gap-1.5 text-sm font-semibold"
      >
        <ClipboardCheck aria-hidden className="size-4" />④
        真机场景清单（待用户真机实测）
      </h3>
      <p className="text-xs text-muted-foreground">
        以下 12 项对应 T6R.1 真机闸门，须用户在 iPad 上逐项实测后勾选；勾选与
        备注保存在本机 localStorage。已实测 {doneCount}/
        {DEVICE_SCENARIOS.length}。
      </p>
      {doneCount === 0 && (
        <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          尚无场景完成实测——全部待用户在 iPad 真机上验证后勾选，桌面自动化结果
          不计入本清单。
        </p>
      )}
      <ol className="space-y-2">
        {DEVICE_SCENARIOS.map((scenario, i) => (
          <li
            key={scenario.id}
            className="rounded-xl border border-border bg-muted/30 px-3 py-2"
          >
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-xs">
              <input
                type="checkbox"
                checked={entries[i]?.done ?? false}
                onChange={(e) => update(i, { done: e.target.checked })}
                className="size-5 shrink-0"
                aria-label={`已实测：${scenario.label}`}
              />
              <span className="font-medium">
                {i + 1}. {scenario.label}
              </span>
            </label>
            <textarea
              value={entries[i]?.note ?? ""}
              onChange={(e) => update(i, { note: e.target.value })}
              placeholder="实测记录（设备/OS/浏览器/结论…）"
              aria-label={`${scenario.label} 备注`}
              className="mt-1 min-h-11 w-full rounded-lg border border-border bg-background p-2 text-xs"
              rows={1}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}
