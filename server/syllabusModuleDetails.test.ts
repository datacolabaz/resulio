import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ModuleDetailsBlocks } from "../client/src/components/syllabus/ModuleDetailsBlocks";
import { emptyModuleDetails, hasModuleDetails, moduleDetailsSchema, parseModuleDetails, type ModuleDetails } from "../shared/syllabusModuleDetails";
import { backfillRows, mapModules, planBackfill, type CandidateSyllabus } from "./syllabus/aiEngineeringBackfill";
import { AI_ENGINEERING_MODULE_DETAILS, AI_ENGINEERING_SYLLABUS_TITLE } from "./syllabus/content/aiEngineeringModuleDetails";
import { changedDetailModules, freezeModuleDetails } from "./syllabus/moduleDetails";
import { studentPathView } from "./syllabus/serialize";
import { diffStructures } from "./syllabus/snapshot";
import type { EngineOutput, ModuleStub, VersionStructure } from "./syllabus/types";

const MONTH_TITLES = AI_ENGINEERING_MODULE_DETAILS.map((c) => c.title);
const AZ_ORDINAL = ["1-ci", "2-ci", "3-cü", "4-cü", "5-ci", "6-cı", "7-ci", "8-ci", "9-cu"];

describe("AI Engineering module details content", () => {
  it("has the 9 months in order, each valid against the shared schema", () => {
    expect(AI_ENGINEERING_MODULE_DETAILS.map((c) => c.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const c of AI_ENGINEERING_MODULE_DETAILS) {
      expect(moduleDetailsSchema.parse(c.details)).toEqual(c.details);
      expect(c.details.objectives.length).toBeGreaterThan(0);
      expect(c.details.prerequisites.length).toBeGreaterThan(0);
      expect(c.details.assessment.items.length).toBeGreaterThan(0);
    }
  });

  it("keeps the program text verbatim", () => {
    const [m1, , m3, , , , , m8, m9] = AI_ENGINEERING_MODULE_DETAILS.map((c) => c.details);
    expect(m1.objectives[0]).toBe("Python proqramlaşdırma dilinin əsaslarını mənimsəmək");
    expect(m1.prerequisites).toEqual(["Proqramlaşdırma üzrə əvvəlcədən təcrübə tələb olunmur", "Kompüterdən əsas səviyyədə istifadə bacarığı", "Proqramlaşdırmaya və süni intellektə maraq"]);
    expect(m3.assessment.items[2]).toBe("Ən azı bir regression və ya classification probleminin həlli");
    expect(m8.assessment.items).toHaveLength(5);
    expect(m9.objectives).toHaveLength(6);
  });

  it("keeps the final project block structure (intro, pipeline, criteria) on month 9 only", () => {
    const a = AI_ENGINEERING_MODULE_DETAILS[8].details.assessment;
    expect(a.heading).toBe("Final Project");
    expect(a.intro).toBe("Tələbə tam işlək AI məhsulu hazırlamalıdır:");
    expect(a.pipeline).toBe("Problem → Data → AI Model/LLM → RAG/Agent → Backend → Database → Docker → Deployment");
    expect(a.listIntro).toBe("Qiymətləndirmə aşağıdakı meyarlar üzrə aparılır:");
    expect(a.items).toEqual([
      "Texniki düzgünlük",
      "AI komponentlərinin düzgün inteqrasiyası",
      "Backend və API arxitekturası",
      "Database istifadəsi",
      "Deployment",
      "Security və error handling",
      "Production architecture",
      "Layihənin təqdimatı və işlək demo",
    ]);
    for (const c of AI_ENGINEERING_MODULE_DETAILS.slice(0, 8)) expect([c.details.assessment.heading, c.details.assessment.pipeline]).toEqual(["", ""]);
  });

  it("matches each month title (with or without the 'N-ci AY —' prefix) by its own pattern only", () => {
    AI_ENGINEERING_MODULE_DETAILS.forEach((c, i) => {
      MONTH_TITLES.forEach((title, j) => expect(c.match.test(title), `${c.month} vs "${title}"`).toBe(i === j));
      expect(c.match.test(`${AZ_ORDINAL[i]} AY — ${c.title}`)).toBe(true);
    });
  });

  it("recognises the syllabus title", () => {
    for (const title of ["AI ENGINEER – 9 AYLIQ PRAKTİK PROQRAM", "AI Engineering", "ai-engineer bootcamp"]) expect(AI_ENGINEERING_SYLLABUS_TITLE.test(title)).toBe(true);
    for (const title of ["Java əsasları", "Data Engineering", "AI for teachers"]) expect(AI_ENGINEERING_SYLLABUS_TITLE.test(title)).toBe(false);
  });
});

describe("module details shape", () => {
  it("reads missing or malformed JSON as empty", () => {
    expect(parseModuleDetails(null)).toEqual(emptyModuleDetails());
    expect(parseModuleDetails({ objectives: "nope" })).toEqual(emptyModuleDetails());
    expect(parseModuleDetails({ objectives: ["a"] })).toEqual({ ...emptyModuleDetails(), objectives: ["a"] });
  });

  it("treats a details object as present only when some block has content", () => {
    expect(hasModuleDetails(null)).toBe(false);
    expect(hasModuleDetails(emptyModuleDetails())).toBe(false);
    expect(hasModuleDetails({ ...emptyModuleDetails(), prerequisites: ["x"] })).toBe(true);
    expect(hasModuleDetails({ ...emptyModuleDetails(), assessment: { ...emptyModuleDetails().assessment, pipeline: "A → B" } })).toBe(true);
  });

  it("rejects blank lines and over-long input", () => {
    expect(moduleDetailsSchema.safeParse({ objectives: [" "] }).success).toBe(false);
    expect(moduleDetailsSchema.safeParse({ objectives: ["x".repeat(501)] }).success).toBe(false);
    expect(moduleDetailsSchema.safeParse({ prerequisites: Array.from({ length: 31 }, () => "x") }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Backfill matching
// ---------------------------------------------------------------------------

const aiModules = (prefix = true) => MONTH_TITLES.map((title, i) => ({ id: `m${i + 1}`, title: prefix ? `${AZ_ORDINAL[i]} AY — ${title}` : title, position: i + 1 }));
const ai = (over: Partial<CandidateSyllabus> = {}): CandidateSyllabus => ({ id: "syl_ai", title: "AI Engineer – 9 aylıq praktik proqram", archived: false, modules: aiModules(), ...over });
const java: CandidateSyllabus = { id: "syl_java", title: "Java əsasları", archived: false, modules: [{ id: "j1", title: "Java basics", position: 1 }] };

describe("AI Engineering backfill plan", () => {
  it("finds the syllabus and maps modules 1–9 by position", () => {
    const plan = planBackfill([java, ai()]);
    expect(plan.action).toBe("fill");
    if (plan.action !== "fill") return;
    expect(plan.syllabusId).toBe("syl_ai");
    expect(plan.modules.map((m) => [m.moduleId, m.month])).toEqual(MONTH_TITLES.map((_, i) => [`m${i + 1}`, i + 1]));
  });

  it("orders by position, not by row order", () => {
    const shuffled = [...aiModules(false)].reverse();
    const mapping = mapModules(shuffled);
    expect(mapping.ok && mapping.modules.map((m) => m.moduleId)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]);
  });

  it("maps by keyword when the syllabus has an extra module", () => {
    const modules = [{ id: "intro", title: "Giriş", position: 0 }, ...aiModules()];
    const mapping = mapModules(modules);
    expect(mapping.ok && mapping.modules.map((m) => m.moduleId)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"]);
  });

  it("does nothing when no syllabus is titled AI Engineer", () => {
    expect(planBackfill([java])).toMatchObject({ action: "none", reason: expect.stringContaining("no syllabus") });
    expect(planBackfill([])).toMatchObject({ action: "none" });
  });

  it("does nothing when module titles do not line up with the months", () => {
    const generic = ai({ modules: MONTH_TITLES.map((_, i) => ({ id: `m${i + 1}`, title: `Modul ${i + 1}`, position: i + 1 })) });
    expect(planBackfill([generic])).toMatchObject({ action: "none", reason: expect.stringContaining("do not match") });
    const swapped = aiModules();
    [swapped[2].position, swapped[3].position] = [swapped[3].position, swapped[2].position];
    expect(planBackfill([ai({ modules: swapped })]).action).toBe("none");
    const doubled = [...aiModules(), { id: "extra", title: "Python advanced", position: 10 }];
    expect(planBackfill([ai({ modules: doubled })])).toMatchObject({ action: "none", reason: expect.stringContaining("2 modules match month 1") });
    expect(planBackfill([ai({ modules: aiModules().slice(0, 8) })]).action).toBe("none");
  });

  it("is ambiguous with two matching live syllabi, but ignores an archived copy", () => {
    expect(planBackfill([ai(), ai({ id: "syl_ai2", title: "AI Engineering (copy)" })])).toMatchObject({ action: "none", reason: expect.stringContaining("ambiguous") });
    expect(planBackfill([ai({ id: "old", archived: true }), ai()])).toMatchObject({ action: "fill", syllabusId: "syl_ai" });
  });
});

describe("AI Engineering backfill rows", () => {
  const plan = planBackfill([ai()]) as Extract<ReturnType<typeof planBackfill>, { action: "fill" }>;
  const allModules = MONTH_TITLES.map((_, i) => `m${i + 1}`);

  it("fills every empty module in the draft and in each version that contains it", () => {
    const rows = backfillRows(plan, new Set(), [{ id: "v1", moduleIds: allModules.slice(0, 8) }, { id: "v2", moduleIds: allModules }], new Set());
    expect(rows.draft).toHaveLength(9);
    expect(rows.draft[8]).toEqual({ moduleId: "m9", syllabusId: "syl_ai", details: AI_ENGINEERING_MODULE_DETAILS[8].details });
    expect(rows.version.filter((r) => r.versionId === "v1")).toHaveLength(8);
    expect(rows.version.filter((r) => r.versionId === "v2")).toHaveLength(9);
    expect(rows.skippedModules).toEqual([]);
  });

  it("leaves modules that already have details untouched, in the draft and in versions", () => {
    const rows = backfillRows(plan, new Set(["m2"]), [{ id: "v1", moduleIds: allModules }], new Set(["v1:m3"]));
    expect(rows.draft.map((r) => r.moduleId)).not.toContain("m2");
    expect(rows.version.map((r) => r.moduleId)).not.toContain("m2");
    expect(rows.version.map((r) => r.moduleId)).not.toContain("m3");
    expect(rows.draft.map((r) => r.moduleId)).toContain("m3");
    expect(rows.skippedModules).toEqual(["m2"]);
  });

  it("writes nothing on a second run", () => {
    const rows = backfillRows(plan, new Set(allModules), [{ id: "v1", moduleIds: allModules }], new Set());
    expect(rows).toEqual({ draft: [], version: [], skippedModules: allModules });
  });
});

// ---------------------------------------------------------------------------
// Serializing, publishing and the publish diff
// ---------------------------------------------------------------------------

const DETAILS: ModuleDetails = AI_ENGINEERING_MODULE_DETAILS[0].details;
const moduleStub = (id: string): ModuleStub =>
  ({ id, title: id, description: "", position: 0, estimatedMinutes: null, objectives: [], prerequisitesText: "", rules: {} as never, lessons: [{ id: `${id}-l`, moduleId: id, title: "L", description: "", position: 0, estimatedMinutes: null, objectives: [], rules: {} as never, items: [] }], items: [] }) as ModuleStub;
const STRUCTURE: VersionStructure = { formatVersion: 1, rules: {} as never, modules: [moduleStub("open"), moduleStub("locked"), moduleStub("bare")], finalItems: [] };
const OUTPUT = {
  progressPct: 0,
  completedLessons: 0,
  totalLessons: 3,
  syllabusCompleted: false,
  syllabusAwaitingApproval: false,
  currentModuleId: "open",
  currentLessonId: "open-l",
  transitions: [],
  finalItems: [],
  modules: STRUCTURE.modules.map((m) => ({ id: m.id, status: m.id === "locked" ? "LOCKED" : "AVAILABLE", unlockSource: null, lockReason: null, completedLessons: 0, totalLessons: 1, items: [] })),
  lessons: STRUCTURE.modules.map((m) => ({ id: `${m.id}-l`, moduleId: m.id, status: m.id === "locked" ? "LOCKED" : "AVAILABLE", unlockSource: null, lockReason: null, optional: false, items: [] })),
} as unknown as EngineOutput;

describe("studentPathView details", () => {
  it("shows details on unlocked modules only, and null where there are none", () => {
    const path = studentPathView(STRUCTURE, OUTPUT, new Map([["open", DETAILS], ["locked", DETAILS], ["bare", emptyModuleDetails()]]));
    expect(path.modules.map((m) => m.details)).toEqual([DETAILS, null, null]);
  });

  it("leaves syllabi without details exactly as before (details null)", () => {
    expect(studentPathView(STRUCTURE, OUTPUT).modules.every((m) => m.details === null)).toBe(true);
  });
});

describe("publishing details", () => {
  it("freezes only non-empty details of modules that made it into the version", async () => {
    const values = vi.fn();
    const tx = { insert: vi.fn(() => ({ values })) };
    await freezeModuleDetails(tx as never, "v9", new Map([["a", DETAILS], ["b", emptyModuleDetails()], ["draftOnly", DETAILS]]), ["a", "b"]);
    expect(values).toHaveBeenCalledWith([{ versionId: "v9", moduleId: "a", details: DETAILS }]);
    values.mockClear();
    await freezeModuleDetails(tx as never, "v9", new Map(), ["a"]);
    expect(values).not.toHaveBeenCalled();
  });

  it("counts a details-only edit as a changed module in the publish diff", () => {
    const changed = changedDetailModules(new Map([["open", DETAILS]]), new Map(), ["open", "bare"]);
    expect([...changed]).toEqual(["open"]);
    expect(changedDetailModules(new Map([["open", emptyModuleDetails()]]), new Map(), ["open"]).size).toBe(0);
    const diff = diffStructures(STRUCTURE, STRUCTURE, new Map(), new Map(), changed);
    expect(diff.modules.changed).toBe(1);
    expect(diff.changed).toBe(true);
    expect(diffStructures(STRUCTURE, STRUCTURE, new Map(), new Map()).changed).toBe(false);
  });
});

describe("ModuleDetailsBlocks", () => {
  const html = (details: ModuleDetails | null) => renderToStaticMarkup(createElement(ModuleDetailsBlocks, { details }));

  it("renders nothing for a module without details", () => {
    expect(html(null)).toBe("");
    expect(html(emptyModuleDetails())).toBe("");
  });

  it("renders the three labelled blocks and the final project structure", () => {
    const out = html(AI_ENGINEERING_MODULE_DETAILS[8].details);
    for (const text of ["🎯", "Məqsədlər", "📋", "İlkin tələblər", "📝", "Modul üzrə qiymətləndirmə", "Final Project", "Tələbə tam işlək AI məhsulu hazırlamalıdır:", "Problem → Data → AI Model/LLM", "Layihənin təqdimatı və işlək demo"]) {
      expect(out).toContain(text);
    }
    expect(out.match(/<li/g)).toHaveLength(6 + 5 + 8);
  });

  it("omits an empty block", () => {
    const out = html({ ...emptyModuleDetails(), objectives: ["Only this"] });
    expect(out).toContain("Məqsədlər");
    expect(out).not.toContain("İlkin tələblər");
    expect(out).not.toContain("Modul üzrə qiymətləndirmə");
  });
});
