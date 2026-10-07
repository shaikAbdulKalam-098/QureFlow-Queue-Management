import { and, eq } from "drizzle-orm";
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

const demoUsers = [
  { role: "PATIENT" as const, name: "Maya Patel", email: "maya@example.test" },
  { role: "STAFF" as const, name: "Nisha Desai", email: "nisha@example.test" },
  { role: "DOCTOR" as const, name: "Dr. Ananya Rao", email: "ananya@example.test" },
  { role: "ADMIN" as const, name: "Devika Menon", email: "devika@example.test" },
];

const departments = [
  "General Medicine",
  "Cardiology",
  "Dermatology",
  "Pediatrics",
];

const doctorSeeds = [
  { name: "Dr. Ananya Rao", department: "General Medicine", duration: 5.2 },
  { name: "Dr. Rahul Mehta", department: "Cardiology", duration: 8.1 },
  { name: "Dr. Priya Sharma", department: "Dermatology", duration: 6.4 },
  { name: "Dr. Arjun Nair", department: "Pediatrics", duration: 7.3 },
];

const samplePatients = [
  { name: "Aarav Shah", email: "aarav@example.test" },
  { name: "Sara Iyer", email: "sara@example.test" },
  { name: "Kabir Rao", email: "kabir@example.test" },
  { name: "Meera Nair", email: "meera@example.test" },
  { name: "Ishaan Das", email: "ishaan@example.test" },
];

async function upsertDemoUser(role: (typeof demoUsers)[number]["role"], name: string, email: string) {
  const [user] = await db
    .insert(usersTable)
    .values({ clerkUserId: `demo:${role}`, role, name, email })
    .onConflictDoUpdate({
      target: usersTable.clerkUserId,
      set: { role, name, email },
    })
    .returning();
  return user;
}

async function upsertSeedPatient(name: string, email: string) {
  const clerkUserId = `seed:patient:${email}`;
  const [user] = await db
    .insert(usersTable)
    .values({ clerkUserId, role: "PATIENT", name, email })
    .onConflictDoUpdate({
      target: usersTable.clerkUserId,
      set: { name, email, role: "PATIENT" },
    })
    .returning();

  const [existing] = await db
    .select()
    .from(patientsTable)
    .where(eq(patientsTable.userId, user.id))
    .limit(1);
  if (existing) return existing;

  const [patient] = await db
    .insert(patientsTable)
    .values({ userId: user.id, displayName: name })
    .returning();
  return patient;
}

async function getOrCreateQueue(
  clinicName: string,
  departmentId: number,
  doctorId: number,
  departmentName: string,
) {
  const name = `${departmentName} queue`;
  const [existing] = await db
    .select()
    .from(queuesTable)
    .where(
      and(
        eq(queuesTable.clinicName, clinicName),
        eq(queuesTable.doctorId, doctorId),
        eq(queuesTable.name, name),
      ),
    )
    .limit(1);
  if (existing) return existing;
  const [queue] = await db
    .insert(queuesTable)
    .values({ clinicName, departmentId, doctorId, name, isOpen: true })
    .returning();
  return queue;
}

