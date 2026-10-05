import { ImageDown, Maximize2, RotateCcw, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  InkDoc,
  InkEngine,
  InkEngineKind,
} from "@/features/ink/engine/index.ts";
import { InkPad } from "@/features/ink/InkPad.tsx";
import { InkLabPanel } from "./InkLabPanel.tsx";

/**
 * /dev/ink 手写开发页（T2.7，架构 §5.4「Phase 2 第一步先做真机试验」的实验场）。
 *
 * 两个区块：
 * ① Atrament 页内答题区（默认形态）
 * ② Excalidraw 全屏作答（按钮进入；懒加载，只在打开时下载库 chunk）
 *
 * 每个区块配：工具栏（InkPad）+ 数据面板（笔画数/点数/字节数）
 * + 「load(getData()) 往返」验证按钮 + 导出 PNG 预览。
 * iPad 真机按架构 §7.1 清单逐项检查（页面底部附清单摘要）；
 * 调试控制台：URL 加 ?debug=1（Eruda）。
 */
export default function InkDevPage() {
  const [fullscreen, setFullscreen] = useState(false);

  return (
    <main className="min-h-dvh bg-background text-foreground [touch-action:manipulation]">
      <header className="border-b border-border px-4 py-3">
        <div className="mx-auto flex max-w-4xl flex-wrap items-baseline gap-3">
          <h1 className="text-sm font-semibold">手写开发页 /dev/ink</h1>
          <span className="text-xs text-muted-foreground">
            T2.7 真机调手感的实验场：两个区块分别试写；iPad 调试可加 ?debug=1
          </span>
        </div>
      </header>

      <div className="mx-auto max-w-4xl space-y-10 px-4 py-6">
        <section aria-labelledby="ink-sec-atrament">
          <h2 id="ink-sec-atrament" className="mb-1 text-base font-semibold">
            ① 页内答题区（Atrament）
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            题目下方写过程用的默认形态。笔/手指/鼠标均可书写；见过 Apple Pencil
            后手指自动只滚动不落墨。写到接近底部会自动加高。
          </p>
          <InkSection engine="atrament" initialHeight={320} />
        </section>

        <section aria-labelledby="ink-sec-excalidraw">
          <h2 id="ink-sec-excalidraw" className="mb-1 text-base font-semibold">
            ② 全屏作答（Excalidraw）
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            大题/画图用。库按需加载（首次进入需几秒）；题干固定在顶部，下方整屏书写。
            进入全屏后同样有工具栏与数据面板（往返验证 / PNG 预览在面板里）。
          </p>
          <div className="mb-3">
            <Button
              type="button"
              className="h-11"
              onClick={() => setFullscreen(true)}
            >
              <Maximize2 aria-hidden />
              进入全屏作答
            </Button>
          </div>
        </section>

        <section aria-labelledby="ink-sec-lab">
          <h2 id="ink-sec-lab" className="mb-1 text-base font-semibold">
            ③ T6R.1 实验室（合成笔迹、预算测量与真机清单）
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Phase6 手写技术验证的隔离实验场：能力探测、合成书写注入、预算试验、
            真机场景清单。所有数字均为桌面自动化参考，不冒充 iPad 真机结论
            （报告见 docs/审查报告/Phase6-手写真机验证.md）。
          </p>
          <InkLabPanel />
        </section>

        <section aria-labelledby="ink-sec-checklist">
          <h2 id="ink-sec-checklist" className="mb-2 text-base font-semibold">
            真机检查清单（§7.1，除 PWA / 切 App 外共 10 项）
          </h2>
          <ol className="list-decimal space-y-1 pl-6 text-xs leading-6 text-muted-foreground">
            <li>手掌放在屏幕上书写，不产生误笔画</li>
            <li>
              手指上下滑动页面正常滚动，笔可随时直接落笔书写（无需切模式）
            </li>
            <li>快速书写连笔、写小字，笔迹连续无断点、无明显延迟</li>
            <li>压感明显（轻重笔画粗细不同）</li>
            <li>长按画布不弹出放大镜/选择菜单；双击不缩放页面</li>
            <li>橡皮擦、撤销、重做、清空正确；撤销可以撤销擦除</li>
            <li>横竖屏切换后笔迹位置、比例正确</li>
            <li>写到答题区底部自动加高；全屏作答模式正常进出</li>
            <li>“最终答案”输入框可用随手写（Scribble）转文字</li>
            <li>连续作答 20 道手写题后页面不卡顿、不崩溃</li>
          </ol>
        </section>
      </div>

      {fullscreen && <FullscreenInk onClose={() => setFullscreen(false)} />}
    </main>
  );
}

