import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const datasets = sqliteTable("datasets", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  fingerprint: text("fingerprint").notNull(),
  status: text("status").notNull().default("ready"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("datasets_owner_fingerprint").on(table.userId, table.fingerprint)]);

export const transactions = sqliteTable("transactions", {
  datasetId: integer("dataset_id").notNull().references(() => datasets.id),
  id: text("id").notNull(),
  date: text("date").notNull(),
  description: text("description").notNull(),
  amount: text("amount").notNull(),
  account: text("account").notNull(),
  kind: text("kind").notNull(),
  category: text("category").notNull(),
  refundExpected: text("refund_expected").notNull(),
  refundFor: text("refund_for").notNull(),
  refundDue: text("refund_due").notNull().default(""),
  refundNote: text("refund_note").notNull().default(""),
}, (table) => [uniqueIndex("transactions_dataset_id").on(table.datasetId, table.id)]);

export const bills = sqliteTable("bills", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  amount: text("amount").notNull(),
  cadence: text("cadence").notNull(),
  nextDue: text("next_due").notNull(),
  note: text("note").notNull().default(""),
  paymentMethod: text("payment_method").notNull().default("manual"),
  status: text("status").notNull().default("active"),
  anchorDay: integer("anchor_day").notNull(),
  anchorMonth: integer("anchor_month").notNull(),
  version: integer("version").notNull().default(1),
  lastPaidDue: text("last_paid_due").notNull().default(""),
  lastPaidOn: text("last_paid_on").notNull().default(""),
});
