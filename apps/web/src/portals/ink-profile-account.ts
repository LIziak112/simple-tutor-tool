import type { StudentMeData, TeacherInfo } from "@tutor/contract";
import type { InkProfileAccount } from "@/features/ink/ink-profile-store";
import type { PortalRoutes } from "@/features/runtime/portal-runtime";
import { ApiError } from "@/lib/api-response";

interface IdentityPorts {
  fetchTeacherMe(): Promise<Pick<TeacherInfo, "id">>;
  fetchStudentMe(): Promise<Pick<StudentMeData, "id">>;
}
/** 独立试写页的旧降级只保留在无门户坐标入口，嵌入门户时严格使用该视角主体。 */
export async function resolveInkProfileAccount(
  routes: PortalRoutes,
  pathname: string,
  clients: IdentityPorts,
): Promise<InkProfileAccount> {
  if (routes.isManagementPath(pathname))
    return { role: "teacher", id: (await clients.fetchTeacherMe()).id };
  try {
    return { role: "student", id: (await clients.fetchStudentMe()).id };
  } catch (error) {
    if (
      !(error instanceof ApiError && error.code === "UNAUTHORIZED") ||
      routes.isLearningPath(pathname)
    )
      throw error;
    return { role: "teacher", id: (await clients.fetchTeacherMe()).id };
  }
}
