import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSettingsNavigation } from "./settings-navigation";

/**
 * 设置页配置区的「暂存草稿」骨架（M1b 从 CapabilityProfileSection 收敛）：
 * - 草稿存 query cache（gcTime Infinity，key = [...keyPrefix, teacherId]），
 *   切分类/重挂载不丢、重取不覆盖编辑、教师之间按 teacherId 隔离；
 * - 注册 settings-navigation 草稿（离开确认 + discard 复位）；
 * - dirty 时挂 beforeunload 守卫。
 * 返回 { draft, setDraft, checked }——checked = draft ?? baseline。
 */
export function useSettingsSectionDraft<T>(
  keyPrefix: readonly string[],
  teacherId: string,
  baseline: T | undefined,
  areEqual: (a: T, b: T) => boolean,
  navigationId: string,
): {
  draft: T | null;
  setDraft: (next: T | null) => void;
  checked: T | undefined;
  dirty: boolean;
} {
  const queryClient = useQueryClient();
  const navigation = useSettingsNavigation();
  const draftKey = useMemo(
    () => [...keyPrefix, teacherId] as const,
    [keyPrefix, teacherId],
  );
  const [draft, setDraft] = useState<T | null>(
    () => queryClient.getQueryData<T>(draftKey) ?? null,
  );
  const checked = draft ?? baseline;
  const dirty = baseline !== undefined && !areEqual(checked as T, baseline);
  const setNavigationDraft = navigation?.setDraft;
  useEffect(() => {
    queryClient.setQueryDefaults(draftKey, { gcTime: Infinity });
    queryClient.setQueryData(draftKey, draft);
  }, [queryClient, draft, draftKey]);
  useEffect(() => {
    setNavigationDraft?.(navigationId, {
      dirty,
      discard: () => {
        setDraft(null);
        queryClient.removeQueries({ queryKey: draftKey });
      },
    });
    return () =>
      setNavigationDraft?.(navigationId, { dirty: false, discard: () => {} });
  }, [dirty, queryClient, setNavigationDraft, draftKey, navigationId]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return { draft, setDraft, checked, dirty };
}
