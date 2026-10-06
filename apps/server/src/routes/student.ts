import type { StudentPasswordChangeRequest } from "@tutor/contract";
import {
  attemptAnswerSaveRequestSchema,
  attemptEventBatchRequestSchema,
  attemptSubmitRequestSchema,
  hintOpenRequestSchema,
  lectureEventBatchRequestSchema,
  noteUploadMetaSchema,
  studentLectureDetailQuerySchema,
  studentPasswordChangeRequestSchema,
  studentRecordsQuerySchema,
  wrongPracticeRequestSchema,
  wrongQuestionsQuerySchema,
} from "@tutor/contract";
import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { createRequireStudent, type StudentEnv } from "../auth/require-student";
import {
  deleteSession,
  isSecurePublicUrl,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "../auth/session";
import type { Db } from "../db/client";
import {
  noStoreBinaryResponse,
  pngResponse,
  stripPngSuffix,
} from "../lib/binary-response";
import {
  formString,
  parseNoteImageUploadForm,
  strictFormInt,
} from "../lib/form-fields";
import {
  firstIssueMessage,
  HttpError,
  parseJsonBody,
  parseJsonBodyOrEmpty,
} from "../lib/http-error";
import {
  getStudentAssignmentPaper,
  listStudentAssignments,
} from "../services/assignment-service";
import {
  getAttemptDetail,
  getStudentAttemptPaper,
  saveDraftAnswer,
  startAttempt,
  startCourseAttempt,
  submitAttempt,
} from "../services/attempt-service";
import {
  appendAttemptEvents,
  appendLectureEvents,
} from "../services/event-service";
import { openHint } from "../services/hint-service";
import { getInkDoc, getStudentInkPng, saveInk } from "../services/ink-service";
import {
  attachNoteImage,
  getStudentNoteDocument,
  getStudentNoteEvidence,
  getStudentNoteHead,
  getStudentNoteImagePng,
  saveNoteVersion,
} from "../services/note-service";
import {
  getStudentCourseDetail,
  getStudentLecture,
  getStudentUnitLanding,
  listStudentCourses,
  listStudentLectures,
} from "../services/student-course-service";
import { listStudentRecords } from "../services/student-records";
import { changeStudentPassword } from "../services/student-service";
import { startWrongPractice } from "../services/wrong-practice";
import { listWrongQuestions } from "../services/wrong-questions";

/**
 * 学生路由（需学生会话），挂载在 /api/student，整组套 requireStudent 守卫：
 * - GET  /me：当前登录学生信息（displayName 等，守卫已校验存在且未归档）；
 * - POST /password：自助修改密码（验证原密码）；
 * - GET  /assignments：我的作业（仅本人被指派且未删除，附完成状态，T2.2；
 *   T2.6 起状态由 attempts 推导：未开始/进行中/已交/已批）；
 * - GET  /assignments/:id/paper：作业试卷——按单元分组的公开题目（T2.4；
 *   T2A.7 起为 {units:[{id,title,questions}]}，live 题数为 0 的单元不出现
 *   （D16：单元软删不影响出卷）；未被指派 403，作业不存在/已删除 404）；
 * - POST /assignments/:id/attempt：创建或取回进行中的 attempt（T2.6，幂等：
 *   一人一份进行中；已交卷返回已交的那份让前端直接进结果视图）；
 * - PUT  /attempts/:id/answers/:questionId：保存草稿答案（T2.6；已交 409）；
 * - POST /attempts/:id/submit：服务端判分 + 快照冻结 + 返回结果（T2.6；
 *   重复交卷 409 ALREADY_SUBMITTED）；
 * - POST /attempts/:id/hints：分步提示（T2.11，{questionId, index} → 被请求的
 *   那一条提示 + 计数；index 越界 400 HINT_INDEX_OUT_OF_RANGE；draft 与已交均
 *   可用；服务端记录 hint_open 事件与 responses 已解锁集合）；
 * - GET  /attempts/:id：attempt 详情（T2.6；未交=草稿视图（无答案/详解/未请求
 *   提示），已交=结果视图（含答案与详解、回显已解锁提示））；
 * - POST /attempts/:id/events：学习痕迹事件批量上报（T2.10，≤200 条/次：
 *   超限/非法 type 400，非本人 403，未登录 401；已交后仍收——交卷瞬间的前台
 *   flush 可能晚到，宽松口径见 event-service）；响应只回 accepted 计数；
 *   T4.0a 增收交互族（host=question/result）、ink_edit_batch、ink_fullscreen、
 *   net/idle（接收范围由契约 attemptEventSchema 锁定）；
 * - POST /events：无 attempt 上下文的事件批量（T2.10 lecture_expand +
 *   T4.0a 讲义域事件组：lecture_visible/hidden、net、idle、
 *   lecture_section_focus、lecture_toc_jump、directive_interact host=lecture；
 *   attemptId/questionId 落 NULL，studentId 从会话写、lectureId 从 payload 提取）；
 * - PUT  /attempts/:id/ink/:questionId：上传/覆盖手写笔迹（T2.8，multipart：
 *   strokes（gzip 后 InkDoc JSON）+ snapshot（PNG），合计 ≤2MB 超 413）；
 * - GET  /attempts/:id/ink/:questionId：取回该题矢量 InkDoc（无笔迹 404）；
 * - GET  /attempts/:id/ink/:questionId.png：本人笔迹 PNG 直出（结果页缩略图）；
 * - PUT  /attempts/:id/notes/:questionId：题目草稿正文上传（T6R.4，multipart：
 *   body 文件（gzip 或原始 JSON 的 NoteDoc）+ baseRevision/mutationId；CAS
 *   409 NOTE_REVISION_CONFLICT 附 _current 摘要、mutationId 幂等回执、限额
 *   413 NOTE_LIMIT_EXCEEDED）；
 * - GET  /attempts/:id/notes/:questionId：本次工作稿头（T6R.5 ①，noteRecordMeta
 *   + 生效版本派生图 + 证据行；无笔记 → 显式空态 note=null，客户端按
 *   baseRevision=0 起步；本人 + attempt 可用 + 题目属冻结集合）；
 * - GET  /attempts/:id/evidence/:questionId：本次只读证据与图片状态（T6R.5 ②，
 *   本人历史权限——已交卷可读、软删题历史证据可读、不查询当前题库存活）；
 * - GET  /note-versions/:versionId/document：读正文（T6R.5 ③，gzip 原字节直出
 *   application/gzip + attachment 下载语义 + no-store；仅经 versionId→note→
 *   attempt→本人归属链授权，不暴露磁盘路径）；
 * - GET  /note-versions/:versionId/images/:imageId(.png)：派生图 PNG 直出
 *   （T6R.5 ④，image/png + no-store；参照 ink 的 .png 后缀分流惯例——后缀
 *   可选，同一资源双 URL 形态，无元数据 JSON 变体）；
 * - POST /note-versions/:versionId/images：为自己的已固定版本补派生图
 *   （T6R.5 ⑤，multipart：image PNG + spec/pageIndex/cropX/Y/W/H/pixel 尺寸；
 *   槽位 (versionId,spec,pageIndex) upsert、hash 服务端算、单图 2MiB/聚合
 *   8MiB 限额、PNG 魔数与 IHDR 尺寸须与声明一致；只能挂既定版本不能改正文；
 *   交卷后仍放行〔补图是恢复通道〕）；
 * - GET  /courses、GET /courses/:id：我的课程（可见讲义/单元计数，完成数 T2A.6 前恒 0）
 *   与课程可见目录（T2A.5，D5 过滤；D22——非成员/学生归档/课程归档 403
 *   COURSE_ACCESS_DENIED，课程不存在/条目不可见 404 NOT_FOUND 不暴露存在性）；
 * - GET  /lectures、GET /lectures/:id：可见讲义双视图（去重并集 + 按课程分组）与
 *   讲义详情（T2.3 起；T2A.5 切换 D5——只含所在课程可见讲义，详情带 ?courseId=
 *   课程上下文与本课配套练习 D8）；
 * - GET  /records（T3.5，D10）：我的记录——本人全部作答的时间倒序索引
 *   （sourceType/courseId/assignmentId/status/from/to/limit/offset 筛选分页；
 *   失权草稿不列、已交卷一律保留；after_due 未公布得分/待批置 null）；
 * - GET  /wrong-questions（T3.5，D11；2026-10 轮次史扩展）：错题本——按
 *   (学生, 题目) 跨全部来源聚合（knowledge 精确筛选、includeResolved 显示
 *   已攻克；只统计已判定作答；after_due 未公布作业的作答整体不参与聚合；
 *   rounds 轮次史 + wrongCount/correctCount + originUnit 归属单元一并下发，
 *   攻克判定规则由端上自选、服务端不下发）；
 * - POST /wrong-practice（2026-10 错题重练）：{questionIds} 圈题组卷——范围
 *   由前端按错题本当前 tab + 分组圈定，服务端校验（∈ 聚合且快照可用，否则
 *   静默剔除；剔完为空 400 WRONG_PRACTICE_EMPTY）并按最近一次判定作答的
 *   快照冻结组卷（sourceType=wrong，题目顺序 = questionIds 顺序）；响应为新
 *   attempt 摘要（201）；作答/判分/批改复用既有 /attempts/:id/* 机制；
 * - POST /logout：删除会话行并清除 Cookie（T2.3，与教师 logout 同实现口径）。
 *
 * 路径段带后缀说明：Hono 的 path 参数会吞掉整个 segment（含 .png 后缀），
 * 因此 ink 的取回路由注册一个 /attempts/:id/ink/:questionId，handler 内按
 * .png 后缀分流 JSON（矢量文档）与 PNG（快照直出）——对外 URL 形态与任务
 * 约定一致（GET …/ink/:questionId 与 GET …/ink/:questionId.png）。T6R.5 的
 * note-versions 图片路由同款注册 /images/:file：该资源只有 PNG 一种形态
 * （元数据经头投影接口下发），后缀可选——带不带 .png 都直出 PNG。
 *
 * 学生端接口永不返回答案/详解等教师侧内容（AGENTS.md 第 3 条）：/assignments
 * 只含单元公开元信息（标题/topic/题数）；/assignments/:id/paper 与草稿视图的
 * 每道题经 questionPublicSchema 输出过滤且题干已公开化（[[答案]] → [[]]）；
 * /attempts/:id 的结果视图在交卷后允许携带参考答案与详解（规则 3 限制的是
 * 「未交卷题目」）；提示内容只经 /attempts/:id/hints 按需逐条下发（T2.11），
 * 两个视图仅回显已解锁条目。T6R.5 的 notes/evidence/补图接口只含笔记元信息、
 * 图片状态与学生自产附件（题干内容不在本批接口）。泄露测试见
 * routes/assignments.test.ts、routes/student-lectures.test.ts、
 * routes/student-paper.test.ts 与 routes/student-attempts.test.ts
 * （通用工具 src/test/assert-no-leak.ts；T2.8 ink 接口见 routes/student-ink.test.ts；
 * T2.11 提示接口与全学生端泄露矩阵见 routes/student-hints.test.ts；
 * T6R.5 草稿接口见 routes/student-notes.test.ts 与 routes/student-note-read.test.ts）。
 * 返回类型不显式标注 Hono：链式注册把路由签名累积进推断类型（AppType / hc 前提）。
 */
export function createStudentRoutes(
  db: Db,
  publicUrl: string,
  dataDir: string,
) {
  const requireStudent = createRequireStudent(db, publicUrl);
  return (
    new Hono<StudentEnv>()
      .use("*", requireStudent)
      .get("/me", (c) => {
        return c.json({ ok: true, data: c.var.student });
      })
      .post("/password", async (c) => {
        const body: StudentPasswordChangeRequest = await parseJsonBody(
          c,
          studentPasswordChangeRequestSchema,
        );
        return c.json({
          ok: true,
          data: await changeStudentPassword(db, c.var.student.id, body),
        });
      })
      .get("/assignments", (c) => {
        return c.json({
          ok: true,
          data: listStudentAssignments(db, c.var.student.id),
        });
      })
      .get("/assignments/:id/paper", (c) => {
        return c.json({
          ok: true,
          data: getStudentAssignmentPaper(
            db,
            c.var.student.id,
            c.req.param("id"),
          ),
        });
      })
      .post("/assignments/:id/attempt", (c) => {
        return c.json({
          ok: true,
          data: startAttempt(db, c.var.student.id, c.req.param("id")),
        });
      })
      .put("/attempts/:id/answers/:questionId", async (c) => {
        const body = await parseJsonBody(c, attemptAnswerSaveRequestSchema);
        return c.json({
          ok: true,
          data: saveDraftAnswer(
            db,
            c.var.student.id,
            c.req.param("id"),
            c.req.param("questionId"),
            body.answer,
          ),
        });
      })
      .post("/attempts/:id/submit", async (c) => {
        // T2A.8：now 显式注入（服务层按 answerRelease+dueAt 决定交卷瞬间的形态）
        // T6R.3：交卷回传每题 questionRevisionId 验证题目版本（与冻结集合精确
        // 比对）；不带请求体按空集合传入——非空卷自然 409 QUESTION_REVISION_STALE
        // （旧标签页/陈旧页面可诊断提示刷新，不静默接受）
        const body = await parseJsonBodyOrEmpty(c, attemptSubmitRequestSchema);
        return c.json({
          ok: true,
          data: submitAttempt(
            db,
            c.var.student.id,
            c.req.param("id"),
            new Date(),
            body?.revisions ?? [],
          ),
        });
      })
      // T2.11：分步提示——按需下发被请求的那一条并记录（hint_open 事件 + 已解锁集合）
      .post("/attempts/:id/hints", async (c) => {
        const body = await parseJsonBody(c, hintOpenRequestSchema);
        return c.json({
          ok: true,
          data: openHint(
            db,
            c.var.student.id,
            c.req.param("id"),
            body.questionId,
            body.index,
          ),
        });
      })
      .get("/attempts/:id", (c) => {
        // T2A.8：now 显式注入（读时比较 dueAt，截止后自动恢复完整结果视图）
        return c.json({
          ok: true,
          data: getAttemptDetail(
            db,
            c.var.student.id,
            c.req.param("id"),
            new Date(),
          ),
        });
      })
      // T2A.6：通用取卷（两种来源共用；T5 鉴权口径——assignment 来源归属即
      // 权限，被移出/作业软删后已建作答仍可取卷；course 来源每次校验可见性与
      // 成员资格，D22——course draft 失去访问权 403/404，前端据此按终态停发）
      .get("/attempts/:id/paper", (c) => {
        return c.json({
          ok: true,
          data: getStudentAttemptPaper(db, c.var.student.id, c.req.param("id")),
        });
      })
      // T2.10：学习痕迹事件批量上报（attempt 上下文，≤200 条/次由契约拦截）
      .post("/attempts/:id/events", async (c) => {
        const body = await parseJsonBody(c, attemptEventBatchRequestSchema);
        return c.json({
          ok: true,
          data: appendAttemptEvents(
            db,
            c.var.student.id,
            c.req.param("id"),
            body.events,
          ),
        });
      })
      // T2.10：无 attempt 上下文的事件批量（讲义 lecture_expand 等）
      .post("/events", async (c) => {
        const body = await parseJsonBody(c, lectureEventBatchRequestSchema);
        return c.json({
          ok: true,
          data: appendLectureEvents(db, c.var.student.id, body.events),
        });
      })
      // T2.8：上传/覆盖一道手写题的笔迹（multipart：strokes + snapshot）
      .put("/attempts/:id/ink/:questionId", async (c) => {
        const body = await c.req.parseBody();
        const strokes = body.strokes;
        const snapshot = body.snapshot;
        // 两段都必须是文件（multipart 文件字段；字符串字段说明客户端组装错误）
        if (!(strokes instanceof File) || !(snapshot instanceof File)) {
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            "请求需为 multipart/form-data，且包含 strokes 与 snapshot 两个文件",
          );
        }
        return c.json({
          ok: true,
          data: saveInk(
            db,
            dataDir,
            c.var.student.id,
            c.req.param("id"),
            c.req.param("questionId"),
            new Uint8Array(await strokes.arrayBuffer()),
            new Uint8Array(await snapshot.arrayBuffer()),
          ),
        });
      })
      // T2.8：取回矢量文档（JSON）或本人 PNG（.png 后缀分流，见文件头说明）
      .get("/attempts/:id/ink/:questionId", (c) => {
        const raw = c.req.param("questionId");
        if (raw.endsWith(".png")) {
          const png = getStudentInkPng(
            db,
            dataDir,
            c.var.student.id,
            c.req.param("id"),
            // questionId 本身可能含点（来自 DSL），只剥离末尾 .png
            stripPngSuffix(raw),
          );
          return pngResponse(png.bytes, png.etag);
        }
        return c.json({
          ok: true,
          data: getInkDoc(
            db,
            dataDir,
            c.var.student.id,
            c.req.param("id"),
            raw,
          ),
        });
      })
      // T6R.4：题目草稿正文上传（方案 §8 形态）。multipart：body 文件（gzip
      // 或原始 JSON 的 NoteDoc）+ baseRevision/mutationId 字段（契约
      // noteUploadMetaSchema）。本人+进行中 attempt+题目属冻结集合（service
      // 内统一门口）；CAS 失败 409 附 _current 摘要、同 mutationId 重放同文
      // 原回执/异文 409（service 内实现）。响应 noteVersionReceipt；客户端
      // 多发的 noteId/serverSavedAt/phase 等字段一律忽略（归属与时间全由
      // 服务端定）。
      .put("/attempts/:id/notes/:questionId", async (c) => {
        const form = await c.req.parseBody();
        const body = form.body;
        // 正文必须是文件字段（multipart 文件；字符串字段说明客户端组装错误）
        if (!(body instanceof File)) {
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            "请求需为 multipart/form-data，且包含 body 文件与 baseRevision、mutationId 字段",
          );
        }
        // multipart 字段全是字符串：baseRevision 按严格十进制整数串转数
        // （T6R.4 复审③——空串与科学计数/十六进制/小数一律不转，交契约
        // schema 出 400；JSON 通道的 number 形态契约不变，此转换属传输层）
        const parsed = noteUploadMetaSchema.safeParse({
          baseRevision: strictFormInt(form, "baseRevision"),
          mutationId: formString(form, "mutationId"),
        });
        if (!parsed.success) {
          const first = firstIssueMessage(parsed.error);
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            `草稿上传元信息不合法：${first}`,
          );
        }
        return c.json({
          ok: true,
          data: saveNoteVersion(
            db,
            dataDir,
            c.var.student.id,
            c.req.param("id"),
            c.req.param("questionId"),
            new Uint8Array(await body.arrayBuffer()),
            parsed.data,
          ),
        });
      })
      // T6R.5 ①：本次工作稿头（noteRecordMeta + 生效版本派生图 + 证据行）。
      // 本人且 attempt 可继续作答（requireUsableAttempt）+ 题目属冻结集合
      // （严格口径，与写通道同一门口）；无笔记 → 显式空态 note=null。
      .get("/attempts/:id/notes/:questionId", (c) => {
        return c.json({
          ok: true,
          data: getStudentNoteHead(
            db,
            c.var.student.id,
            c.req.param("id"),
            c.req.param("questionId"),
          ),
        });
      })
      // T6R.5 ②：本次只读证据与图片状态。本人历史权限（已交卷可读、软删题
      // 历史证据可读——题目成员资格按 attempt 自有 responses 行宽判定，不查
      // 当前题库存活）；课程撤权的进行中稿与 detail 同口径 403。
      .get("/attempts/:id/evidence/:questionId", (c) => {
        return c.json({
          ok: true,
          data: getStudentNoteEvidence(
            db,
            c.var.student.id,
            c.req.param("id"),
            c.req.param("questionId"),
          ),
        });
      })
      // T6R.5 ③：版本文档直出（gzip 原字节；授权在 service 归属链，版本行
      // 不存在 404、非本人 403）。no-store + attachment（下载语义）统一走
      // lib/binary-response.noStoreBinaryResponse（缓存口径理由见其注释）
      .get("/note-versions/:versionId/document", (c) => {
        const versionId = c.req.param("versionId");
        const bytes = getStudentNoteDocument(
          db,
          dataDir,
          c.var.student.id,
          versionId,
        );
        return noStoreBinaryResponse(bytes, "application/gzip", {
          attachmentFilename: `note-${versionId}.json.gz`,
        });
      })
      // T6R.5 ④：派生图 PNG 直出（.png 后缀可选——分流惯例见文件头说明）
      .get("/note-versions/:versionId/images/:file", (c) => {
        const bytes = getStudentNoteImagePng(
          db,
          dataDir,
          c.var.student.id,
          c.req.param("versionId"),
          stripPngSuffix(c.req.param("file")),
        );
        return noStoreBinaryResponse(bytes, "image/png");
      })
      // T6R.5 ⑤：为自己的已固定版本补派生图（multipart 字段集与教师端共用
      // lib/form-fields.parseNoteImageUploadForm；PNG 完整性/限额/槽位 upsert
      // 在 note-service.attachNoteImage）
      .post("/note-versions/:versionId/images", async (c) => {
        const { png, meta } = parseNoteImageUploadForm(await c.req.parseBody());
        return c.json({
          ok: true,
          data: attachNoteImage(
            db,
            dataDir,
            { kind: "student", id: c.var.student.id },
            c.req.param("versionId"),
            new Uint8Array(await png.arrayBuffer()),
            meta,
          ),
        });
      })
      // T2A.5：我的课程与课程可见目录（D5，canStudentSeeItem 唯一判定；
      // 隐藏条目零信息；D22——非成员/归档 403，不存在/不可见 404）
      .get("/courses", (c) => {
        return c.json({
          ok: true,
          data: listStudentCourses(db, c.var.student.id),
        });
      })
      .get("/courses/:id", (c) => {
        return c.json({
          ok: true,
          data: getStudentCourseDetail(db, c.var.student.id, c.req.param("id")),
        });
      })
      // T2A.6：单元落地页（D10——题数/题型分布/历次作答/首次/最近/最高分/未交卷标记；
      // 每次调用都走 D5 可见性门，D22 错误口径）
      .get("/courses/:id/units/:unitId", (c) => {
        return c.json({
          ok: true,
          data: getStudentUnitLanding(
            db,
            c.var.student.id,
            c.req.param("id"),
            c.req.param("unitId"),
          ),
        });
      })
      // T2A.6：课程练习入口（存在未交卷作答返回它；否则新建 attemptNo+1，
      // 新一次从空白开始；事务保证并发只得一份 draft）
      .post("/courses/:id/units/:unitId/attempts", (c) => {
        return c.json(
          {
            ok: true,
            data: startCourseAttempt(
              db,
              c.var.student.id,
              c.req.param("id"),
              c.req.param("unitId"),
            ),
          },
          201,
        );
      })
      // T2A.5：可见讲义双视图（去重并集 + 按课程分组，D5 过滤）
      .get("/lectures", (c) => {
        return c.json({
          ok: true,
          data: listStudentLectures(db, c.var.student.id),
        });
      })
      // T3.5（D10）：我的记录——本人全部作答的时间倒序索引（作业 + 课程练习
      // 混排）+ 筛选 + 分页。失权草稿不列、已交卷一律保留；after_due 未公布
      // 的作业得分与待批数置 null（answersReleased=false）。行数据不含任何
      // 题目内容字段（assertNoLeak 见 routes/student-records.test.ts）
      .get("/records", (c) => {
        // GET 无 JSON body：查询参数手工过契约 schema（数值字段经 coerce 解析）
        const parsed = studentRecordsQuerySchema.safeParse({
          sourceType: c.req.query("sourceType") ?? undefined,
          courseId: c.req.query("courseId") ?? undefined,
          assignmentId: c.req.query("assignmentId") ?? undefined,
          status: c.req.query("status") ?? undefined,
          from: c.req.query("from") ?? undefined,
          to: c.req.query("to") ?? undefined,
          limit: c.req.query("limit") ?? undefined,
          offset: c.req.query("offset") ?? undefined,
        });
        if (!parsed.success) {
          const first = firstIssueMessage(parsed.error);
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            `查询参数不合法：${first}`,
          );
        }
        // now 显式注入（after_due 读时比较，截止后自动恢复真实得分）
        return c.json({
          ok: true,
          data: listStudentRecords(
            db,
            c.var.student.id,
            parsed.data,
            new Date(),
          ),
        });
      })
      // T3.5（D11；2026-10 轮次史扩展）：错题本——按 (studentId, questionId)
      // 跨全部来源聚合的错题索引。只统计已判定作答（待批不参与）；after_due
      // 未公布作业的作答整体不参与聚合（题目完全消失，防泄露对错）；题目内容
      // 来自已交卷快照；rounds/计数/归属单元随条目下发（攻克判定在端上算，
      // 服务端不下发规则）（assertNoLeak 放行 answers 后专项断言见
      // routes/student-wrong-questions.test.ts）
      .get("/wrong-questions", (c) => {
        // GET 无 JSON body：查询参数手工过契约 schema（stringbool 解析 "true"）
        const parsed = wrongQuestionsQuerySchema.safeParse({
          knowledge: c.req.query("knowledge") ?? undefined,
          includeResolved: c.req.query("includeResolved") ?? undefined,
        });
        if (!parsed.success) {
          const first = firstIssueMessage(parsed.error);
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            `查询参数不合法：${first}`,
          );
        }
        // now 显式注入（公布 gate 读时比较，截止后自动纳入该作业的作答）
        return c.json({
          ok: true,
          data: listWrongQuestions(
            db,
            c.var.student.id,
            parsed.data,
            new Date(),
          ),
        });
      })
      // 2026-10 错题重练组卷：范围由前端按错题本筛选口径圈定（questionIds 顺序
      // 即题序），服务端校验 + 快照冻结组卷（wrong-practice.ts，泄露口径与既有
      // 作答接口一致——响应只有 attempt 摘要，无任何题目内容；未交卷详情/试卷
      // 照旧走公开投影，泄露测试见 routes/student-wrong-practice.test.ts）
      .post("/wrong-practice", async (c) => {
        const body = await parseJsonBody(c, wrongPracticeRequestSchema);
        return c.json(
          {
            ok: true,
            data: startWrongPractice(db, c.var.student.id, body.questionIds),
          },
          201,
        );
      })
      // T2A.5：讲义详情带课程上下文（?courseId=，D22 访问判定）与本课配套练习（D8）
      .get("/lectures/:id", (c) => {
        const parsed = studentLectureDetailQuerySchema.safeParse({
          courseId: c.req.query("courseId") ?? undefined,
        });
        if (!parsed.success) {
          throw new HttpError(
            400,
            "VALIDATION_ERROR",
            "查询参数不合法：courseId 必须是 UUID 格式",
          );
        }
        return c.json({
          ok: true,
          data: getStudentLecture(
            db,
            c.var.student.id,
            c.req.param("id"),
            parsed.data.courseId,
          ),
        });
      })
      .post("/logout", (c) => {
        const token = getCookie(c, SESSION_COOKIE);
        if (token) {
          deleteSession(db, token);
        }
        // Cookie 属性与写入时保持一致（尤其 Path），否则浏览器删不掉
        deleteCookie(
          c,
          SESSION_COOKIE,
          sessionCookieOptions(isSecurePublicUrl(publicUrl)),
        );
        return c.json({ ok: true, data: null });
      })
  );
}
