import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AttemptSummary } from "@tutor/contract";
import type { ReactNode } from "react";
import { expect, it } from "vitest";
import { renderHook } from "@/test/render-with-portal";
import { useOpenedAttemptListRefresh } from "./use-opened-attempt-refresh";

const opened: AttemptSummary = {
  id: "88888888-8888-4888-8888-888888888888",
  sourceType: "course",
  courseId: "22222222-2222-4222-8222-222222222222",
  unitId: "u",
  assignmentId: null,
  lectureId: null,
  status: "draft",
  phase: "opened",
  activatedAt: null,
  frozenAt: "2026-11-14T00:00:00.000Z",
  attemptNo: 3,
  startedAt: "2026-11-14T00:00:00.000Z",
  submittedAt: null,
  scoreAuto: null,
};
const active: AttemptSummary = {
  ...opened,
  phase: "active",
  activatedAt: "2026-11-14T00:01:00.000Z",
};
const LISTS = [
  ["student", "course", opened.courseId, "unit", "u"],
  ["student", "lesson-landing", "l1", null],
  ["student", "assignments"],
  ["student", "records", { page: 1 }],
] as const;
const OWN = [
  ["student", "attempt", opened.id],
  ["student", "attempt", opened.id, "context", opened.frozenAt],
  ["student", "lesson", "l1", null],
  ["teacher", "attempts"],
] as const;

function setup(attempt: AttemptSummary | undefined) {
  const client = new QueryClient();
  for (const key of [...LISTS, ...OWN]) client.setQueryData(key, { seeded: 1 });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    (props: { attempt: AttemptSummary | undefined }) =>
      useOpenedAttemptListRefresh(props.attempt),
    { wrapper, initialProps: { attempt } },
  );
  const stale = (keys: readonly (readonly unknown[])[]) =>
    keys.map((key) => client.getQueryState(key)?.isInvalidated);
  return { ...view, stale };
}

it("未激活的卷：在页面上不动列表；看到它已激活时，列表类查询过期，卷自己的不动", () => {
  const { rerender, stale } = setup(opened);
  expect(stale(LISTS)).toEqual([false, false, false, false]);
  rerender({ attempt: active });
  expect(stale(LISTS)).toEqual([true, true, true, true]);
  expect(stale(OWN)).toEqual([false, false, false, false]);
});

it("未激活的卷：离开这份卷时列表类查询过期（动没动笔前端不知道，回列表页重取）", () => {
  const { unmount, stale } = setup(opened);
  unmount();
  expect(stale(LISTS)).toEqual([true, true, true, true]);
  expect(stale(OWN)).toEqual([false, false, false, false]);
});

it("进来就已激活的卷、还没拿到卷：都不碰列表缓存", () => {
  const loaded = setup(active);
  loaded.unmount();
  expect(loaded.stale(LISTS)).toEqual([false, false, false, false]);
  const pending = setup(undefined);
  pending.unmount();
  expect(pending.stale(LISTS)).toEqual([false, false, false, false]);
});
