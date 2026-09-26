import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  StudentCreateData,
  StudentCreateRequest,
  StudentResetLinkData,
  StudentResetPasswordData,
  StudentSummary,
  StudentUpdateRequest,
} from "@tutor/contract";
import {
  createStudentApi,
  fetchStudentsApi,
  resetStudentLinkApi,
  resetStudentPasswordApi,
  updateStudentApi,
} from "@/lib/api";

/**
 * 学生管理查询与写操作（T2.1 教师端学生页）。
 * 列表按 includeArchived 分 key（切换「显示已归档」是独立查询）；
 * 任何写操作成功后整组失效（students 前缀），保证列表与最新状态一致。
 */

/** 学生列表查询 key（includeArchived 进入 key，两种视图独立缓存） */
export const studentsKey = (includeArchived: boolean) =>
  ["teacher", "students", { includeArchived }] as const;

/** 学生列表（三态齐全由页面接 isPending/isError） */
export function useStudents(includeArchived: boolean) {
  return useQuery({
    queryKey: studentsKey(includeArchived),
    queryFn: () => fetchStudentsApi(includeArchived),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** 写操作完成后失效全部学生列表缓存 */
function useInvalidateStudents() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: ["teacher", "students"],
    });
  };
}

/** 新增学生（响应含一次性初始密码明文，由调用方弹窗展示） */
export function useCreateStudent() {
  const invalidate = useInvalidateStudents();
  return useMutation<StudentCreateData, Error, StudentCreateRequest>({
    mutationFn: createStudentApi,
    onSuccess: invalidate,
  });
}

/** 更新学生（开关登录方式 / 改名 / 归档等） */
export function useUpdateStudent() {
  const invalidate = useInvalidateStudents();
  return useMutation<
    StudentSummary,
    Error,
    { id: string; request: StudentUpdateRequest }
  >({
    mutationFn: ({ id, request }) => updateStudentApi(id, request),
    onSuccess: invalidate,
  });
}

/** 重置学生密码（响应含一次性新密码明文） */
export function useResetStudentPassword() {
  const invalidate = useInvalidateStudents();
  return useMutation<StudentResetPasswordData, Error, string>({
    mutationFn: resetStudentPasswordApi,
    onSuccess: invalidate,
  });
}

/** 重置专属链接（旧链接立即失效；响应含新 linkToken） */
export function useResetStudentLink() {
  const invalidate = useInvalidateStudents();
  return useMutation<StudentResetLinkData, Error, string>({
    mutationFn: resetStudentLinkApi,
    onSuccess: invalidate,
  });
}
