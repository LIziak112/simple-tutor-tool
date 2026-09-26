import unknownDirectiveSample from "@samples/lint/09-unknown-directive.md?raw";
import mixedSample from "@samples/v2/混合样例.md?raw";
import practiceSample from "@samples/v2/练习样例.md?raw";
import lectureSample from "@samples/v2/讲义样例.md?raw";
import { useState } from "react";
import { RichMarkdown } from "@/features/markdown/RichMarkdown";

/**
 * /dev/render 渲染开发页（T1.8，仅开发环境注册路由）：
 * 左侧 textarea 编辑 Markdown 原文，右侧 RichMarkdown 实时渲染；
 * 顶部下拉切换预置样例（三份 v2 样例 + 未注册指令降级演示）。
 * 样例原文经 Vite 的 ?raw 导入（构建时内联为字符串，无网络请求）。
 */

/** 预置样例清单（标识符用英文，显示文案中文） */
const SAMPLES = [
  { id: "practice", label: "练习样例（七种题型）", source: practiceSample },
  { id: "lecture", label: "讲义样例（两讲）", source: lectureSample },
  { id: "mixed", label: "混合样例（讲义 + 题目）", source: mixedSample },
  {
    id: "unknown",
    label: "未知指令降级演示（lint 反例 09）",
    source: unknownDirectiveSample,
  },
] as const;

export function RenderDevPage() {
  const [source, setSource] = useState<string>(SAMPLES[0].source);
  const [sampleId, setSampleId] = useState<string>(SAMPLES[0].id);

  /** 切换预置样例：覆盖编辑区内容 */
  function handleSampleChange(id: string): void {
    const sample = SAMPLES.find((s) => s.id === id);
    if (!sample) return;
    setSampleId(id);
    setSource(sample.source);
  }

  return (
    <main className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <h1 className="text-sm font-semibold">渲染开发页 /dev/render</h1>
        <label
          htmlFor="sample-select"
          className="text-xs text-muted-foreground"
        >
          预置样例
        </label>
        <select
          id="sample-select"
          value={sampleId}
          onChange={(e) => handleSampleChange(e.target.value)}
          className="min-h-11 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {SAMPLES.map((sample) => (
            <option key={sample.id} value={sample.id}>
              {sample.label}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-muted-foreground">
          左侧编辑 Markdown，右侧实时渲染
        </span>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-2">
        <textarea
          value={source}
          onChange={(e) => setSource(e.target.value)}
          spellCheck={false}
          aria-label="Markdown 原文编辑区"
          placeholder="在此粘贴或编辑 DSL v2 文档…"
          className="h-full min-h-0 w-full resize-none border-r border-border bg-muted/30 p-4 font-mono text-[13px] leading-6 outline-none"
        />
        <div className="h-full min-h-0 overflow-y-auto p-4 lg:p-6">
          <div className="mx-auto max-w-3xl">
            <RichMarkdown source={source} />
          </div>
        </div>
      </div>
    </main>
  );
}

// 供 App.tsx 的 React.lazy 动态导入（仅开发环境路由）
export default RenderDevPage;
