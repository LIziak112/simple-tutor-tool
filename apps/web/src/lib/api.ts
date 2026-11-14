/** 旧调用者兼容出口；领域引擎通过runtime接收不可重绑的主体客户端。 */
import { defaultClientServices } from "@/portals/clients/default-services";

export type {
  ReviewPackRole,
  SharedImportRequest,
  UnitMetaUpdate,
} from "@tutor/contract";
export type * from "@/features/runtime/client-types";
export { submitAttemptApi } from "./api-attempt-submit";
export { api } from "./api-client";
export { ApiError, callApi } from "./api-response";
export { AttemptDetailReadTimeoutError } from "./attempt-detail-read";
export { restartLessonAttemptApi } from "./lesson-restart-api";
export {
  postAttemptEventsApi,
  postLectureEventsApi,
} from "./student-events-api";
export { loginStudentByLinkApi } from "./student-link-login-api";
export const fetchHealth = defaultClientServices.fetchHealth;
export const saveBlobAs = defaultClientServices.saveBlobAs;
export const fetchTeacherStatus = defaultClientServices.fetchTeacherStatus;
export const fetchPublicConfig = defaultClientServices.fetchPublicConfig;
export const fetchSpecFile = defaultClientServices.fetchSpecFile;
export const setupTeacher = defaultClientServices.setupTeacher;
export const loginTeacher = defaultClientServices.loginTeacher;
export const registerTeacher = defaultClientServices.registerTeacher;
export const logoutTeacher = defaultClientServices.logoutTeacher;
export const fetchTeacherMe = defaultClientServices.fetchTeacherMe;
export const fetchContentTree = defaultClientServices.fetchContentTree;
export const previewImport = defaultClientServices.previewImport;
export const commitImport = defaultClientServices.commitImport;
export const previewImportBatch = defaultClientServices.previewImportBatch;
export const fetchImportBatch = defaultClientServices.fetchImportBatch;
export const fetchQuestionDetail = defaultClientServices.fetchQuestionDetail;
export const updateQuestion = defaultClientServices.updateQuestion;
export const deleteQuestionApi = defaultClientServices.deleteQuestionApi;
export const fetchLectureDetail = defaultClientServices.fetchLectureDetail;
export const updateLecture = defaultClientServices.updateLecture;
export const deleteLectureApi = defaultClientServices.deleteLectureApi;
export const reorderContentApi = defaultClientServices.reorderContentApi;
export const createCourseApi = defaultClientServices.createCourseApi;
export const updateCourseApi = defaultClientServices.updateCourseApi;
export const deleteCourseApi = defaultClientServices.deleteCourseApi;
export const fetchTeacherCourses = defaultClientServices.fetchTeacherCourses;
export const fetchCourseDetail = defaultClientServices.fetchCourseDetail;
export const fetchCourseStudentView =
  defaultClientServices.fetchCourseStudentView;
export const addCourseItemsApi = defaultClientServices.addCourseItemsApi;
export const reorderCourseItemsApi =
  defaultClientServices.reorderCourseItemsApi;
export const updateCourseItemApi = defaultClientServices.updateCourseItemApi;
export const deleteCourseItemApi = defaultClientServices.deleteCourseItemApi;
export const addCourseMembersApi = defaultClientServices.addCourseMembersApi;
export const removeCourseMembersApi =
  defaultClientServices.removeCourseMembersApi;
export const fetchStudentsApi = defaultClientServices.fetchStudentsApi;
export const createStudentApi = defaultClientServices.createStudentApi;
export const updateStudentApi = defaultClientServices.updateStudentApi;
export const resetStudentPasswordApi =
  defaultClientServices.resetStudentPasswordApi;
export const resetStudentLinkApi = defaultClientServices.resetStudentLinkApi;
export const loginStudentApi = defaultClientServices.loginStudentApi;
export const fetchStudentMe = defaultClientServices.fetchStudentMe;
export const logoutStudentApi = defaultClientServices.logoutStudentApi;
export const fetchStudentAssignmentsApi =
  defaultClientServices.fetchStudentAssignmentsApi;
