import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reviewEdit, reviewProblems, reviewStats, reviewTimingCheck } from "../client/src/lib/syllabusImportReview";
import { syllabusImportStructureSchema, type SyllabusImportStructure } from "../shared/syllabusImport";
import { checkModuleDurations, lessonMinutes, suggestedLessonCount, sumDurations } from "../shared/syllabusTiming";
import type { TeacherScope } from "./modules/access";
import { extractDocument, renderDoc } from "./modules/textExtract";
import * as authoring from "./syllabus/authoring";
import { AI_ENGINEERING_MODULE_DETAILS } from "./syllabus/content/aiEngineeringModuleDetails";
import { createFromStructure, importPlan } from "./syllabus/importCreate";
import {
  buildImportMessages,
  lessonsPerWeekFromText,
  mergeParts,
  moduleDurationFromTitle,
  normalizeStructure,
  parseDuration,
  parseImportOutput,
  splitTextChunks,
  type RawPart,
} from "./syllabus/importExtraction";
import { zip } from "./zipFixture";

vi.mock("./syllabus/authoring", () => ({
  createSyllabus: vi.fn(),
  updateCourseTiming: vi.fn(),
  createModule: vi.fn(),
  updateModuleDetails: vi.fn(),
  updateModuleDuration: vi.fn(),
  createLesson: vi.fn(),
  createItem: vi.fn(),
  discardDraft: vi.fn(),
}));

const FIXTURES = join(__dirname, "syllabus", "__fixtures__");
const SOURCE_MD = readFileSync(join(FIXTURES, "ai-engineering-syllabus.md"), "utf8").replace(/\r\n/g, "\n");
/** What a model returns for the fixture, quirks included (heading marks and bullets left in, strings for numbers, missing durations). */
const AI_REPLY = readFileSync(join(FIXTURES, "ai-engineering-import.ai.json"), "utf8");

