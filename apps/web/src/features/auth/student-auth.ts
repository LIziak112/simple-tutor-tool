import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StudentLoginRequest, StudentMeData } from "@tutor/contract";
import {
  fetchStudentAssignmentsApi,
  fetchStudentCoursesApi,
  fetchStudentLecturesApi,
  fetchStudentMe,
  loginStudentApi,
  loginStudentByLinkApi,
  logoutStudentApi,
} from "@/lib/api";

/**
 * 学生登录状态（T2.3 学生端外壳）：与 teacher-auth 同构的模式——
 * - useStudentMe：路由守卫（/s/* 布局与登录页「已登录直接跳走」）；
 * - useStudentLinkLogin / useLoginStudent：两种登录（§5.7），成功后写入 me 缓存，
 *   避免进入首页后守卫再闪一次 loading；
 * - useLogoutStudent：退出（删除服务端会话 + 清全部学生端查询缓存）。
 */

export const studentMeKey = ["student", "me"] as const;

/** 当前登录学生（未登录时 isError 且错误码 UNAUTHORIZED，由守卫处理跳转） */
export function useStudentMe() {
  return useQuery({
    queryKey: studentMeKey,
    queryFn: fetchStudentMe,
    // 401 不重试：守卫需要立刻感知并跳登录页
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** 登录成功后写入 me 缓存并预取我的作业/课程/讲义（首页立即可用，T2A.5 加课程） */
function useApplyStudentAuthed() {
  const queryClient = useQueryClient();
  return (student: StudentMeData) => {
    queryClient.setQueryData(studentMeKey, student);
    void queryClient.prefetchQuery({
      queryKey: ["student", "assignments"],
      queryFn: fetchStudentAssignmentsApi,
    });
    void queryClient.prefetchQuery({
      queryKey: ["student", "courses"],
      queryFn: fetchStudentCoursesApi,
    });
    void queryClient.prefetchQuery({
      queryKey: ["student", "lectures"],
      queryFn: fetchStudentLecturesApi,
    });
  };
}

/** 专属链接登录（/s/:token 页面挂载即调用） */
export function useStudentLinkLogin() {
  const applyAuthed = useApplyStudentAuthed();
  return useMutation({
    mutationFn: loginStudentByLinkApi,
    onSuccess: applyAuthed,
  });
}

/** 登录名 + 密码登录（/s/login 页面表单提交） */
export function useLoginStudent() {
  const applyAuthed = useApplyStudentAuthed();
  return useMutation({
    mutationFn: (request: StudentLoginRequest) => loginStudentApi(request),
    onSuccess: applyAuthed,
  });
}

/** 退出登录：成功后清空全部学生端查询缓存（me 失效后守卫导回登录页） */
export function useLogoutStudent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logoutStudentApi,
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["student"] });
    },
  });
}
