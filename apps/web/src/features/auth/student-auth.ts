import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StudentLoginRequest, StudentMeData } from "@tutor/contract";
import {
  currentAnnotationSession,
  resetAnnotationSession,
} from "@/features/annotation/annotation-sync";
import {
  currentNoteSession,
  resetNoteSession,
} from "@/features/notes/note-sync";
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
    // T6R.9 复审①：登录身份与当前草稿绑定不同 → 立即停旧会话。否则换账号后
    // 旧待传继续跑，会用**新会话 Cookie** 上传——attempt 归属由服务端从会话
    // 推导，旧账号的草稿必 403，被误打成 denied(access) 终态。同账号重登
    // （专属链接重进）不 reset，队列照常；本地未同步内容保留（方案 §6.1）
    const bound = currentNoteSession();
    if (bound !== null && bound.studentId !== student.id) {
      resetNoteSession();
    }
    // T6R.20：标注会话同口径（换账号停旧标注同步队列，防误 403 终态）
    const boundAnnotation = currentAnnotationSession();
    if (boundAnnotation !== null && boundAnnotation.studentId !== student.id) {
      resetAnnotationSession();
    }
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

/**
 * 退出登录：成功后清空全部学生端查询缓存（me 失效后守卫导回登录页），并
 * resetNoteSession（T6R.9）——停旧草稿同步队列、中止在途上传、隔离回执；
 * 本地未同步草稿保留（方案 §6.1：旧账号重新登录才可恢复）。
 */
export function useLogoutStudent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logoutStudentApi,
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["student"] });
      resetNoteSession();
      resetAnnotationSession();
    },
  });
}
