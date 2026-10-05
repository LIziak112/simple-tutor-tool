import { ClipboardCheck, FlaskConical, LoaderCircle, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { INK_CANVAS_SELECTOR } from "@/features/ink/engine/atrament-adapter.ts";
import {
  create,
  type InkDoc,
  type InkEngine,
} from "@/features/ink/engine/index.ts";
// INK_LOGICAL_WIDTH / INK_CANVAS_SELECTOR 走纯模块（engine/index.ts 在测试里被整体 mock）
import { INK_LOGICAL_WIDTH } from "@/features/ink/engine/types.ts";
import { InkPad } from "@/features/ink/InkPad.tsx";
import {
  type BudgetRow,
  DEFAULT_BUDGET_RUNGS,
  evaluateBudgetRowForDoc,
  firstCrossing,
  TENTATIVE_ANALYSIS_LOGICAL_HEIGHT,
  TENTATIVE_ANALYSIS_PNG_MAX_BYTES,
} from "@/features/ink/lab/budget.ts";
import { probeCapabilities } from "@/features/ink/lab/capabilities.ts";
import { drivePointerEvents } from "@/features/ink/lab/inject.ts";
import {
  createDurationSampler,
  type MemorySnapshot,
  measureEncoding,
  observableMemory,
} from "@/features/ink/lab/measure.ts";
import {
  buildSyntheticAtramentDoc,
  totalPoints,
} from "@/features/ink/lab/synthetic-strokes.ts";
import { formatBytes } from "@/lib/format";

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
  if (ms === undefined) return "—";
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
  // formatBytes 对负值返回占位符（字节量语义），差值须先取绝对值再拼符号
  return `内存（usedJSHeapSize）：${formatBytes(before.usedJSHeapSize)} → ${formatBytes(
    after.usedJSHeapSize,
  )}（Δ ${delta >= 0 ? "+" : "-"}${formatBytes(Math.abs(delta))}）`;
}

// ---------------------------------------------------------------------------
// ① 能力探测面板
// ---------------------------------------------------------------------------

interface ProbeRow {
  key: string;
  label: string;
  status: "支持" | "不支持" | "未知";
  /** 信息项显示实际值（如协议）；显示后不再重复状态文案 */
  value?: string;
  /** 补充说明（如剪贴板在非安全上下文下的限制） */
  note?: string;
}

/**
 * 结构化探测结果 → 展示行（检测逻辑在 lab/capabilities.ts，此处只做中文文案
 * 映射；产品侧将来直接消费 CapabilitySnapshot，不经过本层）。
 */
function capabilityRows(): ProbeRow[] {
  const c = probeCapabilities();
  const yn = (b: boolean): ProbeRow["status"] => (b ? "支持" : "不支持");
  return [
    {
      key: "protocol",
      label: "页面协议",
      status: "未知",
      value: c.protocol ?? "未知",
    },
    {
      key: "coalesced",
      label: "getCoalescedEvents（合并采样）",
      status: yn(c.coalescedEvents),
    },
    {
      key: "pointerrawupdate",
      label: "pointerrawupdate（原始高频更新）",
      status: yn(c.pointerrawupdate),
    },
    { key: "ink-api", label: "Ink API", status: yn(c.inkApi) },
    {
      key: "desynchronized",
      label: "canvas desynchronized",
      status:
        c.canvasDesynchronized === "yes"
          ? "支持"
          : c.canvasDesynchronized === "no"
            ? "不支持"
            : "未知",
    },
    {
      key: "clipboard",
      label: "剪贴板（navigator.clipboard）",
      status: yn(c.clipboard),
      ...(c.clipboard ? {} : { note: "非安全上下文下通常不可用，以探测为准" }),
    },
  ];
}

