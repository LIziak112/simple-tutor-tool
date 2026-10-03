import { useEffect } from "react";

/**
 * 学生端主题（2026-10 UI 打磨）：挂载时给 <html> 加 .student-theme（配色变量
 * 见 index.css），卸载时移除——教师端页面不受影响。挂在 <html> 而不是布局容器
 * 上，是为了让经 Portal 渲染到 body 的弹窗（交卷确认等）也用同一套配色。
 * 学生端布局、登录页、专属链接登录页都调用本 hook。
 */
export function useStudentTheme(): void {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("student-theme");
    return () => {
      root.classList.remove("student-theme");
    };
  }, []);
}
