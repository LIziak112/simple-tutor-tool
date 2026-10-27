import { fetchStudentsApi } from "@/lib/api";

/**
 * 教师登录后默认落点（T-PR4 Web-4，个人学习者零设置；方案 §Web-4）：
 * 名下未归档学生恰好 1 名 → 直接落到该生学生主页（/t/students/:id）；
 * 多名学生或暂无学生 → 学生列表。不新增设置项、不新增身份。
 */

/** 由未归档学生名单算落点路径（纯函数；1 名 → 该生主页，其余 → 学生列表） */
export function teacherLandingPath(
  activeStudents: readonly { id: string }[],
): string {
  const only = activeStudents.length === 1 ? activeStudents[0] : undefined;
  return only !== undefined ? `/t/students/${only.id}` : "/t/students";
}

/** 登录成功时的落点解析：取学生列表定落点；取列表失败回落学生列表（不阻塞登录） */
export async function resolveTeacherLanding(): Promise<string> {
  try {
    const list = await fetchStudentsApi(false);
    return teacherLandingPath(list.students.filter((item) => !item.archived));
  } catch {
    return "/t/students";
  }
}
