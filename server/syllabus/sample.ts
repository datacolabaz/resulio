import type { TeacherScope } from "../modules/access";
import * as authoring from "./authoring";

/**
 * "Create a sample syllabus" for the empty state: a small Java course (2 modules × 2–3 lessons)
 * built through the normal authoring functions, so it is an ordinary editable draft.
 */

export type SampleLocale = "az" | "en" | "ru";
type L = Record<SampleLocale, string>;

interface SampleItem {
  kind: "THEORY" | "TEACHER_PRACTICE" | "STUDENT_PRACTICE" | "RESOURCE";
  title: L;
  content: (locale: SampleLocale) => Record<string, unknown>;
}
interface SampleLesson {
  title: L;
  minutes: number;
  objectives: L[];
  items: SampleItem[];
}
interface SampleModule {
  title: L;
  description: L;
  lessons: SampleLesson[];
}

const theory = (title: L, md: L, code?: { language: string; code: string }, link?: { url: string; title: L }): SampleItem => ({
  kind: "THEORY",
  title,
  content: (loc) => ({
    blocks: [
      { type: "markdown", md: md[loc] },
      ...(code ? [{ type: "code", ...code }] : []),
      ...(link ? [{ type: "link", url: link.url, title: link.title[loc] }] : []),
    ],
  }),
});

const DOCS = { url: "https://dev.java/learn/", title: { az: "Rəsmi Java dərslikləri (dev.java)", en: "Official Java tutorials (dev.java)", ru: "Официальные уроки Java (dev.java)" } };

