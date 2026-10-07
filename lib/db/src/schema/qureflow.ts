import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const userRoleEnum = pgEnum("qureflow_user_role", [
  "PATIENT",
  "STAFF",
  "DOCTOR",
  "ADMIN",
]);
export const queuePriorityEnum = pgEnum("qureflow_queue_priority", [
  "NORMAL",
  "PRIORITY",
  "EMERGENCY",
]);
export const queueStatusEnum = pgEnum("qureflow_queue_status", [
  "WAITING",
  "CALLED",
  "IN_CONSULTATION",
  "COMPLETED",
  "SKIPPED",
  "CANCELLED",
]);
export type UserRole = (typeof userRoleEnum.enumValues)[number];

export const usersTable = pgTable(
  "qureflow_users",
  {
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").unique(),
    role: userRoleEnum("role").notNull().default("PATIENT"),
    name: text("name").notNull().unique(),
    email: text("email").notNull().default(""),
    doctorId: integer("doctor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("qureflow_users_role_idx").on(table.role)],
);

export const patientsTable = pgTable("qureflow_patients", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique().references(() => usersTable.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const departmentsTable = pgTable("qureflow_departments", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
});

export const doctorsTable = pgTable(
  "qureflow_doctors",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    departmentId: integer("department_id").notNull().references(() => departmentsTable.id),
    defaultDurationMinutes: doublePrecision("default_duration_minutes").notNull().default(7.5),
  },
  (table) => [index("qureflow_doctors_department_idx").on(table.departmentId)],
);

export const queuesTable = pgTable(
  "qureflow_queues",
  {
    id: serial("id").primaryKey(),
    clinicName: text("clinic_name").notNull(),
    departmentId: integer("department_id").notNull().references(() => departmentsTable.id),
    doctorId: integer("doctor_id").notNull().references(() => doctorsTable.id),
    name: text("name").notNull(),
    isOpen: boolean("is_open").notNull().default(true),
    delayMinutes: integer("delay_minutes").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("qureflow_queues_doctor_idx").on(table.doctorId),
    unique("qureflow_queues_clinic_doctor_name_unique").on(table.clinicName, table.doctorId, table.name),
  ],
);

export const queueEntriesTable = pgTable(
  "qureflow_queue_entries",
  {
    id: serial("id").primaryKey(),
    queueId: integer("queue_id").notNull().references(() => queuesTable.id),
    patientId: integer("patient_id").notNull().references(() => patientsTable.id),
    tokenNumber: integer("token_number").notNull(),
    priority: queuePriorityEnum("priority").notNull().default("NORMAL"),
    status: queueStatusEnum("status").notNull().default("WAITING"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    calledAt: timestamp("called_at", { withTimezone: true }),
    consultationStartedAt: timestamp("consultation_started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    estimatedWaitMinutes: integer("estimated_wait_minutes").notNull().default(0),
  },
  (table) => [
    unique("qureflow_queue_token_unique").on(table.queueId, table.tokenNumber),
    index("qureflow_queue_entries_queue_status_idx").on(table.queueId, table.status),
    index("qureflow_queue_entries_patient_idx").on(table.patientId, table.joinedAt),
    uniqueIndex("qureflow_patient_one_active_token_idx")
      .on(table.patientId, table.queueId)
      .where(sql`${table.status} IN ('WAITING', 'CALLED', 'IN_CONSULTATION', 'SKIPPED')`),
  ],
);

export const consultationsTable = pgTable(
  "qureflow_consultations",
  {
    id: serial("id").primaryKey(),
    queueEntryId: integer("queue_entry_id").notNull().unique().references(() => queueEntriesTable.id),
    doctorId: integer("doctor_id").notNull().references(() => doctorsTable.id),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMinutes: doublePrecision("duration_minutes"),
  },
  (table) => [index("qureflow_consultations_doctor_ended_idx").on(table.doctorId, table.endedAt)],
);

export const notificationsTable = pgTable(
  "qureflow_notifications",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    queueEntryId: integer("queue_entry_id").references(() => queueEntriesTable.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (table) => [index("qureflow_notifications_user_created_idx").on(table.userId, table.createdAt)],
);
