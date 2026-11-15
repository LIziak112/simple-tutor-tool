import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { contentTreeKey } from "@/features/content/content-queries";
import {
  studentCourseKey,
  studentCoursesKey,
  studentLectureKey,
  studentLecturesKey,
} from "@/features/student/student-queries";
import { act, renderHook } from "@/test/render-with-portal";
import {
  useCreateCourse,
  useDeleteCourse,
  useRemoveCourseMembers,
  useUpdateCourse,
} from "./course-queries";

vi.mock("@/lib/api", () => ({
  createCourseApi: vi.fn(async () => ({})),
  updateCourseApi: vi.fn(async () => ({})),
  deleteCourseApi: vi.fn(async () => ({})),
  removeCourseMembersApi: vi.fn(async () => ({})),
}));

describe("课程写入刷新内容树与学习端课程/讲义投影", () => {
  it.each(["创建", "改名", "归档", "删除", "移出成员"] as const)(
    "%s 后内容树、课程与讲义的列表/子项缓存全部失效",
    async (action) => {
      const client = new QueryClient();
      client.setQueryData(contentTreeKey, { courses: [] });
      client.setQueryData(studentCoursesKey, { courses: [] });
      client.setQueryData(studentCourseKey("course"), { items: [] });
      client.setQueryData(studentLecturesKey, { lectures: [] });
      client.setQueryData(studentLectureKey("lecture", "course"), {
        title: "旧课程下的讲义",
      });
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const { result } = renderHook(
        () => ({
          create: useCreateCourse(),
          update: useUpdateCourse("course"),
          remove: useDeleteCourse(),
          removeMember: useRemoveCourseMembers("course"),
        }),
        { wrapper },
      );
      await act(async () => {
        if (action === "创建")
          await result.current.create.mutateAsync({ title: "新课程" });
        else if (action === "移出成员")
          await result.current.removeMember.mutateAsync(["student"]);
        else if (action === "删除")
          await result.current.remove.mutateAsync("course");
        else
          await result.current.update.mutateAsync(
            action === "改名" ? { title: "新名称" } : { archived: true },
          );
      });
      expect(client.getQueryState(contentTreeKey)?.isInvalidated).toBe(true);
      for (const key of [
        studentCoursesKey,
        studentCourseKey("course"),
        studentLecturesKey,
        studentLectureKey("lecture", "course"),
      ]) {
        expect(
          client.getQueryState(key)?.isInvalidated,
          JSON.stringify(key),
        ).toBe(true);
      }
      client.clear();
    },
  );
});
