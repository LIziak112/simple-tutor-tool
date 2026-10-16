import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { contentTreeKey } from "@/features/content/content-queries";
import {
  useCreateCourse,
  useDeleteCourse,
  useUpdateCourse,
} from "./course-queries";

vi.mock("@/lib/api", () => ({
  createCourseApi: vi.fn(async () => ({})),
  updateCourseApi: vi.fn(async () => ({})),
  deleteCourseApi: vi.fn(async () => ({})),
}));

describe("课程变更刷新内容树", () => {
  it.each(["创建", "改名", "归档", "删除"] as const)(
    "%s 后已缓存的内容树失效",
    async (action) => {
      const client = new QueryClient();
      client.setQueryData(contentTreeKey, { courses: [] });
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const { result } = renderHook(
        () => ({
          create: useCreateCourse(),
          update: useUpdateCourse("course"),
          remove: useDeleteCourse(),
        }),
        { wrapper },
      );
      await act(async () => {
        if (action === "创建")
          await result.current.create.mutateAsync({ title: "新课程" });
        else if (action === "删除")
          await result.current.remove.mutateAsync("course");
        else
          await result.current.update.mutateAsync(
            action === "改名" ? { title: "新名称" } : { archived: true },
          );
      });
      expect(client.getQueryState(contentTreeKey)?.isInvalidated).toBe(true);
      client.clear();
    },
  );
});
