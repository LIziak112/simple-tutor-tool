import type {
  DocumentKind,
  ImportAction,
  ImportPreviewData,
} from "@tutor/contract";
import { CircleAlert, ListChecks } from "lucide-react";

/**
 * 导入动作清单面板（T2A.3，D19：预览必须展示「将发生什么」）：
 * - 动作清单：新增/更新单元（含题目细分：新增 n、更新 n（version+1）、保留 n；
 *   缺省题号命中更新时行内附「N 题缺省题号，可能错位」警示徽标，P2b）、
 *   新增/更新讲义、从回收站恢复标注；
 * - 注意事项：D18/D19 的导入 warning（其他文件夹同名讲义、保留题、未截止作业、
 *   配套讲义悬空 LECTURE_LINK_UNRESOLVED）；
 * - 讲练页（kind=lesson，2026-10-15）：按「讲练页一件事」呈现——讲义动作用
 *   「讲练页」文案，单元动作降为缩进的随堂练习附注（不单独进资源库，与
 *   资源库隐藏嵌入单元的决策配套）；其余 kind 维持两条目呈现。
 * 单文件预览与批量展开行共用。
 */

/** 动作 → 中文文案（folderName null = 未归类；lesson 的讲义动作标「讲练页」） */
export function formatImportAction(
  action: ImportAction,
  docKind: DocumentKind = "practice",
): string {
  const where =
    action.folderName === null ? "未归类" : `文件夹「${action.folderName}」`;
  const restore = action.restore ? "；将从回收站恢复" : "";
  const lectureNoun = docKind === "lesson" ? "讲练页" : "讲义";
  switch (action.kind) {
    case "createUnit":
      return `新增单元「${action.title}」（${where}）${restore}`;
    case "updateUnit": {
      const q = action.questions;
      const detail =
        q === undefined
          ? ""
          : `：新增题 ${q.inserted}、更新题 ${q.updated}（version+1）、保留题 ${q.kept}`;
      return `更新单元「${action.title}」（位于${where}）${detail}${restore}`;
    }
    case "createLecture":
      return `新增${lectureNoun}「${action.title}」（${where}）${restore}`;
    case "updateLecture":
      return `更新${lectureNoun}「${action.title}」（位于${where}）${restore}`;
    // tt-06b / QM-05：材料/组动作（title 无值时服务端已用 id 兜底；材料/组不产生题行）
    case "createMaterial":
      return `新增材料「${action.title}」（${where}）${restore}`;
    case "updateMaterial":
      return `更新材料「${action.title}」（位于${where}）${restore}`;
    case "createGroup":
      return `新增题组「${action.title}」（${where}）${restore}`;
    case "updateGroup":
      return `更新题组「${action.title}」（位于${where}）${restore}`;
  }
}

/** 讲练页的随堂练习附注（lesson 的单元动作不作为顶层「更新单元」条目） */
function formatLessonPracticeNote(action: ImportAction): string {
  const q = action.questions;
  const detail =
    q === undefined
      ? ""
      : `：新增题 ${q.inserted}、更新题 ${q.updated}（version+1）、保留题 ${q.kept}`;
  return `└ 随堂练习「${action.title}」${detail}——练习存于讲练页内部，不单独进资源库`;
}

/** 「文件 → 存储名」实际名称段（方案 §5：批量表格内容列与单文件统计条共用） */
export interface ImportStorageNames {
  /** 讲义段（如 `讲义「第4讲」`；多篇 → `讲义「第4讲」等 3 篇`）；null = 无讲义动作 */
  readonly lecture: string | null;
  /** 单元段（如 `单元「练习四」`）；null = 无单元动作（lesson 时恒 null——单元不单独呈现） */
  readonly unit: string | null;
}

/**
 * 缺省题号错位警示徽标（P2b）：updateUnit 动作行内联展示「N 题缺省题号，可能错位」。
 * 服务端仅在 N>0 时携带 updatedDerived；配色与注意事项区 warning 同源（琥珀警示）。
 */
function DerivedIdRiskBadge({ count }: { count: number }) {
  return (
    <span className="ml-1.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
      {count} 题缺省题号，可能错位
    </span>
  );
}

/**
 * 动作清单 → 实际存储名称段（方案 §5：预览把「这个文件导进去会变成什么、叫什么名字」亮出来）。
 * 讲义动作取首篇名（多篇加「等 N 篇」）；单元动作取单元名（一个文件至多产出一个单元）；
 * kind=lesson 时讲义段用「讲练页」措辞、单元段不报（嵌入单元不单独显示）。
 */
export function describeImportNames(
  actions: readonly ImportAction[],
  docKind: DocumentKind = "practice",
): ImportStorageNames {
  const lectureTitles = actions
    .filter(
      (action) =>
        action.kind === "createLecture" || action.kind === "updateLecture",
    )
    .map((action) => action.title);
  const unitAction = actions.find(
    (action) => action.kind === "createUnit" || action.kind === "updateUnit",
  );
  const firstLecture = lectureTitles[0];
  const noun = docKind === "lesson" ? "讲练页" : "讲义";
  return {
    lecture:
      firstLecture === undefined
        ? null
        : lectureTitles.length > 1
          ? `${noun}「${firstLecture}」等 ${lectureTitles.length} 篇`
          : `${noun}「${firstLecture}」`,
    unit:
      docKind === "lesson" || unitAction === undefined
        ? null
        : `单元「${unitAction.title}」`,
  };
}

export function ActionsPanel({ preview }: { preview: ImportPreviewData }) {
  if (preview.actions.length === 0 && preview.warnings.length === 0) {
    return null;
  }
  const docKind = preview.summary.kind ?? "practice";
  const isLesson = docKind === "lesson";
  return (
    <section
      aria-labelledby="import-actions-heading"
      className="mt-3 rounded-xl border border-border bg-card p-4"
    >
      {preview.actions.length > 0 ? (
        <>
          <h2
            id="import-actions-heading"
            className="flex items-center gap-2 text-sm font-semibold"
          >
            <ListChecks aria-hidden className="size-4 shrink-0 text-primary" />
            将执行的动作
          </h2>
          <ul className="mt-2 space-y-1">
            {preview.actions.map((action) =>
              isLesson &&
              (action.kind === "createUnit" || action.kind === "updateUnit") ? (
                <li
                  key={`${action.kind}-${action.unitId ?? action.title}`}
                  className="text-sm text-muted-foreground"
                >
                  {formatLessonPracticeNote(action)}
                </li>
              ) : (
                <li
                  key={`${action.kind}-${action.unitId ?? action.title}`}
                  className="text-sm"
                >
                  {formatImportAction(action, docKind)}
                  {/* P2b：缺省派生 id 命中更新 → 行内标红错位风险（字段仅 N>0 携带） */}
                  {action.kind === "updateUnit" &&
                  action.questions?.updatedDerived !== undefined &&
                  action.questions.updatedDerived > 0 ? (
                    <DerivedIdRiskBadge
                      count={action.questions.updatedDerived}
                    />
                  ) : null}
                </li>
              ),
            )}
          </ul>
        </>
      ) : null}

      {preview.warnings.length > 0 ? (
        <div className={preview.actions.length > 0 ? "mt-3" : undefined}>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-600 dark:text-amber-400">
            <CircleAlert aria-hidden className="size-4 shrink-0" />
            注意事项
          </h3>
          <ul className="mt-1.5 space-y-1">
            {preview.warnings.map((warning) => (
              <li
                key={`${warning.code}-${warning.message}`}
                className="text-sm text-amber-700 dark:text-amber-300"
              >
                {warning.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
