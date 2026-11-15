import type {
  AttemptPartialRequest,
  AttemptSettlementResult,
} from "@tutor/contract";
export interface SettlementsPorts {
  settleAttempt(
    attemptId: string,
    request: AttemptPartialRequest,
  ): Promise<AttemptSettlementResult>;
  readSettlement(
    attemptId: string,
    seq: number,
  ): Promise<AttemptSettlementResult>;
}
