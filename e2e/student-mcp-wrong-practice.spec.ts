import { devices, expect, test } from "@playwright/test";
import { STUDENT_MCP_TOOL_NAMES } from "../apps/server/src/mcp/student-server.ts";
import {
  addCourseMemberViaApi,
  createCourseViaApi,
  createStudentViaApi,
  getStudentViaApi,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * 学生 MCP 组卷两工具 E2E（2026-10 P2 补口）：在真实 HTTP 服务器（8899 =
 * E2E_SERVER_PORT，/mcp/student 不走 vite 代理）用 JSON-RPC 协议客户端走
 * list_my_wrong_questions（只读列表：脱敏题干摘录、无答案/详解/本人答案键；
 * knowledge 筛选）→ create_wrong_practice（AI 组卷：非聚合 id 静默剔除并计入
 * excludedCount、范围快照 kind=ai 落库、学生端可开卷且记录标题带 AI label）。
 * 协议/认证/401 防探测等通用链路由 student-mcp-loop.spec.ts 覆盖，这里只补
 * 组卷链路（此前两工具仅有服务端 SDK 单测）。
 */

/** 与 playwright.config.ts 保持一致（server 直连地址） */
const STUDENT_MCP_URL = "http://127.0.0.1:8899/mcp/student";

/** 两道判断（考点互异）：学生两题都做错后进错题本 */
function practiceMarkdown(unitName: string): string {
  return [
    "---",
    "kind: practice",
    `unit: ${unitName}`,
    "topic: 正数与负数",
    "---",
    "",
    '::::question{type=judge difficulty=1 knowledge="有理数的概念"}',
    "$1$ 是正数。[[正确]]",
    "",
    ":::solution",
    "$1$ 大于 $0$，是正数。",
    ":::",
    "::::",
    "",
    '::::question{type=judge difficulty=1 knowledge="正数与负数"}',
    "$-1$ 是负数。[[正确]]",
    "",
    ":::solution",
    "$-1$ 小于 $0$，是负数。",
    ":::",
    "::::",
    "",
  ].join("\n");
}

/** JSON-RPC 请求体构造 */
function rpc(
  method: string,
  params: unknown,
  id: number,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, params };
}

