import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildSyllabusPdf } from "./pdf";
import type { PublicSyllabusView } from "./joinRules";

function sampleView(overrides: Partial<PublicSyllabusView> = {}): PublicSyllabusView {
  return {
    title: "Süni İntellekt əsasları",
    description: "Qısa təsvir: ə, ı, İ, ğ, ş, ö, ü, ç",
    subject: "İnformatika",
    level: "Orta",
    language: "az",
    estimatedDurationLabel: "8 həftə",
    estimatedHours: 40,
    courseTiming: null,
    teacher: { name: "Telman Əbdüllazadə", avatarUrl: null },
    moduleCount: 1,
    lessonCount: 1,
    modules: [
      {
        title: "Giriş",
        position: 0,
        duration: "1 həftə",
        details: {
          objectives: ["Əsas anlayışları mənimsəmək"],
          prerequisites: ["Riyaziyyatın əsasları"],
          assessment: { heading: "Test", intro: "", pipeline: "", listIntro: "", items: ["Meyar"] },
        },
        lessons: [{ title: "Dərs 1", projects: [] }],
        projects: [],
        assessments: [],
      },
    ],
    finalProjects: [],
    finalAssessments: [],
    ...overrides,
  };
}

describe("buildSyllabusPdf", () => {
  it("produces a valid, loadable PDF for a typical syllabus (Azerbaijani-specific letters included)", async () => {
    const bytes = await buildSyllabusPdf(sampleView(), "TESTCODE");
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("paginates a long syllabus across multiple pages instead of truncating or overlapping", async () => {
    const modules = Array.from({ length: 12 }, (_, i) => ({
      title: `Modul ${i + 1}: uzun bir başlıq ki sətir bölünməsini yoxlasın`,
      position: i,
      duration: "1 həftə",
      details: null,
      lessons: Array.from({ length: 4 }, (_, j) => ({ title: `Dərs ${j + 1}`, projects: ["Alt tapşırıq"] })),
      projects: ["Layihə 1", "Layihə 2"],
      assessments: ["Test 1"],
    }));
    const bytes = await buildSyllabusPdf(sampleView({ modules, moduleCount: modules.length, lessonCount: modules.length * 4 }), "LONGTEST");
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThan(1);
  });

  it("renders a syllabus with no module details/lessons/final sections without throwing", async () => {
    const bytes = await buildSyllabusPdf(
      sampleView({
        description: "",
        modules: [{ title: "Tək modul", position: 0, duration: null, details: null, lessons: [], projects: [], assessments: [] }],
        moduleCount: 1,
        lessonCount: 0,
      }),
      "EMPTYISH",
    );
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
  });
});
