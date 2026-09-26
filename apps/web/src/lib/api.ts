import {
  apiResponseSchema,
  type ContentTree,
  type CourseCreateRequest,
  type CourseData,
  type CourseUpdateRequest,
  type ImportCommitData,
  type ImportCommitRequest,
  type ImportPreviewData,
  type ImportPreviewRequest,
  type LectureDetail,
  type LectureUpdateData,
  type LectureUpdateRequest,
  type QuestionDetail,
  type QuestionUpdateData,
  type QuestionUpdateRequest,
  type ReorderRequest,
  type SpecFileName,
  type StudentCreateData,
  type StudentCreateRequest,
  type StudentListData,
  type StudentLoginRequest,
  type StudentMeData,
  type StudentResetLinkData,
  type StudentResetPasswordData,
  type StudentSummary,
  type StudentUpdateRequest,
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

/**
 * 拉取一份 DSL 规范文档（T1.13）：公开接口 /api/public/spec/:file，
 * md/json 原文直出（不走 { ok, data } 统一壳），返回文件文本。
 */
export async function fetchSpecFile(file: SpecFileName): Promise<string> {
  let res: Response;
  try {
    res = await api.api.public.spec[":file"].$get({ param: { file } });
  } catch {
    throw new Error(
      "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
    );
  }
  if (res.status === 404) {
    throw new Error("规范文档不存在（spec 文件缺失，请检查服务端部署）");
  }
  if (!res.ok) {
    throw new Error(`服务器响应异常（HTTP ${res.status}），请稍后重试`);
  }
  return res.text();
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

// ---------- T1.12：单条编辑 / 删除 / 排序 / 课程 CRUD ----------

/** 题目完整内容（编辑抽屉取 sourceMd 原文；unitId/order 供本地 lint 复现缺省 id） */
export function fetchQuestionDetail(id: string): Promise<QuestionDetail> {
  return callApi(() =>
    api.api.teacher.questions[":id"].$get({ param: { id } }),
  );
}

/**
 * 单题编辑（提交 sourceMd 重新解析）。422 分支：
 * LINT_ERROR（extra._issues）/ ID_IMMUTABLE / VALIDATION_ERROR（0 题或多题）。
 *
 * 说明：本仓库路由不用 zod-validator（parseJsonBody 校验，见 http-error.ts），
 * hc 对带 param 的路由只推断出 param 入参，json 以独立变量传入（对象字面量
 * 会触发多余属性检查；运行时 hc 原样携带 json，校验由服务端契约把关）。
 */
export function updateQuestion(
  id: string,
  request: QuestionUpdateRequest,
): Promise<QuestionUpdateData> {
  const args = { param: { id }, json: request };
  return callApi(() => api.api.teacher.questions[":id"].$put(args));
}

/** 题目软删（重新导入同 id 题目即可恢复） */
export function deleteQuestionApi(id: string): Promise<null> {
  return callApi(() =>
    api.api.teacher.questions[":id"].$delete({ param: { id } }),
  );
}

/** 讲义完整内容（编辑抽屉取 markdown 原文，含 H1 标题行） */
export function fetchLectureDetail(id: string): Promise<LectureDetail> {
  return callApi(() => api.api.teacher.lectures[":id"].$get({ param: { id } }));
}

/** 讲义整篇编辑（title 从 H1 重取；无 H1 / 多 H1 时 422；json 传参说明同 updateQuestion） */
export function updateLecture(
  id: string,
  request: LectureUpdateRequest,
): Promise<LectureUpdateData> {
  const args = { param: { id }, json: request };
  return callApi(() => api.api.teacher.lectures[":id"].$put(args));
}

/** 讲义物理删除（可整篇重新导入恢复；关联单元自动解除关联） */
export function deleteLectureApi(id: string): Promise<null> {
  return callApi(() =>
    api.api.teacher.lectures[":id"].$delete({ param: { id } }),
  );
}

/** 拖拽排序：ids 为该 kind 下排序作用域内实体的完整新顺序 */
export function reorderContentApi(request: ReorderRequest): Promise<null> {
  return callApi(() => api.api.teacher.reorder.$post({ json: request }));
}

/** 新建课程 */
export function createCourseApi(
  request: CourseCreateRequest,
): Promise<CourseData> {
  return callApi(() => api.api.teacher.courses.$post({ json: request }));
}

/** 课程重命名（title 缺省 = 不改；json 传参说明同 updateQuestion） */
export function updateCourseApi(
  id: string,
  request: CourseUpdateRequest,
): Promise<CourseData> {
  const args = { param: { id }, json: request };
  return callApi(() => api.api.teacher.courses[":id"].$patch(args));
}

/** 删除课程（课程下有讲义/单元时后端 409 COURSE_NOT_EMPTY） */
export function deleteCourseApi(id: string): Promise<null> {
  return callApi(() =>
    api.api.teacher.courses[":id"].$delete({ param: { id } }),
  );
}

// ---------- T2.1：学生管理（教师端） ----------

/** 学生列表（默认只列未归档；includeArchived=true 含归档学生） */
export function fetchStudentsApi(
  includeArchived: boolean,
): Promise<StudentListData> {
  return callApi(() =>
    api.api.teacher.students.$get(
      includeArchived ? { query: { includeArchived: "true" } } : undefined,
    ),
  );
}

/**
 * 新增学生。响应 initialPassword 为服务端生成的一次性初始密码明文
 * （教师自备密码时为 null）——只在此响应出现一次，需立即展示/转达。
 */
export function createStudentApi(
  request: StudentCreateRequest,
): Promise<StudentCreateData> {
  return callApi(() => api.api.teacher.students.$post({ json: request }));
}

/**
 * 更新学生（改名/登录名/开关两种登录方式/归档/备注；字段缺省 = 不改）。
 * 409 LOGIN_NAME_TAKEN / 404 STUDENT_NOT_FOUND 由调用方 catch ApiError 分支处理。
 * json 以独立变量传入的原因同 updateQuestion（parseJsonBody 服务端校验）。
 */
export function updateStudentApi(
  id: string,
  request: StudentUpdateRequest,
): Promise<StudentSummary> {
  const args = { param: { id }, json: request };
  return callApi(() => api.api.teacher.students[":id"].$patch(args));
}

/** 重置学生密码：响应返回一次性新密码明文（旧密码立即失效） */
export function resetStudentPasswordApi(
  id: string,
): Promise<StudentResetPasswordData> {
  return callApi(() =>
    // 路径段按实际路由名取（reset-password，连字符），hc 不做驼峰转换
    api.api.teacher.students[":id"]["reset-password"].$post({
      param: { id },
    }),
  );
}

/** 重置专属链接：旧链接立即失效，响应返回新 linkToken（前端拼 `${origin}/s/${token}`） */
export function resetStudentLinkApi(id: string): Promise<StudentResetLinkData> {
  return callApi(() =>
    api.api.teacher.students[":id"]["reset-link"].$post({ param: { id } }),
  );
}

// ---------- T2.1：学生登录（公开，学生端页面 T2.3 使用；本任务供联调验证） ----------

/** 学生登录名+密码登录（成功写 90 天学生会话 Cookie，返回学生基本信息） */
export function loginStudentApi(
  request: StudentLoginRequest,
): Promise<StudentMeData> {
  return callApi(() => api.api.public.student.login.$post({ json: request }));
}
