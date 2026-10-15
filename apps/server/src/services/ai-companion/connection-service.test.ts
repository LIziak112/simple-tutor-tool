import { randomUUID } from "node:crypto";
import { AI_SHARE_DEFAULT_VALID_HOURS } from "@tutor/contract";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../../db/client.ts";
import {
  aiConnections,
  aiFacts,
  aiTasks,
  responses,
  students,
  teachers,
} from "../../db/schema.ts";
import { createTestDb, TEST_TEACHER_ID } from "../../db/test-utils.ts";
import {
  expectHttpError,
  insertAttempt,
} from "../../test/ai-companion-fixtures.ts";
import {
  createStudentAiConnection,
  deleteStudentAiConnection,
  findActiveMcpConnectionByToken,
  listStudentAiConnections,
  patchStudentAiConnection,
  testStudentAiConnection,
} from "./connection-service.ts";
import type { ProviderTransportRequest } from "./provider-client.ts";

/**
 * SAI-16 连接管理服务测试（B08 攻击用例表的 secret/key/restore-revoke/
 * capability 行 + 实施步骤 1/2/3/7 的服务层断言）：
 * - secret：库内只存密文/哈希/指纹，明文 Key/token 只在写入请求与一次性
 *   响应出现；列表/测试响应/错误消息均无明文；
 * - key：解密失败统一 needs_rekey 可解释降级，重填后恢复；测试不无限重试；
 * - restore/revoke：token 重置旧凭证立即失效；删除连接软删 + 停发该通道
 *   未执行任务（created → cancelled + 事实），历史行不物理删；
 * - capability：测试连接探针固定文案（不带题面/学生数据），成功不改
 *   imageCapability（unknown 不因连通变 supported）；
 * - 验证状态明确：新建恒 unverified，不凭 Key 存在宣称在线。
 */

const SECRET = "ab".repeat(32); // 64 hex 字符（connection-cipher 以 hex 解析根密钥）

/** 直插任务行（删除停发用例；不复用 queue 的完整创建链） */
function insertTaskRow(
  db: Db,
  row: {
    studentId: string;
    attemptId: string;
    channel: "inapp" | "mcp" | "link";
    status: string;
  },
): string {
  const id = randomUUID();
  const questionId = `q-${id}`;
  db.insert(responses)
    .values({
      id: randomUUID(),
      attemptId: row.attemptId,
      questionId,
      unitId: null,
      questionVersion: 1,
      questionSnapshotJson: "{}",
      answerJson: null,
      submittedAt: null,
      teacherComment: null,
    })
    .run();
  db.insert(aiTasks)
    .values({
      id,
      studentId: row.studentId,
      attemptId: row.attemptId,
      questionId,
      questionRevisionId: randomUUID(),
      channel: row.channel,
      modeAtSend: "open_study",
      promptHash: "0".repeat(64),
      contextSnapshotJson: "{}",
      status: row.status as "created",
      beforeSubmit: true,
      mutationId: `mut-${id}`,
      leaseUntil: null,
      leaseToken: null,
      replyDeliveredAt: null,
      cancelRequestedAt: null,
      errorText: null,
      retryCount: 0,
      generation: 0,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
    })
    .run();
  return id;
}

