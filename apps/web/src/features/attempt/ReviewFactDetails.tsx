import { type ReviewQuestionFact, rubricEffectiveOf } from "@tutor/contract";
/** 两端使用同一事实呈现量表；Agent意见不混作本人有效档位。 */
export function ReviewFactDetails({ fact }: { fact: ReviewQuestionFact }) {
  const review = fact.rubricReview;
  if (review === null) return null;
  const effective = rubricEffectiveOf(review);
  return (
    <section
      aria-label="量表记录"
      className="rounded-lg border border-border p-3 text-sm"
    >
      <h3 className="font-medium">量表记录</h3>
      <table className="w-full text-left">
        <thead>
          <tr>
            <th>评价项</th>
            <th>自评</th>
            <th>Agent 意见</th>
            <th>本人裁定</th>
            <th>当前档位</th>
          </tr>
        </thead>
        <tbody>
          {review.rubric.items.map((item) => (
            <tr key={item.id}>
              <th>{item.title}</th>
              <td>
                {review.self?.ratings.find((r) => r.id === item.id)?.level ??
                  "—"}
              </td>
              <td>
                {review.agent?.ratings.find((r) => r.id === item.id)?.level ??
                  "—"}
              </td>
              <td>
                {review.final?.ratings.find((r) => r.id === item.id)?.level ??
                  "—"}
              </td>
              <td>
                {effective?.find((r) => r.id === item.id)?.level ?? "待自评"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
