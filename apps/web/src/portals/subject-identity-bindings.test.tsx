import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { StudentMeData } from "@tutor/contract";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import {
  currentAnnotationSession,
  resetAnnotationSession,
} from "@/features/annotation/annotation-sync";
import { useBindAnnotationSession } from "@/features/annotation/use-annotation-session";
import { useStudentMe } from "@/features/auth/student-auth";
import {
  currentNoteSession,
  resetNoteSession,
} from "@/features/notes/note-sync";
import { useBindNoteSession } from "@/features/notes/use-note-session";
import { currentDraftSession } from "@/features/persistence/draft-store";
import {
  type PortalRuntime,
  usePortalRuntime,
} from "@/features/runtime/portal-runtime";
import { serviceLease } from "@/features/runtime/service-leases";
import { act, cleanup, render, waitFor } from "@/test/render-with-portal";
import { PortalHost } from "./PortalHost";

afterEach(() => {
  cleanup();
  resetNoteSession();
  resetAnnotationSession();
  vi.unstubAllGlobals();
});
it("ABA新lease使真实笔记/标注对象换代，旧对象仍固定旧port，同A本地草稿归属保留", async () => {
  const a: StudentMeData = {
    id: "a",
    displayName: "甲",
    loginName: "a",
    accountKind: "class",
    passwordEnabled: false,
    linkEnabled: true,
  };
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  cache.setQueryData(["student", "me"], a);
  const send = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ ok: true, data: a })),
  );
  vi.stubGlobal("fetch", send);
  let runtime: PortalRuntime | undefined;
  function Probe() {
    const me = useStudentMe().data;
    runtime = usePortalRuntime();
    useBindNoteSession(me);
    useBindAnnotationSession(me);
    return null;
  }
  const view = render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={["/s/home"]}>
        <PortalHost>
          <Probe />
        </PortalHost>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(currentNoteSession()?.studentId).toBe("a"));
  const oldNote = currentNoteSession(),
    oldAnnotation = currentAnnotationSession(),
    oldRuntime = runtime;
  if (!oldNote || !oldAnnotation || !oldRuntime)
    throw new Error("缺少初始会话");
  act(() => {
    cache.setQueryData(["student", "me"], { ...a, id: "b" });
    cache.setQueryData(["student", "me"], a);
  });
  await waitFor(() => expect(currentNoteSession()).not.toBe(oldNote));
  const note = currentNoteSession(),
    annotation = currentAnnotationSession();
  if (!note || !annotation || !runtime) throw new Error("缺少新会话");
  expect(annotation).not.toBe(oldAnnotation);
  expect(serviceLease(oldNote)).toBe(oldRuntime.clients);
  expect(serviceLease(oldAnnotation)).toBe(oldRuntime.clients);
  expect(serviceLease(note)).toBe(runtime.clients);
  expect(serviceLease(annotation)).toBe(runtime.clients);
  expect(oldRuntime.signal.aborted).toBe(true);
  expect(runtime.signal.aborted).toBe(false);
  expect(currentDraftSession()).toEqual({
    origin: location.origin,
    studentId: "a",
  });
  await expect(serviceLease(oldNote).fetchStudentMe()).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(send).not.toHaveBeenCalled();
  await expect(serviceLease(note).fetchStudentMe()).resolves.toEqual(a);
  expect(send).toHaveBeenCalledTimes(1);
  view.unmount();
  cache.clear();
});
