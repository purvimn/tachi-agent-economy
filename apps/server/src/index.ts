import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { payRouter } from "./routes/pay.js";
import { agentsRouter } from "./routes/agents.js";
import { servicesRouter } from "./routes/services.js";
import { yieldRouter } from "./routes/yield.js";
import { daemonRouter } from "./routes/daemon.js";
import { datasetsRouter } from "./routes/datasets.js";
import { merchantsRouter } from "./routes/merchants.js";
import { demoRouter } from "./routes/demo.js";
import { nostrRouter } from "./routes/nostr.js";
import { auditRouter } from "./routes/audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(__dirname, "../../dashboard/dist");

const app = express();
app.use(express.json());
app.use(express.static(dashboardDir));

app.use(payRouter);
app.use(agentsRouter);
app.use(servicesRouter);
app.use(yieldRouter);
app.use(daemonRouter);
app.use(datasetsRouter);
app.use(merchantsRouter);
app.use(demoRouter);
app.use(nostrRouter);
app.use(auditRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT ?? 4402);
app.listen(port, () => console.log(`Tachi Agent Economy server listening on :${port}\nDashboard: http://localhost:${port}/`));
