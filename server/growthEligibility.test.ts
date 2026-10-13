import { describe, expect, it } from "vitest";
import { closedForEveryoneIds, exposureOf, isClosedForEveryone, type QuestionLink } from "./growth/eligibility";
import { practisable } from "./growth/practice";
import type { RetakeCandidate } from "./growth/retake";

const now = new Date("2026-10-13T12:00:00Z");
const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
const ahead = (h: number) => new Date(now.getTime() + h * 3_600_000);

describe("isClosedForEveryone", () => {
  it("a published exam whose window is still running is open, even if the student's result was released at submission", () => {
    expect(isClosedForEveryone({ status: "PUBLISHED", endAt: ahead(2) }, [null], false, now)).toBe(false);
  });

  it("a published exam past its end for every assignment is closed", () => {
    expect(isClosedForEveryone({ status: "PUBLISHED", endAt: ago(1) }, [null, ago(3)], false, now)).toBe(true);
  });

  it("one student's later availableUntil keeps it open for everyone", () => {
    expect(isClosedForEveryone({ status: "PUBLISHED", endAt: ago(1) }, [null, ahead(24)], false, now)).toBe(false);
  });

  it("an earlier per-assignment end does not close an exam whose own window is still running", () => {
    expect(isClosedForEveryone({ status: "PUBLISHED", endAt: ahead(5) }, [ago(2)], false, now)).toBe(false);
  });

  it("no end date anywhere means the window never closes", () => {
    expect(isClosedForEveryone({ status: "PUBLISHED", endAt: null }, [], false, now)).toBe(false);
    expect(isClosedForEveryone({ status: "PUBLISHED", endAt: null }, [ago(2)], false, now)).toBe(false);
    expect(isClosedForEveryone({ status: "PUBLISHED", endAt: ago(1) }, [], false, now)).toBe(true);
  });

  it("drafts and upcoming exams are never closed", () => {
    expect(isClosedForEveryone({ status: "DRAFT", endAt: ago(1) }, [], false, now)).toBe(false);
    expect(isClosedForEveryone({ status: "PUBLISHED", endAt: ahead(48) }, [null], false, now)).toBe(false);
  });

  it("an attempt in progress keeps it open, also after the teacher closed it or the window passed", () => {
    expect(isClosedForEveryone({ status: "CLOSED", endAt: ahead(5) }, [], true, now)).toBe(false);
    expect(isClosedForEveryone({ status: "PUBLISHED", endAt: ago(1) }, [null], true, now)).toBe(false);
  });

  it("closed by the teacher (and nobody mid-attempt) is closed whatever the dates say", () => {
    expect(isClosedForEveryone({ status: "CLOSED", endAt: ahead(5) }, [ahead(24)], false, now)).toBe(true);
  });
});

describe("exposureOf", () => {
  const link = (questionId: string, assessmentId: string, published = true): QuestionLink => ({ questionId, assessmentId, published });

  it("blocks a question while any assessment holding it is not closed, through a version copy or the draft list", () => {
    const e = exposureOf([link("q1", "closed"), link("q1", "open"), link("q2", "closed"), link("q3", "draft", false)], new Set(["closed"]));
    expect([...e.blocked].sort()).toEqual(["q1", "q3"]);
    expect([...closedForEveryoneIds(e)]).toEqual(["q2"]);
  });

  it("a closed exam's draft list alone is not an appearance", () => {
    const e = exposureOf([link("q1", "closed", false)], new Set(["closed"]));
    expect(e.blocked.size).toBe(0);
    expect(closedForEveryoneIds(e).size).toBe(0);
  });

  it("keeps every closed assessment a question appeared in", () => {
    const e = exposureOf([link("q1", "a"), link("q1", "b")], new Set(["a", "b"]));
    expect([...e.closedIn.get("q1")!].sort()).toEqual(["a", "b"]);
  });
});

describe("practisable", () => {
  const c = (id: string): RetakeCandidate => ({ id, topicKey: "qt:s1", difficulty: "MEDIUM", seen: true });

  it("needs a closed-for-everyone exam assigned to the student and no open one", () => {
    const exposure = exposureOf(
      [
        { questionId: "mine", assessmentId: "myClosed", published: true },
        { questionId: "other", assessmentId: "otherClosed", published: true },
        { questionId: "reused", assessmentId: "myClosed", published: true },
        { questionId: "reused", assessmentId: "running", published: true },
        { questionId: "taken", assessmentId: "running", published: true },
      ],
      new Set(["myClosed", "otherClosed"]),
    );
    const out = practisable([c("mine"), c("other"), c("reused"), c("taken"), c("unused")], exposure, new Set(["myClosed", "running"]));
    expect(out.map((x) => x.id)).toEqual(["mine"]);
  });
});
