import { fireEvent, render } from "@testing-library/react";
import type {
  AttemptContextGroup,
  AttemptContextMaterial,
} from "@tutor/contract";
import { afterEach, expect, it, vi } from "vitest";
import { QuestionGroupAnchor } from "./QuestionGroupAnchor";

const group: AttemptContextGroup = {
  id: "g1",
  introMd: "",
  materialRefs: [{ material: "m1" }],
  questionIds: ["q1"],
  sourceVersion: 1,
};
const material: AttemptContextMaterial = {
  id: "m1",
  contentMd: "材料",
  anchors: [],
  slots: [],
  mediaPaths: [],
  sourceVersion: 1,
};
const originalScrollIntoView = Element.prototype.scrollIntoView;
afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
  document.documentElement.scrollTop = 0;
});

it.each(["scroll", "jump", "focus"])(
  "材料晚到不覆盖后续用户位置：%s",
  (action) => {
    const into = vi.fn();
    Element.prototype.scrollIntoView = into;
    const props = { group, readingKey: "a|g1", revealSignal: 1 };
    const view = render(
      <>
        <button type="button" data-testid="q2">
          第二题
        </button>
        <QuestionGroupAnchor {...props} materials={[]} />
      </>,
    );
    expect(into).toHaveBeenCalledTimes(1);
    const button = view.getByTestId("q2");
    if (action === "scroll") {
      document.documentElement.scrollTop = 120;
      fireEvent.scroll(window);
    } else if (action === "jump") {
      view.rerender(
        <>
          <button type="button" data-testid="q2">
            第二题
          </button>
          <QuestionGroupAnchor
            {...props}
            materials={[]}
            jumpSignal={{ questionId: "q2", seq: 2 }}
          />
        </>,
      );
    } else button.focus();
    const focused = document.activeElement;
    view.rerender(
      <>
        <button type="button" data-testid="q2">
          第二题
        </button>
        <QuestionGroupAnchor
          {...props}
          materials={[material]}
          jumpSignal={
            action === "jump" ? { questionId: "q2", seq: 2 } : undefined
          }
        />
      </>,
    );
    expect(into).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(focused);
  },
);
