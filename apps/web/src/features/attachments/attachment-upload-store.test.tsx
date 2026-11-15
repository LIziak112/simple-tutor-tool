import type { Attachment } from "@tutor/contract";
import { afterEach, expect, it, vi } from "vitest";
import {
  createTestRuntime,
  TestPortalProvider,
  testClientServices,
} from "@/test/portal-fixture";
import { act, cleanup, renderHook, waitFor } from "@/test/render-with-portal";
import {
  enqueueAttachmentUploads,
  resetAttachmentUploadStoreForTest,
  useAttachmentUploadQueue,
} from "./attachment-upload-store";

const attachment = (id: string): Attachment => ({
  id,
  courseId: "course",
  courseTitle: "课程",
  fileName: "样本.pdf",
  format: "pdf",
  bytes: 1,
  pageCount: null,
  visibility: "teacher_only",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});
function deferred() {
  let resolve: (value: Attachment) => void = () => {};
  const promise = new Promise<Attachment>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
afterEach(() => {
  cleanup();
  resetAttachmentUploadStoreForTest();
});
it("附件按主体隔离，同课程坐标也不显示另一账号的文件或借其端口", async () => {
  const pending = deferred();
  const abort = new AbortController();
  const uploadA = vi.fn(async () => pending.promise);
  const uploadB = vi.fn(async () => attachment("b"));
  const first = createTestRuntime({
    subject: { type: "teacher", id: "a" },
    signal: abort.signal,
    clients: { ...testClientServices, uploadAttachmentApi: uploadA },
  });
  let runtime = first;
  const probe = renderHook(() => useAttachmentUploadQueue("course"), {
    wrapper: ({ children }) => (
      <TestPortalProvider runtime={runtime}>{children}</TestPortalProvider>
    ),
  });
  act(() =>
    enqueueAttachmentUploads(
      first,
      [new File(["x"], "样本.pdf")],
      "course",
      "teacher_only",
    ),
  );
  expect(probe.result.current).toHaveLength(1);
  abort.abort();
  runtime = createTestRuntime({
    subject: { type: "teacher", id: "b" },
    clients: { ...testClientServices, uploadAttachmentApi: uploadB },
  });
  probe.rerender();
  expect(probe.result.current).toHaveLength(0);
  await act(async () => pending.resolve(attachment("old")));
  expect(probe.result.current).toHaveLength(0);
  expect(uploadB).not.toHaveBeenCalled();
});
it("同一主体返回后接回原文件和幂等键，旧租约迟到回执不能覆盖新上传", async () => {
  const old = deferred(),
    fresh = deferred();
  const abort = new AbortController();
  const uploadA = vi.fn<typeof testClientServices.uploadAttachmentApi>(
    async () => old.promise,
  );
  const uploadNew = vi.fn<typeof testClientServices.uploadAttachmentApi>(
    async () => fresh.promise,
  );
  const first = createTestRuntime({
    subject: { type: "teacher", id: "a" },
    signal: abort.signal,
    clients: { ...testClientServices, uploadAttachmentApi: uploadA },
  });
  let runtime = first;
  const probe = renderHook(() => useAttachmentUploadQueue("course"), {
    wrapper: ({ children }) => (
      <TestPortalProvider runtime={runtime}>{children}</TestPortalProvider>
    ),
  });
  const file = new File(["x"], "样本.pdf");
  act(() => enqueueAttachmentUploads(first, [file], "course", "teacher_only"));
  const uploadId = uploadA.mock.calls[0]?.[1]?.uploadId;
  abort.abort();
  runtime = createTestRuntime({
    subject: { type: "teacher", id: "a" },
    clients: { ...testClientServices, uploadAttachmentApi: uploadNew },
  });
  probe.rerender();
  await waitFor(() => expect(uploadNew).toHaveBeenCalledTimes(1));
  expect(uploadNew.mock.calls[0]?.[0]).toBe(file);
  expect(uploadNew.mock.calls[0]?.[1]?.uploadId).toBe(uploadId);
  await act(async () => fresh.resolve(attachment("new")));
  await act(async () => old.resolve(attachment("old")));
  expect(probe.result.current[0]?.result?.id).toBe("new");
});
