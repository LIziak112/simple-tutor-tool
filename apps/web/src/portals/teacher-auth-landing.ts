import type { QueryClient } from "@tanstack/react-query";
import type { TeacherInfo } from "@tutor/contract";
import type { PortalId } from "@/features/runtime/portal-runtime";
import { resolveTeacherLanding } from "@/features/students/teacher-landing";
import { createHttpRuntime } from "./clients/http-runtime";
import { createClientServices } from "./clients/services";
import { createPortalRoutes } from "./routes";
import { watchSubjectIdentity } from "./subject-identity";
import { createSubjectScope } from "./subject-scope";
/** 登录后落点读取明确属于刚提交的教师，不借已关闭的登录页旧port。 */
export async function teacherLandingAfterAuth(
  portal: PortalId,
  teacher: TeacherInfo,
  cache: QueryClient,
  confirmation: { isCurrent(): boolean; readonly signal: AbortSignal },
): Promise<string> {
  const routes = createPortalRoutes(portal);
  const fallback = routes.management("students");
  if (!confirmation.isCurrent()) return fallback;
  if (cache.getQueryData<TeacherInfo>(["teacher", "me"])?.id !== teacher.id)
    return fallback;
  const ownerPortal = teacher.accountKind === "personal" ? "personal" : portal;
  const peer =
    teacher.accountKind === "personal"
      ? cache.getQueryData<{ id: string }>(["student", "me"])?.id
      : undefined;
  const scope = createSubjectScope(
    {
      type: "teacher",
      id: teacher.id,
      portal: ownerPortal,
      ...(peer ? { pairedSubjectId: peer } : {}),
    },
    (input, init) => globalThis.fetch(input, init),
  );
  const stop = watchSubjectIdentity(cache, scope);
  const abort = () => scope.close();
  confirmation.signal.addEventListener("abort", abort, { once: true });
  if (confirmation.signal.aborted) abort();
  try {
    // 个人账号只指向自己的学习首页，不访问教师学生清单。
    if (teacher.accountKind === "personal") return routes.learning("home");
    const landing = await resolveTeacherLanding(
      routes,
      createClientServices(createHttpRuntime(scope)),
    );
    return confirmation.isCurrent() ? landing : fallback;
  } finally {
    confirmation.signal.removeEventListener("abort", abort);
    stop();
    scope.close();
  }
}
