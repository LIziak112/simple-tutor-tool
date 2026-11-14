import type {
  MemoSourceTarget,
  memoShareStateSchema,
  SharedMemo,
} from "@tutor/contract";
import type { z } from "zod";

type MemoShareState = z.infer<typeof memoShareStateSchema>;
export interface MemoSharingPorts {
  memoTagSuggestionsApi(): Promise<{ tags: string[] }>;
  memoSourceTargetApi(id: string): Promise<MemoSourceTarget>;
  memoShareStateApi(id: string): Promise<MemoShareState>;
  shareMemoApi(id: string, teacherId: string): Promise<MemoShareState>;
  revokeMemoShareApi(id: string): Promise<{ id: string }>;
  sharedMemosApi(
    studentId: string,
    cursor?: string,
  ): Promise<{ memos: SharedMemo[]; nextCursor: string | null }>;
}
