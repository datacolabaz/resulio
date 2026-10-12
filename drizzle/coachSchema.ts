import { bigint, boolean, index, int, json, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core";
import type { CoachEventType, RecallMode } from "../shared/coach";

/**
 * AI Study Coach side tables (docs/STUDY-COACH.md). Student-private: no teacher table is read for
 * writing here and none of these feed teacher analytics. Every constraint and index name is set
 * or checked to stay within MySQL's 64 characters.
 */

const id = (name: string) => varchar(name, { length: 32 });

/** Per-student coach preferences and the privacy notice acceptance. No row = not accepted yet, defaults. */
export const coachSettings = mysqlTable("coach_settings", {
  studentId: int("studentId").primaryKey(),
  /** How often the tutor may bring back a past mistake. */
  recallMode: varchar("recallMode", { length: 8 }).$type<RecallMode>().default("NORMAL").notNull(),
  reminders: boolean("reminders").default(true).notNull(),
  /** When the student accepted the privacy notice; coach AI stays closed until then. */
  consentAt: timestamp("consentAt"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** Light funnel for the coach metrics and the per-day feature caps. Append-only; removed with the student's data. */
export const coachEvents = mysqlTable(
  "coach_events",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    studentId: int("studentId").notNull(),
    type: varchar("type", { length: 24 }).$type<CoachEventType>().notNull(),
    refId: id("refId"),
    meta: json("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("coach_events_student_idx").on(t.studentId, t.type, t.createdAt)],
);
