import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ModuleBlocksView, type ModuleBlocksViewProps } from "../client/src/pages/teacher/syllabus/ModuleBlocksEditor";
import { applyDraft, cleanItems, draftOf, insertAfter, isDirty, moveItem, removeAt, setItem, validateDraft } from "../client/src/pages/teacher/syllabus/moduleBlocks";
import { DEFAULT_COMPLETION_RULES } from "../shared/syllabus";
import { emptyModuleDetails, MODULE_DETAILS_MAX_LINE, type ModuleDetails } from "../shared/syllabusModuleDetails";
import { backfillRows, planBackfill } from "./syllabus/aiEngineeringBackfill";
import { AI_ENGINEERING_MODULE_DETAILS } from "./syllabus/content/aiEngineeringModuleDetails";
import { applyLegacyPatch, isLegacyCopy, legacyModuleDetails, mergeLegacy, splitLegacyText, withLegacyFallback } from "./syllabus/legacyModuleDetails";
import { planLegacyMerge, type LegacyMergeInput } from "./syllabus/moduleDetailsBackfill";
import { freezeModuleDetails } from "./syllabus/moduleDetails";
import { studentPathView } from "./syllabus/serialize";
import { buildStructure } from "./syllabus/snapshot";
import type { EngineOutput, ModuleStub, VersionStructure } from "./syllabus/types";

const details = (over: Partial<ModuleDetails> = {}): ModuleDetails => ({ ...emptyModuleDetails(), ...over });

// ---------------------------------------------------------------------------
// Legacy fields → details
// ---------------------------------------------------------------------------

describe("splitting the old prerequisites text", () => {
  it("makes one trimmed item per line, drops blanks and bullet markers", () => {
    expect(splitLegacyText("  Python basics \r\n\n- Git\n• SQL\n2) Linux\n   ")).toEqual(["Python basics", "Git", "SQL", "Linux"]);
  });

  it("keeps a single line as one item and returns nothing for empty text", () => {
    expect(splitLegacyText("Basic algebra, functions; vectors")).toEqual(["Basic algebra, functions; vectors"]);
    expect(splitLegacyText("")).toEqual([]);
    expect(splitLegacyText(null)).toEqual([]);
    expect(splitLegacyText(" \n \n")).toEqual([]);
  });

  it("splits an over-long line at sentence ends instead of cutting text off", () => {
    const sentence = `${"word ".repeat(60).trim()}.`;
    const out = splitLegacyText(`${sentence} ${sentence} ${sentence}`);
    expect(out.every((l) => l.length <= MODULE_DETAILS_MAX_LINE)).toBe(true);
    expect(out.join(" ")).toBe(`${sentence} ${sentence} ${sentence}`);
  });
});

