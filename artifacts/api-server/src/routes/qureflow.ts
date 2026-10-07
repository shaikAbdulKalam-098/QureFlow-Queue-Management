import { Router, type IRouter } from "express";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  sql,
} from "drizzle-orm";
import {
  CreateQueueEntryResponse,
  CreateQueueEntryBody,
  GetAdminOverviewResponse,
  GetAnalyticsResponse,
  GetDashboardResponse,
  GetDirectoryResponse,
  GetPatientHistoryResponse,
  ListNotificationsResponse,
  ListQueueEntriesQueryParams,
  ListQueueEntriesResponse,
  MarkNotificationReadParams,
  MarkNotificationReadResponse,
  PerformQueueActionBody,
  PerformQueueActionParams,
  PerformQueueActionResponse,
  SimulateQueueBody,
  SimulateQueueParams,
  SimulateQueueResponse,
  TrackQueueEntryParams,
  TrackQueueEntryResponse,
} from "@workspace/api-zod";
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
import {
  requireQureFlowAuth,
  requireQureFlowRoles,
} from "../middlewares/qureflowAuth";
import {
  estimateQueue,
  getActiveEntriesForUser,
  getAverageDurationMinutes,
  getDirectoryData,
  getQueueSnapshot,
  getStats,
  isActiveStatus,
  loadQueueRows,
  notifyQueueMovement,
  orderQueueRows,
  queueEntryDto,
  queueNotification,
  refreshQueueEstimates,
  type QfTx,
} from "../lib/qureflow-service";

const router: IRouter = Router();
const staffRoles = ["STAFF", "DOCTOR", "ADMIN"] as const;
const adminRoles = ["ADMIN"] as const;
const clinicQueueRoles = ["STAFF", "DOCTOR", "ADMIN"] as const;
const ACTIVE_STATES = ["WAITING", "CALLED", "IN_CONSULTATION", "SKIPPED"] as const;

