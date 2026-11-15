import { describe, expect, it } from "vitest";
import {
  formatMemoDuration,
  MEMO_TAGS_MAX,
  MEMO_TEXT_MAX,
  memoAgentCreateSchema,
  memoAnchorSchema,
  memoCreateMediaSchema,
  memoCreateTextSchema,
  memoListQuerySchema,
  memoMediaUrl,
  memoSchema,
  normalizeMemoTags,
} from "./memo-api.ts";

const ID = "11111111-1111-4111-8111-111111111111";

const TEXT_MEMO = {
  id: ID,
  kind: "text",
  text: "资料分析增长率题我总把基期当现期",
  media: null,
  anchor: {
    kind: "question",
    attemptId: "a-1",
    questionId: "q-7",
    label: "第 7 题 · 资料分析专项",
  },
  tags: ["易错"],
  source: "self",
  device: "tablet",
  createdAt: "2026-11-10T08:00:00.000Z",
  recordedAt: "2026-11-10T07:58:00.000Z",
} as const;

describe("随笔契约（模块 5 第一步）", () => {
  it("一条随笔：文字无媒体、语音带媒体元信息、形态值域锁定", () => {
    expect(memoSchema.parse(TEXT_MEMO)).toEqual(TEXT_MEMO);
    const voice = memoSchema.parse({
      ...TEXT_MEMO,
      kind: "voice",
      text: null,
      media: { format: "m4a", bytes: 123_456, durationSec: 62 },
      anchor: { kind: "none" },
      tags: [],
      source: "agent",
      device: "phone",
    });
    expect(voice.media?.durationSec).toBe(62);
    expect(memoSchema.safeParse({ ...TEXT_MEMO, kind: "video" }).success).toBe(
      false,
    );
    expect(
      memoSchema.safeParse({
        ...TEXT_MEMO,
        media: { format: "exe", bytes: 1, durationSec: null },
      }).success,
    ).toBe(false);
  });

  it("锚：题 / 讲义节 / 无锚三种；label 必填且有上限", () => {
    expect(
      memoAnchorSchema.parse({
        kind: "lecture",
        lectureId: "l-1",
        sectionId: null,
        label: "《导数》",
      }).kind,
    ).toBe("lecture");
    expect(memoAnchorSchema.parse({ kind: "none" })).toEqual({ kind: "none" });
    expect(
      memoAnchorSchema.safeParse({
        kind: "question",
        attemptId: "a",
        questionId: "q",
        label: "",
      }).success,
    ).toBe(false);
    expect(
      memoAnchorSchema.safeParse({ kind: "attachment", attachmentId: "x" })
        .success,
    ).toBe(false);
  });

  it("创建文字随笔：clientId 必须是 UUID、正文去空白后非空且 ≤ 上限", () => {
    const ok = memoCreateTextSchema.parse({
      clientId: ID,
      text: "  今天的错题要重做  ",
      tags: ["待办"],
      recordedAt: "2026-11-10T07:58:00+08:00",
    });
    expect(ok.text).toBe("今天的错题要重做");
    expect(
      memoCreateTextSchema.safeParse({ clientId: "not-uuid", text: "x" })
        .success,
    ).toBe(false);
    expect(
      memoCreateTextSchema.safeParse({ clientId: ID, text: "   " }).success,
    ).toBe(false);
    expect(
      memoCreateTextSchema.safeParse({
        clientId: ID,
        text: "x".repeat(MEMO_TEXT_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      memoCreateTextSchema.safeParse({
        clientId: ID,
        text: "x",
        tags: Array.from({ length: MEMO_TAGS_MAX + 1 }, (_, i) => `t${i}`),
      }).success,
    ).toBe(false);
  });

  it("创建媒体随笔：形态只能是语音 / 图片 / 手写，时长 ≤ 10 分钟", () => {
    expect(
      memoCreateMediaSchema.parse({
        clientId: ID,
        kind: "voice",
        durationSec: 5,
      }).kind,
    ).toBe("voice");
    expect(
      memoCreateMediaSchema.safeParse({ clientId: ID, kind: "text" }).success,
    ).toBe(false);
    expect(
      memoCreateMediaSchema.safeParse({
        clientId: ID,
        kind: "voice",
        durationSec: 601,
      }).success,
    ).toBe(false);
  });

  it("列表查询：limit 从字符串强制为数字且 ≤ 100；since 须为 ISO 时间", () => {
    expect(memoListQuerySchema.parse({ limit: "20", kind: "voice" })).toEqual({
      limit: 20,
      kind: "voice",
    });
    expect(memoListQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
    expect(memoListQuerySchema.safeParse({ since: "昨天" }).success).toBe(
      false,
    );
  });

  it("Agent 转记入参：锚只报 id 不带 label；无锚可省", () => {
    expect(
      memoAgentCreateSchema.parse({
        text: "记一下：增长率题基期现期",
        anchor: { kind: "question", attemptId: "a", questionId: "q" },
      }).anchor?.kind,
    ).toBe("question");
    expect(memoAgentCreateSchema.parse({ text: "x" }).anchor).toBeUndefined();
    expect(
      memoAgentCreateSchema.safeParse({ text: "x", anchor: { kind: "none" } })
        .success,
    ).toBe(false);
  });

  it("工具函数：媒体 URL、时长、标签规范化", () => {
    expect(memoMediaUrl("a b")).toBe("/api/student/memos/a%20b/media");
    expect(formatMemoDuration(62)).toBe("1:02");
    expect(formatMemoDuration(0)).toBe("0:00");
    expect(normalizeMemoTags([" 易错 ", "易错", "", "疑问"])).toEqual([
      "易错",
      "疑问",
    ]);
    expect(normalizeMemoTags(["1", "2", "3", "4", "5", "6", "7"])).toHaveLength(
      MEMO_TAGS_MAX,
    );
    expect(normalizeMemoTags(["x".repeat(21)])).toEqual([]);
  });
});

describe("随笔范围与Agent上下文", () => {
  it("课程/单元/题及序号区间保留到查询，完整上下文不被丢弃", () => {
    const query = {
      courseId: "course",
      unitId: "unit",
      questionId: "q1",
      seqFrom: 12,
      seqTo: 19,
      parentMemoSeq: 12,
    };
    expect(memoListQuerySchema.parse(query)).toEqual(query);
    const context = {
      schemaVersion: 1,
      content: {
        courseId: null,
        unitId: null,
        lectureId: null,
        sectionId: null,
        questionId: null,
        titles: { course: null, unit: null, lecture: null },
      },
      session: null,
      view: null,
      deviceId: null,
    };
    expect(
      memoAgentCreateSchema.parse({ text: "Agent转记", context }).context,
    ).toEqual(context);
    expect(memoListQuerySchema.safeParse({ seqFrom: 0 }).success).toBe(false);
    expect(memoListQuerySchema.safeParse({ seqTo: -1 }).success).toBe(false);
  });
});
