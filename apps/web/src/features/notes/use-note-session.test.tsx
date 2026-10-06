import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { StudentMeData } from "@tutor/contract";
import { describe, expect, it, vi } from "vitest";
import {
  currentNoteSession,
  resetNoteSession,
} from "@/features/notes/note-sync";

/**
 * useBindNoteSession（use-note-session.ts，T6R.11 复审自 use-note-head 拆出）：
 * me 到达即绑定 {origin, studentId}；me 未到不绑定。实际接线在 StudentLayout。
 */

describe("useBindNoteSession（T6R.9；T6R.11 起为 StudentLayout 布局级接线）", () => {
  it("me 到达即绑定 {origin, studentId}；me 未到不绑定", async () => {
    const { useBindNoteSession } = await import(
      "@/features/notes/use-note-session"
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const me: StudentMeData = {
      id: "11111111-1111-4111-8111-111111111111",
      displayName: "小明",
      loginName: "e2e-stu",
      linkEnabled: true,
      passwordEnabled: false,
    };
    function Probe({ me: m }: { me: StudentMeData | undefined }) {
      useBindNoteSession(m);
      return null;
    }
    const view = render(
      <QueryClientProvider client={client}>
        <Probe me={undefined} />
      </QueryClientProvider>,
    );
    expect(currentNoteSession()).toBeNull(); // 未到不绑
    view.rerender(
      <QueryClientProvider client={client}>
        <Probe me={me} />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => {
      expect(currentNoteSession()).toEqual({
        origin: window.location.origin,
        studentId: me.id,
      });
    });
    resetNoteSession();
  });
});
