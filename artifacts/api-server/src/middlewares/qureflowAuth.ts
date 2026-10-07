import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getAuth } from "@clerk/express";
import { and, eq } from "drizzle-orm";
import {
  db,
  patientsTable,
  usersTable,
  type UserRole,
} from "@workspace/db";

export type QureFlowUser = typeof usersTable.$inferSelect;

declare global {
  namespace Express {
    interface Request {
      qfUser?: QureFlowUser;
    }
  }
}

const allowedRoles: UserRole[] = ["PATIENT", "STAFF", "DOCTOR", "ADMIN"];
const DEMO_COOKIE = "qf_demo";

export function signDemoSession(role: UserRole): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("Demo sessions are disabled until SESSION_SECRET is configured");
  const signature = createHmac("sha256", secret).update(role).digest("hex");
  return `${role}.${signature}`;
}

function getSignedDemoRole(value: unknown): UserRole | null {
  if (process.env.NODE_ENV === "production" || typeof value !== "string") {
    return null;
  }
  const [role, signature, extra] = value.split(".");
  if (extra !== undefined || !allowedRoles.includes(role as UserRole) || !signature) {
    return null;
  }
  const expected = signDemoSession(role as UserRole).split(".")[1];
  const providedBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }
  return role as UserRole;
}

async function getOrCreateClerkUser(req: Request): Promise<QureFlowUser | null> {
  const clerkUserId = getAuth(req).userId;
  if (!clerkUserId) return null;

  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, clerkUserId))
    .limit(1);
  if (existing) return existing;

  const claims = getAuth(req).sessionClaims as
    | Record<string, unknown>
    | null
    | undefined;
  const name =
    (typeof claims?.name === "string" && claims.name.trim()) ||
    (typeof claims?.given_name === "string" && claims.given_name.trim()) ||
    "QureFlow patient";
  const email =
    (typeof claims?.email === "string" && claims.email.trim()) ||
    (Array.isArray(claims?.email_addresses) &&
      typeof claims.email_addresses[0] === "string" &&
      claims.email_addresses[0]) ||
    "";

  const [created] = await db
    .insert(usersTable)
    .values({ clerkUserId, name, email, role: "PATIENT" })
    .onConflictDoNothing()
    .returning();
  const user =
    created ??
    (
      await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.clerkUserId, clerkUserId))
        .limit(1)
    )[0] ??
    null;

  if (user?.role === "PATIENT") {
    await db
      .insert(patientsTable)
      .values({ userId: user.id, displayName: user.name })
      .onConflictDoNothing();
  }
  return user;
}

export async function resolveQureFlowUser(req: Request): Promise<QureFlowUser | null> {
  const demoRole = getSignedDemoRole(req.cookies?.[DEMO_COOKIE]);
  if (demoRole) {
    const [demoUser] = await db
      .select()
      .from(usersTable)
      .where(
        and(
          eq(usersTable.clerkUserId, `demo:${demoRole}`),
          eq(usersTable.role, demoRole),
        ),
      )
      .limit(1);
    if (demoUser) return demoUser;
  }
  return getOrCreateClerkUser(req);
}

export function requireQureFlowAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  void resolveQureFlowUser(req)
    .then((user) => {
      if (!user) {
        res.status(401).json({ error: "Sign in to continue." });
        return;
      }
      req.qfUser = user;
      next();
    })
    .catch(next);
}

export function requireQureFlowRoles(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    requireQureFlowAuth(req, res, () => {
      if (!req.qfUser || !roles.includes(req.qfUser.role)) {
        res.status(403).json({ error: "Your account cannot perform this action." });
        return;
      }
      next();
    });
  };
}

export { DEMO_COOKIE };
