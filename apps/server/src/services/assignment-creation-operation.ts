import type {
  AssignmentCreateData,
  AssignmentCreateRequest,
} from "@tutor/contract";
import { z } from "zod";
import type { Db } from "../db/client";
import { teacherAssignmentOf } from "./assignment-service";
import { createOnce } from "./create-receipt";
import { createAssignmentsWithBackend } from "./kernel-assignment-ownership.ts";

/** 重放成功回执时使用原来选中的学生，即使工具的默认名单已有变化。 */
export function createAssignmentWithReceipt(
  db: Db,
  teacherId: string,
  request: Omit<AssignmentCreateRequest, "studentIds"> & {
    studentIds?: string[] | undefined;
  },
  resolve: (db: Db) => AssignmentCreateRequest,
  kernelAssignmentCreationEnabled = false,
): AssignmentCreateData {
  const { operationId, ...intent } = request;
  const create = (store: Db) =>
    createAssignmentsWithBackend(
      store,
      teacherId,
      resolve(store),
      kernelAssignmentCreationEnabled,
    );
  const ids =
    operationId === undefined
      ? create(db)
      : createOnce(
          db,
          "assignment",
          teacherId,
          operationId,
          intent,
          z.array(z.uuid()),
          create,
        );
  return {
    assignments: ids.map((id) => teacherAssignmentOf(db, teacherId, id)),
  };
}