export const fetchStudentLecturesApi =
  defaultClientServices.fetchStudentLecturesApi;
export const fetchStudentCoursesApi =
  defaultClientServices.fetchStudentCoursesApi;
export const fetchStudentCourseApi =
  defaultClientServices.fetchStudentCourseApi;
export const fetchStudentLectureApi =
  defaultClientServices.fetchStudentLectureApi;
export const fetchAssignmentsApi = defaultClientServices.fetchAssignmentsApi;
export const fetchAssignmentDetailApi =
  defaultClientServices.fetchAssignmentDetailApi;
export const checkAssignmentApi = defaultClientServices.checkAssignmentApi;
export const createAssignmentApi = defaultClientServices.createAssignmentApi;
export const updateAssignmentApi = defaultClientServices.updateAssignmentApi;
export const deleteAssignmentApi = defaultClientServices.deleteAssignmentApi;
export const startAttemptApi = defaultClientServices.startAttemptApi;
export const fetchOpenedAttemptApi =
  defaultClientServices.fetchOpenedAttemptApi;
export const activateAttemptApi = defaultClientServices.activateAttemptApi;
export const fetchStudentUnitLandingApi =
  defaultClientServices.fetchStudentUnitLandingApi;
export const startCourseAttemptApi =
  defaultClientServices.startCourseAttemptApi;
export const startWrongPracticeApi =
  defaultClientServices.startWrongPracticeApi;
export const saveAttemptAnswerApi = defaultClientServices.saveAttemptAnswerApi;
export const setStudentFlagApi = defaultClientServices.setStudentFlagApi;
export const fetchAttemptApi = defaultClientServices.fetchAttemptApi;
export const updateAttemptWorkflowApi =
  defaultClientServices.updateAttemptWorkflowApi;
export const fetchAttemptMaterialRevisionsApi =
  defaultClientServices.fetchAttemptMaterialRevisionsApi;
export const fetchAttemptContextApi =
  defaultClientServices.fetchAttemptContextApi;
export const openAttemptHintApi = defaultClientServices.openAttemptHintApi;
export const fetchLessonLandingApi =
  defaultClientServices.fetchLessonLandingApi;
export const startLessonAttemptApi =
  defaultClientServices.startLessonAttemptApi;
export const submitLessonQuestionApi =
  defaultClientServices.submitLessonQuestionApi;
export const submitPracticeQuestionApi =
  defaultClientServices.submitPracticeQuestionApi;
export const fetchPracticeQuestionFeedbackApi =
  defaultClientServices.fetchPracticeQuestionFeedbackApi;
export const saveSelfReviewApi = defaultClientServices.saveSelfReviewApi;
export const fetchAttemptInkApi = defaultClientServices.fetchAttemptInkApi;
export const putAttemptInkApi = defaultClientServices.putAttemptInkApi;
export const studentInkPngUrl = defaultClientServices.studentInkPngUrl;
export const fetchTeacherInkStrokesApi =
  defaultClientServices.fetchTeacherInkStrokesApi;
export const fetchStudentNoteHeadsApi =
  defaultClientServices.fetchStudentNoteHeadsApi;
export const fetchStudentNoteEvidenceApi =
  defaultClientServices.fetchStudentNoteEvidenceApi;
export const fetchTeacherNoteEvidenceApi =
  defaultClientServices.fetchTeacherNoteEvidenceApi;
export const fetchStudentNoteDocumentApi =
  defaultClientServices.fetchStudentNoteDocumentApi;
export const fetchTeacherNoteDocumentApi =
  defaultClientServices.fetchTeacherNoteDocumentApi;
export const studentNoteImagePngUrl =
  defaultClientServices.studentNoteImagePngUrl;
export const teacherNoteImagePngUrl =
  defaultClientServices.teacherNoteImagePngUrl;
