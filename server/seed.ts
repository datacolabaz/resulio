import "dotenv/config";
import { eq } from "drizzle-orm";
import { groupMembers, providerWorkspaces, users } from "../drizzle/schema";
import type { QuestionInput } from "../shared/assessment";
import { getUserByOpenId, requireDb } from "./db";
import type { TeacherScope } from "./modules/access";
import { createAssessment, createQuestionInAssessment, publish, setTargets, updateSchedule } from "./modules/assessments";
import { createGroup } from "./modules/groups";

/** Local/demo data. Idempotent for users and the demo workspace; creates a fresh group and assessment each run. */
async function ensureUser(openId: string, name: string, email: string) {
  const existing = await getUserByOpenId(openId);
  if (existing) return existing;
  const db = requireDb();
  await db.insert(users).values({ openId, name, email, loginMethod: "demo" });
  const [row] = await db.select().from(users).where(eq(users.openId, openId));
  return row;
}

async function ensureWorkspace(ownerUserId: number) {
  const db = requireDb();
  const id = `ws_demo_${ownerUserId}`;
  const [existing] = await db.select().from(providerWorkspaces).where(eq(providerWorkspaces.id, id)).limit(1);
  if (!existing) {
    await db.insert(providerWorkspaces).values({ id, ownerUserId, title: "Demo Tədris Məkanı", publicDisplayName: "Demo Müəllim" });
  }
  return id;
}

const QUESTIONS: QuestionInput[] = [
  {
    type: "MULTIPLE_CHOICE",
    text: "Azərbaycanın paytaxtı hansıdır?",
    points: 1,
    difficulty: "EASY",
    topic: "Coğrafiya",
    skill: "Bilik",
    tags: [],
    content: { options: [{ key: "A", text: "Gəncə" }, { key: "B", text: "Bakı" }, { key: "C", text: "Şəki" }] },
    answerKey: { correct: "B" },
    explanation: "Bakı 1918-ci ildən paytaxtdır.",
  },
  {
    type: "TRUE_FALSE",
    text: "Su 100°C-də qaynayır (normal təzyiqdə).",
    points: 1,
    difficulty: "EASY",
    topic: "Fizika",
    skill: "Bilik",
    tags: [],
    content: {},
    answerKey: { correct: true },
  },
  {
    type: "NUMERIC",
    text: "12 × 12 = ?",
    points: 2,
    difficulty: "MEDIUM",
    topic: "Riyaziyyat",
    skill: "Hesablama",
    tags: [],
    content: {},
    answerKey: { value: 144, tolerance: 0 },
  },
  {
    type: "ORDERING",
    text: "Planetləri Günəşdən uzaqlığa görə sırala.",
    points: 2,
    difficulty: "MEDIUM",
    topic: "Astronomiya",
    skill: "Təhlil",
    tags: [],
    content: { items: [{ key: "a", text: "Merkuri" }, { key: "b", text: "Venera" }, { key: "c", text: "Yer" }] },
    answerKey: { order: ["a", "b", "c"] },
  },
  {
    type: "LONG_ANSWER",
    text: "Sevdiyiniz kitab haqqında qısa esse yazın.",
    points: 5,
    difficulty: "HARD",
    topic: "Ədəbiyyat",
    skill: "Yazı",
    tags: [],
    content: {},
    answerKey: { rubric: "Struktur, arqument, dil." },
  },
];

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_SEED !== "1") {
    throw new Error("Refusing to seed in production (set ALLOW_SEED=1 to override)");
  }
  const teacher = await ensureUser("demo-teacher", "Demo Müəllim", "teacher@demo.resulio.local");
  const student = await ensureUser("demo-student", "Demo Tələbə", "student@demo.resulio.local");
  const scope: TeacherScope = { workspaceId: await ensureWorkspace(teacher.id), userId: teacher.id };

  const group = await createGroup(scope, { name: "10A Demo", subject: "Ümumi", grade: "10", description: "Demo qrup" });
  await requireDb().insert(groupMembers).values({ groupId: group.id, userId: student.id, status: "ACTIVE" });

  const a = await createAssessment(scope, {
    type: "EXAM",
    settings: { title: "Demo imtahan", subject: "Ümumi", durationSeconds: 20 * 60, attemptsAllowed: 2 },
  });
  for (const q of QUESTIONS) await createQuestionInAssessment(scope, a.id, q);
  const now = Date.now();
  await updateSchedule(scope, a.id, {
    startAt: new Date(now - 60_000),
    endAt: new Date(now + 7 * 24 * 3600_000),
    timezone: "Asia/Baku",
  });
  await setTargets(scope, a.id, { groupIds: [group.id], studentIds: [] });
  const version = await publish(scope, a.id);

  console.log("Seeded:", { teacherUserId: teacher.id, studentUserId: student.id, workspaceId: scope.workspaceId, groupId: group.id, assessmentId: a.id, version });
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
