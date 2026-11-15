import type {
  AttemptContextData,
  AttemptMaterialRevisions,
  AttemptWriteProof,
  HintOpenData,
} from "@tutor/contract";
export interface PracticeMaterialsPorts {
  fetchAttemptMaterialRevisionsApi(
    attemptId: string,
  ): Promise<AttemptMaterialRevisions>;
  fetchAttemptContextApi(attemptId: string): Promise<AttemptContextData>;
  openAttemptHintApi(
    attemptId: string,
    questionId: string,
    index: number,
    proof?: AttemptWriteProof,
  ): Promise<HintOpenData>;
}
