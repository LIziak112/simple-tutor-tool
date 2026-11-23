import type { AssignmentCreateRequest } from "@tutor/contract";
import type { Db } from "../db/client.ts";
import { kernelAssignments } from "../db/schema-kernel-assignments.ts";
import { HttpError } from "../lib/http-error.ts";
import { createAssignmentIds } from "./assignment-service.ts";
import { requireAssignmentRow } from "./attempt-access.ts";
import {
  assertKernelAssignmentPolicy,
  loadKernelAssignmentQuestions,
} from "./kernel-assignment-input.ts";

export function createAssignmentsWithBackend(
  db: Db,
  teacherId: string,
  request: AssignmentCreateRequest,
  kernelEnabled: boolean,
): string[] {
  if (request.executionBackend !== "kernel")
    return createAssignmentIds(db, teacherId, request);
  if (!kernelEnabled) {
    throw new HttpError(
      409,
      "KERNEL_ASSIGNMENT_DISABLED",
      "当前未开放创建内核作业",
    );
  }
  const studentId = request.studentIds[0];
  if (!studentId)
    throw new HttpError(400, "VALIDATION_ERROR", "作业必须至少指派一名学生");

  return db.transaction(
    (tx) => {
      const ids = createAssignmentIds(db, teacherId, request);
      for (const assignmentId of ids) {
        const assignment = requireAssignmentRow(db, assignmentId);
        assertKernelAssignmentPolicy(assignment);
        loadKernelAssignmentQuestions(db, assignment, studentId);
      }
      tx.insert(kernelAssignments)
        .values(ids.map((assignmentId) => ({ assignmentId })))
        .run();
      return ids;
    },
    { behavior: "immediate" },
  );
}
