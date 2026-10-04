import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ANALYTICS_DAYS_DEFAULT,
  ANALYTICS_FOCUS_DAYS_DEFAULT,
  LEARNING_PACK_DAYS_DEFAULT,
} from "@tutor/contract";
import { z } from "zod";
import type { Db } from "../db/client";
import { HttpError } from "../lib/http-error";
import { getAnalyticsQuestions } from "../services/analytics-service";
import { listTeacherAssignments } from "../services/assignment-service";
import {
  analyzeImport,
  commitImport,
  previewImport,
  summarizeParsed,
} from "../services/content-service";
import { listCoursesForTeacher } from "../services/course-service";
import {
  assembleLearningPack,
  type LearningPackServiceOptions,
} from "../services/export-service";
import { exportLectureMd, exportUnitMd } from "../services/library-service";
import { saveMedia } from "../services/media-service";
import { createReport } from "../services/report-service";
import { listStudents } from "../services/student-service";
import { readSpecFile } from "../spec-files";

/**
 * MCP 工具注册（T4.6，D23 清单定稿 11 个 + 媒体管线第三单增补 upload_image）。
 *
 * 全部工具绑定 token 教师域（teacherId 来自鉴权中间件，不信任客户端入参）；
 * 返回统一用 SDK content 结构（text；JSON 数据序列化后作为文本——AI 阅读
 * JSON 与 Markdown 同样有效）；业务错误（HttpError）不抛裸异常给协议层，
 * 转结构化错误文本（isError + {error, message}），lint 错误清单原样透传
 * （复用 T2A「复制错误给 AI」的思想）。
 *
 * 红线：除 import_markdown(confirm=true)、save_report 与 upload_image
 * （图片内容寻址落盘 DATA_DIR，不写数据库）外无任何写操作；
 * 不提供任何删除类工具（D23）。
 */

/** MCP 服务器名称与版本（客户端可见；version 对齐项目主版本） */
export const MCP_SERVER_NAME = "simple-tutor-tool";
export const MCP_SERVER_VERSION = "2.0.0";

/** createMcpServer 的依赖注入 */
export interface McpServerDeps {
  readonly db: Db;
  /** DATA_DIR（learning-pack 装配的 ink 定位；默认模块集不含 ink，签名保持一致） */
  readonly dataDir: string;
  /** token 绑定的教师（全部查询以此域隔离） */
  readonly teacherId: string;
  /** DSL 规范目录覆盖（createApp options.specDir 透传；缺省按候选顺序解析） */
  readonly specDir?: string | undefined;
  /** learning-pack now 注入（测试确定性；默认当前时刻） */
  readonly now?: Date | string | undefined;
}

// ---------- 统一返回与错误结构 ----------