export const postNoteImageApi = defaultClientServices.postNoteImageApi;
export const putNoteDocumentApi = defaultClientServices.putNoteDocumentApi;
export const createCorrectionApi = defaultClientServices.createCorrectionApi;
export const sealCorrectionApi = defaultClientServices.sealCorrectionApi;
export const fetchStudentNotebookApi =
  defaultClientServices.fetchStudentNotebookApi;
export const postAnnotationBaseApi =
  defaultClientServices.postAnnotationBaseApi;
export const postAnnotationBaseImageApi =
  defaultClientServices.postAnnotationBaseImageApi;
export const putAnnotationDocApi = defaultClientServices.putAnnotationDocApi;
export const fetchAnnotationViewApi =
  defaultClientServices.fetchAnnotationViewApi;
export const sealAttemptAnnotationsApi =
  defaultClientServices.sealAttemptAnnotationsApi;
export const fetchTeacherAnnotationViewApi =
  defaultClientServices.fetchTeacherAnnotationViewApi;
export const studentAnnotationBasePngUrl =
  defaultClientServices.studentAnnotationBasePngUrl;
export const teacherAnnotationBasePngUrl =
  defaultClientServices.teacherAnnotationBasePngUrl;
export const postTeacherMediaApi = defaultClientServices.postTeacherMediaApi;
export const fetchCourseProgressApi =
  defaultClientServices.fetchCourseProgressApi;
export const fetchLibraryFolders = defaultClientServices.fetchLibraryFolders;
export const createLibraryFolderApi =
  defaultClientServices.createLibraryFolderApi;
export const renameLibraryFolderApi =
  defaultClientServices.renameLibraryFolderApi;
export const deleteLibraryFolderApi =
  defaultClientServices.deleteLibraryFolderApi;
export const reorderLibraryFoldersApi =
  defaultClientServices.reorderLibraryFoldersApi;
export const fetchLibraryLectures = defaultClientServices.fetchLibraryLectures;
export const fetchLibraryUnits = defaultClientServices.fetchLibraryUnits;
export const updateUnitMetaApi = defaultClientServices.updateUnitMetaApi;
export const deleteUnitApi = defaultClientServices.deleteUnitApi;
export const restoreUnitApi = defaultClientServices.restoreUnitApi;
export const purgeUnitApi = defaultClientServices.purgeUnitApi;
export const updateLectureFolderApi =
  defaultClientServices.updateLectureFolderApi;
export const restoreLectureApi = defaultClientServices.restoreLectureApi;
export const purgeLectureApi = defaultClientServices.purgeLectureApi;
export const fetchUnitUsageApi = defaultClientServices.fetchUnitUsageApi;
export const fetchLectureUsageApi = defaultClientServices.fetchLectureUsageApi;
export const batchLibraryApi = defaultClientServices.batchLibraryApi;
export const downloadExportMd = defaultClientServices.downloadExportMd;
export const downloadTeachingPack = defaultClientServices.downloadTeachingPack;
export const fetchAdminTeachers = defaultClientServices.fetchAdminTeachers;
export const createAdminTeacherApi =
  defaultClientServices.createAdminTeacherApi;
export const updateAdminTeacherApi =
  defaultClientServices.updateAdminTeacherApi;
export const disableAdminTeacherApi =
  defaultClientServices.disableAdminTeacherApi;
export const enableAdminTeacherApi =
  defaultClientServices.enableAdminTeacherApi;
export const resetAdminTeacherPasswordApi =
  defaultClientServices.resetAdminTeacherPasswordApi;
export const fetchAdminSettings = defaultClientServices.fetchAdminSettings;
export const updateAdminSettingsApi =
  defaultClientServices.updateAdminSettingsApi;
export const fetchAdminOverview = defaultClientServices.fetchAdminOverview;
export const fetchSharedFiles = defaultClientServices.fetchSharedFiles;
export const publishUnitToSharedApi =
  defaultClientServices.publishUnitToSharedApi;
