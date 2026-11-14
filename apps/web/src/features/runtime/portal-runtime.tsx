import type { AccountKind } from "@tutor/contract";
import { createContext, type ReactNode, useContext } from "react";
import type { ApiServices } from "./ports/api-services";
export type PortalId = "student" | "teacher" | "personal" | "admin";
export interface PortalAddress {
  readonly label: string;
  readonly homePath: string;
  readonly loginPath: string;
}
export interface PortalRoutes {
  learning(path: string): string;
  management(path: string): string;
  portal(id: PortalId): PortalAddress;
  readonly all: Readonly<Record<PortalId, PortalAddress>>;
  learningPattern(suffix: string, flags?: string): RegExp;
  isLearningPath(path: string): boolean;
  isManagementPath(path: string): boolean;
}
export interface PortalCapabilities {
  practice: boolean;
  courses: boolean;
  records: boolean;
  memos: boolean;
  resourceManagement: boolean;
  assignments: boolean;
  members: boolean;
  teacherAiConnections: boolean;
  showLoginName: boolean;
  accountAdministration: boolean;
}
export interface PortalRuntime {
  readonly portal: PortalId;
  readonly view: "learning" | "management";
  readonly subject: {
    readonly type: "student" | "teacher";
    readonly id: string;
  } | null;
  readonly accountKind: AccountKind | undefined;
  readonly routes: PortalRoutes;
  readonly clients: ApiServices;
  readonly capabilities: PortalCapabilities;
  capabilitiesFor(
    role: "student" | "teacher",
    kind: AccountKind,
  ): PortalCapabilities;
  readonly signal: AbortSignal;
}
const RuntimeContext = createContext<PortalRuntime | null>(null);
export function PortalRuntimeProvider({
  runtime,
  children,
}: {
  runtime: PortalRuntime;
  children: ReactNode;
}) {
  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
    </RuntimeContext.Provider>
  );
}
export function usePortalRuntime(): PortalRuntime {
  const runtime = useContext(RuntimeContext);
  if (runtime === null) throw new Error("领域引擎缺少门户宿主");
  return runtime;
}
export function usePortalClients() {
  return usePortalRuntime().clients;
}
export function usePortalRoutes() {
  return usePortalRuntime().routes;
}
