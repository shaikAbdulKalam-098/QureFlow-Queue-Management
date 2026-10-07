import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  consultationsTable,
  departmentsTable,
  doctorsTable,
  notificationsTable,
  patientsTable,
  queueEntriesTable,
  queuesTable,
  usersTable,
} from "@workspace/db";

export type QfTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type QfExecutor = typeof db | QfTx;

const ACTIVE_STATUSES = [
  "WAITING",
  "CALLED",
  "IN_CONSULTATION",
  "SKIPPED",
] as const;
const PRIORITY_ORDER: Record<string, number> = {
  EMERGENCY: 0,
  PRIORITY: 1,
  NORMAL: 2,
};
const STATUS_ORDER: Record<string, number> = {
  IN_CONSULTATION: 0,
  CALLED: 1,
  WAITING: 2,
  SKIPPED: 3,
};

export type QueueEntryRow = {
  entry: typeof queueEntriesTable.$inferSelect;
  patientName: string;
  userId: number;
  doctorId: number;
  doctorName: string;
  departmentName: string;
};

export function orderQueueRows<T extends { entry: { status: string; priority: string; joinedAt: Date; id: number } }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => {
    const leftStatus = STATUS_ORDER[left.entry.status] ?? 9;
    const rightStatus = STATUS_ORDER[right.entry.status] ?? 9;
    if (leftStatus !== rightStatus) return leftStatus - rightStatus;
    const leftPriority = PRIORITY_ORDER[left.entry.priority] ?? 9;
    const rightPriority = PRIORITY_ORDER[right.entry.priority] ?? 9;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const joinedDelta =
      left.entry.joinedAt.getTime() - right.entry.joinedAt.getTime();
    return joinedDelta || left.entry.id - right.entry.id;
  });
}

export async function loadQueueRows(
  executor: QfExecutor,
  queueId: number,
): Promise<QueueEntryRow[]> {
  const rows = await executor
    .select({
      entry: queueEntriesTable,
      patientName: patientsTable.displayName,
      userId: patientsTable.userId,
      doctorId: queuesTable.doctorId,
      doctorName: doctorsTable.name,
      departmentName: departmentsTable.name,
    })
    .from(queueEntriesTable)
    .innerJoin(patientsTable, eq(queueEntriesTable.patientId, patientsTable.id))
    .innerJoin(queuesTable, eq(queueEntriesTable.queueId, queuesTable.id))
    .innerJoin(doctorsTable, eq(queuesTable.doctorId, doctorsTable.id))
    .innerJoin(departmentsTable, eq(queuesTable.departmentId, departmentsTable.id))
    .where(eq(queueEntriesTable.queueId, queueId));
  return rows;
}

export async function getAverageDurationMinutes(
  executor: QfExecutor,
  doctorId: number,
): Promise<number> {
  const [doctor] = await executor
    .select({ fallback: doctorsTable.defaultDurationMinutes })
    .from(doctorsTable)
    .where(eq(doctorsTable.id, doctorId))
    .limit(1);
  const recent = await executor
    .select({ duration: consultationsTable.durationMinutes })
    .from(consultationsTable)
    .where(
      and(
        eq(consultationsTable.doctorId, doctorId),
        isNotNull(consultationsTable.durationMinutes),
      ),
    )
    .orderBy(desc(consultationsTable.endedAt))
    .limit(20);
  const durations = recent
    .map((item) => item.duration)
    .filter((item): item is number => item != null && item > 0);
  const value =
    durations.length > 0
      ? durations.reduce((sum, item) => sum + item, 0) / durations.length
      : (doctor?.fallback ?? 7.5);
  return Math.round(value * 10) / 10;
}