export const publishLectureToSharedApi =
  defaultClientServices.publishLectureToSharedApi;
export const previewSharedFile = defaultClientServices.previewSharedFile;
export const importSharedFile = defaultClientServices.importSharedFile;
export const deleteSharedFileApi = defaultClientServices.deleteSharedFileApi;
export const fetchAdminSharedFiles =
  defaultClientServices.fetchAdminSharedFiles;
export const deleteAdminSharedFileApi =
  defaultClientServices.deleteAdminSharedFileApi;
export const fetchTeacherAttemptsApi =
  defaultClientServices.fetchTeacherAttemptsApi;
export const fetchTeacherAttemptDetailApi =
  defaultClientServices.fetchTeacherAttemptDetailApi;
export const fetchTeacherAttemptReplayApi =
  defaultClientServices.fetchTeacherAttemptReplayApi;
export const fetchPendingMarksApi = defaultClientServices.fetchPendingMarksApi;
export const markResponseApi = defaultClientServices.markResponseApi;
export const downloadTeacherExportCsv =
  defaultClientServices.downloadTeacherExportCsv;
export const fetchStudentRecordsApi =
  defaultClientServices.fetchStudentRecordsApi;
export const fetchStudentWrongQuestionsApi =
  defaultClientServices.fetchStudentWrongQuestionsApi;
export const fetchQuestionReviewApi =
  defaultClientServices.fetchQuestionReviewApi;
export const fetchAnalyticsOverviewApi =
  defaultClientServices.fetchAnalyticsOverviewApi;
export const fetchAnalyticsStudentApi =
  defaultClientServices.fetchAnalyticsStudentApi;
export const fetchAnalyticsQuestionsApi =
  defaultClientServices.fetchAnalyticsQuestionsApi;
export const previewLearningPackApi =
  defaultClientServices.previewLearningPackApi;
export const downloadLearningPackApi =
  defaultClientServices.downloadLearningPackApi;
export const fetchReviewPackPreviewApi =
  defaultClientServices.fetchReviewPackPreviewApi;
export const downloadReviewPackApi =
  defaultClientServices.downloadReviewPackApi;
export const downloadAttachmentApi =
  defaultClientServices.downloadAttachmentApi;
export const fetchBackupSnapshots = defaultClientServices.fetchBackupSnapshots;
export const fetchApiToken = defaultClientServices.fetchApiToken;
export const resetApiToken = defaultClientServices.resetApiToken;
export const fetchCapabilityProfile =
  defaultClientServices.fetchCapabilityProfile;
export const saveCapabilityProfile =
  defaultClientServices.saveCapabilityProfile;
export const fetchPracticeFeedbackSettings =
  defaultClientServices.fetchPracticeFeedbackSettings;
export const savePracticeFeedbackSettings =
  defaultClientServices.savePracticeFeedbackSettings;
export const fetchTeacherAiSettingsApi =
  defaultClientServices.fetchTeacherAiSettingsApi;
export const saveTeacherAiSettingsApi =
  defaultClientServices.saveTeacherAiSettingsApi;
export const fetchTeacherAiPromptsApi =
  defaultClientServices.fetchTeacherAiPromptsApi;
export const saveTeacherAiPromptsApi =
  defaultClientServices.saveTeacherAiPromptsApi;
export const fetchStudentAiPromptsApi =
  defaultClientServices.fetchStudentAiPromptsApi;
export const saveStudentAiPromptsApi =
  defaultClientServices.saveStudentAiPromptsApi;
export const fetchAiPolicyOverrideApi =
  defaultClientServices.fetchAiPolicyOverrideApi;
export const putAiPolicyOverrideApi =
  defaultClientServices.putAiPolicyOverrideApi;
export const fetchTeacherAttemptAiRecordsApi =
  defaultClientServices.fetchTeacherAttemptAiRecordsApi;
