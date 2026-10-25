import { useQueryClient } from "@tanstack/react-query";
import {
  AI_PROMPT_BODY_MAX_CHARS,
  type AiPromptSettingsData,
  type AiPromptSlotState,
} from "@tutor/contract";
import { Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useSettingsNavigation } from "@/features/teacher-settings/settings-navigation";
import { ApiError } from "@/lib/api";
import {
  teacherAiPromptsDraftKey,
  teacherAiPromptsKey,
  useSaveTeacherAiPrompts,
  useTeacherAiPrompts,
} from "./ai-prompt-queries";

/**
 * 教师设置「AI 提示词」区（hall-9533）：出题助手开场指令、学情数据包五个
 * 任务目标、单题复习包（教师域）指令的编辑与恢复默认。
 * - 只改本地草稿（queryClient 缓存，切分类不丢），保存才 PUT 变化槽位；
 * - 保存时正文与默认一致 → 提交 null（删覆盖行 = 恢复默认，不存冗余默认行）；
 * - 409 AI_SETTINGS_STALE 不自动覆盖输入：显示冲突并提供显式「放弃本地
 *   更改并重新加载」；其余失败保留编辑可重试；
 * - 复用设置页离开确认（settings-navigation，id=ai-prompts）。
 */

/** 分组展示顺序与标题（契约 group 枚举的中文文案，单源展示） */
const GROUP_LABELS: Record<AiPromptSlotState["group"], string> = {
  "content-ai": "AI 出题助手",
  "learning-pack": "学情数据包（导出给 AI 的 prompt.md）",
  "review-pack": "单题复习包（教师域）",
};

const GROUP_ORDER: ReadonlyArray<AiPromptSlotState["group"]> = [
  "content-ai",
  "learning-pack",
  "review-pack",
];

/** 本地草稿：槽位键 → 正文（与 baseline 同形；null = 无草稿） */
type PromptsDraft = Record<string, string>;

function toBaseline(data: AiPromptSettingsData): {
  bodies: PromptsDraft;
  slotsByKey: Record<string, AiPromptSlotState>;
} {
  const bodies: PromptsDraft = {};
  const slotsByKey: Record<string, AiPromptSlotState> = {};
  for (const slot of data.slots) {
    bodies[slot.key] = slot.body;
    slotsByKey[slot.key] = slot;
  }
  return { bodies, slotsByKey };
}

