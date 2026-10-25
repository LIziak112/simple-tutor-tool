import { devices, expect, test } from "@playwright/test";
import {
  addCourseMemberViaApi,
  choiceJudgePracticeMarkdown,
  createCourseViaApi,
  createStudentViaApi,
  getStudentViaApi,
  teacherApiLogin,
  uniqueSuffix,
} from "./helpers";

/**
 * SAI-27 学生 MCP 闭环 E2E（B14「自动化用协议客户端跑完整闭环」）：
 * 在真实 HTTP 服务器上（8899 = E2E_SERVER_PORT，/mcp/student 不走 vite
 * 代理）用 JSON-RPC 协议客户端完成 401 防探测 → initialize → tools/list →
 * 材料上传（SAI-20 multipart）→ claim ×2（首题领取附 base64 PNG 图像，
 * 次题无材料仅文字）→ renew → list → submit ×2 全链路，并验证学生页面/API
 * 的真实等待与逐题对应回复。真实第三方客户端（Claude Code / Cursor 等）
 * 的名称/版本/认证/图片兼容为待人工项，见 docs/学生端AI伴学/验收记录.md
 * B14 行。
 *
 * 验收场景对照（B14 SAI-27）：
 * - 明文凭证只在创建/重置响应出现一次（普通查询只有指纹掩码）；
 * - 撤销（重置 Token）后旧客户端马上拒绝；
 * - 两题入队可继续作答，外部批量处理后各题收到对应回复（不串题）；
 * - 外部未写回时平台保持真实等待（处理中），不因工具被调用就显示已回复。
 */

/** 与 playwright.config.ts 保持一致（server 直连地址；vite 代理不转发 /mcp） */
const STUDENT_MCP_URL = "http://127.0.0.1:8899/mcp/student";

/** 学生 MCP 八工具（四逐题 + 四整体复盘，任务 1ef854c7；与服务端 student-mcp 测试同清单） */
const EXPECTED_STUDENT_TOOLS = [
  "claim_ai_task",
  "claim_attempt_review",
  "list_my_ai_tasks",
  "list_my_attempt_reviews",
  "renew_ai_lease",
  "renew_attempt_review_lease",
  "submit_ai_reply",
  "submit_attempt_review_result",
].sort();

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

/** tools/call 的原始 content（领取附图时含 SDK image content 项） */
type ToolContent = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

/** tools/call 并解析 text content 里的 JSON（工具统一 JSON 文本返回）+ 保留原始 content 供附图断言 */
async function callTool(
  request: import("@playwright/test").APIRequestContext,
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<{ json: Record<string, unknown>; content: ToolContent[] }> {
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
    content: ToolContent[];
    isError?: boolean;
  };
  const text = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (result.isError === true) {
    throw new Error(`tools/call ${name} 返回错误：${text}`);
  }
  return { json: parsed, content: result.content };
}

/**
 * 最小合法 PNG（魔数 + IHDR 宣告宽高 + 尾部 IEND；服务端只验哨兵不验 CRC，
 * 与 apps/server/src/test/note-fixtures.ts makeNotePng 同口径——e2e 不跨包引
 * server 测试夹具）。
 */
function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(76);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "latin1");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf.writeUInt32BE(0, buf.length - 12);
  buf.write("IEND", buf.length - 8, "latin1");
  return buf;
}

