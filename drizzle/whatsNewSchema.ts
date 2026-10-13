import { int, mysqlTable, primaryKey, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * "Yeniliklər" (shared/whatsNew.ts): per user and feature, when its page was first opened and when
 * its card was closed. A side table: nothing else reads it, and a missing row means "not seen yet".
 */
export const userFeatureSeen = mysqlTable(
  "user_feature_seen",
  {
    userId: int("userId").notNull(),
    featureId: varchar("featureId", { length: 64 }).notNull(),
    seenAt: timestamp("seenAt"),
    dismissedAt: timestamp("dismissedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.featureId] })],
);
