import type {
  PersonalLoginRequest,
  PersonalRegisterRequest,
  PersonalSessionData,
} from "@tutor/contract";
import { api, callApi } from "@/lib/api";

/**
 * 个人账号接口（模块 0）：与 lib/api.ts 同一 hc 客户端与响应壳解包，独立成模块
 * （api.ts 为历史超限文件，基线只降不升）。两个接口成功都同时写入教师 + 学生
 * 两枚会话 Cookie，响应给出两侧身份。
 */

/**
 * 邀请码自助注册（Q7 定案 b）。错误码：409 TEACHER_NOT_EXISTS 未首启 /
 * 403 PERSONAL_REGISTRATION_DISABLED 未开放 / 403 INVITE_CODE_INVALID 邀请码错 /
 * 409 TEACHER_LOGIN_EXISTS 重名 / 429 LOCKED 同 IP 1 小时超过 5 次。
 */
export function registerPersonalApi(
  request: PersonalRegisterRequest,
): Promise<PersonalSessionData> {
  return callApi(() =>
    api.api.public.personal.register.$post({ json: request }),
  );
}

/** 个人账号登录；班级教师凭证 → 403 ACCOUNT_KIND_MISMATCH（提示走教师登录） */
export function loginPersonalApi(
  request: PersonalLoginRequest,
): Promise<PersonalSessionData> {
  return callApi(() => api.api.public.personal.login.$post({ json: request }));
}