function CapabilityProbeSection() {
  const rows = useMemo(() => capabilityRows(), []);
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
            <span className="flex items-baseline gap-2">
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
              </span>
              {row.note ? (
                <span className="text-muted-foreground">{row.note}</span>
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

  // dev-only 调试钩子：控制台可取当前引擎文档（实验室排障用，不进生产路径）
  useEffect(() => {
    const w = window as typeof window & {
      __inkLabBench?: () => InkEngine | null;
    };
    w.__inkLabBench = () => engineRef.current;
    return () => {
      delete w.__inkLabBench;
    };
  }, []);

  const liveStrokes = liveDoc?.data.strokes.length ?? 0;
  const livePoints = liveDoc ? totalPoints(liveDoc) : 0;
  const lastStrokePoints = liveDoc?.data.strokes.at(-1)?.points.length ?? 0;

  /**
   * 两个注入入口共用的运行骨架：busy 标记 + 错误/报告重置 + 收尾。
   * busyRef 与 busy 状态同值——onDocChange 在注入期间跳过 setLiveDoc
   * （每笔全文档 setState 会把注入拖成 O(n²) 的渲染压力，最终统计以结束时
   * 的一次 getData 为准），手写时的实时统计不受影响。
   */
  const busyRef = useRef(false);
  async function runBench(measure: () => Promise<void>): Promise<void> {
    if (busyRef.current) return; // 重入守卫：不依赖按钮 disabled 的重渲染时序
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      await measure();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
      setProgress(null);
      // 中途失败也复位实时统计（引擎里已有前 k 笔，不能停留在注入前快照）
      const doc = engineRef.current?.getData();
      setLiveDoc(doc?.engine === "atrament" ? doc : null);
    }
  }

  async function runPointerInjection(): Promise<void> {
    const ink = engineRef.current;
    const failPrecondition = (message: string): void => {
      setReport(null); // 前置失败也清旧报告，避免成功报告与错误同屏并存
      setError(message);
    };
    if (!ink) {
      failPrecondition("引擎尚未就绪");
      return;
    }
    const canvas =
      padWrapRef.current?.querySelector<HTMLCanvasElement>(INK_CANVAS_SELECTOR);
    if (!canvas) {
      failPrecondition("未找到手写画布（引擎未挂载）");
      return;
    }
    if (typeof PointerEvent === "undefined") {
      failPrecondition("当前环境不支持 PointerEvent，无法驱动指针事件");
      return;
    }
    await runBench(async () => {
      const doc = buildSyntheticAtramentDoc({
        seed,
        strokeCount,
        pointsPerStroke,
      });
      ink.clear();
      await yieldFrame();
      const memBefore = observableMemory();
      const { down, move, up, droppedStrokes } = await drivePointerEvents(
        ink,
        canvas,
        doc.data.strokes,
        {
          onProgress: (done, total) =>
            setProgress(`注入中：${done}/${total} 笔`),
          yieldFrame,
        },
      );
      const memAfter = observableMemory();
      const finalDoc = ink.getData();
      const atr = finalDoc.engine === "atrament" ? finalDoc : null;
      setLiveDoc(atr);
      // 全量重绘：load 同一份文档走确定性重放路径（T6R.6 渲染器同款原语）
      const redraw = createDurationSampler();
      redraw.measure(() => ink.load(finalDoc));
      const ms = move.stats();
      setReport(
        [
          `注入完成：计划 ${doc.data.strokes.length} 笔 / ${totalPoints(doc)} 点；引擎实际 ${atr?.data.strokes.length ?? 0} 笔 / ${atr ? totalPoints(atr) : 0} 点`,
          `事件处理耗时（pointermove ×${move.sampleCount()}）：p50 ${fmtMs(ms?.p50)}｜p95 ${fmtMs(ms?.p95)}｜max ${fmtMs(ms?.max)}`,
          `落笔（pointerdown ×${down.sampleCount()}）max ${fmtMs(down.stats()?.max)}；收笔（pointerup ×${up.sampleCount()}）max ${fmtMs(up.stats()?.max)}`,
          `全量重绘（load 注入后文档）：${fmtMs(redraw.stats()?.max)}`,
          memoryLine(memBefore, memAfter),
          ...(droppedStrokes > 0
            ? [
                `⚠ 整笔越界被画布边界校验丢弃：${droppedStrokes} 笔（画布过小或纸高超限，测量样本已失真）`,
              ]
            : []),
          "限制：合成 PointerEvent 无合并采样（回退单点路径），合并批次真实耗时须真机测量",
        ].join("\n"),
      );
    });
  }

  async function runLoadInjection(): Promise<void> {
    const ink = engineRef.current;
    if (!ink) {
      setReport(null);
      setError("引擎尚未就绪");
      return;
    }
    await runBench(async () => {
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
      setLiveDoc(doc);
      setReport(
        [
          `load 注入完成：${doc.data.strokes.length} 笔 / ${totalPoints(doc)} 点`,
          `全量重绘耗时：${fmtMs(redraw.stats()?.max)}`,
          `JSON 原始 ${formatBytes(m.rawBytes)}；gzip ${formatBytes(m.gzipBytes)}（${fmtMs(m.gzipMs)}${m.compressed ? "" : "，本环境未真正压缩，数字仅参考"}）`,
          memoryLine(memBefore, memAfter),
        ].join("\n"),
      );
    });
  }

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
        <div className="flex flex-col gap-1 text-xs">
          <label htmlFor="ink-lab-bench-strokes">注入笔数</label>
          <Input
            id="ink-lab-bench-strokes"
            type="number"
            min={0}
            max={5000}
            value={strokeCount}
            onChange={(e) =>
              setStrokeCount(
                Math.min(5000, Math.max(0, Number(e.target.value) || 0)),
              )
            }
            className="w-24"
          />
        </div>
        <div className="flex flex-col gap-1 text-xs">
          <label htmlFor="ink-lab-bench-points">注入每笔点数</label>
          <Input
            id="ink-lab-bench-points"
            type="number"
            min={1}
            max={500}
            value={pointsPerStroke}
            onChange={(e) =>
              setPointsPerStroke(
                Math.min(500, Math.max(1, Number(e.target.value) || 1)),
              )
            }
            className="w-24"
          />
        </div>
        <div className="flex flex-col gap-1 text-xs">
          <label htmlFor="ink-lab-bench-seed">随机种子</label>
          <Input
            id="ink-lab-bench-seed"
            type="number"
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value) || 0)}
            className="w-24"
          />
        </div>
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
        <p className="flex min-h-6 items-center gap-2 text-xs tabular-nums text-muted-foreground">
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
          onDocChange={(doc) => {
            // 注入期间跳过（见 runBench 注释）；手写时正常实时统计
            if (!busyRef.current) {
              setLiveDoc(doc.engine === "atrament" ? doc : null);
            }
          }}
          label="合成书写台（真实引擎与工具栏，可手写）"
        />
      </div>

      <div className="rounded-xl border border-border bg-muted/30 p-3 text-xs">
        {busy ? (
          <p className="font-medium">注入运行中——实时统计暂停，结束后更新</p>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span className="font-medium">实时文档</span>
            <span>笔画：{liveStrokes}</span>
            <span>总点数：{livePoints}</span>
            <span>最近一笔点数：{lastStrokePoints}</span>
          </div>
        )}
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

