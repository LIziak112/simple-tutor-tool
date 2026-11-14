import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createStudentSession } from "../auth/session.ts";
import { makeStudent } from "../test/note-fixtures.ts";
import { studentPracticeReadEnv } from "../test/student-mcp-practice-fixtures.ts";

const opened: Awaited<ReturnType<typeof studentPracticeReadEnv>>[] = [];
afterEach(async () => {
  for (const env of opened.splice(0)) {
    await env.client.close();
    env.db.$client.close();
  }
});
describe.each(["class", "personal"] as const)("%s 分批HTTP出口", (kind) => {
  it("本批结果无批外题，重放不缓存，跨账号404", async () => {
    const env = await studentPracticeReadEnv(kind);
    opened.push(env);
    const request = {
      workflowVersion: 1,
      workflowRevision: 0,
      mutationId: randomUUID(),
      questions: [
        {
          questionId: "q-1",
          questionRevisionId: env.revisions[0],
          expectedAnswerRevision: 0,
          evidence: { questionId: "q-1", state: "none" },
        },
      ],
    };
    const url = `/api/student/attempts/${env.practiceId}/settlements`;
    const post = () =>
      env.app.request(url, {
        method: "POST",
        headers: { cookie: env.cookie, "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body: unknown = await response.json();
    expect(JSON.stringify(body)).not.toContain('"q-2"');
    expect(body).toMatchObject({
      ok: true,
      data: {
        settlement: { kind: "partial", seq: 1, questionCount: 1 },
        questions: [{ questionId: "q-1" }],
        questionNos: { "q-1": 1 },
      },
    });
    expect(await (await post()).json()).toEqual(body);
    expect(
      await (
        await env.app.request(`${url}/1`, { headers: { cookie: env.cookie } })
      ).json(),
    ).toEqual(body);
    const other = makeStudent(env.db);
    const cookie = `tutor_student_session=${createStudentSession(env.db, other).token}`;
    const denied = await env.app.request(`${url}/1`, { headers: { cookie } });
    expect(denied.status).toBe(404);
    expect(JSON.stringify(await denied.json())).not.toContain('"q-1"');
    expect((await env.app.request(`${url}/1`)).status).toBe(401);
  });
});
