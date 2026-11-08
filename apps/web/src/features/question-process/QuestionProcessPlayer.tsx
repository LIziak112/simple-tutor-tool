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
import { ExcalidrawReplay } from "@/features/ink/replay/ExcalidrawReplay";
import {
  advancePlayhead,
  REPLAY_SPEEDS,
  type ReplaySpeed,
} from "@/features/ink/replay/model";
import {
  fetchTeacherQuestionProcessApi,
  teacherAnnotationBasePngUrl,
} from "@/lib/api";
import {
  focusPeriods,
  fromPlaybackTime,
  normalizedStroke,
  processPauses,
  type QuestionProcessFrame,
  questionTimeline,
  timelineFrame,
  toPlaybackTime,
} from "./replay";

function AtramentProcessInk({
  surface,
  annotation,
  fallback,
  visiblePoints,
  removed,
}: {
  surface: QuestionProcessSurface;
  annotation: boolean;
  fallback?: ReactNode;
  visiblePoints?: number[] | undefined;
  removed?: QuestionProcessFrame["removedSince"]["scratch"];
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
    const strokes = surface.strokes.map((stroke) =>
      normalizedStroke(stroke, surface.width),
    );
    canvas.current?.drawFrame(
      strokes,
      visiblePoints ?? strokes.map((stroke) => stroke.points.length),
    );
    if (removed?.length)
      canvas.current?.drawDeleted?.(
        removed.map((item) => ({
          stroke: item.stroke,
          startMs: 0,
          deletedAtMs: Infinity,
          pointTimesMs: item.stroke.points.map(() => 0),
        })),
        0,
      );
  }, [ready, surface, visiblePoints, removed]);
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
      data-process-deleted-strokes={removed?.length ?? 0}
      data-process-visible-points={(
        visiblePoints ?? surface.strokes.map((stroke) => stroke.points.length)
      ).reduce((sum, n) => sum + n, 0)}
      data-process-total-points={surface.strokes.reduce(
        (sum, stroke) => sum + stroke.points.length,
        0,
      )}
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

function ProcessInk(props: Parameters<typeof AtramentProcessInk>[0]) {
  const legacy = props.surface.legacy;
  if (legacy)
    return (
      <div>
        <p className="text-sm">历史场景按快照回放</p>
        <ExcalidrawReplay
          elements={legacy.scene.elements}
          visibleElements={legacy.scene.elements.length}
        />
      </div>
    );
  return <AtramentProcessInk {...props} />;
}

const layerLabels = { annotation: "圈画", scratch: "草稿", answer: "手写作答" };
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
const activityLabels = {
  focus: "进入本题",
  blur: "离开本题",
  paper_open: "展开草稿纸",
  paper_close: "收起草稿纸",
  fullscreen_on: "进入全屏",
  fullscreen_off: "退出全屏",
  submit: "提交本题",
  idle_start: "开始空闲",
  idle_end: "结束空闲",
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
      return `恢复${layerLabels[event.layer]}状态`;
    case "ink":
      return (
        layerLabels[event.layer] +
        inkLabels[event.operation] +
        (event.finish && event.finish !== "up" ? "（中断收笔）" : "")
      );
    case "answer":
      return "作答变化";
    case "hint":
      if (event.action === "shown" && event.requestId.startsWith("restored-"))
        return `已呈现此前解锁的提示 ${event.index + 1}`;
      return `${hintLabels[event.action]} ${event.index + 1}`;
    case "activity":
      if (event.action === "submit" && event.scope === "attempt")
        return "整卷提交请求";
      if (
        (event.action === "paper_open" || event.action === "paper_close") &&
        event.layer &&
        event.layer !== "scratch"
      )
        return `${event.action === "paper_open" ? "展开" : "收起"}${event.layer === "answer" ? "手写作答纸" : "圈画工具"}`;
      return activityLabels[event.action];
    case "boundary":
      return boundaryLabels[event.reason];
  }
}

