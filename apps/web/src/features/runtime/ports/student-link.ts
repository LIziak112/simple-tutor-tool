import type { StudentMeData } from "@tutor/contract";
export interface StudentLinkPorts {
  loginStudentByLinkApi(
    token: string,
    signal?: AbortSignal,
  ): Promise<StudentMeData>;
}
