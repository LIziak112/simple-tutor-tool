import type {
  AssignmentCheckData,
  AssignmentCheckRequest,
  AssignmentCreateData,
  AssignmentCreateRequest,
  AssignmentDetailData,
  AssignmentUpdateRequest,
  TeacherAssignment,
  TeacherAssignmentListData,
} from "@tutor/contract";
export interface AssignmentsPorts {
  fetchAssignmentsApi(
    courseId: string | undefined,
    includeDeleted: boolean,
  ): Promise<TeacherAssignmentListData>;
  fetchAssignmentDetailApi(id: string): Promise<AssignmentDetailData>;
  checkAssignmentApi(
    request: AssignmentCheckRequest,
  ): Promise<AssignmentCheckData>;
  createAssignmentApi(
    request: AssignmentCreateRequest,
  ): Promise<AssignmentCreateData>;
  updateAssignmentApi(
    id: string,
    request: AssignmentUpdateRequest,
  ): Promise<TeacherAssignment>;
  deleteAssignmentApi(id: string): Promise<null>;
}
