// Child process for tests/e2e/scheduler-hard-kill.test.mjs: a real server at roundabout that is killed hard
// (no close, no exit handlers) while T1's delivery is in flight. Prints one JSON line, then dies.
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { startWorld } from "../http/helpers.mjs";
import { writeSpecs } from "./world.mjs";

const oneShip = (c) => {
  c.roles = { implement: ["fake"], review: ["fake"] }; c.routing.security_routed = ["src/auth.ts"]; c.routing.do_not_touch = [".env"];
  c.scheduler = { ...(c.scheduler ?? {}), max_concurrent_ships: 1 };
};
const x = await startWorld("slow", oneShip, { server: { pollMs: 20, schedulerTickMs: 200 } });
const post = async (name, body) => {
  const res = await x.api(`/api/commands/${name}`, { method: "POST", body });
  if (res.status !== 200 && res.status !== 202) throw new Error(`${name}: ${res.status} ${res.text}`);
};
const [cPath] = writeSpecs(x.w, [{ id: "C", scripts: ["happy"] }]);
await post("moon.assign", { planetId: x.w.planetId, specPath: cPath });
await post("config.automation", { level: "roundabout" });
for (;;) {
  const snap = (await x.api("/api/snapshot")).json;
  const t1 = snap.systems.flatMap((s) => s.planets).flatMap((p) => p.moons).find((m) => m.task_id === "T1");
  if (t1?.status === "implementing") break;
  await delay(5);
}
fs.writeSync(1, JSON.stringify({ dir: x.w.dir, webRoot: x.webRoot, pid: process.pid }) + "\n");
process.kill(process.pid, "SIGKILL");
