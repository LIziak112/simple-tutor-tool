import { useMutation } from "@tanstack/react-query";
import type { PersonalSessionData } from "@tutor/contract";
import { loginPersonalApi, registerPersonalApi } from "./personal-api";
import { useApplyStudentAuthed, useLogoutStudent } from "./student-auth";
import { useApplyTeacherAuthed, useLogoutTeacher } from "./teacher-auth";

/**
 * 个人账号登录状态（模块 0）：个人账号 = 一条教师行 + 一条绑定学习者行、两枚会话
 * Cookie，前端不新增第三份身份缓存——注册 / 登录成功后把两侧身份分别写进既有的
 * teacher me / student me 缓存（各自的 apply 钩子：学生侧还负责草稿 / 标注 /
 * 偏好等按账号绑定），两端布局守卫与页面照常工作；退出则两侧一起退。
 */

/** 双会话写入：教师侧 + 学生侧 */
function useApplyPersonalAuthed() {
  const applyTeacher = useApplyTeacherAuthed();
  const applyStudent = useApplyStudentAuthed();
  return async (session: PersonalSessionData) => {
    await applyTeacher(session.teacher);
    await applyStudent(session.student);
  };
}

/** 邀请码自助注册（成功即双会话登录） */
export function useRegisterPersonal() {
  const applyAuthed = useApplyPersonalAuthed();
  return useMutation({
    mutationFn: registerPersonalApi,
    onSuccess: applyAuthed,
  });
}

/** 个人账号登录 */
export function useLoginPersonal() {
  const applyAuthed = useApplyPersonalAuthed();
  return useMutation({
    mutationFn: loginPersonalApi,
    onSuccess: applyAuthed,
  });
}

/**
 * 个人账号退出：学生会话与教师会话一起退（两侧缓存各自清理）。
 * 任一侧失败不阻断另一侧（Promise.allSettled），但以错误上抛让界面提示。
 */
export function useLogoutPersonal() {
  const logoutStudent = useLogoutStudent();
  const logoutTeacher = useLogoutTeacher();
  return useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled([
        logoutStudent.mutateAsync(undefined),
        logoutTeacher.mutateAsync(undefined),
      ]);
      const failed = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failed !== undefined) {
        throw failed.reason instanceof Error
          ? failed.reason
          : new Error("退出失败，请稍后重试");
      }
      return null;
    },
  });
}
