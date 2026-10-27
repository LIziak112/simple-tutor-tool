import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AI_REPLY_MAX_CHARS,
  aiAttemptReviewStatusSchema,
  aiTaskStatusSchema,
} from "@tutor/contract";
import { z } from "zod";
import type { Db } from "../db/client";
import { HttpError } from "../lib/http-error";
import {
  claimAttemptReviewTask,
  listAttemptReviewTasks,
  renewAttemptReviewLease,
  submitAttemptReviewResult,
} from "../services/ai-companion/student-ai-attempt-review.ts";
import {
  collectAiTaskMaterialBytes,
  taskOf,
} from "../services/ai-companion/student-ai-materials.ts";
import {
  claimMcpTask,
  listStudentAiTasks,
  renewMcpLease,
  submitMcpReply,
} from "../services/ai-companion/student-ai-queue.ts";
import { outboundAssemblyOfTask } from "../services/ai-companion/student-ai-worker.ts";
import { startWrongPractice } from "../services/wrong-practice.ts";
import { listWrongQuestions } from "../services/wrong-questions.ts";
import { guard, jsonContent } from "./server.js";

/**
 * 学生 MCP 工具实例（SAI-25 骨架 / SAI-26 四类任务工具，B00 §4.3 工具名）。
 *
 * 与教师 server.ts **独立构建**（B14 执行步骤 3）：不把教师 14 工具全部
 * 注册后仅在 tools/list 隐藏，而是从零构造只属于学生的 McpServer——教师
 * 工具在本实例结构上不存在，伪造 tools/call 也无法调用（协议层 Unknown
 * tool）。学生身份（studentId）只来自鉴权中间件注入的 deps，全部工具闭包
 * 固定该域；调用参数自报 studentId 一律无效。
 *
 * 四类工具全部走 SAI-12（队列）/ SAI-09（上下文）/ SAI-11（材料）既有服务层
 * ——与页面接口执行同一规则，MCP 层不直接更新数据库：
 * 1. list_my_ai_tasks：只读列表（本人任务元信息 + 游标分页，无领取/已读副作用）；
 * 2. claim_ai_task：领取（claim 幂等语义 = 指定 taskId 重放 409 不改抢；
 *    上限 = 域内 FIFO 扫描 + 同题/待处理/当日配额在服务层）——逐任务实时
 *    裁决当前模式并重装配提示词（SAI-12 rearm），装配固定材料（任务行冻结
 *    快照 + 本人材料 PNG），返回 lease/generation/contextVersion 与图像，
 *    不返回其他题/账号；
 * 3. renew_ai_lease：续租（仅当前有效 lease 持有者，累计上限 60min）；
 * 4. submit_ai_reply：回信写回（校验 taskId/leaseToken/contextVersion，
 *    内容 sha-256 幂等，超长按契约截断并声明；迟到回执仅记事实）。
 *
 * Prompt（工具 description）仅辅助客户端/用户操作，不构成后台调度授权；
 * 本服务器无任何定时/轮询机制——外部客户端主动领取才推进任务。
 *
 * 错题组卷两工具（2026-10 错题本迭代）同样只走既有服务层（wrong-questions /
 * wrong-practice，与页面接口同一规则）：list_my_wrong_questions 只读（脱敏
 * 摘录，无答案/详解/本人答案——不是受控 AI 出口）；create_wrong_practice
 * 非幂等建卷，AI 侧须先与学生确认。
 */
export const STUDENT_MCP_SERVER_NAME = "simple-tutor-tool-student";
export const STUDENT_MCP_SERVER_VERSION = "2.0.0";

/**
 * 学生 MCP 工具名单唯一清单（2026-10 评审修复：此前在服务端测试 ×2、e2e、
 * B19 冒烟脚本四处手工拷贝，本批工具扩充时冒烟脚本漏更即漂移）。新增工具时
 * 只改这里与注册处；各断言方 import 本常量。
 */
export const STUDENT_MCP_TOOL_NAMES = [
  "claim_ai_task",
  "claim_attempt_review",
  "create_wrong_practice",
  "list_my_ai_tasks",
  "list_my_attempt_reviews",
  "list_my_wrong_questions",
  "renew_ai_lease",
  "renew_attempt_review_lease",
  "submit_ai_reply",
  "submit_attempt_review_result",
] as const;

/**
 * 领取附图的字节预算（原始 PNG 字节合计；base64 膨胀 ×4/3 后约 5.3MiB）：
 * 超限不静默丢页——结构化 AI_MATERIAL_TOO_LARGE 并附租约信息，客户端可
 * 仅文字写回（includeImages=false 下次领取）或放任租约过期。
 */
