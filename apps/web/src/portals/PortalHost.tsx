import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { StudentMeData, TeacherInfo } from "@tutor/contract";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";
import {
  type PortalId,
  type PortalRuntime,
  PortalRuntimeProvider,
} from "@/features/runtime/portal-runtime";
import { defaultClientServices } from "./clients/default-services";
import { createHttpRuntime } from "./clients/http-runtime";
import { createClientServices } from "./clients/services";
import { portalCapabilitiesOf } from "./registry";
import { createPortalRoutes } from "./routes";
import { prefetchAuthenticatedStudent } from "./student-auth-prefetch";
import { watchSubjectIdentity } from "./subject-identity";
import { createSubjectScope } from "./subject-scope";
import { teacherLandingAfterAuth } from "./teacher-auth-landing";

function roleSessionQuery(role: "student" | "teacher") {
  return {
    queryKey: [role, "me"] as const,
    queryFn: () =>
      role === "student"
        ? defaultClientServices.fetchStudentMe()
        : defaultClientServices.fetchTeacherMe(),
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  };
}
/** 认证bootstrap在L3，领域查询仍共用原角色缓存；每个真实subject生成新租约。 */
export function PortalHost({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const cache = useQueryClient();
  const [identityEpoch, setIdentityEpoch] = useState(0);
  const portal: PortalId = pathname.startsWith("/p")
    ? "personal"
    : pathname.startsWith("/a")
      ? "admin"
      : pathname.startsWith("/t")
        ? "teacher"
        : "student";
  const view =
    portal === "teacher" ||
    portal === "admin" ||
    pathname.startsWith("/p/manage")
      ? "management"
      : "learning";
  const role = view === "management" ? "teacher" : "student";
  const session = useQuery<StudentMeData | TeacherInfo>(roleSessionQuery(role));
  const peer = useQuery<StudentMeData | TeacherInfo>({
    ...roleSessionQuery(role === "student" ? "teacher" : "student"),
    enabled: portal === "personal",
  });
  // 个人端沿用两侧既有缓存；任一侧变化都撤销旧租约，不把新Cookie借给旧工作。
  const pairedSubjectId =
    portal === "personal" ? (peer.data?.id ?? null) : null;
  const id = session.data?.id ?? null;
  const scope = useMemo(
    () =>
      createSubjectScope(
        {
          type: role,
          id: id ?? "unconfirmed",
          portal,
          generation: identityEpoch,
          ...(pairedSubjectId === null ? {} : { pairedSubjectId }),
        },
        (input, init) => globalThis.fetch(input, init),
      ),
    [role, id, portal, pairedSubjectId, identityEpoch],
  );
  useEffect(() => {
    const release = scope.retain();
    const stop = watchSubjectIdentity(cache, scope, () =>
      setIdentityEpoch((value) => value + 1),
    );
    return () => {
      stop();
      release();
    };
  }, [cache, scope]);
  const clients = useMemo(
    () => createClientServices(createHttpRuntime(scope)),
    [scope],
  );
  const routes = useMemo(() => createPortalRoutes(portal), [portal]);
  const accountKind = session.data?.accountKind;
  const runtime = useMemo<PortalRuntime>(
    () => ({
      portal,
      view,
      subject: id === null ? null : { type: role, id },
      accountKind,
      clients,
      routes,
      capabilities: portalCapabilitiesOf(
        view === "management" ? "teacher" : "student",
        accountKind ?? "class",
      ),
      capabilitiesFor: portalCapabilitiesOf,
      signal: scope.signal,
      teacherLandingAfterAuth: (teacher, client, confirmation) =>
        teacherLandingAfterAuth(portal, teacher, client, confirmation),
      prefetchStudentAfterAuth: (student, client) =>
        prefetchAuthenticatedStudent(portal, student, client),
    }),
    [portal, view, id, role, accountKind, clients, routes, scope],
  );
  return (
    <PortalRuntimeProvider runtime={runtime}>{children}</PortalRuntimeProvider>
  );
}