function parseInteger(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function getPatientProfileId(userId: number) {
  const [profile] = await db
    .select()
    .from(patientsTable)
    .where(eq(patientsTable.userId, userId))
    .limit(1);
  if (profile) return profile.id;
  const [user] = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const [created] = await db
    .insert(patientsTable)
    .values({ userId, displayName: user?.name ?? "QureFlow patient" })
    .returning();
  return created.id;
}

async function lockQueue(tx: QfTx, queueId: number): Promise<boolean> {
  const result = await tx.execute(
    sql`SELECT id FROM qureflow_queues WHERE id = ${queueId} FOR UPDATE`,
  );
  return (result.rowCount ?? 0) > 0;
}

async function entryDtoFromDatabase(entryId: number) {
  const [entry] = await db
    .select({ queueId: queueEntriesTable.queueId })
    .from(queueEntriesTable)
    .where(eq(queueEntriesTable.id, entryId))
    .limit(1);
  if (!entry) return null;
  const rows = await loadQueueRows(db, entry.queueId);
  const [queue] = await db
    .select({ delayMinutes: queuesTable.delayMinutes, doctorId: queuesTable.doctorId })
    .from(queuesTable)
    .where(eq(queuesTable.id, entry.queueId))
    .limit(1);
  const average = await getAverageDurationMinutes(db, queue?.doctorId ?? 0);
  const estimates = estimateQueue(rows, average, queue?.delayMinutes ?? 0);
  return estimates.dtoById.get(entryId) ?? null;
}

async function callNextWaiting(tx: QfTx, queueId: number) {
  const rows = await loadQueueRows(tx, queueId);
  const next = orderQueueRows(
    rows.filter((row) => row.entry.status === "WAITING"),
  )[0];
  if (!next) return null;
  const calledAt = new Date();
  await tx
    .update(queueEntriesTable)
    .set({ status: "CALLED", calledAt })
    .where(eq(queueEntriesTable.id, next.entry.id));
  await queueNotification(
    tx,
    next.userId,
    "You have been called",
    `Token #${next.entry.tokenNumber} is now being called. Please proceed to ${next.departmentName}.`,
    next.entry.id,
  );
  return next.entry.id;
}

async function beginConsultation(tx: QfTx, entryId: number, doctorId: number) {
  const now = new Date();
  await tx
    .update(queueEntriesTable)
    .set({ status: "IN_CONSULTATION", consultationStartedAt: now })
    .where(eq(queueEntriesTable.id, entryId));
  await tx
    .insert(consultationsTable)
    .values({ queueEntryId: entryId, doctorId, startedAt: now })
    .onConflictDoUpdate({
      target: consultationsTable.queueEntryId,
      set: { doctorId, startedAt: now, endedAt: null, durationMinutes: null },
    });
}

async function completeConsultation(
  tx: QfTx,
  entryId: number,
  tokenNumber: number,
) {
  const [entry] = await tx
    .select({
      startedAt: queueEntriesTable.consultationStartedAt,
      queueId: queueEntriesTable.queueId,
      patientId: queueEntriesTable.patientId,
    })
    .from(queueEntriesTable)
    .where(eq(queueEntriesTable.id, entryId))
    .limit(1);
  if (!entry?.startedAt) throw new Error("Consultation start time is missing.");
  const endedAt = new Date();
  const durationMinutes = Math.max(
    0.1,
    (endedAt.getTime() - entry.startedAt.getTime()) / 60_000,
  );
  await tx
    .update(queueEntriesTable)
    .set({ status: "COMPLETED", completedAt: endedAt })
    .where(eq(queueEntriesTable.id, entryId));
  await tx
    .update(consultationsTable)
    .set({ endedAt, durationMinutes })
    .where(eq(consultationsTable.queueEntryId, entryId));
  const [patient] = await tx
    .select({ userId: patientsTable.userId })
    .from(patientsTable)
    .where(eq(patientsTable.id, entry.patientId))
    .limit(1);
  if (patient) {
    await queueNotification(
      tx,
      patient.userId,
      "Consultation completed",
      `Your consultation for token #${tokenNumber} is complete. Thank you for visiting.`,
      entryId,
    );
  }
}

router.get("/directory", async (_req, res): Promise<void> => {
  res.json(GetDirectoryResponse.parse(await getDirectoryData()));
});

router.get(
  "/dashboard",
  requireQureFlowAuth,
  async (req, res): Promise<void> => {
    const user = req.qfUser!;
    const stats = await getStats();
    const entriesForUser = user.role === "PATIENT" ? await getActiveEntriesForUser(user) : [];
    const directory = await getDirectoryData();
    const ownQueue =
      user.role === "DOCTOR" && user.doctorId
        ? directory.queues.find((item) => item.doctorId === user.doctorId)
        : directory.queues[0];
    let queue = ownQueue ?? null;
    let entries: NonNullable<Awaited<ReturnType<typeof getQueueSnapshot>>>["entries"] = [];
    if (queue) {
      const snapshot = await getQueueSnapshot(queue.id);
      if (snapshot) {
        queue = snapshot.queue;
        entries = snapshot.orderedEntries.filter((item) =>
          ACTIVE_STATES.includes(item.status as (typeof ACTIVE_STATES)[number]),
        );
      }
    }
    const [activeEntry] =
      user.role === "PATIENT"
        ? entriesForUser
        : entries.filter((item) => item.status === "IN_CONSULTATION");
    const notifications = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.userId, user.id))
      .orderBy(desc(notificationsTable.createdAt))
      .limit(5);
    const payload = {
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        email: user.email,
        doctorId: user.doctorId,
      },
      activeEntry: activeEntry ?? null,
      queue,
      entries,
      stats,
      recentNotifications: notifications.map((item) => ({
        id: item.id,
        title: item.title,
        message: item.message,
        createdAt: item.createdAt.toISOString(),
        isRead: item.readAt != null,
        queueEntryId: item.queueEntryId,
      })),
    };
    res.json(GetDashboardResponse.parse(payload));
  },
);

