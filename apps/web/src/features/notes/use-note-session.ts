/**
 * 草稿会话绑定的布局级接线（T6R.9 起，T6R.11 复审上提 StudentLayout）：
 * 守卫已消费 useStudentMe，布局层一并 bind 当前学生 + 部署实例（origin 取
 * window.location.origin——同源即同实例），所有 /s/* 学生页面自动获得
 * 身份接线。离开页面**不** reset——收起题卡/路由切换后同步队列照常完成
 * （方案 §6.1）；登出在 student-auth 统一 resetNoteSession（切账号即旧会话
 * 失效、回执隔离）。紧邻 note-sync 会话三件套（bind/current/reset）。
 */
import type { StudentMeData } from "@tutor/contract";
import { useEffect } from "react";
import { bindNoteSession } from "@/features/notes/note-sync";

export function useBindNoteSession(me: StudentMeData | undefined): void {
  useEffect(() => {
    if (me === undefined) return;
    bindNoteSession({
      origin: window.location.origin,
      studentId: me.id,
    });
  }, [me]);
}
