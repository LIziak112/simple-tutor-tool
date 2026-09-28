import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { AttemptSession } from "@/features/attempt/AttemptSession";
import {
  useAttemptDetail,
  useStartAttempt,
} from "@/features/attempt/attempt-queries";
import {
  StudentErrorPanel,
  StudentListSkeleton,
} from "@/features/student/student-ui";

/**
 * /s/assignments/:id 作业答题入口（T2.6；T2A.6 通用化改造）：
 * 1. 进入即 POST attempt（幂等创建/取回——「一个作业一人一份进行中」只对
 *    assignment 来源生效；已交卷返回已交的那份，直接进结果视图）；
 * 2. 拿到 attemptId 后渲染通用答题会话 AttemptSession（与课程练习
 *    /s/attempts/:attemptId 共用同一组件，D9）；
 * 3. 三态齐全（加载骨架/错误重试/空试卷提示在 AttemptSession 内）。
 */

export default function StudentAssignmentAttemptPage() {
  const { id: assignmentId = "" } = useParams();
  const navigate = useNavigate();

  // 第 1 步：幂等创建/取回 attempt（进入页面触发一次；重试走错误态按钮）
  const startAttempt = useStartAttempt(assignmentId);
  const startMutate = startAttempt.mutate;
  useEffect(() => {
    if (assignmentId !== "") startMutate();
  }, [assignmentId, startMutate]);

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
  if (startAttempt.isPending) {
    return <StudentListSkeleton label="正在打开作业" />;
  }
  if (startAttempt.isError || startAttempt.data === undefined) {
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
  if (detailQuery.isPending) {
    return <StudentListSkeleton label="正在加载题目" />;
  }
  if (detailQuery.isError || detailQuery.data === undefined) {
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
    <AttemptSession
      data={detailQuery.data}
      onExit={() => void navigate("/s/home")}
    />
  );
}
