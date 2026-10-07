import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import qureflowRouter from "./qureflow";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(qureflowRouter);

export default router;
