import { expect, it } from "vitest";
import { allocateTimeSpans } from "./attempt-time-attribution";

const active = (questionId: string, start: number, end: number) => ({
  questionId,
  start,
  end,
  active: true,
  session: questionId,
});
it("已知异题冲突封存排除，同批数组顺序无影响", () => {
  const input = [active("q1", 0, 10000), active("q2", 5000, 15000)];
  expect(allocateTimeSpans(input, new Set(["q1"]), [])).toEqual([
    { questionId: "q1", kind: "active", start: 0, end: 5000 },
    { questionId: null, kind: "unattributed", start: 5000, end: 10000 },
  ]);
  expect(allocateTimeSpans(input, new Set(["q2", "q1"]), [])).toEqual(
    allocateTimeSpans(input, new Set(["q1", "q2"]), []),
  );
});
it("迟到题扣旧封存区间，不改旧账也不重复追加排除", () => {
  expect(
    allocateTimeSpans([active("q2", 5000, 15000)], new Set(["q2"]), [
      { start: 0, end: 10000 },
    ]),
  ).toEqual([{ questionId: "q2", kind: "active", start: 10000, end: 15000 }]);
});
it("同题多端并集且活动优先，observed同样占用", () => {
  expect(
    allocateTimeSpans(
      [active("q1", 0, 10), { ...active("q1", 5, 15), active: false }],
      new Set(["q1"]),
      [],
    ),
  ).toEqual([
    { questionId: "q1", kind: "active", start: 0, end: 10 },
    { questionId: "q1", kind: "observed", start: 10, end: 15 },
  ]);
});
