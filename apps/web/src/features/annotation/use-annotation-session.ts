/**
 * 标注会话绑定的布局级接线（T6R.20，use-note-session 的标注同构）：
 * StudentLayout 与草稿会话并行 bind 当前学生 + 部署实例；登出在
 * student-auth 统一 resetAnnotationSession（与 resetNoteSession 对称）。
 * 标注键前缀与草稿隔离，互不越界；离开页面不 reset（同步队列照常完成）。
 */
import type { StudentMeData } from "@tutor/contract";
import { useEffect } from "react";
import { bindAnnotationSession } from "@/features/annotation/annotation-sync";

export function useBindAnnotationSession(me: StudentMeData | undefined): void {
  useEffect(() => {
    if (me === undefined) return;
    bindAnnotationSession({
      origin: window.location.origin,
      studentId: me.id,
    });
  }, [me]);
}
