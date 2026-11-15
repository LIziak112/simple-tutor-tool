import type { AccountKind, PersonalSessionRole } from "@tutor/contract";
import { useEffect, useRef } from "react";
import {
  usePortalClients,
  usePortalRoutes,
} from "@/features/runtime/portal-runtime";

import { useApplyIdentity } from "./auth-apply";
import { useClearIdentitySessions } from "./auth-clear";
import { useAccountMutation } from "./auth-mutation";

/**
 * 个人账号登录状态（模块 0）：个人账号 = 一条教师行 + 一条绑定学习者行、两枚会话
 * Cookie，前端不新增第三份身份缓存——注册 / 登录成功后把两侧身份分别写进既有的
 * teacher me / student me 缓存（各自的 apply 钩子：学生侧还负责草稿 / 标注 /
 * 偏好等按账号绑定），两端布局守卫与页面照常工作；退出则两侧一起退。
 */

/** 邀请码自助注册（成功即双会话登录） */
export function useRegisterPersonal() {
  const { registerPersonalApi } = usePortalClients();

  const apply = useApplyIdentity();
  return useAccountMutation(registerPersonalApi, (session, operation) =>
    apply(session, undefined, operation),
  );
}

/** 个人账号登录 */
export function useLoginPersonal() {
  const { loginPersonalApi } = usePortalClients();

  const apply = useApplyIdentity();
  return useAccountMutation(loginPersonalApi, (session, operation) =>
    apply(session, undefined, operation),
  );
}

/** 服务端只结束属于本人的会话，按实际结束的角色清理缓存。 */
export function useLogoutPersonal(
  role: PersonalSessionRole,
  onLoggedOut?: () => void,
) {
  const { logoutPersonalApi } = usePortalClients();

  const clear = useClearIdentitySessions();
  return useAccountMutation(
    () => logoutPersonalApi(role),
    ({ paired }, operation) =>
      clear(paired ? ["student", "teacher"] : [role], onLoggedOut, operation),
    [role],
  );
}

/** 身份查询在退出时先清空，外层守卫保留最近一次确认的账号类型。 */
export function useAccountLoginPath(
  kind: AccountKind | undefined,
  fallback: string,
) {
  const routes = usePortalRoutes();

  const lastKind = useRef(kind);
  useEffect(() => {
    if (kind !== undefined) lastKind.current = kind;
  }, [kind]);
  return (kind ?? lastKind.current) === "personal"
    ? routes.portal("personal").loginPath
    : fallback;
}