/** 预算试验行：字节部分（BudgetRow）+ 分析图渲染部分 + 行级触线标志 */
interface BudgetRunRow extends BudgetRow {
  redrawMs: number;
  pngBytes: number;
  pngMs: number;
  /** 分析图 PNG 超暂定限额（行级算一次，展示/结论/提前终止共用） */
  hitsPngLimit: boolean;
}

function BudgetSection({ rungs }: { rungs: readonly number[] }) {
  const [pointsPerStroke, setPointsPerStroke] = useState(40);
  const [seed, setSeed] = useState(20261005);
  const [running, setRunning] = useState(false);
  /** 分析引擎懒建：首次运行才创建 1000×3000 画布（DPR2 下约 48MB 位图），不运行为省内存——本页正是内存压力实测场地 */
  const [labReady, setLabReady] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<BudgetRunRow[] | null>(null);
  const [summary, setSummary] = useState<string[] | null>(null);

  /** 分析图渲染宿主：离屏但保持布局（display:none 会让 clientWidth=0） */
  const analysisHostRef = useRef<HTMLDivElement>(null);
  const analysisEngineRef = useRef<InkEngine | null>(null);

  useEffect(() => {
    if (!labReady) return; // 懒建：宿主未渲染时 effect 短路
    const host = analysisHostRef.current;
    if (!host) return;
    // 逻辑宽 1000px 的分析图渲染（方案 §7 暂定）：宿主 CSS 宽正好 1000
    analysisEngineRef.current = create(host, {
      engine: "atrament",
      height: TENTATIVE_ANALYSIS_LOGICAL_HEIGHT,
    });
    return () => {
      analysisEngineRef.current?.destroy();
      analysisEngineRef.current = null;
    };
  }, [labReady]);

  async function runExperiment(): Promise<void> {
    if (!labReady) {
      setLabReady(true);
      // 等渲染 + effect 建好引擎（两拍：一拍渲染、一拍 effect 后的布局）
      await yieldFrame();
      await yieldFrame();
      if (analysisEngineRef.current === null) {
        setError("分析图引擎尚未就绪，请重试");
        return;
      }
    }
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
          paperHeightLogical: TENTATIVE_ANALYSIS_LOGICAL_HEIGHT, // 方案 §7 分析图暂定规格
        });
        const row = await evaluateBudgetRowForDoc(doc);
        const engine = analysisEngineRef.current;
        if (engine === null) {
          break; // 组件已卸载（effect cleanup 销毁引擎）：停止后续阶梯白跑
        }
        let redrawMs = 0;
        let pngBytes = 0;
        let pngMs = 0;
        {
          const t0 = performance.now();
          engine.load(doc);
          redrawMs = performance.now() - t0;
          const t1 = performance.now();
          const blob = await engine.exportPng();
          pngMs = performance.now() - t1;
          pngBytes = blob.size;
        }
        out.push({
          ...row,
          redrawMs,
          pngBytes,
          pngMs,
          hitsPngLimit: pngBytes > TENTATIVE_ANALYSIS_PNG_MAX_BYTES,
        });
        // 三条预算线都已触达：更大的阶梯只会更超，提前结束
        if (
          row.hitsGzipLimit &&
          row.hitsDecompressedLimit &&
          out[out.length - 1]?.hitsPngLimit
        ) {
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
        <div className="flex flex-col gap-1 text-xs">
          <label htmlFor="ink-lab-budget-points">预算每笔点数</label>
          <Input
            id="ink-lab-budget-points"
            type="number"
            min={1}
            max={500}
            value={pointsPerStroke}
            onChange={(e) =>
              setPointsPerStroke(
                Math.min(500, Math.max(1, Number(e.target.value) || 1)),
              )
            }
            className="w-24"
          />
        </div>
        <div className="flex flex-col gap-1 text-xs">
          <label htmlFor="ink-lab-budget-seed">预算随机种子</label>
          <Input
            id="ink-lab-budget-seed"
            type="number"
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value) || 0)}
            className="w-24"
          />
        </div>
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

      {/* 分析图离屏宿主：懒建（首次运行才挂载），不可见但参与布局 */}
      {labReady && (
        <div
          aria-hidden
          ref={analysisHostRef}
          style={{
            position: "absolute",
            left: "-9999px",
            top: "0",
            width: `${INK_LOGICAL_WIDTH}px`,
            height: `${TENTATIVE_ANALYSIS_LOGICAL_HEIGHT}px`,
          }}
        />
      )}

      {progress && (
        <p className="flex min-h-6 items-center gap-2 text-xs tabular-nums text-muted-foreground">
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
                  <tr
                    key={`${row.strokes}-${row.points}`}
                    className="tabular-nums"
                  >
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
                      {row.hitsGzipLimit ||
                      row.hitsDecompressedLimit ||
                      row.hitsPngLimit ? (
                        <span className="text-destructive">
                          {[
                            row.hitsGzipLimit ? "gzip" : null,
                            row.hitsDecompressedLimit ? "解压" : null,
                            row.hitsPngLimit ? "分析图" : null,
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
  const last = rows[rows.length - 1] as BudgetRunRow | undefined;
  /** 三条预算线共用的结论模板（命中=括号区间，未命中=最大阶梯） */
  const crossingLine = (
    label: string,
    hit: { crossing: BudgetRow; before: BudgetRow | null } | null,
  ): string =>
    hit
      ? `${label}：在 ${desc(hit.before)} 与 ${desc(hit.crossing)} 之间触线`
      : `${label}：最大阶梯 ${desc(last ?? null)} 未触线`;
  const lines: string[] = [];
  if (
    !rows.some(
      (r) => r.hitsGzipLimit || r.hitsDecompressedLimit || r.hitsPngLimit,
    )
  ) {
    lines.push(`未触任何暂定预算线（最大阶梯 ${desc(last ?? null)}）`);
  } else {
    lines.push(
      crossingLine(
        "正文 gzip ≤2MiB（暂定）",
        firstCrossing(rows, (r) => r.hitsGzipLimit),
      ),
      crossingLine(
        "正文解压 ≤32MiB（暂定）",
        firstCrossing(rows, (r) => r.hitsDecompressedLimit),
      ),
      crossingLine(
        "每分析图 ≤2MiB（暂定，整幅不切片口径）",
        firstCrossing(rows, (r) => r.hitsPngLimit),
      ),
    );
  }
  const maxPng = rows.reduce((m, r) => Math.max(m, r.pngBytes), 0);
  lines.push(
    `分析图（逻辑宽 ${INK_LOGICAL_WIDTH}px、纸高 ${TENTATIVE_ANALYSIS_LOGICAL_HEIGHT}）最大 PNG：${formatBytes(maxPng)}（桌面参考，真机待测）`,
  );
  if (stoppedEarly) {
    lines.push("三条预算线均已触达，更大阶梯已跳过");
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
  // 备注逐键同步写 localStorage 会在慢设备卡输入手感：防抖 500ms，卸载前冲刷
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  useEffect(() => {
    return () => {
      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
      }
      persistChecklist(entriesRef.current);
    };
  }, []);
  const schedulePersist = (next: readonly ChecklistEntry[]): void => {
    if (persistTimerRef.current !== null) {
      clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      persistChecklist(next);
    }, 500);
  };

  const doneCount = entries.filter((e) => e.done).length;

  function update(index: number, patch: Partial<ChecklistEntry>): void {
    // 先算 next 再提交：副作用（持久化）不放 setState updater——
    // StrictMode 下 updater 双调用会重复写 localStorage
    const next = entries.map((entry, i) =>
      i === index ? { ...entry, ...patch } : entry,
    );
    setEntries(next);
    if (patch.done !== undefined) {
      // 勾选低频：立即持久化（并取消待写的防抖，避免旧数据回写覆盖）
      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      persistChecklist(next);
    } else {
      schedulePersist(next);
    }
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
