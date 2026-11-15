import type { LearningEvent } from "@tutor/contract";
import type { EventScope, EventStoreBackend } from "./event-queue-core";
export interface EventOwner {
  origin: string;
  studentId: string;
}

export type ScopedEventOutboxFactory = (options: {
  scope: EventScope;
  owner: EventOwner;
  store: () => EventStoreBackend;
  isCurrent: () => boolean;
  send?:
    | ((events: readonly LearningEvent[], viewId: string) => Promise<void>)
    | undefined;
  beacon?:
    | ((events: readonly LearningEvent[], viewId: string) => boolean)
    | null
    | undefined;
}) => {
  flush(batches: LearningEvent[][], viewId: string): Promise<void>;
  isDenied: () => boolean;
};
