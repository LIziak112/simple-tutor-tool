import type { ReplayEvent } from "./question-activity-replay";

export interface TimeEvidenceRow {
  seq: number;
  origin: "client" | "server";
  type: string;
  clientTs: number;
  questionId: string | null;
  viewId: string | null;
}
/** 来源用receipt证明；服务器动作指向收件当时最近focus，不用服务器epoch开关区间。 */
export function timeEvidenceSessions(
  input: readonly TimeEvidenceRow[],
  validQuestions: ReadonlySet<string>,
  submittedQuestions: readonly string[] = [],
) {
  const rows = [...input].sort((a, b) => a.seq - b.seq);
  const client = rows.filter(
    (r) =>
      r.origin === "client" &&
      (r.questionId === null || validQuestions.has(r.questionId)),
  );
  const badQuestions = new Set(
    client
      .filter((r) => !Number.isSafeInteger(r.clientTs) || r.clientTs < 0)
      .map((r) => r.questionId),
  );
  const seen = new Set<string>();
  const accepted = client
    .filter(
      (r) =>
        Number.isSafeInteger(r.clientTs) &&
        r.clientTs >= 0 &&
        r.type !== "submit",
    )
    .filter((r) => {
      const key = JSON.stringify([r.type, r.clientTs, r.questionId, r.viewId]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const acceptedSeq = new Set(accepted.map((r) => r.seq));
  const sessions = new Map<string, ReplayEvent[]>();
  const focus = new Map<string, TimeEvidenceRow>();
  const actions: ReplayEvent[] = [];
  const submittedEpisodes = new Set<number>();
  for (const row of rows) {
    if (
      acceptedSeq.has(row.seq) &&
      row.type === "question_focus" &&
      row.questionId !== null
    )
      focus.set(row.questionId, row);
    if (
      row.origin === "server" &&
      (row.type === "hint_open" || row.type === "question_submit") &&
      row.questionId !== null &&
      validQuestions.has(row.questionId)
    ) {
      const target = focus.get(row.questionId);
      if (target && row.type === "question_submit")
        submittedEpisodes.add(target.seq);
      if (target)
        actions.push({
          type: row.type,
          questionId: row.questionId,
          viewId: target.viewId,
          clientTs: 0,
          serverRecorded: true,
          episodeId: target.seq,
        });
    }
  }
  for (const questionId of submittedQuestions) {
    const target = focus.get(questionId);
    if (target && !submittedEpisodes.has(target.seq))
      actions.push({
        type: "question_submit",
        questionId,
        viewId: target.viewId,
        clientTs: 0,
        serverRecorded: true,
        episodeId: target.seq,
      });
  }
  for (const row of accepted.sort(
    (a, b) => a.clientTs - b.clientTs || a.seq - b.seq,
  )) {
    const key = row.viewId ?? "",
      list = sessions.get(key) ?? [];
    list.push({
      ...row,
      ...(row.type === "question_focus" ? { episodeId: row.seq } : {}),
    });
    sessions.set(key, list);
  }
  // 动作在客户端回放后追认指定episode，绝不恢复idle或延长流尾。
  for (const action of actions) sessions.get(action.viewId ?? "")?.push(action);
  return { sessions, badQuestions, badGlobal: badQuestions.has(null) };
}
