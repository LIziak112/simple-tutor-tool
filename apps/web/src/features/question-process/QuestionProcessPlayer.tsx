import { useQuery } from "@tanstack/react-query";
import type {
  QuestionProcessEvent,
  QuestionProcessRead,
  QuestionProcessSurface,
} from "@tutor/contract";
import {
  dispatchBehavior,
  emptyPublicStructure,
  matchingPublicStructureOf,
  orderingPublicStructureOf,
} from "@tutor/contract";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { QuestionSurface } from "@/features/attempt/QuestionSurface";
import { createAtramentReplayCanvas } from "@/features/ink/replay/draw";
import {
  fetchTeacherQuestionProcessApi,
  teacherAnnotationBasePngUrl,
} from "@/lib/api";
import { frameAt } from "./replay";

function ProcessInk({
  surface,
  annotation,
  fallback,
}: {
  surface: QuestionProcessSurface;
  annotation: boolean;
  fallback?: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<ReturnType<typeof createAtramentReplayCanvas> | null>(
    null,
  );
  const [decoded, setDecoded] = useState<string | null>(null);
  const baseId = surface.baseId;
  const ready = !annotation || (baseId !== undefined && decoded === baseId);
  const background =
    annotation || surface.background === "white"
      ? undefined
      : surface.background === "line"
        ? "linear-gradient(#e2e8f0 1px, transparent 1px)"
        : "linear-gradient(#e2e8f0 1px, transparent 1px),linear-gradient(90deg,#e2e8f0 1px,transparent 1px)";
  useEffect(() => {
    if (!ready || !host.current) return;
    const instance = createAtramentReplayCanvas(host.current);
    canvas.current = instance;
    return () => {
      canvas.current = null;
      instance.destroy();
    };
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    const scale = 1000 / surface.width;
    const strokes =
      scale === 1
        ? surface.strokes
        : surface.strokes.map((stroke) => ({
            ...stroke,
            weight: stroke.weight * scale,
            points: stroke.points.map((point) => ({
              ...point,
              x: point.x * scale,
              y: point.y * scale,
            })),
          }));
    canvas.current?.drawFrame(
      strokes,
      strokes.map((stroke) => stroke.points.length),
    );
  }, [ready, surface]);
  if (annotation && (!baseId || decoded === "error")) {
    return (
      <>
        {fallback}
        <p role="status">
          {baseId
            ? "圈画底图无法读取或尺寸不符。"
            : "该段圈画的原始底图尚不可用。"}
        </p>
      </>
    );
  }
  return (
    <div
      className="relative max-w-3xl overflow-hidden rounded border bg-white"
      data-process-stroke-count={surface.strokes.length}
      style={{
        aspectRatio: `${surface.width}/${surface.height}`,
        backgroundImage: background,
        backgroundSize: "4% auto",
      }}
    >
      {annotation && baseId && (
        <img
          src={teacherAnnotationBasePngUrl(baseId)}
          alt="保存时的题面底图"
          className="absolute inset-0 h-full w-full"
          onLoad={(event) => {
            const image = event.currentTarget;
            setDecoded(
              image.naturalWidth === surface.width &&
                image.naturalHeight === surface.height
                ? baseId
                : "error",
            );
          }}
          onError={() => setDecoded("error")}
        />
      )}
      {ready && (
        <div ref={host} className="absolute inset-0" aria-hidden="true" />
      )}
      {annotation && !ready && (
        <p className="relative bg-background p-2" role="status">
          正在读取圈画底图…
        </p>
      )}
    </div>
  );
}

const inkLabels = {
  stroke: "书写",
  erase: "擦除",
  undo: "撤销",
  redo: "重做",
  clear: "清空",
};
const hintLabels = {
  request: "请求提示",
  received: "收到提示",
  failed: "提示请求失败",
  shown: "已呈现提示",
};
const boundaryLabels = {
  offline: "断网",
  online: "重新联网",
  hidden: "页面进入后台",
  visible: "返回页面",
  closed: "采集段结束",
  interrupted: "稿件变化，过程有缺口",
};

function eventLabel(event: QuestionProcessEvent): string {
  switch (event.kind) {
    case "start":
      return "本段起始状态";
    case "surface":
      return event.layer === "scratch" ? "恢复草稿状态" : "恢复圈画状态";
    case "ink":
      return (
        (event.layer === "scratch" ? "草稿" : "圈画") +
        inkLabels[event.operation] +
        (event.finish && event.finish !== "up" ? "（中断收笔）" : "")
      );
    case "answer":
      return "作答变化";
    case "hint":
      if (event.action === "shown" && event.requestId.startsWith("restored-"))
        return `已呈现此前解锁的提示 ${event.index + 1}`;
      return `${hintLabels[event.action]} ${event.index + 1}`;
    case "boundary":
      return boundaryLabels[event.reason];
  }
}

function SegmentPlayer({
  question,
  segment,
}: {
  question: QuestionProcessRead["question"];
  segment: QuestionProcessRead["segments"][number];
}) {
  const range = useId();
  const start = segment.events[0]?.at ?? 0;
  const [time, setTime] = useState(start);
  const [selected, setSelected] = useState<number | undefined>();
  const [playing, setPlaying] = useState(false);
  const playFrom = useRef(0);
  const tail = segment.events.at(-1);
  const end = tail?.at ?? 0;
  const activeEvent =
    selected ?? segment.events.findLastIndex((event) => event.at <= time);
  const state = useMemo(
    () => frameAt(segment.events, Number.POSITIVE_INFINITY, activeEvent),
    [segment.events, activeEvent],
  );
  const answerStructures = useMemo(() => {
    const slots = question.matchingSlots ?? [];
    return {
      ...emptyPublicStructure,
      matching: question.matchingOptions
        ? matchingPublicStructureOf(
            question.matchingOptions,
            slots.map(({ id }) => id),
            Object.fromEntries(slots.map(({ id, ordinal }) => [id, ordinal])),
          )
        : emptyPublicStructure.matching,
      ordering: question.orderingItems
        ? orderingPublicStructureOf(question.orderingItems)
        : emptyPublicStructure.ordering,
    };
  }, [question]);
  useEffect(() => {
    if (!playing) return;
    const start = playFrom.current;
    let origin: number | undefined;
    let handle = 0;
    const tick = (now: number) => {
      origin ??= now;
      const next = Math.min(end, start + now - origin);
      setTime(next);
      if (next < end) handle = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, end]);
  if (!state) return <p>该段缺少起始状态，无法回放。</p>;
  const annotation = state.layers.annotation;
  const frozenStem = (
    <QuestionSurface
      question={question}
      answer={state.answer ?? undefined}
      readOnly
    />
  );
  const answerText = state.answer
    ? dispatchBehavior(state.answer, "display", answerStructures)
    : null;
  return (
    <div className="space-y-3">
      {segment.gap && <p role="status">该段有缺失，已显示可回放的部分。</p>}
      {!(tail?.kind === "boundary" && tail.reason === "closed") && (
        <p className="text-sm text-muted-foreground">
          该段可能仍在记录或有尾部尚未同步。
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={end === 0}
          onClick={() => {
            if (!playing) {
              playFrom.current = time >= end ? start : time;
              setTime(playFrom.current);
            }
            setSelected(undefined);
            setPlaying(!playing);
          }}
        >
          {playing ? "暂停" : "播放"}
        </Button>
        <label htmlFor={range}>回放时刻</label>
        <input
          id={range}
          className="min-w-24 flex-1"
          type="range"
          min={start}
          max={end}
          step={1}
          value={Math.round(time)}
          onChange={(event) => {
            setPlaying(false);
            setSelected(undefined);
            setTime(Number(event.currentTarget.value));
          }}
        />
        <span className="tabular-nums">{(time / 1000).toFixed(1)} 秒</span>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <section aria-label="回放题面" className="min-w-0 space-y-2">
          {annotation ? (
            <ProcessInk
              key={annotation.baseId}
              surface={annotation}
              annotation
              fallback={frozenStem}
            />
          ) : (
            frozenStem
          )}
          <p
            data-slot="question-process-answer"
            className="whitespace-pre-wrap break-words text-sm"
          >
            当时作答：{answerText || "未作答"}
          </p>
          <p className="text-sm">
            已呈现提示：
            {state.hints.length
              ? state.hints.map((index) => index + 1).join("、")
              : "无"}
          </p>
        </section>
        {state.layers.scratch && (
          <section aria-label="回放草稿" className="min-w-0">
            <ProcessInk surface={state.layers.scratch} annotation={false} />
          </section>
        )}
      </div>
      <ol
        className="max-h-48 overflow-auto rounded border p-2 text-sm"
        aria-label="过程事件"
      >
        {segment.events.map((event) => (
          <li key={event.seq}>
            <button
              type="button"
              className="min-h-8 w-full rounded px-2 text-left hover:bg-muted"
              aria-current={selected === event.seq ? "step" : undefined}
              onClick={() => {
                setPlaying(false);
                setSelected(event.seq);
                setTime(event.at);
              }}
            >
              {(event.at / 1000).toFixed(1)} 秒 · {eventLabel(event)}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ProcessBody({
  attemptId,
  questionId,
}: {
  attemptId: string;
  questionId: string;
}) {
  const [index, setIndex] = useState(0);
  const query = useQuery({
    queryKey: ["teacher-question-process", attemptId, questionId],
    queryFn: ({ signal }) =>
      fetchTeacherQuestionProcessApi(attemptId, questionId, signal),
    gcTime: 0,
    retry: false,
  });
  if (query.isPending) return <p role="status">正在加载单题过程…</p>;
  if (query.isError)
    return (
      <Button
        type="button"
        variant="outline"
        onClick={() => void query.refetch()}
      >
        加载失败，重试
      </Button>
    );
  const segment = query.data.segments[index];
  if (!segment) return <p>这道题暂无可回放的过程记录。</p>;
  return (
    <>
      {query.data.segments.length > 1 && (
        <label className="text-sm">
          采集段{" "}
          <select
            value={index}
            onChange={(event) => setIndex(Number(event.currentTarget.value))}
          >
            {query.data.segments.map((item, i) => (
              <option key={item.id} value={i}>
                第 {i + 1} 段
              </option>
            ))}
          </select>
        </label>
      )}
      <SegmentPlayer
        key={segment.id}
        question={query.data.question}
        segment={segment}
      />
    </>
  );
}

export function QuestionProcessPlayer({
  attemptId,
  questionId,
}: {
  attemptId: string;
  questionId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="单题过程回放" className="space-y-3">
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "收起过程回放" : "过程回放"}
      </Button>
      {open && <ProcessBody attemptId={attemptId} questionId={questionId} />}
    </section>
  );
}
