import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { AttemptSession } from "@/features/attempt/AttemptSession";
import {
  useAttemptDetail,
  useStartAttempt,
} from "@/features/attempt/attempt-queries";
import {
  initialTimeLimitOf,
  TimeLimitPicker,
  timeLimitStartOption,
} from "@/features/attempt/TimeLimitPicker";
import { assignmentsReturnTarget } from "@/features/student/assignment-list-filters";
import { aiQueueReturnTarget } from "@/features/student/record-review-navigation";
import { useStudentAssignments } from "@/features/student/student-queries";
import {
  StudentErrorPanel,
  StudentListSkeleton,
  StudentRefreshWarning,
} from "@/features/student/student-ui";
import { ApiError } from "@/lib/api";

/**
 * /s/assignments/:id 作业答题入口（T2.6；T2A.6 通用化改造）：
 * 1. 已开始的作业直接取回进行中卷或结果，首次进入先选择限时设置再建卷；
 * 2. 拿到 attemptId 后渲染通用答题会话 AttemptSession（与课程练习
 *    /s/attempts/:attemptId 共用同一组件，D9）；
 * 3. 三态齐全（加载骨架/错误重试/空试卷提示在 AttemptSession 内）。
 */

export default function StudentAssignmentAttemptPage() {
  const { id: assignmentId = "" } = useParams();
  return (
    <AssignmentAttemptEntry key={assignmentId} assignmentId={assignmentId} />
  );
}

function AssignmentAttemptEntry({ assignmentId }: { assignmentId: string }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const returnTo = assignmentsReturnTarget(params.get("returnTo"));
  // SAI-23 队列跳转来源（aiFrom 白名单独立于作业列表 returnTo）：无列表
  // 上下文时改写返回目标，保留打开队列时的来源位置
  const queueTarget = aiQueueReturnTarget(params.get("aiFrom"));

  const assignments = useStudentAssignments();
  const assignment = assignments.data?.assignments.find(
    (item) => item.id === assignmentId,
  );
  const needsStart = assignment?.status === "not_started";
  const [timeLimit, setTimeLimit] = useState(() =>
    initialTimeLimitOf(undefined),
  );
  const timing = timeLimitStartOption(timeLimit);
  const back = () => void navigate(returnTo ?? queueTarget ?? "/s/home");
  const startAttempt = useStartAttempt(assignmentId);
  const startMutate = startAttempt.mutate;
  const startIdle = startAttempt.isIdle;
  const attemptedResume = useRef(false);
  useEffect(() => {
    if (!assignment || needsStart || !startIdle || attemptedResume.current)
      return;
    attemptedResume.current = true;
    startMutate();
  }, [assignment, needsStart, startIdle, startMutate]);

  // 第 2 步：详情（draft→草稿视图 / 已交→结果视图）
  const attemptId = startAttempt.data?.id;
  const detailQuery = useAttemptDetail(attemptId);

  if (assignmentId === "") {
    return (
      <StudentErrorPanel
        title="地址不完整"
        message="缺少作业编号，请从首页的作业卡片重新进入。"
        onRetry={() => void navigate("/s/home")}
      />
    );
  }
  if (
    !startAttempt.data &&
    assignments.fetchStatus === "paused" &&
    !assignments.data
  ) {
    return (
      <StudentErrorPanel
        title="打不开这份作业"
        message="当前网络不可用，请连接网络后重试。"
        onRetry={() => void assignments.refetch()}
      />
    );
  }
  if (!startAttempt.data && assignments.isPending) {
    return <StudentListSkeleton label="正在打开作业" />;
  }
  if (!startAttempt.data && !assignment) {
    return (
      <StudentErrorPanel
        title="打不开这份作业"
        message={
          assignments.error instanceof Error
            ? assignments.error.message
            : "作业不存在或你已无权作答。"
        }
        onRetry={() => void assignments.refetch()}
      />
    );
  }
  if (assignment && needsStart && !startAttempt.data) {
    return (
      <section
        aria-label="作业开卷设置"
        className="flex max-w-xl flex-col gap-4"
      >
        <h1 className="text-xl font-semibold">{assignment.title}</h1>
        <TimeLimitPicker
          value={timeLimit}
          onChange={setTimeLimit}
          recommended={undefined}
        />
        {startAttempt.error instanceof Error && (
          <p role="alert" className="text-sm text-destructive">
            {startAttempt.error.message}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Button className="min-h-11" variant="outline" onClick={back}>
            返回
          </Button>
          <Button
            className="min-h-11"
            disabled={timing === null || startAttempt.isPending}
            onClick={() => {
              if (timing !== null) startMutate(timing);
            }}
          >
            {startAttempt.isPending ? "正在开始…" : "开始作业"}
          </Button>
        </div>
      </section>
    );
  }
  if (startAttempt.isIdle || startAttempt.isPending) {
    return <StudentListSkeleton label="正在打开作业" />;
  }
  if (startAttempt.isError) {
    return (
      <StudentErrorPanel
        title="打不开这份作业"
        message={
          startAttempt.error instanceof Error
            ? startAttempt.error.message
            : "网络异常，请稍后重试"
        }
        onRetry={() => startAttempt.mutate()}
      />
    );
  }
  const denied =
    detailQuery.isError &&
    detailQuery.error instanceof ApiError &&
    [401, 403, 404].includes(detailQuery.error.status);
  if (detailQuery.data === undefined && detailQuery.fetchStatus === "paused") {
    return (
      <StudentErrorPanel
        title="题目加载失败"
        message="当前网络不可用，请连接网络后重试。"
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }
  if (detailQuery.isPending) {
    return <StudentListSkeleton label="正在加载题目" />;
  }
  if (denied || detailQuery.data === undefined) {
    return (
      <StudentErrorPanel
        title="题目加载失败"
        message={
          detailQuery.error instanceof Error
            ? detailQuery.error.message
            : "网络异常，请稍后重试"
        }
        onRetry={() => void detailQuery.refetch()}
      />
    );
  }

  return (
    <>
      {detailQuery.isError && (
        <StudentRefreshWarning
          title="题目信息刷新失败"
          onRetry={() => void detailQuery.refetch()}
        />
      )}
      <AttemptSession
        data={detailQuery.data}
        onExit={back}
        exitLabel={
          returnTo ? "返回我的作业" : queueTarget ? "返回原页面" : undefined
        }
        onRefresh={() => void detailQuery.refetch()}
      />
    </>
  );
}