/** Ground truth read straight from the markdown: each "## …" module with the bullets under "### Mövzular". */
function sourceModules() {
  return SOURCE_MD.split(/\n## /)
    .slice(1)
    .map((block) => {
      const [title, ...rest] = block.split("\n");
      const topics: string[] = [];
      let inTopics = false;
      for (const line of rest) {
        if (line.startsWith("### ")) inTopics = line.trim() === "### Mövzular";
        else if (inTopics && line.startsWith("- ")) topics.push(line.slice(2).trim());
      }
      return { title: title.trim(), topics };
    });
}

function importFixture(): SyllabusImportStructure {
  const part = parseImportOutput("```json\n" + AI_REPLY + "\n```");
  expect(part).not.toBeNull();
  const s = normalizeStructure(mergeParts([part!]), "ai-engineering.md");
  expect(s).not.toBeNull();
  return s!;
}

describe("AI Engineering syllabus from a mocked AI reply", () => {
  const s = importFixture();
  const source = sourceModules();

  it("keeps the course header as written", () => {
    expect(s.title).toBe("AI ENGINEER – 9 AYLIQ PRAKTİK PROQRAM");
    expect(s.description.split("\n")).toEqual([
      "Müddət: 9 ay",
      "Format: Nəzəriyyə + intensiv praktika + real layihələr",
      "Səviyyə: Beginner → Professional",
      "Tədris: Həftədə 2 dərs",
      "Əsas məqsəd: AI sistemlərini hazırlamaq, inteqrasiya etmək və production mühitinə çıxarmaq",
    ]);
    expect(s.level).toBe("Beginner → Professional");
    expect(s.language).toBe("az");
    expect(s.durationLabel).toBe("9 ay");
  });

  it("finds 9 modules with their titles verbatim and in order", () => {
    expect(s.modules).toHaveLength(9);
    expect(s.modules.map((m) => m.title)).toEqual(source.map((m) => m.title));
    expect(s.modules[0].title).toBe("1-ci AY — Python & Programming Fundamentals");
    expect(s.modules[8].title).toBe("9-cu AY — Deployment, MLOps & Final Project");
  });

  it("turns each module's own topics into its lessons, nothing moved between modules", () => {
    s.modules.forEach((m, i) => {
      expect(m.lessons.map((l) => l.title)).toEqual(source[i].topics);
      expect(m.lessons.every((l) => l.minutes === null && l.points.length === 0)).toBe(true);
    });
    expect(s.modules[2].lessons[0].title).toBe("Machine Learning fundamentals");
  });

  it("keeps the practical projects of each module", () => {
    expect(s.modules[0].projectsHeading).toBe("Praktiki layihə");
    expect(s.modules[0].projects).toEqual([{ title: "Python əsaslı mini tətbiq", description: "" }]);
    expect(s.modules[2].projectsHeading).toBe("Praktiki layihələr");
    expect(s.modules[2].projects.map((p) => p.title)).toEqual(["House Price Prediction", "Customer Churn Prediction", "Customer Segmentation"]);
    expect(s.modules[5].projects).toEqual([
      { title: "AI Knowledge Assistant", description: "İstifadəçi şirkətin sənədlərini yükləyir və AI həmin sənədlər əsasında sualları cavablandırır." },
    ]);
    const final = s.modules[8];
    expect(final.projectsHeading).toBe("Final Project");
    expect(final.projects).toHaveLength(1);
    expect(final.projects[0].description).toContain("Problem → Data → Model → LLM → RAG/Agent → Backend → API → Database → Docker → Deployment");
    expect(final.projects[0].description).toContain("- AI Customer Support platforması");
    expect(final.projects[0].description).toContain("- AI Research Assistant");
  });

  it("fills the three end-of-module blocks exactly as the source has them", () => {
    s.modules.forEach((m, i) => expect(m.details).toEqual(AI_ENGINEERING_MODULE_DETAILS[i].details));
  });

  it("reads the timing: 9 months, 2 lessons a week, each module one month", () => {
    expect(s.timing).toEqual({ duration: { value: 9, unit: "MONTHS" }, lessonsPerWeek: 2, lessonMinutes: null });
    expect(s.modules.map((m) => m.duration)).toEqual(Array(9).fill({ value: 1, unit: "MONTHS" }));
    expect(checkModuleDurations(s.timing.duration, s.modules.map((m) => m.duration))).toEqual({ sum: { value: 9, unit: "MONTHS" }, missing: 0, mismatch: false });
  });

  it("is accepted by the schema the create endpoint validates", () => {
    expect(syllabusImportStructureSchema.safeParse(s).success).toBe(true);
  });
});

describe("blocks the source does not have", () => {
  it("stay empty instead of being invented", () => {
    const part = parseImportOutput(JSON.stringify({ syllabus: { title: "Java" }, modules: [{ title: "Modul 1 — Giriş", lessons: ["Dəyişənlər", "Dövrlər"] }] }));
    const s = normalizeStructure(mergeParts([part!]), "")!;
    expect(s.modules[0].details).toEqual({ objectives: [], prerequisites: [], assessment: { heading: "", intro: "", pipeline: "", listIntro: "", items: [] } });
    expect(s.modules[0].projects).toEqual([]);
    expect(s.modules[0].projectsHeading).toBe("");
    expect(s.modules[0].duration).toBeNull();
    expect(s.timing).toEqual({ duration: null, lessonsPerWeek: null, lessonMinutes: null });
  });

  it("returns null when no module was found, and for output that is not the expected JSON", () => {
    expect(normalizeStructure(mergeParts([parseImportOutput('{"syllabus":{"title":"x"},"modules":[]}')!]), "")).toBeNull();
    expect(parseImportOutput("I could not read this document.")).toBeNull();
    expect(parseImportOutput('{"modules": "none"}')).toBeNull();
  });
});

describe("long documents read in parts", () => {
  const full = JSON.parse(AI_REPLY) as { syllabus: Record<string, unknown>; modules: Array<Record<string, unknown> & { lessons: unknown[] }> };

  it("merges a module cut across two parts and nothing else", () => {
    const fifth = full.modules[4];
    const partA: RawPart = parseImportOutput(JSON.stringify({ syllabus: full.syllabus, modules: [...full.modules.slice(0, 4), { title: fifth.title, lessons: fifth.lessons.slice(0, 6) }] }))!;
    const partB: RawPart = parseImportOutput(
      JSON.stringify({
        syllabus: {},
        modules: [{ title: fifth.title, continuesPrevious: true, lessons: fifth.lessons.slice(6), projectsHeading: fifth.projectsHeading, projects: fifth.projects, objectives: fifth.objectives, prerequisites: fifth.prerequisites, assessment: fifth.assessment }, ...full.modules.slice(5)],
      }),
    )!;
    const merged = normalizeStructure(mergeParts([partA, partB]), "x")!;
    expect(merged).toEqual(importFixture());
  });

  it("never merges a part's first module into the previous one unless it continues it", () => {
    const a = parseImportOutput(JSON.stringify({ syllabus: {}, modules: [{ title: "Modul 1", lessons: ["A"] }] }))!;
    const b = parseImportOutput(JSON.stringify({ syllabus: {}, modules: [{ title: "Modul 2", lessons: ["B"] }] }))!;
    const s = normalizeStructure(mergeParts([a, b]), "x")!;
    expect(s.modules.map((m) => [m.title, m.lessons.map((l) => l.title)])).toEqual([
      ["Modul 1", ["A"]],
      ["Modul 2", ["B"]],
    ]);
    const repeated = parseImportOutput(JSON.stringify({ syllabus: {}, modules: [{ title: "modul 1 ", lessons: ["A2"] }, { title: "Modul 2" }] }))!;
    const s2 = normalizeStructure(mergeParts([a, repeated]), "x")!;
    expect(s2.modules.map((m) => [m.title, m.lessons.map((l) => l.title)])).toEqual([
      ["Modul 1", ["A", "A2"]],
      ["Modul 2", []],
    ]);
  });

  it("cuts long text before module headings", () => {
    const chunks = splitTextChunks(SOURCE_MD, 2_500);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 2_500)).toBe(true);
    expect(chunks.join("\n").replace(/\s+/g, "")).toBe(SOURCE_MD.replace(/\s+/g, ""));
    for (const c of chunks.slice(1)) expect(c).toMatch(/^#{2,3} /);
    expect(splitTextChunks(SOURCE_MD, 100_000)).toEqual([SOURCE_MD.trim()]);
  });

  it("tells the model which part it reads and what came before, with the document fenced as data", () => {
    const msgs = buildImportMessages({ parts: null, documentText: "## 2-ci AY", part: { index: 1, total: 3 }, previousModules: ["1-ci AY — Python"], nonce: "n1" });
    const user = JSON.stringify(msgs[1].content);
    expect(user).toContain("part 2 of 3");
    expect(user).toContain("1-ci AY — Python");
    expect(user).toContain("<<<DOC-n1>>>");
    expect(String(msgs[0].content)).toContain("Never invent");
  });
});