router.get(
  "/history",
  requireQureFlowRoles("PATIENT"),
  async (req, res): Promise<void> => {
    const patientId = await getPatientProfileId(req.qfUser!.id);
    const rows = await db
      .select({
        entry: queueEntriesTable,
        doctorName: doctorsTable.name,
        departmentName: departmentsTable.name,
        duration: consultationsTable.durationMinutes,
      })
      .from(queueEntriesTable)
      .innerJoin(queuesTable, eq(queueEntriesTable.queueId, queuesTable.id))
      .innerJoin(doctorsTable, eq(queuesTable.doctorId, doctorsTable.id))
      .innerJoin(departmentsTable, eq(queuesTable.departmentId, departmentsTable.id))
      .leftJoin(consultationsTable, eq(consultationsTable.queueEntryId, queueEntriesTable.id))
      .where(eq(queueEntriesTable.patientId, patientId))
      .orderBy(desc(queueEntriesTable.joinedAt))
      .limit(50);
    res.json(
      GetPatientHistoryResponse.parse(
        rows.map((row) => ({
          id: row.entry.id,
          tokenNumber: row.entry.tokenNumber,
          doctorName: row.doctorName,
          departmentName: row.departmentName,
          status: row.entry.status,
          joinedAt: row.entry.joinedAt.toISOString(),
          estimatedWaitMinutes: row.entry.estimatedWaitMinutes,
          durationMinutes: row.duration,
        })),
      ),
    );
  },
);

router.get(
  "/queue-entries",
  requireQureFlowRoles(...clinicQueueRoles),
  async (req, res): Promise<void> => {
    const query = ListQueueEntriesQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "The selected queue is invalid." });
      return;
    }
    const user = req.qfUser!;
    let queueIds: number[];
    if (query.data.queueId) {
      const [queue] = await db
        .select({ id: queuesTable.id, doctorId: queuesTable.doctorId })
        .from(queuesTable)
        .where(eq(queuesTable.id, query.data.queueId))
        .limit(1);
      if (!queue) {
        res.status(404).json({ error: "Queue not found." });
        return;
      }
      if (user.role === "DOCTOR" && queue.doctorId !== user.doctorId) {
        res.status(403).json({ error: "This queue belongs to another doctor." });
        return;
      }
      queueIds = [queue.id];
    } else {
      const queues = await db
        .select({ id: queuesTable.id, doctorId: queuesTable.doctorId })
        .from(queuesTable)
        .orderBy(asc(queuesTable.id));
      queueIds =
        user.role === "DOCTOR"
          ? queues.filter((item) => item.doctorId === user.doctorId).map((item) => item.id)
          : queues.map((item) => item.id);
    }
    const results = [];
    for (const queueId of queueIds) {
      const snapshot = await getQueueSnapshot(queueId);
      if (snapshot) {
        results.push(
          ...snapshot.orderedEntries.filter((item) =>
            ACTIVE_STATES.includes(item.status as (typeof ACTIVE_STATES)[number]),
          ),
        );
      }
    }
    res.json(ListQueueEntriesResponse.parse(results));
  },
);

