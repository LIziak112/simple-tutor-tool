export type { EventOwner } from "./event-outbox-types";

import { defaultScopedEventOutbox } from "@/portals/clients/legacy-telemetry";
export const createScopedEventOutbox = defaultScopedEventOutbox;
