import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MEMO_JSON_BODY_MAX_BYTES,
  MEMO_METADATA_MAX_BYTES,
  MEMO_OUTBOX_ACCOUNT_HEADER,
  MEMO_TEXT_MAX,
  memoSchema,
} from "@tutor/contract";
import { eq } from "drizzle-orm";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { createStudentSession } from "../auth/session.ts";
import { memos, units } from "../db/schema.ts";
import {
  createTestDb,
  createTestDir,
  seedLessonWithEmbeddedUnit,
} from "../db/test-utils.ts";
import { assertNoLeak } from "../test/assert-no-leak.ts";
import {
  frozenDraftAttempt,
  snapshotJsonOf,
} from "../test/evidence-fixtures.ts";
import { makeNotePng, makeStudent } from "../test/note-fixtures.ts";

function setup() {
  const db = createTestDb();
  const dataDir = createTestDir();
  const studentId = makeStudent(db);
  const app = createApp({
    db,
    dataDir,
    publicUrl: "http://localhost",
    isProduction: false,
    logger: pino({ enabled: false }),
  });
  const headers = {
    cookie: `tutor_student_session=${createStudentSession(db, studentId).token}`,
    [MEMO_OUTBOX_ACCOUNT_HEADER]: studentId,
  };
  const post = (body: object, extra: Record<string, string> = {}) =>
    app.request("/api/student/memos", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", ...extra },
      body: JSON.stringify(body),
    });
  const media = (anchor: object, extra?: (form: FormData) => void) => {
    const form = new FormData();
    form.set("clientId", randomUUID());
    form.set("kind", "image");
    form.set("anchor", JSON.stringify(anchor));
    form.set(
      "file",
      new Blob([new Uint8Array(makeNotePng()).buffer]),
      "memo.png",
    );
    extra?.(form);
    return app.request("/api/student/memos/media", {
      method: "POST",
      headers,
      body: form,
    });
  };
  const assertRejected = async (response: Response) => {
    expect(response.status).toBe(413);
    const body = await response.json();
    assertNoLeak(body);
    expect(body).toMatchObject({ ok: false, error: "MEMO_METADATA_TOO_LARGE" });
    expect(db.select().from(memos).all()).toHaveLength(0);
    const listed = await app.request("/api/student/memos", { headers });
    expect(listed.status).toBe(200);
    const bytes = await listed.text();
    expect(Buffer.byteLength(bytes)).toBeLessThan(512);
    expect(JSON.parse(bytes)).toMatchObject({ data: { memos: [] } });
  };
  return { db, app, dataDir, studentId, headers, post, media, assertRejected };
}

const hugeAnchor = () => ({
  kind: "question",
  attemptId: randomUUID(),
  questionId: "x".repeat(256 * 1024),
  label: "来源",
});

describe("随笔元数据总字节与请求流闸门", () => {
  it("三字正文加256KiB无效旧锚不落库、不放大列表、补传不占序号", async () => {
    const env = setup();
    const input = {
      clientId: randomUUID(),
      text: "小记录",
      anchor: hugeAnchor(),
    };
    for (let retry = 0; retry < 2; retry += 1)
      await env.assertRejected(await env.post(input));
    const valid = await env.post({ clientId: randomUUID(), text: "正常" });
    expect(valid.status).toBe(201);
    expect(
      memoSchema.parse(((await valid.json()) as { data: unknown }).data).seq,
    ).toBe(1);
  });

  it.each([undefined, "1"])(
    "无/虚假Content-Length=%s时按实际流计数拒绝，不读完整超量请求",
    async (declared) => {
      const env = setup();
      const encoded = new TextEncoder().encode(
        JSON.stringify({
          clientId: randomUUID(),
          text: "小记录",
          anchor: hugeAnchor(),
        }),
      );
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= encoded.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(pulled + 4096, encoded.byteLength);
          controller.enqueue(encoded.subarray(pulled, end));
          pulled = end;
        },
      });
      const response = await env.app.request("/api/student/memos", {
        method: "POST",
        headers: {
          ...env.headers,
          "content-type": "application/json",
          ...(declared === undefined ? {} : { "content-length": declared }),
        },
        body: stream,
        duplex: "half",
      } as RequestInit);
      await env.assertRejected(response);
      expect(pulled).toBeLessThan(encoded.byteLength);
    },
  );

  it("声明的Content-Length过大时明确413", async () => {
    const env = setup();
    await env.assertRejected(
      await env.post(
        { clientId: randomUUID(), text: "小记录", anchor: hugeAnchor() },
        { "content-length": String(256 * 1024) },
      ),
    );
  });

  it("显式context不能经大标题输入绕过总量闸门", async () => {
    const env = setup();
    await env.assertRejected(
      await env.post({
        clientId: randomUUID(),
        text: "小记录",
        context: {
          schemaVersion: 1,
          content: {
            courseId: null,
            unitId: null,
            lectureId: null,
            sectionId: null,
            questionId: null,
            titles: {
              course: null,
              unit: "x".repeat(256 * 1024),
              lecture: null,
            },
          },
          session: null,
          view: null,
          deviceId: null,
        },
      }),
    );
  });

  it("媒体非文件元数据也受同一预算约束，拒绝时不写blob", async () => {
    const env = setup();
    await env.assertRejected(await env.media(hugeAnchor()));
    expect(existsSync(join(env.dataDir, "blobs", "memos"))).toBe(false);
  });

  it("真实来源展开后超过预算也明确拒绝，文字和媒体都不部分落库", async () => {
    const env = setup();
    const { unitId } = seedLessonWithEmbeddedUnit(env.db, {
      unitTitle: "长".repeat(30_000),
    });
    env.db
      .update(units)
      .set({ lectureId: null })
      .where(eq(units.id, unitId))
      .run();
    const { attemptId } = frozenDraftAttempt(
      env.db,
      env.studentId,
      [
        {
          questionId: "q1",
          snapshotJson: snapshotJsonOf({ id: "q1" }),
          unitId,
        },
      ],
      { attemptUnitId: unitId },
    );
    const anchor = {
      kind: "question",
      attemptId,
      questionId: "q1",
      label: "合法来源",
    };
    await env.assertRejected(
      await env.post({ clientId: randomUUID(), text: "小记录", anchor }),
    );
    await env.assertRejected(await env.media(anchor));
    expect(existsSync(join(env.dataDir, "blobs", "memos"))).toBe(false);
  });
});