router.post(
  "/queue-entries",
  requireQureFlowRoles("PATIENT"),
  async (req, res): Promise<void> => {
    const parsed = CreateQueueEntryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Choose an available clinic queue." });
      return;
    }
    const patientId = await getPatientProfileId(req.qfUser!.id);
    try {
      const entryId = await db.transaction(async (tx) => {
        const locked = await lockQueue(tx, parsed.data.queueId);
        if (!locked) throw new Error("QUEUE_NOT_FOUND");
        const [queue] = await tx
          .select()
          .from(queuesTable)
          .where(eq(queuesTable.id, parsed.data.queueId))
          .limit(1);
        if (!queue?.isOpen) throw new Error("QUEUE_CLOSED");
        const [existing] = await tx
          .select()
          .from(queueEntriesTable)
          .where(
            and(
              eq(queueEntriesTable.queueId, queue.id),
              eq(queueEntriesTable.patientId, patientId),
              inArray(queueEntriesTable.status, [...ACTIVE_STATES]),
            ),
          )
          .limit(1);
        if (existing) throw new Error("DUPLICATE_TOKEN");
        const [numberRow] = await tx
          .select({
            value: sql<number>`coalesce(max(${queueEntriesTable.tokenNumber}), 0)::int`,
          })
          .from(queueEntriesTable)
          .where(eq(queueEntriesTable.queueId, queue.id));
        const tokenNumber = (numberRow?.value ?? 0) + 1;
        const [created] = await tx
          .insert(queueEntriesTable)
          .values({ queueId: queue.id, patientId, tokenNumber, priority: "NORMAL" })
          .returning();
        await refreshQueueEstimates(tx, queue.id);
        await queueNotification(
          tx,
          req.qfUser!.id,
          "Digital token ready",
          `You're in the ${queue.name}. Your token is #${tokenNumber}.`,
          created.id,
        );
        await notifyQueueMovement(tx, queue.id);
        return created.id;
      });
      const tracking = await getQueueSnapshot(parsed.data.queueId);
      const created = tracking?.entries.find((item) => item.id === entryId);
      if (!created) {
        res.status(500).json({ error: "Unable to load your new token." });
        return;
      }
      res.status(201).json(
        CreateQueueEntryResponse.parse(created),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "DUPLICATE_TOKEN") {
        res.status(409).json({ error: "You already have an active token in this queue." });
        return;
      }
      if (message === "QUEUE_CLOSED") {
        res.status(400).json({ error: "This queue is currently closed." });
        return;
      }
      if (message === "QUEUE_NOT_FOUND") {
        res.status(404).json({ error: "This queue could not be found." });
        return;
      }
      req.log.error({ err: error }, "Unable to create a queue token");
      res.status(500).json({ error: "Unable to generate your token. Please try again." });
    }
  },
);

router.get(
  "/queue-entries/:entryId/track",
  requireQureFlowAuth,
  async (req, res): Promise<void> => {
    const params = TrackQueueEntryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Token not found." });
      return;
    }
    const snapshot = await getQueueSnapshot(
      (
        await db
          .select({ queueId: queueEntriesTable.queueId })
          .from(queueEntriesTable)
          .where(eq(queueEntriesTable.id, params.data.entryId))
          .limit(1)
      )[0]?.queueId ?? -1,
    );
    const entry = snapshot?.entries.find((item) => item.id === params.data.entryId);
    if (!entry) {
      res.status(404).json({ error: "Token not found." });
      return;
    }
    const user = req.qfUser!;
    if (
      user.role === "PATIENT" &&
      !(await getActiveEntriesForUser(user)).some((item) => item.id === entry.id)
    ) {
      res.status(403).json({ error: "You cannot view another patient's token." });
      return;
    }
    if (
      user.role === "DOCTOR" &&
      user.doctorId !== entry.doctorId
    ) {
      res.status(403).json({ error: "This token belongs to another doctor's queue." });
      return;
    }
    res.json(TrackQueueEntryResponse.parse(entry));
  },
);

