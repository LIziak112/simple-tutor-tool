import { useQueryClient } from "@tanstack/react-query";
import type { CapabilitySwitch } from "@tutor/contract";
import { toEnabledCapabilities } from "@tutor/contract";
import { Info, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  useCapabilityProfile,
  useSaveCapabilityProfile,
} from "./capability-profile-queries";
import { useSettingsNavigation } from "./settings-navigation";

const DRAFT_KEY = ["teacher", "capability-draft"] as const;
type CapabilityDraft = Record<CapabilitySwitch, boolean>;

/** 暂存选择独立于服务端查询；重取不覆盖本地编辑，返回设置仍可继续编辑。 */
export function CapabilityProfileSection({
  teacherId = "current",
}: {
  teacherId?: string;
}) {
  const profileQuery = useCapabilityProfile();
  const saveMutation = useSaveCapabilityProfile();
  const queryClient = useQueryClient();
  const navigation = useSettingsNavigation();
  const draftKey = useMemo(
    () => [...DRAFT_KEY, teacherId] as const,
    [teacherId],
  );
  const [draft, setDraft] = useState<CapabilityDraft | null>(
    () => queryClient.getQueryData<CapabilityDraft>(draftKey) ?? null,
  );
  const loaded = profileQuery.data?.enabledCapabilities;
  const baseline = toEnabledCapabilities(loaded ?? ["steps", "ink"]);
  const checked = draft ?? baseline;
  const dirty =
    loaded !== undefined &&
    (checked.steps !== baseline.steps || checked.ink !== baseline.ink);
  const setNavigationDraft = navigation?.setDraft;
  useEffect(() => {
    queryClient.setQueryDefaults(draftKey, { gcTime: Infinity });
    queryClient.setQueryData(draftKey, draft);
  }, [queryClient, draft, draftKey]);
  useEffect(() => {
    setNavigationDraft?.({
      dirty,
      discard: () => {
        setDraft(null);
        queryClient.removeQueries({ queryKey: draftKey });
      },
    });
    return () => setNavigationDraft?.({ dirty: false, discard: () => {} });
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
  const switches = [
    {
      key: "steps",
      label: "逐步揭晓",
      description: "按步骤展示讲义和题目。关闭后，全部步骤会一次显示。",
    },
    {
      key: "ink",
      label: "手写辅助",
      description: "提供手写作答、全屏手写和草稿纸。关闭后仍可填写最终答案。",
    },
  ] as const;
  return (
    <div className="teacher-config-section">
      <div>
        <h2 className="font-semibold">辅助作答</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          这些设置会应用到你的学生，正式答案始终可以填写与提交。
        </p>
      </div>
      {profileQuery.isPending && (
        <p className="text-sm text-muted-foreground">正在加载配置…</p>
      )}
      {profileQuery.isError && (
        <div>
          <p role="alert" className="text-sm text-destructive">
            无法加载作答方式，请重试。
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => void profileQuery.refetch()}
          >
            重新加载配置
          </Button>
        </div>
      )}
      {loaded !== undefined && (
        <>
          <fieldset className="m-0 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card p-0">
            <legend className="sr-only">辅助能力开关</legend>
            {switches.map(({ key, label, description }) => (
              <label
                key={key}
                className="flex min-h-11 cursor-pointer items-center justify-between gap-5 px-5 py-5 sm:px-7 sm:py-6"
              >
                <span className="min-w-0">
                  <span className="block text-[0.9375rem] font-semibold">
                    {label}
                  </span>
                  <span className="mt-1 block max-w-[54ch] text-[0.8125rem] leading-relaxed text-muted-foreground">
                    {description}
                  </span>
                </span>
                <span className="flex min-h-11 min-w-11 items-center justify-center">
                  <input
                    type="checkbox"
                    className="teacher-toggle"
                    aria-label={label}
                    disabled={saveMutation.isPending}
                    checked={checked[key]}
                    onChange={(event) =>
                      setDraft({ ...checked, [key]: event.target.checked })
                    }
                  />
                </span>
              </label>
            ))}
          </fieldset>
          <p className="flex items-start gap-2 text-[0.8125rem] leading-relaxed text-muted-foreground">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              保存后，学生重新打开页面时生效。
              <br />
              已有答案、笔迹和草稿会保留。
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
                  {
                    enabledCapabilities: (["steps", "ink"] as const).filter(
                      (key) => checked[key],
                    ),
                  },
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
