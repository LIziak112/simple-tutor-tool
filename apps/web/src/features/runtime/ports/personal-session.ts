import type {
  PersonalLoginRequest,
  PersonalLogoutData,
  PersonalRegisterRequest,
  PersonalSessionData,
  PersonalSessionRole,
} from "@tutor/contract";
export interface PersonalSessionPorts {
  registerPersonalApi(
    request: PersonalRegisterRequest,
  ): Promise<PersonalSessionData>;
  loginPersonalApi(request: PersonalLoginRequest): Promise<PersonalSessionData>;
  checkPersonalSessionApi(
    role: PersonalSessionRole,
  ): Promise<PersonalSessionData | null>;
  logoutPersonalApi(role: PersonalSessionRole): Promise<PersonalLogoutData>;
}
