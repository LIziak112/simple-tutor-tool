import {
  type AdminOverviewData,
  type AdminSettingsData,
  type AdminSettingsUpdateRequest,
  type AdminTeacherCreateData,
  type AdminTeacherCreateRequest,
  type AdminTeacherListData,
  type AdminTeacherResetPasswordData,
  type AdminTeacherResetPasswordRequest,
  type AdminTeacherSummary,
  type AdminTeacherUpdateRequest,
  type AnalyticsOverviewData,
  type AnalyticsQuestionsData,
  type AnalyticsStudentData,
  type AssignmentCheckData,
  type AssignmentCheckRequest,
  type AssignmentCreateData,
  type AssignmentCreateRequest,
  type AssignmentDetailData,
  type AssignmentUpdateRequest,
  type AttemptAnswerSaveData,
  type AttemptAnswerSaveRequest,
  type AttemptDetailData,
  type AttemptEvent,
  type AttemptSource,
  type AttemptStartData,
  type AttemptStatus,
  type AttemptSubmitRequest,
  apiResponseSchema,
  type BackupRestoreResult,
  type BackupSnapshotList,
  type ContentTree,
  type CourseCreateRequest,
  type CourseData,
  type CourseDetailData,
  type CourseItemsAddData,
  type CourseItemsAddRequest,
  type CourseItemsReorderRequest,
  type CourseItemUpdateRequest,
  type CourseListData,
  type CourseMembersRequest,
  type CourseProgressData,
  type CourseStudentViewData,
  type CourseUpdateRequest,
  type HintOpenData,
  type ImportBatchData,
  type ImportCommitData,
  type ImportCommitRequest,
  type ImportPreviewBatchData,
  type ImportPreviewBatchRequest,
  type ImportPreviewData,
  type ImportPreviewRequest,
  type InkDoc,
  type InkUploadData,
  type LearningEventBatchData,
  type LearningPackExportRequest,
  type LearningPackPreviewData,
  type LectureDetail,
  type LectureEvent,
  type LectureMetaData,
  type LectureMetaUpdate,
  type LectureUpdateData,
  type LectureUpdateRequest,
  type LibraryBatchData,
  type LibraryBatchRequest,
  type LibraryFolder,
  type LibraryFolderCreate,
  type LibraryFolderReorder,
  type LibraryFolderUpdate,
  type LibraryLectureList,
  type LibraryUnitList,
  type LibraryUsage,
  type MarkRequest,
  type MarkResponseData,
  type MediaUploadResult,
  NOTE_IMAGE_FORM_FIELDS,
  type NoteHeadData,
  type NoteImageMeta,
  type NoteImageUploadMeta,
  type NoteUploadMeta,
  type NoteVersionReceipt,
  type PendingMarkListData,
  type PublicConfigData,
  type QuestionDetail,
  type QuestionUpdateData,
  type QuestionUpdateRequest,
  type ReorderRequest,
  type ReportDetail,
  type ReportListData,
  type ReviewPackPreviewData,
  type ReviewPackRole,
  type SharedFileList,
  type SharedImportRequest,
  type SharedPreviewData,
  type SharedPreviewRequest,
  type SharedPublishData,
  type SpecFileName,
  type StudentAssignmentListData,
  type StudentCourseDetailData,
  type StudentCourseListData,
  type StudentCreateData,
  type StudentCreateRequest,
  type StudentLectureDetail,
  type StudentLectureListData,
  type StudentListData,
  type StudentLoginRequest,
  type StudentMeData,
  type StudentRecordsData,
  type StudentResetLinkData,
  type StudentResetPasswordData,
  type StudentSummary,
  type StudentUnitLandingData,
  type StudentUpdateRequest,
  type TeacherApiTokenData,
  type TeacherApiTokenResetData,
  type TeacherAssignment,
  type TeacherAssignmentListData,
  type TeacherAttemptDetailData,
  type TeacherAttemptListData,
  type TeacherInfo,
  type TeacherLoginRequest,
  type TeacherRegisterRequest,
  type TeacherSetupRequest,
  type TeacherStatusData,
  type UnitMetaData,
  type UnitMetaUpdate,
  type WrongQuestionsData,
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
  } catch (err) {
    // 中止身份保留（T6R.8 复审⑬）：AbortError 原样上抛——调用方（note-sync）
    // 据此区分「会话切换主动中止（丢弃）」与网络错误（退避）；其余失败
    // 归并中文网络文案
    if (err instanceof Error && err.name === "AbortError") throw err;
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

/**
 * 非 2xx 响应 → 抛错（口径同 callApi 的错误路径，供文件直出接口复用）：
 * { ok:false } 统一壳 → ApiError（code + 服务端中文 message + 壳外附加字段），
 * 调用方按 code 分支（如 404 INK_NOT_FOUND 降级）；壳解析失败/非壳 → 通用中文 Error。
 */
async function throwShellError(res: Response): Promise<never> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`服务器响应异常（HTTP ${res.status}），请稍后重试`);
  }
  const parsed = apiResponseSchema.safeParse(body);
  if (parsed.success && !parsed.data.ok) {
    throw new ApiError(
      parsed.data.error,
      parsed.data.message,
      res.status,
      pickExtraFields(body),
    );
  }
  throw new Error(`服务器响应异常（HTTP ${res.status}），请稍后重试`);
}

/**
 * 触发浏览器保存 blob（a[download] 短挂载；object URL 用后即撤）。
 * api.ts 内全部文件直出下载（CSV/MD/学情包/单题包/逐张图片/备份）共用，
 * 不再各自手抄 anchor 七行。
 */
function saveBlobAs(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // revoke 延迟到下一轮宏任务（/code-review 角A）：Safari/WebKit 在同轮
    // 事件里 revoke 会导致下载拿到空 blob（iPad 支持面的已知怪癖）
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Content-Disposition → 下载文件名（filename="…" 形态；取不到回退 fallback）。
 * 中文文件名的 filename*=UTF-8'' 形态另见 downloadExportMd（唯一特例，不并）。
 */
function filenameFromDisposition(res: Response, fallback: string): string {
  const disposition = res.headers.get("content-disposition") ?? "";
  // 负向断言排除 filename*= 形态（RFC 5987 编码形态只有 downloadExportMd
  // 那一处理——它的 `*=UTF-8''` 前缀会被本正则误捕，这里不受理）
  const matched = /filename(?!\*)="?([^";]+)"?/i.exec(disposition)?.[1];
  return matched !== undefined && matched.length > 0 ? matched : fallback;
}

/** 查询是否已设置教师（首启判断，无登录要求） */
export function fetchTeacherStatus(): Promise<TeacherStatusData> {
  return callApi(() => api.api.public.teacher.status.$get());
}

/**
 * 运行时公开配置（T2.12）：pwaEnabled 随服务端 PUBLIC_URL 协议，
 * 前端入口据此决定是否注册 Service Worker（lib/pwa.ts）。
 */
