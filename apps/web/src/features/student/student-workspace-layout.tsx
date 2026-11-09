import { createContext, useContext, useEffect } from "react";

/**
 * 学生专用框架的工作区档位：false=普通页面；"default"=工作区（1120px 容器，
 * 隐藏学生导航）；"wide"=宽工作区（xl 起放宽到 1280px——做题三栏布局
 * 题号导航 + 题面 + AI 助教并排需要的宽度，阶段 B 2026-11）。
 */
export type StudentWorkspaceVariant = false | "default" | "wide";

export const StudentWorkspaceContext = createContext<
  ((variant: StudentWorkspaceVariant) => void) | null
>(null);

/** 答题视图显式申请专用框架，卸载后恢复学生导航与普通页面尺寸。 */
export function useStudentWorkspace(
  variant: Exclude<StudentWorkspaceVariant, false> = "default",
): void {
  const setWorkspace = useContext(StudentWorkspaceContext);
  useEffect(() => {
    setWorkspace?.(variant);
    return () => setWorkspace?.(false);
  }, [setWorkspace, variant]);
}
