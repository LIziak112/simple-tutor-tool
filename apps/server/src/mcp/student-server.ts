import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { studentMcpPracticeQuestionSubmitSchema } from "@tutor/contract";
import type { Db } from "../db/client";
import { submitPracticeQuestion } from "../services/attempt-service.ts";
import { listStudentMcpPractices } from "../services/student-mcp-practice-list.ts";
import {
  getStudentMcpPractice,
  getStudentMcpPracticeQuestion,
} from "../services/student-mcp-practice-read.ts";
import { registerStudentAiTaskTools } from "./student-ai-task-tools.ts";
import { registerStudentAttemptReviewTools } from "./student-attempt-review-tools.ts";
import { registerStudentLiveFocusTool } from "./student-live-focus-tool.ts";
import { registerStudentMemoTools } from "./student-memo-tools";
import { registerStudentPracticeTools } from "./student-practice-tools.ts";
import { registerStudentWrongPracticeTools } from "./student-wrong-practice-tools.ts";
import { AllowListMcpServer } from "./tool-allow-list";
import { guard, jsonContent } from "./tool-result";

export { AI_MCP_CLAIM_IMAGES_MAX_BYTES } from "./mcp-image-budget.ts";

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
  "get_current_context",
  "list_my_practices",
  "get_practice",
  "get_practice_question",
  "list_my_ai_tasks",
  "list_my_attempt_reviews",
  "list_my_wrong_questions",
  "renew_ai_lease",
  "renew_attempt_review_lease",
  "submit_ai_reply",
  "check_ai_reply",
  "submit_rubric_opinion",
  "submit_attempt_review_result",
  "student_submit_practice_question",
  // 模块 5 第一步随笔（student-memo-tools.ts）
  "list_my_memos",
  "add_memo",
  "get_memo_media",
] as const;

/** createStudentMcpServer 的依赖注入 */
export interface StudentMcpServerDeps {
  readonly db: Db;
  /** DATA_DIR（材料 PNG 字节读取） */
  readonly dataDir: string;
  readonly publicUrl: string;
  /** token 绑定的学生（全部工具以此域隔离；唯一身份来源是鉴权中间件） */
  readonly studentId: string;
  readonly connectionId?: string | undefined;
  /** 快照装配 HMAC 密钥（DATA_DIR/secret.key；整体复盘范围锚核对用） */
  readonly hmacSecret: string;
  readonly isAuthorized: () => boolean;
}

/**
 * 创建一台绑定单学生的 MCP 服务器实例（工具名单见 STUDENT_MCP_TOOL_NAMES）。
 * stateless 挂载下每个 HTTP 请求新建一个实例（注册开销可忽略，无跨请求状态）。
 */
export function createStudentMcpServer(
  deps: StudentMcpServerDeps & { readonly isAuthorized: () => boolean },
): McpServer {
  const server = new AllowListMcpServer(
    { name: STUDENT_MCP_SERVER_NAME, version: STUDENT_MCP_SERVER_VERSION },
    STUDENT_MCP_TOOL_NAMES,
    deps.isAuthorized,
  );
  registerStudentTools(server, deps);
  return server;
}

/**
 * 把全部学生工具注册到给定实例（模块 0 抽出：个人账号的 /mcp/personal 复用同一份
 * 注册，与教师白名单工具合并在一台实例上——工具定义单源）。
 */
export function registerStudentTools(
  server: McpServer,
  deps: StudentMcpServerDeps,
): void {
  const { db, dataDir, studentId } = deps;
  registerStudentMemoTools(server, { db, dataDir, studentId });
  registerStudentLiveFocusTool(server, db, studentId, deps.connectionId);

  registerStudentAiTaskTools(server, deps);
  registerStudentAttemptReviewTools(server, deps);
  registerStudentWrongPracticeTools(server, deps);
  registerStudentPracticeTools(server, {
    list: (input) => listStudentMcpPractices(db, studentId, input),
    practice: (input) => getStudentMcpPractice(db, studentId, input),
    question: (input) =>
      getStudentMcpPracticeQuestion(
        db,
        dataDir,
        studentId,
        input,
        deps.isAuthorized,
      ),
  });

  server.registerTool(
    "student_submit_practice_question",
    {
      description:
        "学生确认后提交一题。提交会锁定本题，最后一题会自动交卷。questionId 是 DSL 题号，questionRevisionId 是作答行 UUID。携带练习详情中的工作流版本、答案版本及笔记证据声明。可同时提供本次答案，省略则提交已保存的草稿。重试同一次提交须复用 submissionMutationId 和全部输入。",
      inputSchema: studentMcpPracticeQuestionSubmitSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    guard(({ practiceId, questionId, ...request }) => {
      submitPracticeQuestion(db, studentId, practiceId, questionId, request);
      return jsonContent({ success: true });
    }),
  );
}
