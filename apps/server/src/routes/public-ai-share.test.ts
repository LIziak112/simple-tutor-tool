import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { learningRecordAiViewSchema } from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import {
  aiFacts,
  aiPolicyOverrides,
  aiShareTickets,
  aiTasks,
  annotationBases,
  annotations,
  responses,
  students,
  teachers,
} from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  TEST_TEACHER_ID,
} from "../db/test-utils.ts";
import { attachAiTaskMaterials } from "../services/ai-companion/student-ai-materials.ts";
import { createAiTask } from "../services/ai-companion/student-ai-queue.ts";
import {
  createAiShareTicket,
  hashShareToken,
  revokeAiShareTickets,
} from "../services/ai-companion/student-ai-share.ts";
import {
  insertAttempt,
  insertResponse,
} from "../test/ai-companion-fixtures.ts";
import { makeNotePng, makeStudent } from "../test/note-fixtures.ts";

/**
 * SAI-29 分享正文及附件路由测试（B15；需求规格 §10、技术方案 §4.2 表 8）。
 *
 * 先测五组逐条：
 * ① 正文过期/撤销/禁用后，附件直连请求同样拒绝（独立实时校验）；
 * ② 同题答案解析可出；学生姓名/内部 UUID/绝对路径/教师私注/邻题材料
 *    不出现在正文、材料清单或错误响应里；
 * ③ 应用日志（错误路径）无 token 明文（path 脱敏，不只清查询参数）；
 *    缓存/Referrer/索引 headers 按请求方式匹配（GET 与 HEAD 一致）；
 * ④ 图片路径穿越/替换 ID/错页号不能读其他文件；
 * ⑤ 多次预览/附件读取不产生重复求助或 AI 已读事实（HEAD 不记已读）。
 *
 * 完成条件：app.request 验证实际 headers 与二进制权限（PNG 字节逐位相等）。
 * 全部夹具走真实服务（任务/材料/票据），时刻用真实时钟（撤销/改库造失效态）。
 */

const SECRET = "share-route-test-secret-0001";
/** 学生姓名哨兵：正文与错误响应都不得出现 */
const NAME_SENTINEL = "学生甲真名SENTINEL";
/** 教师私注哨兵：任何分享输出不得出现 */
const PRIVATE_NOTE_SENTINEL = "SENTINEL_PRIVATE_NOTE_不可外发";

it("不同题链接独立读取；本次重新读取不使用条件缓存，撤销后仍拒绝并禁缓存", async () => {
  const w = await prepareLinkTask(false);
  insertResponse(w.db, w.attemptId, "q-beta");
  const { task } = createAiTask(
    w.db,
    {
      studentId: w.studentId,
      attemptId: w.attemptId,
      questionId: "q-beta",
      question: "第二道题的独立问题 SENTINEL_BETA",
      channel: "link",
      mutationId: randomUUID(),
    },
    { hmacSecret: SECRET },
  );
  const second = createAiShareTicket(w.db, {
    studentId: w.studentId,
    taskId: task.id,
  });
  const firstPath = `/api/public/ai/share/${w.token}`;
  const secondPath = `/api/public/ai/share/${second.token}`;
  const first = await w.app.request(`${firstPath}?read=one`, {
    headers: { "if-none-match": "cached" },
  });
  expect(first.status).toBe(200);
  const firstText = await first.text();
  expect(firstText).toContain("SENTINEL_QUESTION");
  expect(firstText).not.toContain("SENTINEL_BETA");
  expect(firstText).toContain("每次回答前");
  const other = await w.app.request(`${secondPath}?read=two`);
  expect(await other.text()).toContain("SENTINEL_BETA");
  await w.app.request(`${firstPath}?read=three`);
  expect(
    w.db
      .select()
      .from(aiShareTickets)
      .where(eq(aiShareTickets.tokenHash, hashShareToken(w.token)))
      .get()?.viewCount,
  ).toBe(2);
  revokeAiShareTickets(w.db, { studentId: w.studentId, taskId: w.taskId });
  const rejected = await w.app.request(`${firstPath}?read=four`, {
    headers: { "if-none-match": "cached" },
  });
  expect(rejected.status).toBe(403);
  expect(rejected.headers.get("cache-control")).toBe("no-store");
  expect((await w.app.request(secondPath)).status).toBe(200);
});

