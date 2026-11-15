import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AccountKind,
  CourseDetailData,
  StudentSummary,
} from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { teacherMeKey } from "@/features/auth/teacher-auth";
import { studentsKey } from "@/features/students/student-queries";
import { fireEvent, render, screen } from "@/test/render-with-portal";
import { CourseMembersTab } from "./CourseMembersTab";

const detail: CourseDetailData = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "课程",
  description: null,
  order: 0,
  archived: false,
  archivedAt: null,
  hasAttempts: false,
  items: [],
  members: [],
  createdAt: "2026-11-13T00:00:00Z",
};
const student: StudentSummary = {
  id: "22222222-2222-4222-8222-222222222222",
  displayName: "小栗",
  loginName: "personal:internal-id",
  linkEnabled: false,
  passwordEnabled: false,
  hasPassword: false,
  linkToken: "internal-link",
  note: null,
  archived: false,
  createdAt: "2026-11-13T00:00:00Z",
};

function renderMembers(kind: AccountKind) {
  const client = new QueryClient();
  client.setQueryData(teacherMeKey, {
    id: "33333333-3333-4333-8333-333333333333",
    loginName: "user",
    isAdmin: false,
    accountKind: kind,
    createdAt: "2026-11-13T00:00:00Z",
  });
  client.setQueryData(studentsKey(false), { students: [student] });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CourseMembersTab courseId={detail.id} detail={detail} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "添加成员" }));
}

describe("课程成员候选身份显示", () => {
  it("个人账号显示名字，隐藏内部登录名", () => {
    renderMembers("personal");
    expect(screen.getByText("小栗")).toBeVisible();
    expect(screen.queryByText(/personal:internal-id/)).not.toBeInTheDocument();
  });

  it("班级账号保留登录名用于区分同名学生", () => {
    renderMembers("class");
    expect(screen.getByText(/登录名：personal:internal-id/)).toBeVisible();
  });
});
