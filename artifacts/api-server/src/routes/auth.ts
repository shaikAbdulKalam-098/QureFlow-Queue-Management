import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  CreateDemoSessionBody,
  GetCurrentUserResponse,
} from "@workspace/api-zod";
import {
  db,
  usersTable,
  type UserRole,
} from "@workspace/db";
import {
  DEMO_COOKIE,
  requireQureFlowAuth,
  signDemoSession,
} from "../middlewares/qureflowAuth";
import { getCurrentUserDto } from "../lib/qureflow-service";

const router: IRouter = Router();

router.get("/auth/me", requireQureFlowAuth, async (req, res): Promise<void> => {
  res.json(GetCurrentUserResponse.parse(await getCurrentUserDto(req.qfUser!)));
});

router.post("/auth/demo-session", async (req, res): Promise<void> => {
  if (process.env.NODE_ENV === "production") {
    res.status(403).json({ error: "Demo sessions are available in development only." });
    return;
  }
  const parsed = CreateDemoSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose a valid demo role." });
    return;
  }
  const role = parsed.data.role as UserRole;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, `demo:${role}`))
    .limit(1);
  if (!user) {
    res.status(503).json({ error: "Demo data is still loading. Please try again." });
    return;
  }
  const forwardedProtocol = req.get("x-forwarded-proto")?.split(",")[0];
  res.cookie(DEMO_COOKIE, signDemoSession(role), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure || forwardedProtocol === "https",
    maxAge: 4 * 60 * 60 * 1000,
    path: "/",
  });
  res.json(GetCurrentUserResponse.parse(await getCurrentUserDto(user)));
});

router.delete("/auth/demo-session", (_req, res): void => {
  res.clearCookie(DEMO_COOKIE, { httpOnly: true, sameSite: "lax", path: "/" });
  res.sendStatus(204);
});

export default router;
