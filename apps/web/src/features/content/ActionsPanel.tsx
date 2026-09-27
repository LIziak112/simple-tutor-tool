import type { ImportAction, ImportPreviewData } from "@tutor/contract";
import { CircleAlert, ListChecks } from "lucide-react";

/**
 * 导入动作清单面板（T2A.3，D19：预览必须展示「将发生什么」）：
 * - 动作清单：新增/更新单元（含题目细分：新增 n、更新 n（version+1）、保留 n）、
 *   新增/更新讲义、从回收站恢复标注；
 * - 注意事项：D18/D19 的导入 warning（其他文件夹同名讲义、保留题、未截止作业）。
 * 单文件预览与批量展开行共用。
 */

/** 动作 → 中文文案（folderName null = 未归类） */
export function formatImportAction(action: ImportAction): string {
  const where =
    action.folderName === null ? "未归类" : `文件夹「${action.folderName}」`;
  const restore = action.restore ? "；将从回收站恢复" : "";
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
      return `新增讲义「${action.title}」（${where}）${restore}`;
    case "updateLecture":
      return `更新讲义「${action.title}」（位于${where}）${restore}`;
  }
}

export function ActionsPanel({ preview }: { preview: ImportPreviewData }) {
  if (preview.actions.length === 0 && preview.warnings.length === 0) {
    return null;
  }
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
            {preview.actions.map((action) => (
              <li
                key={`${action.kind}-${action.unitId ?? action.title}`}
                className="text-sm"
              >
                {formatImportAction(action)}
              </li>
            ))}
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