export const AI_MCP_CLAIM_IMAGES_MAX_BYTES = 4 * 1024 * 1024;

/** 回信入参上限（字符）：契约截断阈值 32KiB 之上留余量，再大直接形状拒绝 */
const REPLY_INPUT_MAX_CHARS = 40_000;

/**
 * 错题列表题干摘录上限（字符）：list_my_wrong_questions 只给 AI 挑题用的
 * 短摘录（stemMd 已是 studentStemMd 脱敏投影），全文让学生在错题本/答题页看
 */
const WRONG_STEM_EXCERPT_MAX_CHARS = 200;

/**
 * stemMd（已脱敏）→ 单行短摘录：压缩空白后截断加省略号。按码点（[...str]）
 * 截断——评审修复：此前按 UTF-16 码元 slice，边界落在代理对（emoji 等）中间
 * 会产生孤立代理项，摘录末尾乱码。
 */
function stemExcerptOf(stemMd: string): string {
  const compact = stemMd.replace(/\s+/g, " ").trim();
  const chars = [...compact];
  return chars.length <= WRONG_STEM_EXCERPT_MAX_CHARS
    ? compact
    : `${chars.slice(0, WRONG_STEM_EXCERPT_MAX_CHARS).join("")}…`;
}

/** createStudentMcpServer 的依赖注入 */
export interface StudentMcpServerDeps {
  readonly db: Db;
  /** DATA_DIR（材料 PNG 字节读取） */
  readonly dataDir: string;
  /** token 绑定的学生（全部工具以此域隔离；唯一身份来源是鉴权中间件） */
  readonly studentId: string;
  /** 快照装配 HMAC 密钥（DATA_DIR/secret.key；整体复盘范围锚核对用） */
  readonly hmacSecret: string;
}

/**
 * 创建一台绑定单学生的 MCP 服务器实例（四工具）。
 * stateless 挂载下每个 HTTP 请求新建一个实例（注册开销可忽略，无跨请求状态）。
 */
