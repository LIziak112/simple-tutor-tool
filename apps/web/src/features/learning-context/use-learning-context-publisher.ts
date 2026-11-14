import { useQueryClient } from "@tanstack/react-query";
import type { AttemptStatus, LearningContext } from "@tutor/contract";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePortalClients } from "@/features/runtime/portal-runtime";

import {
  type HostLease,
  type LearningSource,
  learningContextStore,
  useLearningContextSnapshot,
} from "./learning-context-store";
import { LearningPrincipalContext } from "./learning-principal";
export interface LearningQuestion {
  readonly id: string;
  readonly questionRevisionId?: string | undefined;
}
interface PublisherInput {
  route: string;
  surface: "attempt" | "result" | "lesson" | "lecture";
  questions?: readonly LearningQuestion[];
  title: string;
  attemptStatus?: AttemptStatus | undefined;
  layout?: string | null | undefined;
  lecture?: { id: string; courseId: string; courseName: string } | undefined;
  observedId?: string | null | undefined;
  isEditing?: ((id: string) => boolean) | undefined;
}
const questionKey = (source: LearningSource, principal: string | null) => [
  "student",
  "learning-context",
  principal,
  source.reference,
  source.expectedDisplay,
];
/** DOM 与菜单共用租约/来源身份门，旧宿主节点不能借新宿主发布。 */
function sourceForCard(
  card: HTMLElement,
  lease: HostLease,
  surface: PublisherInput["surface"],
) {
  const questionId = card.dataset.questionId ?? card.dataset.reviewQuestion;
  if (
    !questionId ||
    surface === "lecture" ||
    card.dataset.learningAttempt !== lease.route ||
    card.dataset.learningSurface !== surface ||
    card.dataset.learningView !== lease.viewId
  )
    return null;
  return learningContextStore.captureQuestion(lease, {
    attemptId: lease.route,
    questionId,
    surface,
    questionRevisionId: card.dataset.learningRevision,
  });
}
/** 页面注册一个租约；题卡只发布动作，不注册或卸载整个共享焦点。 */
export function useLearningContextPublisher(input: PublisherInput) {
  const { resolveLearningContext } = usePortalClients();

  const query = useQueryClient();
  const principal = useContext(LearningPrincipalContext);
  const snapshot = useLearningContextSnapshot();
  const latest = useRef(input);
  latest.current = input;
  const [lease, setLease] = useState<HostLease | null>(null);
  const epoch = snapshot.epoch;
  const { route, attemptStatus } = input;
  useEffect(() => {
    if (
      learningContextStore.getSnapshot().epoch !== epoch ||
      (principal !== undefined &&
        learningContextStore.getSnapshot().principal !== principal)
    )
      return;
    const host = learningContextStore.registerHost(
      route,
      (id) => {
        const current = latest.current;
        if (current.route !== route) return null;
        if (current.surface === "lecture" && current.lecture) {
          const reference = {
            kind: "lecture" as const,
            lectureId: current.lecture.id,
            courseId: current.lecture.courseId,
            sectionId: null,
          };
          return {
            anchor: {
              kind: "lecture",
              lectureId: reference.lectureId,
              sectionId: null,
              label: current.title.slice(0, 120) || "讲义",
            },
            reference,
          };
        }
        const questions = current.questions ?? [];
        const index = questions.findIndex((q) => q.id === id);
        const question = questions[index];
        if (!question || current.surface === "lecture") return null;
        const reference = {
          kind: "question" as const,
          attemptId: route,
          questionId: id,
          surface: current.surface,
          ...(question.questionRevisionId
            ? { expectedQuestionRevisionId: question.questionRevisionId }
            : {}),
        };
        const source: LearningSource = {
          anchor: {
            kind: "question",
            attemptId: route,
            questionId: id,
            label: `第 ${index + 1} 题 · ${current.title}`.slice(0, 120),
          },
          reference,
          layout: current.layout ?? null,
          expectedDisplay: {
            questionNo: index + 1,
            questionCount: questions.length,
          },
        };
        const context = query.getQueryData<LearningContext>(
          questionKey(source, learningContextStore.getSnapshot().principal),
        );
        return context === undefined ||
          context.session?.questionNo !== index + 1 ||
          context.session.questionCount !== questions.length
          ? source
          : { ...source, context };
      },
      attemptStatus,
    );
    setLease(host);
    return () => learningContextStore.release(host);
  }, [route, attemptStatus, query, epoch, principal]);
  const enrich = useCallback(
    (host: HostLease, source: LearningSource) => {
      const reference = source.reference;
      if (!reference || learningContextStore.getSnapshot().host !== host)
        return;
      const principal = learningContextStore.getSnapshot().principal;
      void query
        .fetchQuery({
          queryKey: questionKey(source, principal),
          queryFn: ({ signal }) => resolveLearningContext(reference, signal),
          staleTime: Infinity,
        })
        .then((context) => {
          const current = latest.current;
          if (source.reference?.kind === "question") {
            const qid = source.reference.questionId;
            const index =
              current.questions?.findIndex((q) => q.id === qid) ?? -1;
            if (
              index < 0 ||
              context.session?.questionNo !== index + 1 ||
              context.session.questionCount !== current.questions?.length
            )
              return;
          }
          learningContextStore.resolve(host, reference, context);
        })
        .catch(() => {});
    },
    [query, resolveLearningContext],
  );
  const eligible = useCallback(() => {
    const selected = learningContextStore.getSnapshot();
    const id =
      selected.source.anchor.kind === "question"
        ? selected.source.anchor.questionId
        : null;
    const host = selected.host;
    if (!id || !host) return false;
    if (
      latest.current.isEditing?.(id) ||
      document.querySelector('[role="dialog"][data-state="open"]')
    )
      return true;
    const card = [
      ...document.querySelectorAll<HTMLElement>(
        "[data-question-id],[data-review-question]",
      ),
    ].find(
      (el) =>
        (el.dataset.questionId === id || el.dataset.reviewQuestion === id) &&
        sourceForCard(el, host, latest.current.surface) !== null,
    );
    if (!card || card.closest("[hidden]")) return false;
    if (
      card.contains(document.activeElement) ||
      card.querySelector('[data-state="open"],details[open]')
    )
      return true;
    const rect = card.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const width = Math.max(
      0,
      Math.min(rect.right, innerWidth) - Math.max(rect.left, 0),
    );
    const height = Math.max(
      0,
      Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0),
    );
    return width * height >= rect.width * rect.height * 0.1;
  }, []);
  const publish = useCallback(
    (id: string, explicit: boolean) => {
      if (!lease || learningContextStore.getSnapshot().host !== lease) return;
      const source = lease.sourceOf(id);
      if (!source) return;
      if (explicit) learningContextStore.explicit(lease, source);
      else learningContextStore.observe(lease, source, eligible());
      enrich(lease, source);
    },
    [lease, enrich, eligible],
  );
  useEffect(() => {
    if (input.observedId) publish(input.observedId, false);
    else if (lease)
      learningContextStore.observe(
        lease,
        { anchor: { kind: "none" } },
        eligible(),
      );
  }, [input.observedId, publish, lease, eligible]);
  useEffect(() => {
    if (!lease) return;
    const interact = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const card = event.target.closest<HTMLElement>(
        "[data-question-id],[data-review-question]",
      );
      const source = card
        ? sourceForCard(card, lease, latest.current.surface)
        : null;
      if (source?.anchor.kind === "question")
        publish(source.anchor.questionId, true);
    };
    document.addEventListener("pointerdown", interact, true);
    document.addEventListener("focusin", interact, true);
    document.addEventListener("input", interact, true);
    return () => {
      document.removeEventListener("pointerdown", interact, true);
      document.removeEventListener("focusin", interact, true);
      document.removeEventListener("input", interact, true);
    };
  }, [lease, publish]);
  useEffect(() => {
    let frame = 0;
    const refresh = () => {
      const id = latest.current.observedId;
      if (id) publish(id, false);
    };
    const blur = () => queueMicrotask(refresh);
    const scroll = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          refresh();
        });
    };
    document.addEventListener("focusout", blur, true);
    window.addEventListener("scroll", scroll, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scroll, true);
      document.removeEventListener("focusout", blur, true);
    };
  }, [publish]);
  const observe = useCallback((id: string) => publish(id, false), [publish]);
  const explicit = useCallback((id: string) => publish(id, true), [publish]);
  return { observe, explicit, lease };
}
