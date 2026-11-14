import {
  NOTE_MAX_POINTS_PER_STROKE,
  NOTE_MAX_TOTAL_POINTS,
} from "@tutor/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { countPoints, totalPointsAfterWrite } from "./note-points";

/** 一笔：只带点数（内容与点数统计无关）；id 缺省即旧稿里没有 id 的笔画 */
function s(id: string | undefined, count: number) {
  return {
    ...(id === undefined ? {} : { id }),
    points: Array.from({ length: count }, () => 0),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("草稿全稿点数：写入一份新正文之后", () => {
  it("countPoints 是各笔点数之和", () => {
    expect(countPoints([])).toBe(0);
    expect(countPoints([s("a", 3), s(undefined, 5)])).toBe(8);
  });

  it("尾部追加（原来的最后一笔还在原位、后面多了几笔）：在旧总数上累加新笔，不重扫", () => {
    const next = [s("a", 3), s("b", 5), s("c", 2)];
    expect(totalPointsAfterWrite([s("a", 3)], next, 3)).toBe(10);
    // 故意给一个不对的旧总数：结果带着它，说明走的是累加而不是重扫
    expect(totalPointsAfterWrite([s("a", 3)], next, 100)).toBe(107);
    // 空稿上的第一笔
    expect(totalPointsAfterWrite([], [s("a", 3)], 0)).toBe(3);
  });

  it("局部擦除把一笔切成两段（笔数变多，但不是尾部追加）：全量重算", () => {
    // a（10 点）切成 4 点 + 5 点，b 往后挪了一位
    expect(
      totalPointsAfterWrite(
        [s("a", 10), s("b", 6)],
        [s("piece-1", 4), s("piece-2", 5), s("b", 6)],
        16,
      ),
    ).toBe(15);
    // 被切开的正是最后一笔
    expect(
      totalPointsAfterWrite(
        [s("a", 6), s("b", 10)],
        [s("a", 6), s("piece-1", 4), s("piece-2", 5)],
        16,
      ),
    ).toBe(15);
  });

  it("撤销把中间擦掉的一笔放回原位（笔数变多，但不是尾部追加）：全量重算", () => {
    expect(
      totalPointsAfterWrite(
        [s("b", 6), s("c", 2)],
        [s("a", 10), s("b", 6), s("c", 2)],
        8,
      ),
    ).toBe(18);
  });

  it("旧稿笔画没有 id，认不出是不是尾部追加：全量重算", () => {
    expect(
      totalPointsAfterWrite(
        [s(undefined, 3)],
        [s(undefined, 3), s(undefined, 5)],
        100,
      ),
    ).toBe(8);
  });

  it("笔数减少或不变（撤销、擦除、清空、等长替换）：全量重算", () => {
    expect(totalPointsAfterWrite([s("a", 3), s("b", 5)], [s("a", 3)], 8)).toBe(
      3,
    );
    expect(totalPointsAfterWrite([s("a", 3)], [s("z", 7)], 3)).toBe(7);
    expect(totalPointsAfterWrite([s("a", 3)], [], 3)).toBe(0);
  });

  it("追加的一笔超过单笔上限：告警、不计入；累计超过全稿预算：告警，都不阻断", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      totalPointsAfterWrite(
        [s("a", 3)],
        [s("a", 3), s("big", NOTE_MAX_POINTS_PER_STROKE + 1), s("c", 2)],
        3,
      ),
    ).toBe(5);
    expect(warn.mock.calls).toEqual([
      ["草稿新笔超单笔点数上限（保留本机，同步由服务端裁决）"],
    ]);

    warn.mockClear();
    expect(
      totalPointsAfterWrite(
        [s("a", 3)],
        [s("a", 3), s("b", 2)],
        NOTE_MAX_TOTAL_POINTS,
      ),
    ).toBe(NOTE_MAX_TOTAL_POINTS + 2);
    expect(warn.mock.calls).toEqual([
      ["草稿累计点数超全稿预算（保留本机，同步由服务端裁决）"],
    ]);
  });
});
