import { act, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  installAnnotationBackend,
  memoryAnnotationBackend,
} from "@/features/annotation/annotation-store";
import {
  installDraftBackend,
  memoryBackend,
} from "@/features/attempt/draft-store";
import { prepareStudentDraftsForPwaUpdate } from "@/features/attempt/pwa-draft-safety";
import {
  getNoteRecord,
  installNoteBackend,
  memoryNoteBackend,
  settleNotePersistence,
  writeNoteDoc,
} from "@/features/notes/note-store";
import { DOC_A, SCOPE, SESSION_A } from "@/features/notes/note-test-utils";
import { preparePwaUpdate, usePwaUpdateGuard } from "@/lib/pwa-update-safety";
import { PwaDraftSafety } from "./PwaDraftSafety";

const sessions = vi.hoisted(() => ({
  notes: null as { origin: string; studentId: string } | null,
  annotations: null as { origin: string; studentId: string } | null,
}));
vi.mock("@/features/notes/note-sync", () => ({
  currentNoteSession: () => sessions.notes,
  catchUpNotes: vi.fn(async () => {}),
}));
vi.mock("@/features/annotation/annotation-sync", () => ({
  currentAnnotationSession: () => sessions.annotations,
  catchUpAnnotations: vi.fn(async () => {}),
}));

function StudentScope() {
  usePwaUpdateGuard(
    () => prepareStudentDraftsForPwaUpdate(SESSION_A.studentId),
    "student-scope",
    true,
  );
  return <p>学生作答</p>;
}
function Page({ student }: { student: boolean }) {
  return (
    <>
      <PwaDraftSafety />
      {student ? <StudentScope /> : <p>教师页面</p>}
    </>
  );
}

beforeEach(() => {
  installDraftBackend(memoryBackend());
  installNoteBackend(memoryNoteBackend());
  installAnnotationBackend(memoryAnnotationBackend());
  sessions.notes = SESSION_A;
  sessions.annotations = SESSION_A;
});

it("学生业务scope卸载后，教师页面更新仍拦住学生未落盘稿", async () => {
  installNoteBackend({
    ...memoryNoteBackend(),
    set: async () => {
      throw new Error("本机磁盘已满");
    },
  });
  const view = render(<Page student />);
  writeNoteDoc(SESSION_A, SCOPE, DOC_A);
  await settleNotePersistence();
  view.rerender(<Page student={false} />);
  await expect(preparePwaUpdate()).rejects.toThrow("磁盘已满");
});

it("学生业务scope卸载后，教师页面更新必须等待学生在途写盘", async () => {
  let releaseWrite = () => {};
  const write = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const backend = memoryNoteBackend();
  installNoteBackend({
    ...backend,
    set: async (key, value) => {
      await write;
      await backend.set(key, value);
    },
  });
  const view = render(<Page student />);
  writeNoteDoc(SESSION_A, SCOPE, DOC_A);
  view.rerender(<Page student={false} />);
  let completed = false;
  const preparing = preparePwaUpdate().then(
    (prepared) => {
      completed = true;
      prepared.release();
      return null;
    },
    (error: unknown) => {
      completed = true;
      return error;
    },
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(completed).toBe(false);
  releaseWrite();
  expect(await preparing).toBeInstanceOf(Error);
});

it("显式退出解绑后，旧账号未落盘稿仍不能随页面更新丢弃", async () => {
  installNoteBackend({
    ...memoryNoteBackend(),
    set: async () => {
      throw new Error("旧稿写入失败");
    },
  });
  writeNoteDoc(SESSION_A, SCOPE, DOC_A);
  await settleNotePersistence();
  sessions.notes = null;
  sessions.annotations = null;
  render(<PwaDraftSafety />);
  await expect(preparePwaUpdate()).rejects.toThrow("旧稿写入失败");
});

it("旧账号已落盘的待传稿保留原样，不要求以新账号上传才能更新", async () => {
  writeNoteDoc(SESSION_A, SCOPE, DOC_A);
  await settleNotePersistence();
  sessions.notes = null;
  sessions.annotations = null;
  render(<PwaDraftSafety />);
  const prepared = await preparePwaUpdate();
  prepared.assertReady();
  prepared.release();
  expect((await getNoteRecord(SESSION_A, SCOPE))?.pending).not.toBeNull();
});

it("会话都已解绑但本机作答缓存仍未确认归属时，不能默许更新", async () => {
  const { draftStore } = await import("@/features/attempt/draft-store");
  draftStore.saveAnswer("unknown-attempt", "q", { kind: "judge", value: true });
  sessions.notes = null;
  sessions.annotations = null;
  render(<PwaDraftSafety />);
  await expect(preparePwaUpdate()).rejects.toThrow("未确认账号归属");
});

it("只剩一个已绑定材料会话时保守阻止更新", async () => {
  sessions.annotations = null;
  render(<PwaDraftSafety />);
  await expect(preparePwaUpdate()).rejects.toThrow("会话未就绪或不一致");
});
