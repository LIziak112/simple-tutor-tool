import { render, screen } from "@testing-library/react";
import type { TeacherAttemptCard } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AttemptGroupedList, sourceContextOf } from "./attempt-views";

/**
 * /t/data 作答列表视图（2026-10 讲练一体覆盖）：lesson 来源的徽章/上下文/
 * 分组——教师批改队列与列表共用 sourceContextOf 同一口径。
 */

const LESSON_CARD: TeacherAttemptCard = {
  sourceType: "lesson",
  courseId: null,
  courseName: null,
  assignmentId: null,
  assignmentTitle: null,
  unitId: "随堂讲练",
  unitTitle: "第1讲 有理数讲练",
  attemptNo: 2,
  attemptId: "55555555-5555-4555-8555-555555555555",
  studentId: "11111111-1111-4111-8111-111111111111",
  studentName: "张三",
  unitCount: 1,
  questionCount: 3,
  status: "submitted",
  scoreAuto: 67,
  scoreFinal: null,
  pendingCount: 1,
  startedAt: "2026-10-12T02:00:00.000Z",
  submittedAt: "2026-10-12T02:20:00.000Z",
  activeSec: 600,
};

describe("teacher-attempts 视图：lesson（讲练）来源", () => {
  it("sourceContextOf：unitTitle 承载讲义标题 + 第 n 次；无课程时不出现前导分隔符", () => {
    // 服务端 sourceOf：unitTitle=讲义标题、courseId/courseName 可空（打开时来自哪门课）
    expect(sourceContextOf(LESSON_CARD)).toBe("第1讲 有理数讲练 · 第 2 次");
    expect(
      sourceContextOf({
        ...LESSON_CARD,
        courseId: "33333333-3333-4333-8333-333333333333",
        courseName: "初一上",
      }),
    ).toBe("初一上 · 第1讲 有理数讲练 · 第 2 次");
  });

  it("列表卡片：来源徽章「讲练」+ 上下文行（与学生端记录卡同配色词表）", () => {
    render(
      <MemoryRouter>
        <AttemptGroupedList attempts={[LESSON_CARD]} view="course" />
      </MemoryRouter>,
    );
    expect(screen.getByText("讲练")).toBeInTheDocument();
    expect(screen.getByText("第1讲 有理数讲练 · 第 2 次")).toBeInTheDocument();
  });

  it("按作业视图分组：lesson 单独成组「讲练 · 讲义标题」（不混入课程练习组）", () => {
    render(
      <MemoryRouter>
        <AttemptGroupedList
          attempts={[
            LESSON_CARD,
            {
              ...LESSON_CARD,
              attemptId: "66666666-6666-4666-8666-666666666666",
              sourceType: "course",
              unitId: "有理数小练",
              unitTitle: "有理数小练",
              courseId: "33333333-3333-4333-8333-333333333333",
              courseName: "初一上",
            },
          ]}
          view="assignment"
        />
      </MemoryRouter>,
    );
    // 两组：讲练组 + 课程练习组，互不混排
    expect(screen.getByText("讲练 · 第1讲 有理数讲练")).toBeInTheDocument();
    expect(screen.getByText("课程练习 · 有理数小练")).toBeInTheDocument();
  });
});
