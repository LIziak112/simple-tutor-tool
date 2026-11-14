import type {
  PersonalLoginRequest,
  PersonalLogoutData,
  PersonalRegisterRequest,
  PersonalSessionData,
  PersonalSessionRole,
} from "@tutor/contract";
import { callApi } from "@/lib/api-response";
import type { HttpRuntime } from "./http-runtime";
export function createPersonalSessionClient(http: HttpRuntime) {
  const { api } = http;
  function registerPersonalApi(
    request: PersonalRegisterRequest,
  ): Promise<PersonalSessionData> {
    return callApi(() =>
      api.api.public.personal.register.$post({ json: request }),
    );
  }
  function loginPersonalApi(
    request: PersonalLoginRequest,
  ): Promise<PersonalSessionData> {
    return callApi(() =>
      api.api.public.personal.login.$post({ json: request }),
    );
  }
  function checkPersonalSessionApi(
    role: PersonalSessionRole,
  ): Promise<PersonalSessionData | null> {
    return callApi(() =>
      api.api.public.personal.session.check.$post({ json: { role } }),
    );
  }
  function logoutPersonalApi(
    role: PersonalSessionRole,
  ): Promise<PersonalLogoutData> {
    return callApi(() =>
      api.api.public.personal.session.logout.$post({ json: { role } }),
    );
  }
  return {
    registerPersonalApi,
    loginPersonalApi,
    checkPersonalSessionApi,
    logoutPersonalApi,
  };
}
