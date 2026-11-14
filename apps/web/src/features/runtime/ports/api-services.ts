import type { AccountSettingsPorts } from "./account-settings";
import type { AdministrationPorts } from "./administration";
import type { AiConnectionsPorts } from "./ai-connections";
import type { AiConversationsPorts } from "./ai-conversations";
import type { AiPolicyPorts } from "./ai-policy";
import type { AiTasksPorts } from "./ai-tasks";
import type { AnalyticsPorts } from "./analytics";
import type { AnnotationPorts } from "./annotation";
import type { AssignmentsPorts } from "./assignments";
import type { AttachmentsPorts } from "./attachments";
import type { BackupPorts } from "./backup";
import type { ContentPorts } from "./content";
import type { CoursesPorts } from "./courses";
import type { DevicesPorts } from "./devices";
import type { EventsPorts } from "./events";
import type { ExportPorts } from "./export";
import type { GeneralPorts } from "./general";
import type { InkPorts } from "./ink";
import type { InkProfilesPorts } from "./ink-profiles";
import type { LearnerRecordsPorts } from "./learner-records";
import type { LearnerSessionPorts } from "./learner-session";
import type { LearningSourcePorts } from "./learning-source";
import type { LessonPorts } from "./lesson";
import type { LessonRestartPorts } from "./lesson-restart";
import type { LibraryPorts } from "./library";
import type { MediaPorts } from "./media";
import type { MemoSharingPorts } from "./memo-sharing";
import type { MemosPorts } from "./memos";
import type { NoteReadPorts } from "./note-read";
import type { NoteWritePorts } from "./note-write";
import type { PersonalSessionPorts } from "./personal-session";
import type { PlatformPorts } from "./platform";
import type { PracticePorts } from "./practice";
import type { PracticeMaterialsPorts } from "./practice-materials";
import type { ReportsPorts } from "./reports";
import type { ReviewQueuePorts } from "./review-queue";
import type { ReviewV2Ports } from "./review-v2";
import type { RubricPorts } from "./rubric";
import type { SettlementsPorts } from "./settlements";
import type { SharedPorts } from "./shared";
import type { StudentLinkPorts } from "./student-link";
import type { StudentsPorts } from "./students";
import type { SubmissionPorts } from "./submission";
import type { TeacherRecordsPorts } from "./teacher-records";
export interface ApiServices
  extends PlatformPorts,
    SubmissionPorts,
    EventsPorts,
    StudentLinkPorts,
    LessonRestartPorts,
    MemosPorts,
    MemoSharingPorts,
    RubricPorts,
    AttachmentsPorts,
    DevicesPorts,
    ReviewV2Ports,
    ReviewQueuePorts,
    LearningSourcePorts,
    PersonalSessionPorts,
    InkProfilesPorts,
    SettlementsPorts,
    GeneralPorts,
    ContentPorts,
    CoursesPorts,
    StudentsPorts,
    LearnerSessionPorts,
    AssignmentsPorts,
    PracticePorts,
    PracticeMaterialsPorts,
    LessonPorts,
    InkPorts,
    NoteReadPorts,
    NoteWritePorts,
    AnnotationPorts,
    MediaPorts,
    LibraryPorts,
    AdministrationPorts,
    SharedPorts,
    TeacherRecordsPorts,
    LearnerRecordsPorts,
    AnalyticsPorts,
    ExportPorts,
    AccountSettingsPorts,
    AiPolicyPorts,
    AiConnectionsPorts,
    AiTasksPorts,
    AiConversationsPorts,
    ReportsPorts,
    BackupPorts {}
