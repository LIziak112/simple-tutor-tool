import { teacherLoginOkSchema } from "@tutor/contract";
import type { createApp } from "../app.ts";
import {
  createStudent,
  extractSessionToken,
  loginStudent,
} from "../test/note-world.ts";

export async function createIdentitySessionFixture(
  app: ReturnType<typeof createApp>,
  teacherCredentials: { loginName: string; password: string },
) {
  const login = await app.request("/api/public/teacher/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(teacherCredentials),
  });
  if (login.status !== 200) throw new Error(`教师登录失败：${login.status}`);
  const { data } = teacherLoginOkSchema.parse(await login.json());
  const teacher = {
    id: data.id,
    cookie: `tutor_session=${extractSessionToken(login)}`,
  };

  const studentName = "试点学生甲";
  const student = {
    id: await createStudent(app, teacher.cookie, studentName),
    cookie: await loginStudent(app, studentName),
  };
  const otherStudentName = "试点学生乙";
  const otherStudent = {
    id: await createStudent(app, teacher.cookie, otherStudentName),
    cookie: await loginStudent(app, otherStudentName),
  };

  return {
    teacher,
    student,
    otherStudent,
    browserCookie: `${teacher.cookie}; ${student.cookie}`,
  };
}
