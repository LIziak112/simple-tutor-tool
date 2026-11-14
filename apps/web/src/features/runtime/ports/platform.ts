import type {
  NoteHeadData,
  StudentMcpLiveFocusRequest,
  studentMcpLiveFocusCapabilitySchema,
} from "@tutor/contract";
import type { z } from "zod";
import type { EventQueueApi, EventQueueOptions } from "@/lib/event-queue-core";
import type { NoteRole } from "../client-types";
export interface PlatformPorts {
  sharedMemoMediaUrl(studentId: string, memoId: string): string;
  isEvidenceDownloadUrl(url: string | undefined): boolean;
  fetchMcpLiveFocusCapability(): Promise<
    z.infer<typeof studentMcpLiveFocusCapabilitySchema>
  >;
  putMcpLiveFocus(
    attemptId: string,
    input: StudentMcpLiveFocusRequest,
  ): Promise<void>;
  createEventQueue(options: EventQueueOptions): EventQueueApi;
  fetchStudentNoteHeadCoalesced(
    attemptId: string,
    questionId: string,
  ): Promise<NoteHeadData>;
  readPrivateBlob(url: string, signal?: AbortSignal): Promise<Blob>;
  fetchNoteEvidenceApi(
    role: NoteRole,
    attemptId: string,
    questionId: string,
  ): Promise<NoteHeadData>;
  fetchNoteDocumentApi(role: NoteRole, versionId: string): Promise<unknown>;
}
