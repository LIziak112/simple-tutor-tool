import type { QueryClient } from "@tanstack/react-query";
import type { StudentMeData } from "@tutor/contract";
import { prefetchStudentQueries } from "@/features/auth/student-prefetch";
import type { PortalId } from "@/features/runtime/portal-runtime";
import { createHttpRuntime } from "./clients/http-runtime";
import { createClientServices } from "./clients/services";
import { portalCapabilitiesOf } from "./registry";
import { watchSubjectIdentity } from "./subject-identity";
import { createSubjectScope } from "./subject-scope";

/** 认证提交后显式建立新主体短租约；绝不把旧客户端转发到当前主体。 */
export function prefetchAuthenticatedStudent(
  portal: PortalId,
  student: StudentMeData,
  cache: QueryClient,
) {
  if (cache.getQueryData<StudentMeData>(["student", "me"])?.id !== student.id)
    return;
  const ownerPortal = student.accountKind === "personal" ? "personal" : portal;
  const peer =
    ownerPortal === "personal"
      ? cache.getQueryData<{ id: string }>(["teacher", "me"])?.id
      : undefined;
  const scope = createSubjectScope(
    {
      type: "student",
      id: student.id,
      portal: ownerPortal,
      ...(peer ? { pairedSubjectId: peer } : {}),
    },
    (input, init) => globalThis.fetch(input, init),
  );
  const stop = watchSubjectIdentity(cache, scope);
  void prefetchStudentQueries(
    cache,
    createClientServices(createHttpRuntime(scope)),
    portalCapabilitiesOf("student", student.accountKind).assignments,
  ).finally(() => {
    stop();
    scope.close();
  });
}
