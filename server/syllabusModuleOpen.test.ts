import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModuleToggleAll } from "../client/src/components/syllabus/ModuleToggles";
import { openModulesKey, readOpenModules, studentDefaultOpen, writeOpenModules } from "../client/src/lib/syllabusModuleOpen";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

const lesson = (id: string, status: string) => ({ id, status });

describe("remembered open modules", () => {
  const key = openModulesKey("student", "syl1");

  it("keys the state per view and syllabus", () => {
    expect(key).toBe("resulio-syllabus-open:student:syl1");
    expect(openModulesKey("builder", "syl1")).not.toBe(key);
  });

  it("returns null when nothing was remembered, so the default applies", () => {
    expect(readOpenModules(memoryStorage(), key, ["m1"])).toBeNull();
    expect(readOpenModules(null, key, ["m1"])).toBeNull();
  });

  it("round-trips, keeps an explicit 'all closed' and drops modules that no longer exist", () => {
    const storage = memoryStorage();
    writeOpenModules(storage, key, new Set(["m1", "gone"]));
    expect(readOpenModules(storage, key, ["m1", "m2"])).toEqual(["m1"]);
    writeOpenModules(storage, key, []);
    expect(readOpenModules(storage, key, ["m1", "m2"])).toEqual([]);
  });

  it("ignores corrupt or foreign values and blocked storage", () => {
    expect(readOpenModules(memoryStorage({ [key]: "{oops" }), key, ["m1"])).toBeNull();
    expect(readOpenModules(memoryStorage({ [key]: '{"m1":true}' }), key, ["m1"])).toBeNull();
    expect(readOpenModules(memoryStorage({ [key]: '["m1", 3, null]' }), key, ["m1"])).toEqual(["m1"]);
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readOpenModules(blocked, key, ["m1"])).toBeNull();
    expect(() => writeOpenModules(blocked, key, ["m1"])).not.toThrow();
  });
});

describe("student default", () => {
  const modules = [
    { id: "m1", lessons: [lesson("l1", "COMPLETED"), lesson("l2", "COMPLETED")] },
    { id: "m2", lessons: [lesson("l3", "IN_PROGRESS"), lesson("l4", "LOCKED")] },
    { id: "m3", lessons: [lesson("l5", "LOCKED")] },
  ];

  it("opens nothing before the student has started", () => {
    const fresh = [
      { id: "m1", lessons: [lesson("l1", "AVAILABLE")] },
      { id: "m2", lessons: [lesson("l2", "LOCKED")] },
    ];
    expect(studentDefaultOpen({ currentModuleId: "m1", currentLessonId: "l1", modules: fresh })).toEqual([]);
  });

  it("opens only the module that holds the current lesson", () => {
    expect(studentDefaultOpen({ currentModuleId: "m1", currentLessonId: "l3", modules })).toEqual(["m2"]);
  });

  it("falls back to the current module, and to none when that is unknown", () => {
    expect(studentDefaultOpen({ currentModuleId: "m3", currentLessonId: null, modules })).toEqual(["m3"]);
    expect(studentDefaultOpen({ currentModuleId: "nope", currentLessonId: "nope", modules })).toEqual([]);
    expect(studentDefaultOpen({ currentModuleId: null, currentLessonId: null, modules })).toEqual([]);
  });

  it("counts lessons awaiting review as started", () => {
    const waiting = [{ id: "m1", lessons: [lesson("l1", "AWAITING_REVIEW"), lesson("l2", "LOCKED")] }];
    expect(studentDefaultOpen({ currentModuleId: "m1", currentLessonId: "l2", modules: waiting })).toEqual(["m1"]);
  });
});

describe("expand/collapse all control", () => {
  const html = (allOpen: boolean, noneOpen: boolean) =>
    renderToStaticMarkup(createElement(ModuleToggleAll, { allOpen, noneOpen, onOpenAll: () => {}, onCloseAll: () => {} }));

  it("offers both actions as labelled buttons in a group", () => {
    const out = html(false, false);
    expect(out).toContain('role="group"');
    expect(out).toContain("Hamısını aç");
    expect(out).toContain("Hamısını bağla");
    expect(out.match(/<button/g)).toHaveLength(2);
    expect(out).not.toContain('disabled=""');
  });

  it("disables the action that would change nothing", () => {
    const disabledLabels = (out: string) => [...out.matchAll(/<button[^>]*disabled=""[^>]*>(?:<svg.*?<\/svg>)?([^<]+)</g)].map((m) => m[1]);
    expect(disabledLabels(html(true, false))).toEqual(["Hamısını aç"]);
    expect(disabledLabels(html(false, true))).toEqual(["Hamısını bağla"]);
  });
});
