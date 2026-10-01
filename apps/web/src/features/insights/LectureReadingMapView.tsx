import type {
  AnalyticsLectureFoldRow,
  AnalyticsLectureMapEntry,
  AnalyticsLectureSectionRow,
  AnalyticsLectureStepsRow,
} from "@tutor/contract";
import { Info, TriangleAlert } from "lucide-react";
import { formatActiveSec } from "@/features/teacher-attempts/AttemptDetailQuestionCard";
import { formatCnTime } from "@/lib/time";
import {
  FOLD_NAME_LABELS,
  FOLD_STATUS_LABELS,
  formatPercent,
  SECTION_STATUS_LABELS,
  STEPS_STATUS_LABELS,
} from "./insights-format";

/**
 * 讲义阅读地图（T4.2，消费 T4.0b 服务端聚合，T4.0 方案 §4.4.4）：
 * - 讲义目录树逐项状态标记——节（未到达/掠过/部分/已读/细读）、折叠指令
 *   （未打开/打开未读/已读，按 hostHeadingIndex 挂到所属节下）、steps 容器
 *   （未开始/连点跳过/逐步阅读/未走完）；
 * - 节与折叠同时展示 rawDwell 与 dwell：「停留 X（含挂机 Y）」——raw 是
 *   可见∩聚焦的原始停留、dwell 是扣 idle 后的有效停留，差值即挂机；
 * - **显著标注「行为推断，非注意力测量」**（方案前提 3：判定是时间代理，
 *   只标记不下结论），逐讲义渲染、不容教师错过；
 * - 折叠/步骤状态徽章配色：未读类琥珀、已读类绿、连点跳过红。
 */

/** 节状态徽章配色（薄弱状态显著，方便扫读） */
const SECTION_BADGE_CLASS: Record<
  AnalyticsLectureSectionRow["status"],
  string
> = {
  "not-reached": "bg-muted text-muted-foreground",
  skimmed: "bg-red-500/10 text-red-700 dark:text-red-300",
  partial: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  read: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  deep: "bg-emerald-500 font-medium text-white",
};

