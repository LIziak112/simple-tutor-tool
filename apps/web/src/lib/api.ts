import {
  type AssignmentCreateRequest,
  type AssignmentUpdateRequest,
  type AttemptAnswerSaveData,
  type AttemptAnswerSaveRequest,
  type AttemptDetailData,
  type AttemptEvent,
  type AttemptStartData,
  apiResponseSchema,
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
  type PublicConfigData,
  type QuestionDetail,
  type QuestionUpdateData,
  type QuestionUpdateRequest,
  type ReorderRequest,
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
  type StudentPaperData,
  type StudentResetLinkData,
  type StudentResetPasswordData,
  type StudentSummary,
  type StudentUnitLandingData,
  type StudentUpdateRequest,
  type TeacherAssignment,
  type TeacherAssignmentListData,
  type TeacherInfo,
  type TeacherStatusData,
  type UnitMetaData,
  type UnitMetaUpdate,
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

/** 删除课程（有作答记录时后端 409 COURSE_HAS_ATTEMPTS，D4：提示改用归档） */
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

/** 作业列表（默认只列未删除；includeDeleted=true 含已删除作业） */
export function fetchAssignmentsApi(
  includeDeleted: boolean,
): Promise<TeacherAssignmentListData> {
  return callApi(() =>
    api.api.teacher.assignments.$get(
      includeDeleted ? { query: { includeDeleted: "true" } } : undefined,
    ),
  );
}

/**
 * 布置作业 {unitId, title?, studentIds[], dueAt?}。
 * dueAt 必须是带 Z 后缀的 UTC ISO（datetime-local 值先经页面转 UTC，见 lib/time.ts）；
 * unitId 不存在 404 UNIT_NOT_FOUND / studentIds 空或含未知 id 由后端契约拦截。
 */
export function createAssignmentApi(
  request: AssignmentCreateRequest,
): Promise<TeacherAssignment> {
  return callApi(() => api.api.teacher.assignments.$post({ json: request }));
}

/**
 * 更新作业（改标题/截止/全量替换名单；dueAt 显式 null = 取消截止）。
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

/** 通用取卷（两种来源共用；课程来源每次校验可见性与成员资格） */
export function fetchAttemptPaperApi(
  attemptId: string,
): Promise<StudentPaperData> {
  return callApi(() =>
    api.api.student.attempts[":id"].paper.$get({ param: { id: attemptId } }),
  );
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
 * 交卷：服务端判分、冻结题目快照，返回结果视图（含参考答案与详解）。
 * 重复交卷抛 409 ALREADY_SUBMITTED。
 */
export function submitAttemptApi(
  attemptId: string,
): Promise<AttemptDetailData> {
  return callApi(() =>
    api.api.student.attempts[":id"].submit.$post({ param: { id: attemptId } }),
  );
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
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
