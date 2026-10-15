import { useQueryClient } from "@tanstack/react-query";
import type { AiPolicyInheritableMode } from "@tutor/contract";
import { Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AiPolicySubjectRef } from "@/lib/api";
import {
  aiPolicyOverrideDraftKey,
  useAiPolicyOverride,
  usePutAiPolicyOverride,
  useTeacherAiSettings,
} from "./ai-policy-queries";
import { AI_INHERITABLE_MODE_LABELS, aiResolutionText } from "./ai-policy-text";

/**
 * SAI-07 学生 / 作业的 AI 策略覆盖组件（需求 §3.1–3.2、§11 草图）：
 * - 单选「继承（当前：教师默认）」+ 三显式模式；「有效结果」以服务端
 *   resolution 单源拼装（保存后按返回值回显）；本地改动只做单层展示预览，
 *   不在前端复算两层合并真值表；
 * - 暂存草稿（queryClient 缓存，弹层重开不丢），显式「保存 AI 策略」才 PUT；
 * - 静态说明另一对象的明确关闭优先（学生关 + 作业开 = 关），不把本层
 *   「开放」误称最终开放；AI 复盘可能早于普通答案公布；
 * - dirty 变化经 onDirtyChange 上报宿主（作业编辑弹层的关闭守卫）。
 */

/** 显式三模式单选（不含 inherit，继承标签单独拼教师默认值） */
const EXPLICIT_MODES: ReadonlyArray<{
  value: Exclude<AiPolicyInheritableMode, "inherit">;
  description: string;
}> = [
  {
    value: "open_study",
    description: "作答中即可求助，AI 参考已有答案解析提供完整帮助。",
  },
  {
    value: "guided_only",
    description: "作答中只给思路提示，不给最终答案。",
  },
  {
    value: "post_submit_only",
    description: "本题完成后才可求助，作答中不可用。",
  },
];

/** 另一对象明确关闭优先的静态说明（需求 §3.2 两步规则第 1 步） */
function crossLayerNote(subjectType: "student" | "assignment"): string {
  return subjectType === "student"
    ? "另一处的明确关闭优先：若某份作业单独设置为「完成后可用」，该作业作答中仍不可用；在这里选择「开放伴学」不能绕过作业的关闭。"
    : "另一处的明确关闭优先：若某学生单独设置为「完成后可用」，本作业选择开放也不能让其在作答中使用；本作业选择「完成后可用」时，即便学生侧是开放，作答中同样不可用。";
}