/** 折叠状态徽章配色 */
const FOLD_BADGE_CLASS: Record<AnalyticsLectureFoldRow["status"], string> = {
  "not-opened": "bg-muted text-muted-foreground",
  "opened-unread": "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  read: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

/** steps 状态徽章配色（连点跳过是异常信号，用红） */
const STEPS_BADGE_CLASS: Record<AnalyticsLectureStepsRow["status"], string> = {
  "not-started": "bg-muted text-muted-foreground",
  "rush-skipped": "bg-red-500/10 text-red-700 dark:text-red-300",
  "step-by-step": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  incomplete: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};

/** 「停留 X（含挂机 Y）」：raw 与 dwell 相同则不显示挂机段 */
function dwellLine(rawSec: number, dwellSec: number): string {
  const base = `停留 ${formatActiveSec(dwellSec)}`;
  if (rawSec > dwellSec) {
    return `${base}（含挂机 ${formatActiveSec(rawSec - dwellSec)}）`;
  }
  return base;
}

/** 一行折叠指令（挂在所属节下，缩进呈现） */
function FoldRow({ fold }: { fold: AnalyticsLectureFoldRow }) {
  return (
    <li className="ml-4 flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-l border-border pl-3">
      <span className="text-xs text-muted-foreground">
        {FOLD_NAME_LABELS[fold.name] ?? fold.name}
      </span>
      <span
        className={`rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${FOLD_BADGE_CLASS[fold.status]}`}
      >
        {FOLD_STATUS_LABELS[fold.status]}
      </span>
      <span className="text-xs text-muted-foreground">
        打开 {fold.openCount} 次 · {dwellLine(fold.rawDwellSec, fold.dwellSec)}
      </span>
    </li>
  );
}

/** 一行 steps 容器（挂在所属节下，缩进呈现） */
function StepsRow({ row }: { row: AnalyticsLectureStepsRow }) {
  return (
    <li className="ml-4 flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-l border-border pl-3">
      <span className="text-xs text-muted-foreground">分步演示</span>
      <span
        className={`rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${STEPS_BADGE_CLASS[row.status]}`}
      >
        {STEPS_STATUS_LABELS[row.status]}
      </span>
      <span className="text-xs text-muted-foreground">
        走到第 {row.revealedCount} / {row.total} 步
      </span>
    </li>
  );
}

/** 一节（含挂在其下的折叠指令与 steps 容器） */
function SectionRow({
  section,
  folds,
  steps,
}: {
  section: AnalyticsLectureSectionRow;
  folds: AnalyticsLectureFoldRow[];
  steps: AnalyticsLectureStepsRow[];
}) {
  return (
    <li className="flex flex-col">
      <div
        className={`flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 ${
          section.level === 3 ? "ml-5" : ""
        }`}
      >
        {section.level === 3 && (
          <span aria-hidden className="text-xs text-muted-foreground">
            └
          </span>
        )}
        <span className={`text-sm ${section.level === 2 ? "font-medium" : ""}`}>
          {section.text}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${SECTION_BADGE_CLASS[section.status]}`}
        >
          {SECTION_STATUS_LABELS[section.status]}
        </span>
        <span className="text-xs text-muted-foreground">
          {dwellLine(section.rawDwellSec, section.dwellSec)} · 预期{" "}
          {formatActiveSec(section.expectedSec)}
        </span>
      </div>
      {(folds.length > 0 || steps.length > 0) && (
        <ul className="flex flex-col gap-0.5">
          {folds.map((fold) => (
            <FoldRow key={`fold-${fold.docIndex}`} fold={fold} />
          ))}
          {steps.map((step) => (
            <StepsRow key={`steps-${step.docIndex}`} row={step} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** 一篇讲义的阅读地图（汇总条 + 目录树） */
function LectureMap({ entry }: { entry: AnalyticsLectureMapEntry }) {
  const { map } = entry;
  // 折叠/步骤按 hostHeadingIndex 挂到所属节；对不上任何节的保守放「文档其他位置」
  const foldsByHost = new Map<number, AnalyticsLectureFoldRow[]>();
  const stepsByHost = new Map<number, AnalyticsLectureStepsRow[]>();
  const orphanFolds: AnalyticsLectureFoldRow[] = [];
  const orphanSteps: AnalyticsLectureStepsRow[] = [];
  const hostIndexes = new Set(
    map.sections.map((section) => section.headingIndex),
  );
  for (const fold of map.folds) {
    if (hostIndexes.has(fold.hostHeadingIndex)) {
      const bucket = foldsByHost.get(fold.hostHeadingIndex) ?? [];
      bucket.push(fold);
      foldsByHost.set(fold.hostHeadingIndex, bucket);
    } else {
      orphanFolds.push(fold);
    }
  }
  for (const step of map.steps) {
    if (hostIndexes.has(step.hostHeadingIndex)) {
      const bucket = stepsByHost.get(step.hostHeadingIndex) ?? [];
      bucket.push(step);
      stepsByHost.set(step.hostHeadingIndex, bucket);
    } else {
      orphanSteps.push(step);
    }
  }

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold">{entry.title}</h4>
        <span className="text-xs text-muted-foreground">
          版本时间 {formatCnTime(entry.updatedAt)}
        </span>
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>节覆盖 {formatPercent(map.summary.sectionCoverage)}</span>
        <span>阅读 {formatActiveSec(map.summary.readSec)}</span>
        <span>折叠打开 {formatPercent(map.summary.foldOpenRate)}</span>
        <span>提示 {map.summary.hintOpenCount} 次</span>
        <span>解析 {map.summary.solutionOpenCount} 次</span>
        <span>
          连点跳过 {map.summary.stepsRushContainerCount} /{" "}
          {map.summary.stepsTotalContainers} 组
        </span>
        {map.summary.degradedEventCount > 0 && (
          <span className="flex items-center gap-1 text-amber-700 dark:text-amber-300">
            <TriangleAlert aria-hidden className="size-3" />
            {map.summary.degradedEventCount} 条旧版本事件未定位
          </span>
        )}
      </p>
      <ul className="flex flex-col gap-0.5">
        {map.sections.map((section) => (
          <SectionRow
            key={section.headingIndex}
            section={section}
            folds={foldsByHost.get(section.headingIndex) ?? []}
            steps={stepsByHost.get(section.headingIndex) ?? []}
          />
        ))}
        {(orphanFolds.length > 0 || orphanSteps.length > 0) && (
          <li className="flex flex-col">
            <p className="min-h-11 py-2 text-xs text-muted-foreground">
              文档其他位置（未对应到现存小节）
            </p>
            <ul className="flex flex-col gap-0.5">
              {orphanFolds.map((fold) => (
                <FoldRow key={`orphan-fold-${fold.docIndex}`} fold={fold} />
              ))}
              {orphanSteps.map((step) => (
                <StepsRow key={`orphan-steps-${step.docIndex}`} row={step} />
              ))}
            </ul>
          </li>
        )}
      </ul>
    </li>
  );
}

/** 讲义阅读地图区（多讲义列表 + 行为推断标注） */
export function LectureReadingMapView({
  entries,
}: {
  entries: AnalyticsLectureMapEntry[];
}) {
  return (
    <section aria-label="讲义阅读地图" className="flex flex-col gap-3">
      <div
        role="note"
        className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/40 dark:text-amber-200"
      >
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        <p>
          <b>行为推断，非注意力测量：</b>
          以下「已读 / 细读 / 连点跳过」等状态由停留时长与操作节奏推断（时间
          代理），仅供教学参考，不能据此对学生下注意力结论。
        </p>
      </div>
      {entries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          时间范围内该生还没有讲义阅读记录。
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map((entry) => (
            <LectureMap key={entry.lectureId} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}
