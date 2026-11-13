import type {
  AssignmentCreateData,
  AssignmentCreateRequest,
} from "@tutor/contract";
import { z } from "zod";
import type { Db } from "../db/client";
import {
  createAssignment,
  createAssignmentIds,
  teacherAssignmentOf,
} from "./assignment-service";
import { createOnce } from "./create-receipt";

/** 重放成功回执时使用原来选中的学生，即使工具的默认名单已有变化。 */
export function createAssignmentWithReceipt(
  db: Db,
  teacherId: string,
  request: Omit<AssignmentCreateRequest, "studentIds"> & {
    studentIds?: string[] | undefined;
  },
  resolve: (db: Db) => AssignmentCreateRequest,
): AssignmentCreateData {
  const { operationId, ...intent } = request;
  if (operationId === undefined)
    return createAssignment(db, teacherId, resolve(db));
  const ids = createOnce(
    db,
    "assignment",
    teacherId,
    operationId,
    intent,
    z.array(z.uuid()),
    (store) => createAssignmentIds(store, teacherId, resolve(store)),
  );
  return {
    assignments: ids.map((id) => teacherAssignmentOf(db, teacherId, id)),
  };
}