export function AiPolicyOverrideField({
  subject,
  onDirtyChange,
}: {
  subject: AiPolicySubjectRef;
  /** dirty 变化上报（宿主并入自己的关闭守卫） */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const overrideQuery = useAiPolicyOverride(subject);
  const settingsQuery = useTeacherAiSettings();
  const putMutation = usePutAiPolicyOverride();
  const queryClient = useQueryClient();
  const draftKey = useMemo(
    () => aiPolicyOverrideDraftKey(subject.type, subject.id),
    [subject.type, subject.id],
  );
  const [draft, setDraft] = useState<AiPolicyInheritableMode | null>(
    // getQueryData 未命中返回 undefined，折算 null 表示「无草稿」
    () => queryClient.getQueryData<AiPolicyInheritableMode>(draftKey) ?? null,
  );

  const data = overrideQuery.data;
  const checked = draft ?? data?.mode;
  const dirty = data !== undefined && checked !== data.mode;

  useEffect(() => {
    queryClient.setQueryDefaults(draftKey, { gcTime: Infinity });
    queryClient.setQueryData(draftKey, draft);
  }, [queryClient, draft, draftKey]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  /** 教师默认模式（「继承（当前：…）」标签与继承态预览） */
  const teacherDefault = settingsQuery.data?.defaultMode;

  /**
   * 有效结果：无本地改动用服务端 resolution（单源）；有改动只做单层
   * 展示预览（继承 → 教师默认；显式值 → 对应模式/不可用），保存后
   * 以 PUT 返回的服务端裁决为准。
   */
  const resolutionText =
    data === undefined || checked === undefined
      ? null
      : dirty
        ? checked === "inherit"
          ? `${
              teacherDefault !== undefined
                ? AI_INHERITABLE_MODE_LABELS[teacherDefault]
                : "教师默认"
            }（跟随你的默认设置）`
          : checked === "post_submit_only"
            ? `作答中不可用（来自${subject.type === "student" ? "学生" : "作业"}设置）`
            : `${AI_INHERITABLE_MODE_LABELS[checked]}（来自${
                subject.type === "student" ? "学生" : "作业"
              }设置）`
        : aiResolutionText(data.resolution);

  const subjectNoun = subject.type === "student" ? "学生" : "作业";

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-sm">AI 伴学策略</legend>

      {overrideQuery.isPending && (
        <p className="text-sm text-muted-foreground">正在加载 AI 策略…</p>
      )}
      {overrideQuery.isError && (
        <div>
          <p role="alert" className="text-sm text-destructive">
            无法加载 AI 策略，请重试。
          </p>
          <Button
            variant="outline"
            className="mt-3 min-h-11"
            onClick={() => void overrideQuery.refetch()}
          >
            重新加载
          </Button>
        </div>
      )}

      {checked !== undefined && (
        <>
          <div className="flex flex-col gap-1">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-1 text-sm">
              <input
                type="radio"
                name={`ai-policy-${subject.type}-${subject.id}`}
                aria-label={`继承${
                  teacherDefault !== undefined
                    ? `（当前：${AI_INHERITABLE_MODE_LABELS[teacherDefault]}）`
                    : "（跟随教师默认）"
                }`}
                className="size-5 accent-primary"
                checked={checked === "inherit"}
                onChange={() => setDraft("inherit")}
              />
              <span>
                继承
                {teacherDefault !== undefined
                  ? `（当前：${AI_INHERITABLE_MODE_LABELS[teacherDefault]}）`
                  : "（跟随教师默认）"}
              </span>
            </label>
            {EXPLICIT_MODES.map(({ value, description }) => (
              <label
                key={value}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-1 text-sm"
              >
                <span className="flex min-h-11 min-w-11 items-center justify-center">
                  <input
                    type="radio"
                    name={`ai-policy-${subject.type}-${subject.id}`}
                    aria-label={AI_INHERITABLE_MODE_LABELS[value]}
                    className="size-5 accent-primary"
                    checked={checked === value}
                    onChange={() => setDraft(value)}
                  />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">
                    {AI_INHERITABLE_MODE_LABELS[value]}
                  </span>
                  <span className="mt-0.5 block max-w-[54ch] text-xs leading-relaxed text-muted-foreground">
                    {description}
                  </span>
                </span>
              </label>
            ))}
          </div>

          {resolutionText !== null && (
            <p className="text-sm">
              <span className="text-muted-foreground">有效结果：</span>
              {resolutionText}
            </p>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {crossLayerNote(subject.type)}
            本题完成后 AI 复盘恒可用，可能早于普通答案公布。
          </p>

          {putMutation.isError && (
            <p
              role="alert"
              className="flex items-start gap-2 text-sm text-destructive"
            >
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {putMutation.error instanceof Error
                ? putMutation.error.message
                : "保存失败"}
              。更改仍保留，请重试保存。
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="status" className="text-xs text-muted-foreground">
              {putMutation.isPending
                ? "正在保存…"
                : dirty
                  ? "有未保存的更改"
                  : putMutation.isSuccess
                    ? "更改已保存"
                    : `当前${subjectNoun}策略已保存`}
            </p>
            <Button
              type="button"
              className="min-h-11 px-5"
              disabled={putMutation.isPending || !dirty}
              onClick={() =>
                putMutation.mutate(
                  { subject, mode: checked },
                  { onSuccess: () => setDraft(null) },
                )
              }
            >
              {putMutation.isPending && (
                <Loader2 aria-hidden className="motion-safe:animate-spin" />
              )}
              保存 AI 策略
            </Button>
          </div>
        </>
      )}
    </fieldset>
  );
}
