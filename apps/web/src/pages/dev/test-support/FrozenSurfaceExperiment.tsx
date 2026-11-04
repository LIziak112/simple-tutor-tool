import {
  ANNOTATION_SURFACE_PIXEL_RATIO,
  type AnnotationDoc,
  type AttemptQuestionPublic,
  annotationDocSchema,
  annotationSurfaceLayoutSchema,
  type StudentAnswer,
} from "@tutor/contract";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { compatibleSurfaceEvidence } from "@/features/annotation/annotation-layout-compatibility";
import {
  type AnnotationSurface,
  createAnnotationSurface,
} from "@/features/annotation/annotation-surface";
import {
  measureQuestionSurface,
  publicContentSignatureOf,
  renderQuestionBaseImage,
} from "@/features/annotation/question-base-image";
import { QuestionSurface } from "@/features/attempt/QuestionSurface";
import { stableContentHash64 } from "@/lib/content-hash";
import {
  captureQuestionSlots,
  type FrozenQuestionManifest,
  validateFrozenQuestion,
} from "./frozen-surface-prototype";

const common = {
  id: "prototype-question",
  questionRevisionId: "prototype-revision-1",
  difficulty: 1 as const,
  knowledge: [],
  hintCount: 0,
};
const questions = {
  fill: {
    ...common,
    type: "fill",
    stemMd:
      "求导后填写两处结果。$f(x)=x^3+\\sin x$，则 $f'(x)=$ [[]]；在 $x=0$ 处的切线斜率为 [[]]。\n\n$$\\int_0^1 3x^2\\,dx = 1$$",
  },
  choice: {
    ...common,
    type: "choice",
    stemMd: "下列哪一项与 $\\frac{1}{2}$ 等价？",
    options: [
      "$0.5$",
      "一段很长的选项说明，包含公式 $\\sum_{k=1}^{n}k$，在窄屏时应自然换行。".repeat(
        3,
      ),
      "$\\frac{2}{5}$",
    ],
  },
  matching: {
    ...common,
    type: "matching",
    stemMd: "读长文后，把五个空位与选项配对。",
    matchingSlots: Array.from({ length: 5 }, (_, index) => ({
      id: `slot-${index + 1}`,
      ordinal: index + 1,
    })),
    matchingOptions: {
      allowRepeat: false,
      options: Array.from({ length: 7 }, (_, index) => ({
        id: `opt-${index + 1}`,
        text: `选项 ${index + 1}：${"长段落选项内容。".repeat(3)}`,
      })),
    },
  },
  ordering: {
    ...common,
    type: "ordering",
    stemMd: "阅读说明，再把三个步骤排入顺序。",
    orderingItems: [
      { id: "item-1", text: "先观察函数定义域。", fixedPosition: null },
      { id: "item-2", text: "再求导并分析符号。", fixedPosition: null },
      { id: "item-3", text: "最后写出结论。", fixedPosition: null },
    ],
    sortableCount: 3,
  },
} satisfies Record<string, AttemptQuestionPublic>;
export const prototypeMatchingQuestion: AttemptQuestionPublic =
  questions.matching;

type QuestionKind = keyof typeof questions;
type ExperimentKind = QuestionKind;

