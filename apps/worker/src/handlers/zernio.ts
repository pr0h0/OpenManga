import { join } from "node:path";
import { and, assets, eq, exportsTable, like } from "@openmanga/db";
import { UnrecoverableError } from "@openmanga/queue";
import { publishZernioPost, uploadZernioVideo, type ZernioPublishInput, zernioPostBody } from "@openmanga/services";
import { withTempDir } from "@openmanga/storage";
import type { WorkerDeps } from "../context.ts";

type Job = { id: string; projectId: string; userId: string | null; options: Record<string, unknown> };
type Opts = ZernioPublishInput & { sourceJobId: string; credentialId: string };

/**
 * A `social_publish` job: uploads a finished video export to Zernio and publishes it now to the chosen accounts, with
 * the publishing user's own Zernio key. Nothing is retried once Zernio is called (a failure is final and says why):
 * the job id is also the post's idempotency key, so even a redelivered job cannot post twice.
 */
export async function publishToZernio(deps: WorkerDeps, job: Job, progress: (p: number) => Promise<void>) {
  const o = job.options as unknown as Opts;
  if (!job.userId) throw new UnrecoverableError("The user who published this no longer exists");
  const [file] = await deps.db
    .select({ name: exportsTable.fileName, key: assets.storageKey })
    .from(exportsTable)
    .innerJoin(assets, eq(assets.id, exportsTable.assetId))
    .where(
      and(
        eq(exportsTable.exportJobId, o.sourceJobId),
        eq(exportsTable.projectId, job.projectId),
        like(exportsTable.fileName, "%.mp4"),
      ),
    );
  if (!file) throw new UnrecoverableError("The video was deleted. Render it again, then publish.");
  const fail = (e: unknown): never => {
    throw new UnrecoverableError(e instanceof Error ? e.message : String(e));
  };
  const cred = await deps.credentials.resolve(o.credentialId, job.userId).catch(fail);
  await deps.credentials.touch(cred.id);
  return withTempDir(deps.config.TEMP_ROOT, async (dir) => {
    // Copied to disk first: the upload needs the file's length, which a storage stream does not carry.
    const path = join(dir, "video.mp4");
    await Bun.write(path, new Response(deps.assets.storage.stream(file.key)));
    await progress(0.1);
    const url = await uploadZernioVideo(cred.apiKey, file.name, Bun.file(path)).catch(fail);
    // Last moment a cancel takes effect: after this the post exists.
    await progress(0.7);
    const post = await publishZernioPost(cred.apiKey, zernioPostBody(o, url, job.id), job.id).catch(fail);
    return { zernio: post };
  });
}