const MODULES: SampleModule[] = [
  {
    title: { az: "Java əsasları", en: "Java basics", ru: "Основы Java" },
    description: {
      az: "Proqramın quruluşu, dəyişənlər və tiplər.",
      en: "Program structure, variables and types.",
      ru: "Структура программы, переменные и типы.",
    },
    lessons: [
      {
        title: { az: "Java ilə tanışlıq", en: "Introduction to Java", ru: "Знакомство с Java" },
        minutes: 30,
        objectives: [{ az: "İlk proqramı yazıb işə salmaq", en: "Write and run a first program", ru: "Написать и запустить первую программу" }],
        items: [
          theory(
            { az: "Java nədir?", en: "What is Java?", ru: "Что такое Java?" },
            {
              az: "## Java nədir?\n\nJava — **obyekt yönümlü** proqramlaşdırma dilidir. Kod `javac` ilə kompilyasiya olunur və JVM-də işləyir.\n\n- Bir dəfə yaz, hər yerdə işlət\n- Güclü tip sistemi",
              en: "## What is Java?\n\nJava is an **object-oriented** programming language. Code is compiled with `javac` and runs on the JVM.\n\n- Write once, run anywhere\n- Strong static typing",
              ru: "## Что такое Java?\n\nJava — **объектно-ориентированный** язык программирования. Код компилируется `javac` и выполняется в JVM.\n\n- Написал один раз — запускай везде\n- Строгая статическая типизация",
            },
            { language: "java", code: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, Java!");\n    }\n}' },
            DOCS,
          ),
          {
            kind: "TEACHER_PRACTICE",
            title: { az: "Sinifdə: ilk proqram", en: "In class: first program", ru: "На занятии: первая программа" },
            content: (loc) => ({
              problem: { az: "Ekrana adınızı çıxaran proqram yazın.", en: "Write a program that prints your name.", ru: "Напишите программу, которая выводит ваше имя." }[loc],
              difficulty: "EASY",
              expectedOutcome: { az: "Konsolda ad görünür.", en: "The name appears in the console.", ru: "Имя появляется в консоли." }[loc],
              hints: [{ az: "System.out.println istifadə edin.", en: "Use System.out.println.", ru: "Используйте System.out.println." }[loc]],
              exampleOutput: "Aysel",
              teacherOnly: { solution: 'System.out.println("Aysel");', notes: "" },
            }),
          },
        ],
      },
      {
        title: { az: "Dəyişənlər və tiplər", en: "Variables and types", ru: "Переменные и типы" },
        minutes: 45,
        objectives: [{ az: "int, double, String tiplərindən istifadə etmək", en: "Use int, double and String", ru: "Использовать int, double и String" }],
        items: [
          theory(
            { az: "Dəyişənlər", en: "Variables", ru: "Переменные" },
            {
              az: "## Dəyişənlər\n\nDəyişən — adı və tipi olan yaddaş sahəsidir.\n\n1. `int` — tam ədəd\n2. `double` — kəsr ədəd\n3. `String` — mətn",
              en: "## Variables\n\nA variable is a named, typed piece of memory.\n\n1. `int` — whole number\n2. `double` — decimal number\n3. `String` — text",
              ru: "## Переменные\n\nПеременная — именованная типизированная область памяти.\n\n1. `int` — целое число\n2. `double` — дробное число\n3. `String` — текст",
            },
            { language: "java", code: 'int age = 17;\ndouble score = 92.5;\nString name = "Murad";' },
          ),
          {
            kind: "STUDENT_PRACTICE",
            title: { az: "Tapşırıq: özün haqqında", en: "Task: about you", ru: "Задание: о себе" },
            content: (loc) => ({
              instructions: {
                az: "Adınızı, yaşınızı və orta balınızı dəyişənlərdə saxlayıb ekrana çıxaran proqram yazın.",
                en: "Store your name, age and average score in variables and print them.",
                ru: "Сохраните имя, возраст и средний балл в переменных и выведите их.",
              }[loc],
              difficulty: "EASY",
              expectedResult: { az: "Üç sətir çıxış.", en: "Three lines of output.", ru: "Три строки вывода." }[loc],
              submissionType: "TEXT_OR_FILE",
              evaluation: "AI_AUTO",
            }),
          },
        ],
      },
    ],
  },
  {
    title: { az: "İdarəetmə strukturları", en: "Control flow", ru: "Управляющие конструкции" },
    description: { az: "Şərtlər və dövrlər.", en: "Conditions and loops.", ru: "Условия и циклы." },
    lessons: [
      {
        title: { az: "Şərt operatorları", en: "Conditions", ru: "Условия" },
        minutes: 40,
        objectives: [{ az: "if / else ilə qərar vermək", en: "Make decisions with if / else", ru: "Принимать решения с if / else" }],
        items: [
          theory(
            { az: "if / else", en: "if / else", ru: "if / else" },
            {
              az: "## if / else\n\nŞərt doğrudursa birinci blok, əks halda ikinci blok işləyir.",
              en: "## if / else\n\nIf the condition is true the first block runs, otherwise the second.",
              ru: "## if / else\n\nЕсли условие истинно, выполняется первый блок, иначе второй.",
            },
            { language: "java", code: 'if (score >= 50) {\n    System.out.println("Passed");\n} else {\n    System.out.println("Try again");\n}' },
          ),
        ],
      },
      {
        title: { az: "Dövrlər", en: "Loops", ru: "Циклы" },
        minutes: 45,
        objectives: [{ az: "for və while dövrlərini yazmaq", en: "Write for and while loops", ru: "Писать циклы for и while" }],
        items: [
          theory(
            { az: "for və while", en: "for and while", ru: "for и while" },
            {
              az: "## Dövrlər\n\n`for` — sayı məlum olan təkrarlar üçün, `while` — şərt doğru olduqca.",
              en: "## Loops\n\n`for` repeats a known number of times, `while` repeats while a condition holds.",
              ru: "## Циклы\n\n`for` — известное число повторений, `while` — пока условие истинно.",
            },
            { language: "java", code: "for (int i = 1; i <= 5; i++) {\n    System.out.println(i);\n}" },
          ),
          {
            kind: "STUDENT_PRACTICE",
            title: { az: "Tapşırıq: vurma cədvəli", en: "Task: multiplication table", ru: "Задание: таблица умножения" },
            content: (loc) => ({
              instructions: {
                az: "Daxil edilən ədəd üçün 1-dən 10-a qədər vurma cədvəlini çıxaran proqram yazın.",
                en: "Print the multiplication table from 1 to 10 for a given number.",
                ru: "Выведите таблицу умножения от 1 до 10 для заданного числа.",
              }[loc],
              difficulty: "MEDIUM",
              submissionType: "TEXT_OR_FILE",
              evaluation: "AI_AUTO",
            }),
          },
          {
            kind: "RESOURCE",
            title: { az: "Əlavə oxu", en: "Further reading", ru: "Дополнительно" },
            content: (loc) => ({ url: DOCS.url, title: DOCS.title[loc], note: "" }),
          },
        ],
      },
    ],
  },
];

const TITLE: L = { az: "Java proqramlaşdırma (nümunə)", en: "Java programming (sample)", ru: "Программирование на Java (пример)" };
const DESCRIPTION: L = {
  az: "Nümunə syllabus: istədiyiniz kimi dəyişin, dərc etməzdən əvvəl tələbələr heç nə görmür.",
  en: "A sample syllabus: change anything you like — students see nothing until you publish.",
  ru: "Пример силлабуса: меняйте что угодно — студенты ничего не увидят до публикации.",
};
const LANGUAGE: L = { az: "az", en: "en", ru: "ru" };

/** Pure: everything the sample creates, in one language (tests run it without a database). */
export function samplePlan(locale: SampleLocale) {
  return {
    syllabus: {
      title: TITLE[locale],
      description: DESCRIPTION[locale],
      subject: "Java",
      level: "Beginner",
      language: LANGUAGE[locale],
      estimatedDurationLabel: "",
      estimatedHours: 8,
    },
    modules: MODULES.map((m) => ({
      title: m.title[locale],
      description: m.description[locale],
      lessons: m.lessons.map((l) => ({
        title: l.title[locale],
        estimatedMinutes: l.minutes,
        objectives: l.objectives.map((o) => o[locale]),
        items: l.items.map((it) => ({ kind: it.kind, title: it.title[locale], content: it.content(locale) })),
      })),
    })),
  };
}

/** All or nothing: if any step fails, the half-built draft is removed before the error surfaces. */
export async function createSampleSyllabus(scope: TeacherScope, locale: SampleLocale) {
  const plan = samplePlan(locale);
  const syllabus = await authoring.createSyllabus(scope, plan.syllabus);
  try {
    for (const m of plan.modules) {
      const mod = await authoring.createModule(scope, syllabus.id, { title: m.title, description: m.description });
      for (const l of m.lessons) {
        const lesson = await authoring.createLesson(scope, mod.id, { title: l.title, estimatedMinutes: l.estimatedMinutes, objectives: l.objectives });
        for (const it of l.items) await authoring.createItem(scope, syllabus.id, { scope: "LESSON", lessonId: lesson.id }, it);
      }
    }
  } catch (error) {
    await authoring.discardDraft(scope, syllabus.id).catch((cleanup) => console.error("[syllabus] sample cleanup failed", { syllabusId: syllabus.id }, cleanup));
    throw error;
  }
  return syllabus;
}

/** Exposed for tests: every sample item must pass the same content validation as teacher input. */
export const SAMPLE_MODULES = MODULES;