router.post(
  "/queue-entries/:entryId/actions",
  requireQureFlowRoles(...staffRoles),
  async (req, res): Promise<void> => {
    const params = PerformQueueActionParams.safeParse(req.params);
    const parsed = PerformQueueActionBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Check the queue action and try again." });
      return;
    }
    const user = req.qfUser!;
    try {
      const entryId = params.data.entryId;
      const queueId = await db
        .select({ queueId: queueEntriesTable.queueId })
        .from(queueEntriesTable)
        .where(eq(queueEntriesTable.id, entryId))
        .then((result) => result[0]?.queueId);
      if (!queueId) {
        res.status(404).json({ error: "Queue token not found." });
        return;
      }
      await db.transaction(async (tx) => {
        if (!(await lockQueue(tx, queueId))) throw new Error("QUEUE_NOT_FOUND");
        const [row] = await tx
          .select({
            entry: queueEntriesTable,
            userId: patientsTable.userId,
            doctorId: queuesTable.doctorId,
          })
          .from(queueEntriesTable)
          .innerJoin(patientsTable, eq(queueEntriesTable.patientId, patientsTable.id))
          .innerJoin(queuesTable, eq(queueEntriesTable.queueId, queuesTable.id))
          .where(eq(queueEntriesTable.id, entryId))
          .limit(1);
        if (!row) throw new Error("ENTRY_NOT_FOUND");
        if (user.role === "DOCTOR" && user.doctorId !== row.doctorId) {
          throw new Error("FORBIDDEN");
        }
        const now = new Date();
        switch (parsed.data.action) {
          case "CALL_NEXT": {
            if (row.entry.status !== "WAITING") throw new Error("INVALID_TRANSITION");
            const rows = await loadQueueRows(tx, queueId);
            const next = orderQueueRows(
              rows.filter((item) => item.entry.status === "WAITING"),
            )[0];
            if (next?.entry.id !== entryId) throw new Error("NOT_NEXT");
            await tx
              .update(queueEntriesTable)
              .set({ status: "CALLED", calledAt: now })
              .where(eq(queueEntriesTable.id, entryId));
            await queueNotification(
              tx,
              row.userId,
              "You have been called",
              `Token #${row.entry.tokenNumber} is now being called. Please proceed to the clinic.`,
              entryId,
            );
            break;
          }
          case "START":
            if (row.entry.status !== "CALLED") throw new Error("INVALID_TRANSITION");
            await beginConsultation(tx, entryId, row.doctorId);
            break;
          case "COMPLETE":
            if (row.entry.status !== "IN_CONSULTATION") throw new Error("INVALID_TRANSITION");
            await completeConsultation(tx, entryId, row.entry.tokenNumber);
            await callNextWaiting(tx, queueId);
            break;
          case "SKIP":
            if (row.entry.status !== "WAITING" && row.entry.status !== "CALLED") {
              throw new Error("INVALID_TRANSITION");
            }
            await tx
              .update(queueEntriesTable)
              .set({ status: "SKIPPED" })
              .where(eq(queueEntriesTable.id, entryId));
            await queueNotification(
              tx,
              row.userId,
              "Token skipped",
              `Token #${row.entry.tokenNumber} was skipped. Please ask clinic staff to recall you.`,
              entryId,
            );
            break;
          case "RECALL":
            if (row.entry.status !== "SKIPPED") throw new Error("INVALID_TRANSITION");
            await tx
              .update(queueEntriesTable)
              .set({ status: "CALLED", calledAt: now })
              .where(eq(queueEntriesTable.id, entryId));
            await queueNotification(
              tx,
              row.userId,
              "Token recalled",
              `Token #${row.entry.tokenNumber} has been recalled. Please proceed to the clinic.`,
              entryId,
            );
            break;
          case "CANCEL":
            if (!isActiveStatus(row.entry.status) || row.entry.status === "IN_CONSULTATION") {
              throw new Error("INVALID_TRANSITION");
            }
            await tx
              .update(queueEntriesTable)
              .set({ status: "CANCELLED" })
              .where(eq(queueEntriesTable.id, entryId));
            await queueNotification(
              tx,
              row.userId,
              "Token cancelled",
              `Token #${row.entry.tokenNumber} has been cancelled by clinic staff.`,
              entryId,
            );
            break;
          case "CHANGE_PRIORITY":
            if (!parsed.data.priority) throw new Error("PRIORITY_REQUIRED");
            if (!isActiveStatus(row.entry.status) || row.entry.status === "IN_CONSULTATION") {
              throw new Error("INVALID_TRANSITION");
            }
            await tx
              .update(queueEntriesTable)
              .set({ priority: parsed.data.priority })
              .where(eq(queueEntriesTable.id, entryId));
            await queueNotification(
              tx,
              row.userId,
              "Queue priority updated",
              `Your queue priority is now ${parsed.data.priority.toLowerCase()}.`,
              entryId,
            );
            break;
        }
        await refreshQueueEstimates(tx, queueId);
        await notifyQueueMovement(tx, queueId);
      });
      const updated = await entryDtoFromDatabase(entryId);
      if (!updated) {
        res.status(404).json({ error: "Queue token not found." });
        return;
      }
      res.json(PerformQueueActionResponse.parse(updated));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "FORBIDDEN") {
        res.status(403).json({ error: "This queue belongs to another doctor." });
        return;
      }
      if (message === "ENTRY_NOT_FOUND" || message === "QUEUE_NOT_FOUND") {
        res.status(404).json({ error: "Queue token not found." });
        return;
      }
      if (message === "NOT_NEXT") {
        res.status(400).json({ error: "Another patient is next in the queue." });
        return;
      }
      if (message === "PRIORITY_REQUIRED") {
        res.status(400).json({ error: "Select a priority before saving." });
        return;
      }
      if (message === "INVALID_TRANSITION") {
        res.status(400).json({ error: "That action is not valid for this token's current status." });
        return;
      }
      req.log.error({ err: error }, "Unable to update queue entry");
      res.status(500).json({ error: "Unable to update the queue. Please try again." });
    }
  },
);