const active: ReturnType<typeof createTestDb>[] = [];
const activeDirs: string[] = [];

function world() {
  const db = createTestDb();
  active.push(db);
  const dataDir = createTestDir();
  activeDirs.push(dataDir);
  db.update(teachers)
    .set({ passwordHash: "scrypt$fixture" })
    .where(eq(teachers.id, TEST_TEACHER_ID))
    .run();
  const studentId = makeStudent(db);
  // 姓名哨兵：share 正文不得携带学生姓名
  db.update(students)
    .set({ displayName: NAME_SENTINEL })
    .where(eq(students.id, studentId))
    .run();
  const attemptId = insertAttempt(db, { studentId });
  const responseId = insertResponse(db, attemptId, "q-alpha");
  // 教师私注哨兵：任何受控出口都不得下发
  db.update(responses)
    .set({ teacherComment: PRIVATE_NOTE_SENTINEL })
    .where(eq(responses.id, responseId))
    .run();
  // 捕获 pino 输出（错误路径的 path 脱敏断言用）
  const logs: string[] = [];
  const logger = pino(
    { level: "info" },
    { write: (chunk: string) => logs.push(chunk) },
  );
  const app = createApp({
    db,
    dataDir,
    publicUrl: "https://tutor.example.com/",
    isProduction: false,
    logger,
  });
  return { app, db, dataDir, logs, studentId, attemptId, responseId };
}

afterEach(() => {
  for (const db of active.splice(0)) db.$client.close();
  for (const dir of activeDirs.splice(0)) {
    // 临时目录清理交给 createTestDir 的回收策略；这里只断开引用
    void dir;
  }
});

interface PreparedLink {
  readonly app: ReturnType<typeof createApp>;
  readonly db: ReturnType<typeof createTestDb>;
  readonly logs: string[];
  readonly dataDir: string;
  readonly studentId: string;
  readonly attemptId: string;
  readonly taskId: string;
  readonly token: string;
  readonly png: Uint8Array;
}

/** 建一个带两页材料的 link 任务 + 有效票据（真实服务链路，无行直插） */
async function prepareLinkTask(withMaterials = true): Promise<PreparedLink> {
  const w = world();
  const { task } = createAiTask(
    w.db,
    {
      studentId: w.studentId,
      attemptId: w.attemptId,
      questionId: "q-alpha",
      question: "这道题第二问的思路是什么？SENTINEL_QUESTION",
      channel: "link",
      mutationId: randomUUID(),
    },
    { hmacSecret: SECRET },
  );
  const png = makeNotePng();
  if (withMaterials) {
    attachAiTaskMaterials(w.db, w.dataDir, {
      studentId: w.studentId,
      taskId: task.id,
      pages: [
        {
          kind: "annotation",
          pageIndex: 0,
          pixelWidth: 320,
          pixelHeight: 200,
          png,
        },
        { kind: "draft", pageIndex: 0, pixelWidth: 320, pixelHeight: 200, png },
      ],
    });
  }
  const { token } = createAiShareTicket(w.db, {
    studentId: w.studentId,
    taskId: task.id,
  });
  return {
    app: w.app,
    db: w.db,
    logs: w.logs,
    dataDir: w.dataDir,
    studentId: w.studentId,
    attemptId: w.attemptId,
    taskId: task.id,
    token,
    png,
  };
}

