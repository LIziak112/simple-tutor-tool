import { useQueryClient } from "@tanstack/react-query";
import type { TeacherPracticeFeedbackPolicy } from "@tutor/contract";
import { Info, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  usePracticeFeedbackSettings,
  useSavePracticeFeedbackSettings,
} from "./practice-feedback-queries";
import { useSettingsNavigation } from "./settings-navigation";

const DRAFT_KEY = ["teacher", "practice-feedback-draft"] as const;
type PracticeFeedbackDraft = TeacherPracticeFeedbackPolicy;

const OPTIONS = [
  {
    value: "student_choice" as const,
    label: "由学生选择",
    description:
      "新建的课程练习、作业（教师开启逐题反馈时）和错题重练，学生可自选「每题提交后查看」或「交卷后统一查看」。",
  },
  {
    value: "after_attempt" as const,
    label: "交卷后公布",
    description: "学生可以选做题布局，反馈节奏固定为交卷后统一查看。",
  },
] as const;

/**
 * 设置页「教学」分类的练习反馈默认策略区（M1b）：
 * 独立于 steps/ink 辅助能力开关；未配置（null）按「由学生选择」缺省展示——
 * 该缺省仅对新普通自由练习生效，不改历史作答。选择暂存、保存生效、
 * 重取不覆盖编辑、离开确认按 settings-navigation 既有方式。
 */
export function PracticeFeedbackSection({
  teacherId = "current",
}: {
  teacherId?: string;
}) {
  const settingsQuery = usePracticeFeedbackSettings();
  const saveMutation = useSavePracticeFeedbackSettings();
  const queryClient = useQueryClient();
  const navigation = useSettingsNavigation();
  const draftKey = useMemo(
    () => [...DRAFT_KEY, teacherId] as const,
    [teacherId],
  );
  const [draft, setDraft] = useState<PracticeFeedbackDraft | null>(
    () => queryClient.getQueryData<PracticeFeedbackDraft>(draftKey) ?? null,
  );
  const loaded = settingsQuery.data?.practiceFeedbackPolicy;
  // 未配置（null）的有效默认：由学生选择（仅对新普通自由练习生效）
  const baseline: PracticeFeedbackDraft = loaded ?? "student_choice";
  const checked = draft ?? baseline;
  const dirty = loaded !== undefined && checked !== baseline;
  const setNavigationDraft = navigation?.setDraft;
  useEffect(() => {
    queryClient.setQueryDefaults(draftKey, { gcTime: Infinity });
    queryClient.setQueryData(draftKey, draft);
  }, [queryClient, draft, draftKey]);
  useEffect(() => {
    setNavigationDraft?.("practice-feedback", {
      dirty,
      discard: () => {
        setDraft(null);
        queryClient.removeQueries({ queryKey: draftKey });
      },
    });
    return () =>
      setNavigationDraft?.("practice-feedback", {
        dirty: false,
        discard: () => {},
      });
  }, [dirty, queryClient, setNavigationDraft, draftKey]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return (
    <div className="teacher-config-section">
      <div>
        <h2 className="font-semibold">练习反馈默认策略</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          新建练习卷的反馈节奏默认规则。教师明确限制（如作业设为交卷后公布）
          始终优先于学生偏好。
        </p>
      </div>
      {settingsQuery.isPending && (
        <p className="text-sm text-muted-foreground">正在加载配置…</p>
      )}
      {settingsQuery.isError && (
        <div>
          <p role="alert" className="text-sm text-destructive">
            无法加载练习反馈策略，请重试。
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => void settingsQuery.refetch()}
          >
            重新加载配置
          </Button>
        </div>
      )}
      {loaded !== undefined && (
        <>
          <fieldset className="m-0 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card p-0">
            <legend className="sr-only">练习反馈默认策略</legend>
            {OPTIONS.map(({ value, label, description }) => (
              <label
                key={value}
                className="flex min-h-11 cursor-pointer items-center justify-between gap-5 px-5 py-5 sm:px-7 sm:py-6"
              >
                <span className="min-w-0">
                  <span className="block text-[0.9375rem] font-semibold">
                    {label}
                    {loaded === null && value === "student_choice" && (
                      <span className="ml-2 text-[0.8125rem] font-normal text-muted-foreground">
                        （未配置时的默认）
                      </span>
                    )}
                  </span>
                  <span className="mt-1 block max-w-[54ch] text-[0.8125rem] leading-relaxed text-muted-foreground">
                    {description}
                  </span>
                </span>
                <span className="flex min-h-11 min-w-11 items-center justify-center">
                  <input
                    type="radio"
                    name={`practice-feedback-${teacherId}`}
                    className="mt-0.5 size-5 shrink-0 accent-[var(--color-primary)]"
                    aria-label={label}
                    disabled={saveMutation.isPending}
                    checked={checked === value}
                    onChange={() => setDraft(value)}
                  />
                </span>
              </label>
            ))}
          </fieldset>
          <p className="flex items-start gap-2 text-[0.8125rem] leading-relaxed text-muted-foreground">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              只影响之后新建的普通练习卷；进行中和历史作答保持原有节奏。
              <br />
              教师中途收紧规则时，已提交的结果保留，剩余题目按新规则完成。
            </span>
          </p>
          {saveMutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              {saveMutation.error instanceof Error
                ? saveMutation.error.message
                : "保存失败"}
              。更改仍保留，请重试保存。
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-4">
            <p role="status" className="text-xs text-muted-foreground">
              {saveMutation.isPending
                ? "正在保存…"
                : dirty
                  ? "有未保存的更改"
                  : saveMutation.isSuccess
                    ? "更改已保存"
                    : "当前设置已保存"}
            </p>
            <Button
              className="min-h-11 px-5"
              disabled={saveMutation.isPending}
              onClick={() =>
                saveMutation.mutate(
                  { practiceFeedbackPolicy: checked },
                  { onSuccess: () => setDraft(null) },
                )
              }
            >
              {saveMutation.isPending && (
                <Loader2 aria-hidden className="motion-safe:animate-spin" />
              )}
              保存更改
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