function boundedInput(bytes: number, chinese = false) {
  const anchor = {
    kind: "question",
    attemptId: randomUUID(),
    questionId: "",
    label: "来源",
  };
  const measure = () =>
    Buffer.byteLength(
      JSON.stringify({
        anchor,
        context: null,
        tags: [],
        device: "other",
        deviceId: null,
        recordedAt: null,
      }),
      "utf8",
    );
  const room = bytes - measure();
  anchor.questionId = chinese
    ? "界".repeat(Math.floor(room / 3)) + "x".repeat(room % 3)
    : "x".repeat(room);
  expect(measure()).toBe(bytes);
  return { clientId: randomUUID(), text: "小记录", anchor };
}

it.each([-1, 0, 1])(
  "JSON与媒体同一元数据预算偏移%i，按UTF-8字节计且不截断",
  async (delta) => {
    for (const media of [false, true]) {
      const env = setup();
      const input = boundedInput(MEMO_METADATA_MAX_BYTES + delta, true);
      const response = media
        ? await env.media(input.anchor)
        : await env.post(input);
      if (delta > 0) {
        await env.assertRejected(response);
        continue;
      }
      expect(response.status).toBe(201);
      const memo = memoSchema.parse(
        ((await response.json()) as { data: unknown }).data,
      );
      expect(memo.anchor).toMatchObject({
        questionId: input.anchor.questionId,
      });
      expect(memo.seq).toBe(1);
    }
  },
);

it("正文最坏JSON转义仍有独立信封余量，不缩小5000字符正文语义", async () => {
  const env = setup();
  const input = {
    ...boundedInput(MEMO_METADATA_MAX_BYTES),
    text: "\u0001".repeat(MEMO_TEXT_MAX),
  };
  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(
    MEMO_JSON_BODY_MAX_BYTES,
  );
  const response = await env.post(input);
  expect(response.status).toBe(201);
  expect(
    memoSchema.parse(((await response.json()) as { data: unknown }).data).text,
  ).toBe(input.text);
});

it("已成功条目的超限补传也不修改原文、不占新序号", async () => {
  const env = setup();
  const clientId = randomUUID();
  const first = await env.post({ clientId, text: "原文" });
  expect(first.status).toBe(201);
  const rejected = await env.post({
    ...boundedInput(MEMO_METADATA_MAX_BYTES + 1),
    clientId,
  });
  expect(rejected.status).toBe(413);
  expect(env.db.select().from(memos).all()).toMatchObject([
    { text: "原文", seq: 1 },
  ]);
  const next = await env.post({ clientId: randomUUID(), text: "下一条" });
  expect(
    memoSchema.parse(((await next.json()) as { data: unknown }).data).seq,
  ).toBe(2);
});

it("显式context在JSON信封以内仍执行元数据预算", async () => {
  const env = setup();
  const body = {
    clientId: randomUUID(),
    text: "小记录",
    context: {
      schemaVersion: 1,
      content: {
        courseId: null,
        unitId: null,
        lectureId: null,
        sectionId: null,
        questionId: null,
        titles: {
          course: null,
          unit: "x".repeat(MEMO_METADATA_MAX_BYTES),
          lecture: null,
        },
      },
      session: null,
      view: null,
      deviceId: null,
    },
  };
  expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(
    MEMO_JSON_BODY_MAX_BYTES,
  );
  await env.assertRejected(await env.post(body));
});

it("媒体重复或未知文本字段也受信封总量限制，文件大小不挤占元数据预算", async () => {
  const env = setup();
  await env.assertRejected(
    await env.media({ kind: "none" }, (form) => {
      form.append(
        "ignored",
        "界".repeat(Math.ceil(MEMO_JSON_BODY_MAX_BYTES / 3)),
      );
      form.append("ignored", "重复");
    }),
  );
  const valid = await env.media({ kind: "none" }, (form) =>
    form.set(
      "file",
      new Blob([new Uint8Array(makeNotePng(320, 200, 1024 * 1024)).buffer]),
      "large.png",
    ),
  );
  expect(valid.status).toBe(201);
});
