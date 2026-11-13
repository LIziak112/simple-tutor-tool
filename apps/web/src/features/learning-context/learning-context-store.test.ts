import { expect, it } from "vitest";
import { createLearningContextStore } from "./learning-context-store";

const source = (questionId: string) => ({
  reference: {
    kind: "question" as const,
    attemptId: "a",
    questionId,
    surface: "attempt" as const,
  },
  anchor: {
    kind: "question" as const,
    attemptId: "a",
    questionId,
    label: questionId,
  },
});
it("新host与旧host同一题时，旧cleanup不能删除新发布", () => {
  const s = createLearningContextStore();
  s.bindPrincipal("alice");
  const old = s.registerHost("a", (id) => source(id), "draft");
  s.explicit(old, source("q1"));
  const next = s.registerHost("a", (id) => source(id), "draft");
  s.explicit(next, source("q1"));
  s.release(old);
  expect(s.getSnapshot().source.anchor).toEqual(source("q1").anchor);
});
it("显式题仍可见/编辑/弹层时优先，失去资格才跟随阅读", () => {
  const s = createLearningContextStore();
  const h = s.registerHost("a", (id) => source(id), "draft");
  s.explicit(h, source("q2"));
  s.observe(h, source("q1"), true);
  expect(s.getSnapshot().source.anchor).toEqual(source("q2").anchor);
  s.observe(h, source("q1"), false);
  expect(s.getSnapshot().source.anchor).toEqual(source("q1").anchor);
});
it("principal变化废止旧lease和迟到canonical，不复活旧人来源", () => {
  const s = createLearningContextStore();
  s.bindPrincipal("alice");
  const h = s.registerHost("a", (id) => source(id), "draft");
  s.explicit(h, source("q1"));
  s.bindPrincipal("bob");
  s.explicit(h, source("q2"));
  expect(s.getSnapshot().source.anchor).toEqual({ kind: "none" });
  expect(s.getSnapshot().principal).toBe("bob");
});
it("释放旧路由不清新路由，空题不借旧题，StrictMode重新注册独立view", () => {
  const s = createLearningContextStore();
  const a = s.registerHost("a", (id) => source(id), "draft");
  s.explicit(a, source("q1"));
  const b = s.registerHost("b", (id) => source(id), "graded");
  expect(a.viewId).not.toBe(b.viewId);
  expect(s.getSnapshot().source.anchor).toEqual({ kind: "none" });
  s.release(a);
  s.explicit(b, source("q2"));
  expect(s.getSnapshot().source.anchor).toEqual(source("q2").anchor);
});
it("捕获的是独立快照，后续阅读与隐藏不会改动记录来源", () => {
  const s = createLearningContextStore();
  const h = s.registerHost("a", (id) => source(id), "draft");
  s.explicit(h, source("q1"));
  const captured = s.captureQuestion(h, {
    attemptId: "a",
    questionId: "q2",
    surface: "attempt",
  });
  s.observe(h, source("q1"), false);
  s.setVisible(false);
  expect(captured?.anchor).toEqual(source("q2").anchor);
  expect(s.getSnapshot().visible).toBe(false);
});

it("相同主体的新layout绑定不被旧layout清理，旧host也不能解除新弹层保护", () => {
  const s = createLearningContextStore();
  const cleanup = s.bindPrincipalLease("alice");
  const a = s.registerHost("a", (id) => source(id), "draft");
  const nextCleanup = s.bindPrincipalLease("alice");
  const b = s.registerHost("b", (id) => source(id), "draft");
  s.explicit(b, source("q2"));
  s.pin(b, true);
  cleanup();
  s.pin(a, false);
  s.observe(b, source("q1"), false);
  expect(s.getSnapshot().principal).toBe("alice");
  expect(s.getSnapshot().source.anchor).toEqual(source("q2").anchor);
  nextCleanup();
  expect(s.getSnapshot().source.anchor).toEqual({ kind: "none" });
});
