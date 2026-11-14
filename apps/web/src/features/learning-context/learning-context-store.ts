import type {
  AttemptStatus,
  LearningContext,
  LearningContextRequest,
  MemoAnchor,
} from "@tutor/contract";
import { createContext, useSyncExternalStore } from "react";

/** 未取得完整坐标时只保留真实旧引用，不能构造部分 session。 */
export interface LearningSource {
  readonly anchor: MemoAnchor;
  readonly reference?: LearningContextRequest;
  readonly context?: LearningContext;
  readonly principal?: string | null;
  readonly view?: LearningContext["view"];
  readonly layout?: string | null;
  readonly expectedDisplay?: { questionNo: number; questionCount: number };
}
export interface HostLease {
  readonly token: symbol;
  readonly epoch: number;
  readonly routeEpoch: number;
  readonly viewId: string;
  readonly route: string;
  readonly attemptStatus: AttemptStatus | undefined;
  readonly sourceOf: (id: string) => LearningSource | null;
}
/** 只传递宿主所有权；当前来源仍只保存在唯一仓中。 */
export const LearningHostContext = createContext<HostLease | null>(null);
export interface LearningQuestionTarget {
  readonly attemptId: string;
  readonly questionId: string;
  readonly surface: "attempt" | "result" | "lesson";
  readonly questionRevisionId?: string | undefined;
}
const emptySource: LearningSource = { anchor: { kind: "none" } };
export interface LearningSnapshot {
  readonly epoch: number;
  readonly principal: string | null;
  readonly host: HostLease | null;
  readonly source: LearningSource;
  readonly explicit: boolean;
  readonly visible: boolean;
}
/** 唯一实时来源仓。租约身份与题值分开，旧 cleanup 不能清掉新 host。 */
export function createLearningContextStore() {
  let epoch = 0;
  let routeEpoch = 0;
  let principal: string | null = null;
  let host: HostLease | null = null;
  let snapshot: LearningSnapshot = {
    epoch,
    principal,
    host,
    source: emptySource,
    explicit: false,
    visible: true,
  };
  let pinned = false;
  let principalOwner: symbol | null = null;
  const listeners = new Set<() => void>();
  const emit = (patch: Partial<LearningSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const fn of listeners) fn();
  };
  const valid = (lease: HostLease) => host === lease && lease.epoch === epoch;
  const copy = (source: LearningSource): LearningSource =>
    structuredClone(source);
  const stamp = (lease: HostLease, source: LearningSource): LearningSource => {
    const surface =
      source.reference?.kind === "question"
        ? source.reference.surface
        : source.reference?.kind === "lecture"
          ? "lecture"
          : undefined;
    const view: LearningContext["view"] | undefined = surface
      ? { surface, layout: source.layout ?? null, viewId: lease.viewId }
      : source.view;
    return {
      ...copy(source),
      principal,
      ...(view ? { view } : {}),
      ...(source.context && view
        ? { context: { ...source.context, view } }
        : {}),
    };
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bindPrincipal(next: string | null) {
      if (next === principal) return;
      principal = next;
      epoch++;
      host = null;
      pinned = false;
      emit({ epoch, principal, host, source: emptySource, explicit: false });
    },
    bindPrincipalLease(next: string | null) {
      const owner = Symbol("principal");
      principalOwner = owner;
      if (next !== principal) {
        principal = next;
        epoch++;
        host = null;
        pinned = false;
        emit({ epoch, principal, host, source: emptySource, explicit: false });
      }
      return () => {
        if (principalOwner !== owner) return;
        principalOwner = null;
        principal = null;
        epoch++;
        host = null;
        pinned = false;
        emit({ epoch, principal, host, source: emptySource, explicit: false });
      };
    },
    reset() {
      epoch++;
      host = null;
      pinned = false;
      emit({ epoch, host, source: emptySource, explicit: false });
    },
    registerHost(
      route: string,
      sourceOf: HostLease["sourceOf"],
      attemptStatus?: AttemptStatus,
    ): HostLease {
      host = {
        token: Symbol(route),
        epoch,
        routeEpoch: ++routeEpoch,
        viewId: crypto.randomUUID(),
        route,
        sourceOf,
        attemptStatus,
      };
      pinned = false;
      emit({ host, source: emptySource, explicit: false });
      return host;
    },
    release(lease: HostLease) {
      if (!valid(lease)) return;
      host = null;
      pinned = false;
      emit({ host, source: emptySource, explicit: false });
    },
    explicit(lease: HostLease, source: LearningSource) {
      if (valid(lease)) emit({ source: stamp(lease, source), explicit: true });
    },
    observe(
      lease: HostLease,
      source: LearningSource,
      explicitEligible: boolean,
    ) {
      if (!valid(lease) || (snapshot.explicit && (explicitEligible || pinned)))
        return;
      if (
        JSON.stringify(snapshot.source) ===
          JSON.stringify(stamp(lease, source)) &&
        !snapshot.explicit
      )
        return;
      emit({ source: stamp(lease, source), explicit: false });
    },
    resolve(
      lease: HostLease,
      reference: LearningContextRequest,
      context: LearningContext,
    ) {
      if (
        !valid(lease) ||
        JSON.stringify(snapshot.source.reference) !== JSON.stringify(reference)
      )
        return;
      const source = stamp(lease, {
        ...snapshot.source,
        context: structuredClone(context),
      });
      if (JSON.stringify(source) !== JSON.stringify(snapshot.source))
        emit({ source });
    },
    pin(lease: HostLease, on: boolean) {
      if (valid(lease)) pinned = on;
    },
    setVisible(visible: boolean) {
      if (visible !== snapshot.visible) emit({ visible });
    },
    captureQuestion(
      lease: HostLease | null,
      target: LearningQuestionTarget,
    ): LearningSource | null {
      if (!lease || !valid(lease) || lease.route !== target.attemptId)
        return null;
      const source = lease.sourceOf(target.questionId);
      const reference = source?.reference;
      if (
        !source ||
        reference?.kind !== "question" ||
        reference.attemptId !== target.attemptId ||
        reference.questionId !== target.questionId ||
        reference.surface !== target.surface ||
        (target.questionRevisionId !== undefined &&
          reference.expectedQuestionRevisionId !== target.questionRevisionId)
      )
        return null;
      return stamp(lease, source);
    },
  };
}
export const learningContextStore = createLearningContextStore();
export function useLearningContextSnapshot() {
  return useSyncExternalStore(
    learningContextStore.subscribe,
    learningContextStore.getSnapshot,
    learningContextStore.getSnapshot,
  );
}
export function captureLearningSource(
  expectedPrincipal?: string | null,
): LearningSource {
  const snapshot = learningContextStore.getSnapshot();
  if (
    expectedPrincipal !== undefined &&
    snapshot.principal !== expectedPrincipal
  )
    return { anchor: { kind: "none" }, principal: expectedPrincipal };
  return structuredClone({ ...snapshot.source, principal: snapshot.principal });
}
