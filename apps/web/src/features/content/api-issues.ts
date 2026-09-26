import { type LintIssue, lintIssueSchema } from "@tutor/contract";

/**
 * 从 ApiError.extra（统一壳之外的附加字段）解析 _issues 列表（T1.10 commit /
 * T1.12 单条编辑的 422 LINT_ERROR 都携带）。逐条过契约，坏条目丢弃不炸面板。
 */
export function parseApiIssues(
  extra: Record<string, unknown> | undefined,
): LintIssue[] {
  const raw = extra?._issues;
  if (!Array.isArray(raw)) return [];
  const list: LintIssue[] = [];
  for (const item of raw) {
    const parsed = lintIssueSchema.safeParse(item);
    if (parsed.success) list.push(parsed.data);
  }
  return list;
}
