import { describe, expect, it } from "vitest";
import { resumeReadingPosition } from "./use-reading-position";

describe("分批后的跨设备续做", () => {
  const resume = { nextQuestionId: "q2", submittedQuestionIds: ["q1"] };
  it("本机未提交题位置优先；已提交位置或新设备回退服务端", () => {
    expect(
      resumeReadingPosition({ questionId: "q3", offset: 45 }, resume),
    ).toEqual({ questionId: "q3", offset: 45 });
    expect(
      resumeReadingPosition({ questionId: "q1", offset: 45 }, resume),
    ).toEqual({ questionId: "q2", offset: 0 });
    expect(resumeReadingPosition(null, resume)).toEqual({
      questionId: "q2",
      offset: 0,
    });
    expect(resumeReadingPosition(null)).toBeNull();
  });
});