export function TeacherAiPromptsSection() {
  const promptsQuery = useTeacherAiPrompts();
  const saveMutation = useSaveTeacherAiPrompts();
  const queryClient = useQueryClient();
  const navigation = useSettingsNavigation();
  const [draft, setDraft] = useState<PromptsDraft | null>(
    () =>
      queryClient.getQueryData<PromptsDraft>(teacherAiPromptsDraftKey) ?? null,
  );
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);

  const data = promptsQuery.data;
  const baseline = useMemo(() => (data ? toBaseline(data) : null), [data]);
  const checked = draft ?? baseline?.bodies ?? null;
  const dirty =
    baseline !== null &&
    checked !== null &&
    Object.keys(baseline.bodies).some(
      (key) => checked[key] !== baseline.bodies[key],
    );
  // 变化中的槽位存在空正文 → 不能保存（清空请用「恢复默认」提交 null）
  const blankChanged =
    baseline !== null &&
    checked !== null &&
    Object.keys(baseline.bodies).some(
      (key) =>
        checked[key] !== baseline.bodies[key] &&
        (checked[key] ?? "").trim().length === 0,
    );

  useEffect(() => {
    queryClient.setQueryDefaults(teacherAiPromptsDraftKey, {
      gcTime: Infinity,
    });
    queryClient.setQueryData(teacherAiPromptsDraftKey, draft);
  }, [queryClient, draft]);
  const setNavigationDraft = navigation?.setDraft;
  useEffect(() => {
    setNavigationDraft?.("ai-prompts", {
      dirty,
      discard: () => {
        setDraft(null);
        queryClient.removeQueries({ queryKey: teacherAiPromptsDraftKey });
      },
    });
    return () =>
      setNavigationDraft?.("ai-prompts", {
        dirty: false,
        discard: () => {},
      });
  }, [dirty, queryClient, setNavigationDraft]);

  function setSlotDraft(key: string, value: string): void {
    if (baseline === null) return;
    setDraft((prev) => ({ ...(prev ?? baseline.bodies), [key]: value }));
    setSaved(false);
    setConflict(false);
  }

  function resetSlot(key: string): void {
    if (baseline === null) return;
    setSlotDraft(key, baseline.slotsByKey[key]?.defaultBody ?? "");
  }

  function handleSave(): void {
    if (baseline === null || checked === null || data === undefined) return;
    const updates = Object.keys(baseline.bodies)
      .filter((key) => checked[key] !== baseline.bodies[key])
      .map((key) => {
        const text = checked[key] ?? "";
        return {
          key: key as AiPromptSlotState["key"],
          // 与默认正文一致 = 恢复默认（提交 null 删覆盖行）
          body:
            text.trim() === (baseline.slotsByKey[key]?.defaultBody ?? "").trim()
              ? null
              : text,
        };
      });
    if (updates.length === 0) return;
    saveMutation.mutate(
      { updates, baseUpdatedAt: data.updatedAt },
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
      <section
        aria-labelledby="teacher-ai-prompts-title"
        className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground"
      >
        <Loader2 aria-hidden className="mr-2 inline size-4 animate-spin" />
        正在加载 AI 提示词…
      </section>
    );
  }
  if (promptsQuery.isError || baseline === null) {
    return (
      <section
        aria-labelledby="teacher-ai-prompts-title"
        className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive"
      >
        <TriangleAlert aria-hidden className="mr-2 inline size-4" />
        AI 提示词加载失败：
        {promptsQuery.error instanceof Error
          ? promptsQuery.error.message
          : "请稍后重试"}
        <Button
          type="button"
          variant="outline"
          className="ml-3 min-h-9 px-3"
          onClick={() => void promptsQuery.refetch()}
        >
          重试
        </Button>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="teacher-ai-prompts-title"
      className="rounded-xl border border-border bg-card"
    >
      <div className="border-b border-border p-5 sm:p-6">
        <h2 id="teacher-ai-prompts-title" className="text-lg font-semibold">
          AI 提示词（导出给 AI 的指令）
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          出题助手、学情数据包与单题复习包交给 AI
          使用的提示词，可按场景自定义；保存后下一次复制或导出立即生效。
        </p>
      </div>
      {GROUP_ORDER.map((group) => (
        <div
          key={group}
          className="border-b border-border p-5 last:border-b-0 sm:p-6"
        >
          <h3 className="text-sm font-semibold">{GROUP_LABELS[group]}</h3>
          {baseline.slotsByKey &&
            data?.slots
              .filter((slot) => slot.group === group)
              .map((slot) => {
                const isChanged =
                  checked !== null &&
                  checked[slot.key] !== baseline.bodies[slot.key];
                return (
                  <div key={slot.key} className="mt-4 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label
                        htmlFor={`ai-prompt-${slot.key}`}
                        className="text-sm font-medium"
                      >
                        {slot.title}
                        {slot.isCustom ? (
                          <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
                            已自定义
                          </span>
                        ) : null}
                        {isChanged ? (
                          <span className="ml-2 text-xs font-medium text-primary">
                            未保存
                          </span>
                        ) : null}
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-h-9 px-3 text-xs"
                        disabled={
                          checked !== null &&
                          checked[slot.key] === slot.defaultBody
                        }
                        onClick={() => resetSlot(slot.key)}
                      >
                        <RotateCcw aria-hidden className="mr-1 size-3.5" />
                        恢复默认
                      </Button>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {slot.description}
                    </p>
                    <textarea
                      id={`ai-prompt-${slot.key}`}
                      value={checked?.[slot.key] ?? ""}
                      onChange={(event) =>
                        setSlotDraft(slot.key, event.target.value)
                      }
                      rows={slot.group === "content-ai" ? 3 : 9}
                      maxLength={AI_PROMPT_BODY_MAX_CHARS}
                      aria-label={`${slot.title}提示词正文`}
                      className="min-h-24 w-full resize-y rounded-lg border border-border bg-background p-3 font-mono text-xs leading-5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    />
                  </div>
                );
              })}
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-5 sm:p-6">
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
                  void queryClient.invalidateQueries({
                    queryKey: teacherAiPromptsKey,
                  });
                }}
              >
                放弃本地更改并重新加载
              </button>
              ，或把本页内容复制留底后重试。
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
              有槽位正文为空：请填写内容，或用「恢复默认」提交默认值。
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
            "保存全部改动"
          )}
        </Button>
      </div>
    </section>
  );
}