export function estimateQueue(rows: QueueEntryRow[], averageDuration: number, delayMinutes: number) {
  const ordered = orderQueueRows(
    rows.filter((item) => ACTIVE_STATUSES.includes(item.entry.status as (typeof ACTIVE_STATUSES)[number]) && item.entry.status !== "SKIPPED"),
  );
  const indexById = new Map(ordered.map((row, index) => [row.entry.id, index]));
  const dtoById = new Map<number, ReturnType<typeof queueEntryDto>>();

  for (const [index, row] of ordered.entries()) {
    const preceding = ordered.slice(0, index);
    let wait = 0;
    for (const before of preceding) {
      if (before.entry.status === "IN_CONSULTATION" && before.entry.consultationStartedAt) {
        const elapsed =
          (Date.now() - before.entry.consultationStartedAt.getTime()) / 60_000;
        wait += Math.max(0.5, averageDuration - elapsed);
      } else {
        wait += averageDuration;
      }
    }
    if (row.entry.status === "WAITING") wait += delayMinutes;
    const estimatedWaitMinutes =
      row.entry.status === "WAITING" ? Math.max(0, Math.round(wait)) : 0;
    dtoById.set(
      row.entry.id,
      queueEntryDto(
        row,
        index + 1,
        index,
        estimatedWaitMinutes,
        averageDuration,
      ),
    );
  }

  for (const row of rows) {
    if (!dtoById.has(row.entry.id)) {
      dtoById.set(row.entry.id, queueEntryDto(row, 0, 0, 0, averageDuration));
    }
  }
  return { ordered, indexById, dtoById };
}

export function queueEntryDto(
  row: QueueEntryRow,
  position: number,
  peopleAhead: number,
  estimatedWaitMinutes: number,
  durationFallback: number,
) {
  const durationMinutes =
    row.entry.completedAt && row.entry.consultationStartedAt
      ? Math.max(
          0,
          (row.entry.completedAt.getTime() -
            row.entry.consultationStartedAt.getTime()) /
            60_000,
        )
      : null;
  return {
    id: row.entry.id,
    tokenNumber: row.entry.tokenNumber,
    queueId: row.entry.queueId,
    patientId: row.entry.patientId,
    patientName: row.patientName,
    doctorId: row.doctorId,
    doctorName: row.doctorName,
    departmentName: row.departmentName,
    priority: row.entry.priority,
    status: row.entry.status,
    position,
    peopleAhead,
    estimatedWaitMinutes,
    joinedAt: row.entry.joinedAt.toISOString(),
    calledAt: row.entry.calledAt?.toISOString() ?? null,
    consultationStartedAt:
      row.entry.consultationStartedAt?.toISOString() ?? null,
    completedAt: row.entry.completedAt?.toISOString() ?? null,
    durationMinutes:
      durationMinutes == null
        ? null
        : Math.round(durationMinutes * 10) / 10,
    _durationFallback: durationFallback,
  };
}

export async function refreshQueueEstimates(
  executor: QfExecutor,
  queueId: number,
): Promise<void> {
  const rows = await loadQueueRows(executor, queueId);
  if (rows.length === 0) return;
  const queue = rows[0];
  const average = await getAverageDurationMinutes(executor, queue.doctorId);
  const [queueDetails] = await executor
    .select({ delayMinutes: queuesTable.delayMinutes })
    .from(queuesTable)
    .where(eq(queuesTable.id, queueId))
    .limit(1);
  const estimate = estimateQueue(rows, average, queueDetails?.delayMinutes ?? 0);
  for (const row of estimate.ordered) {
    const value = estimate.dtoById.get(row.entry.id);
    if (!value) continue;
    await executor
      .update(queueEntriesTable)
      .set({ estimatedWaitMinutes: value.estimatedWaitMinutes })
      .where(eq(queueEntriesTable.id, row.entry.id));
  }
}

