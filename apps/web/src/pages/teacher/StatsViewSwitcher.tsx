import { Link } from "react-router";
import { Button } from "@/components/ui/button";

/**
 * 「作答记录 / 统计」次级切换（T-PR1：「学情分析」一级入口下沉后三页共用）。
 * aria-pressed 表当前视图；「作答记录」即 /t/data 作答数据页，「统计」是
 * /t/insights 学情总览，两页各自持筛选，切换不携带对方页的筛选参数。
 */
export function StatsViewSwitcher({
  active,
}: {
  active: "attempts" | "stats";
}) {
  return (
    <fieldset className="flex flex-wrap gap-2">
      <legend className="sr-only">数据视图</legend>
      {active === "attempts" ? (
        <Button variant="default" className="min-h-11" aria-pressed={true}>
          作答记录
        </Button>
      ) : (
        <Button
          variant="outline"
          className="min-h-11"
          aria-pressed={false}
          asChild
        >
          <Link to="/t/data">作答记录</Link>
        </Button>
      )}
      {active === "stats" ? (
        <Button variant="default" className="min-h-11" aria-pressed={true}>
          统计
        </Button>
      ) : (
        <Button
          variant="outline"
          className="min-h-11"
          aria-pressed={false}
          asChild
        >
          <Link to="/t/insights">统计</Link>
        </Button>
      )}
    </fieldset>
  );
}
