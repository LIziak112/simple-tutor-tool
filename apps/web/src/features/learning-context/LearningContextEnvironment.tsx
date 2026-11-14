import { type ReactNode, useEffect, useLayoutEffect } from "react";
import { useMcpLiveFocus } from "@/features/student-ai/mcp-live-focus";
import { learningContextStore } from "./learning-context-store";
import { LearningPrincipalContext } from "./learning-principal";
/** 学习布局的主体绑定与页面可见性；与旧outbox/认证绑定并列，保留各角色行为。 */
export function LearningContextEnvironment({
  principal,
  children,
}: {
  principal: string | null;
  children?: ReactNode;
}) {
  useLayoutEffect(
    () => learningContextStore.bindPrincipalLease(principal),
    [principal],
  );
  useEffect(() => {
    const refresh = () =>
      learningContextStore.setVisible(document.visibilityState === "visible");
    const hide = () => learningContextStore.setVisible(false);
    refresh();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", refresh);
    };
  }, []);
  useMcpLiveFocus();
  return (
    <LearningPrincipalContext value={principal}>
      {children}
    </LearningPrincipalContext>
  );
}
