import type { AttemptDetailData, AttemptDraftData } from "@tutor/contract";
import { attemptSubmitRequestSchema } from "@tutor/contract";

/**
 * T6R.3 交卷回传辅助（路由测试共用）：取 attempt 详情，收集草稿视图每题
 * questionRevisionId 作为交卷请求体——与前端真实流程一致（取卷渲染 → 交卷
 * 原样回传版本集合）。
 *
 * 宽松口径：详情取不到（未登录/无权限/不存在）或已是结果视图（重复交卷走
 * 409 ALREADY_SUBMITTED，不触发版本验证）时返回空集合——这些用例的交卷
 * 预期同样是 4xx，空 body 不改变断言结果。
 */
export async function fetchSubmitRevisions(
  app: {
    request: (path: string, init?: RequestInit) => Promise<Response> | Response;
  },
  cookie: string | undefined,
  attemptId: string,
): Promise<ReturnType<typeof attemptSubmitRequestSchema.parse>["revisions"]> {
  if (cookie === undefined) return [];
  const res = await app.request(`/api/student/attempts/${attemptId}`, {
    headers: { cookie },
  });
  if (res.status !== 200) return [];
  const parsed = ((await res.json()) as { data: AttemptDetailData }).data;
  // 契约 union 的判别键在嵌套 attempt.status 上（TS 无法自动收窄）；服务端
  // 保证状态-形态一致，draft 时按草稿视图取题（结果视图无题目版本可取）
  const revisions =
    parsed.attempt.status === "draft"
      ? (parsed as AttemptDraftData).units.flatMap((unit) =>
          unit.questions.map((question) => ({
            questionId: question.id,
            questionRevisionId: question.questionRevisionId,
          })),
        )
      : [];
  return attemptSubmitRequestSchema.parse({ revisions }).revisions;
}

/**
 * 交卷请求的统一发送（路由测试 13 个文件共用——收敛各自手写的
 * fetchSubmitRevisions + POST body 样板）：自动取详情里的题目版本集合并随
 * 请求体回传（与前端同流程）；详情取不到（未登录/无权限/不存在）按空集合
 * 提交——这些用例的交卷预期同样是 4xx，空 body 不改变断言结果。
 */
export async function submitAttemptRequest(
  app: {
    request: (path: string, init?: RequestInit) => Promise<Response> | Response;
  },
  cookie: string | undefined,
  attemptId: string,
): Promise<Response> {
  const revisions = await fetchSubmitRevisions(app, cookie, attemptId);
  return Promise.resolve(
    app.request(`/api/student/attempts/${attemptId}/submit`, {
      method: "POST",
      headers: cookie === undefined ? {} : { cookie },
      body: JSON.stringify({ revisions }),
    }),
  );
}