describe("timing read from the source", () => {
  it("parses durations in AZ, EN and RU", () => {
    expect(parseDuration("9 ay")).toEqual({ value: 9, unit: "MONTHS" });
    expect(parseDuration("12 weeks")).toEqual({ value: 12, unit: "WEEKS" });
    expect(parseDuration("3 месяца")).toEqual({ value: 3, unit: "MONTHS" });
    expect(parseDuration("6 həftə")).toEqual({ value: 6, unit: "WEEKS" });
    expect(parseDuration({ value: "1,5", unit: "months" })).toEqual({ value: 1.5, unit: "MONTHS" });
    expect(parseDuration("bir neçə ay")).toBeNull();
    expect(parseDuration({ value: 0, unit: "MONTHS" })).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });

  it("reads a month heading as a one-month module", () => {
    expect(moduleDurationFromTitle("1-ci AY — Python")).toEqual({ value: 1, unit: "MONTHS" });
    expect(moduleDurationFromTitle("6-cı AY — LLM")).toEqual({ value: 1, unit: "MONTHS" });
    expect(moduleDurationFromTitle("Month 2: Data")).toEqual({ value: 1, unit: "MONTHS" });
    expect(moduleDurationFromTitle("3-й месяц")).toEqual({ value: 1, unit: "MONTHS" });
    expect(moduleDurationFromTitle("Modul 1 — Giriş")).toBeNull();
  });

  it("reads lessons per week", () => {
    expect(lessonsPerWeekFromText("Tədris: Həftədə 2 dərs")).toBe(2);
    expect(lessonsPerWeekFromText("3 lessons per week")).toBe(3);
    expect(lessonsPerWeekFromText("2 раза в неделю")).toBe(2);
    expect(lessonsPerWeekFromText("Həftədə 40 dərs")).toBeNull();
    expect(lessonsPerWeekFromText("no schedule")).toBeNull();
  });
});

describe("builder timing helpers", () => {
  it("sums module durations and warns, never blocks, when they differ from the course total", () => {
    const month = { value: 1, unit: "MONTHS" } as const;
    expect(sumDurations([month, month])).toEqual({ value: 2, unit: "MONTHS" });
    expect(sumDurations([month, { value: 2, unit: "WEEKS" }])).toEqual({ value: 6.3, unit: "WEEKS" });
    expect(checkModuleDurations({ value: 9, unit: "MONTHS" }, [month, month, null])).toEqual({ sum: { value: 2, unit: "MONTHS" }, missing: 1, mismatch: true });
    expect(checkModuleDurations({ value: 3, unit: "MONTHS" }, [{ value: 13, unit: "WEEKS" }])).toMatchObject({ mismatch: false });
    expect(checkModuleDurations(null, [month])).toMatchObject({ mismatch: false });
  });

  it("suggests a lesson count from cadence × duration and totals lesson minutes", () => {
    expect(suggestedLessonCount(2, { value: 1, unit: "MONTHS" })).toBe(9);
    expect(suggestedLessonCount(2, { value: 9, unit: "MONTHS" })).toBe(78);
    expect(suggestedLessonCount(null, { value: 1, unit: "MONTHS" })).toBeNull();
    expect(lessonMinutes([{ estimatedMinutes: 90 }, { estimatedMinutes: null }, { estimatedMinutes: 45 }])).toEqual({ minutes: 135, missing: 1 });
  });
});