/** 全屏作答覆盖层：题干固定顶部 + 整屏 Excalidraw（退出即销毁引擎与懒加载状态） */
function FullscreenInk({ onClose }: { onClose: () => void }) {
  // 覆盖层挂载时才渲染 InkPad → Excalidraw 只在此时动态加载
  const initialHeight =
    typeof window === "undefined"
      ? 600
      : Math.max(480, window.innerHeight - 210);
  return (
    <div
      role="dialog"
      aria-label="全屏作答"
      className="fixed inset-0 z-50 flex flex-col bg-background"
    >
      <header className="flex items-center gap-3 border-b border-border px-4 py-2">
        <p className="min-w-0 flex-1 truncate text-sm">
          <span className="font-semibold">例题（题干固定）：</span>
          已知函数 f(x) = x² - 2ax + 3 在区间 [0, 2] 上的最小值为 -1，求 a
          的值，并写出完整过程。
        </p>
        <Button
          type="button"
          variant="outline"
          className="h-11"
          onClick={onClose}
        >
          <X aria-hidden />
          退出全屏
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <InkSection
          engine="excalidraw"
          initialHeight={initialHeight}
          padLabel="全屏手写作答区"
        />
      </div>
    </div>
  );
}

/** 区块通用：InkPad + 数据面板（摘要 / 往返验证 / PNG 预览） */
function InkSection({
  engine,
  initialHeight,
  padLabel,
}: {
  engine: InkEngineKind;
  initialHeight?: number;
  padLabel?: string;
}) {
  const engineRef = useRef<InkEngine | null>(null);
  const [doc, setDoc] = useState<InkDoc | null>(null);
  const [roundTrip, setRoundTrip] = useState<string | null>(null);
  const [pngUrl, setPngUrl] = useState<string | null>(null);

  const stats = summarize(doc);

  /** load(getData()) 往返一致性验证（验收项在引擎层有单测，这里是页上实测） */
  function handleRoundTrip(): void {
    const ink = engineRef.current;
    if (!ink) return;
    const before = ink.getData();
    ink.load(before);
    const after = ink.getData();
    const same =
      JSON.stringify(before) === JSON.stringify(after)
        ? "一致 ✓"
        : `不一致 ✗（前 ${JSON.stringify(before).length} 字节 / 后 ${
            JSON.stringify(after).length
          } 字节）`;
    setRoundTrip(same);
  }

  async function handleExportPng(): Promise<void> {
    const ink = engineRef.current;
    if (!ink) return;
    try {
      const blob = await ink.exportPng();
      if (pngUrl) URL.revokeObjectURL(pngUrl);
      setPngUrl(URL.createObjectURL(blob));
    } catch (err) {
      setPngUrl(null);
      setRoundTrip(
        `导出失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return (
    <div className="space-y-3">
      <InkPad
        engine={engine}
        engineRef={engineRef}
        onDocChange={setDoc}
        {...(initialHeight !== undefined ? { initialHeight } : {})}
        label={
          padLabel ??
          (engine === "atrament" ? "页内手写答题区" : "全屏手写作答区")
        }
      />

      {/* 数据面板 */}
      <div className="rounded-xl border border-border bg-muted/30 p-3 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-medium">getData() 摘要</span>
          <span>引擎：{doc?.engine ?? engine}</span>
          <span>笔画：{stats.strokes}</span>
          <span>总点数：{stats.points}</span>
          <span>JSON：{stats.bytes} 字节</span>
          {doc && (
            <span>
              更新时间：
              {doc.updatedAt > 0
                ? new Date(doc.updatedAt).toLocaleTimeString("zh-CN")
                : "—"}
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={!doc}
            onClick={handleRoundTrip}
          >
            <RotateCcw aria-hidden />
            load(getData()) 往返
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={!doc}
            onClick={() => void handleExportPng()}
          >
            <ImageDown aria-hidden />
            导出 PNG 预览
          </Button>
          {roundTrip && (
            <span
              className={
                roundTrip.startsWith("一致")
                  ? "text-green-700"
                  : "text-destructive"
              }
            >
              往返结果：{roundTrip}
            </span>
          )}
        </div>
        {pngUrl && (
          <div className="mt-3">
            <p className="mb-1 text-muted-foreground">PNG 快照预览：</p>
            <img
              src={pngUrl}
              alt="笔迹 PNG 快照预览"
              className="max-h-64 rounded-lg border border-border bg-white"
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** InkDoc → 面板摘要（笔画数/点数/字节数） */
function summarize(doc: InkDoc | null): {
  strokes: number;
  points: number;
  bytes: number;
} {
  if (!doc) return { strokes: 0, points: 0, bytes: 0 };
  if (doc.engine === "atrament") {
    // 泛型联合无法随 engine 字段收窄 data，校验后显式特化
    const strokes = (doc as InkDoc<"atrament">).data.strokes;
    return {
      strokes: strokes.length,
      points: strokes.reduce((n, s) => n + s.points.length, 0),
      bytes: JSON.stringify(doc).length,
    };
  }
  const scene = (doc as InkDoc<"excalidraw">).data.scene;
  const elements = Array.isArray(scene.elements) ? scene.elements.length : 0;
  return { strokes: elements, points: 0, bytes: JSON.stringify(doc).length };
}