router.post(
  "/queues/:queueId/simulate",
  requireQureFlowRoles("STAFF", "ADMIN"),
  async (req, res): Promise<void> => {
    const params = SimulateQueueParams.safeParse(req.params);
    const parsed = SimulateQueueBody.safeParse(req.body);
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "Check the simulation action and try again." });
      return;
    }
    const queueId = params.data.queueId;
    try {
      const result = await db.transaction(async (tx) => {
        if (!(await lockQueue(tx, queueId))) throw new Error("QUEUE_NOT_FOUND");
        const [queue] = await tx
          .select({ doctorId: queuesTable.doctorId })
          .from(queuesTable)
          .where(eq(queuesTable.id, queueId))
          .limit(1);
        if (!queue) throw new Error("QUEUE_NOT_FOUND");
        if (parsed.data.action === "DELAY") {
          const delay = parsed.data.delayMinutes ?? 12;
          await tx
            .update(queuesTable)
            .set({
              delayMinutes: sql`least(${queuesTable.delayMinutes} + ${delay}, 180)`,
            })
            .where(eq(queuesTable.id, queueId));
          await refreshQueueEstimates(tx, queueId);
          const rows = await loadQueueRows(tx, queueId);
          for (const row of rows.filter((item) => item.entry.status === "WAITING")) {
            await queueNotification(
              tx,
              row.userId,
              "Queue delay",
              `The clinic is running about ${delay} minutes behind. Your wait estimate has been updated.`,
              row.entry.id,
            );
          }
          return { completedId: null, calledId: null, message: `Queue delay increased by ${delay} minutes.` };
        }

        const rows = await loadQueueRows(tx, queueId);
        let current = rows.find((row) => row.entry.status === "IN_CONSULTATION");
        if (!current) {
          current =
            rows.find((row) => row.entry.status === "CALLED") ??
            orderQueueRows(rows.filter((row) => row.entry.status === "WAITING"))[0];
          if (current?.entry.status === "WAITING") {
            await tx
              .update(queueEntriesTable)
              .set({ status: "CALLED", calledAt: new Date() })
              .where(eq(queueEntriesTable.id, current.entry.id));
          }
          if (current) await beginConsultation(tx, current.entry.id, queue.doctorId);
        }

        let completedId: number | null = null;
        if (current) {
          await completeConsultation(tx, current.entry.id, current.entry.tokenNumber);
          completedId = current.entry.id;
        }
        const calledId = await callNextWaiting(tx, queueId);
        await refreshQueueEstimates(tx, queueId);
        await notifyQueueMovement(tx, queueId);
        return {
          completedId,
          calledId,
          message: completedId
            ? "Consultation completed and the queue advanced."
            : "The queue is empty. Add a patient token to continue the simulation.",
        };
      });
      const snapshot = await getQueueSnapshot(queueId);
      const completedEntry =
        result.completedId == null
          ? null
          : snapshot?.entries.find((item) => item.id === result.completedId) ?? null;
      const calledEntry =
        result.calledId == null
          ? null
          : snapshot?.entries.find((item) => item.id === result.calledId) ?? null;
      if (!snapshot) {
        res.status(404).json({ error: "Queue not found." });
        return;
      }
      res.json(
        SimulateQueueResponse.parse({
          completedEntry,
          calledEntry,
          queue: snapshot.queue,
          message: result.message,
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.message === "QUEUE_NOT_FOUND") {
        res.status(404).json({ error: "Queue not found." });
        return;
      }
      req.log.error({ err: error }, "Unable to simulate queue");
      res.status(500).json({ error: "Unable to simulate the queue. Please try again." });
    }
  },
);

