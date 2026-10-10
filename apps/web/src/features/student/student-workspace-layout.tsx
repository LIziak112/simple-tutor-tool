import { createContext, useContext, useEffect } from "react";

export const StudentWorkspaceContext = createContext<
  ((active: boolean) => void) | null
>(null);

/** 答题视图显式申请专用框架，卸载后恢复学生导航与普通页面尺寸。 */
export function useStudentWorkspace(): void {
  const setWorkspace = useContext(StudentWorkspaceContext);
  useEffect(() => {
    setWorkspace?.(true);
    return () => setWorkspace?.(false);
  }, [setWorkspace]);
}