export async function getQueueSnapshot(queueId: number) {
  const rows = await loadQueueRows(db, queueId);
  const [queueRow] = await db
    .select({
      queue: queuesTable,
      departmentName: departmentsTable.name,
      doctorName: doctorsTable.name,
    })
    .from(queuesTable)
    .innerJoin(departmentsTable, eq(queuesTable.departmentId, departmentsTable.id))
    .innerJoin(doctorsTable, eq(queuesTable.doctorId, doctorsTable.id))
    .where(eq(queuesTable.id, queueId))
    .limit(1);
  if (!queueRow) return null;

  const average = await getAverageDurationMinutes(db, queueRow.queue.doctorId);
  const estimated = estimateQueue(rows, average, queueRow.queue.delayMinutes);
  const active = estimated.ordered;
  const current =
    active.find((item) => item.entry.status === "IN_CONSULTATION") ??
    active.find((item) => item.entry.status === "CALLED") ??
    null;
  const entryDtos = rows.map(
    (row) =>
      estimated.dtoById.get(row.entry.id) ??
      queueEntryDto(row, 0, 0, 0, average),
  );
  return {
    queue: {
      id: queueRow.queue.id,
      clinicName: queueRow.queue.clinicName,
      departmentId: queueRow.queue.departmentId,
      departmentName: queueRow.departmentName,
      doctorId: queueRow.queue.doctorId,
      doctorName: queueRow.doctorName,
      name: queueRow.queue.name,
      isOpen: queueRow.queue.isOpen,
      waitingCount: active.filter(
        (item) => item.entry.status === "WAITING" || item.entry.status === "CALLED",
      ).length,
      currentToken: current?.entry.tokenNumber ?? null,
      averageDurationMinutes: average,
      delayMinutes: queueRow.queue.delayMinutes,
    },
    entries: entryDtos,
    orderedEntries: estimated.ordered.map((row) => estimated.dtoById.get(row.entry.id)!),
    rows,
  };
}

export async function queueNotification(
  executor: QfExecutor,
  userId: number,
  title: string,
  message: string,
  queueEntryId: number | null = null,
): Promise<void> {
  await executor.insert(notificationsTable).values({
    userId,
    queueEntryId,
    title,
    message,
  });
}

export async function notifyQueueMovement(
  executor: QfExecutor,
  queueId: number,
): Promise<void> {
  const rows = await loadQueueRows(executor, queueId);
  const [queue] = await executor
    .select({ delayMinutes: queuesTable.delayMinutes })
    .from(queuesTable)
    .where(eq(queuesTable.id, queueId))
    .limit(1);
  if (!rows.length) return;
  const average = await getAverageDurationMinutes(executor, rows[0].doctorId);
  const { ordered, dtoById } = estimateQueue(rows, average, queue?.delayMinutes ?? 0);
  const nowServing =
    ordered.find((item) => item.entry.status === "IN_CONSULTATION") ??
    ordered.find((item) => item.entry.status === "CALLED");
  for (const row of ordered) {
    const dto = dtoById.get(row.entry.id);
    if (!dto || row.entry.status !== "WAITING") continue;
    if (dto.peopleAhead <= 2) {
      await queueNotification(
        executor,
        row.userId,
        "Your turn is approaching",
        `Token #${row.entry.tokenNumber} is approximately ${dto.peopleAhead} patient${dto.peopleAhead === 1 ? "" : "s"} away. Please be ready.`,
        row.entry.id,
      );
    } else if (nowServing && row.entry.estimatedWaitMinutes > dto.estimatedWaitMinutes + 5) {
      await queueNotification(
        executor,
        row.userId,
        "Queue timing updated",
        `Your estimated wait for token #${row.entry.tokenNumber} is now about ${dto.estimatedWaitMinutes} minutes.`,
        row.entry.id,
      );
    }
  }
}

export async function getCurrentUserDto(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    email: user.email,
    doctorId: user.doctorId,
  };
}