function SegmentPlayer({
  question,
  segments,
}: {
  question: QuestionProcessRead["question"];
  segments: QuestionProcessRead["segments"];
}) {
  const range = useId();
  const markers = useId();
  const timeline = useMemo(() => questionTimeline(segments), [segments]);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [realTime, setRealTime] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const pauses = useMemo(
    () => (realTime ? [] : processPauses(timeline.events)),
    [realTime, timeline.events],
  );
  const start = timeline.events[0]?.at ?? 0;
  const [time, setTime] = useState(start);
  const [selected, setSelected] = useState<number | undefined>();
  const [playing, setPlaying] = useState(false);
  const playFrom = useRef(0);
  const tail = timeline.events.at(-1)?.event;
  const end = timeline.events.at(-1)?.at ?? 0;
  const playbackEnd = toPlaybackTime(end, pauses);
  const periods = useMemo(() => focusPeriods(timeline), [timeline]);
  const state = useMemo(
    () => timelineFrame(timeline, time, selected),
    [timeline, time, selected],
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
    const start = toPlaybackTime(playFrom.current, pauses);
    let origin: number | undefined;
    let handle = 0;
    const tick = (now: number) => {
      origin ??= now;
      const advanced = advancePlayhead(start, now - origin, speed, playbackEnd);
      const next = fromPlaybackTime(advanced.timeMs, pauses);
      playFrom.current = next;
      setTime(next);
      if (!advanced.ended) handle = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, pauses, speed, playbackEnd]);
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
      <p className="text-sm text-muted-foreground">
        本段起始笔迹为录制前已有或恢复的状态，未采集的书写过程无法回放。
      </p>
      {segments.some((segment) => segment.gap) && (
        <p role="status">记录有缺失，已显示可回放的部分。</p>
      )}
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
        {REPLAY_SPEEDS.map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={speed === value}
            onClick={() => setSpeed(value)}
          >
            {value}×
          </Button>
        ))}
        <label>
          <input
            type="checkbox"
            checked={realTime}
            onChange={(event) => setRealTime(event.currentTarget.checked)}
          />{" "}
          按真实时间
        </label>
        <label>
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(event) => setShowDeleted(event.currentTarget.checked)}
          />{" "}
          看擦改
        </label>
        <label htmlFor={range}>回放时刻</label>
        <input
          id={range}
          className="min-w-24 flex-1"
          type="range"
          min={start}
          max={playbackEnd}
          step={1}
          list={markers}
          value={Math.round(toPlaybackTime(time, pauses))}
          onChange={(event) => {
            setPlaying(false);
            setSelected(undefined);
            setTime(
              fromPlaybackTime(Number(event.currentTarget.value), pauses),
            );
          }}
        />
        <span className="tabular-nums">{(time / 1000).toFixed(1)} 秒</span>
      </div>
      {periods.length > 0 && (
        <div
          role="img"
          aria-label={`在本题区间：${periods.map((period) => `${(period.startMs / 1000).toFixed(1)}到${(period.endMs / 1000).toFixed(1)}秒`).join("；")}`}
          className="relative h-2 rounded bg-muted"
        >
          {periods.map((period) => (
            <span
              key={`${period.segmentId}:${period.startMs}`}
              className="absolute h-full rounded bg-blue-500"
              style={{
                left: `${(100 * (toPlaybackTime(period.startMs, pauses) - start)) / Math.max(1, playbackEnd - start)}%`,
                width: `${(100 * (toPlaybackTime(period.endMs, pauses) - toPlaybackTime(period.startMs, pauses))) / Math.max(1, playbackEnd - start)}%`,
              }}
            />
          ))}
        </div>
      )}
      <datalist id={markers}>
        {pauses.map((pause) => (
          <option
            key={pause.startMs}
            value={toPlaybackTime(pause.endMs, pauses)}
            label={`停顿 ${(pause.realMs / 1000).toFixed(0)} 秒`}
          />
        ))}
      </datalist>
      {pauses.length > 0 && (
        <p data-slot="process-pauses" className="text-sm text-muted-foreground">
          {pauses
            .map((pause) => `停顿 ${(pause.realMs / 1000).toFixed(0)} 秒`)
            .join("；")}
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <section aria-label="回放题面" className="min-w-0 space-y-2">
          {annotation ? (
            <ProcessInk
              key={annotation.baseId}
              surface={annotation}
              visiblePoints={state.visiblePoints.annotation}
              removed={showDeleted ? state.removedSince.annotation : undefined}
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
            <ProcessInk
              surface={state.layers.scratch}
              visiblePoints={state.visiblePoints.scratch}
              removed={showDeleted ? state.removedSince.scratch : undefined}
              annotation={false}
            />
          </section>
        )}
        {state.layers.answer && (
          <section aria-label="回放手写作答" className="min-w-0">
            <ProcessInk
              surface={state.layers.answer}
              visiblePoints={state.visiblePoints.answer}
              removed={showDeleted ? state.removedSince.answer : undefined}
              annotation={false}
            />
          </section>
        )}
      </div>
      <ol
        className="max-h-48 overflow-auto rounded border p-2 text-sm"
        aria-label="过程事件"
      >
        {timeline.events.map((entry, index) => (
          <li key={`${entry.segment.id}:${entry.event.seq}`}>
            <button
              type="button"
              className="min-h-8 w-full rounded px-2 text-left hover:bg-muted"
              aria-current={selected === index ? "step" : undefined}
              data-process-segment={entry.segment.id}
              onClick={() => {
                setPlaying(false);
                setSelected(index);
                setTime(entry.at);
              }}
            >
              {(entry.at / 1000).toFixed(1)} 秒 ·{" "}
              {entry.event.kind === "start" && entry.segmentIndex > 0
                ? `刷新重进 · 间隔 ${(entry.gapMs / 1000).toFixed(1)} 秒${entry.overlap ? "（采集段时间重叠，可按段查看）" : ""}`
                : eventLabel(entry.event)}
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
  const [index, setIndex] = useState(-1);
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
  const segments =
    index < 0
      ? query.data.segments
      : query.data.segments.filter((_, i) => i === index);
  if (segments.length === 0) return <p>这道题暂无可回放的过程记录。</p>;
  return (
    <>
      {query.data.segments.length > 1 && (
        <label className="text-sm">
          回放范围{" "}
          <select
            value={index}
            onChange={(event) => setIndex(Number(event.currentTarget.value))}
          >
            <option value={-1}>整题</option>
            {query.data.segments.map((item, i) => (
              <option key={item.id} value={i}>
                第 {i + 1} 段
              </option>
            ))}
          </select>
        </label>
      )}
      <SegmentPlayer
        key={index}
        question={query.data.question}
        segments={segments}
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
