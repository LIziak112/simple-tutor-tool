import { AI_PROMPT_BODY_MAX_CHARS } from "@tutor/contract";
import { Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import {
  useSaveStudentAiPrompts,
  useStudentAiPrompts,
} from "./ai-prompt-queries";

/**
 * 学生设置「复习包 AI 提示词」区（hall-9533）：导出「单题复习包」给 AI
 * 自助复习时使用的指令（角色 + 任务段），可自定义并随时恢复默认。
 * - 编辑只改本地草稿，保存才 PUT（与默认正文一致 → 提交 null = 恢复默认）；
 * - 409 AI_SETTINGS_STALE 显示冲突并提供「放弃本地更改并重新加载」；
 * - 附件清单、数据说明、红线等系统段不受自定义影响（服务端固定生成）。
 */
export function StudentAiPromptsSection({
  onDirtyChange,
}: {
  onDirtyChange?: (dirty: boolean) => void;
} = {}) {
  const promptsQuery = useStudentAiPrompts();
  const saveMutation = useSaveStudentAiPrompts();
  const [draft, setDraft] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);

  const data = promptsQuery.data;
  const slot = data?.slots[0];
  const baselineBody = slot?.body ?? "";
  const checked = draft ?? baselineBody;
  const dirty = draft !== null && draft !== baselineBody;
  const blankChanged = dirty && checked.trim().length === 0;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  function setDraftValue(value: string): void {
    setDraft(value);
    setSaved(false);
    setConflict(false);
  }

  function handleSave(): void {
    if (slot === undefined || data === undefined) return;
    saveMutation.mutate(
      {
        updates: [
          {
            key: slot.key,
            // 与默认正文一致 = 恢复默认（提交 null 删覆盖行）
            body: checked.trim() === slot.defaultBody.trim() ? null : checked,
          },
        ],
        baseUpdatedAt: data.updatedAt,
      },
      {
        onSuccess: () => {
          setDraft(null);
          setConflict(false);
          setSaved(true);
        },
        onError: (error) => {
          if (error instanceof ApiError && error.code === "AI_SETTINGS_STALE") {
            setConflict(true);
          }
        },
      },
    );
  }

  if (promptsQuery.isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 aria-hidden className="size-4 animate-spin" />
        正在加载复习包提示词…
      </p>
    );
  }
  if (promptsQuery.isError || slot === undefined) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm text-destructive">
        <span className="flex items-start gap-1.5">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          复习包提示词加载失败：
          {promptsQuery.error instanceof Error
            ? promptsQuery.error.message
            : "请稍后重试"}
        </span>
        <Button
          type="button"
          variant="outline"
          className="min-h-9 px-3"
          onClick={() => void promptsQuery.refetch()}
        >
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label
          htmlFor="student-ai-prompt-review-pack"
          className="text-sm font-medium"
        >
          {slot.title}
          {slot.isCustom ? (
            <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
              已自定义
            </span>
          ) : null}
          {dirty ? (
            <span className="ml-2 text-xs font-medium text-primary">
              未保存
            </span>
          ) : null}
        </label>
        <Button
          type="button"
          variant="ghost"
          className="min-h-9 px-3 text-xs"
          disabled={checked === slot.defaultBody}
          onClick={() => setDraftValue(slot.defaultBody)}
        >
          <RotateCcw aria-hidden className="mr-1 size-3.5" />
          恢复默认
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {slot.description}
      </p>
      <textarea
        id="student-ai-prompt-review-pack"
        value={checked}
        onChange={(event) => setDraftValue(event.target.value)}
        rows={9}
        maxLength={AI_PROMPT_BODY_MAX_CHARS}
        aria-label="单题复习包提示词正文"
        className="min-h-40 w-full resize-y rounded-lg border border-border bg-background p-3 font-mono text-xs leading-5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1 text-sm">
          {conflict ? (
            <p role="alert" className="text-destructive">
              <TriangleAlert aria-hidden className="mr-1 inline size-4" />
              提示词已在其他页面被修改。可
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => {
                  setDraft(null);
                  setConflict(false);
                  void promptsQuery.refetch();
                }}
              >
                放弃本地更改并重新加载
              </button>
              。
            </p>
          ) : null}
          {saveMutation.isError && !conflict ? (
            <p role="alert" className="text-destructive">
              <TriangleAlert aria-hidden className="mr-1 inline size-4" />
              保存失败：
              {saveMutation.error instanceof Error
                ? saveMutation.error.message
                : "请稍后重试"}
              ，已保留编辑可重试。
            </p>
          ) : null}
          {saved && !dirty ? (
            <p role="status" className="text-emerald-700 dark:text-emerald-300">
              已保存。
            </p>
          ) : null}
          {blankChanged ? (
            <p className="text-muted-foreground">
              正文为空：请填写内容，或用「恢复默认」提交默认值。
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          className="min-h-11 px-5"
          disabled={!dirty || blankChanged || saveMutation.isPending}
          onClick={handleSave}
        >
          {saveMutation.isPending ? (
            <>
              <Loader2 aria-hidden className="animate-spin" />
              正在保存…
            </>
          ) : (
            "保存"
          )}
        </Button>
      </div>
    </div>
  );
}