/** 世界：一名学生（归属测试教师）+ 一次性 attempt */
function world() {
  const db = createTestDb();
  db.update(teachers)
    .set({ passwordHash: "scrypt$fixture" })
    .where(eq(teachers.id, TEST_TEACHER_ID))
    .run();
  const studentId = randomUUID();
  db.insert(students)
    .values({
      id: studentId,
      teacherId: TEST_TEACHER_ID,
      displayName: "学生一",
      loginName: `stu-${studentId.slice(0, 8)}`,
      passwordHash: null,
      linkToken: `link-${studentId}`,
      linkEnabled: true,
      passwordEnabled: false,
      note: null,
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  const attemptId = insertAttempt(db, { studentId });
  return { db, studentId, attemptId };
}

/** 成功假 transport：捕获出站请求，返回 OpenAI 兼容 ok 响应 */
function okTransport(captured: ProviderTransportRequest[]) {
  return async (request: ProviderTransportRequest) => {
    captured.push(request);
    return {
      status: 200,
      headers: {},
      bodyText: JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
    };
  };
}

describe("SAI-16 连接管理服务", () => {
  it("inapp 创建：库内只存密文与指纹，列表只回公开视图，新建恒 unverified", () => {
    const { db, studentId } = world();
    const created = createStudentAiConnection(db, {
      studentId,
      rootSecret: SECRET,
      request: {
        channel: "inapp",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
        apiKey: "sk-plaintext-secret",
      },
    });
    expect(created.credential).toBeNull();
    expect(created.connection.channel).toBe("inapp");
    if (created.connection.channel === "inapp") {
      expect(created.connection.verifyStatus).toBe("unverified");
      expect(created.connection.keyFingerprint).toMatch(/^[0-9a-f]{8}$/);
    }
    // 库内 configJson 无明文 Key（secret 行）
    const row = db
      .select()
      .from(aiConnections)
      .where(eq(aiConnections.id, created.connection.id))
      .get();
    expect(row?.configJson).not.toContain("sk-plaintext-secret");
    // 列表只回公开视图（无密文列/无明文）
    const list = listStudentAiConnections(db, studentId);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("sk-plaintext-secret");
    expect(JSON.stringify(list[0])).not.toContain("ciphertext");
  });

  it("mcp 创建：token 高熵一次性返回，库内只存分用途哈希", () => {
    const { db, studentId } = world();
    const created = createStudentAiConnection(db, {
      studentId,
      rootSecret: SECRET,
      request: { channel: "mcp" },
    });
    // base64url(AI_MCP_TOKEN_BYTES) = 43 字符
    expect(created.credential?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = db
      .select()
      .from(aiConnections)
      .where(eq(aiConnections.id, created.connection.id))
      .get();
    expect(row?.configJson).not.toContain(created.credential?.token ?? "");
    expect(JSON.parse(row?.configJson ?? "{}").tokenHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
    // 认证：正确 token 命中，错 token / 学生登录 linkToken 均查不到（分用途）
    const token = created.credential?.token ?? "";
    expect(findActiveMcpConnectionByToken(db, token)).toEqual({
      id: created.connection.id,
      studentId,
    });
    expect(findActiveMcpConnectionByToken(db, "wrong-token")).toBeNull();
    const linkToken = db
      .select()
      .from(students)
      .where(eq(students.id, studentId))
      .get()?.linkToken;
    expect(findActiveMcpConnectionByToken(db, linkToken ?? "")).toBeNull();
  });

  it("link 创建：defaultValidHours 缺省取契约默认；重复通道 409；默认互斥跨通道唯一", () => {
    const { db, studentId } = world();
    const link = createStudentAiConnection(db, {
      studentId,
      rootSecret: SECRET,
      request: { channel: "link", isDefault: true },
    });
    expect(link.connection.channel === "link").toBe(true);
    if (link.connection.channel === "link") {
      expect(link.connection.defaultValidHours).toBe(
        AI_SHARE_DEFAULT_VALID_HOURS,
      );
      expect(link.connection.isDefault).toBe(true);
    }
    // 同通道重复 → 409 AI_STATE_CONFLICT（先查后插，错误码与任务 CAS 一致）
    expectHttpError(
      () =>
        createStudentAiConnection(db, {
          studentId,
          rootSecret: SECRET,
          request: { channel: "link" },
        }),
      409,
      "AI_STATE_CONFLICT",
    );
    // 新默认清旧默认（学生维度唯一）
    const inapp = createStudentAiConnection(db, {
      studentId,
      rootSecret: SECRET,
      request: {
        channel: "inapp",
        baseUrl: "https://api.example.com/v1",
        model: "m",
        apiKey: "k",
        isDefault: true,
      },
    });
    const relisted = listStudentAiConnections(db, studentId);
    expect(relisted.find((c) => c.id === link.connection.id)?.isDefault).toBe(
      false,
    );
    expect(relisted.find((c) => c.id === inapp.connection.id)?.isDefault).toBe(
      true,
    );
  });

  it("SSRF 入口：创建与更新拒绝字面量内网 IP baseUrl（400 AI_CONNECTION_INVALID）", () => {
    const { db, studentId } = world();
    // 字面量 IP 在保存期快速失败；localhost 等主机名留给连接级守卫按
    // DNS 解析结果裁决（2195b865 outbound-target.test 双证已覆盖）
    for (const baseUrl of [
      "http://127.0.0.1/v1",
      "http://192.168.1.4/v1",
      "http://[::1]/v1",
      "http://169.254.169.254/v1",
    ]) {
      expectHttpError(
        () =>
          createStudentAiConnection(db, {
            studentId,
            rootSecret: SECRET,
            request: { channel: "inapp", baseUrl, model: "m", apiKey: "k" },
          }),
        400,
        "AI_CONNECTION_INVALID",
      );
    }
    const created = createStudentAiConnection(db, {
      studentId,
      rootSecret: SECRET,
      request: {
        channel: "inapp",
        baseUrl: "https://api.example.com/v1",
        model: "m",
        apiKey: "k",
      },
    });
    expectHttpError(
      () =>
        patchStudentAiConnection(db, {
          studentId,
          connectionId: created.connection.id,
          rootSecret: SECRET,
          request: { channel: "inapp", baseUrl: "http://169.254.169.254/v1" },
        }),
      400,
      "AI_CONNECTION_INVALID",
    );
  });

  it("更新：Key 轮换重新密封回 unverified；mcp 重置 token 旧凭证立即失效", () => {
    const { db, studentId } = world();
    const created = createStudentAiConnection(db, {
      studentId,
      rootSecret: SECRET,
      request: {
        channel: "inapp",
        baseUrl: "https://api.example.com/v1",
        model: "m",
        apiKey: "sk-old",
      },
    });
    const patched = patchStudentAiConnection(db, {
      studentId,
      connectionId: created.connection.id,
      rootSecret: SECRET,
      request: { channel: "inapp", apiKey: "sk-new", model: "m2" },
    });
    expect(patched.connection.channel).toBe("inapp");
    if (
      patched.connection.channel === "inapp" &&
      created.connection.channel === "inapp"
    ) {
      expect(patched.connection.verifyStatus).toBe("unverified");
      expect(patched.connection.keyFingerprint).not.toBe(
        created.connection.keyFingerprint,
      );
      expect(patched.connection.model).toBe("m2");
    }
    const row = db
      .select()
      .from(aiConnections)
      .where(eq(aiConnections.id, created.connection.id))
      .get();
    expect(row?.configJson).not.toContain("sk-old");
    expect(row?.configJson).not.toContain("sk-new");

    // mcp 重置：旧 token 认证立即失效，新 token 一次性返回
    const mcp = createStudentAiConnection(db, {
      studentId,
      rootSecret: SECRET,
      request: { channel: "mcp" },
    });
    const oldToken = mcp.credential?.token ?? "";
    const reset = patchStudentAiConnection(db, {
      studentId,
      connectionId: mcp.connection.id,
      rootSecret: SECRET,
      request: { channel: "mcp" },
    });
    // mcp 无字段 PATCH 不重置（reset 语义由专用入参承载，见下一断言组）
    expect(reset.credential).toBeNull();
    expect(findActiveMcpConnectionByToken(db, oldToken)?.id).toBe(
      mcp.connection.id,
    );
    const reset2 = patchStudentAiConnection(db, {
      studentId,
      connectionId: mcp.connection.id,
      rootSecret: SECRET,
      request: { channel: "mcp", resetToken: true },
    });
    expect(reset2.credential?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(reset2.credential?.token).not.toBe(oldToken);
    expect(findActiveMcpConnectionByToken(db, oldToken)).toBeNull();
    expect(
      findActiveMcpConnectionByToken(db, reset2.credential?.token ?? "")?.id,
    ).toBe(mcp.connection.id);
  });

  it("更新通道适用性：mcp 行收 inapp 字段、link 行收 baseUrl → 400 AI_CONNECTION_INVALID", () => {
    const { db, studentId } = world();
    const mcp = createStudentAiConnection(db, {
      studentId,
      rootSecret: SECRET,
      request: { channel: "mcp" },
    });
    expectHttpError(
      () =>
        patchStudentAiConnection(db, {
          studentId,
          connectionId: mcp.connection.id,
          rootSecret: SECRET,
          request: { channel: "inapp", apiKey: "sk-x" },
        }),
      400,
      "AI_CONNECTION_INVALID",
    );
    const link = createStudentAiConnection(db, {
      studentId,
      rootSecret: SECRET,
      request: { channel: "link" },
    });
    expectHttpError(
      () =>
        patchStudentAiConnection(db, {
          studentId,
          connectionId: link.connection.id,
          rootSecret: SECRET,
          request: { channel: "inapp", baseUrl: "https://a.example.com" },
        }),
      400,
      "AI_CONNECTION_INVALID",
    );
  });

  it("归属与防枚举：他人学生 id 操作别人连接 → 404 NOT_FOUND 同文案", () => {
    const { db, studentId } = world();
    const otherId = randomUUID();
    const created = createStudentAiConnection(db, {
      studentId,
      rootSecret: SECRET,
      request: { channel: "mcp" },
    });
    expectHttpError(
      () =>
        listStudentAiConnections(db, otherId).length === 0 &&
        patchStudentAiConnection(db, {
          studentId: otherId,
          connectionId: created.connection.id,
          rootSecret: SECRET,
          request: { channel: "mcp", isDefault: true },
        }),
      404,
      "NOT_FOUND",
    );
    expect(listStudentAiConnections(db, otherId)).toHaveLength(0);
  });

  it("删除：软删 + 停发该通道 created 任务（cancelled + 事实），他通道任务不动", () => {
    const { db, studentId, attemptId } = world();
    const mcp = createStudentAiConnection(db, {
      studentId,
      rootSecret: SECRET,
      request: { channel: "mcp", isDefault: true },
    });
    createStudentAiConnection(db, {
      studentId,
      rootSecret: SECRET,
      request: { channel: "link" },
    });
    const createdTask = insertTaskRow(db, {
      studentId,
      attemptId,
      channel: "mcp",
      status: "created",
    });
    const otherChannelTask = insertTaskRow(db, {
      studentId,
      attemptId,
      channel: "link",
      status: "created",
    });
    const repliedTask = insertTaskRow(db, {
      studentId,
      attemptId,
      channel: "mcp",
      status: "replied",
    });
    const deleted = deleteStudentAiConnection(db, {
      studentId,
      connectionId: mcp.connection.id,
    });
    expect(deleted.id).toBe(mcp.connection.id);
    // 行软删保留（历史事实锚点），token 立即失效
    const row = db
      .select()
      .from(aiConnections)
      .where(eq(aiConnections.id, mcp.connection.id))
      .get();
    expect(row?.archivedAt).not.toBeNull();
    expect(
      findActiveMcpConnectionByToken(db, mcp.credential?.token ?? ""),
    ).toBeNull();
    // 该通道未执行任务停发；他通道与历史任务不受影响
    const taskOf = (id: string) =>
      db.select().from(aiTasks).where(eq(aiTasks.id, id)).get()?.status;
    expect(taskOf(createdTask)).toBe("cancelled");
    expect(taskOf(otherChannelTask)).toBe("created");
    expect(taskOf(repliedTask)).toBe("replied");
    const fact = db
      .select()
      .from(aiFacts)
      .where(eq(aiFacts.taskId, createdTask))
      .get();
    expect(fact?.type).toBe("cancelled");
    // 删除默认连接不自动补默认
    const relisted = listStudentAiConnections(db, studentId);
    expect(relisted.every((c) => !c.isDefault)).toBe(true);
    // 重复删除 → 404
    expectHttpError(
      () =>
        deleteStudentAiConnection(db, {
          studentId,
          connectionId: mcp.connection.id,
        }),
      404,
      "NOT_FOUND",
    );
  });

  it("测试连接：探针不带题面，成功置 verified 但不改 imageCapability", async () => {
    const { db, studentId } = world();
    const created = createStudentAiConnection(db, {
      studentId,
      rootSecret: SECRET,
      request: {
        channel: "inapp",
        baseUrl: "https://api.example.com/v1",
        model: "gpt-4o-mini",
        apiKey: "sk-test",
      },
    });
    const captured: ProviderTransportRequest[] = [];
    const result = await testStudentAiConnection(
      db,
      {
        studentId,
        connectionId: created.connection.id,
        rootSecret: SECRET,
      },
      { transport: okTransport(captured) },
    );
    expect(result.verifyStatus).toBe("verified");
    expect(result.verifiedAt).not.toBeNull();
    // capability 行：连通 ≠ 识图支持，unknown 原样保留
    const relisted = listStudentAiConnections(db, studentId);
    const view = relisted[0];
    expect(view?.channel).toBe("inapp");
    expect(view?.channel === "inapp" ? view.imageCapability : "missing").toBe(
      "unknown",
    );
    // 出站只有探针：无题面/学生数据/答案哨兵；鉴权头携带密封解出的 Key
    expect(captured).toHaveLength(1);
    const outbound = captured[0];
    const body =
      outbound === undefined
        ? null
        : (JSON.parse(outbound.body) as {
            messages: { role: string; content: string }[];
          });
    expect(body).not.toBeNull();
    expect(body?.messages).toHaveLength(1);
    expect(body?.messages[0]?.content).toBe("连接测试：请只回复 ok。");
    expect(JSON.stringify(body?.messages)).not.toContain("stemMd");
    expect(outbound?.url).toBe("https://api.example.com/v1/chat/completions");
    expect(outbound?.headers.authorization).toBe("Bearer sk-test");
    expect(result.message).not.toContain("sk-test");
  });

  it("测试连接失败置 failed；解密失败置 needs_rekey 且不再出站", async () => {
    const { db, studentId } = world();
    const created = createStudentAiConnection(db, {
      studentId,
      rootSecret: SECRET,
      request: {
        channel: "inapp",
        baseUrl: "https://api.example.com/v1",
        model: "m",
        apiKey: "sk-a",
      },
    });
    // 供应商 401 → failed + 中文短句（无响应原文/头）
    const failed = await testStudentAiConnection(
      db,
      {
        studentId,
        connectionId: created.connection.id,
        rootSecret: SECRET,
      },
      {
        transport: async () => ({
          status: 401,
          headers: {},
          bodyText: "denied-secret-detail",
        }),
      },
    );
    expect(failed.verifyStatus).toBe("failed");
    expect(failed.message).not.toContain("denied-secret-detail");
    // 换根密钥（模拟 secret.key 丢失/更换）→ 行置 needs_rekey，可解释返回
    const rekeyed = await testStudentAiConnection(
      db,
      {
        studentId,
        connectionId: created.connection.id,
        rootSecret: "cd".repeat(32),
      },
      { transport: okTransport([]) },
    );
    expect(rekeyed.verifyStatus).toBe("needs_rekey");
    expect(rekeyed.message).toContain("重填");
    const row = db
      .select()
      .from(aiConnections)
      .where(eq(aiConnections.id, created.connection.id))
      .get();
    expect(row?.verifyStatus).toBe("needs_rekey");
    // needs_rekey 行再测：直接可解释返回，不出站（key 行：不无限重试）
    const called: ProviderTransportRequest[] = [];
    const again = await testStudentAiConnection(
      db,
      {
        studentId,
        connectionId: created.connection.id,
        rootSecret: "cd".repeat(32),
      },
      { transport: okTransport(called) },
    );
    expect(again.verifyStatus).toBe("needs_rekey");
    expect(called).toHaveLength(0);
    // 重填 Key 后恢复 unverified（可再测）
    const refilled = patchStudentAiConnection(db, {
      studentId,
      connectionId: created.connection.id,
      rootSecret: "cd".repeat(32),
      request: { channel: "inapp", apiKey: "sk-b" },
    });
    expect(refilled.connection.channel).toBe("inapp");
    if (refilled.connection.channel === "inapp") {
      expect(refilled.connection.verifyStatus).toBe("unverified");
    }
  });

  it("非 inapp 通道不支持测试连接（link 无出站目标；mcp 由领取方驱动）", async () => {
    const { db, studentId } = world();
    const link = createStudentAiConnection(db, {
      studentId,
      rootSecret: SECRET,
      request: { channel: "link" },
    });
    await expect(
      testStudentAiConnection(db, {
        studentId,
        connectionId: link.connection.id,
        rootSecret: SECRET,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "AI_CONNECTION_INVALID",
    });
  });
});
