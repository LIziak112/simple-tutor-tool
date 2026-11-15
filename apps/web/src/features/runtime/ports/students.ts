import type {
  StudentCreateData,
  StudentCreateRequest,
  StudentListData,
  StudentResetLinkData,
  StudentResetPasswordData,
  StudentSummary,
  StudentUpdateRequest,
} from "@tutor/contract";
export interface StudentsPorts {
  fetchStudentsApi(includeArchived: boolean): Promise<StudentListData>;
  createStudentApi(request: StudentCreateRequest): Promise<StudentCreateData>;
  updateStudentApi(
    id: string,
    request: StudentUpdateRequest,
  ): Promise<StudentSummary>;
  resetStudentPasswordApi(id: string): Promise<StudentResetPasswordData>;
  resetStudentLinkApi(id: string): Promise<StudentResetLinkData>;
}
