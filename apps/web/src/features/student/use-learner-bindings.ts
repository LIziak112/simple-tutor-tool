import type { StudentMeData } from "@tutor/contract";
import { useEffect } from "react";
import { useBindAnnotationSession } from "@/features/annotation/use-annotation-session";
import { bindPracticePreferenceAccount } from "@/features/attempt/practice-preference-store";
import { useBindInkProfiles } from "@/features/ink/use-ink-profiles";
import { bindKeyboardBindingsAccount } from "@/features/keyboard/keyboard-binding-store";
import { bindMemoOutboxAccount } from "@/features/memos/memo-outbox";
import { useBindNoteSession } from "@/features/notes/use-note-session";
import { usePortalClients } from "@/features/runtime/portal-runtime";
import { bindAiDisplayAccount } from "@/features/student-ai/ai-display-preference-store";
/** 班级与个人学习壳共用账号接线；主体变化重新绑定不可重绑的客户端租约。 */
export function useLearnerBindings(me: StudentMeData | undefined) {
  const clients = usePortalClients();
  useEffect(() => {
    bindAiDisplayAccount(me?.id ?? null);
    return () => bindAiDisplayAccount(null);
  }, [me?.id]);
  // M3-D1：做题方式偏好与 AI 显示偏好同一绑定时机（布局/快捷键按账号读取）
  useEffect(() => {
    bindPracticePreferenceAccount(me?.id ?? null);
    return () => bindPracticePreferenceAccount(null);
  }, [me?.id]);
  // 键位绑定偏好同口径（2026-10-28 快捷键体系：本设备键位按账号隔离读取）
  useEffect(() => {
    bindKeyboardBindingsAccount(me?.id ?? null);
    return () => bindKeyboardBindingsAccount(null);
  }, [me?.id]);
  useBindInkProfiles("student", me?.id);
  // 随笔待补传队列按账号隔离（模块 5 第一步）
  useEffect(() => {
    void bindMemoOutboxAccount(me?.id ?? null, clients);
    return () => void bindMemoOutboxAccount(null);
  }, [me?.id, clients]);
  // T6R.11 复审（会话接线层级）：草稿会话绑定上提到布局层——所有 /s/* 学生
  // 页面（答题/结果/历史回看）自动获得当前身份接线（bind/reset 对称：reset
  // 在 student-auth 登出处）。结果页读链路全走 Cookie 与 image-sync 队列不
  // 消费 note-session；绑定在布局层即模块级会话服务的身份职责归位
  useBindNoteSession(me);
  // T6R.20：标注会话与草稿会话并行绑定（标注同步队列的身份接线）
  useBindAnnotationSession(me);
}
