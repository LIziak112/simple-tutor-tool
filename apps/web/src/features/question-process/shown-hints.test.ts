import { expect, it } from "vitest";
import { memoryKVBackend } from "@/lib/kv-backend";
import { ProcessShownHints } from "./shown-hints";

it("刷新只恢复本录制中真正呈现且仍已解锁的提示，删除与账号隔离", async () => {
  const store = memoryKVBackend();
  const first = new ProcessShownHints(store, "student-a/attempt", "recording");
  await first.load();
  expect(first.read("q1", [0, 1])).toEqual([]);
  await first.add("q1", 0);
  await first.add("q1", 0);
  const restored = new ProcessShownHints(
    store,
    "student-a/attempt",
    "recording",
  );
  await restored.load();
  expect(restored.read("q1", [0, 1])).toEqual([0]);
  expect(restored.read("q1", [1])).toEqual([]);
  expect(restored.read("q2", [0])).toEqual([]);
  for (const [prefix, recording] of [
    ["student-b/attempt", "recording"],
    ["student-a/attempt", "new-recording"],
  ] as const) {
    const isolated = new ProcessShownHints(store, prefix, recording);
    await isolated.load();
    expect(isolated.read("q1", [0])).toEqual([]);
  }
  const rows = await store.getAll(
    `${JSON.stringify(["student-a/attempt"]).slice(0, -1)},`,
  );
  await Promise.all(rows.map(([key]) => store.del(key)));
  const deleted = new ProcessShownHints(
    store,
    "student-a/attempt",
    "recording",
  );
  await deleted.load();
  expect(deleted.read("q1", [0])).toEqual([]);
});

it("新段起始快照含已见提示，快照后首次出现的解锁提示才补 restored 节点", async () => {
  const { QuestionProcessRecorder } = await import("./recorder");
  const store = memoryKVBackend();
  const batches: import("@tutor/contract").QuestionProcessBatch[] = [];
  const create = async () => {
    const seen = new ProcessShownHints(
      store,
      "scope",
      "863de11a-f212-46e1-b876-d3a29e07df55",
    );
    await seen.load();
    return new QuestionProcessRecorder({
      attemptId: "attempt",
      recordingId: "863de11a-f212-46e1-b876-d3a29e07df55",
      expiresAt: "2099-01-01T00:00:00Z",
      prefix: "scope",
      store,
      current: () => true,
      revision: () => "revision",
      snapshot: (id) => ({
        answer: null,
        layers: {},
        hints: seen.read(id, [0, 1]),
      }),
      onHintShown: (id, index) => seen.add(id, index),
      upload: async (batch) => {
        batches.push(batch);
        return batch.events.at(-1)?.seq ?? -1;
      },
    });
  };
  const first = await create();
  first.showHint("q1", 0);
  await first.close();
  batches.length = 0;
  const next = await create();
  next.begin("q1");
  next.showHint("q1", 0);
  next.showHint("q1", 1);
  await next.flush();
  const restoredId = batches.find((batch) =>
    batch.events.some(
      (event) => event.kind === "start" && event.hints.includes(0),
    ),
  )?.segmentId;
  expect(restoredId).toBeDefined();
  const events = batches
    .filter((batch) => batch.segmentId === restoredId)
    .flatMap((batch) => batch.events);
  expect(events[0]).toMatchObject({ kind: "start", hints: [0] });
  expect(events.filter((event) => event.kind === "hint")).toEqual([
    expect.objectContaining({
      kind: "hint",
      action: "shown",
      index: 1,
      requestId: "restored-1",
    }),
  ]);
  await next.close();
});
