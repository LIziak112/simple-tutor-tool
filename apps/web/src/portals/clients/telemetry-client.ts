import type { EventQueueApi, EventQueueOptions } from "@/lib/event-queue-core";
import { createEventQueueCore } from "@/lib/event-queue-core";
import { createEventTransport } from "./event-transport-client";
import type { HttpRuntime } from "./http-runtime";
import { createScopedEventOutboxClient } from "./scoped-event-outbox-client";
import type { ClientServices } from "./service-types";
export function createTelemetryClient(
  http: HttpRuntime,
  deps: () => ClientServices,
) {
  const transport = {
    ...createEventTransport(http, deps),
    createScopedEventOutbox: createScopedEventOutboxClient(http),
  };
  return {
    createEventQueue: (options: EventQueueOptions): EventQueueApi =>
      createEventQueueCore(options, transport),
  };
}