/** 教师域建好「两题作业 + 一名学生」的世界，返回开卷所需的全部 id */
async function makeWorld(
  request: import("@playwright/test").APIRequestContext,
  suffix: string,
  title: string,
): Promise<{ assignmentId: string; loginName: string }> {
  await teacherApiLogin(request);
  const courseId = await createCourseViaApi(request, `e2e-mcp闭环课${suffix}`);
  const unitName = `mcp闭环单元${suffix}`;
  const importRes = await request.post("/api/teacher/import/commit", {
    data: {
      markdown: choiceJudgePracticeMarkdown(unitName),
      filename: `${unitName}.md`,
      courseId,
    },
  });
  if (!importRes.ok()) {
    throw new Error(`导入练习失败：HTTP ${importRes.status()}`);
  }
  const importBody = (await importRes.json()) as {
    data: { units: { id: string }[] };
  };
  const unitId = importBody.data.units[0]?.id;
  if (unitId === undefined) throw new Error("导入响应缺少单元 id");

  const loginName = `e2e-saimcp-${suffix}`;
  await createStudentViaApi(request, `e2e-mcp生${suffix}`, loginName);
  const student = await getStudentViaApi(request, loginName);
  await addCourseMemberViaApi(request, courseId, student.id);

  const assignmentRes = await request.post("/api/teacher/assignments", {
    data: {
      unitIds: [unitId],
      studentIds: [student.id],
      title,
      courseId,
    },
  });
  if (!assignmentRes.ok()) {
    throw new Error(`布置作业失败：HTTP ${assignmentRes.status()}`);
  }
  const assignmentBody = (await assignmentRes.json()) as {
    data: { assignments: { id: string }[] };
  };
  const assignmentId = assignmentBody.data.assignments[0]?.id;
  if (assignmentId === undefined) throw new Error("布置响应缺少作业 id");
  return { assignmentId, loginName };
}

/** 学生专属链接登录 → 返回带会话 cookie 的 context 与首页 page */
async function loginStudent(
  browser: import("@playwright/test").Browser,
  linkToken: string,
) {
  const context = await browser.newContext(devices["iPad (gen 7)"]);
  const page = await context.newPage();
  await page.goto(`/s/${linkToken}`);
  await page.waitForURL("**/s/home");
  return { context, page };
}

