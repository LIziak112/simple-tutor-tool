import type { ReactNode } from "react";
import { prefetchStudentQueries } from "@/features/auth/student-prefetch";
import {
  type PortalRuntime,
  PortalRuntimeProvider,
} from "@/features/runtime/portal-runtime";
import type { ApiServices } from "@/features/runtime/ports/api-services";
import * as api from "@/lib/api";
import * as attachments from "@/lib/attachment-api";
import * as device from "@/lib/device-api";
import * as telemetry from "@/lib/event-queue";
import * as ink from "@/lib/ink-profiles-legacy-api";
import * as learning from "@/lib/learning-source-legacy-api";
import * as memo from "@/lib/memo-api";
import * as memoSharing from "@/lib/memo-enhancement-api";
import * as note from "@/lib/note-endpoints";
import * as headBatch from "@/lib/note-head-batch";
import * as personal from "@/lib/personal-session-legacy-api";
import * as reviewQueue from "@/lib/review-queue-legacy-api";
import * as review from "@/lib/review-v2-legacy-api";
import * as rubric from "@/lib/rubric-api";
import * as settlements from "@/lib/settlements-legacy-api";
import { defaultClientServices } from "@/portals/clients/default-services";
import { portalCapabilitiesOf } from "@/portals/registry";
import { createPortalRoutes } from "@/portals/routes";
/** 测试显式注入现有mock接缝；生产代码没有缺省宿主/缺省端口。 */
export const testClientServices: ApiServices = {
  ...defaultClientServices,
  ...telemetry,
  ...headBatch,
  ...api,
  ...memo,
  ...memoSharing,
  ...device,
  ...attachments,
  ...rubric,
  ...note,
  ...review,
  ...reviewQueue,
  ...learning,
  ...personal,
  ...ink,
  ...settlements,
};
export function createTestRuntime(
  overrides: Partial<PortalRuntime> = {},
): PortalRuntime {
  return {
    portal: "student",
    view: "learning",
    subject: { type: "student", id: "test" },
    accountKind: "class",
    clients: testClientServices,
    routes: createPortalRoutes("student"),
    capabilities: portalCapabilitiesOf("student", "class"),
    capabilitiesFor: portalCapabilitiesOf,
    signal: new AbortController().signal,
    prefetchStudentAfterAuth: (student, cache) => {
      void prefetchStudentQueries(
        cache,
        overrides.clients ?? testClientServices,
        portalCapabilitiesOf("student", student.accountKind).assignments,
      );
    },
    ...overrides,
  };
}
export function TestPortalProvider({
  children,
  runtime = createTestRuntime(),
}: {
  children: ReactNode;
  runtime?: PortalRuntime;
}) {
  return (
    <PortalRuntimeProvider runtime={runtime}>{children}</PortalRuntimeProvider>
  );
}

export const testPortalRoutes = createPortalRoutes("student");