export async function seedQureFlowDemoData(): Promise<void> {
  for (const name of departments) {
    await db.insert(departmentsTable).values({ name }).onConflictDoNothing();
  }

  const departmentRows = await db.select().from(departmentsTable);
  const departmentByName = new Map(departmentRows.map((item) => [item.name, item]));

  const demoUserByRole = new Map<string, (typeof usersTable.$inferSelect)>();
  for (const user of demoUsers) {
    demoUserByRole.set(
      user.role,
      await upsertDemoUser(user.role, user.name, user.email),
    );
  }
  const demoPatientUser = demoUserByRole.get("PATIENT");
  if (!demoPatientUser) throw new Error("Missing demo patient seed user");

  const demoPatientRow = await (async () => {
    const [existing] = await db
      .select()
      .from(patientsTable)
      .where(eq(patientsTable.userId, demoPatientUser.id))
      .limit(1);
    if (existing) return existing;
    const [patient] = await db
      .insert(patientsTable)
      .values({ userId: demoPatientUser.id, displayName: demoPatientUser.name })
      .returning();
    return patient;
  })();

  const seededPatientRows = [];
  for (const patient of samplePatients) {
    seededPatientRows.push(await upsertSeedPatient(patient.name, patient.email));
  }

  const clinicName = "QureFlow Community Clinic";
  for (const doctorSeed of doctorSeeds) {
    const department = departmentByName.get(doctorSeed.department);
    if (!department) throw new Error(`Missing department ${doctorSeed.department}`);

    const [doctor] = await db
      .insert(doctorsTable)
      .values({
        name: doctorSeed.name,
        departmentId: department.id,
        defaultDurationMinutes: doctorSeed.duration,
      })
      .onConflictDoNothing()
      .returning();
    const doctorRow =
      doctor ??
      (
        await db
          .select()
          .from(doctorsTable)
          .where(eq(doctorsTable.name, doctorSeed.name))
          .limit(1)
      )[0];
    if (!doctorRow) throw new Error(`Unable to seed ${doctorSeed.name}`);

    const queue = await getOrCreateQueue(
      clinicName,
      department.id,
      doctorRow.id,
      department.name,
    );

    const doctorDemoUser = demoUserByRole.get("DOCTOR");
    if (doctorDemoUser && doctorSeed.name === "Dr. Ananya Rao") {
      await db
        .update(usersTable)
        .set({ doctorId: doctorRow.id })
        .where(eq(usersTable.id, doctorDemoUser.id));
      await db
        .update(doctorsTable)
        .set({ userId: doctorDemoUser.id })
        .where(eq(doctorsTable.id, doctorRow.id));
    }

    const [firstEntry] = await db
      .select()
      .from(queueEntriesTable)
      .where(eq(queueEntriesTable.queueId, queue.id))
      .limit(1);
    if (firstEntry) continue;

    const now = Date.now();
    const priorDurations = [4.8, 6.1, 5.4, 4.9, 5.7];
    for (let index = 0; index < priorDurations.length; index += 1) {
      const patient = seededPatientRows[index % seededPatientRows.length];
      const endedAt = new Date(now - (index + 1) * 26 * 60 * 60 * 1000);
      const startedAt = new Date(
        endedAt.getTime() - priorDurations[index] * 60 * 1000,
      );
      const [entry] = await db
        .insert(queueEntriesTable)
        .values({
          queueId: queue.id,
          patientId: patient.id,
          tokenNumber: 20 + index,
          status: "COMPLETED",
          priority: "NORMAL",
          joinedAt: new Date(startedAt.getTime() - 14 * 60 * 1000),
          calledAt: new Date(startedAt.getTime() - 2 * 60 * 1000),
          consultationStartedAt: startedAt,
          completedAt: endedAt,
        })
        .returning();
      await db.insert(consultationsTable).values({
        queueEntryId: entry.id,
        doctorId: doctorRow.id,
        startedAt,
        endedAt,
        durationMinutes: priorDurations[index],
      });
    }

    if (doctorSeed.name !== "Dr. Ananya Rao") {
      for (let index = 0; index < 3; index += 1) {
        const patient = seededPatientRows[(index + 1) % seededPatientRows.length];
        await db.insert(queueEntriesTable).values({
          queueId: queue.id,
          patientId: patient.id,
          tokenNumber: 14 + index,
          status: index === 0 ? "CALLED" : "WAITING",
          priority: "NORMAL",
          joinedAt: new Date(now - (3 - index) * 6 * 60 * 1000),
          ...(index === 0 ? { calledAt: new Date(now - 90 * 1000) } : {}),
        });
      }
      continue;
    }

    const currentStartedAt = new Date(now - 6 * 60 * 1000);
    const activeRows = [
      {
        patientId: seededPatientRows[0].id,
        tokenNumber: 38,
        status: "IN_CONSULTATION" as const,
        priority: "NORMAL" as const,
        joinedAt: new Date(now - 38 * 60 * 1000),
        calledAt: new Date(now - 10 * 60 * 1000),
        consultationStartedAt: currentStartedAt,
      },
      {
        patientId: seededPatientRows[1].id,
        tokenNumber: 39,
        status: "WAITING" as const,
        priority: "NORMAL" as const,
        joinedAt: new Date(now - 33 * 60 * 1000),
      },
      {
        patientId: seededPatientRows[2].id,
        tokenNumber: 40,
        status: "WAITING" as const,
        priority: "NORMAL" as const,
        joinedAt: new Date(now - 27 * 60 * 1000),
      },
      {
        patientId: seededPatientRows[3].id,
        tokenNumber: 41,
        status: "WAITING" as const,
        priority: "PRIORITY" as const,
        joinedAt: new Date(now - 20 * 60 * 1000),
      },
      {
        patientId: demoPatientRow.id,
        tokenNumber: 42,
        status: "WAITING" as const,
        priority: "NORMAL" as const,
        joinedAt: new Date(now - 16 * 60 * 1000),
      },
    ];
    for (const row of activeRows) {
      const [entry] = await db
        .insert(queueEntriesTable)
        .values({
          queueId: queue.id,
          ...row,
        })
        .returning();
      if (row.status === "IN_CONSULTATION") {
        await db.insert(consultationsTable).values({
          queueEntryId: entry.id,
          doctorId: doctorRow.id,
          startedAt: currentStartedAt,
        });
      }
    }
  }

  const [tokenNotification] = await db
    .select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.userId, demoPatientUser.id),
        eq(notificationsTable.title, "Digital token ready"),
      ),
    )
    .limit(1);
  if (!tokenNotification) {
    const [activeToken] = await db
      .select()
      .from(queueEntriesTable)
      .where(
        and(
          eq(queueEntriesTable.patientId, demoPatientRow.id),
          eq(queueEntriesTable.tokenNumber, 42),
        ),
      )
      .limit(1);
    await db.insert(notificationsTable).values({
      userId: demoPatientUser.id,
      queueEntryId: activeToken?.id ?? null,
      title: "Digital token ready",
      message: "You're in the General Medicine queue. Your token is #42.",
    });
  }
}
