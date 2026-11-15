import { createNoteHeadBatchClient } from "@/portals/clients/note-head-batch-client";
import * as api from "./api";
export const { fetchStudentNoteHeadCoalesced, resetNoteHeadBatchForTest } =
  createNoteHeadBatchClient({
    fetchStudentNoteHeadsApi: (attemptId, questionIds) =>
      api.fetchStudentNoteHeadsApi(attemptId, questionIds),
  });
