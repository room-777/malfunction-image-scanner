import { integer, sqliteTable, text } from "void/schema-d1";
import { UPLOAD_STATUSES } from "../lib/upload";

export const uploads = sqliteTable("uploads", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  status: text("status", { enum: UPLOAD_STATUSES }).notNull(),
  mime: text("mime"),
  reason: text("reason"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
