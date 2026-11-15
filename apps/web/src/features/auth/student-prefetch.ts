import type { QueryClient } from "@tanstack/react-query";
import type { ApiServices } from "@/features/runtime/ports/api-services";

/** 登录后的既有三项预取，调用方必须提供新认证主体的客户端。 */
export function prefetchStudentQueries(
  cache: QueryClient,
  clients: ApiServices,
  assignments: boolean,
) {
  const reads = [
    cache.prefetchQuery({
      queryKey: ["student", "courses"],
      queryFn: clients.fetchStudentCoursesApi,
    }),
    cache.prefetchQuery({
      queryKey: ["student", "lectures"],
      queryFn: clients.fetchStudentLecturesApi,
    }),
  ];
  if (assignments)
    reads.push(
      cache.prefetchQuery({
        queryKey: ["student", "assignments"],
        queryFn: clients.fetchStudentAssignmentsApi,
      }),
    );
  return Promise.allSettled(reads);
}