test.describe("SAI-27 学生 MCP 闭环（协议客户端）", { tag: ["@mcp"] }, () => {
  test("两题入队 → 外部客户端领取写回 → 各题收到对应回复；等待状态真实", async ({
    browser,
    request,
  }) => {
    test.setTimeout(180_000);
    const suffix = uniqueSuffix();
    const title = `MCP闭环作业${suffix}`;
    const world = await makeWorld(request, suffix, title);
    const student = await getStudentViaApi(request, world.loginName);
    const { context, page } = await loginStudent(browser, student.linkToken);
    try {
      // 学生 API（context.request 复用会话 cookie）：开卷（幂等）+ 拿两题 id
      const studentApi = context.request;
      const startRes = await studentApi.post(
        `/api/student/assignments/${world.assignmentId}/attempt`,
      );
      if (!startRes.ok()) {
        throw new Error(`开卷失败：HTTP ${startRes.status()}`);
      }
      const attemptId = (
        (await startRes.json()) as {
          data: { id: string };
        }
      ).data.id;
      const detailRes = await studentApi.get(
        `/api/student/attempts/${attemptId}`,
      );
      const questions = (
        (await detailRes.json()) as {
          data: { units: { questions: { id: string }[] }[] };
        }
      ).data.units.flatMap((unit) => unit.questions);
      expect(questions.length).toBeGreaterThanOrEqual(2);

      // ① 无 token → 401（防探测口径，与错 token 同文案）
      const init = rpc(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "sai27-e2e-protocol-client", version: "1.0.0" },
        },
        1,
      );
      const anon = await postStudentRpc(request, init, null);
      expect(anon.status).toBe(401);

      // ② 创建 mcp 连接：明文 token 只在响应出现一次
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
      // 普通查询只有指纹掩码，明文不可再得
      const listConn = (
        (await (
          await studentApi.get("/api/student/ai/connections")
        ).json()) as {
          data: {
            connections: { channel: string; tokenFingerprint?: string }[];
          };
        }
      ).data.connections;
      const mcpConn = listConn.find((c) => c.channel === "mcp");
      expect(mcpConn?.tokenFingerprint).toBeTruthy();

      // ③ 两题入队（学生可继续作答，页面不自动切题）；首题记下 id 供附材料
      const questionIds = questions.slice(0, 2).map((q) => q.id);
      const createdIds: string[] = [];
      for (const questionId of questionIds) {
        const created = await studentApi.post("/api/student/ai/tasks", {
          data: {
            attemptId,
            questionId,
            question: "请帮我讲解本题",
            channel: "mcp",
            materials: { annotation: true, draft: true, formalInk: false },
            mutationId: crypto.randomUUID(),
          },
        });
        expect(created.status()).toBe(201);
        createdIds.push(
          ((await created.json()) as { data: { id: string } }).data.id,
        );
      }

      // ③b 首题上传一页草稿材料 PNG（SAI-20 multipart）：领取时应作为
      // SDK image content 附图出站——协议客户端拿到的是 base64 PNG
      const materialPng = makePng(320, 200);
      const materialsRes = await studentApi.post(
        `/api/student/ai/tasks/${createdIds[0]}/materials`,
        {
          multipart: {
            // manifest 是普通字符串字段（Hono parseBody 只认字符串）；
            // 仅 page-N 是文件部件
            manifest: JSON.stringify([
              {
                kind: "draft",
                pageIndex: 0,
                pixelWidth: 320,
                pixelHeight: 200,
              },
            ]),
            "page-0": {
              name: "page-0.png",
              mimeType: "image/png",
              buffer: materialPng,
            },
          },
        },
      );
      expect(materialsRes.status()).toBe(200);
      const materialsBody = (await materialsRes.json()) as {
        data: { materials: { state: string }[]; totalBytes: number };
      };
      expect(materialsBody.data.materials[0]?.state).toBe("ready");
      expect(materialsBody.data.totalBytes).toBe(materialPng.byteLength);

      // ④ 协议客户端：initialize → tools/list 恰好八工具（四逐题 + 四整体复盘）
      const initRes = await postStudentRpc(request, init, token);
      expect(initRes.status).toBe(200);
      expect(initRes.json.error).toBeUndefined();
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
      expect(tools).toEqual(EXPECTED_STUDENT_TOOLS);

      // ⑤ 等待状态真实：入队未领取 → 页面队列角标「待处理 2」
      //（角标随页面加载查询，外部入队后重新进入页面即见真实计数）
      await page.reload();
      await expect(
        page.getByRole("button", { name: /助教队列：待处理 2/u }),
      ).toBeVisible();

      // ⑥ 领取两题（FIFO 各领一题；租约/上下文版本齐备）。首题领到
      // 附材料图像（base64 PNG image content），次题无材料仅文字
      const first = await callTool(request, token, 3, "claim_ai_task", {});
      expect(first.json.claimed).toBe(true);
      const second = await callTool(request, token, 4, "claim_ai_task", {});
      expect(second.json.claimed).toBe(true);
      const claim1 = first.json;
      const claim2 = second.json;
      expect(claim1.taskId).not.toBe(claim2.taskId);
      for (const claim of [claim1, claim2]) {
        expect(questionIds).toContain(claim.questionId);
        expect(typeof claim.leaseToken).toBe("string");
        expect(typeof claim.contextVersion).toBe("string");
      }
      // FIFO：先创建的首题（带材料）先被领取
      expect(claim1.taskId).toBe(createdIds[0]);
      expect(claim1.imagesIncluded).toBe(true);
      const claim1Materials = claim1.materials as {
        kind: string;
        pageIndex: number;
      }[];
      expect(claim1Materials).toHaveLength(1);
      expect(claim1Materials[0]?.kind).toBe("draft");
      const firstImages = first.content.filter((item) => item.type === "image");
      expect(firstImages).toHaveLength(1);
      expect(firstImages[0]?.mimeType).toBe("image/png");
      // base64 解码回 PNG 魔数 + IHDR 宽高（图像字节与上传件同源）
      const decoded = Buffer.from(firstImages[0]?.data ?? "", "base64");
      expect(decoded.subarray(0, 8)).toEqual(materialPng.subarray(0, 8));
      expect(decoded.readUInt32BE(16)).toBe(320);
      expect(decoded.readUInt32BE(20)).toBe(200);
      expect(claim2.imagesIncluded).toBe(true);
      expect(claim2.materials).toEqual([]);
      expect(second.content.filter((item) => item.type === "image")).toEqual(
        [],
      );

      // ⑥b 续租（四工具之三）：+10 分钟租约仍由当前持有者续期
      const renew = await callTool(request, token, 7, "renew_ai_lease", {
        taskId: claim1.taskId,
        leaseToken: claim1.leaseToken,
      });
      expect(renew.json.renewed).toBe(true);

      // ⑥c 只读列表（四工具之一）：两任务都在客户端列表里
      const listed = await callTool(request, token, 8, "list_my_ai_tasks", {
        limit: 10,
      });
      const listedIds = ((listed.json.tasks as { id: string }[]) ?? []).map(
        (task) => task.id,
      );
      expect(listedIds).toContain(claim1.taskId);
      expect(listedIds).toContain(claim2.taskId);

      // ⑦ 外部已领取未写回 → 平台保持真实等待（处理中，不虚报已回复）
      await page.reload();
      await expect(
        page.getByRole("button", { name: /待处理 2/u }),
      ).toBeVisible();
      const queuePanel1 = (
        (await (
          await studentApi.get("/api/student/ai/tasks?limit=10")
        ).json()) as { data: { tasks: { status: string }[] } }
      ).data.tasks;
      expect(
        queuePanel1.filter((t) => t.status === "claimed").length,
      ).toBeGreaterThanOrEqual(2);

      // ⑧ 批量写回：各题收到对应回复（内容互不串题）
      const reply1 = "第一题的讲解：$1$ 大于 $0$，所以是正数，判断为正确。";
      const reply2 = "第二题的讲解：$(-3)+7=4$，选 $4$。";
      const submit1 = await callTool(request, token, 9, "submit_ai_reply", {
        taskId: claim1.taskId,
        leaseToken: claim1.leaseToken,
        replyMarkdown: reply1,
        contextVersion: claim1.contextVersion,
      });
      expect(submit1.json.submitted).toBe(true);
      const submit2 = await callTool(request, token, 10, "submit_ai_reply", {
        taskId: claim2.taskId,
        leaseToken: claim2.leaseToken,
        replyMarkdown: reply2,
        contextVersion: claim2.contextVersion,
      });
      expect(submit2.json.submitted).toBe(true);

      // ⑨ 学生侧逐题验证：状态 replied、各自对话含自己的回复、不含另一题的
      for (const [claim, reply, other] of [
        [claim1, reply1, reply2],
        [claim2, reply2, reply1],
      ] as const) {
        const detail = (
          (await (
            await studentApi.get(`/api/student/ai/tasks/${claim.taskId}`)
          ).json()) as {
            data: {
              task: { status: string };
              messages: { role: string; contentMd: string }[];
            };
          }
        ).data;
        expect(detail.task.status).toBe("replied");
        const assistant = detail.messages
          .filter((m) => m.role === "assistant")
          .map((m) => m.contentMd)
          .join("\n");
        expect(assistant).toContain(reply.slice(0, 12));
        expect(assistant).not.toContain(other.slice(0, 12));
      }

      // ⑩ 页面展示：新回复角标真实出现（不是常驻占位 0）
      await page.reload();
      await expect(
        page.getByRole("button", { name: /新回复 [1-9]/u }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("重置 Token 后旧客户端立即拒绝；未写回任务保持真实等待", async ({
    browser,
    request,
  }) => {
    test.setTimeout(180_000);
    const suffix = uniqueSuffix();
    const title = `MCP撤销作业${suffix}`;
    const world = await makeWorld(request, suffix, title);
    const student = await getStudentViaApi(request, world.loginName);
    const { context, page } = await loginStudent(browser, student.linkToken);
    try {
      const studentApi = context.request;
      const startRes = await studentApi.post(
        `/api/student/assignments/${world.assignmentId}/attempt`,
      );
      if (!startRes.ok()) {
        throw new Error(`开卷失败：HTTP ${startRes.status()}`);
      }
      const attemptId = (
        (await startRes.json()) as {
          data: { id: string };
        }
      ).data.id;
      const questionId = (
        (await (
          await studentApi.get(`/api/student/attempts/${attemptId}`)
        ).json()) as {
          data: { units: { questions: { id: string }[] }[] };
        }
      ).data.units.flatMap((unit) => unit.questions)[0]?.id;
      expect(typeof questionId).toBe("string");

      const connRes = await studentApi.post("/api/student/ai/connections", {
        data: { channel: "mcp" },
      });
      const oldToken =
        (
          (await connRes.json()) as {
            data: { credential: { token: string } | null };
          }
        ).data.credential?.token ?? "";
      expect(oldToken.length).toBeGreaterThan(0);
      const connections = (
        (await (
          await studentApi.get("/api/student/ai/connections")
        ).json()) as {
          data: { connections: { id: string; channel: string }[] };
        }
      ).data.connections;
      const mcpConnection = connections.find((c) => c.channel === "mcp");
      expect(mcpConnection).toBeTruthy();

      const created = await studentApi.post("/api/student/ai/tasks", {
        data: {
          attemptId,
          questionId,
          question: "请帮我讲解本题",
          channel: "mcp",
          materials: { annotation: true, draft: true, formalInk: false },
          mutationId: crypto.randomUUID(),
        },
      });
      expect(created.status()).toBe(201);

      // 旧客户端领取（持有租约）
      const claimRaw = await callTool(
        request,
        oldToken,
        1,
        "claim_ai_task",
        {},
      );
      expect(claimRaw.json.claimed).toBe(true);
      const claim = claimRaw.json;
      const taskId = claim.taskId as string;

      // 撤销（重置 Token）：新明文只出现一次；旧客户端立即被拒
      const resetRes = await studentApi.patch(
        `/api/student/ai/connections/${mcpConnection?.id}`,
        { data: { channel: "mcp", resetToken: true } },
      );
      expect(resetRes.ok()).toBe(true);
      const newToken =
        (
          (await resetRes.json()) as {
            data: { credential: { token: string } | null };
          }
        ).data.credential?.token ?? "";
      expect(newToken.length).toBeGreaterThan(0);
      expect(newToken).not.toBe(oldToken);

      const init = rpc(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "sai27-e2e-revoke-client", version: "1.0.0" },
        },
        1,
      );
      const oldRejected = await postStudentRpc(request, init, oldToken);
      expect(oldRejected.status).toBe(401);
      const newOk = await postStudentRpc(request, init, newToken);
      expect(newOk.status).toBe(200);

      // 旧客户端持旧租约写回：连接层即拒绝（凭证实时失效），不进入工具层
      const staleSubmit = await postStudentRpc(
        request,
        rpc(
          "tools/call",
          {
            name: "submit_ai_reply",
            arguments: {
              taskId,
              leaseToken: claim.leaseToken,
              replyMarkdown: "旧客户端的迟到写回",
            },
          },
          2,
        ),
        oldToken,
      );
      expect(staleSubmit.status).toBe(401);

      // 平台事实不受影响：任务保持 claimed（真实等待），学生页面仍「待处理」
      const taskDetail = (
        (await (
          await studentApi.get(`/api/student/ai/tasks/${taskId}`)
        ).json()) as { data: { task: { status: string } } }
      ).data;
      expect(taskDetail.task.status).toBe("claimed");
      await page.reload();
      await expect(
        page.getByRole("button", { name: /待处理 1/u }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
