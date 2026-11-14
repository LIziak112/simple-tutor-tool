import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { STUDENT_MCP_TOOL_NAMES } from "../apps/server/src/mcp/student-server.ts";
import {
  callToolJson,
  connectMcpClientViaHttp,
} from "../apps/server/src/test/mcp-test-utils.ts";
import {
  attemptSettlementResultSchema,
  memoListDataSchema,
  memoSchema,
  studentMcpPracticeDataSchema,
  studentMcpPracticeListDataSchema,
  studentMcpPracticeQuestionDataSchema,
} from "../packages/contract/src/index.ts";
import {
  addCourseMemberViaApi,
  choiceJudgePracticeMarkdown,
  createCourseViaApi,
  createStudentViaApi,
  getStudentViaApi,
  STUDENT_PASSWORD,
  setCourseItemVisible,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/** 真实HTTP、Bearer与官方SDK链路；协议测试不依赖浏览器点击或外部AI客户端。 */
async function preparePractice(
  owner: APIRequestContext,
  learner: APIRequestContext,
  studentId: string | undefined,
  suffix: string,
) {
  const feedback = await owner.put("/api/teacher/settings/practice-feedback", {
    data: { practiceFeedbackPolicy: "student_choice" },
  });
  expect(feedback.ok()).toBe(true);
  const courseId = await createCourseViaApi(owner, `MCP公开读取${suffix}`);
  const title = `公开读取单元${suffix}`;
  const imported = await owner.post("/api/teacher/import/commit", {
    data: {
      courseId,
      filename: `${title}.md`,
      markdown: choiceJudgePracticeMarkdown(title).replaceAll(
        "$1$ 大于 $0$，是正数。",
        "公开读取私有解析哨兵",
      ),
    },
  });
  expect(imported.ok()).toBe(true);
  const unitId = (
    (await imported.json()) as {
      data: { units: { id: string }[] };
    }
  ).data.units[0]?.id;
  if (!unitId) throw new Error("导入未返回练习单元");
  await setCourseItemVisible(owner, courseId, title, true);
  if (studentId !== undefined)
    await addCourseMemberViaApi(owner, courseId, studentId);
  const started = await learner.post(
    `/api/student/courses/${courseId}/units/${encodeURIComponent(unitId)}/attempts`,
    { data: { workflowVersion: 1, feedbackMode: "per_question" } },
  );
  expect(started.ok()).toBe(true);
  return {
    practiceId: ((await started.json()) as { data: { id: string } }).data.id,
    courseId,
  };
}

for (const kind of ["class", "personal"] as const) {
  test.describe(`A1 ${kind} MCP公开读取`, { tag: ["@mcp"] }, () => {
    test("本人公开读取→确认提交反馈/分批/随笔往返；token域与隐藏来源拒绝", async ({
      request,
      browser,
    }) => {
      const suffix = uniqueSuffix();
      await teacherApiLogin(request);
      const learnerContext = await browser.newContext({
        baseURL: "http://127.0.0.1:5199",
      });
      const learner = learnerContext.request;
      let client:
        | Awaited<ReturnType<typeof connectMcpClientViaHttp>>
        | undefined;
      try {
        let studentId: string | undefined;
        if (kind === "class") {
          const loginName = `mcp-read-${suffix}`;
          await createStudentViaApi(
            request,
            `公开读取学生${suffix}`,
            loginName,
          );
          studentId = (await getStudentViaApi(request, loginName)).id;
          const logged = await learner.post("/api/public/student/login", {
            data: { loginName, password: STUDENT_PASSWORD },
          });
          expect(logged.ok()).toBe(true);
        } else {
          const inviteCode = `mcp-read-invite-${suffix}`;
          const opened = await request.patch("/api/admin/settings", {
            data: { personalInviteCode: inviteCode },
          });
          expect(opened.ok()).toBe(true);
          const registered = await learner.post(
            "/api/public/personal/register",
            {
              headers: { "x-forwarded-for": "10.92.5.1" },
              data: {
                loginName: `个人公开读取${suffix}`,
                password: "e2e-mcp-read-personal-pass",
                inviteCode,
              },
            },
          );
          expect(registered.ok()).toBe(true);
        }
        const owner = kind === "personal" ? learner : request;
        const { practiceId, courseId } = await preparePractice(
          owner,
          learner,
          studentId,
          suffix,
        );
        const page = await learnerContext.newPage();
        await page.goto(`/s/attempts/${practiceId}`);
        await expect(
          page.getByRole("article", { name: "第 1 题", exact: true }),
        ).toBeVisible();
        // 题卡原始随笔是首个实质动作；Agent后续只新增关联条目，不改原文。
        await page
          .getByRole("button", { name: "第 1 题更多", exact: true })
          .click();
        await page
          .getByRole("menuitem", { name: "记随笔", exact: true })
          .click();
        const memoDialog = page.getByRole("dialog", { name: "随手记" });
        await memoDialog.getByLabel("随笔内容").fill(`原始MCP随笔${suffix}`);
        await memoDialog.getByRole("button", { name: "保存" }).click();
        await expect(memoDialog).toBeHidden();
        await expect
          .poll(async () => {
            const response = await learner.get("/api/student/memos");
            return memoListDataSchema
              .parse(((await response.json()) as { data: unknown }).data)
              .memos.some((memo) => memo.text === `原始MCP随笔${suffix}`);
          })
          .toBe(true);
        const created = await learner.post("/api/student/ai/connections", {
          data: { channel: "mcp" },
        });
        expect(created.ok()).toBe(true);
        const credential = (
          (await created.json()) as {
            data: { credential: { token: string } | null };
          }
        ).data.credential;
        if (!credential) throw new Error("未创建MCP凭据");
        const wrongDomain = await learner.post(
          `http://127.0.0.1:8899/mcp/${kind === "class" ? "personal" : "student"}`,
          {
            headers: {
              authorization: `Bearer ${credential.token}`,
              accept: "application/json, text/event-stream",
            },
            data: {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "wrong-token-domain-probe", version: "1" },
              },
            },
          },
        );
        expect(wrongDomain.status()).toBe(401);
        client = await connectMcpClientViaHttp(
          `http://127.0.0.1:8899/mcp/${kind === "class" ? "student" : "personal"}`,
          credential.token,
          "practice-public-read-e2e",
        );
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        expect(STUDENT_MCP_TOOL_NAMES).toContain("student_settle_practice");
        // 个人端合法组合本人教师工具；班级学生端只开放学生工具清单。
        if (kind === "class")
          expect(names).toHaveLength(STUDENT_MCP_TOOL_NAMES.length);
        expect(new Set(names).size).toBe(names.length);
        expect(names).toEqual(
          expect.arrayContaining([
            "create_review_run_v2",
            "list_review_runs_v2",
            "claim_review_part_v2",
            "renew_review_part_lease_v2",
            "submit_review_part_v2",
          ]),
        );
        expect(names).toEqual(
          expect.arrayContaining([...STUDENT_MCP_TOOL_NAMES]),
        );
        const listed = await callToolJson(client, "list_my_practices", {});
        expect(listed.isError).toBe(false);
        const list = studentMcpPracticeListDataSchema.parse(listed.data);
        expect(
          list.practices.some((practice) => practice.practiceId === practiceId),
        ).toBe(true);
        const directory = await callToolJson(client, "get_practice", {
          practiceId,
        });
        expect(directory.isError).toBe(false);
        const practice = studentMcpPracticeDataSchema.parse(directory.data);
        expect(practice.questions).toHaveLength(2);
        const first = practice.questions[0];
        if (!first) throw new Error("目录为空");
        const read = await callToolJson(client, "get_practice_question", {
          practiceId,
          questionId: first.questionId,
          questionNo: first.questionNo,
          includeImages: false,
        });
        expect(read.isError).toBe(false);
        const question = studentMcpPracticeQuestionDataSchema.parse(read.data);
        expect(question.context.session).toMatchObject({
          attemptId: practiceId,
          questionRevisionId: first.questionRevisionId,
          questionNo: 1,
          questionCount: 2,
          settlementSeq: null,
        });
        for (const data of [list, practice, question])
          expect(JSON.stringify(data)).not.toMatch(
            /"answers"|solutionMd|teacherComment|autoCorrect|公开读取私有解析哨兵/,
          );
        if (!question.submission.available)
          throw new Error(
            `真实新协议夹具不允许逐题提交：${question.submission.reason}`,
          );
        const parameters = question.submission.parameters;
        const missingKey = await client.callTool({
          name: "student_submit_practice_question",
          arguments: parameters,
        });
        expect(missingKey.isError).toBe(true);
        const envelope = { ...parameters, submissionMutationId: randomUUID() };
        const submitted = await callToolJson(
          client,
          "student_submit_practice_question",
          envelope,
        );
        expect(submitted).toEqual({ isError: false, data: { success: true } });
        expect(
          await callToolJson(
            client,
            "student_submit_practice_question",
            envelope,
          ),
        ).toEqual(submitted);
        const enhanced = await callToolJson(
          client,
          "student_submit_practice_question",
          { ...envelope, responseVersion: 2, questionNo: 1 },
        );
        expect(enhanced.isError).toBe(false);
        expect(enhanced.data).toMatchObject({
          success: true,
          responseVersion: 2,
          practiceId,
          questionId: first.questionId,
          questionNo: 1,
          submissionMutationId: envelope.submissionMutationId,
          progress: { submittedCount: 1, totalCount: 2 },
          nextQuestion: { questionNo: 2 },
        });
        expect(enhanced.data.feedback).toMatchObject({
          status: "released",
          question: {
            questionId: first.questionId,
            solutionMd: expect.stringContaining("公开读取私有解析哨兵"),
            teacherComment: null,
            teacherMark: null,
            finalCorrect: null,
          },
        });
        const feedback = await learner.get(
          `/api/student/attempts/${practiceId}/questions/${encodeURIComponent(first.questionId)}/feedback`,
        );
        expect(
          ((await feedback.json()) as { data: { feedback: unknown } }).data
            .feedback,
        ).toEqual(enhanced.data.feedback);
        const settlementRequest = {
          practiceId,
          workflowVersion: parameters.workflowVersion,
          workflowRevision: parameters.workflowRevision,
          mutationId: randomUUID(),
          questions: [],
        };
        const settled = await callToolJson(
          client,
          "student_settle_practice",
          settlementRequest,
        );
        expect(settled.isError).toBe(false);
        const batch = attemptSettlementResultSchema.parse(settled.data);
        expect(batch.settlement).toMatchObject({
          seq: 1,
          kind: "partial",
          questionCount: 1,
        });
        expect(batch.questions.map((item) => item.questionId)).toEqual([
          first.questionId,
        ]);
        expect(Object.keys(batch.questionNos)).toEqual([first.questionId]);
        expect(
          await callToolJson(
            client,
            "student_settle_practice",
            settlementRequest,
          ),
        ).toEqual(settled);
        const original = memoListDataSchema
          .parse(
            (await callToolJson(client, "list_my_memos", { courseId })).data,
          )
          .memos.find((memo) => memo.text === `原始MCP随笔${suffix}`);
        if (!original?.context || !original.seq)
          throw new Error("原始随笔缺完整来源或序号");
        const memoRequest = {
          operationId: randomUUID(),
          parentMemoSeq: original.seq,
          context: original.context,
          text: `Agent整理稿${suffix}`,
        };
        const added = await callToolJson(client, "add_memo", memoRequest);
        expect(added.isError).toBe(false);
        const derived = memoSchema.parse(added.data);
        expect(derived.context?.content).toEqual(original.context.content);
        expect(derived.context?.session?.questionRevisionId).toBe(
          first.questionRevisionId,
        );
        expect(derived.deviceId).toBeTruthy();
        expect(await callToolJson(client, "add_memo", memoRequest)).toEqual(
          added,
        );
        const learn = kind === "personal" ? "/p/learn" : "/s";
        await page.goto(`${learn}/memos?seq=${original.seq}`);
        const parentCard = page
          .locator("article")
          .filter({ hasText: `原始MCP随笔${suffix}` });
        await expect(parentCard).toBeVisible();
        await parentCard
          .getByRole("link", { name: `查看 #${original.seq} 的关联条目` })
          .click();
        const childCard = page
          .locator("article")
          .filter({ hasText: `Agent整理稿${suffix}` });
        await expect(childCard).toBeVisible();
        await expect(
          childCard.getByText(/MCP 连接 · [a-f0-9]{8}/),
        ).toBeVisible();
        await expect(
          childCard.getByRole("link", { name: `关联原随笔 #${original.seq}` }),
        ).toHaveAttribute("href", `${learn}/memos?seq=${original.seq}`);
        await childCard.getByRole("button", { name: /查看来源/ }).click();
        await expect(
          childCard.getByRole("link", { name: /第\s*1\s*题/ }),
        ).toHaveAttribute(
          "href",
          `${learn}/attempts/${practiceId}?q=${encodeURIComponent(first.questionId)}`,
        );
        const reread = await callToolJson(client, "get_practice_question", {
          practiceId,
          questionId: first.questionId,
          includeImages: false,
        });
        expect(reread.isError).toBe(false);
        expect(
          studentMcpPracticeQuestionDataSchema.parse(reread.data).submission,
        ).toEqual({
          available: false,
          reason: "QUESTION_ALREADY_SUBMITTED",
        });
        expect(JSON.stringify(reread.data)).not.toMatch(
          /"answers"|solutionMd|teacherComment|autoCorrect|公开读取私有解析哨兵/,
        );
        // 目录存在不授予内容权；来源隐藏后同一Bearer必须立即失权。
        await setCourseItemVisible(
          owner,
          courseId,
          `公开读取单元${suffix}`,
          false,
        );
        for (const name of ["get_practice", "get_practice_question"]) {
          const denied = await callToolJson(client, name, {
            practiceId,
            ...(name === "get_practice_question"
              ? { questionId: first.questionId, includeImages: false }
              : {}),
          });
          expect(denied.isError).toBe(true);
          expect(Object.keys(denied.data).sort()).toEqual(["error", "message"]);
          expect(JSON.stringify(denied)).not.toContain("公开读取私有解析哨兵");
        }
      } finally {
        try {
          await client?.close();
        } finally {
          await learnerContext.close();
        }
      }
    });
  });
}