export async function getDirectoryData() {
  const [departments, doctors, queues] = await Promise.all([
    db.select().from(departmentsTable).orderBy(departmentsTable.name),
    db
      .select({
        id: doctorsTable.id,
        name: doctorsTable.name,
        departmentId: doctorsTable.departmentId,
        departmentName: departmentsTable.name,
      })
      .from(doctorsTable)
      .innerJoin(departmentsTable, eq(doctorsTable.departmentId, departmentsTable.id))
      .orderBy(doctorsTable.name),
    db.select({ id: queuesTable.id, clinicName: queuesTable.clinicName }).from(queuesTable),
  ]);
  const queueResults = [];
  for (const item of queues) {
    const snapshot = await getQueueSnapshot(item.id);
    if (snapshot) queueResults.push(snapshot.queue);
  }
  const doctorResults = await Promise.all(
    doctors.map(async (doctor) => ({
      ...doctor,
      averageDurationMinutes: await getAverageDurationMinutes(db, doctor.id),
    })),
  );
  return {
    clinics: [...new Set(queues.map((item) => item.clinicName))],
    departments,
    doctors: doctorResults,
    queues: queueResults,
  };
}

export async function getStats() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const [today] = await db
    .select({
      patientsToday: sql<number>`count(*)::int`,
      waitingNow: sql<number>`count(*) filter (where ${queueEntriesTable.status} = 'WAITING')::int`,
      completedToday: sql<number>`count(*) filter (where ${queueEntriesTable.status} = 'COMPLETED')::int`,
      cancelledToday: sql<number>`count(*) filter (where ${queueEntriesTable.status} = 'CANCELLED')::int`,
      emergencyCases: sql<number>`count(*) filter (where ${queueEntriesTable.priority} = 'EMERGENCY')::int`,
      averageWait: sql<number>`coalesce(avg(extract(epoch from (${queueEntriesTable.calledAt} - ${queueEntriesTable.joinedAt})) / 60) filter (where ${queueEntriesTable.status} = 'COMPLETED'), 0)::int`,
    })
    .from(queueEntriesTable)
    .where(sql`${queueEntriesTable.joinedAt} >= ${startOfToday}`);
  const [consultations] = await db
    .select({
      average: sql<number>`coalesce(avg(${consultationsTable.durationMinutes}), 0)::float`,
    })
    .from(consultationsTable)
    .where(
      and(
        isNotNull(consultationsTable.durationMinutes),
        sql`${consultationsTable.endedAt} >= ${startOfToday}`,
      ),
    );
  return {
    patientsToday: today?.patientsToday ?? 0,
    waitingNow: today?.waitingNow ?? 0,
    completedToday: today?.completedToday ?? 0,
    cancelledToday: today?.cancelledToday ?? 0,
    emergencyCases: today?.emergencyCases ?? 0,
    averageWaitMinutes: today?.averageWait ?? 0,
    averageConsultationMinutes:
      Math.round((consultations?.average ?? 0) * 10) / 10,
  };
}

export async function getActiveEntriesForUser(user: typeof usersTable.$inferSelect) {
  const patient = await db
    .select()
    .from(patientsTable)
    .where(eq(patientsTable.userId, user.id))
    .limit(1);
  if (!patient[0]) return [];
  const entries = await db
    .select({ queueId: queueEntriesTable.queueId })
    .from(queueEntriesTable)
    .where(
      and(
        eq(queueEntriesTable.patientId, patient[0].id),
        inArray(queueEntriesTable.status, [...ACTIVE_STATUSES]),
      ),
    );
  const results = [];
  for (const queueId of [...new Set(entries.map((item) => item.queueId))]) {
    const snapshot = await getQueueSnapshot(queueId);
    if (snapshot) {
      results.push(
        ...snapshot.entries.filter(
          (entry) => entry.patientId === patient[0].id && ACTIVE_STATUSES.includes(entry.status as (typeof ACTIVE_STATUSES)[number]),
        ),
      );
    }
  }
  return results;
}

export function isActiveStatus(status: string): status is (typeof ACTIVE_STATUSES)[number] {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}
