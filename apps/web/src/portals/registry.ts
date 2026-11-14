import type { AccountKind } from "@tutor/contract";

/** 门户地址唯一出处；管理端复用教师认证和 Cookie。 */
export const PORTALS = {
  student: { label: "学生端", loginPath: "/s/login", homePath: "/s/home" },
  teacher: { label: "教师端", loginPath: "/t/login", homePath: "/t" },
  personal: {
    label: "个人学习端",
    loginPath: "/p/login",
    homePath: "/p/learn/home",
  },
  admin: { label: "管理端", loginPath: "/t/login", homePath: "/a" },
} as const;
export type PortalId = keyof typeof PORTALS;

const LEARNING_CAPABILITIES = {
  practice: true,
  courses: true,
  records: true,
  memos: true,
  resourceManagement: false,
  assignments: true,
  members: false,
  teacherAiConnections: false,
  showLoginName: true,
  accountAdministration: false,
};
const MANAGEMENT_CAPABILITIES = {
  ...LEARNING_CAPABILITIES,
  practice: false,
  memos: false,
  resourceManagement: true,
  members: true,
  teacherAiConnections: true,
};
const PERSONAL_RESTRICTIONS = {
  assignments: false,
  members: false,
  teacherAiConnections: false,
  showLoginName: false,
};

const NO_CAPABILITIES = {
  ...LEARNING_CAPABILITIES,
  practice: false,
  courses: false,
  records: false,
  memos: false,
  assignments: false,
  showLoginName: false,
};

/** 能力按门户与账号类型集中维护；服务端权限与管理员身份仍由会话裁决。 */
const CAPABILITIES = {
  student: {
    class: LEARNING_CAPABILITIES,
    personal: { ...LEARNING_CAPABILITIES, ...PERSONAL_RESTRICTIONS },
  },
  teacher: {
    class: MANAGEMENT_CAPABILITIES,
    personal: { ...MANAGEMENT_CAPABILITIES, ...PERSONAL_RESTRICTIONS },
  },
  personal: {
    class: NO_CAPABILITIES,
    personal: {
      ...LEARNING_CAPABILITIES,
      ...PERSONAL_RESTRICTIONS,
      resourceManagement: true,
    },
  },
  admin: {
    class: {
      ...NO_CAPABILITIES,
      accountAdministration: true,
      showLoginName: true,
    },
    personal: NO_CAPABILITIES,
  },
} as const;
export type PortalCapability = keyof typeof LEARNING_CAPABILITIES;
export function portalCapabilitiesOf(portal: PortalId, kind: AccountKind) {
  return CAPABILITIES[portal][kind];
}

/** 只接受可进入的站内业务页，防止外跳、路径编码绕过和登录循环。 */
export function safeReturnTo(
  value: string | null | undefined,
  portal: PortalId,
  fallback: string = PORTALS[portal].homePath,
): string {
  if (
    !value?.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\s]|%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)
  )
    return fallback;
  const url = new URL(value, "https://portal.local");
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return fallback;
  }
  if (/^\/(?:s|t|p)\/(?:login|register|setup)(?:\/|$)/i.test(path))
    return fallback;
  const studentPath =
    /^\/s\/(?:home|assignments|courses|lectures|attempts|wrong|records|settings|memos|notebook)(?:\/|$)/.test(
      path,
    );
  const teacherPath = /^\/t(?:\/|$)/.test(path);
  const adminPath = /^\/a(?:\/|$)/.test(path);
  const allowed =
    portal === "personal"
      ? studentPath ||
        teacherPath ||
        /^\/p\/(?:learn|manage)(?:\/|$)/.test(path)
      : portal === "student"
        ? studentPath
        : portal === "admin"
          ? adminPath
          : teacherPath || adminPath;
  if (!allowed) return fallback;
  if (portal === "personal" && (studentPath || teacherPath)) {
    const view = studentPath ? "learn" : "manage";
    const tail = url.pathname.slice(2) || "/library";
    return `/p/${view}${tail}${url.search}${url.hash}`;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export { loginPathWithReturnTo } from "@/features/auth/return-navigation";
