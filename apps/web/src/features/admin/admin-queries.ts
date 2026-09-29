import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdminSettingsUpdateRequest,
  AdminTeacherResetPasswordRequest,
  AdminTeacherUpdateRequest,
} from "@tutor/contract";
import {
  createAdminTeacherApi,
  disableAdminTeacherApi,
  enableAdminTeacherApi,
  fetchAdminOverview,
  fetchAdminSettings,
  fetchAdminTeachers,
  resetAdminTeacherPasswordApi,
  updateAdminSettingsApi,
  updateAdminTeacherApi,
} from "@/lib/api";

/**
 * 管理端查询与写操作（T2B.6，D19/D20）。
 * 教师列表按 status 筛选分 key；任何教师写操作成功后失效整组 admin 缓存
 * （列表 + 概览 + status——注册开关切换会改变 /api/public/teacher/status，
 * 一并失效让登录页入口即时联动）。
 */

/** 教师列表查询 key（status 进入 key，三种视图独立缓存） */
export const adminTeachersKey = (status: "all" | "active" | "disabled") =>
  ["admin", "teachers", { status }] as const;

/** 教师列表（三态齐全由页面接 isPending/isError） */
export function useAdminTeachers(status: "all" | "active" | "disabled") {
  return useQuery({
    queryKey: adminTeachersKey(status),
    queryFn: () => fetchAdminTeachers(status),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** 管理端写操作完成后失效全部管理端缓存 + 公开 status（注册开关联动登录页） */
function useInvalidateAdmin() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
    void queryClient.invalidateQueries({ queryKey: ["teacher", "status"] });
  };
}

/** 管理员创建教师（响应含一次性初始密码明文，由调用方弹窗展示，§4.4） */
export function useCreateAdminTeacher() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: createAdminTeacherApi,
    onSuccess: invalidate,
  });
}

/** 改登录名 / 授予撤销 isAdmin */
export function useUpdateAdminTeacher() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: ({
      id,
      request,
    }: {
      id: string;
      request: AdminTeacherUpdateRequest;
    }) => updateAdminTeacherApi(id, request),
    onSuccess: invalidate,
  });
}

/** 禁用教师（确认弹层由页面先展示影响说明，§4.1） */
export function useDisableAdminTeacher() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: disableAdminTeacherApi,
    onSuccess: invalidate,
  });
}

/** 启用教师 */
export function useEnableAdminTeacher() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: enableAdminTeacherApi,
    onSuccess: invalidate,
  });
}

/** 重置教师密码（响应含一次性新密码明文） */
export function useResetAdminTeacherPassword() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: ({
      id,
      request,
    }: {
      id: string;
      request: AdminTeacherResetPasswordRequest;
    }) => resetAdminTeacherPasswordApi(id, request),
    onSuccess: invalidate,
  });
}

/** 注册开关当前状态（D8；概览页就地切换行也用它做乐观基础） */
export function useAdminSettings() {
  return useQuery({
    queryKey: ["admin", "settings"],
    queryFn: fetchAdminSettings,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** 切换注册开关 */
export function useUpdateAdminSettings() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: (request: AdminSettingsUpdateRequest) =>
      updateAdminSettingsApi(request),
    onSuccess: invalidate,
  });
}

/** 概览聚合计数（D20：只读展示） */
export function useAdminOverview() {
  return useQuery({
    queryKey: ["admin", "overview"],
    queryFn: fetchAdminOverview,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
