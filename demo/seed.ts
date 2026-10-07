// Seeds a *running* server (npm run server) with demo data. Same flow as the dashboard's "Add demo agents".
import { seedDemo } from "../apps/server/src/flows.js";

seedDemo("http://localhost:4402", (m) => console.log(m)).then(
  () => console.log("Seeded."),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
