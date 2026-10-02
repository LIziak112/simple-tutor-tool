import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AssignmentCheckData,
  AssignmentCheckRequest,
  AssignmentCreateData,
  AssignmentCreateRequest,
  AssignmentUpdateRequest,
  TeacherAssignment,
} from "@tutor/contract";
import {
  checkAssignmentApi,
  createAssignmentApi,
  deleteAssignmentApi,
  fetchAssignmentDetailApi,
  fetchAssignmentsApi,
  updateAssignmentApi,
} from "@/lib/api";

/**
 * 作业查询与写操作（T2.2 教师端作业页；T2A.7 扩展 courseId 筛选、详情与 D15 检查）。
 * 列表按 (courseId, includeDeleted) 分 key（「显示已删除」「按课程筛选」是独立查询）；
 * 任何写操作成功后整组失效（assignments 前缀），保证列表与详情最新。
 */

/** 作业列表查询 key（courseId/includeDeleted 进入 key，视图独立缓存） */
export const assignmentsKey = (
  courseId: string | undefined,
  includeDeleted: boolean,
) => ["teacher", "assignments", { courseId, includeDeleted }] as const;

/** 教师作业列表（三态齐全由页面接 isPending/isError） */
export function useTeacherAssignments(
  courseId: string | undefined,
  includeDeleted: boolean,
) {
  return useQuery({
    queryKey: assignmentsKey(courseId, includeDeleted),
    queryFn: () => fetchAssignmentsApi(courseId, includeDeleted),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** 单份作业详情 key（编辑弹层：名单状态/锁定原因/课程新成员） */
export const assignmentDetailKey = (id: string) =>
  ["teacher", "assignments", "detail", id] as const;

/** 作业详情（T2A.7） */
export function useAssignmentDetail(id: string | undefined) {
  return useQuery({
    queryKey: assignmentDetailKey(id ?? "pending"),
    queryFn: () => fetchAssignmentDetailApi(id ?? ""),
    enabled: id !== undefined,
    staleTime: 15_000,
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

/**
 * 布置作业（多单元 + 课程 + 学生多选 + 可选截止 + 组合方式；4xx/409 由调用方
 * catch ApiError 展示）。响应为列表形态（2026-10）：merged 恰一份、separate
 * 每个 unitIds 顺序 N 份——向导提交后只做缓存失效，不逐份消费。
 */
export function useCreateAssignment() {
  const invalidate = useInvalidateAssignments();
  return useMutation<AssignmentCreateData, Error, AssignmentCreateRequest>({
    mutationFn: createAssignmentApi,
    onSuccess: invalidate,
  });
}

/**
 * 更新作业（T2A.7：标题/截止/替换单元/名单增删）。
 * 409 CONFIRM_REQUIRED 时 error.extra._students 为受影响学生名单（调用方确认后
 * 带 confirmStarted: true 重发）；409 ASSIGNMENT_CONTENT_LOCKED = 内容已锁定。
 */
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

/** 布置前「已做过」检查（D15：仅提示不阻止；确认步骤逐条展示） */
export function useCheckAssignment() {
  return useMutation<AssignmentCheckData, Error, AssignmentCheckRequest>({
    mutationFn: checkAssignmentApi,
  });
}
