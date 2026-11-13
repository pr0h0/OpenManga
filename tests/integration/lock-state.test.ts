import { afterAll, beforeAll, test } from "bun:test";
import { sql } from "@openmanga/db";
import { startHarness, type TestClient } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let owner: TestClient;
let editor: TestClient;
let projectId: string;
let chapterId: string;
let pageId: string;
let panelId: string;

beforeAll(async () => {
  h = await startHarness();
  owner = h.client();
  editor = h.client();
  await owner.post(
    "/api/auth/register",
    { username: "lockowner", email: "lo@example.com", password: "lock-owner-1" },
    201,
  );
  await editor.post(
    "/api/auth/register",
    { username: "lockedit", email: "le@example.com", password: "lock-editor-1" },
    201,
  );
  projectId = (await owner.post<{ project: { id: string } }>("/api/projects", { title: "Locks" }, 201)).project.id;
  const editorId = (await editor.get<{ user: { id: string } }>("/api/auth/me")).user.id;
  await h.deps.db.execute(
    sql`insert into project_members (project_id, user_id, role) values (${projectId}, ${editorId}, 'editor')`,
  );
  chapterId = (
    await owner.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "One" }, 201)
  ).chapter.id;
  pageId = (await owner.post<{ page: { id: string } }>(`/api/chapters/${chapterId}/pages`, {}, 201)).page.id;
  panelId = (await owner.post<{ panel: { id: string } }>(`/api/pages/${pageId}/panels`, {}, 201)).panel.id;
}, 60_000);
afterAll(() => h?.stop());

test("an editor cannot reopen a locked page, panel or chapter plan; the owner can", async () => {
  await owner.patch(`/api/pages/${pageId}`, { status: "locked" });
  await owner.patch(`/api/panels/${panelId}`, { approvalStatus: "locked" });
  await owner.patch(`/api/chapters/${chapterId}`, { planStatus: "locked" });

  await editor.patch(`/api/pages/${pageId}`, { status: "draft" }, 403);
  await editor.patch(`/api/panels/${panelId}`, { approvalStatus: "draft" }, 403);
  await editor.patch(`/api/chapters/${chapterId}`, { planStatus: "draft" }, 403);

  await owner.patch(`/api/pages/${pageId}`, { status: "draft" });
  await owner.patch(`/api/panels/${panelId}`, { approvalStatus: "draft" });
  await owner.patch(`/api/chapters/${chapterId}`, { planStatus: "draft" });
});

test("bubbles and sound effects on a locked page cannot be added, edited or removed", async () => {
  const d = (await editor.post<{ dialogue: { id: string } }>(`/api/pages/${pageId}/dialogue`, { text: "Hey" }, 201))
    .dialogue.id;
  const s = (await editor.post<{ sfx: { id: string } }>(`/api/pages/${pageId}/sfx`, { text: "BANG" }, 201)).sfx.id;
  await owner.patch(`/api/pages/${pageId}`, { status: "locked" });

  await editor.post(`/api/pages/${pageId}/dialogue`, { text: "More" }, 409);
  await editor.patch(`/api/dialogue/${d}`, { text: "Changed" }, 409);
  await editor.del(`/api/dialogue/${d}`, 409);
  await editor.post(`/api/pages/${pageId}/sfx`, { text: "BOOM" }, 409);
  await editor.patch(`/api/sfx/${s}`, { text: "POW" }, 409);
  await editor.del(`/api/sfx/${s}`, 409);
});