export const fetchTeacherAiTaskDetailApi =
  defaultClientServices.fetchTeacherAiTaskDetailApi;
export const teacherAiTaskMaterialPngUrl =
  defaultClientServices.teacherAiTaskMaterialPngUrl;
export const fetchStudentQuickButtonsApi =
  defaultClientServices.fetchStudentQuickButtonsApi;
export const saveStudentQuickButtonsApi =
  defaultClientServices.saveStudentQuickButtonsApi;
export const fetchStudentAiConnectionsApi =
  defaultClientServices.fetchStudentAiConnectionsApi;
export const createStudentAiConnectionApi =
  defaultClientServices.createStudentAiConnectionApi;
export const patchStudentAiConnectionApi =
  defaultClientServices.patchStudentAiConnectionApi;
export const deleteStudentAiConnectionApi =
  defaultClientServices.deleteStudentAiConnectionApi;
export const testStudentAiConnectionApi =
  defaultClientServices.testStudentAiConnectionApi;
export const fetchStudentAiConnectionModelsApi =
  defaultClientServices.fetchStudentAiConnectionModelsApi;
export const fetchStudentAiShareAccessStatusApi =
  defaultClientServices.fetchStudentAiShareAccessStatusApi;
export const probeStudentAiConnectionApi =
  defaultClientServices.probeStudentAiConnectionApi;
export const fetchStudentAiStatusApi =
  defaultClientServices.fetchStudentAiStatusApi;
export const createStudentAiTaskApi =
  defaultClientServices.createStudentAiTaskApi;
export const fetchStudentAiAttemptReviewPreviewApi =
  defaultClientServices.fetchStudentAiAttemptReviewPreviewApi;
export const listStudentAiAttemptReviewsApi =
  defaultClientServices.listStudentAiAttemptReviewsApi;
export const createStudentAiAttemptReviewApi =
  defaultClientServices.createStudentAiAttemptReviewApi;
export const postStudentAiAttemptReviewActionApi =
  defaultClientServices.postStudentAiAttemptReviewActionApi;
export const createStudentAiBatchReviewApi =
  defaultClientServices.createStudentAiBatchReviewApi;
export const listStudentAiTasksApi =
  defaultClientServices.listStudentAiTasksApi;
export const fetchStudentAiTaskApi =
  defaultClientServices.fetchStudentAiTaskApi;
export const openStudentAiReplyApi =
  defaultClientServices.openStudentAiReplyApi;
export const createStudentAiShareTicketApi =
  defaultClientServices.createStudentAiShareTicketApi;
export const revokeStudentAiShareTicketsApi =
  defaultClientServices.revokeStudentAiShareTicketsApi;
export const followupStudentAiTaskApi =
  defaultClientServices.followupStudentAiTaskApi;
export const uploadStudentAiTaskMaterialsApi =
  defaultClientServices.uploadStudentAiTaskMaterialsApi;
export const fetchStudentAiQueueSummaryApi =
  defaultClientServices.fetchStudentAiQueueSummaryApi;
export const listStudentAiQueueApi =
  defaultClientServices.listStudentAiQueueApi;
export const studentAiTaskActionApi =
  defaultClientServices.studentAiTaskActionApi;
export const fetchStudentReports = defaultClientServices.fetchStudentReports;
export const fetchReportDetail = defaultClientServices.fetchReportDetail;
export const deleteReportApi = defaultClientServices.deleteReportApi;
export const downloadBackupApi = defaultClientServices.downloadBackupApi;
export const restoreBackupApi = defaultClientServices.restoreBackupApi;
export const manageCourseCatalogApi =
  defaultClientServices.manageCourseCatalogApi;
export const questionProcessStatusApi =
  defaultClientServices.questionProcessStatusApi;
export const uploadQuestionProcessApi =
  defaultClientServices.uploadQuestionProcessApi;
export const fetchTeacherQuestionProcessApi =
  defaultClientServices.fetchTeacherQuestionProcessApi;
