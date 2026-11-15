import type { AttemptDetailData, AttemptSummary } from "@tutor/contract";
import { createContext, type ReactNode, useContext } from "react";
import {
  EnabledCapabilitiesProvider,
  toEnabledCapabilities,
} from "@/features/capability/enabled-capabilities";

const SnapshotContext = createContext<Pick<
  AttemptSummary,
  "id" | "frozenAt" | "phase"
> | null>(null);
/** 换冻结版本即换编辑实例，在途旧编辑仍持有原来的凭据。 */
export function AttemptSnapshotScope({
  attempt,
  children,
}: {
  attempt: AttemptSummary;
  children: ReactNode;
}) {
  return (
    <SnapshotContext
      key={`${attempt.id}:${attempt.frozenAt ?? "unknown"}`}
      value={attempt}
    >
      {children}
    </SnapshotContext>
  );
}
export function useAttemptSnapshotToken(
  attemptId: string,
): string | null | undefined {
  const snapshot = useContext(SnapshotContext);
  return snapshot?.id === attemptId ? snapshot.frozenAt : undefined;
}
/** 这份卷还没有实质动作（未激活）。不在本次作答视图里、卷号对不上都算否。 */
export function useAttemptOpened(attemptId: string): boolean {
  const snapshot = useContext(SnapshotContext);
  return snapshot?.id === attemptId && snapshot.phase === "opened";
}
/** 教师辅助能力与渲染冻结凭据都随本次作答视图提供，结果和草稿口径一致。 */
export function AttemptSessionScope({
  data,
  children,
}: {
  data: Pick<AttemptDetailData, "attempt" | "enabledCapabilities">;
  children: ReactNode;
}) {
  const capabilities = toEnabledCapabilities(data.enabledCapabilities);
  return (
    <EnabledCapabilitiesProvider value={capabilities}>
      <AttemptSnapshotScope attempt={data.attempt}>
        {children}
      </AttemptSnapshotScope>
    </EnabledCapabilitiesProvider>
  );
}
