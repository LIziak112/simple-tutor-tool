import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { QuestionHistoryLink } from "./QuestionHistoryLink";

it("历史入口保留记录来源与回看范围，并将返回位置固定到点击的题目", () => {
  render(
    <MemoryRouter
      initialEntries={[
        "/s/attempts/att-1?returnTo=%2Fs%2Frecords%3Fstatus%3Dgraded&reviewScope=wrong&reviewQuestion=old#result",
      ]}
    >
      <QuestionHistoryLink questionId="p1-q8" ariaPrefix="第 8 题" />
    </MemoryRouter>,
  );
  const target = new URL(
    screen
      .getByRole("link", { name: "第 8 题本题历史" })
      .getAttribute("href") ?? "",
    "http://localhost",
  );
  expect(target.pathname).toBe("/s/notebook/p1-q8");
  const source = new URL(
    target.searchParams.get("returnTo") ?? "",
    "http://localhost",
  );
  expect(source.pathname).toBe("/s/attempts/att-1");
  expect(source.searchParams.get("reviewQuestion")).toBe("p1-q8");
  expect(source.searchParams.get("reviewScope")).toBe("wrong");
  expect(source.searchParams.get("returnTo")).toBe("/s/records?status=graded");
  expect(source.hash).toBe("#result");
});