describe("merging the old fields into the details", () => {
  const legacy = legacyModuleDetails({ objectives: [" Learn X ", "", "Build Y"], prerequisitesText: "Python\nGit" });

  it("reads the old fields as details", () => {
    expect(legacy).toEqual(details({ objectives: ["Learn X", "Build Y"], prerequisites: ["Python", "Git"] }));
    expect(legacyModuleDetails({ objectives: null, prerequisitesText: null })).toEqual(emptyModuleDetails());
  });

  it("fills empty fields only and keeps everything else", () => {
    expect(mergeLegacy(undefined, legacy)).toEqual(legacy);
    const teacher = details({ objectives: ["Teacher objective"], assessment: { ...emptyModuleDetails().assessment, items: ["Quiz"] } });
    expect(mergeLegacy(teacher, legacy)).toEqual({ ...teacher, prerequisites: ["Python", "Git"] });
  });

  it("changes nothing when both fields are filled or the old fields are empty", () => {
    expect(mergeLegacy(details({ objectives: ["a"], prerequisites: ["b"] }), legacy)).toBeNull();
    expect(mergeLegacy(details(), emptyModuleDetails())).toBeNull();
    expect(mergeLegacy(undefined, emptyModuleDetails())).toBeNull();
  });

  it("plans draft and published-version rows for every syllabus, skipping excluded modules", () => {
    const input: LegacyMergeInput = {
      draftModules: [
        { id: "a", syllabusId: "s1", objectives: ["Old A"], prerequisitesText: "" },
        { id: "b", syllabusId: "s1", objectives: [], prerequisitesText: null },
        { id: "c", syllabusId: "s2", objectives: ["Old C"], prerequisitesText: "Req C" },
        { id: "ai1", syllabusId: "s3", objectives: ["Old AI"], prerequisitesText: "" },
      ],
      draftRows: new Map([["c", details({ objectives: ["Edited C"] })]]),
      versions: [{ id: "v1", modules: [{ id: "a", objectives: ["Old A v1"], prerequisitesText: "" }, { id: "ai1", objectives: ["Old AI"], prerequisitesText: "" }] }],
      versionRows: new Map(),
      exclude: new Set(["ai1"]),
    };
    const plan = planLegacyMerge(input);
    expect(plan.draft).toEqual([
      { moduleId: "a", syllabusId: "s1", details: details({ objectives: ["Old A"] }) },
      { moduleId: "c", syllabusId: "s2", details: details({ objectives: ["Edited C"], prerequisites: ["Req C"] }) },
    ]);
    expect(plan.version).toEqual([{ versionId: "v1", moduleId: "a", details: details({ objectives: ["Old A v1"] }) }]);
  });

  it("is a no-op when run again on its own output", () => {
    const first = planLegacyMerge({
      draftModules: [{ id: "a", syllabusId: "s", objectives: ["x"], prerequisitesText: "y" }],
      draftRows: new Map(),
      versions: [],
      versionRows: new Map(),
      exclude: new Set(),
    });
    const again = planLegacyMerge({
      draftModules: [{ id: "a", syllabusId: "s", objectives: ["x"], prerequisitesText: "y" }],
      draftRows: new Map(first.draft.map((r) => [r.moduleId, r.details])),
      versions: [],
      versionRows: new Map(),
      exclude: new Set(),
    });
    expect(again.draft).toEqual([]);
  });
});