export function fetchPublicConfig(): Promise<PublicConfigData> {
  return callApi(() => api.api.public.config.$get());
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

/** 首次创建教师账号（登录名 + 密码，仅无教师时可用；成功即自动登录并返回教师信息） */
export function setupTeacher(
  request: TeacherSetupRequest,
): Promise<TeacherInfo> {
  return callApi(() => api.api.public.teacher.setup.$post({ json: request }));
}

/** 教师登录名 + 密码登录（连续失败 5 次会被临时锁定，见后端 §5.7 限流） */
export function loginTeacher(
  request: TeacherLoginRequest,
): Promise<TeacherInfo> {
  return callApi(() => api.api.public.teacher.login.$post({ json: request }));
}

/**
 * 教师自助注册（T2B.6，D3 来源一）：成功创建 isAdmin=false 教师并自动登录。
 * 403 REGISTRATION_DISABLED = 注册开关已关；409 TEACHER_LOGIN_EXISTS = 登录名冲突；
 * 409 TEACHER_NOT_EXISTS = 尚未做过首启；429 LOCKED = 同 IP 1 小时超过 5 次。
 */
export function registerTeacher(
  request: TeacherRegisterRequest,
): Promise<TeacherInfo> {
  return callApi(() =>
    api.api.public.teacher.register.$post({ json: request }),
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

/** 导入预览（dry-run，不写库）：摘要 + 全部 lint issues */
export function previewImport(
  request: ImportPreviewRequest,
): Promise<ImportPreviewData> {
  return callApi(() => api.api.teacher.import.preview.$post({ json: request }));
}

/**
 * 导入提交（落库）。有 error 级 issue 时后端返回 422，
 * callApi 会抛 code=LINT_ERROR 的 ApiError（extra._issues 为错误列表），
 * 由调用方 catch 后并入错误面板。
 * T2A.3：批量提交由前端逐文件携带 batchId 顺序调用（每文件独立事务）。
 */
export function commitImport(
  request: ImportCommitRequest,
): Promise<ImportCommitData> {
  return callApi(() => api.api.teacher.import.commit.$post({ json: request }));
}

/**
 * 批量导入预览（D20，不写库）：每文件预览 + 跨文件冲突 + autoFolderBySubdir
 * 目标文件夹解析。超规模上限后端 413 IMPORT_TOO_LARGE（前端已按同一组常量预检）。
 */
export function previewImportBatch(
  request: ImportPreviewBatchRequest,
): Promise<ImportPreviewBatchData> {
  return callApi(() =>
    api.api.teacher.import["preview-batch"].$post({ json: request }),
  );
}

/** 批次记录回看（逐文件 commit 携带同一 batchId 后可查；无成功记录返回空 files） */
export function fetchImportBatch(batchId: string): Promise<ImportBatchData> {
  return callApi(() =>
    api.api.teacher.import.batches[":batchId"].$get({ param: { batchId } }),
  );
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

/** 新建课程（title 即课程名；description 可选，T2A.4） */
export function createCourseApi(
  request: CourseCreateRequest,
): Promise<CourseData> {
  return callApi(() => api.api.teacher.courses.$post({ json: request }));
}

/**
 * 更新课程（name/title 同义、description 显式 null 清空、archived 归档开关；
 * json 传参说明同 updateQuestion）。
 */
export function updateCourseApi(
  id: string,
  request: CourseUpdateRequest,
): Promise<CourseData> {
  const args = { param: { id }, json: request };
  return callApi(() => api.api.teacher.courses[":id"].$patch(args));
}

/** 删除课程（有作答记录或按课程布置的作业时后端 409 COURSE_HAS_ATTEMPTS，D4：提示改用归档） */
export function deleteCourseApi(id: string): Promise<null> {
  return callApi(() =>
    api.api.teacher.courses[":id"].$delete({ param: { id } }),
  );
}

// ---------- T2A.4：课程编辑页（目录编排 + 可见性 + 成员） ----------

/** 课程列表（archived=false 未归档 / true 已归档；含成员数、条目数、可见条目数、memberIds） */
export function fetchTeacherCourses(
  archived: boolean,
): Promise<CourseListData> {
  return callApi(() =>
    api.api.teacher.courses.$get(
      archived ? { query: { archived: "true" } } : undefined,
    ),
  );
}

/** 课程详情（目录条目含资源摘要与状态标签数据 + 成员列表 + hasAttempts） */
export function fetchCourseDetail(id: string): Promise<CourseDetailData> {
  return callApi(() => api.api.teacher.courses[":id"].$get({ param: { id } }));
}

/** 学生可见预览（按 D5 过滤的成员可见目录；studentId 为成员 id） */
export function fetchCourseStudentView(
  courseId: string,
  studentId: string,
): Promise<CourseStudentViewData> {
  // hc 对带 param 的路由只推断出 param 入参，query/json 以独立变量传入（同 updateQuestion）
  const args = { param: { id: courseId }, query: { studentId } };
  return callApi(() =>
    api.api.teacher.courses[":id"]["student-view"].$get(args),
  );
}

/** 批量追加目录条目（重复跳过并返回清单，D6；withCompanionUnits 一并加配套练习，D8） */
export function addCourseItemsApi(
  courseId: string,
  request: CourseItemsAddRequest,
): Promise<CourseItemsAddData> {
  const args = { param: { id: courseId }, json: request };
  return callApi(() => api.api.teacher.courses[":id"].items.$post(args));
}

/** 目录排序（ids 为该课程全部条目的完整新顺序） */
export function reorderCourseItemsApi(
  courseId: string,
  request: CourseItemsReorderRequest,
): Promise<null> {
  const args = { param: { id: courseId }, json: request };
  return callApi(() => api.api.teacher.courses[":id"].items.order.$put(args));
}

/** 目录条目更新（可见开关 / 定时发布 / 分节改名；json 传参说明同 updateQuestion） */
export function updateCourseItemApi(
  id: string,
  request: CourseItemUpdateRequest,
): Promise<CourseDetailData["items"][number]> {
  const args = { param: { id }, json: request };
  return callApi(() => api.api.teacher["course-items"][":id"].$patch(args));
}

/** 从课程目录移除条目（不动资源库） */
export function deleteCourseItemApi(id: string): Promise<null> {
  return callApi(() =>
    api.api.teacher["course-items"][":id"].$delete({ param: { id } }),
  );
}

/** 添加成员（已在课幂等） */
export function addCourseMembersApi(
  courseId: string,
  request: CourseMembersRequest,
): Promise<null> {
  const args = { param: { id: courseId }, json: request };
  return callApi(() => api.api.teacher.courses[":id"].members.$post(args));
}

/** 移出成员（D7：立即看不到课程；已交卷记录保留，数据不删） */
export function removeCourseMembersApi(
  courseId: string,
  request: CourseMembersRequest,
): Promise<null> {
  const args = { param: { id: courseId }, json: request };
  return callApi(() => api.api.teacher.courses[":id"].members.$delete(args));
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

// ---------- T2.2：作业管理（教师端） ----------

/**
 * 作业列表（T2A.7：courseId 筛选——UUID 只看该课程作业、"none" 只看无课程作业、
 * 缺省全部；includeDeleted=true 含已删除作业）
 */
export function fetchAssignmentsApi(
  courseId: string | undefined,
  includeDeleted: boolean,
): Promise<TeacherAssignmentListData> {
  const query: Record<string, string> = {};
  if (courseId !== undefined) query.courseId = courseId;
  if (includeDeleted) query.includeDeleted = "true";
  return callApi(() =>
    api.api.teacher.assignments.$get(
      Object.keys(query).length > 0 ? { query } : undefined,
    ),
  );
}

/** 作业详情（T2A.7：roster 每人状态、startedCount、课程新成员） */
export function fetchAssignmentDetailApi(
  id: string,
): Promise<AssignmentDetailData> {
  return callApi(() =>
    api.api.teacher.assignments[":id"].$get({ param: { id } }),
  );
}

/** 布置前「已做过」检查（D15：名单学生在课程练习中对所选单元的已交卷次数） */
export function checkAssignmentApi(
  request: AssignmentCheckRequest,
): Promise<AssignmentCheckData> {
  return callApi(() =>
    api.api.teacher.assignments.check.$post({ json: request }),
  );
}

/**
 * 布置作业（T2A.7）{unitIds[], studentIds[], title?, courseId?, dueAt?,
 * unitGrouping?}。dueAt 必须是带 Z 后缀的 UTC ISO（datetime-local 值先经页面
 * 转 UTC，见 lib/time.ts）；单元重复 400 DUPLICATE_UNIT；单元/学生/课程不
 * 存在 404（由后端契约拦截）。unitGrouping 缺省 merged（合并一份）；separate
 * = 每个单元一份。响应 data = { assignments: [...] }（2026-10 列表形态）：
 * 本批创建的全部作业，merged 恰一份、separate 按 unitIds 顺序 N 份。
 */
export function createAssignmentApi(
  request: AssignmentCreateRequest,
): Promise<AssignmentCreateData> {
  return callApi(() => api.api.teacher.assignments.$post({ json: request }));
}

/**
 * 更新作业（T2A.7 增量语义：标题/截止/整组替换单元/名单增删）。
 * unitIds 在锁定后（有 attempt）409 ASSIGNMENT_CONTENT_LOCKED；移出已开始学生
 * 未带 confirmStarted 时 409 CONFIRM_REQUIRED（extra._students 为受影响学生名单，
 * 调用方确认后带 confirmStarted 重发）。
 * json 以独立变量传入的原因同 updateQuestion（parseJsonBody 服务端校验）。
 */
export function updateAssignmentApi(
  id: string,
  request: AssignmentUpdateRequest,
): Promise<TeacherAssignment> {
  const args = { param: { id }, json: request };
  return callApi(() => api.api.teacher.assignments[":id"].$patch(args));
}

/** 删除作业（软删：作答保留、学生端立即不可见；教师列表默认不再显示） */
export function deleteAssignmentApi(id: string): Promise<null> {
  return callApi(() =>
    api.api.teacher.assignments[":id"].$delete({ param: { id } }),
  );
}

// ---------- T2.3：学生端外壳 ----------

/** 专属链接登录（GET /api/public/s/:token：成功写 90 天学生会话 Cookie） */
export function loginStudentByLinkApi(token: string): Promise<StudentMeData> {
  return callApi(() => api.api.public.s[":token"].$get({ param: { token } }));
}

/** 当前登录学生（未登录 / 会话过期 / 被归档时 401 UNAUTHORIZED，由守卫跳登录） */
export function fetchStudentMe(): Promise<StudentMeData> {
  return callApi(() => api.api.student.me.$get());
}

/** 学生退出登录（删除会话行并清除 Cookie） */
export function logoutStudentApi(): Promise<null> {
  return callApi(() => api.api.student.logout.$post());
}

/** 我的作业（仅本人被指派且未删除，附完成状态；不含题目内容） */
export function fetchStudentAssignmentsApi(): Promise<StudentAssignmentListData> {
  return callApi(() => api.api.student.assignments.$get());
}

/** 讲义摘要列表（T2A.5 D5：去重并集 + 按课程分组双视图；不含题目内容） */
export function fetchStudentLecturesApi(): Promise<StudentLectureListData> {
  return callApi(() => api.api.student.lectures.$get());
}

/** 我的课程（T2A.5：所在课程卡片数据——名称/描述/可见计数；隐藏条目零信息） */
export function fetchStudentCoursesApi(): Promise<StudentCourseListData> {
  return callApi(() => api.api.student.courses.$get());
}

/** 课程可见目录（D5 过滤；非成员/课程归档 403 COURSE_ACCESS_DENIED） */
export function fetchStudentCourseApi(
  id: string,
): Promise<StudentCourseDetailData> {
  return callApi(() => api.api.student.courses[":id"].$get({ param: { id } }));
}

/**
 * 讲义全文 markdown（T2A.5：需经课程可见——?courseId= 课程上下文与本课配套练习；
 * 讲义全量下发是设计如此，:::solution 为讲解内容非题目答案）
 */
export function fetchStudentLectureApi(
  id: string,
  courseId?: string | undefined,
): Promise<StudentLectureDetail> {
  return callApi(() =>
    api.api.student.lectures[":id"].$get({
      param: { id },
      ...(courseId !== undefined ? { query: { courseId } } : {}),
    }),
  );
}

// ---------- T2.6：作答生命周期（学生端答题页） ----------

/**
 * 创建或取回进行中的 attempt（幂等：一个作业一人一份进行中）。
 * 已交卷时返回已交的那份（status=submitted/graded，前端直接进结果视图）。
 */
export function startAttemptApi(
  assignmentId: string,
): Promise<AttemptStartData> {
  return callApi(() =>
    api.api.student.assignments[":id"].attempt.$post({
      param: { id: assignmentId },
    }),
  );
}

// ---------- T2A.6：课程练习（可重做 + 历次记录） ----------

/** 单元落地信息（题数/题型分布/历次作答/首次/最近/最高分；D22 越权 403/404） */
export function fetchStudentUnitLandingApi(
  courseId: string,
  unitId: string,
): Promise<StudentUnitLandingData> {
  return callApi(() =>
    api.api.student.courses[":id"].units[":unitId"].$get({
      param: { id: courseId, unitId },
    }),
  );
}

/**
 * 课程练习入口（D10）：存在未交卷作答返回它（继续作答）；否则新建
 * attemptNo+1（再做一次，从空白开始）。每次调用服务端都校验 D5 可见性——
 * 移出成员 403 COURSE_ACCESS_DENIED / 条目不可见 404 NOT_FOUND。
 */
export function startCourseAttemptApi(
  courseId: string,
  unitId: string,
): Promise<AttemptStartData> {
  return callApi(() =>
    api.api.student.courses[":id"].units[":unitId"].attempts.$post({
      param: { id: courseId, unitId },
    }),
  );
}

// ---------- 2026-10：错题重练（/s/wrong 圈题组卷） ----------

/**
 * 错题重练组卷（POST /api/student/wrong-practice）：questionIds 由页面按当前
 * tab + 分组圈定（顺序即组卷题序）。服务端校验「∈ 错题本聚合且快照可用」，
 * 不在聚合内的题静默剔除；全部被剔 → 400 WRONG_PRACTICE_EMPTY（提示刷新）。
 * 返回新 wrong 来源 attempt 摘要（跳 /s/attempts/:id 走既有答题会话）。
 */
export function startWrongPracticeApi(
  questionIds: string[],
): Promise<AttemptStartData> {
  const args = { json: { questionIds } };
  return callApi(() => api.api.student["wrong-practice"].$post(args));
}

/**
 * 保存草稿答案（draft 阶段）。409 ALREADY_SUBMITTED = 已交卷；
 * 404 QUESTION_NOT_FOUND = 题目不属于这份作业或已被老师删除。
 * json 以独立变量传入的原因同 updateQuestion（parseJsonBody 服务端校验）。
 */
export function saveAttemptAnswerApi(
  attemptId: string,
  questionId: string,
  answer: AttemptAnswerSaveRequest["answer"],
): Promise<AttemptAnswerSaveData> {
  const args = { param: { id: attemptId, questionId }, json: { answer } };
  return callApi(() =>
    api.api.student.attempts[":id"].answers[":questionId"].$put(args),
  );
}

/**
 * 交卷：服务端判分、按建卷冻结快照判分，返回结果视图（含参考答案与详解）。
 * T6R.3：请求体回传每题 questionRevisionId（建卷时下发的题目版本引用），
 * 服务端与冻结集合精确比对——旧标签页/陈旧页面的提交抛 409
 * QUESTION_REVISION_STALE（提示刷新页面后重交）；重复交卷抛 409
 * ALREADY_SUBMITTED。
 * T6R.10：evidence 为每题笔记证据声明（none/frozen/missing + 预期 revision），
 * 服务端同一事务固定原稿（submission_evidence）；**缺省 = 旧客户端**——
 * 有草稿的卷会被 409 NOTE_EVIDENCE_MISMATCH 拒绝并要求刷新。
 */
export function submitAttemptApi(
  attemptId: string,
  revisions: AttemptSubmitRequest["revisions"],
  evidence?: AttemptSubmitRequest["evidence"],
): Promise<AttemptDetailData> {
  const args = {
    param: { id: attemptId },
    json: {
      revisions: [...revisions],
      // 条件展开适配 exactOptionalPropertyTypes：不传 ≠ 传 undefined
      ...(evidence !== undefined ? { evidence: [...evidence] } : {}),
    },
  };
  return callApi(() => api.api.student.attempts[":id"].submit.$post(args));
}

/**
 * attempt 详情：未交 = 草稿视图（公开题目 + 本人草稿 + 已解锁提示回显）；
 * 已交 = 结果视图（快照 + 参考答案 + 详解 + 判分 + 已解锁提示回看）。
 * 前端按 data.attempt.status 分支渲染。
 */
export function fetchAttemptApi(attemptId: string): Promise<AttemptDetailData> {
  return callApi(() =>
    api.api.student.attempts[":id"].$get({ param: { id: attemptId } }),
  );
}

/**
 * 解锁（查看）一道题的第 index 条提示（T2.11 分步提示）：
 * 服务端按需下发被请求的那一条并记录 hint_open 事件与已解锁集合
 * （draft 与已交均可用——交卷后回看自己请求过的提示）。
 * 400 HINT_INDEX_OUT_OF_RANGE = 序号越界（正常 UI 流程不会触发，属防御口径）。
 */
export function openAttemptHintApi(
  attemptId: string,
  questionId: string,
  index: number,
): Promise<HintOpenData> {
  const args = { param: { id: attemptId }, json: { questionId, index } };
  return callApi(() => api.api.student.attempts[":id"].hints.$post(args));
}

// ---------- T2.10：学习痕迹事件（学生端） ----------

/**
 * 批量上报 attempt 上下文的学习痕迹事件（≤200 条/次，契约拦截）。
 * 事件队列（lib/event-queue.ts）的正常发送路径；sendBeacon 兜底路径
 * 在队列内部用原生 fetch/Beacon 直发（见 putAttemptInkApi 的同类说明）。
 * json 以独立变量传入的原因同 updateQuestion（parseJsonBody 服务端校验）。
 */
export function postAttemptEventsApi(
  attemptId: string,
  events: readonly AttemptEvent[],
): Promise<LearningEventBatchData> {
  const args = { param: { id: attemptId }, json: { events: [...events] } };
  return callApi(() => api.api.student.attempts[":id"].events.$post(args));
}

/**
 * 批量上报无 attempt 上下文的事件（讲义 lecture_expand）。
 * 与 postAttemptEventsApi 同壳；讲义阅读页的事件队列使用。
 */
export function postLectureEventsApi(
  events: readonly LectureEvent[],
): Promise<LearningEventBatchData> {
  return callApi(() =>
    api.api.student.events.$post({ json: { events: [...events] } }),
  );
}

// ---------- T2.8：手写笔迹（学生端） ----------

/**
 * 取回一道手写题的矢量文档（刷新后继续书写 / 已交卷回看自己的笔迹）。
 * 该题尚无笔迹时服务端 404 → 返回 null（前端据此跳过 load，从空白开始）。
 */
export async function fetchAttemptInkApi(
  attemptId: string,
  questionId: string,
): Promise<InkDoc | null> {
  try {
    return await callApi<InkDoc>(() =>
      api.api.student.attempts[":id"].ink[":questionId"].$get({
        param: { id: attemptId, questionId },
      }),
    );
  } catch (err) {
    if (err instanceof ApiError && err.code === "INK_NOT_FOUND") return null;
    throw err;
  }
}

/**
 * 上传/覆盖一道手写题的笔迹（multipart：strokes（gzip 后 InkDoc JSON）+
 * snapshot（白底 PNG），服务端校验合计 ≤2MB，超限抛 413 INK_TOO_LARGE）。
 * 同题再传幂等覆盖（inkId 不变）。
 *
 * 说明：服务端 handler 用 c.req.parseBody() 解析 multipart，hc RPC 对这类路由
 * 推断不出 form 入参类型——这里用同构 fetch（同源相对路径、自动带会话 Cookie）
 * 替代 hc，响应仍走 callApi 的统一壳校验（apiResponseSchema），不手抄类型。
 */
export function putAttemptInkApi(
  attemptId: string,
  questionId: string,
  strokesGzip: Blob,
  snapshotPng: Blob,
): Promise<InkUploadData> {
  const form = new FormData();
  form.append("strokes", strokesGzip, "strokes.json.gz");
  form.append("snapshot", snapshotPng, "snapshot.png");
  return callApi(() =>
    fetch(
      `/api/student/attempts/${encodeURIComponent(attemptId)}/ink/${encodeURIComponent(questionId)}`,
      { method: "PUT", body: form },
    ),
  );
}

/**
 * 本人笔迹 PNG 的 URL（结果页/题卡 <img src> 直出；同源请求自动带会话 Cookie，
 * 404 时由 <img> 的 onerror 兜底隐藏）。「文件直出而非 base64 进库」口径下的
 * 学生端取回途径（见任务报告）。
 */
export function studentInkPngUrl(
  attemptId: string,
  questionId: string,
): string {
  return `/api/student/attempts/${encodeURIComponent(attemptId)}/ink/${encodeURIComponent(questionId)}.png`;
}

// ---------- T3.3：笔迹回放矢量数据（教师端，D12） ----------

/** fetchGzipJson 的分路文案（调用方各自措辞，共用流程见 helper 注释） */
interface GzipJsonMessages {
  network: string;
  unsupported: string;
  decompress: string;
  corrupt: string;
}

/**
 * 私有共用（T6R.5 复审⑤收敛）：fetch gzip 直出接口 → DecompressionStream
 * 解压 → JSON.parse。坑位集中一处：
 * - 不用 Blob 流——jsdom 的 Blob 流与 Node 全局流互操作不可靠；
 *   Response/DecompressionStream 在浏览器与测试环境同为原生；
 * - 直接 pipe 响应体流（不经 arrayBuffer 整包绕路）——fetch 返回的 Response
 *   流可 pipeThrough，全真链路由 api-teacher-ink.test 验证；
 * - 返回类型刻意为 unknown 且本层不做 Zod 校验：文件直出接口（gzip 原字节，
 *   不走 { ok, data } 统一壳），文档形态由消费方（<InkReplay> 按 engine
 *   分派 / T6R.6 渲染器按 noteDocSchema）收窄校验。
 */
async function fetchGzipJson(
  path: string,
  msg: GzipJsonMessages,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path);
  } catch {
    throw new Error(msg.network);
  }
  if (!res.ok) {
    await throwShellError(res);
  }
  if (typeof DecompressionStream === "undefined") {
    // 上传侧（gzipOrRaw）有原始 JSON 回退；解压消费只在支持的环境提供
    throw new Error(msg.unsupported);
  }
  // 无字节流按传输层异常归因（浏览器保证 2xx 响应有 body——复审轮⑤）
  if (res.body === null) {
    throw new Error(msg.network);
  }
  let text: string;
  try {
    text = await new Response(
      res.body.pipeThrough(new DecompressionStream("gzip")),
    ).text();
  } catch (err) {
    // 读流阶段失败的归因启发式（复审轮⑤）：gzip 坏块与网络中断在这里同为
    // 异常、无可靠类型区分——按错误文案归类：已知网络类字样 → 网络错误
    // 文案；其余（含各实现的解压错误）→ 解压失败文案。
    const detail = err instanceof Error ? err.message : String(err);
    if (/terminated|aborted|network|fetch failed/i.test(detail)) {
      throw new Error(msg.network);
    }
    throw new Error(msg.decompress);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(msg.corrupt);
  }
}

/**
 * 教师按 inkId 取笔迹矢量文档（回放用）：fetch `/api/teacher/ink/{inkId}.json.gz`
 * （同源相对路径自动带会话 Cookie，与 putAttemptInkApi 的原生 fetch 同口径）。
 * 失败：网络错误抛中文 Error；非 200 抛 ApiError——404 INK_NOT_FOUND 即
 * 行不存在/域不匹配/文件缺失，调用方据此降级为 PNG 快照 + 「无回放数据」提示。
 */
export function fetchTeacherInkStrokesApi(inkId: string): Promise<unknown> {
  return fetchGzipJson(
    `/api/teacher/ink/${encodeURIComponent(inkId)}.json.gz`,
    {
      network:
        "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
      unsupported: "当前浏览器不支持笔迹回放（缺少 DecompressionStream）",
      decompress: "笔迹矢量数据解压失败（文件可能损坏），请刷新重试",
      corrupt: "笔迹矢量数据损坏（不是合法的 JSON），请反馈老师处理",
    },
  );
}

// ---------- T6R.5：题目草稿读接口（学生端 + 教师端 evidence） ----------

/**
 * 本次工作稿头（T6R.5 ①）：noteRecordMeta + 生效版本派生图 + 证据行。
 * 无笔记时服务端返回显式空态（note=null / images=[] / evidence=null），
 * 客户端以 baseRevision=0 起步——不是 404，无需判空捕获。
 */
export function fetchStudentNoteHeadApi(
  attemptId: string,
  questionId: string,
  /** 逐题超时等中止信号（T6R.10 交卷组装 30s——对齐 PUT 口径）；
   *  有 signal 时走原语 fetch（hc RPC 路由推断不出 signal，同 putNoteDocumentApi） */
  signal?: AbortSignal,
): Promise<NoteHeadData> {
  if (signal === undefined) {
    return callApi(() =>
      api.api.student.attempts[":id"].notes[":questionId"].$get({
        param: { id: attemptId, questionId },
      }),
    );
  }
  return callApi(() =>
    fetch(
      `/api/student/attempts/${encodeURIComponent(attemptId)}/notes/${encodeURIComponent(questionId)}`,
      { signal },
    ),
  );
}

/**
 * 本次只读证据与图片状态（T6R.5 ②）：本人历史权限（已交卷可读、软删题
 * 历史证据可读）。结果页原稿查看（T6R.11）与草稿期图片状态轮询共用。
 */
export function fetchStudentNoteEvidenceApi(
  attemptId: string,
  questionId: string,
): Promise<NoteHeadData> {
  return callApi(() =>
    api.api.student.attempts[":id"].evidence[":questionId"].$get({
      param: { id: attemptId, questionId },
    }),
  );
}

/** 教师域内只读证据（T6R.5 ⑥；域外 404，批改/详情页原稿查看用） */
export function fetchTeacherNoteEvidenceApi(
  attemptId: string,
  questionId: string,
): Promise<NoteHeadData> {
  return callApi(() =>
    api.api.teacher.attempts[":id"].evidence[":questionId"].$get({
      param: { id: attemptId, questionId },
    }),
  );
}

/**
 * 学生读自己的版本文档（T6R.5 ③）：fetch 直出接口（gzip 原字节 +
 * attachment，不走 { ok, data } 统一壳），解压与解析共用 fetchGzipJson
 * （坑位注释见彼处）。返回类型刻意为 unknown：文档形态由 T6R.6 渲染器
 * 消费时按 noteDocSchema 收窄。失败：404 NOTE_NOT_FOUND（不存在/非本人/
 * 文件缺失）抛 ApiError。
 */

/** 笔记版本文档的分路文案（学生/教师两薄导出共用一份——复审轮⑬） */
const NOTE_DOC_MESSAGES: GzipJsonMessages = {
  network: "连不上服务器，请确认网络后重试",
  unsupported: "当前浏览器不支持读取草稿正文（缺少 DecompressionStream）",
  decompress: "草稿正文解压失败（文件可能损坏），请刷新重试",
  corrupt: "草稿正文损坏（不是合法的 JSON），请反馈老师处理",
};

export function fetchStudentNoteDocumentApi(
  versionId: string,
): Promise<unknown> {
  return fetchGzipJson(
    `/api/student/note-versions/${encodeURIComponent(versionId)}/document`,
    NOTE_DOC_MESSAGES,
  );
}

/** 教师域内读学生版本文档（T6R.5 ⑦；域外 404），口径同学生端版本文档 */
export function fetchTeacherNoteDocumentApi(
  versionId: string,
): Promise<unknown> {
  return fetchGzipJson(
    `/api/teacher/note-versions/${encodeURIComponent(versionId)}/document`,
    NOTE_DOC_MESSAGES,
  );
}

/**
 * 学生端派生图 PNG 的 URL（T6R.5 ④；<img src> 直出，同源请求自动带会话
 * Cookie，404 由 <img> 的 onerror 兜底）。带 .png 后缀（与 ink PNG 的
 * URL 形态惯例一致；服务端两种形态同一资源）。
 */
export function studentNoteImagePngUrl(
  versionId: string,
  imageId: string,
): string {
  return `/api/student/note-versions/${encodeURIComponent(versionId)}/images/${encodeURIComponent(imageId)}.png`;
}

/** 教师端派生图 PNG 的 URL（T6R.5 ⑦），形态同学生端 */
export function teacherNoteImagePngUrl(
  versionId: string,
  imageId: string,
): string {
  return `/api/teacher/note-versions/${encodeURIComponent(versionId)}/images/${encodeURIComponent(imageId)}.png`;
}

/**
 * 补图上传（T6R.6；POST /api/{student|teacher}/note-versions/:id/images）：
 * 渲染产物 PNG + 上传元信息 → 服务端槽位幂等 upsert，返回 NoteImageMeta 回执。
 * multipart 字段集与服务端 lib/form-fields.parseNoteImageUploadForm 一一对应
 * （image 文件 + spec/pageIndex/cropX/cropY/cropW/cropH/pixelWidth/pixelHeight
 * 八个字符串字段——strictFormInt 只认严格十进制串，客户端统一 String() 发送）。
 * hc RPC 对 multipart 路由推断不出 form 入参——与 postTeacherMediaApi 同口径
 * 用原生 fetch（同源相对路径自动带会话 Cookie）。失败抛 ApiError（如 413
 * NOTE_LIMIT_EXCEEDED）或网络层中文 Error，由调用方（图片同步队列/补图恢复）
 * 决定重试策略。
 */
/** 补图角色：学生补自己的图 / 教师按授权补学生版本。note 域读端点的角色
 * 分派（fetchNoteEvidenceApi/fetchNoteDocumentApi）与本类型同一份联合
 * （T6R.11 复审：组件 viewer prop 也取此导出，不在别处再手写同一联合） */
export type NoteRole = "student" | "teacher";

export function postNoteImageApi(
  role: NoteRole,
  versionId: string,
  png: Blob,
  meta: NoteImageUploadMeta,
): Promise<NoteImageMeta> {
  const form = new FormData();
  const F = NOTE_IMAGE_FORM_FIELDS;
  form.append(
    F.image,
    png,
    `note-${versionId}-${meta.spec}-p${meta.pageIndex}.png`,
  );
  form.append(F.spec, meta.spec);
  form.append(F.pageIndex, String(meta.pageIndex));
  form.append(F.cropX, String(meta.crop.x));
  form.append(F.cropY, String(meta.crop.y));
  form.append(F.cropW, String(meta.crop.width));
  form.append(F.cropH, String(meta.crop.height));
  form.append(F.pixelWidth, String(meta.pixelWidth));
  form.append(F.pixelHeight, String(meta.pixelHeight));
  return callApi(() =>
    fetch(
      `/api/${role}/note-versions/${encodeURIComponent(versionId)}/images`,
      {
        method: "POST",
        body: form,
      },
    ),
  );
}

// ---------- T6R.8：草稿正文上传（PUT notes，note-sync 队列消费） ----------

/**
 * 草稿正文上传（T6R.8；PUT /api/student/attempts/:id/notes/:qid，服务端
 * T6R.4 落地）：multipart = body 文件（gzip 后或原始 JSON 的 NoteDoc）+
 * baseRevision/mutationId 十进制串字段（与服务端 parseBody + strictFormInt
 * 口径对应；契约 noteUploadMetaSchema）。返回 noteVersionReceipt（CAS 成功
 * 或幂等命中）。
 *
 * 失败形态（note-sync 据此分流）：
 * - 409 NOTE_REVISION_CONFLICT：extra._current 携带当前版本摘要
 *   （noteRevisionConflictCurrentSchema）——保留本地、进 conflict 态；
 * - 403/404 / 409 ALREADY_SUBMITTED：访问权终态（denied，停自动重试）；
 * - 400 NOTE_VALIDATION_FAILED / 413 NOTE_LIMIT_EXCEEDED：内容被拒
 *   （保留本地，pending 终态、新内容重新可传）；
 * - 网络错误抛中文 Error。
 * hc RPC 对 multipart 路由推断不出 form 入参——原生 fetch 同口径
 * （postNoteImageApi）；signal 供 note-sync 账号切换中止旧会话在途请求。
 */
export function putNoteDocumentApi(
  attemptId: string,
  questionId: string,
  body: Blob,
  meta: NoteUploadMeta,
  signal?: AbortSignal,
): Promise<NoteVersionReceipt> {
  const form = new FormData();
  form.append("body", body, "body.json.gz");
  form.append("baseRevision", String(meta.baseRevision));
  form.append("mutationId", meta.mutationId);
  return callApi(() =>
    fetch(
      `/api/student/attempts/${encodeURIComponent(attemptId)}/notes/${encodeURIComponent(questionId)}`,
      {
        method: "PUT",
        body: form,
        // RequestInit.signal 类型为 AbortSignal | null（非 undefined——
        // exactOptionalPropertyTypes 口径；复审⑭去冗余展开）
        signal: signal ?? null,
      },
    ),
  );
}

// ---------- 图片上传（POST /api/teacher/media：导入页随行图片流程在用） ----------

/**
 * 上传一张图片（multipart 字段 file；PNG/JPG/WEBP/GIF，≤5MB），返回
 * { src, bytes }——src 即 ::image 指令的 src（blobs/media/<hash>.<ext>，
 * 渲染层归一化为根相对路径后请求）。
 * 说明：服务端 handler 用 c.req.parseBody() 解析 multipart，hc RPC 对这类
 * 路由推断不出 form 入参类型——与 putAttemptInkApi 同口径改用同构 fetch
 * （同源相对路径自动带会话 Cookie），响应仍走 callApi 的统一壳校验。
 * 失败抛 ApiError（message 为服务端中文文案：413 MEDIA_TOO_LARGE /
 * 415 UNSUPPORTED_MEDIA_TYPE）或网络层中文 Error，由调用方原样透出。
 */
export function postTeacherMediaApi(file: File): Promise<MediaUploadResult> {
  const form = new FormData();
  form.append("file", file);
  return callApi(() =>
    fetch("/api/teacher/media", { method: "POST", body: form }),
  );
}

// ---------- T2A.2：资源库（讲义库 / 题库 / 回收站 + 单元管理） ----------

/** 课程进度矩阵（T2A.6：成员 × 可见单元；每格课程练习统计 + 历次列表） */
export function fetchCourseProgressApi(
  courseId: string,
): Promise<CourseProgressData> {
  return callApi(() =>
    api.api.teacher.courses[":id"].progress.$get({ param: { id: courseId } }),
  );
}

export type {
  LectureMetaUpdate,
  LibraryBatchRequest,
  LibraryFolderCreate,
  LibraryFolderReorder,
  LibraryFolderUpdate,
  SharedImportRequest,
  SharedPreviewRequest,
  UnitMetaUpdate,
} from "@tutor/contract";

/** 列表查询参数（folderId：null = 未归类；deleted = 回收站） */
export interface LibraryListParams {
  folderId?: string | null | undefined;
  q?: string | undefined;
  deleted?: boolean | undefined;
}

/** 列表查询参数 → querystring（undefined 字段不发送） */
function libraryListQuery(params: LibraryListParams): Record<string, string> {
  const query: Record<string, string> = {};
  if (params.folderId !== undefined) {
    query.folderId = params.folderId === null ? "none" : params.folderId;
  }
  if (params.q !== undefined && params.q.trim().length > 0) {
    query.q = params.q.trim();
  }
  if (params.deleted) {
    query.deleted = "1";
  }
  return query;
}

/** 文件夹列表（order 升序，含未删除资源计数；「未归类」由前端固定渲染） */
export function fetchLibraryFolders(): Promise<{
  folders: LibraryFolder[];
}> {
  return callApi(() => api.api.teacher.library.folders.$get());
}

/** 新建文件夹（同名已存在 409 FOLDER_NAME_EXISTS） */
export function createLibraryFolderApi(
  request: LibraryFolderCreate,
): Promise<LibraryFolder> {
  return callApi(() =>
    api.api.teacher.library.folders.$post({ json: request }),
  );
}

/** 文件夹改名（json 以独立变量传入的原因同 updateQuestion） */
export function renameLibraryFolderApi(
  id: string,
  request: LibraryFolderUpdate,
): Promise<LibraryFolder> {
  const args = { param: { id }, json: request };
  return callApi(() => api.api.teacher.library.folders[":id"].$patch(args));
}

/** 删除文件夹：内容移入未归类，响应返回移动数量 {movedLectures, movedUnits} */
export function deleteLibraryFolderApi(
  id: string,
): Promise<{ movedLectures: number; movedUnits: number }> {
  return callApi(() =>
    api.api.teacher.library.folders[":id"].$delete({ param: { id } }),
  );
}

/** 文件夹拖拽排序（ids 为全部文件夹完整新顺序） */
export function reorderLibraryFoldersApi(
  request: LibraryFolderReorder,
): Promise<null> {
  return callApi(() =>
    api.api.teacher.library.folders.reorder.$post({ json: request }),
  );
}

/** 讲义库列表（folderId/q/deleted 筛选） */
export function fetchLibraryLectures(
  params: LibraryListParams = {},
): Promise<LibraryLectureList> {
  return callApi(() =>
    api.api.teacher.library.lectures.$get({ query: libraryListQuery(params) }),
  );
}

/** 题库列表（单元含题数、题型分布、考点、引用数、使用作业数、题目摘要） */
export function fetchLibraryUnits(
  params: LibraryListParams = {},
): Promise<LibraryUnitList> {
  return callApi(() =>
    api.api.teacher.library.units.$get({ query: libraryListQuery(params) }),
  );
}

/** 单元元数据编辑（标题/主题/文件夹/配套讲义；显式 null = 清空） */
export function updateUnitMetaApi(
  id: string,
  request: UnitMetaUpdate,
): Promise<UnitMetaData> {
  const args = { param: { id }, json: request };
  return callApi(() => api.api.teacher.units[":id"].$patch(args));
}

/** 单元软删（进回收站，可恢复） */
export function deleteUnitApi(id: string): Promise<null> {
  return callApi(() => api.api.teacher.units[":id"].$delete({ param: { id } }));
}

/** 单元从回收站恢复 */
export function restoreUnitApi(id: string): Promise<null> {
  return callApi(() =>
    api.api.teacher.units[":id"].restore.$post({ param: { id } }),
  );
}

/** 单元彻底删除（有作答记录或作业引用时 409 RESOURCE_IN_USE） */
export function purgeUnitApi(id: string): Promise<null> {
  return callApi(() =>
    api.api.teacher.units[":id"].purge.$delete({ param: { id } }),
  );
}

/** 讲义移动文件夹（内容编辑走现有 updateLecture） */
export function updateLectureFolderApi(
  id: string,
  request: LectureMetaUpdate,
): Promise<LectureMetaData> {
  const args = { param: { id }, json: request };
  return callApi(() => api.api.teacher.lectures[":id"].$patch(args));
}

/** 讲义从回收站恢复 */
export function restoreLectureApi(id: string): Promise<null> {
  return callApi(() =>
    api.api.teacher.lectures[":id"].restore.$post({ param: { id } }),
  );
}

/** 讲义彻底删除（配套单元有作答记录时 409 RESOURCE_IN_USE） */
export function purgeLectureApi(id: string): Promise<null> {
  return callApi(() =>
    api.api.teacher.lectures[":id"].purge.$delete({ param: { id } }),
  );
}

/** 单元使用情况（删除确认弹层 / purge 条件判断数据源） */
export function fetchUnitUsageApi(id: string): Promise<LibraryUsage> {
  return callApi(() =>
    api.api.teacher.units[":id"].usage.$get({ param: { id } }),
  );
}

/** 讲义使用情况（assignments 恒空，作答数经配套单元保守合计） */
export function fetchLectureUsageApi(id: string): Promise<LibraryUsage> {
  return callApi(() =>
    api.api.teacher.lectures[":id"].usage.$get({ param: { id } }),
  );
}

/** 批量操作（move/delete/restore/addToCourse；部分失败逐条返回） */
export function batchLibraryApi(
  request: LibraryBatchRequest,
): Promise<LibraryBatchData> {
  return callApi(() => api.api.teacher.library.batch.$post({ json: request }));
}

/**
 * 下载导出的 Markdown（GET …/export.md 为文件直出，非 JSON 统一壳）：
 * 同构 fetch（同源自动带会话 Cookie）拿 blob 触发浏览器下载；
 * 失败时按统一错误壳解析成 ApiError（如 404 UNIT_NOT_FOUND）。
 */
export async function downloadExportMd(
  kind: "unit" | "lecture",
  id: string,
): Promise<void> {
  const path =
    kind === "unit"
      ? `/api/teacher/units/${encodeURIComponent(id)}/export.md`
      : `/api/teacher/lectures/${encodeURIComponent(id)}/export.md`;
  let res: Response;
  try {
    res = await fetch(path);
  } catch {
    throw new Error(
      "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
    );
  }
  if (!res.ok) {
    // 文件接口的错误仍是统一 JSON 壳
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const parsed = apiResponseSchema.safeParse(body);
    if (parsed.success && !parsed.data.ok) {
      throw new ApiError(
        parsed.data.error,
        parsed.data.message,
        res.status,
        pickExtraFields(body),
      );
    }
    throw new Error(`导出失败（HTTP ${res.status}），请稍后重试`);
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  // 优先 filename*=UTF-8''（中文标题），回退整个头文本
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const filename = star !== undefined ? decodeURIComponent(star) : `${id}.md`;
  saveBlobAs(await res.blob(), filename);
}

// ---------- T2B.6：管理端（/api/admin/*，requireAdmin；D19 管理员无业务数据权限） ----------

/** 教师列表（loginName/isAdmin/disabledAt/createdAt/学生数；status=all|active|disabled 筛选） */
export function fetchAdminTeachers(
  status: "all" | "active" | "disabled",
): Promise<AdminTeacherListData> {
  // status=all 时也显式传参（契约默认同值，保持请求形状稳定便于缓存键区分）
  return callApi(() => api.api.admin.teachers.$get({ query: { status } }));
}

/**
 * 管理员创建教师（不受注册开关影响）。响应 initialPassword 为服务端生成的
 * 一次性初始密码明文（管理员自备密码时为 null）——只在此响应出现一次。
 */
export function createAdminTeacherApi(
  request: AdminTeacherCreateRequest,
): Promise<AdminTeacherCreateData> {
  return callApi(() => api.api.admin.teachers.$post({ json: request }));
}

/** 改登录名 / 授予撤销 isAdmin（409 TEACHER_LOGIN_EXISTS / LAST_ADMIN 由页面分支提示） */
export function updateAdminTeacherApi(
  id: string,
  request: AdminTeacherUpdateRequest,
): Promise<AdminTeacherSummary> {
  const args = { param: { id }, json: request };
  return callApi(() => api.api.admin.teachers[":id"].$patch(args));
}

/** 禁用教师（D5：会话立即失效、数据全保留、可再启用；409 LAST_ADMIN 不能禁自己/最后一位活跃管理员） */
export function disableAdminTeacherApi(
  id: string,
): Promise<AdminTeacherSummary> {
  return callApi(() =>
    api.api.admin.teachers[":id"].disable.$post({ param: { id } }),
  );
}

/** 启用教师（完全恢复原状） */
export function enableAdminTeacherApi(
  id: string,
): Promise<AdminTeacherSummary> {
  return callApi(() =>
    api.api.admin.teachers[":id"].enable.$post({ param: { id } }),
  );
}

/**
 * 重置教师密码。响应 password 为一次性新密码明文（自备密码时即所提供值）
 * ——需线下告知对方（§4.1）。
 */
export function resetAdminTeacherPasswordApi(
  id: string,
  request: AdminTeacherResetPasswordRequest,
): Promise<AdminTeacherResetPasswordData> {
  const args = { param: { id }, json: request };
  return callApi(() =>
    api.api.admin.teachers[":id"]["reset-password"].$post(args),
  );
}

/** 注册开关当前状态（D8） */
export function fetchAdminSettings(): Promise<AdminSettingsData> {
  return callApi(() => api.api.admin.settings.$get());
}

/** 切换注册开关（登录页注册入口与 /t/register 关闭提示随 status 联动） */
export function updateAdminSettingsApi(
  request: AdminSettingsUpdateRequest,
): Promise<AdminSettingsData> {
  return callApi(() => api.api.admin.settings.$patch({ json: request }));
}

/** 概览聚合计数（D20：教师/学生/作答/共享文件/注册开关，无任何明细） */
export function fetchAdminOverview(): Promise<AdminOverviewData> {
  return callApi(() => api.api.admin.overview.$get());
}

// ---------- T2B.7：共享发布与导入（D15–D18；DATA_DIR/shared 目录） ----------
/** 共享列表（D15：≤1MB 的 .md 按时间倒序最多 200 个；truncated/oversizeHidden 防线提示） */
export function fetchSharedFiles(): Promise<SharedFileList> {
  return callApi(() => api.api.teacher.shared.$get());
}

/** 发布单元到共享（D16 复制快照；响应 filename = 实际写入文件名，含序号） */
export function publishUnitToSharedApi(id: string): Promise<SharedPublishData> {
  return callApi(() =>
    api.api.teacher.library.units[":id"].publish.$post({ param: { id } }),
  );
}

/** 发布讲义到共享（D16：文件含 kind: lecture frontmatter） */
export function publishLectureToSharedApi(
  id: string,
): Promise<SharedPublishData> {
  return callApi(() =>
    api.api.teacher.library.lectures[":id"].publish.$post({ param: { id } }),
  );
}

/**
 * 共享文件预览（D17：服务端读文件复用单文件预览逻辑，动作清单按本人域计算）。
 * 响应在导入预览字段之外携带 markdown 原文（「查看预览」渲染用）。
 * 有 error 级 lint 时响应仍 200（与普通 preview 一致，error 在 data.issues 里）。
 */
export function previewSharedFile(
  request: SharedPreviewRequest,
): Promise<SharedPreviewData> {
  return callApi(() => api.api.teacher.shared.preview.$post({ json: request }));
}

/**
 * 导入共享文件进本人资源库（D17）。文件有 error 级 lint 时 422 LINT_ERROR
 * （extra._issues 由抽屉展示）。删除后文件不存在 → 404 SHARED_FILE_NOT_FOUND。
 */
export function importSharedFile(
  request: SharedImportRequest,
): Promise<ImportCommitData> {
  return callApi(() => api.api.teacher.shared.import.$post({ json: request }));
}

/** 删除共享文件（D18：发布者删自己的；他人/本地文件 403 FORBIDDEN_SHARED_FILE） */
export function deleteSharedFileApi(filename: string): Promise<null> {
  return callApi(() =>
    api.api.teacher.shared[":filename"].$delete({
      param: { filename },
    }),
  );
}

/** 管理端共享列表（与教师端同形状；canDelete 恒 true——管理员可删任意） */
export function fetchAdminSharedFiles(): Promise<SharedFileList> {
  return callApi(() => api.api.admin["shared-files"].$get());
}

/** 管理端删除共享文件（可删任意，含本地放入的；连带删伴生 meta.json） */
export function deleteAdminSharedFileApi(filename: string): Promise<null> {
  return callApi(() =>
    api.api.admin["shared-files"][":filename"].$delete({
      param: { filename },
    }),
  );
}

// ---------- T3.1：教师端作答数据页（/t/data，D5–D7） ----------

/**
 * 作答列表查询参数（界面层形态）。undefined / null 字段不发送（= 后端不过滤）；
 * limit / offset 恒发送（分页）。from / to 为带 Z 后缀的 UTC ISO（页面把
 * datetime-local 本地值经 lib/time.localInputToUtcIso 转换后传入）。
 */
export interface TeacherAttemptListParams {
  studentId?: string | undefined;
  courseId?: string | undefined;
  assignmentId?: string | undefined;
  unitId?: string | undefined;
  sourceType?: AttemptSource | undefined;
  status?: AttemptStatus | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  offset: number;
}

/** 教师作答卡片列表（D6 筛选与分页；按最近活动时间倒序） */
export function fetchTeacherAttemptsApi(
  params: TeacherAttemptListParams,
): Promise<TeacherAttemptListData> {
  const query: Record<string, string> = {};
  if (params.studentId !== undefined) query.studentId = params.studentId;
  if (params.courseId !== undefined) query.courseId = params.courseId;
  if (params.assignmentId !== undefined) {
    query.assignmentId = params.assignmentId;
  }
  if (params.unitId !== undefined) query.unitId = params.unitId;
  if (params.sourceType !== undefined) query.sourceType = params.sourceType;
  if (params.status !== undefined) query.status = params.status;
  if (params.from !== undefined) query.from = params.from;
  if (params.to !== undefined) query.to = params.to;
  query.limit = String(params.limit);
  query.offset = String(params.offset);
  return callApi(() => api.api.teacher.attempts.$get({ query }));
}

/** 教师作答详情（D7 全字段；draft 亦可用，判定列语义见 D5） */
export function fetchTeacherAttemptDetailApi(
  attemptId: string,
): Promise<TeacherAttemptDetailData> {
  return callApi(() =>
    api.api.teacher.attempts[":id"].$get({ param: { id: attemptId } }),
  );
}

// ---------- T3.2b：批注与待批队列（D3/D4） ----------

/**
 * 待批队列查询参数（界面层形态；undefined 字段不发送 = 后端不过滤）。
 * 排序由服务端恒定 submittedAt 升序（先交先批），无分页（D4）。
 */
export interface PendingMarkListParams {
  courseId?: string | undefined;
  assignmentId?: string | undefined;
  studentId?: string | undefined;
}

/** 待批队列（D4：finalCorrect IS NULL 的已交卷 responses；课程/作业/学生筛选） */
export function fetchPendingMarksApi(
  params: PendingMarkListParams,
): Promise<PendingMarkListData> {
  const query: Record<string, string> = {};
  if (params.courseId !== undefined) query.courseId = params.courseId;
  if (params.assignmentId !== undefined) {
    query.assignmentId = params.assignmentId;
  }
  if (params.studentId !== undefined) query.studentId = params.studentId;
  return callApi(() =>
    api.api.teacher["pending-marks"].$get(
      Object.keys(query).length > 0 ? { query } : undefined,
    ),
  );
}

/**
 * 批注单题（D3：判定与评语两字段一次提交，值可为 null——mark=null 清除教师判定，
 * comment 由服务端 trim 归一化，空串按 null）。draft attempt → 409 NOT_SUBMITTED；
 * 非本人教师 → 404 RESPONSE_NOT_FOUND。json 以独立变量传入的原因同 updateQuestion。
 */
export function markResponseApi(
  responseId: string,
  request: MarkRequest,
): Promise<MarkResponseData> {
  const args = { param: { id: responseId }, json: request };
  return callApi(() => api.api.teacher.responses[":id"].mark.$post(args));
}

// ---------- T3.4：CSV 导出（D13） ----------

/**
 * CSV 导出查询参数（界面层形态）。undefined 字段不发送（= 后端不过滤）；
 * from / to 为带 Z 后缀的 UTC ISO（页面把 datetime-local 本地值经
 * lib/time.localInputToUtcIso 转换后传入）。
 */
export interface TeacherExportCsvParams {
  studentId?: string | undefined;
  courseId?: string | undefined;
  assignmentId?: string | undefined;
  sourceType?: AttemptSource | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * 下载教师端 CSV 导出（GET /api/teacher/export/csv，文件直出非统一壳）：
 * 同构 fetch（同源自动带会话 Cookie，与 downloadExportMd 同口径）拿 blob 触发
 * 浏览器下载；文件名优先取响应 Content-Disposition（服务端按请求时刻北京时间
 * 生成 tutor-export-YYYYMMDD-HHmmss.csv），取不到时回退固定名。
 * 失败时按统一错误壳解析成 ApiError（如 VALIDATION_ERROR），调用方 alert 提示。
 */
export async function downloadTeacherExportCsv(
  params: TeacherExportCsvParams,
): Promise<void> {
  const query = new URLSearchParams();
  if (params.studentId !== undefined) query.set("studentId", params.studentId);
  if (params.courseId !== undefined) query.set("courseId", params.courseId);
  if (params.assignmentId !== undefined) {
    query.set("assignmentId", params.assignmentId);
  }
  if (params.sourceType !== undefined) {
    query.set("sourceType", params.sourceType);
  }
  if (params.from !== undefined) query.set("from", params.from);
  if (params.to !== undefined) query.set("to", params.to);
  const qs = query.toString();
  let res: Response;
  try {
    res = await fetch(`/api/teacher/export/csv${qs ? `?${qs}` : ""}`);
  } catch {
    throw new Error(
      "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
    );
  }
  if (!res.ok) {
    // 文件接口的错误仍是统一 JSON 壳
    await throwShellError(res);
  }
  const filename = filenameFromDisposition(res, "tutor-export.csv");
  saveBlobAs(await res.blob(), filename);
}

// ---------- T3.5：学生端「我的记录」与错题本（D9–D11） ----------

/**
 * 我的记录查询参数（界面层形态，D10）。undefined 字段不发送（= 后端不过滤）；
 * limit / offset 恒发送（分页）。from / to 为带 Z 后缀的 UTC ISO（页面把
 * datetime-local 本地值经 lib/time.localInputToUtcIso 转换后传入）。
 */
export interface StudentRecordsParams {
  sourceType?: AttemptSource | undefined;
  courseId?: string | undefined;
  assignmentId?: string | undefined;
  status?: AttemptStatus | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit: number;
  offset: number;
}

/**
 * 我的记录（GET /api/student/records，D10）：本人全部作答的时间倒序索引
 * （作业 + 课程练习混排，每条标来源）+ 筛选 + 分页。行内不含题目内容字段
 * （答案/详解在单次结果视图按既有口径下发）。
 */
export function fetchStudentRecordsApi(
  params: StudentRecordsParams,
): Promise<StudentRecordsData> {
  const query: Record<string, string> = {};
  if (params.sourceType !== undefined) query.sourceType = params.sourceType;
  if (params.courseId !== undefined) query.courseId = params.courseId;
  if (params.assignmentId !== undefined) {
    query.assignmentId = params.assignmentId;
  }
  if (params.status !== undefined) query.status = params.status;
  if (params.from !== undefined) query.from = params.from;
  if (params.to !== undefined) query.to = params.to;
  query.limit = String(params.limit);
  query.offset = String(params.offset);
  return callApi(() => api.api.student.records.$get({ query }));
}

/**
 * 错题本查询参数（界面层形态，D11）。undefined 字段不发送（= 后端默认：
 * 不筛考点、只列最近仍错的题）。includeResolved 走 z.stringbool（"true"/"false"）。
 */
export interface WrongQuestionsParams {
  knowledge?: string | undefined;
  includeResolved?: boolean | undefined;
}

/**
 * 错题本（GET /api/student/wrong-questions，D11）：按 (学生, 题目) 跨全部来源
 * 聚合；题目内容取最近一次判定作答的快照（已交卷内容允许下发，与结果视图
 * 同口径）。无分页（单学生错题规模有限）。
 */
export function fetchStudentWrongQuestionsApi(
  params: WrongQuestionsParams,
): Promise<WrongQuestionsData> {
  const query: Record<string, string> = {};
  if (params.knowledge !== undefined) query.knowledge = params.knowledge;
  if (params.includeResolved !== undefined) {
    query.includeResolved = String(params.includeResolved);
  }
  return callApi(() =>
    api.api.student["wrong-questions"].$get(
      Object.keys(query).length > 0 ? { query } : undefined,
    ),
  );
}

// ---------- T4.2：学情分析（纯消费 T4.1 三接口，口径见契约 analytics-api.ts） ----------

/**
 * 学情三接口共用查询参数（界面层形态）。undefined 字段不发送（= 后端默认：
 * days=30、focusDays=14、课程不筛）；days 为正整数天数或 "all"（全部）；
 * focusDays 只作用于「下节课重点」卡片（与 days 独立，D5）。
 */
export interface AnalyticsFetchParams {
  courseId?: string | undefined;
  days?: number | "all" | undefined;
  focusDays?: number | undefined;
}

/** 学情查询参数 → querystring（undefined 字段不发送；数值转字符串） */
function analyticsQueryOf(
  params: AnalyticsFetchParams,
): Record<string, string> {
  const query: Record<string, string> = {};
  if (params.courseId !== undefined) query.courseId = params.courseId;
  if (params.days !== undefined) query.days = String(params.days);
  if (params.focusDays !== undefined)
    query.focusDays = String(params.focusDays);
  return query;
}

/** 学情总览（完成矩阵 + 周趋势 + 下节课重点 + 关键计数 + 离线占比 + 重做计数） */
export function fetchAnalyticsOverviewApi(
  params: AnalyticsFetchParams = {},
): Promise<AnalyticsOverviewData> {
  const query = analyticsQueryOf(params);
  return callApi(() =>
    api.api.teacher.analytics.overview.$get(
      Object.keys(query).length > 0 ? { query } : undefined,
    ),
  );
}

/**
 * 学生画像（趋势/考点/异常题/重做/离线/讲义阅读地图）。
 * 学生不存在或非本教师 → 404 STUDENT_NOT_FOUND（ApiError 由页面分支成错误态）。
 */
export function fetchAnalyticsStudentApi(
  studentId: string,
  params: AnalyticsFetchParams = {},
): Promise<AnalyticsStudentData> {
  // hc 对带 param 的路由只推断出 param 入参，query 以独立变量传入（同 updateQuestion）
  const args = { param: { id: studentId }, query: analyticsQueryOf(params) };
  return callApi(() => api.api.teacher.analytics.student[":id"].$get(args));
}

/** 题目视角（题目/考点正确率、平均用时、高频错误答案分布） */
export function fetchAnalyticsQuestionsApi(
  params: AnalyticsFetchParams = {},
): Promise<AnalyticsQuestionsData> {
  const query = analyticsQueryOf(params);
  return callApi(() =>
    api.api.teacher.analytics.questions.$get(
      Object.keys(query).length > 0 ? { query } : undefined,
    ),
  );
}

// ---------- T4.4：AI 学情数据包导出向导（契约 learning-pack.ts；业务 T4.3） ----------

/**
 * 学情数据包预览（POST /api/teacher/export/learning-pack/preview，统一壳）：
 * 向导第⑤步数据源——文件清单 + 预估大小 + 超限标志（overLimit 时向导提示
 * 精简并禁用下载；D18）。请求 schema 与生成接口共用（D14 五步的同一份勾选）。
 * 错误：范围 id 域校验 404 STUDENT_NOT_FOUND 等 → ApiError（页面错误态展示）。
 */
export function previewLearningPackApi(
  request: LearningPackExportRequest,
): Promise<LearningPackPreviewData> {
  // 路径段按实际路由名取（learning-preview，连字符），hc 不做驼峰转换
  return callApi(() =>
    api.api.teacher.export["learning-pack"].preview.$post({ json: request }),
  );
}

/**
 * 生成并下载学情数据包 zip（POST /api/teacher/export/learning-pack，
 * 文件直出非统一壳）：zip 二进制流不适合 hc 的 JSON 类型链，用同构 fetch
 * （同源相对路径自动带会话 Cookie，与 downloadTeacherExportCsv 同口径）
 * 拿 blob 触发浏览器下载；文件名取响应 Content-Disposition（服务端按请求
 * 时刻北京时间生成 learning-pack-YYYYMMDD-HHmmss.zip），取不到时回退固定名。
 * 失败：统一壳错误仍为 JSON（如 413 EXPORT_TOO_LARGE 含精简方向）→ 经
 * throwShellError 抛 ApiError；返回值为实际使用的下载文件名。
 */
export async function downloadLearningPackApi(
  request: LearningPackExportRequest,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch("/api/teacher/export/learning-pack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    throw new Error(
      "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
    );
  }
  if (!res.ok) {
    // 文件接口的错误仍是统一 JSON 壳
    await throwShellError(res);
  }
  const filename = filenameFromDisposition(res, "learning-pack.zip");
  saveBlobAs(await res.blob(), filename);
  return filename;
}

// ---------- T6R.13：单题完整导出（review-pack，契约 review-pack.ts） ----------

/** review-pack 请求角色：契约单一来源（reviewPackSchema 的 role 字面量联合） */
export type { ReviewPackRole };

/** 单题包预览（POST …/review-pack/preview 统一壳；附件清单 + 缺失 + reviewMd） */
export function fetchReviewPackPreviewApi(
  role: ReviewPackRole,
  attemptId: string,
  questionId: string,
): Promise<ReviewPackPreviewData> {
  return callApi(() =>
    role === "student"
      ? api.api.student.attempts[":id"].questions[":questionId"][
          "review-pack"
        ].preview.$post({ param: { id: attemptId, questionId } })
      : api.api.teacher.attempts[":id"].questions[":questionId"][
          "review-pack"
        ].preview.$post({ param: { id: attemptId, questionId } }),
  );
}

/**
 * 下载单题包 zip（POST …/review-pack 文件直出；同 downloadLearningPackApi
 * 模式：同构 fetch 拿 blob 触发浏览器下载，文件名取 Content-Disposition，
 * 回退固定名）。网络失败给中文提示；服务端统一壳错误经 throwShellError 抛
 * ApiError。**每次点击都重新请求**（响应 no-store，不跨账号缓存复用）。
 */
export async function downloadReviewPackApi(
  role: ReviewPackRole,
  attemptId: string,
  questionId: string,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(
      `/api/${role}/attempts/${encodeURIComponent(attemptId)}/questions/${encodeURIComponent(questionId)}/review-pack`,
      { method: "POST" },
    );
  } catch {
    throw new Error("连不上服务器，请检查网络后重试");
  }
  if (!res.ok) {
    await throwShellError(res);
  }
  const filename = filenameFromDisposition(res, "review-pack.zip");
  saveBlobAs(await res.blob(), filename);
  return filename;
}

/**
 * 逐张下载真实图片（媒体配图 / 证据分析图；url 来自预览 attachments 的
 * downloadUrl——学生/教师各自已授权的直出端点或公开 /blobs 路径）。
 * 会话过期（401/403）与网络失败都显式抛中文错误，**不静默声称下载成功**。
 */
export async function downloadAttachmentApi(
  url: string,
  filename: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error("连不上服务器，请检查网络后重试");
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("没有权限读取这张图片（登录可能已过期，请刷新页面后重试）");
  }
  if (!res.ok) {
    throw new Error(`图片下载失败（HTTP ${res.status}）`);
  }
  saveBlobAs(await res.blob(), filename);
}

// ---------- 备份与恢复（T4.5，D20/D21 口径见契约 backup-api.ts） ----------

/**
 * 最近快照列表（设置页「最近快照」区数据源）。
 * hc RPC 走统一壳（JSON 响应），与 snapshots 契约端到端类型一致。
 */
export function fetchBackupSnapshots(): Promise<BackupSnapshotList> {
  return callApi(() => api.api.teacher.backup.snapshots.$get());
}

// ---------- API Token（T4.6，D22；MCP 鉴权凭证，设置页数据源） ----------

/**
 * 查看当前 API Token（D22：可随时查看，不做「只显示一次」）。
 * 从未生成时 data.token=null（设置页提示可生成）。
 */
export function fetchApiToken(): Promise<TeacherApiTokenData> {
  return callApi(() => api.api.teacher["api-token"].$get());
}

/**
 * 生成 / 重置 API Token（同一动作：无则生成、有则覆盖列值）。
 * 返回新 token；**旧 token 立即失效**——调用方（设置页）在重置前必须二次确认
 * 并提示「已配置的客户端（如 Claude Desktop）需要更新 token」。
 */
export function resetApiToken(): Promise<TeacherApiTokenResetData> {
  return callApi(() => api.api.teacher["api-token"].$post());
}

// ---------- 学情报告（T4.6 接口；T4.7 画像页报告区消费，D24） ----------

/**
 * 学生报告列表（createdAt 倒序；摘要行不含 markdown 正文）。
 * 学生不存在或非本教师 → 404 STUDENT_NOT_FOUND（画像页对 404 已有整页错误态，
 * 报告区单独吞掉 404 展示为空即可——画像数据与报告同源自同一名学生）。
 */
export function fetchStudentReports(
  studentId: string,
): Promise<ReportListData> {
  return callApi(() =>
    api.api.teacher.students[":id"].reports.$get({
      param: { id: studentId },
    }),
  );
}

/** 单份报告详情（含 markdown 正文；画像页「点开渲染」按需取） */
export function fetchReportDetail(reportId: string): Promise<ReportDetail> {
  return callApi(() =>
    api.api.teacher.reports[":id"].$get({ param: { id: reportId } }),
  );
}

/** 删除报告（D24：不做编辑；非本教师报告 404，删除前页面有确认弹层） */
export function deleteReportApi(reportId: string): Promise<null> {
  return callApi(() =>
    api.api.teacher.reports[":id"].$delete({ param: { id: reportId } }),
  );
}

/**
 * 下载完整备份 zip（GET 文件直出，同 downloadLearningPackApi 模式）：
 * 同构 fetch（同源自动带会话 Cookie）→ blob 触发 a[download] 浏览器下载，
 * 返回实际文件名；错误响应（统一 JSON 壳）抛 ApiError。
 */
export async function downloadBackupApi(): Promise<string> {
  let res: Response;
  try {
    res = await fetch("/api/teacher/backup/download", { method: "GET" });
  } catch {
    throw new Error(
      "连不上服务器，请确认后端已启动（pnpm --filter server dev）后重试",
    );
  }
  if (!res.ok) {
    // 文件接口的错误仍是统一 JSON 壳
    await throwShellError(res);
  }
  const filename = filenameFromDisposition(res, "tutor-backup.zip");
  saveBlobAs(await res.blob(), filename);
  return filename;
}

/**
 * 从备份 zip 恢复整库（D21：multipart zip 文件 + 登录密码，服务端 scrypt 校验）。
 * multipart 路由 hc 推断不出 form 入参（与笔迹上传同因），用同构 fetch +
 * callApi 统一壳校验；成功返回恢复摘要（sessionWarning=true 时页面提示重新登录）。
 */
export function restoreBackupApi(
  zip: File,
  password: string,
): Promise<BackupRestoreResult> {
  const form = new FormData();
  form.append("zip", zip);
  form.append("password", password);
  return callApi(() =>
    fetch("/api/teacher/backup/restore", { method: "POST", body: form }),
  );
}
