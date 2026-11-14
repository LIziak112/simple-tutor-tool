import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createOperationIdSchema } from "@tutor/contract";
import { z } from "zod";
import { startWrongPractice } from "../services/wrong-practice.ts";
import { listWrongQuestions } from "../services/wrong-questions.ts";
import type { StudentMcpServerDeps } from "./student-server.ts";
import { guard, jsonContent } from "./tool-result";

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

/** 错题筛选与确认后组卷；复用页面同一业务服务。 */
export function registerStudentWrongPracticeTools(
  server: McpServer,
  deps: StudentMcpServerDeps,
): void {
  const { db, studentId } = deps;
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
  //     不携带任何题目内容）。确认后分配操作标识，响应丢失时复用。
  server.registerTool(
    "create_wrong_practice",
    {
      description:
        "把选定的错题组成一份新的错题重练卷（AI 组卷），学生可在「我的记录」或返回的链接开始作答。不属于当前学生错题本的题会被剔除，全部无效返回 WRONG_PRACTICE_EMPTY。请先与学生确认，再生成 operationId；同一操作重试沿用它。label 随卷保存，缺省为「AI 组卷」。",
      inputSchema: {
        operationId: createOperationIdSchema.optional(),
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
    guard(({ questionIds, label, operationId }) => {
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
        operationId,
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
}
