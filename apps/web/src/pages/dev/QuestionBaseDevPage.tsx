import type { AttemptQuestionPublic, StudentAnswer } from "@tutor/contract";
import { useEffect, useRef, useState } from "react";
import { renderQuestionBaseImage } from "@/features/annotation/question-base-image";
import { QuestionSurface } from "@/features/attempt/QuestionSurface";

const common = {
  id: "geometry-fixture",
  questionRevisionId: "fixture-revision",
  difficulty: 1 as const,
  knowledge: [],
  hintCount: 0,
};
const fixtures: Readonly<Record<string, AttemptQuestionPublic>> = {
  judge: { ...common, type: "judge", stemMd: "一是正数。[[]]" },
  limit: {
    ...common,
    type: "fill",
    stemMd:
      "数二\n\n$$\\lim_{x\\to +\\infty} x^2[\\arctan(x+1) - \\arctan x] =$$\n\n计算结果为 [[]]。",
  },
  mathFonts: {
    ...common,
    type: "fill",
    stemMd:
      "计算下列式子。\n\n$$\\sum_{k=1}^{n} \\frac{k^2}{\\sqrt{k+1}} + \\int_0^1 x^2\\,dx =$$\n\n结果为 [[]]。",
  },
  choice: {
    ...common,
    type: "choice",
    stemMd: "选择 $\\frac{1}{2}$ 的等价形式。",
    options: ["$0.5$", "较长选项内容，需要在窄屏自然换行。".repeat(3)],
  },
  multi: {
    ...common,
    type: "multi",
    stemMd: "选择正数。",
    options: ["$1$", "$2$", "$-1$"],
  },
  fill: {
    ...common,
    type: "fill",
    stemMd:
      "甲 [[]]；乙 [[]]；丙 :blank[]；丁 [[]]。\n\n$$\\frac{1}{2}+\\frac{1}{3}=\\frac{5}{6}$$",
  },
  media: {
    ...common,
    type: "solve",
    stemMd:
      '观察图片。\n\n::image{src="/icons/icon-192.png" width="120px" alt="本地图像"}\n\n| 数据 | 数值 |\n| --- | --- |\n| 甲 | $1$ |\n| 乙 | $2$ |',
  },
  graph: {
    ...common,
    type: "solve",
    stemMd: '观察函数图像。\n\n::graph{fn="x^2" range="-2,2"}',
  },
  fold: {
    ...common,
    type: "solve",
    stemMd: '阅读题干。\n\n:::fold{title="公开材料"}\n材料内容。\n:::',
  },
  broken: { ...common, type: "solve", stemMd: "$\\left(1$ 与 $2\\right)$" },
  tall: {
    ...common,
    type: "solve",
    stemMd: Array.from({ length: 100 }, () =>
      "较长的公开题干段落，需要自然换行。".repeat(3),
    ).join("\n\n"),
  },
};

/** 仅开发环境的几何准入夹具，不进入学生导航与生产构建。 */
export default function QuestionBaseDevPage() {
  const [fixture, setFixture] = useState("fill");
  const [width, setWidth] = useState(304.25);
  const [answer, setAnswer] = useState<StudentAnswer | undefined>();
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof renderQuestionBaseImage>
  > | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!result) {
      setUrl("");
      return;
    }
    const next = URL.createObjectURL(result.blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [result]);
  const question = fixtures[fixture];
  if (!question) return null;
  const generate = async () => {
    const surface = ref.current?.querySelector<HTMLElement>(
      '[data-slot="question-surface"]',
    );
    if (!surface) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await renderQuestionBaseImage(question, surface));
    } catch (error) {
      setError(error instanceof Error ? error.message : "生成失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="p-4">
      <div className="mb-4 flex flex-wrap gap-3">
        <select
          aria-label="题面夹具"
          value={fixture}
          onChange={(event) => {
            setFixture(event.target.value);
            setAnswer(undefined);
            setResult(null);
            setError("");
          }}
          disabled={busy}
          className="h-11 border"
        >
          {Object.keys(fixtures).map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
        <input
          aria-label="题面宽度"
          type="number"
          value={width}
          onChange={(event) => {
            setWidth(Number(event.target.value));
            setResult(null);
          }}
          disabled={busy}
          className="h-11 border"
        />
        <button
          type="button"
          onClick={() => void generate()}
          disabled={busy}
          className="h-11 border px-3"
        >
          {busy ? "生成中" : "生成底图"}
        </button>
      </div>
      <div ref={ref} style={{ width }} className="bg-card text-card-foreground">
        <QuestionSurface
          key={fixture}
          question={question}
          answer={answer}
          onAnswer={setAnswer}
        />
      </div>
      {error && <p role="alert">{error}</p>}
      {result && (
        <pre data-testid="layout-result" className="max-w-full overflow-x-auto">
          {JSON.stringify({
            layout: result.layout,
            pixelWidth: result.pixelWidth,
            pixelHeight: result.pixelHeight,
          })}
        </pre>
      )}
      {url && <img src={url} alt="题面底图" style={{ width }} />}
    </main>
  );
}