describe("review before creating", () => {
  it("renames, reorders and deletes without touching other modules", () => {
    const s = importFixture();
    let r = reviewEdit.renameModule(s, 0, "Python");
    r = reviewEdit.moveModule(r, 0, 1);
    expect(r.modules.slice(0, 2).map((m) => m.title)).toEqual([s.modules[1].title, "Python"]);
    r = reviewEdit.removeLesson(r, 1, 0);
    r = reviewEdit.moveLesson(r, 1, 0, 1);
    expect(r.modules[1].lessons.slice(0, 2).map((l) => l.title)).toEqual([s.modules[0].lessons[2].title, s.modules[0].lessons[1].title]);
    expect(r.modules[0].lessons).toEqual(s.modules[1].lessons);
    r = reviewEdit.lessonMinutes(r, 1, 0, 90);
    expect(r.modules[1].lessons[0].minutes).toBe(90);
    r = reviewEdit.moduleDuration(r, 2, { value: 6, unit: "WEEKS" });
    expect(reviewTimingCheck(r).mismatch).toBe(true);
    r = reviewEdit.removeProject(r, 2, 0);
    expect(r.modules[2].projects.map((p) => p.title)).toEqual(["Customer Churn Prediction", "Customer Segmentation"]);
    expect(s.modules[0].title).toBe("1-ci AY — Python & Programming Fundamentals");
    expect(reviewEdit.moveModule(s, 0, -1).modules.map((m) => m.title)).toEqual(s.modules.map((m) => m.title));
  });

  it("counts what will be created and lists what blocks creation", () => {
    const s = importFixture();
    expect(reviewStats(s)).toEqual({ modules: 9, lessons: 127, projects: 15, withBlocks: 9 });
    expect(reviewProblems(s)).toEqual([]);
    const broken = reviewEdit.renameLesson(reviewEdit.syllabus(s, { title: " " }), 0, 0, "");
    expect(reviewProblems(broken)).toEqual(["NO_TITLE", "EMPTY_LESSON_TITLE"]);
    expect(reviewProblems({ ...s, modules: [] })).toContain("NO_MODULES");
  });
});