export function createStudentMcpServer(deps: StudentMcpServerDeps): McpServer {
  const { db, dataDir, studentId, hmacSecret } = deps;
  const server = new McpServer({
    name: STUDENT_MCP_SERVER_NAME,
    version: STUDENT_MCP_SERVER_VERSION,
  });

  // 1. list_my_ai_tasks：只读列表（无领取/已读副作用）
  server.registerTool(
    "list_my_ai_tasks",
    {
      description:
        "列出当前学生的 AI 求助任务（元信息：状态、通道、创建时间、上下文版本、是否已有回信等），游标分页。只读：不领取任务、不标记已读。可用 status 过滤（created=待领取、claimed=处理中、replied=已回信等）。",
      inputSchema: {
        status: aiTaskStatusSchema
          .optional()
          .describe("按状态过滤；缺省 = 全部"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("每页条数，缺省 20"),
        cursor: z
          .string()
          .optional()
          .describe("上一页返回的 nextCursor；缺省首页"),
      },
      annotations: { readOnlyHint: true },
    },
    guard(({ status, limit, cursor }) => {
      const result = listStudentAiTasks(db, {
        studentId,
        ...(status !== undefined ? { status } : {}),
        limit: limit ?? 20,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      return jsonContent(result);
    }),
  );

  // 2. claim_ai_task：领取（幂等/上限/逐任务模式裁决/固定材料装配）
  server.registerTool(
    "claim_ai_task",
    {
      description:
        "领取一个 AI 求助任务：缺省按创建时间领取下一个待领取任务（无任务返回 claimed:false）；携带 taskId = 指定领取（重放已领取任务 → 409，不改抢其他任务）。领取即出站：按当前教学模式实时裁决并重装配提示词（提交后的待处理任务按复盘尺度），返回租约（leaseToken/leaseUntil）、generation、contextVersion、完整出站消息（system + 数据段 + 历史 + 学生诉求）与材料图像。图像为 PNG base64（SDK image content）；材料合计超限将显式报 AI_MATERIAL_TOO_LARGE（租约信息随错误交付，可仅文字写回）。不支持识图的客户端可传 includeImages=false 显式不附图。写回用 submit_ai_reply，长处理用 renew_ai_lease 续租。",
      inputSchema: {
        taskId: z
          .string()
          .uuid()
          .optional()
          .describe("指定领取的任务 id；缺省 = 按创建时间领取下一个"),
        includeImages: z
          .boolean()
          .optional()
          .describe("是否随领取返回材料图像（默认 true）；false = 显式仅文字"),
      },
    },
    guard(async ({ taskId, includeImages }) => {
      const claimed = claimMcpTask(db, {
        studentId,
        ...(taskId !== undefined ? { taskId } : {}),
      });
      if (claimed === null) {
        return jsonContent({
          claimed: false,
          message: "当前没有可领取的任务",
        });
      }
      const task = taskOf(db, claimed.taskId);
      if (task === undefined) {
        throw new HttpError(
          500,
          "AI_CONTEXT_BROKEN",
          "领取的任务行缺失，请稍后重试",
        );
      }
      // 装配（领取事务外；快照损坏 → AI_CONTEXT_BROKEN 不伪造题面）
      const assembly = outboundAssemblyOfTask(db, task);
      const base = {
        claimed: true as const,
        taskId: claimed.taskId,
        attemptId: task.attemptId,
        questionId: task.questionId,
        modeAtSend: task.modeAtSend,
        beforeSubmit: task.beforeSubmit,
        leaseToken: claimed.leaseToken,
        leaseUntil: claimed.leaseUntil,
        generation: claimed.generation,
        contextVersion: claimed.contextVersion,
        runtimeEpoch: claimed.runtimeEpoch,
        systemPromptMd: assembly.systemPromptMd,
        contextDataMd: assembly.contextDataMd,
        messages: assembly.messages,
      };
      if (includeImages === false) {
        return jsonContent({ ...base, imagesIncluded: false, materials: [] });
      }
      // 材料字节：缺件按 AI_MATERIAL_BROKEN 报错（不虚报已附图）；超限显式
      // 拒绝但不静默丢页——租约信息随错误交付，客户端可仅文字写回
      const collected = collectAiTaskMaterialBytes(db, dataDir, claimed.taskId);
      const totalBytes = collected.reduce(
        (sum, item) => sum + item.row.byteSize,
        0,
      );
      if (totalBytes > AI_MCP_CLAIM_IMAGES_MAX_BYTES) {
        throw new HttpError(
          413,
          "AI_MATERIAL_TOO_LARGE",
          `材料图像合计 ${totalBytes} 字节，超过单次领取附图上限 ${AI_MCP_CLAIM_IMAGES_MAX_BYTES} 字节（base64 膨胀后报文受限）；任务已领取，可凭租约仅文字写回，或放任租约过期由学生重新发起`,
          {
            ...base,
            materials: collected.map((item) => ({
              kind: item.row.kind,
              pageIndex: item.row.pageIndex,
              byteSize: item.row.byteSize,
            })),
          },
        );
      }
      const text = jsonContent({
        ...base,
        imagesIncluded: true,
        materials: collected.map((item) => ({
          kind: item.row.kind,
          pageIndex: item.row.pageIndex,
          byteSize: item.row.byteSize,
        })),
      });
      // 图像按 SDK 真实 content 结构追加（顺序与 materials 元信息一致）
      return {
        content: [
          ...text.content,
          ...collected.map((item) => ({
            type: "image" as const,
            data: Buffer.from(item.bytes).toString("base64"),
            mimeType: "image/png" as const,
          })),
        ],
      };
    }),
  );

  // 3. renew_ai_lease：续租（仅当前有效 lease 持有者）
  server.registerTool(
    "renew_ai_lease",
    {
      description:
        "续租当前持有的任务租约（每次 +10 分钟，累计上限 60 分钟）。只对 claim_ai_task 返回的未过期 leaseToken 有效；租约已过期或不是当前持有者 → 409。",
      inputSchema: {
        taskId: z.string().uuid().describe("claim_ai_task 返回的任务 id"),
        leaseToken: z.string().min(1).describe("claim_ai_task 返回的租约凭证"),
      },
    },
    guard(({ taskId, leaseToken }) => {
      const { leaseUntil } = renewMcpLease(db, {
        studentId,
        taskId,
        leaseToken,
      });
      return jsonContent({ renewed: true, taskId, leaseUntil });
    }),
  );

  // 4. submit_ai_reply：回信写回（沿共享写回逻辑，不直写库）
  server.registerTool(
    "submit_ai_reply",
    {
      description:
        "把 AI 回信写回平台（学生在伴学栏查看）。校验任务归属与租约：leaseToken 必须是当前有效持有者；contextVersion/runtimeEpoch 与领取时不一致 → 409（迟到回执仅记事实，不覆盖首次成功）。同内容重放幂等成功（duplicate:true）；正文超过平台上限将被截断并在 truncated:true 声明。正文用 Markdown。",
      inputSchema: {
        taskId: z.string().uuid().describe("claim_ai_task 返回的任务 id"),
        leaseToken: z.string().min(1).describe("claim_ai_task 返回的租约凭证"),
        replyMarkdown: z
          .string()
          .min(1)
          .max(REPLY_INPUT_MAX_CHARS)
          .describe("回信正文（Markdown）"),
        contextVersion: z
          .string()
          .optional()
          .describe(
            "领取时返回的 contextVersion（推荐携带，旧上下文回执将被拒绝）",
          ),
        runtimeEpoch: z
          .string()
          .optional()
          .describe("领取时返回的 runtimeEpoch（推荐携带）"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guard(
      ({ taskId, leaseToken, replyMarkdown, contextVersion, runtimeEpoch }) => {
        // 超长由服务层按契约单源截断（truncated:true 声明），MCP 层不提前截断
        const result = submitMcpReply(db, {
          studentId,
          taskId,
          leaseToken,
          replyMarkdown,
          ...(contextVersion !== undefined
            ? { expectedContextVersion: contextVersion }
            : {}),
          ...(runtimeEpoch !== undefined
            ? { expectedRuntimeEpoch: runtimeEpoch }
            : {}),
        });
        return jsonContent({
          submitted: true,
          taskId,
          duplicate: result.duplicate,
          truncated: result.truncated,
          maxChars: AI_REPLY_MAX_CHARS,
        });
      },
    ),
  );

  // 5. list_my_attempt_reviews：整体复盘任务只读列表（独立任务类型，不与
  //    逐题任务混排；领取/写回用下列专属工具）
  server.registerTool(
    "list_my_attempt_reviews",
    {
      description:
        "列出当前学生的「本次练习整体复盘」任务（元信息：状态、覆盖题数、创建时间），游标分页。只读：不领取任务。整体复盘是独立任务类型：一个 attempt 一份整体上下文，与逐题求助任务互不混排。",
      inputSchema: {
        status: aiAttemptReviewStatusSchema
          .optional()
          .describe("按状态过滤；缺省 = 全部"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("每页条数，缺省 20"),
        cursor: z
          .string()
          .optional()
          .describe("上一页返回的 nextCursor；缺省首页"),
      },
      annotations: { readOnlyHint: true },
    },
    guard(({ status, limit, cursor }) => {
      const result = listAttemptReviewTasks(db, {
        studentId,
        ...(status !== undefined ? { status } : {}),
        limit: limit ?? 20,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      return jsonContent({
        tasks: result.tasks.map((task) => ({
          taskId: task.id,
          attemptId: task.attemptId,
          status: task.status,
          questionCount: task.questionCount,
          createdAt: task.createdAt,
        })),
      });
    }),
  );

  // 6. claim_attempt_review：领取整体复盘任务（领取即出站：整体快照+提示词+租约）
  server.registerTool(
    "claim_attempt_review",
    {
      description:
        "领取一个「本次练习整体复盘」任务：缺省按创建时间领取下一个待领取任务（无任务返回 claimed:false）；携带 taskId = 指定领取（范围或授权已变化 → 409，任务转为暂停，不悄悄改抢）。领取即出站：返回本次练习的整体快照（每题题面、作答状态、参考答案与解析、统计）、固定分析提示词与租约。按提示词产出约定 JSON 报告后用 submit_attempt_review_result 写回；长处理用 renew_attempt_review_lease 续租。",
      inputSchema: {
        taskId: z
          .string()
          .uuid()
          .optional()
          .describe("指定领取的任务 id；缺省 = 按创建时间领取下一个"),
      },
    },
    guard(({ taskId }) => {
      const claimed = claimAttemptReviewTask(
        db,
        { studentId, ...(taskId !== undefined ? { taskId } : {}) },
        { hmacSecret },
      );
      if (claimed === null) {
        return jsonContent({
          claimed: false,
          message: "当前没有可领取的整体复盘任务",
        });
      }
      return jsonContent({ claimed: true, ...claimed });
    }),
  );

  // 7. renew_attempt_review_lease：续租（仅当前有效租约持有者）
  server.registerTool(
    "renew_attempt_review_lease",
    {
      description:
        "续租当前持有的整体复盘任务租约（每次 +10 分钟，累计上限 60 分钟）。只对 claim_attempt_review 返回的未过期 leaseToken 有效；过期或非当前持有者 → 409。",
      inputSchema: {
        taskId: z
          .string()
          .uuid()
          .describe("claim_attempt_review 返回的任务 id"),
        leaseToken: z
          .string()
          .min(1)
          .describe("claim_attempt_review 返回的租约凭证"),
      },
    },
    guard(({ taskId, leaseToken }) => {
      const { leaseUntil } = renewAttemptReviewLease(
        db,
        { studentId, taskId, leaseToken },
        { hmacSecret },
      );
      return jsonContent({ renewed: true, taskId, leaseUntil });
    }),
  );

  // 8. submit_attempt_review_result：整体复盘报告写回（strict 校验+证据复核在服务层）
  server.registerTool(
    "submit_attempt_review_result",
    {
      description:
        "把整体复盘的结构化 JSON 报告写回平台。校验任务归属与租约：leaseToken 必须是当前有效持有者，generation/snapshotVersion 与领取时不一致 → 409（迟到报告仅记事实，不覆盖）。同内容重放幂等成功（duplicate:true）；报告超 32KiB 或引用范围外题号将被拒绝。结构见领取视图的提示词说明。",
      inputSchema: {
        taskId: z
          .string()
          .uuid()
          .describe("claim_attempt_review 返回的任务 id"),
        leaseToken: z
          .string()
          .min(1)
          .describe("claim_attempt_review 返回的租约凭证"),
        generation: z
          .number()
          .int()
          .min(1)
          .describe("claim_attempt_review 返回的出站代次"),
        snapshotVersion: z
          .string()
          .min(1)
          .describe("claim_attempt_review 返回的快照版本"),
        report: z
          .record(z.string(), z.unknown())
          .describe("结构化报告对象（结构见领取提示词；服务端 strict 校验）"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    guard(({ taskId, leaseToken, generation, snapshotVersion, report }) => {
      const result = submitAttemptReviewResult(
        db,
        {
          studentId,
          taskId,
          leaseToken,
          generation,
          snapshotVersion,
          report,
        },
        { hmacSecret },
      );
      return jsonContent({
        submitted: true as const,
        taskId,
        duplicate: result.duplicate,
      });
    }),
  );

  // 9. list_my_wrong_questions：错题本只读列表（2026-10 AI 组卷配套；只给
  //    组卷决策所需的元数据 + 脱敏题干摘录，不下发答案/详解/本人答案——
  //    AGENTS 第 3/4 条：本工具不是受控 AI 出口，不得携带 answers/solutionMd/
  //    answerText；题面走与页面错题本同一份 studentStemMd 投影后的 stemMd
  //    截断，绝不回填 live 题库内容）
  server.registerTool(
    "list_my_wrong_questions",
    {
      description:
        "列出当前学生的错题本（只读，供挑选题目组卷）：每题含题型、难度、考点、错/对次数、轮次数、待批轮数、最近一轮是否做对、是否已攻克（服务端口径=最近一轮做对且未标「不会」；学生设备上更严格的「连续 2 次做对」标准可能把更多题算作待复习）、归属练习、来源课程、首错/最近判定时间与脱敏题干摘录（不含答案与解析）。筛选：knowledge=考点精确匹配任一考点；courseId=任一轮发生在该课程；sinceDays=最近 N 个自然日（含今天，Asia/Shanghai）内有判定，与学生端「最近 N 天」筛选同一口径；includeConquered=是否包含已攻克（默认 false 只列待复习）。取数：limit=截取前 N 条（默认 100，total 仍为筛选后总数）+ offset=翻页偏移——错题超过 limit 上限时（如 total=350）用 offset 逐步取后续题，最久未判定的题在尾部，别漏掉它们。挑好题后用 create_wrong_practice 组卷。",
      inputSchema: {
        knowledge: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .optional()
          .describe("考点精确匹配（题目任一考点命中即保留；首尾空格归一）"),
        courseId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "只保留任一轮发生在该课程的题（错题重练轮无课程不参与命中）",
          ),
        sinceDays: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe(
            "只保留最近 N 个自然日（含今天，Asia/Shanghai）内有判定的题（按最近判定时间；与学生端「最近 N 天」筛选同一口径）",
          ),
        includeConquered: z
          .boolean()
          .optional()
          .describe("是否包含已攻克的题（默认 false 只列待复习）"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("截取前 N 条（默认 100；total 为筛选后总数）"),
        offset: z
          .number()
          .int()
          .min(0)
          .max(100_000)
          .optional()
          .describe(
            "翻页偏移（0 起，配合 limit 使用；错题超过 limit 上限时用 offset 逐步取后续题，total 为全集数）",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    guard(
      ({ knowledge, courseId, sinceDays, includeConquered, limit, offset }) => {
        // 全部筛选走服务层单源谓词（与页面接口同一出处；courseId/sinceDays 为
        // 2026-10 评审修复下沉——此前在 MCP 层内存过滤且 sinceDays 用滚动窗口，
        // 与页面自然日口径分叉）；limit/offset 是展示层截取，留在本层
        const cards = listWrongQuestions(
          db,
          studentId,
          {
            includeResolved: includeConquered === true,
            ...(knowledge !== undefined ? { knowledge } : {}),
          },
          new Date(),
          {
            ...(courseId !== undefined ? { courseId } : {}),
            ...(sinceDays !== undefined ? { sinceDays } : {}),
          },
        ).questions;
        const start = offset ?? 0;
        const questions = cards
          .slice(start, start + (limit ?? 100))
          .map((card) => ({
            questionId: card.questionId,
            type: card.type,
            difficulty: card.difficulty,
            knowledge: card.knowledge,
            stemExcerpt: stemExcerptOf(card.stemMd),
            wrongCount: card.wrongCount,
            correctCount: card.correctCount,
            roundCount: card.rounds.length,
            pendingCount: card.pendingCount,
            lastCorrect: card.rounds.at(-1)?.correct ?? null,
            resolved: card.resolved,
            originUnitId: card.originUnitId,
            originUnitTitle: card.originUnitTitle,
            courseNames: [
              ...new Set(
                card.rounds.flatMap((round) =>
                  round.courseName !== null ? [round.courseName] : [],
                ),
              ),
            ],
            firstAt: card.firstAt,
            lastAt: card.lastAt,
          }));
        return jsonContent({ total: cards.length, questions });
      },
    ),
  );

  // 10. create_wrong_practice：AI 组卷（2026-10）——走 wrong-practice 服务层
  //     （与页面 POST /wrong-practice 同一校验与快照冻结：∉ 本人错题本聚合的题
  //     静默剔除、剔完为空 400 WRONG_PRACTICE_EMPTY；建卷只复制题目快照，响应
  //     不携带任何题目内容）。**非幂等**：每次调用新建一份独立练习卷，MCP 层
  //     不做去重——由 AI 侧在调用前与学生确认
  server.registerTool(
    "create_wrong_practice",
    {
      description:
        "把选定的错题组成一份新的错题重练卷（AI 组卷），学生可在「我的记录」或返回的链接开始作答。题目必须属于当前学生的错题本：不在聚合内的题会被静默剔除并在 excludedCount 说明，全部无效返回 400 WRONG_PRACTICE_EMPTY。注意：非幂等——每次调用都会新建一份独立练习卷，请先与学生确认选题再调用。label 是随卷快照的组卷说明（如「最近一周 · 错 2 次以上 · 10 题」），会展示在卷标题「错题重练 · 第 n 次 · label」中；缺省为「AI 组卷」。",
      inputSchema: {
        questionIds: z
          .array(z.string().min(1))
          .min(1, "至少选择一道错题")
          .max(200, "一次组卷最多 200 题")
          .describe(
            "题目 id 列表（来自 list_my_wrong_questions；顺序即组卷题序）",
          ),
        label: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe("组卷说明（随卷快照展示「练的是什么」；缺省「AI 组卷」）"),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    guard(({ questionIds, label }) => {
      const scopeLabel = label ?? "AI 组卷";
      const { attempt, includedCount } = startWrongPractice(
        db,
        studentId,
        questionIds,
        // 与页面建卷同一新协议起点（评审修复：此前传 {} 恒落旧协议列，同一学生
        // 两个入口建卷行为分叉）。学生设备偏好服务端无从得知——不传
        // feedbackMode，由教师策略/缺省档裁决
        { workflowVersion: 1 },
        {
          kind: "ai",
          label: scopeLabel,
        },
      );
      // 剔除计数：服务层返回实际冻结题数 vs 去重后的入参数（已静默剔除）
      return jsonContent({
        created: true,
        attemptId: attempt.id,
        attemptUrl: `/s/attempts/${attempt.id}`,
        attemptNo: attempt.attemptNo,
        label: scopeLabel,
        includedCount,
        excludedCount: new Set(questionIds).size - includedCount,
      });
    }),
  );

  return server;
}
