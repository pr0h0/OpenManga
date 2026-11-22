import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Send } from "lucide-react";
import { useState } from "react";
import { get, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import type { ExportListItem } from "../../api/types.ts";
import { ErrorBox, Field, Modal, Spinner } from "../../components/ui.tsx";
import { useAiOptions } from "../ai/AiPicker.tsx";
import { useProject, useProjectId } from "../project/ProjectLayout.tsx";

type Account = {
  id: string;
  platform: string;
  username: string;
  displayName: string;
  picture: string | null;
  usable: boolean;
  supported: boolean;
};
type PlatformResult = { platform: string; accountId: string; status: string; url: string | null; error: string | null };

/** "Publish" on a finished video: sends it through the user's Zernio key to the accounts connected on zernio.com. */
export function ZernioPublishButton({ job }: { job: ExportListItem }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
        <Send className="size-4" /> Publish
      </button>
      {open && <PublishDialog job={job} onClose={() => setOpen(false)} />}
    </>
  );
}

function PublishDialog({ job, onClose }: { job: ExportListItem; onClose: () => void }) {
  const projectId = useProjectId();
  const { data: overview } = useProject();
  const keys = (useAiOptions().data?.credentials ?? []).filter((c) => c.kind === "zernio");
  const [credentialId, setCredentialId] = useState("");
  const cred = credentialId || keys[0]?.id || "";
  const accounts = useQuery({
    queryKey: ["zernio-accounts", cred],
    queryFn: () => get<{ accounts: Account[] }>(`/zernio/accounts?credentialId=${cred}`),
    enabled: Boolean(cred),
  });
  // Prefilled from the Short's own social text, else the project's YouTube package, else the project title.
  const social = (job.options as { social?: { title?: string; caption?: string } }).social;
  const yt = overview?.project.settings.youtubePackage;
  const [form, setForm] = useState({
    title: social?.title || yt?.titles[0] || overview?.project.title || "",
    caption: social?.caption || yt?.description || "",
    tags: yt?.tags ?? [],
    visibility: "public" as "public" | "unlisted" | "private",
    aiGenerated: true,
    tiktokConsent: false,
  });
  const [picked, setPicked] = useState<string[]>([]);
  const chosen = (accounts.data?.accounts ?? []).filter((a) => picked.includes(a.id));
  const has = (p: string) => chosen.some((a) => a.platform === p);
  const publish = useAction(
    () => post(`/exports/${job.id}/publish`, { ...form, credentialId: cred, accountIds: picked }),
    { invalidate: [qk.exports(projectId)], success: "Publishing queued", onSuccess: onClose },
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Publish with Zernio"
      footer={
        keys.length > 0 && (
          <button
            type="button"
            className="btn-primary"
            disabled={publish.isPending || !picked.length || (has("tiktok") && !form.tiktokConsent)}
            onClick={() => publish.mutate()}
          >
            {publish.isPending ? <Spinner /> : <Send className="size-4" />} Publish now
          </button>
        )
      }
    >
      {!keys.length ? (
        <p className="text-sm">
          Add your Zernio API key under{" "}
          <Link to="/account" className="underline">
            Account → AI providers
          </Link>{" "}
          (provider "Zernio"), and connect your social accounts on{" "}
          <a className="underline" href="https://zernio.com/dashboard" target="_blank" rel="noreferrer">
            zernio.com
          </a>
          .
        </p>
      ) : (
        <div className="space-y-3">
          {keys.length > 1 && (
            <Field label="Zernio key">
              <select className="input" value={cred} onChange={(e) => setCredentialId(e.target.value)}>
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label} ({k.keyHint})
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field
            label="Accounts"
            hint={
              <a className="underline" href="https://zernio.com/dashboard" target="_blank" rel="noreferrer">
                Connect more accounts on zernio.com
              </a>
            }
          >
            {accounts.isLoading && <Spinner />}
            <ErrorBox error={accounts.error} onRetry={() => accounts.refetch()} />
            {accounts.data && !accounts.data.accounts.length && (
              <p className="muted text-sm">No accounts connected on Zernio yet.</p>
            )}
            <ul className="space-y-1">
              {accounts.data?.accounts.map((a) => {
                const ok = a.usable && a.supported;
                return (
                  <li key={a.id}>
                    <label className={`flex items-center gap-2 text-sm ${ok ? "" : "opacity-50"}`}>
                      <input
                        type="checkbox"
                        disabled={!ok}
                        checked={picked.includes(a.id)}
                        onChange={(e) =>
                          setPicked(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))
                        }
                      />
                      {a.picture && <img src={a.picture} alt="" className="size-5 rounded-full" />}
                      <span className="chip">{a.platform}</span>
                      <span>{a.displayName}</span>
                      <span className="muted text-xs">@{a.username}</span>
                      {!a.usable && <span className="text-xs text-amber-600">reconnect on Zernio</span>}
                      {a.usable && !a.supported && <span className="muted text-xs">no video posts</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          </Field>
          <Field label="Title (YouTube, Facebook)">
            <input
              className="input"
              maxLength={100}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </Field>
          <Field label="Caption / description">
            <textarea
              className="input min-h-28"
              maxLength={5000}
              value={form.caption}
              onChange={(e) => setForm({ ...form, caption: e.target.value })}
            />
          </Field>
          {has("youtube") && (
            <Field label="YouTube visibility">
              <select
                className="input"
                value={form.visibility}
                onChange={(e) => setForm({ ...form, visibility: e.target.value as typeof form.visibility })}
              >
                <option value="public">Public</option>
                <option value="unlisted">Unlisted</option>
                <option value="private">Private</option>
              </select>
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.aiGenerated}
              onChange={(e) => setForm({ ...form, aiGenerated: e.target.checked })}
            />
            Label as AI-generated where the platform supports it
          </label>
          {has("tiktok") && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={form.tiktokConsent}
                onChange={(e) => setForm({ ...form, tiktokConsent: e.target.checked })}
              />
              I have watched this video and agree to post it publicly to TikTok.
            </label>
          )}
          <ErrorBox error={publish.error} />
          <p className="muted text-xs">
            Posts immediately. Zernio refuses the same video to the same account twice in 24 h.
          </p>
        </div>
      )}
    </Modal>
  );
}

/** What a finished `social_publish` job reports per platform. */
export function ZernioResult({ result }: { result: Record<string, unknown> | null }) {
  const post = result?.zernio as { platforms: PlatformResult[] } | undefined;
  if (!post?.platforms.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs">
      {post.platforms.map((p) => (
        <li key={p.accountId} className={p.error ? "text-red-600" : undefined}>
          <span className="chip">{p.platform}</span> {p.status}
          {p.url && (
            <a
              className="ml-1 inline-flex items-center gap-0.5 underline"
              href={p.url}
              target="_blank"
              rel="noreferrer"
            >
              open <ExternalLink className="size-3" />
            </a>
          )}
          {p.error && ` — ${p.error}`}
        </li>
      ))}
    </ul>
  );
}
