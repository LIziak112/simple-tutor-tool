import {
  apiResponseSchema,
  type ContentTree,
  type ImportCommitData,
  type ImportCommitRequest,
  type ImportPreviewData,
  type ImportPreviewRequest,
  type TeacherInfo,
  type TeacherStatusData,
} from "@tutor/contract";
import { hc } from "hono/client";
import type { AppType } from "server";

/**
 * Hono RPC 类型客户端：路由类型来自 apps/server 的 AppType，端到端类型安全。
 * 基址用相对路径 "/"（mergePath 拼出 "/api/..." 相对地址）：
 * - 开发环境经 Vite 代理转发到 127.0.0.1:8787；
 * - 生产环境与页面同源（apps/server 托管 apps/web/dist），无需任何配置。
 */
export const api = hc<AppType>("/");

/** health 接口的数据部分 */
export interface HealthData {
  /** UTC ISO 字符串（§0.3 时间约定：传输与存储一律 UTC，界面再转 Asia/Shanghai） */
  time: string;
}

/** 查询服务健康状态。失败时抛带中文提示的 Error，交给 TanStack Query 错误态展示 */
export async function fetchHealth(): Promise<HealthData> {
  let res: Awaited<ReturnType<typeof api.api.public.health.$get>>;
  try {
    res = await api.api.public.health.$get();
  } catch {
    // 网络层失败（后端未启动、代理不可达等）
    throw new Error(
      "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
    );
  }
  if (!res.ok) {
    throw new Error(`服务器响应异常（HTTP ${res.status}），请稍后重试`);
  }
  const body = await res.json();
  return body.data;
}

/**
 * 后端返回的业务错误（{ ok:false } 壳）：带 UPPER_SNAKE 错误码，
 * 页面按 code 分支展示（如 INVALID_CREDENTIALS / LOCKED / UNAUTHORIZED）。
 * extra 为统一壳之外的附加字段（如导入 commit 422 LINT_ERROR 携带的 _issues）。
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 调用 hc 接口并解包响应壳（T1.9 起）：
 * - 成功 → 返回 data 部分；
 * - { ok:false } → 抛 ApiError（code + 服务端中文 message + 壳外附加字段）；
 * - 网络失败 / 响应不符合契约壳 → 抛带中文提示的 Error。
 * 响应壳用共享契约 apiResponseSchema 校验，避免前端手写同一结构。
 */
async function callApi<TData>(fn: () => Promise<Response>): Promise<TData> {
  let res: Response;
  try {
    res = await fn();
  } catch {
    throw new Error(
      "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`服务器响应异常（HTTP ${res.status}），请稍后重试`);
  }
  const parsed = apiResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`服务器响应异常（HTTP ${res.status}），请稍后重试`);
  }
  if (!parsed.data.ok) {
    throw new ApiError(
      parsed.data.error,
      parsed.data.message,
      res.status,
      pickExtraFields(body),
    );
  }
  return parsed.data.data as TData;
}

/** 取统一壳（ok/error/message）之外的附加字段（如 LINT_ERROR 的 _issues） */
function pickExtraFields(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== "ok" && key !== "error" && key !== "message") {
      extra[key] = value;
    }
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/** 查询是否已设置教师（首启判断，无登录要求） */
export function fetchTeacherStatus(): Promise<TeacherStatusData> {
  return callApi(() => api.api.public.teacher.status.$get());
}

/** 首次设置教师密码（仅无教师时可用；成功即自动登录并返回教师信息） */
export function setupTeacher(password: string): Promise<TeacherInfo> {
  return callApi(() =>
    api.api.public.teacher.setup.$post({ json: { password } }),
  );
}

/** 教师密码登录（连续失败 5 次会被临时锁定，见后端 §5.7 限流） */
export function loginTeacher(password: string): Promise<TeacherInfo> {
  return callApi(() =>
    api.api.public.teacher.login.$post({ json: { password } }),
  );
}

/** 退出登录（删除会话并清除 Cookie） */
export function logoutTeacher(): Promise<null> {
  return callApi(() => api.api.teacher.logout.$post());
}

/** 当前登录教师信息（未登录 / 会话过期时后端返回 401 UNAUTHORIZED） */
export function fetchTeacherMe(): Promise<TeacherInfo> {
  return callApi(() => api.api.teacher.me.$get());
}

/** 教师端内容树（课程 → 讲义/单元 → 题目摘要；未导入任何内容时 courses 为空数组） */
export function fetchContentTree(): Promise<ContentTree> {
  return callApi(() => api.api.teacher.content.$get());
}

/** 导入预览（dry-run，不写库）：识别版本 + 摘要 + 全部 lint issues */
export function previewImport(
  request: ImportPreviewRequest,
): Promise<ImportPreviewData> {
  return callApi(() => api.api.teacher.import.preview.$post({ json: request }));
}

/**
 * 导入提交（落库）。有 error 级 issue 时后端返回 422，
 * callApi 会抛 code=LINT_ERROR 的 ApiError（extra._issues 为错误列表），
 * 由调用方 catch 后并入错误面板。
 */
export function commitImport(
  request: ImportCommitRequest,
): Promise<ImportCommitData> {
  return callApi(() => api.api.teacher.import.commit.$post({ json: request }));
}
