import { expect, it } from "vitest";
import {
  type TimeEvidenceRow,
  timeEvidenceSessions,
} from "./attempt-time-evidence";
import { replaySession, type Tally } from "./question-activity-replay";

it("跨view提示只追认收件时最近focus，服务器时钟不恢复idle", () => {
  const event = (
    seq: number,
    type: string,
    clientTs: number,
    questionId: string | null,
    viewId: string | null,
    origin: "client" | "server" = "client",
  ): TimeEvidenceRow => ({ seq, type, clientTs, questionId, viewId, origin });
  const input = [
    event(1, "question_focus", 1000, "q1", "a"),
    event(2, "idle_start", 2000, null, "a"),
    event(3, "hint_open", 999999999, "q1", null, "server"),
    event(4, "question_focus", 3000, "q1", "b"),
    event(5, "question_blur", 6000, "q1", "b"),
    event(6, "question_blur", 5000, "q1", "a"),
  ];
  const normalized = timeEvidenceSessions(input, new Set(["q1"])),
    tallies = new Map<string, Tally>();
  const segments = [...normalized.sessions].flatMap(([view, list]) =>
    replaySession(view, list, tallies),
  );
  expect(segments).toEqual([
    { session: "a", questionId: "q1", start: 1000, end: 2000, active: true },
    { session: "b", questionId: "q1", start: 3000, end: 6000, active: false },
  ]);
  expect(tallies.get("q1")?.actions).toBe(1);
});
it("真实question_submit已在receipt中时不重复合成提交动作", () => {
  const rows: TimeEvidenceRow[] = [
    {
      seq: 1,
      type: "question_focus",
      clientTs: 1000,
      questionId: "q1",
      viewId: "a",
      origin: "client",
    },
    {
      seq: 2,
      type: "question_blur",
      clientTs: 2000,
      questionId: "q1",
      viewId: "a",
      origin: "client",
    },
    {
      seq: 3,
      type: "question_submit",
      clientTs: 999999,
      questionId: "q1",
      viewId: null,
      origin: "server",
    },
  ];
  const normalized = timeEvidenceSessions(rows, new Set(["q1"]), ["q1"]),
    tallies = new Map<string, Tally>();
  for (const [view, list] of normalized.sessions)
    replaySession(view, list, tallies);
  expect(tallies.get("q1")?.actions).toBe(1);
});