/** JSON 数据 → text content（2 空格缩进） */
function jsonContent(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** 纯文本 / 已是 JSON 文本的原文 → text content */
function textContent(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/** 业务错误 → 结构化错误文本（不抛裸异常给协议层；lint 错误清单原样透传） */
function errorContent(err: unknown): CallToolResult {
  if (err instanceof HttpError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: err.code, message: err.message, ...(err.extra ?? {}) },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { error: "INTERNAL", message: "服务器内部错误，请稍后重试" },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

/** 包装工具回调：异常统一转结构化错误文本（args 原样透传，保住 SDK 的类型推断） */
function guard<Args>(
  run: (args: Args) => CallToolResult | Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args): Promise<CallToolResult> => {
    try {
      return await run(args);
    } catch (err) {
      return errorContent(err);
    }
  };
}

// ---------- D14 模块勾选（get_student_learning_pack 参数对齐） ----------

/** AI 可覆盖的内容模块（与 learningPackModulesSchema 的可覆盖子集对齐） */
const packModulesOverrideSchema = z
  .object({
    /** 题目三层：stem=仅题干 / answer=+参考答案 / solution=+解析（默认 solution） */
    questions: z.enum(["stem", "answer", "solution"]).optional(),
    /** 逐题作答与判定（默认开） */
    responses: z.boolean().optional(),
    /** 历次作答汇总（默认开） */
    summaries: z.boolean().optional(),
    /** 每题派生指标与讲义阅读地图（默认开） */
    traces: z.boolean().optional(),
  })
  .optional();

/** get_student_learning_pack 的默认模块集（派单定稿）：题目三层全量 + 全部作答 + 痕迹 */
function packRequestDefaults() {
  return {
    modules: {
      lectures: [],
      questions: "solution" as const,
      responses: true,
      summaries: true,
      ink: false,
      traces: true,
    },
  };
}

// ---------- 工具注册 ----------

/**
 * 创建一台绑定单教师的 MCP 服务器实例（12 工具）。
 * stateless 挂载下每个 HTTP 请求新建一个实例（注册开销可忽略，无跨请求状态）。
 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const { db, dataDir, teacherId, specDir } = deps;
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });

  // 1. get_dsl_spec：DSL 规范 + 样例（复用 T1.13 spec 路由数据源）
  server.registerTool(
    "get_dsl_spec",
    {
      description:
        "获取内容 DSL v2 规范与完整样例。出题 / 写讲义前先读本工具，产出的 Markdown 必须遵守该规范（frontmatter、题目容器、七种题型语法）。",
      inputSchema: {},
    },
    guard(async () => {
      const rules = await readSpecFile("rules.md", specDir);
      const example = await readSpecFile("example.md", specDir);
      return {
        content: [
          {
            type: "text",
            text: `===== DSL 规范（规范.md）=====\n\n${rules.content}`,
          },
          {
            type: "text",
            text: `===== 完整样例（完整样例.md）=====\n\n${example.content}`,
          },
        ],
      };
    }),
  );

  // 2. lint_markdown：入参 markdown 文本 → lint 结果原样返回
  server.registerTool(
    "lint_markdown",
    {
      description:
        "校验一份内容 Markdown（练习 / 讲义 / 混合文档；v1 旧格式自动兼容转换），返回版本识别、解析摘要与全部 lint 问题（error/warning 级别、行列、错误码、中文说明）。生成内容后请先用本工具校验，有 error 再修正，通过后导入。",
      inputSchema: {
        markdown: z.string().min(1).describe("待校验的 Markdown 全文"),
      },
    },
    guard(({ markdown }) => {
      // 与导入预览同一份口径（analyzeImport：v1 兼容 + fallback 锚定 + lintDocument）
      const { version, issues, parsed } = analyzeImport(markdown, "mcp-import");
      return jsonContent({
        version,
        summary: summarizeParsed(parsed),
        issues,
      });
    }),
  );

  // 3. import_markdown：默认 dry-run（动作预览）；confirm:true 才写入教师资源库
  server.registerTool(
    "import_markdown",
    {
      description:
        "导入一份内容 Markdown 到当前教师的资源库。默认 dry-run：只返回动作预览（将创建/更新哪些讲义与练习单元、题目增改计数、lint 结果与警告），不写库；确认无误后带 confirm=true 再次调用才真正写入。",
      inputSchema: {
        markdown: z.string().min(1).describe("待导入的 Markdown 全文"),
        filename: z
          .string()
          .min(1)
          .optional()
          .describe(
            "留档文件名（缺省 mcp-import.md；frontmatter 未声明 unit 时用作单元名锚定）",
          ),
        confirm: z
          .boolean()
          .optional()
          .describe("默认 false（dry-run 不写库）；true 时真正写入"),
        folderId: z
          .string()
          .uuid()
          .nullable()
          .optional()
          .describe("目标资源库文件夹 id；null / 缺省 = 未归类"),
      },
      annotations: { destructiveHint: true },
    },
    guard(({ markdown, filename, confirm, folderId }) => {
      if (confirm === true) {
        // 复用既有导入服务：写 token 教师的资源库（域内匹配/落库/留档一体）
        const report = commitImport(db, teacherId, {
          markdown,
          filename: filename ?? "mcp-import.md",
          folderId: folderId ?? null,
        });
        return jsonContent({ confirmed: true, report });
      }
      const preview = previewImport(db, teacherId, {
        markdown,
        filename: filename ?? "mcp-import.md",
        folderId: folderId ?? null,
      });
      return jsonContent({
        confirmed: false,
        dryRun: true,
        preview,
      });
    }),
  );

  // 4. list_students：基本信息（id/姓名/归档标注/创建时间）
  server.registerTool(
    "list_students",
    {
      description:
        "列出当前教师的全部学生（id、姓名、登录名、是否归档、创建时间）。归档学生默认包含并带标注。",
      inputSchema: {
        includeArchived: z
          .boolean()
          .optional()
          .describe("是否包含已归档学生；默认 true"),
      },
      annotations: { readOnlyHint: true },
    },
    guard(({ includeArchived }) => {
      const { students: rows } = listStudents(
        db,
        teacherId,
        includeArchived ?? true,
      );
      return jsonContent({
        students: rows.map((s) => ({
          id: s.id,
          name: s.displayName,
          loginName: s.loginName,
          archived: s.archived,
          createdAt: s.createdAt,
        })),
      });
    }),
  );

  // 5. list_assignments：基本信息（id/标题/课程/截止/题数/名单数/软删标注）
  server.registerTool(
    "list_assignments",
    {
      description:
        "列出当前教师的作业（id、标题、所属课程、截止时间、题数、在册人数、是否已删除）。",
      inputSchema: {
        includeDeleted: z
          .boolean()
          .optional()
          .describe("是否包含已删除（软删）作业；默认 false"),
      },
      annotations: { readOnlyHint: true },
    },
    guard(({ includeDeleted }) => {
      const { assignments: rows } = listTeacherAssignments(db, teacherId, {
        includeDeleted: includeDeleted ?? false,
      });
      return jsonContent({
        assignments: rows.map((a) => ({
          id: a.id,
          title: a.title,
          courseName: a.courseName,
          dueAt: a.dueAt,
          questionCount: a.totalQuestionCount,
          studentCount: a.studentCount,
          deleted: a.deleted,
          createdAt: a.createdAt,
        })),
      });
    }),
  );

  // 6. list_courses：基本信息（AI 需要课程上下文，D23 增补）
  server.registerTool(
    "list_courses",
    {
      description:
        "列出当前教师的课程（id、课程名、简介、成员数、目录条目数）。用于确定学生所处课程与可用教学资源。",
      inputSchema: {
        includeArchived: z
          .boolean()
          .optional()
          .describe("是否包含已归档课程；默认 false"),
      },
      annotations: { readOnlyHint: true },
    },
    guard(({ includeArchived }) => {
      const rows = listCoursesForTeacher(db, teacherId, {
        archived: includeArchived ?? false,
      });
      return jsonContent({
        courses: rows.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          memberCount: c.memberCount,
          itemCount: c.itemCount,
          visibleItemCount: c.visibleItemCount,
        })),
      });
    }),
  );

  // 7. get_lecture：按 id 返回讲义 Markdown 原文（复用 T2A.2 export 逻辑）
  server.registerTool(
    "get_lecture",
    {
      description:
        "按讲义 id 返回可原样重新导入的 Markdown 原文（含 kind: lecture frontmatter）。非本教师的讲义返回「未找到」结构化结果（不暴露存在性）。",
      inputSchema: {
        id: z
          .string()
          .uuid()
          .describe("讲义 id（list_courses / 课程详情可见）"),
      },
      annotations: { readOnlyHint: true },
    },
    guard(({ id }) => {
      const { markdown, filename } = exportLectureMd(db, teacherId, id);
      return jsonContent({ found: true, filename, markdown });
    }),
  );

  // 8. get_unit：按 id 返回练习单元 Markdown 原文（复用 T2A.2 export 逻辑）
  server.registerTool(
    "get_unit",
    {
      description:
        "按练习单元 id 返回可原样重新导入的 Markdown 原文（含 frontmatter 与全部题目，含参考答案与解析——供教师侧 AI 使用）。非本教师的单元返回「未找到」结构化结果。",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("练习单元 id（来自 DSL 的 unit 标识，非 UUID）"),
      },
      annotations: { readOnlyHint: true },
    },
    guard(({ id }) => {
      const { markdown, filename } = exportUnitMd(db, teacherId, id);
      return jsonContent({ found: true, filename, markdown });
    }),
  );

  // 9. get_student_learning_pack：复用 T4.3 打包服务（默认模块集，D14 可覆盖）
  server.registerTool(
    "get_student_learning_pack",
    {
      description:
        "获取学情数据包（pack.json 全文）。默认包含：题目三层全量（题干+答案+解析）、全部历次作答与汇总、学习痕迹派生指标；默认不化名（MCP 为教师本人域调用）。可按模块覆盖勾选。范围内的学生/课程/作业不存在或不属于本教师时返回结构化错误。",
      inputSchema: {
        studentId: z
          .string()
          .uuid()
          .optional()
          .describe("聚焦单个学生（缺省 = 范围内全部学生）"),
        courseId: z.string().uuid().optional().describe("按课程筛选"),
        assignmentId: z.string().uuid().optional().describe("按作业筛选"),
        days: z
          .union([z.number().int().min(1).max(3650), z.literal("all")])
          .optional()
          .describe("时间范围天数（按交卷时间）；缺省 30，'all' 为全部"),
        goal: z
          .enum([
            "diagnose-weakness",
            "lesson-prep",
            "variant-practice",
            "period-summary",
          ])
          .optional()
          .describe(
            "任务目标（决定 pack 内 prompt 模板；缺省 diagnose-weakness）",
          ),
        anonymize: z
          .boolean()
          .optional()
          .describe("是否化名（学生A/学生B…）；默认 false（教师本人域调用）"),
        modules: packModulesOverrideSchema.describe(
          "内容模块覆盖（缺省全开：题目三层全量+作答+痕迹）",
        ),
      },
      annotations: { readOnlyHint: true },
    },
    guard(
      ({
        studentId,
        courseId,
        assignmentId,
        days,
        goal,
        anonymize,
        modules,
      }) => {
        const options: LearningPackServiceOptions =
          deps.now !== undefined ? { now: deps.now } : {};
        // 默认模块集（派单定稿）+ AI 覆盖浅合并；请求整体经契约 schema 终校验
        const base = packRequestDefaults();
        const assembly = assembleLearningPack(
          db,
          dataDir,
          teacherId,
          {
            scope: {
              ...(studentId !== undefined ? { studentIds: [studentId] } : {}),
              ...(courseId !== undefined ? { courseId } : {}),
              ...(assignmentId !== undefined ? { assignmentId } : {}),
              days: days ?? LEARNING_PACK_DAYS_DEFAULT,
            },
            modules: {
              ...base.modules,
              ...(modules?.questions !== undefined
                ? { questions: modules.questions }
                : {}),
              ...(modules?.responses !== undefined
                ? { responses: modules.responses }
                : {}),
              ...(modules?.summaries !== undefined
                ? { summaries: modules.summaries }
                : {}),
              ...(modules?.traces !== undefined
                ? { traces: modules.traces }
                : {}),
            },
            goal: goal ?? "diagnose-weakness",
            privacy: { anonymize: anonymize ?? false },
          },
          options,
        );
        // 返回 pack.json 原文（JSON 文本，供 AI 直接阅读；不再二次包一层 JSON）
        return textContent(assembly.packJson);
      },
    ),
  );

  // 10. get_question_stats：复用 T4.1 questions 接口口径
  server.registerTool(
    "get_question_stats",
    {
      description:
        "题目视角统计（T4.1 学情口径）：题目/考点正确率、平均用时、高频错误答案分布，支持课程筛选与时间范围。正确率以最终判定为准，待批题不计入分母。",
      inputSchema: {
        courseId: z.string().uuid().optional().describe("按课程筛选"),
        days: z
          .union([z.number().int().min(1).max(3650), z.literal("all")])
          .optional()
          .describe("时间范围天数；缺省 30，'all' 为全部"),
        focusDays: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("「下节课重点」周期天数；缺省 14"),
      },
      annotations: { readOnlyHint: true },
    },
    guard(({ courseId, days, focusDays }) => {
      const data = getAnalyticsQuestions(db, teacherId, {
        ...(courseId !== undefined ? { courseId } : {}),
        days: days ?? ANALYTICS_DAYS_DEFAULT,
        focusDays: focusDays ?? ANALYTICS_FOCUS_DAYS_DEFAULT,
      });
      return jsonContent(data);
    }),
  );

  // 11. save_report：写 reports 表（title/markdown/studentId）
  server.registerTool(
    "save_report",
    {
      description:
        "把学情报告保存回系统（供教师在学生画像页查看）。studentId 必须属于当前教师；标题与正文必填，正文为 Markdown。",
      inputSchema: {
        studentId: z.string().uuid().describe("学生 id"),
        title: z.string().trim().min(1).max(200).describe("报告标题"),
        markdown: z
          .string()
          .min(1)
          .max(1_000_000)
          .describe("报告正文（Markdown）"),
      },
      annotations: { destructiveHint: false },
    },
    guard(({ studentId, title, markdown }) => {
      const report = createReport(
        db,
        teacherId,
        { studentId, title, markdown },
        "mcp",
      );
      return jsonContent({ saved: true, report });
    }),
  );

  // 12. upload_image：base64 图片字节 → saveMedia 内容寻址落盘 → ::image 的 src
  server.registerTool(
    "upload_image",
    {
      description:
        "上传一张图片供 ::image 指令引用（PNG/JPG/WEBP/GIF，≤5MB）。入参为图片字节的 base64 编码；成功返回 { src, bytes }，在 ::image 指令的 src 属性使用该路径即可。内容寻址幂等：同一张图重复上传返回相同 src。",
      inputSchema: {
        dataBase64: z
          .string()
          .min(1)
          .describe(
            "图片字节的 base64 编码（标准字母表 A-Z a-z 0-9 + / 与 = 填充，可含换行空白）",
          ),
        filename: z
          .string()
          .min(1)
          .optional()
          .describe("文件名（可选，仅用于错误提示定位）"),
      },
      // 写操作但非破坏性：只新增 blobs/media 内容寻址文件，不覆盖不删除
      annotations: { destructiveHint: false },
    },
    guard(({ dataBase64, filename }) => {
      const nameHint = filename !== undefined ? `「${filename}」` : "图片";
      // 容忍传输层折行（长 base64 常被换行），剥离空白后整体校验标准形态；
      // url-safe（-/_）等其他编码不给静默误解码，直接中文报错指导重新编码
      const compact = dataBase64.replace(/\s+/g, "");
      if (
        compact.length === 0 ||
        compact.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)
      ) {
        throw new HttpError(
          400,
          "INVALID_BASE64",
          `${nameHint}的 dataBase64 不是合法 base64（需标准字母表 A-Z a-z 0-9 + / 与至多两个 = 填充），请重新编码后重试`,
        );
      }
      const bytes = new Uint8Array(Buffer.from(compact, "base64"));
      // saveMedia：魔数白名单外 415、超 5MB 413（HttpError 经 guard 转结构化错误）
      const result = saveMedia(dataDir, bytes);
      return jsonContent({
        ...result,
        usage: `在 ::image 指令的 src 属性使用该路径，如 ::image{src="${result.src}" alt="图示"}`,
      });
    }),
  );

  return server;
}