router.get(
  "/notifications",
  requireQureFlowAuth,
  async (req, res): Promise<void> => {
    const rows = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.userId, req.qfUser!.id))
      .orderBy(desc(notificationsTable.createdAt))
      .limit(100);
    res.json(
      ListNotificationsResponse.parse(
        rows.map((item) => ({
          id: item.id,
          title: item.title,
          message: item.message,
          createdAt: item.createdAt.toISOString(),
          isRead: item.readAt != null,
          queueEntryId: item.queueEntryId,
        })),
      ),
    );
  },
);

router.post(
  "/notifications/:notificationId/read",
  requireQureFlowAuth,
  async (req, res): Promise<void> => {
    const params = MarkNotificationReadParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Notification not found." });
      return;
    }
    const [updated] = await db
      .update(notificationsTable)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notificationsTable.id, params.data.notificationId),
          eq(notificationsTable.userId, req.qfUser!.id),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Notification not found." });
      return;
    }
    res.json(
      MarkNotificationReadResponse.parse({
        id: updated.id,
        title: updated.title,
        message: updated.message,
        createdAt: updated.createdAt.toISOString(),
        isRead: updated.readAt != null,
        queueEntryId: updated.queueEntryId,
      }),
    );
  },
);

router.get(
  "/analytics",
  requireQureFlowRoles(...clinicQueueRoles),
  async (_req, res): Promise<void> => {
    const stats = await getStats();
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const hourly = await db
      .select({
        hour: sql<string>`to_char(date_trunc('hour', ${queueEntriesTable.joinedAt}), 'HH24:00')`,
        count: sql<number>`count(*)::int`,
      })
      .from(queueEntriesTable)
      .where(sql`${queueEntriesTable.joinedAt} >= ${start}`)
      .groupBy(sql`date_trunc('hour', ${queueEntriesTable.joinedAt})`)
      .orderBy(sql`date_trunc('hour', ${queueEntriesTable.joinedAt})`);
    const queues = await db
      .select({ id: queuesTable.id, name: queuesTable.name })
      .from(queuesTable)
      .orderBy(queuesTable.name);
    const queueSizes = [];
    for (const queue of queues) {
      const [count] = await db
        .select({
          waiting: sql<number>`count(*)::int`,
        })
        .from(queueEntriesTable)
        .where(
          and(
            eq(queueEntriesTable.queueId, queue.id),
            inArray(queueEntriesTable.status, ["WAITING", "CALLED"]),
          ),
        );
      queueSizes.push({ queueName: queue.name, waiting: count?.waiting ?? 0 });
    }
    res.json(
      GetAnalyticsResponse.parse({
        stats,
        hourlyVolume: hourly,
        queueSizes,
      }),
    );
  },
);

router.get(
  "/admin/overview",
  requireQureFlowRoles(...adminRoles),
  async (_req, res): Promise<void> => {
    const [userCounts] = await db
      .select({
        patients: sql<number>`count(*) filter (where ${usersTable.role} = 'PATIENT')::int`,
        staff: sql<number>`count(*) filter (where ${usersTable.role} = 'STAFF')::int`,
        doctors: sql<number>`count(*) filter (where ${usersTable.role} = 'DOCTOR')::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(usersTable);
    const directory = await getDirectoryData();
    res.json(
      GetAdminOverviewResponse.parse({
        userCount: userCounts?.total ?? 0,
        patientCount: userCounts?.patients ?? 0,
        staffCount: userCounts?.staff ?? 0,
        doctorCount: userCounts?.doctors ?? 0,
        queues: directory.queues,
      }),
    );
  },
);

export default router;
