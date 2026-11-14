import { createSubjectScope } from "../subject-scope";
import { defaultClientServices } from "./default-services";
import { createEventTransport } from "./event-transport-client";
import { createHttpRuntime } from "./http-runtime";
import { createScopedEventOutboxClient } from "./scoped-event-outbox-client";
export const legacyTelemetryHttp = createHttpRuntime(
  createSubjectScope({ type: "student", id: "legacy" }, (...args) =>
    globalThis.fetch(...args),
  ),
);
export const defaultEventTransport = createEventTransport(
  legacyTelemetryHttp,
  () => defaultClientServices,
);
export const defaultScopedEventOutbox =
  createScopedEventOutboxClient(legacyTelemetryHttp);
