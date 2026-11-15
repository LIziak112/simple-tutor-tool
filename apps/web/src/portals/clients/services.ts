import { createAccountSettingsClient } from "./account-settings-client";
import { createAdministrationClient } from "./administration-client";
import { createAiConnectionsClient } from "./ai-connections-client";
import { createAiConversationsClient } from "./ai-conversations-client";
import { createAiPolicyClient } from "./ai-policy-client";
import { createAiTasksClient } from "./ai-tasks-client";
import { createAnalyticsClient } from "./analytics-client";
import { createAnnotationClient } from "./annotation-client";
import { createAssignmentsClient } from "./assignments-client";
import { createAttachmentsClient } from "./attachments-client";
import { createBackupClient } from "./backup-client";
import { createContentClient } from "./content-client";
import { createCoursesClient } from "./courses-client";
import { createDevicesClient } from "./devices-client";
import { createEventsClient } from "./events-client";
import { createExportClient } from "./export-client";
import { createGeneralClient } from "./general-client";
import type { HttpRuntime } from "./http-runtime";
import { createInkClient } from "./ink-client";
import { createInkProfilesClient } from "./ink-profiles-client";
import { createLearnerRecordsClient } from "./learner-records-client";
import { createLearnerSessionClient } from "./learner-session-client";
import { createLearningSourceClient } from "./learning-source-client";
import { createLessonClient } from "./lesson-client";
import { createLessonRestartClient } from "./lesson-restart-client";
import { createLibraryClient } from "./library-client";
import { createMediaClient } from "./media-client";
import { createMemoSharingClient } from "./memo-sharing-client";
import { createMemosClient } from "./memos-client";
import { createNoteHeadBatchClient } from "./note-head-batch-client";
import { createNoteReadClient } from "./note-read-client";
import { createNoteWriteClient } from "./note-write-client";
import { createPersonalSessionClient } from "./personal-session-client";
import { createPlatformClient } from "./platform-client";
import { createPracticeClient } from "./practice-client";
import { createPracticeMaterialsClient } from "./practice-materials-client";
import { createReportsClient } from "./reports-client";
import { createReviewQueueClient } from "./review-queue-client";
import { createReviewV2Client } from "./review-v2-client";
import { createRubricClient } from "./rubric-client";
import type { ClientServices } from "./service-types";
import { createSettlementsClient } from "./settlements-client";
import { createSharedClient } from "./shared-client";
import { createStudentLinkClient } from "./student-link-client";
import { createStudentsClient } from "./students-client";
import { createSubmissionClient } from "./submission-client";
import { createTeacherRecordsClient } from "./teacher-records-client";
import { createTelemetryClient } from "./telemetry-client";
export function createClientServices(http: HttpRuntime): ClientServices {
  const deps = (): ClientServices => services;
  const services: ClientServices = {
    ...createPlatformClient(http, deps),
    ...createTelemetryClient(http, deps),
    fetchStudentNoteHeadCoalesced: createNoteHeadBatchClient({
      fetchStudentNoteHeadsApi: (attemptId, questionIds) =>
        deps().fetchStudentNoteHeadsApi(attemptId, questionIds),
    }).fetchStudentNoteHeadCoalesced,
    ...createSubmissionClient(http),
    ...createEventsClient(http),
    ...createStudentLinkClient(http),
    ...createLessonRestartClient(http),
    ...createMemosClient(http),
    ...createMemoSharingClient(http),
    ...createRubricClient(http),
    ...createAttachmentsClient(http),
    ...createDevicesClient(http),
    ...createReviewV2Client(http),
    ...createReviewQueueClient(http),
    ...createLearningSourceClient(http),
    ...createPersonalSessionClient(http),
    ...createInkProfilesClient(http),
    ...createSettlementsClient(http),
    ...createGeneralClient(http, deps),
    ...createContentClient(http, deps),
    ...createCoursesClient(http, deps),
    ...createStudentsClient(http, deps),
    ...createLearnerSessionClient(http, deps),
    ...createAssignmentsClient(http, deps),
    ...createPracticeClient(http, deps),
    ...createPracticeMaterialsClient(http, deps),
    ...createLessonClient(http, deps),
    ...createInkClient(http, deps),
    ...createNoteReadClient(http, deps),
    ...createNoteWriteClient(http, deps),
    ...createAnnotationClient(http, deps),
    ...createMediaClient(http, deps),
    ...createLibraryClient(http, deps),
    ...createAdministrationClient(http, deps),
    ...createSharedClient(http, deps),
    ...createTeacherRecordsClient(http, deps),
    ...createLearnerRecordsClient(http, deps),
    ...createAnalyticsClient(http, deps),
    ...createExportClient(http, deps),
    ...createAccountSettingsClient(http, deps),
    ...createAiPolicyClient(http, deps),
    ...createAiConnectionsClient(http, deps),
    ...createAiTasksClient(http, deps),
    ...createAiConversationsClient(http, deps),
    ...createReportsClient(http, deps),
    ...createBackupClient(http, deps),
  };
  return Object.freeze(services);
}
export type { ClientServices } from "./service-types";
