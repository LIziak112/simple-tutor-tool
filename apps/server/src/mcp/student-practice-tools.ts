import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type StudentMcpPracticeData,
  type StudentMcpPracticeListData,
  type StudentMcpPracticeListInput,
  type StudentMcpPracticeQuestionData,
  type StudentMcpPracticeQuestionReadInput,
  type StudentMcpPracticeReadInput,
  studentMcpPracticeDataSchema,
  studentMcpPracticeListDataSchema,
  studentMcpPracticeListInputSchema,
  studentMcpPracticeQuestionDataSchema,
  studentMcpPracticeQuestionReadInputSchema,
  studentMcpPracticeReadInputSchema,
} from "@tutor/contract";
import { HttpError } from "../lib/http-error.ts";
import { assertMemoMetadataBudget } from "../services/memo-budget.ts";
import type { collectStudentPracticeImages } from "./student-practice-images.ts";
import { guard, jsonContent } from "./tool-result.ts";

/** 身份固定在调用方闭包；canonical服务的依赖由业务适配装配，不由工具请求提供。 */
export interface StudentPracticeReads {
  list(input: StudentMcpPracticeListInput): StudentMcpPracticeListData;
  practice(input: StudentMcpPracticeReadInput): StudentMcpPracticeData;
  question(input: StudentMcpPracticeQuestionReadInput):
    | {
        data: StudentMcpPracticeQuestionData;
        content: Awaited<
          ReturnType<typeof collectStudentPracticeImages>
        >["content"];
      }
    | Promise<{
        data: StudentMcpPracticeQuestionData;
        content: Awaited<
          ReturnType<typeof collectStudentPracticeImages>
        >["content"];
      }>;
}

/** 新普通读出口不透传任意错误extra；只附图片预算的公开数字。 */
function publicRead<Args>(
  run: (input: Args) => CallToolResult | Promise<CallToolResult>,
) {
  return guard(async (input: Args) => {
    try {
      assertMemoMetadataBudget({ context: input });
      return await run(input);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      const extra =
        error.code === "AI_MATERIAL_TOO_LARGE" &&
        typeof error.extra?.totalBytes === "number" &&
        typeof error.extra?.maxBytes === "number"
          ? {
              totalBytes: error.extra.totalBytes,
              maxBytes: error.extra.maxBytes,
            }
          : undefined;
      throw new HttpError(error.status, error.code, error.message, extra);
    }
  });
}

/** 三个普通公开读工具；输出在协议边界再次校验，不混用任务领取的答案例外。 */
export function registerStudentPracticeTools(
  server: McpServer,
  reads: StudentPracticeReads,
): void {
  server.registerTool(
    "list_my_practices",
    {
      description:
        "列出本人练习的公开元数据、现有状态和进度，按最近活动排序；不包含题面、答案、成绩或判定。可列出不代表允许AI读题或提交，读取具体练习仍会实时检查权限。仅浏览产生的草稿沿现有记录口径保留。",
      inputSchema: studentMcpPracticeListInputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    publicRead((input: StudentMcpPracticeListInput) =>
      jsonContent(studentMcpPracticeListDataSchema.parse(reads.list(input))),
    ),
  );
  server.registerTool(
    "get_practice",
    {
      description:
        "读取本人一份练习的公开题目目录：题序、题目id、冻结版本、公开题干摘录和已答/已提交状态。整份目录逐题实时检查AI权限，任一题不可读则整次拒绝，不附参考答案、解析、本人答案或判定。",
      inputSchema: studentMcpPracticeReadInputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    publicRead((input: StudentMcpPracticeReadInput) =>
      jsonContent(studentMcpPracticeDataSchema.parse(reads.practice(input))),
    ),
  );
  server.registerTool(
    "get_practice_question",
    {
      description:
        "按题目id或本卷题序读取本人一道题的公开题面、冻结材料、本人已保存答案与规范上下文；两种定位都给时必须一致。参考答案、解析和未解锁提示不在本工具授权内。返回可用时的真实工作流/题目/答案版本和已保存笔记证据参数；学生确认题号、答案与冻结稿件后，另生成submissionMutationId调用原提交工具，同一次重试保留全部参数。服务端无法确认浏览器无未上传稿，绝不默认缺稿提交。图片原始字节合计上限4MiB，超限可传includeImages=false显式仅文字；本工具不创建任务、租约、事件或设备。",
      inputSchema: studentMcpPracticeQuestionReadInputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    publicRead(async (input: StudentMcpPracticeQuestionReadInput) => {
      const result = await reads.question(input);
      const data = jsonContent(
        studentMcpPracticeQuestionDataSchema.parse(result.data),
      );
      return { content: [...data.content, ...result.content] };
    }),
  );
}