/** POST /mcp/student（stateless + JSON 响应；Accept 与 SDK 客户口径一致） */
async function postStudentRpc(
  request: import("@playwright/test").APIRequestContext,
  body: Record<string, unknown>,
  token: string | null,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await request.post(STUDENT_MCP_URL, {
    data: body,
    headers: {
      accept: "application/json, text/event-stream",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
  });
  return {
    status: res.status(),
    json: (await res.json()) as Record<string, unknown>,
  };
}

/** tools/call 并解析 text content 里的 JSON（工具统一 JSON 文本返回） */
async function callTool(
  request: import("@playwright/test").APIRequestContext,
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await postStudentRpc(
    request,
    rpc("tools/call", { name, arguments: args }, id),
    token,
  );
  if (res.status !== 200 || res.json.error !== undefined) {
    throw new Error(
      `tools/call ${name} 失败：HTTP ${res.status} ${JSON.stringify(res.json)}`,
    );
  }
  const result = res.json.result as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (result.isError === true) {
    throw new Error(`tools/call ${name} 返回错误：${text}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

test.describe("学生 MCP 组卷两工具（list_my_wrong_questions + create_wrong_practice）", {
  tag: ["@mcp"],
}, () => {
  test("错题只读列表（脱敏 + 筛选）→ AI 组卷（剔除计数 + kind=ai 快照 + 学生端可开卷）", async ({
    request,
    browser,
  }) => {
    test.setTimeout(240_000);

    // —— 造数（教师 API）：课程 + 两题判断 + 学生入成员；学生 UI 做错一轮 ——
    await teacherApiLogin(request);
    const suffix = uniqueSuffix();
    const courseName = `e2e-mcp组卷课${suffix}`;
    const unitName = `mcp组卷小练${suffix}`;
    const courseId = await createCourseViaApi(request, courseName);
    const importRes = await request.post("/api/teacher/import/commit", {
      data: {
        markdown: practiceMarkdown(unitName),
        filename: `${unitName}.md`,
        courseId,
      },
    });
    if (!importRes.ok()) {
      throw new Error(`导入课程练习失败：HTTP ${importRes.status()}`);
    }
    await setCourseItemVisible(request, courseId, unitName, true);
    const loginName = `e2e-mcpwp-${suffix}`;
    await createStudentViaApi(request, `e2e-mcp组卷生${suffix}`, loginName);
    const student = await getStudentViaApi(request, loginName);
    await addCourseMemberViaApi(request, courseId, student.id);

    const context = await browser.newContext(devices["iPad (gen 7)"]);
    const page = await context.newPage();
    try {
      await page.goto(`/s/${student.linkToken}`);
      await page.waitForURL("**/s/home");
      const unitPath = `/s/courses/${courseId}/units/${encodeURIComponent(unitName)}`;
      await page.goto(unitPath);
      await page.getByRole("button", { name: "开始练习" }).click();
      await page.waitForURL("**/s/attempts/**");
      for (const [label, answer] of [
        ["第 1 题", "错"],
        ["第 2 题", "错"],
      ] as const) {
        const question = page.locator(`article[aria-label="${label}"]`);
        await question
          .getByRole("radio", { name: answer, exact: true })
          .locator("xpath=ancestor::label[1]")
          .click();
      }
      await expect
        .poll(async () => page.getByTestId("draft-status").textContent())
        .not.toContain("保存中");
      await page.getByRole("button", { name: "交卷", exact: true }).click();
      await page.getByRole("button", { name: "确认交卷" }).first().click();
      await expect(page.getByText("批改结果")).toBeVisible({
        timeout: 30_000,
      });

      // 错题本两题（页面接口口径）并拿题目 id
      const studentApi = context.request;
      const wrongList = (
        (await (
          await studentApi.get(
            "/api/student/wrong-questions?includeResolved=true",
          )
        ).json()) as {
          data: { questions: { questionId: string; wrongCount: number }[] };
        }
      ).data;
      expect(wrongList.questions).toHaveLength(2);
      const wrongId = wrongList.questions[0]?.questionId;
      expect(wrongId).toBeDefined();

      // —— 学生 MCP 连接（明文 token 只在创建响应出现一次）——
      const connRes = await studentApi.post("/api/student/ai/connections", {
        data: { channel: "mcp" },
      });
      expect(connRes.ok()).toBe(true);
      const token =
        (
          (await connRes.json()) as {
            data: { credential: { token: string } | null };
          }
        ).data.credential?.token ?? "";
      expect(token.length).toBeGreaterThan(0);

      // initialize → tools/list 全名单单源断言（与 loop spec 同口径）
      const init = rpc(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mcp-wrong-practice-e2e", version: "1.0.0" },
        },
        1,
      );
      expect((await postStudentRpc(request, init, token)).status).toBe(200);
      const listRes = await postStudentRpc(
        request,
        rpc("tools/list", {}, 2),
        token,
      );
      const tools = (
        (listRes.json.result as { tools: { name: string }[] }).tools ?? []
      )
        .map((tool) => tool.name)
        .sort();
      expect(tools).toEqual([...STUDENT_MCP_TOOL_NAMES].sort());

      // —— ① list_my_wrong_questions：只读投影（脱敏题干摘录，无答案键）——
      const listed = await callTool(
        request,
        token,
        3,
        "list_my_wrong_questions",
        {},
      );
      expect(listed.total).toBe(2);
      const listedJson = JSON.stringify(listed);
      expect(listedJson).not.toContain("solutionMd");
      expect(listedJson).not.toContain('"answers"');
      expect(listedJson).not.toContain('"answerText"');
      const first = (
        listed.questions as {
          questionId: string;
          stemExcerpt: string;
          wrongCount: number;
        }[]
      )[0];
      expect(first?.questionId).toBe(wrongId);
      expect(first?.stemExcerpt.length ?? 0).toBeGreaterThan(0);
      expect(first?.wrongCount).toBe(1);

      // knowledge 筛选（与页面综合筛选同一服务端谓词）
      const filtered = await callTool(
        request,
        token,
        4,
        "list_my_wrong_questions",
        { knowledge: "有理数的概念" },
      );
      expect(filtered.total).toBe(1);

      // —— ② create_wrong_practice：混入非聚合 id 静默剔除并计数 ——
      const created = await callTool(
        request,
        token,
        5,
        "create_wrong_practice",
        {
          questionIds: [wrongId as string, "不存在的题目"],
          label: "e2e AI 精选",
        },
      );
      expect(created.created).toBe(true);
      expect(created.includedCount).toBe(1);
      expect(created.excludedCount).toBe(1);
      expect(created.attemptNo).toBe(1);
      const attemptId = created.attemptId as string;
      expect(created.attemptUrl).toBe(`/s/attempts/${attemptId}`);

      // 学生端：卷真实存在、只有勾选的那 1 题；记录标题带 AI label（kind=ai 快照）
      const detail = await studentApi.get(`/api/student/attempts/${attemptId}`);
      expect(detail.ok()).toBe(true);
      const detailQuestions = (
        (await detail.json()) as {
          data: { units: { questions: { id: string }[] }[] };
        }
      ).data.units.flatMap((unit) => unit.questions);
      expect(detailQuestions.map((question) => question.id)).toEqual([wrongId]);

      const records = await studentApi.get("/api/student/records");
      expect(records.ok()).toBe(true);
      const recordsText = JSON.stringify(await records.json());
      expect(recordsText).toContain("错题重练 · 第 1 次");
      expect(recordsText).toContain("e2e AI 精选");
    } finally {
      await context.close();
    }
  });
});
