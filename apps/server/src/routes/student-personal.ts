import { Hono } from "hono";
import type { StudentEnv } from "../auth/require-student";
import type { Db } from "../db/client";
import { createStudentDeviceRoutes } from "./devices";
import { createStudentInkProfileRoutes } from "./ink-profiles";
import { createStudentMemoRoutes } from "./student-memos";

/** 本人数据模块装配，统一继承学生域鉴权，不向教师暴露随笔。 */
export function createStudentPersonalRoutes(db: Db, dataDir: string) {
  return new Hono<StudentEnv>()
    .route("/", createStudentInkProfileRoutes(db))
    .route("/", createStudentMemoRoutes(db, dataDir))
    .route("/", createStudentDeviceRoutes(db));
}
