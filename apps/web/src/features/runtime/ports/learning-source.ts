import type { LearningContext, LearningContextRequest } from "@tutor/contract";
export interface LearningSourcePorts {
  resolveLearningContext(
    reference: LearningContextRequest,
    signal?: AbortSignal,
  ): Promise<LearningContext>;
}
