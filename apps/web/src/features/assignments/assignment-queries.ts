import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AssignmentCreateRequest,
  AssignmentUpdateRequest,
  TeacherAssignment,
} from "@tutor/contract";
import {
  createAssignmentApi,
  deleteAssignmentApi,
  fetchAssignmentsApi,
  updateAssignmentApi,
} from "@/lib/api";

/**
 * 作业查询与写操作（T2.2 教师端作业页）。
 * 列表按 includeDeleted 分 key（「显示已删除」是独立查询）；
 * 任何写操作成功后整组失效（assignments 前缀），保证列表与最新状态一致。
 * 学生端「我的作业」查询自 T2.3 学生端外壳接入。
 */

/** 作业列表查询 key（includeDeleted 进入 key，两种视图独立缓存） */
export const assignmentsKey = (includeDeleted: boolean) =>
  ["teacher", "assignments", { includeDeleted }] as const;

/** 教师作业列表（三态齐全由页面接 isPending/isError） */
export function useTeacherAssignments(includeDeleted: boolean) {
  return useQuery({
    queryKey: assignmentsKey(includeDeleted),
    queryFn: () => fetchAssignmentsApi(includeDeleted),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** 写操作完成后失效全部作业列表缓存 */
function useInvalidateAssignments() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: ["teacher", "assignments"],
    });
  };
}

/** 布置作业（选单元 + 多选学生 + 可选截止；404/400 由调用方 catch ApiError 展示） */
export function useCreateAssignment() {
  const invalidate = useInvalidateAssignments();
  return useMutation<TeacherAssignment, Error, AssignmentCreateRequest>({
    mutationFn: createAssignmentApi,
    onSuccess: invalidate,
  });
}

/** 更新作业（改标题/截止/全量替换名单；dueAt null = 取消截止） */
export function useUpdateAssignment() {
  const invalidate = useInvalidateAssignments();
  return useMutation<
    TeacherAssignment,
    Error,
    { id: string; request: AssignmentUpdateRequest }
  >({
    mutationFn: ({ id, request }) => updateAssignmentApi(id, request),
    onSuccess: invalidate,
  });
}

/** 删除作业（软删，作答保留；列表随后自动刷新） */
export function useDeleteAssignment() {
  const invalidate = useInvalidateAssignments();
  return useMutation<null, Error, string>({
    mutationFn: deleteAssignmentApi,
    onSuccess: invalidate,
  });
}