describe("Word documents", () => {
  it("are read into text with each heading on its own line, ready for the same pipeline", () => {
    const para = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t.replace(/&/g, "&amp;")}</w:t></w:r></w:p>`;
    const lines = SOURCE_MD.split("\n").slice(0, 60).filter((l) => l.trim() && l.trim() !== "---");
    const xml = `<w:document><w:body>${lines.map(para).join("")}</w:body></w:document>`;
    const res = extractDocument("AI syllabus.docx", zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": xml }));
    expect(res.ok).toBe(true);
    const text = renderDoc((res as Extract<typeof res, { ok: true }>).doc);
    expect(text.split("\n")).toContain("## 1-ci AY — Python & Programming Fundamentals");
    expect(text.split("\n")).toContain("- Python fundamentals");
    expect(text).toContain("Tədris: Həftədə 2 dərs");
    expect(splitTextChunks(text, 600)[1]).toMatch(/^#{2,3} /);
  });
});

// ---------------------------------------------------------------------------
// Creating the draft
// ---------------------------------------------------------------------------

const scope = { userId: 7, workspaceId: "ws1" } as unknown as TeacherScope;
const a = vi.mocked(authoring);

describe("creating from the reviewed structure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let n = 0;
    a.createSyllabus.mockResolvedValue({ id: "syl1" } as never);
    a.createModule.mockImplementation(async () => ({ id: `mod${++n}` }) as never);
    a.createLesson.mockImplementation(async () => ({ id: `les${++n}` }) as never);
    a.createItem.mockResolvedValue({} as never);
    a.updateModuleDetails.mockResolvedValue({} as never);
    a.updateModuleDuration.mockResolvedValue({ ok: true } as never);
    a.updateCourseTiming.mockResolvedValue({ ok: true } as never);
    a.discardDraft.mockResolvedValue({} as never);
  });

  it("plans topics as lessons and projects as teacher-graded tasks in a last lesson", () => {
    const plan = importPlan(importFixture());
    expect(plan.syllabus).toMatchObject({ title: "AI ENGINEER – 9 AYLIQ PRAKTİK PROQRAM", estimatedDurationLabel: "9 ay", language: "az" });
    expect(plan.course).toEqual({ duration: { value: 9, unit: "MONTHS" }, lessonsPerWeek: 2 });
    const ml = plan.modules[2];
    expect(ml.lessons).toHaveLength(17 + 1);
    expect(ml.lessons[0]).toEqual({ title: "Machine Learning fundamentals", estimatedMinutes: null, items: [] });
    expect(ml.lessons.at(-1)).toMatchObject({ title: "Praktiki layihələr" });
    expect(ml.lessons.at(-1)!.items.map((i) => [i.kind, i.title])).toEqual([
      ["STUDENT_PRACTICE", "House Price Prediction"],
      ["STUDENT_PRACTICE", "Customer Churn Prediction"],
      ["STUDENT_PRACTICE", "Customer Segmentation"],
    ]);
    expect(ml.lessons.at(-1)!.items[0].content).toEqual({ instructions: "", evaluation: "TEACHER", submissionType: "TEXT_OR_FILE" });
  });

  it("gives lessons the course-wide length and lists sub-points in a theory item", () => {
    const s = importFixture();
    const withPoints = { ...s, timing: { ...s.timing, lessonMinutes: 90 }, modules: [{ ...s.modules[0], lessons: [{ title: "OOP", minutes: null, points: ["Classes", "Inheritance"] }, { title: "Git", minutes: 45, points: [] }] }] };
    const [lesson, git] = importPlan(withPoints).modules[0].lessons;
    expect(lesson.estimatedMinutes).toBe(90);
    expect(git.estimatedMinutes).toBe(45);
    expect(lesson.items).toEqual([{ kind: "THEORY", title: "OOP", content: { blocks: [{ type: "markdown", md: "- Classes\n- Inheritance" }] } }]);
  });

  it("builds a draft through the normal authoring functions, module by module", async () => {
    const s = importFixture();
    expect(await createFromStructure(scope, s)).toEqual({ id: "syl1" });
    expect(a.createSyllabus).toHaveBeenCalledWith(scope, expect.objectContaining({ title: s.title }));
    expect(a.updateCourseTiming).toHaveBeenCalledWith(scope, "syl1", { duration: { value: 9, unit: "MONTHS" }, lessonsPerWeek: 2 });
    expect(a.createModule.mock.calls.map((c) => c[2].title)).toEqual(s.modules.map((m) => m.title));
    expect(a.updateModuleDetails).toHaveBeenCalledTimes(9);
    expect(a.updateModuleDuration).toHaveBeenCalledTimes(9);
    expect(a.createLesson).toHaveBeenCalledTimes(127 + 9);
    expect(a.createItem).toHaveBeenCalledTimes(15);
    expect(a.discardDraft).not.toHaveBeenCalled();
    const firstModuleId = (await a.createModule.mock.results[0].value) as { id: string };
    const lessonsOfFirst = a.createLesson.mock.calls.filter((c) => c[1] === firstModuleId.id).map((c) => c[2].title);
    expect(lessonsOfFirst).toEqual([...s.modules[0].lessons.map((l) => l.title), "Praktiki layihə"]);
  });

  it("skips timing and blocks the source did not have", async () => {
    const s = importFixture();
    const bare = { ...s, timing: { duration: null, lessonsPerWeek: null, lessonMinutes: null }, modules: [{ ...s.modules[0], duration: null, projects: [], projectsHeading: "", details: { objectives: [], prerequisites: [], assessment: { heading: "", intro: "", pipeline: "", listIntro: "", items: [] } } }] };
    await createFromStructure(scope, bare);
    expect(a.updateCourseTiming).not.toHaveBeenCalled();
    expect(a.updateModuleDetails).not.toHaveBeenCalled();
    expect(a.updateModuleDuration).not.toHaveBeenCalled();
    expect(a.createItem).not.toHaveBeenCalled();
  });

  it("removes the half-built draft when a step fails", async () => {
    a.createLesson.mockRejectedValueOnce(new Error("boom"));
    await expect(createFromStructure(scope, importFixture())).rejects.toThrow("boom");
    expect(a.discardDraft).toHaveBeenCalledWith(scope, "syl1");
  });
});
