import { describe, expect, it } from "vitest";
import { buildSummaryMessages, formatSummaryText } from "./summary";

describe("formatSummaryText", () => {
  it("renders overview and bulleted sections under the topic name", () => {
    const text = formatSummaryText("Hərəkət qanunları", {
      overview: "Nyutonun üç qanunu cismin hərəkətini təsvir edir.",
      concepts: ["Ətalət", "Qüvvə"],
      rules: ["F = m·a"],
      commonMistakes: ["Kütlə ilə çəkini qarışdırmaq"],
      reviewQuestions: ["Ətalət qanunu nədir?"],
    });
    expect(text).toBe(
      [
        "Hərəkət qanunları",
        "Nyutonun üç qanunu cismin hərəkətini təsvir edir.",
        "Əsas anlayışlar:\n- Ətalət\n- Qüvvə",
        "Qaydalar:\n- F = m·a",
        "Tipik səhvlər:\n- Kütlə ilə çəkini qarışdırmaq",
        "Təkrar sualları:\n- Ətalət qanunu nədir?",
      ].join("\n\n"),
    );
  });

  it("needs at least one structured section beyond the title and overview, else null", () => {
    // Title + overview only (no concepts/rules/mistakes/review questions) isn't a usable konspekt.
    expect(formatSummaryText("Mövzu", { overview: "Qısa icmal.", concepts: [], rules: [], commonMistakes: [], reviewQuestions: [] })).toBeNull();
    expect(formatSummaryText("Mövzu", { overview: "", concepts: [], rules: [], commonMistakes: [], reviewQuestions: [] })).toBeNull();
    expect(formatSummaryText("Mövzu", "not json")).toBeNull();
    expect(formatSummaryText("Mövzu", null)).toBeNull();
  });

  it("coerces non-string items instead of throwing, and drops blanks", () => {
    const text = formatSummaryText("Mövzu", { overview: "İcmal.", concepts: [1, "  ", "Əsas anlayış"], rules: [], commonMistakes: [], reviewQuestions: [] });
    expect(text).toBe("Mövzu\n\nİcmal.\n\nƏsas anlayışlar:\n- 1\n- Əsas anlayış");
  });
});

describe("buildSummaryMessages", () => {
  it("fences the questions between nonce-tagged markers and keeps them out of the system prompt", () => {
    const messages = buildSummaryMessages("Triqonometriya", ["#1: sin(x) nədir?", "#2: cos qaydası"], "abc123");
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).not.toContain("sin(x)");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Topic: Triqonometriya\n\n<<<Q-abc123>>>\n#1: sin(x) nədir?\n#2: cos qaydası\n<<<END-Q-abc123>>>");
  });
});
