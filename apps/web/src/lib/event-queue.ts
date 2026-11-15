export * from "./event-queue-core";

import { defaultClientServices } from "@/portals/clients/default-services";
import { createEventTransport } from "@/portals/clients/event-transport-client";
import {
  defaultEventTransport,
  defaultScopedEventOutbox,
  legacyTelemetryHttp,
} from "@/portals/clients/legacy-telemetry";
import * as api from "./api";
import {
  createEventQueueCore,
  type EventQueueOptions,
} from "./event-queue-core";

const transport = createEventTransport(legacyTelemetryHttp, () => ({
  ...defaultClientServices,
  ...api,
}));
export const createEventQueue = (options: EventQueueOptions) =>
  createEventQueueCore(options, {
    ...defaultEventTransport,
    ...transport,
    createScopedEventOutbox: defaultScopedEventOutbox,
  });