describe("read-time fallback and API compatibility", () => {
  const modules = [
    { id: "noRow", objectives: ["Old"], prerequisitesText: "Req" },
    { id: "cleared", objectives: ["Old"], prerequisitesText: "" },
    { id: "nothing", objectives: [], prerequisitesText: "" },
  ];

  it("falls back to the old fields only for a module without a details row", () => {
    const out = withLegacyFallback(new Map([["cleared", emptyModuleDetails()]]), modules);
    expect(out.get("noRow")).toEqual(details({ objectives: ["Old"], prerequisites: ["Req"] }));
    expect(out.get("cleared")).toEqual(emptyModuleDetails());
    expect(out.has("nothing")).toBe(false);
  });

  it("maps old-client objectives / prerequisitesText into the details, and ignores a no-op round trip", () => {
    const current = details({ objectives: ["A"], prerequisites: ["P1", "P2"], assessment: { ...emptyModuleDetails().assessment, intro: "Keep" } });
    expect(applyLegacyPatch(current, { objectives: ["A"], prerequisitesText: "P1\nP2" })).toBeNull();
    expect(applyLegacyPatch(current, { objectives: ["B", " "] })).toEqual({ ...current, objectives: ["B"] });
    expect(applyLegacyPatch(current, { prerequisitesText: "" })).toEqual({ ...current, prerequisites: [] });
    expect(applyLegacyPatch(undefined, {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AI Engineering precedence over copied legacy values
// ---------------------------------------------------------------------------

describe("AI Engineering content takes precedence over legacy copies", () => {
  const MONTHS = AI_ENGINEERING_MODULE_DETAILS.map((c) => c.title);
  const ids = MONTHS.map((_, i) => `m${i + 1}`);
  const plan = planBackfill([{ id: "syl_ai", title: "AI Engineer", archived: false, modules: MONTHS.map((title, i) => ({ id: ids[i], title, position: i + 1 })) }]);
  if (plan.action !== "fill") throw new Error("plan");
  const draftModules = ids.map((id) => ({ id, syllabusId: "syl_ai", objectives: [`Old objective ${id}`], prerequisitesText: "Old prerequisite" }));
  const version = { id: "v1", modules: draftModules.map(({ id, objectives, prerequisitesText }) => ({ id, objectives, prerequisitesText })) };

  it("replaces rows that are only copies of the old fields (merge ran first)", () => {
    const merged = planLegacyMerge({ draftModules, draftRows: new Map(), versions: [version], versionRows: new Map(), exclude: new Set() });
    const rows = backfillRows(plan, {
      draftRows: new Map(merged.draft.map((r) => [r.moduleId, r.details])),
      draftModules,
      versions: [version],
      versionRows: new Map(merged.version.map((r) => [`${r.versionId}:${r.moduleId}`, r.details])),
    });
    expect(rows.draft.map((r) => r.details)).toEqual(AI_ENGINEERING_MODULE_DETAILS.map((c) => c.details));
    expect(rows.version).toHaveLength(9);
    expect(rows.skippedModules).toEqual([]);
  });

  it("keeps a block a teacher edited after the copy, and an emptied one", () => {
    const legacy = legacyModuleDetails(draftModules[0]);
    expect(isLegacyCopy(legacy, legacy)).toBe(true);
    const edited = { ...legacy, objectives: ["Teacher changed this"] };
    expect(isLegacyCopy(edited, legacy)).toBe(false);
    expect(isLegacyCopy(emptyModuleDetails(), emptyModuleDetails())).toBe(false);
    const rows = backfillRows(plan, { draftRows: new Map([["m1", edited], ["m2", emptyModuleDetails()]]), draftModules, versions: [], versionRows: new Map() });
    expect(rows.skippedModules).toEqual(["m1", "m2"]);
    expect(rows.draft).toHaveLength(7);
  });

  it("the merge leaves the AI Engineering modules alone when the backfill ran first (startup order)", () => {
    const merged = planLegacyMerge({ draftModules, draftRows: new Map(), versions: [version], versionRows: new Map(), exclude: new Set(ids) });
    expect(merged).toEqual({ draft: [], version: [] });
  });
});

// ---------------------------------------------------------------------------
// Snapshot, publish, student payload
// ---------------------------------------------------------------------------

const lessonStub = (moduleId: string) => ({ id: `${moduleId}-l`, moduleId, title: `Lesson of ${moduleId}`, description: "SECRET lesson body", position: 1, estimatedMinutes: 30, objectives: ["SECRET lesson objective"], rules: {} as never, items: [] });
const moduleStub = (id: string, over: Partial<ModuleStub> = {}): ModuleStub =>
  ({ id, title: `Module ${id}`, description: "SECRET module description", position: 1, estimatedMinutes: 90, objectives: [], prerequisitesText: "", rules: {} as never, lessons: [lessonStub(id)], items: [], ...over }) as ModuleStub;

const output = (structure: VersionStructure, locked: string[]) =>
  ({
    progressPct: 0,
    completedLessons: 0,
    totalLessons: structure.modules.length,
    syllabusCompleted: false,
    syllabusAwaitingApproval: false,
    currentModuleId: structure.modules[0].id,
    currentLessonId: null,
    transitions: [],
    finalItems: [],
    modules: structure.modules.map((m) => ({ id: m.id, status: locked.includes(m.id) ? "LOCKED" : "AVAILABLE", unlockSource: null, lockReason: locked.includes(m.id) ? { code: "PREVIOUS_MODULE", moduleId: "open", title: "Module open" } : null, completedLessons: 0, totalLessons: 1, items: [] })),
    lessons: structure.modules.map((m) => ({ id: `${m.id}-l`, moduleId: m.id, status: locked.includes(m.id) ? "LOCKED" : "AVAILABLE", unlockSource: null, lockReason: locked.includes(m.id) ? { code: "PREVIOUS_MODULE", moduleId: "open", title: "Module open" } : null, optional: false, items: [] })),
  }) as unknown as EngineOutput;

describe("student path payload", () => {
  const BLOCKS = AI_ENGINEERING_MODULE_DETAILS[0].details;

  it("sends a locked module's details but no description or lesson content", () => {
    const structure: VersionStructure = { formatVersion: 1, rules: {} as never, modules: [moduleStub("open"), moduleStub("locked")], finalItems: [] };
    const path = studentPathView(structure, output(structure, ["locked"]), new Map([["locked", BLOCKS]]));
    const locked = path.modules[1];
    expect(locked.status).toBe("LOCKED");
    expect(locked.details).toEqual(BLOCKS);
    expect(locked.description).toBeNull();
    expect(locked.lessons).toEqual([{ id: "locked-l", title: "Lesson of locked", position: 1, status: "LOCKED", lockReason: expect.any(Object), optional: false, estimatedMinutes: null }]);
    expect(JSON.stringify(locked)).not.toContain("SECRET");
  });

  it("never sends the old objectives list, so nothing is shown twice", () => {
    const structure: VersionStructure = { formatVersion: 1, rules: {} as never, modules: [moduleStub("open", { objectives: ["Old objective"], prerequisitesText: "Old req" })], finalItems: [] };
    const withRow = studentPathView(structure, output(structure, []), new Map([["open", details({ objectives: ["New objective"] })]]));
    expect(withRow.modules[0]).not.toHaveProperty("objectives");
    expect(withRow.modules[0].details).toEqual(details({ objectives: ["New objective"] }));
    expect(JSON.stringify(withRow)).not.toContain("Old objective");
  });

  it("shows an already-published snapshot's old objectives as details until rows exist", () => {
    const structure: VersionStructure = { formatVersion: 1, rules: {} as never, modules: [moduleStub("open", { objectives: ["Old objective"], prerequisitesText: "Old req" })], finalItems: [] };
    const path = studentPathView(structure, output(structure, []));
    expect(path.modules[0].details).toEqual(details({ objectives: ["Old objective"], prerequisites: ["Old req"] }));
  });
});

describe("publishing", () => {
  const draftModule = { id: "m1", position: 1, title: "M", description: null, estimatedMinutes: null, objectives: ["Stale old objective"], prerequisitesText: "Stale", status: "READY" as const, completionRules: null };
  const draftLesson = { id: "l1", moduleId: "m1", position: 1, title: "L", description: null, estimatedMinutes: null, objectives: ["Lesson objective"], status: "READY" as const, completionRules: null };

  it("no longer copies the old module fields into new snapshots (lesson objectives stay)", () => {
    const { structure } = buildStructure({ syllabusRules: DEFAULT_COMPLETION_RULES, modules: [draftModule], lessons: [draftLesson], items: [], publishedAssessments: new Map(), frozenTaskIds: new Map() });
    expect(structure.modules[0].objectives).toEqual([]);
    expect(structure.modules[0].prerequisitesText).toBe("");
    expect(structure.modules[0].lessons[0].objectives).toEqual(["Lesson objective"]);
  });

  it("freezes the effective details, including a module only covered by the fallback", async () => {
    const values = vi.fn();
    const tx = { insert: vi.fn(() => ({ values })) };
    const effective = withLegacyFallback(new Map(), [draftModule]);
    await freezeModuleDetails(tx as never, "v2", effective, ["m1"]);
    expect(values).toHaveBeenCalledWith([{ versionId: "v2", moduleId: "m1", details: details({ objectives: ["Stale old objective"], prerequisites: ["Stale"] }) }]);
  });
});

// ---------------------------------------------------------------------------
// Builder list editor
// ---------------------------------------------------------------------------

describe("module blocks list editor", () => {
  it("Enter inserts an empty item after the current one and focuses it", () => {
    expect(insertAfter(["a", "b"], 0)).toEqual({ items: ["a", "", "b"], focus: 1 });
    expect(insertAfter(["a"], 0)).toEqual({ items: ["a", ""], focus: 1 });
  });

  it("removing keeps at least one input and focuses the previous item", () => {
    expect(removeAt(["a", "b", "c"], 1)).toEqual({ items: ["a", "c"], focus: 0 });
    expect(removeAt(["only"], 0)).toEqual({ items: [""], focus: 0 });
  });

  it("moves items up and down within bounds and edits in place", () => {
    expect(moveItem(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(setItem(["a", "b"], 1, "B")).toEqual(["a", "B"]);
  });

  it("saves trimmed items without blanks and only replaces the edited block", () => {
    expect(cleanItems([" a ", "", "  ", "b"])).toEqual(["a", "b"]);
    const base = details({ objectives: ["keep"], prerequisites: ["old"] });
    const draft = { ...draftOf(base, "prerequisites"), items: ["new ", ""] };
    expect(applyDraft(base, "prerequisites", draft)).toEqual(details({ objectives: ["keep"], prerequisites: ["new"] }));
    expect(isDirty(base, "prerequisites", draft)).toBe(true);
    expect(isDirty(base, "prerequisites", draftOf(base, "prerequisites"))).toBe(false);
  });

  it("starts an empty block with one empty input; the assessment keeps its text fields", () => {
    expect(draftOf(emptyModuleDetails(), "objectives").items).toEqual([""]);
    const a = AI_ENGINEERING_MODULE_DETAILS[8].details;
    const draft = draftOf(a, "assessment");
    expect(draft.heading).toBe("Final Project");
    expect(applyDraft(a, "assessment", draft)).toEqual(a);
  });

  it("explains problems in plain language terms", () => {
    expect(validateDraft({ ...draftOf(emptyModuleDetails(), "objectives"), items: Array.from({ length: 31 }, (_, i) => `x${i}`) })).toEqual({ code: "tooMany", max: 30 });
    expect(validateDraft({ ...draftOf(emptyModuleDetails(), "objectives"), items: ["ok", "y".repeat(501)] })).toEqual({ code: "tooLong", n: 2, max: 500 });
    expect(validateDraft({ ...draftOf(emptyModuleDetails(), "objectives"), items: ["ok", ""] })).toBeNull();
  });
});

describe("module blocks on the builder card", () => {
  const props = (over: Partial<ModuleBlocksViewProps> = {}): ModuleBlocksViewProps => ({
    moduleTitle: "Python",
    details: emptyModuleDetails(),
    editing: null,
    draft: null,
    saving: false,
    savedBlock: null,
    problem: null,
    onEdit: () => {},
    onDraft: () => {},
    onCancel: () => {},
    onSave: () => {},
    ...over,
  });
  const html = (p: ModuleBlocksViewProps) => renderToStaticMarkup(createElement(ModuleBlocksView, p));

  it("shows all three blocks with friendly empty text and an Add button each", () => {
    const out = html(props());
    for (const text of ["Məqsədlər", "İlkin tələblər", "Modul üzrə qiymətləndirmə", "Hələ məqsəd əlavə edilməyib.", "Hələ ilkin tələb əlavə edilməyib."]) expect(out).toContain(text);
    expect(out.match(/>Əlavə et</g)).toHaveLength(3);
    expect(out).not.toMatch(/seçilməyib/i);
  });

  it("shows filled blocks as students see them, with an Edit button", () => {
    const out = html(props({ details: AI_ENGINEERING_MODULE_DETAILS[0].details }));
    expect(out).toContain("Python proqramlaşdırma dilinin əsaslarını mənimsəmək");
    expect(out.match(/>Redaktə et</g)).toHaveLength(3);
  });

  it("edits a block with one input per item, Save/Cancel and a plain-language error", () => {
    const d = details({ objectives: ["One"] });
    const out = html(props({ details: d, editing: "objectives", draft: { ...draftOf(d, "objectives"), items: ["One", "Two"] }, problem: { code: "tooMany", max: 30 } }));
    expect(out.match(/<input/g)).toHaveLength(2);
    expect(out).toContain('value="Two"');
    expect(out).toContain("Bənd əlavə et");
    expect(out).toContain("Saxlanılmamış dəyişikliklər");
    expect(out).toContain("Yadda saxla");
    expect(out).toContain("Ən çoxu 30 bənd ola bilər");
  });

  it("shows the saved indicator after a save", () => {
    expect(html(props({ details: details({ objectives: ["One"] }), savedBlock: "objectives" }))).toContain("Yadda saxlanıldı");
  });
});