describe("SAI-29 分享正文及附件（公开读端点）", () => {
  describe("先测①：失效形态下正文与附件直连一致拒绝", () => {
    it("猜 token：正文与附件都 404，错误壳不回显 token", async () => {
      const w = await prepareLinkTask();
      const guess = "A".repeat(43);
      const body = await w.app.request(`/api/public/ai/share/${guess}`);
      expect(body.status).toBe(404);
      const bodyText = await body.text();
      expect(bodyText).not.toContain(guess);
      expect(bodyText).not.toContain(w.token);
      const material = await w.app.request(
        `/api/public/ai/share/${guess}/materials/0.png`,
      );
      expect(material.status).toBe(404);
      expect(await material.text()).not.toContain(w.token);
    });

    it("撤销后：正文 403 AI_SHARE_REVOKED，直连附件同样 403", async () => {
      const w = await prepareLinkTask();
      revokeAiShareTickets(w.db, {
        studentId: w.studentId,
        taskId: w.taskId,
      });
      const body = await w.app.request(`/api/public/ai/share/${w.token}`);
      expect(body.status).toBe(403);
      expect(((await body.json()) as { error: string }).error).toBe(
        "AI_SHARE_REVOKED",
      );
      const material = await w.app.request(
        `/api/public/ai/share/${w.token}/materials/0.png`,
      );
      expect(material.status).toBe(403);
      expect(((await material.json()) as { error: string }).error).toBe(
        "AI_SHARE_REVOKED",
      );
    });

    it("过期（行改写过期时刻）：正文与直连附件都 403 AI_SHARE_EXPIRED", async () => {
      const w = await prepareLinkTask();
      w.db
        .update(aiShareTickets)
        .set({ expiresAt: "2020-01-01T00:00:00.000Z" })
        .where(eq(aiShareTickets.taskId, w.taskId))
        .run();
      const body = await w.app.request(`/api/public/ai/share/${w.token}`);
      expect(body.status).toBe(403);
      expect(((await body.json()) as { error: string }).error).toBe(
        "AI_SHARE_EXPIRED",
      );
      const material = await w.app.request(
        `/api/public/ai/share/${w.token}/materials/1.png`,
      );
      expect(material.status).toBe(403);
      expect(((await material.json()) as { error: string }).error).toBe(
        "AI_SHARE_EXPIRED",
      );
    });

    it("老师中途关闭（post_submit_only 且未完成）：正文与附件新读取都 403", async () => {
      const w = await prepareLinkTask();
      w.db
        .insert(aiPolicyOverrides)
        .values({
          subjectType: "student",
          subjectId: w.studentId,
          mode: "post_submit_only",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })
        .run();
      const body = await w.app.request(`/api/public/ai/share/${w.token}`);
      expect(body.status).toBe(403);
      expect(((await body.json()) as { error: string }).error).toBe(
        "AI_POLICY_DISABLED",
      );
      const material = await w.app.request(
        `/api/public/ai/share/${w.token}/materials/0.png`,
      );
      expect(material.status).toBe(403);
    });
  });

  describe("先测②：内容面——授权答案解析可出，隐私面不可出", () => {
    it("正文 200 HTML：含题号/快照时间/有效模式/题干/参考答案/解析/学生问题/材料链接", async () => {
      const w = await prepareLinkTask();
      const res = await w.app.request(`/api/public/ai/share/${w.token}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await res.text();
      // 授权内容（受控 AI 出口例外）：题干、参考答案、官方解析、学生问题
      expect(html).toContain("题干");
      expect(html).toContain("解析");
      expect(html).toContain("SENTINEL_QUESTION");
      // 题号与快照锚点、有效模式（发送时模式）
      expect(html).toContain("第 1 题");
      expect(html).toContain("开放伴学");
      // 材料链接只指向本票据授权附件
      expect(html).toContain(`/api/public/ai/share/${w.token}/materials/0.png`);
      expect(html).toContain(`/api/public/ai/share/${w.token}/materials/1.png`);
      // 隐私面：姓名/私注/内部 UUID/绝对路径/文件 hash 一律不出
      expect(html).not.toContain(NAME_SENTINEL);
      expect(html).not.toContain(PRIVATE_NOTE_SENTINEL);
      expect(html).not.toContain(w.taskId);
      const uuids = [
        html.match(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        )?.[0],
      ];
      expect(uuids[0]).toBeUndefined();
      expect(html).not.toContain(w.dataDir.replaceAll("\\", "/"));
      expect(html).not.toContain("blobs/ai-materials");
    });

    it("材料清单只含本题任务材料：邻题任务的附件不在正文也不可直连", async () => {
      const w = await prepareLinkTask();
      // 同学生另一题建第二个任务 + 一页材料（邻题媒体哨兵）
      insertResponse(w.db, w.attemptId, "q-beta");
      const { task: otherTask } = createAiTask(
        w.db,
        {
          studentId: w.studentId,
          attemptId: w.attemptId,
          questionId: "q-beta",
          question: "邻题问题",
          channel: "link",
          mutationId: randomUUID(),
        },
        { hmacSecret: SECRET },
      );
      attachAiTaskMaterials(w.db, w.dataDir, {
        studentId: w.studentId,
        taskId: otherTask.id,
        pages: [
          {
            kind: "annotation",
            pageIndex: 0,
            pixelWidth: 320,
            pixelHeight: 200,
            png: makeNotePng(),
          },
        ],
      });
      const res = await w.app.request(`/api/public/ai/share/${w.token}`);
      const html = await res.text();
      // 本票据任务只有两页材料；第二任务的附件不可经本票据任何页号读到
      expect(html).not.toContain("materials/2.png");
      const beyond = await w.app.request(
        `/api/public/ai/share/${w.token}/materials/2.png`,
      );
      expect(beyond.status).toBe(404);
    });

    it("材料二进制权限：PNG 字节逐位相等、content-type image/png、no-store", async () => {
      const w = await prepareLinkTask();
      const res = await w.app.request(
        `/api/public/ai/share/${w.token}/materials/0.png`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes.byteLength).toBe(w.png.byteLength);
      expect(bytes).toEqual(w.png);
    });
  });

  describe("先测③：日志脱敏与缓存/索引/Referrer headers", () => {
    it("错误路径日志不含 token 明文（path 脱敏），错误壳亦不含", async () => {
      const w = await prepareLinkTask();
      revokeAiShareTickets(w.db, {
        studentId: w.studentId,
        taskId: w.taskId,
      });
      const res = await w.app.request(`/api/public/ai/share/${w.token}`);
      expect(res.status).toBe(403);
      const joined = w.logs.join("\n");
      expect(joined).not.toContain(w.token);
      // 脱敏形态：路径段替换为占位符（不能只清查询参数——token 在 path 里）
      expect(joined).toContain("/api/public/ai/share/[token]");
      expect(joined).not.toContain(w.dataDir.replaceAll("\\", "/"));
      expect((await res.text()).includes(w.token)).toBe(false);
    });

    it("正文 GET/HEAD 都带 no-store、no-referrer、noindex；HEAD 无 body", async () => {
      const w = await prepareLinkTask();
      const get = await w.app.request(`/api/public/ai/share/${w.token}`);
      expect(get.headers.get("cache-control")).toBe("no-store");
      expect(get.headers.get("referrer-policy")).toBe("no-referrer");
      expect(get.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      const head = await w.app.request(`/api/public/ai/share/${w.token}`, {
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      expect(head.headers.get("cache-control")).toBe("no-store");
      expect(head.headers.get("referrer-policy")).toBe("no-referrer");
      expect(head.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(await head.text()).toBe("");
      // 附件同款（Referrer 不外泄附件 URL）
      const materialHead = await w.app.request(
        `/api/public/ai/share/${w.token}/materials/0.png`,
        { method: "HEAD" },
      );
      expect(materialHead.headers.get("cache-control")).toBe("no-store");
      expect(materialHead.headers.get("referrer-policy")).toBe("no-referrer");
      expect(materialHead.headers.get("x-robots-tag")).toBe(
        "noindex, nofollow",
      );
      expect(await materialHead.text()).toBe("");
    });
  });

  describe("先测④：路径穿越/替换 ID/错页号不能读其他文件", () => {
    it("穿越与非法页号变体一律 404，不读任意文件", async () => {
      const w = await prepareLinkTask();
      const variants = [
        "/materials/%2e%2e%2f%2e%2e%2fsecret.png",
        "/materials/%2e%2e.png",
        "/materials/..png",
        "/materials/0.PNG",
        "/materials/0jpg",
        "/materials/-1.png",
        "/materials/99999999999999999999.png",
        "/materials/abc.png",
      ];
      for (const variant of variants) {
        const res = await w.app.request(
          `/api/public/ai/share/${w.token}${variant}`,
        );
        expect(res.status, variant).toBe(404);
      }
    });

    it("错 token 长度/字符形态不进入票据查询（404 同文案防枚举）", async () => {
      const w = await prepareLinkTask();
      const first = await w.app.request(
        "/api/public/ai/share/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      );
      const firstBody = (await first.json()) as { message: string };
      for (const bad of [
        "short",
        "x".repeat(44),
        `${w.token.slice(0, 42)}%2B`,
      ]) {
        const res = await w.app.request(`/api/public/ai/share/${bad}`);
        expect(res.status).toBe(404);
        expect(((await res.json()) as { message: string }).message).toBe(
          firstBody.message,
        );
      }
    });
  });

  describe("先测⑤：读取副作用——HEAD 不记已读、附件不产生事实、不重复计数", () => {
    it("HEAD 不记已读；GET 记 link_viewed（source=unknown）；任务状态不动", async () => {
      const w = await prepareLinkTask();
      const head = await w.app.request(`/api/public/ai/share/${w.token}`, {
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      let ticket = w.db
        .select()
        .from(aiShareTickets)
        .where(eq(aiShareTickets.taskId, w.taskId))
        .all()[0];
      expect(ticket?.viewCount).toBe(0);
      expect(ticket?.lastViewedAt).toBeNull();
      const get = await w.app.request(`/api/public/ai/share/${w.token}`);
      expect(get.status).toBe(200);
      ticket = w.db
        .select()
        .from(aiShareTickets)
        .where(eq(aiShareTickets.taskId, w.taskId))
        .all()[0];
      expect(ticket?.viewCount).toBe(1);
      const facts = w.db
        .select()
        .from(aiFacts)
        .where(eq(aiFacts.taskId, w.taskId))
        .all();
      // 事实族：创建 + 生成票据 + 一次读取；无 reply_*/dispatched/已读冒充
      expect(facts.map((row) => row.type)).toEqual([
        "task_created",
        "link_generated",
        "link_viewed",
      ]);
      const task = w.db
        .select()
        .from(aiTasks)
        .all()
        .find((row) => row.id === w.taskId);
      expect(task?.status).toBe("created");
      expect(task?.replyDeliveredAt).toBeNull();
    });

    it("多次正文/附件读取：viewCount 递增但不产生新任务或回复事实（不重复计数求助）", async () => {
      const w = await prepareLinkTask();
      for (let i = 0; i < 3; i += 1) {
        const body = await w.app.request(`/api/public/ai/share/${w.token}`);
        expect(body.status).toBe(200);
        const material = await w.app.request(
          `/api/public/ai/share/${w.token}/materials/0.png`,
        );
        expect(material.status).toBe(200);
      }
      const ticket = w.db
        .select()
        .from(aiShareTickets)
        .where(eq(aiShareTickets.taskId, w.taskId))
        .all()[0];
      expect(ticket?.viewCount).toBe(3); // 附件读取不记正文已读
      const facts = w.db
        .select()
        .from(aiFacts)
        .where(eq(aiFacts.taskId, w.taskId))
        .all();
      expect(facts.map((row) => row.type)).toEqual([
        "task_created",
        "link_generated",
        "link_viewed",
        "link_viewed",
        "link_viewed",
      ]);
      // 求助题数不因读取重复累计：任务行数不变
      expect(w.db.select().from(aiTasks).all()).toHaveLength(1);
    });
  });

  it("正文含材料缺失明确说明（缺件不假成功、不给死链）", async () => {
    const w = await prepareLinkTask();
    // 删除材料文件制造缺件（行 ready 文件无）：正文必须明确说明，直连附件
    // 返回明确错误——都不用空白图或静默省略假成功
    const { loadAiTaskMaterialRows } = await import(
      "../services/ai-companion/student-ai-materials.ts"
    );
    const materialRows = loadAiTaskMaterialRows(w.db, w.taskId);
    expect(materialRows).toHaveLength(2);
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const row of materialRows) {
      fs.rmSync(path.join(w.dataDir, row.pngPath), { force: true });
    }
    const body = await w.app.request(`/api/public/ai/share/${w.token}`);
    expect(body.status).toBe(200);
    const html = await body.text();
    expect(html).toContain("缺失");
    // 直连缺件附件：明确错误（AI_MATERIAL_BROKEN），不是空白图假成功
    const material = await w.app.request(
      `/api/public/ai/share/${w.token}/materials/0.png`,
    );
    expect(material.status).toBe(500);
    expect(((await material.json()) as { error: string }).error).toBe(
      "AI_MATERIAL_BROKEN",
    );
  });
});

describe("LR-PR5 学习记录段（评审 #12249 必改②锁）", () => {
  it("学习记录 JSON 过契约、anchors 键 ∈ 笔画 id、不携带 taskId 与 responses 行 id", async () => {
    const w = world();
    // 圈画材料在任务创建**之前**落（创建时钉进 recordRefs）：一笔 UUID 笔画 + 锚点
    const strokeId = randomUUID();
    const doc = {
      version: 1,
      baseWidth: 100,
      baseHeight: 80,
      strokes: [
        {
          tool: "pen",
          color: "#1f2328",
          weight: 4,
          id: strokeId,
          startedAt: 1,
          pointer: "pen",
          points: [{ x: 1, y: 2, p: 0.5, t: 0 }],
        },
      ],
      anchors: { [strokeId]: "stem/p/0" },
    };
    const relBody = `blobs/annotation-bodies/${randomUUID()}.json.gz`;
    mkdirSync(join(w.dataDir, "blobs/annotation-bodies"), { recursive: true });
    writeFileSync(
      join(w.dataDir, relBody),
      gzipSync(Buffer.from(JSON.stringify(doc))),
    );
    const baseId = randomUUID();
    w.db
      .insert(annotationBases)
      .values({
        id: baseId,
        attemptId: w.attemptId,
        questionId: "q-alpha",
        questionRevisionId: w.responseId,
        phase: "scratch",
        snapshotHash: "c".repeat(64),
        baseRenderVersion: 2,
        state: "ready",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    w.db
      .insert(annotations)
      .values({
        id: randomUUID(),
        attemptId: w.attemptId,
        questionId: "q-alpha",
        phase: "scratch",
        baseId,
        revision: 1,
        bodyPath: relBody,
        hash: "d".repeat(64),
        strokeCount: 1,
        pointCount: 1,
        sealedAt: null,
        updatedAt: new Date().toISOString(),
      })
      .run();
    const { task } = createAiTask(
      w.db,
      {
        studentId: w.studentId,
        attemptId: w.attemptId,
        questionId: "q-alpha",
        question: "这道题第二问的思路是什么？SENTINEL_QUESTION",
        channel: "link",
        mutationId: randomUUID(),
      },
      { hmacSecret: SECRET },
    );
    const { token } = createAiShareTicket(w.db, {
      studentId: w.studentId,
      taskId: task.id,
    });
    const res = await w.app.request(`/api/public/ai/share/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const match =
      /<script type="application\/json" id="learning-record">([\s\S]*?)<\/script>/.exec(
        html,
      );
    expect(match).not.toBeNull();
    const raw = match?.[1];
    if (raw === undefined) throw new Error("页面未内嵌 learning-record JSON");
    const view = JSON.parse(raw) as unknown;
    expect(learningRecordAiViewSchema.safeParse(view).success).toBe(true);
    const typed = view as {
      record: {
        ink: Array<{
          strokes: Array<{ id?: string }>;
          deleted: Array<{ id?: string }>;
          anchors?: Record<string, string>;
        }>;
        timeline: { entries: Array<{ detail?: Record<string, unknown> }> };
      };
    };
    const strokeIds = typed.record.ink.flatMap((facet) => [
      ...facet.strokes.map((s) => s.id ?? ""),
      ...facet.deleted.map((s) => s.id ?? ""),
    ]);
    for (const facet of typed.record.ink) {
      for (const key of Object.keys(facet.anchors ?? {})) {
        expect(strokeIds).toContain(key);
      }
    }
    expect(JSON.stringify(typed.record.timeline)).not.toContain('"taskId"');
    // responses 行 id（record identity 的 questionRevisionId）已投影为占位
    expect(html).not.toContain(w.responseId);
  });
});