const manifestSchema = z.strictObject({
  version: z.literal(0),
  questionId: z.string(),
  questionRevisionId: z.string(),
  contentSignature: z.string(),
  slots: z.array(
    z.strictObject({
      key: z.string(),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
  ),
});
const questionSnapshotSchema = z.strictObject({
  version: z.literal(0),
  kind: z.literal("question"),
  dataUrl: z.string().startsWith("data:image/png;base64,"),
  layout: annotationSurfaceLayoutSchema,
  manifest: manifestSchema,
  doc: annotationDocSchema,
});
type QuestionSnapshot = z.infer<typeof questionSnapshotSchema>;

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function slotRect(
  slot: FrozenQuestionManifest["slots"][number],
): React.CSSProperties {
  return {
    position: "absolute",
    left: slot.x,
    top: slot.y,
    width: slot.width,
    height: slot.height,
    zIndex: 2,
  };
}

function FrozenControls({
  question,
  manifest,
  answer,
  update,
  disabled,
  readOnly,
}: {
  question: AttemptQuestionPublic;
  manifest: FrozenQuestionManifest;
  answer: StudentAnswer | undefined;
  update: (value: StudentAnswer) => void;
  disabled: boolean;
  readOnly: boolean;
}) {
  if (question.type === "fill") {
    const values = answer?.kind === "fill" ? answer.values : [];
    return manifest.slots.map((slot, index) => (
      <input
        key={slot.key}
        type="text"
        aria-label={`第${index + 1}空`}
        value={values[index] ?? ""}
        disabled={disabled}
        readOnly={readOnly}
        onChange={(event) => {
          if (disabled || readOnly) return;
          const next = [...values];
          next[index] = event.target.value;
          update({ kind: "fill", values: next });
        }}
        style={{
          ...slotRect(slot),
          background: "white",
          border: "1px solid #64748b",
          borderRadius: 6,
          padding: "0 8px",
        }}
      />
    ));
  }
  if (question.type === "choice") {
    return manifest.slots.map((slot, index) => (
      <input
        key={slot.key}
        type="radio"
        name="frozen-choice"
        aria-label={`选项 ${String.fromCharCode(65 + index)}`}
        checked={answer?.kind === "choice" && answer.index === index}
        disabled={disabled || readOnly}
        onChange={() => {
          if (!disabled && !readOnly) update({ kind: "choice", index });
        }}
        style={{
          ...slotRect(slot),
          appearance: "none",
          border:
            answer?.kind === "choice" && answer.index === index
              ? "2px solid #2563eb"
              : "2px solid transparent",
          borderRadius: 6,
          cursor: "pointer",
        }}
      />
    ));
  }
  if (question.type === "matching") {
    const pairs = answer?.kind === "matching" ? answer.pairs : {};
    const slots = question.matchingSlots ?? [];
    const options = question.matchingOptions?.options ?? [];
    return manifest.slots.map((slot, index) => {
      const slotId = slots[index]?.id;
      if (slotId === undefined) return null;
      return (
        <select
          key={slot.key}
          aria-label={`第${slots[index]?.ordinal ?? index + 1}空的选项`}
          value={pairs[slotId] ?? ""}
          disabled={disabled || readOnly}
          onChange={(event) => {
            if (disabled || readOnly) return;
            const next = { ...pairs };
            if (event.target.value === "") delete next[slotId];
            else next[slotId] = event.target.value;
            update({ kind: "matching", pairs: next });
          }}
          style={{
            ...slotRect(slot),
            background: "white",
            border: "1px solid #64748b",
            borderRadius: 6,
            padding: "0 8px",
          }}
        >
          <option value="">未选择</option>
          {options.map((option) => (
            <option
              key={option.id}
              value={option.id}
              disabled={
                !question.matchingOptions?.allowRepeat &&
                Object.entries(pairs).some(
                  ([otherSlot, choice]) =>
                    otherSlot !== slotId && choice === option.id,
                )
              }
            >
              {option.text}
            </option>
          ))}
        </select>
      );
    });
  }
  return null;
}

export default function FrozenSurfaceExperiment() {
  const [kind, setKind] = useState<ExperimentKind>("fill");
  const [sourceWidth, setSourceWidth] = useState(720);
  const [displayWidth, setDisplayWidth] = useState(720);
  const [answer, setAnswer] = useState<StudentAnswer | undefined>();
  const [snapshot, setSnapshot] = useState<QuestionSnapshot | null>(null);
  const [transport, setTransport] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const sourceRef = useRef<HTMLDivElement>(null);
  const inkHostRef = useRef<HTMLDivElement>(null);
  const inkSurfaceRef = useRef<AnnotationSurface | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const question = questions[kind];
  // 排序板始终是动态作答区；冻结的只是同题修订版的公开静态题干。
  const staticQuestion: AttemptQuestionPublic =
    kind === "ordering"
      ? {
          ...question,
          type: "solve",
          orderingItems: undefined,
          sortableCount: undefined,
        }
      : question;
  const active =
    snapshot !== null &&
    validateFrozenQuestion(
      snapshot.manifest,
      staticQuestion,
      stableContentHash64(publicContentSignatureOf(staticQuestion)),
    ) &&
    snapshot.layout.questionRevisionId === staticQuestion.questionRevisionId;
  const baseDataUrl = snapshot?.dataUrl;

  useEffect(() => {
    if (!baseDataUrl) return;
    const initial = snapshotRef.current;
    if (!initial || !inkHostRef.current) return;
    const surface = createAnnotationSurface({
      baseWidth: initial.doc.baseWidth,
      baseHeight: initial.doc.baseHeight,
      inputMode: "auto",
    });
    surface.mount(inkHostRef.current, initial.doc);
    surface.setInputEnabled(false);
    inkSurfaceRef.current = surface;
    const unsubscribe = surface.onChange((doc, reason) => {
      if (reason === "load") return;
      setSnapshot((current) => (current ? { ...current, doc } : current));
    });
    return () => {
      unsubscribe();
      surface.destroy();
      inkSurfaceRef.current = null;
    };
    // 只按原稿身份挂引擎，笔画和答案变动不重挂。
  }, [baseDataUrl]);

  useEffect(() => {
    inkSurfaceRef.current?.setInputEnabled(drawing && active && !readOnly);
  }, [drawing, active, readOnly]);

  useEffect(() => {
    if (snapshot) setTransport(JSON.stringify(snapshot));
  }, [snapshot]);

  const freeze = async () => {
    const surface = sourceRef.current?.querySelector<HTMLElement>(
      '[data-slot="question-surface"]',
    );
    if (!surface) return;
    setBusy(true);
    setError("");
    try {
      const signature = stableContentHash64(
        publicContentSignatureOf(staticQuestion),
      );
      const before = captureQuestionSlots(staticQuestion, surface, signature);
      const result = await renderQuestionBaseImage(staticQuestion, surface);
      const after = captureQuestionSlots(staticQuestion, surface, signature);
      const evidence = result.layout.compatibility;
      const current = measureQuestionSurface(surface);
      if (
        surface.closest("[data-annotation-scale]") ||
        !evidence ||
        evidence.contentSignature !== signature ||
        JSON.stringify(before.slots) !== JSON.stringify(after.slots) ||
        !compatibleSurfaceEvidence(evidence, current) ||
        Math.abs(result.layout.cssWidth - current.cssWidth) > 0.01 ||
        Math.abs(result.layout.cssHeight - current.cssHeight) > 0.01
      )
        throw new Error("底图与冻结控件不属同一次稳定布局");
      const doc: AnnotationDoc = {
        version: 1,
        baseWidth: result.pixelWidth,
        baseHeight: result.pixelHeight,
        strokes: [],
      };
      setSnapshot({
        version: 0,
        kind: "question",
        dataUrl: await blobDataUrl(result.blob),
        layout: result.layout,
        manifest: { ...after, slots: [...after.slots] },
        doc,
      });
      setDrawing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "冻结失败");
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setError("");
    try {
      const parsed: unknown = JSON.parse(transport);
      const incoming = questionSnapshotSchema.parse(parsed);
      if (
        incoming.doc.baseWidth !==
          Math.ceil(
            incoming.layout.cssWidth * ANNOTATION_SURFACE_PIXEL_RATIO,
          ) ||
        incoming.doc.baseHeight !==
          Math.ceil(incoming.layout.cssHeight * ANNOTATION_SURFACE_PIXEL_RATIO)
      )
        throw new Error("原稿图片与笔迹尺寸不符");
      const image = new Image();
      image.src = incoming.dataUrl;
      await image.decode();
      if (
        image.naturalWidth !== incoming.doc.baseWidth ||
        image.naturalHeight !== incoming.doc.baseHeight
      )
        throw new Error("原稿图片解码尺寸不符");
      if (snapshot?.dataUrl === incoming.dataUrl)
        inkSurfaceRef.current?.load(incoming.doc);
      setSnapshot(incoming);
      setDrawing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "原稿读取失败");
    }
  };

  const scale = snapshot
    ? Math.min(1, displayWidth / snapshot.layout.cssWidth)
    : 1;
  return (
    <section
      data-testid="frozen-prototype"
      className="mt-8 border-t border-border pt-6"
    >
      <h2 className="mb-3 text-lg font-semibold">冻结可圈画表面实验</h2>
      <div className="mb-3 flex flex-wrap gap-2">
        <select
          aria-label="实验类型"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as ExperimentKind);
            setSnapshot(null);
            setTransport("");
            setAnswer(undefined);
            setDrawing(false);
            setError("");
          }}
          className="h-11 border"
        >
          <option value="fill">公式填空</option>
          <option value="choice">长选项</option>
          <option value="matching">配对</option>
          <option value="ordering">动态排序</option>
        </select>
        <input
          aria-label="实验宽度"
          type="number"
          value={sourceWidth}
          onChange={(event) => setSourceWidth(Number(event.target.value))}
          className="h-11 w-24 border"
        />
        <input
          aria-label="显示宽度"
          type="number"
          value={displayWidth}
          onChange={(event) => setDisplayWidth(Number(event.target.value))}
          className="h-11 w-24 border"
        />
        <button
          type="button"
          onClick={() => snapshot && setDisplayWidth(snapshot.layout.cssWidth)}
          disabled={!snapshot}
          className="h-11 border px-3"
        >
          1:1放大
        </button>
        <button
          type="button"
          onClick={() => void freeze()}
          disabled={busy || snapshot !== null}
          className="h-11 border px-3"
        >
          {busy ? "冻结中" : "冻结原稿"}
        </button>
        <button
          type="button"
          onClick={() => void restore()}
          className="h-11 border px-3"
        >
          导入原稿
        </button>
        <button
          type="button"
          onClick={() => setDrawing((value) => !value)}
          disabled={!snapshot || !active || readOnly}
          className="h-11 border px-3"
        >
          {drawing ? "作答" : "圈画"}
        </button>
        <button
          type="button"
          onClick={() => inkSurfaceRef.current?.setTool({ type: "eraser" })}
          disabled={!snapshot || !active || readOnly}
          className="h-11 border px-3"
        >
          橡皮
        </button>
        <button
          type="button"
          onClick={() => inkSurfaceRef.current?.setTool({ type: "pen" })}
          disabled={!snapshot || !active || readOnly}
          className="h-11 border px-3"
        >
          画笔
        </button>
        <button
          type="button"
          onClick={() => inkSurfaceRef.current?.undo()}
          disabled={!snapshot || !active || readOnly}
          className="h-11 border px-3"
        >
          撤销
        </button>
        <button
          type="button"
          onClick={() => setReadOnly((value) => !value)}
          className="h-11 border px-3"
        >
          {readOnly ? "解除只读" : "只读"}
        </button>
      </div>
      <textarea
        data-testid="prototype-snapshot"
        aria-label="实验原稿传输"
        value={transport}
        onChange={(event) => setTransport(event.target.value)}
        className="mb-3 h-20 w-full border font-mono text-xs"
      />
      {error && (
        <p role="alert" className="mb-2 text-red-700">
          {error}
        </p>
      )}
      <pre
        data-testid="prototype-answer"
        className="max-w-full overflow-x-auto"
      >
        {JSON.stringify(answer ?? null)}
      </pre>
      {snapshot && (
        <pre
          data-testid="prototype-points"
          className="max-w-full overflow-x-auto"
        >
          {JSON.stringify(snapshot.doc.strokes)}
        </pre>
      )}
      {!snapshot && (
        <div
          ref={sourceRef}
          style={{ width: sourceWidth }}
          className="bg-white text-slate-900"
        >
          <QuestionSurface
            question={staticQuestion}
            answer={answer}
            onAnswer={setAnswer}
          />
        </div>
      )}
      {snapshot && (
        <div
          data-testid="frozen-viewport"
          className="max-w-full overflow-x-auto"
        >
          <div
            data-testid="frozen-frame"
            style={{
              position: "relative",
              width: snapshot.layout.cssWidth * scale,
              height: snapshot.layout.cssHeight * scale,
            }}
          >
            <div
              style={{
                position: "absolute",
                width: snapshot.layout.cssWidth,
                height: snapshot.layout.cssHeight,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              }}
            >
              <img
                src={snapshot.dataUrl}
                alt="冻结题面"
                style={{
                  width: snapshot.layout.cssWidth,
                  height: snapshot.layout.cssHeight,
                }}
              />
              {active ? (
                <FrozenControls
                  question={staticQuestion}
                  manifest={snapshot.manifest}
                  answer={answer}
                  update={setAnswer}
                  disabled={drawing}
                  readOnly={readOnly}
                />
              ) : (
                <p role="alert" className="absolute left-0 top-0 bg-white p-2">
                  槽位或题目身份不符，仅查看原稿
                </p>
              )}
            </div>
            <div
              ref={inkHostRef}
              style={{
                position: "absolute",
                inset: 0,
                pointerEvents: drawing ? "auto" : "none",
                zIndex: 3,
              }}
            />
          </div>
        </div>
      )}
      {kind === "ordering" && snapshot && (
        <div
          data-testid="dynamic-ordering"
          className="mt-4"
          style={{ width: sourceWidth }}
        >
          <QuestionSurface
            question={{ ...questions.ordering, stemMd: "" }}
            answer={answer}
            onAnswer={setAnswer}
            readOnly={readOnly}
          />
        </div>
      )}
    </section>
  );
}
