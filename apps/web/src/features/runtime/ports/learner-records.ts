import type { StudentRecordsData, WrongQuestionsData } from "@tutor/contract";
import type {
  StudentRecordsParams,
  WrongQuestionsParams,
} from "@/features/runtime/client-types";
export interface LearnerRecordsPorts {
  fetchStudentRecordsApi(
    params: StudentRecordsParams,
  ): Promise<StudentRecordsData>;
  fetchStudentWrongQuestionsApi(
    params: WrongQuestionsParams,
  ): Promise<WrongQuestionsData>;
}
