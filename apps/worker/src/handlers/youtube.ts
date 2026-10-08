import { eq, youtubeChannels } from "@openmanga/db";
import type { WorkerDeps } from "../context.ts";

/** The hourly pass: public-counter snapshots that are due, reach reports, retention. */
export async function youtubeHourly(deps: WorkerDeps) {
  const r = await deps.youtube.hourly();
  deps.logger.info("youtube stats pass", r);
  return r;
}

/** A video was just linked under a connection: read every reach report Google still has, so its history is there. */
export async function youtubeBackfill(deps: WorkerDeps, connectionId: string) {
  const [conn] = await deps.db.select().from(youtubeChannels).where(eq(youtubeChannels.id, connectionId));
  if (conn?.status !== "active") return { reachRows: 0 };
  return { reachRows: await deps.youtube.ingestReports(conn, { full: true }) };
}
