import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Bot, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { get, post } from "../../api/client.ts";
import { useMe } from "../../api/hooks.ts";
import { ErrorBox, Spinner } from "../../components/ui.tsx";
import { type Grant, GrantEditor } from "./AgentsPage.tsx";

type ConsentRequest = {
  id: string;
  client: { id: string; name: string; kind: "dcr" | "cimd" };
  redirectHost: string;
  scopes: { scope: string; description: string }[];
  expiresAt: string;
};

/**
 * OAuth consent, reached from /oauth/authorize after the normal sign-in. The request itself (client, redirect,
 * PKCE, state) was frozen by the server when it arrived; this page only ever refers to it by id, and chooses what
 * to grant within what was asked.
 */
export function ConnectPage() {
  const { requestId } = useParams({ strict: false }) as { requestId: string };
  const { data: me } = useMe();
  const q = useQuery({
    queryKey: ["consent", requestId],
    queryFn: () => get<{ request: ConsentRequest }>(`/agents/consent/${requestId}`),
    retry: false,
  });
  const [grant, setGrant] = useState<Grant | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const req = q.data?.request;
  const value: Grant | null =
    grant ??
    (req
      ? {
          name: req.client.name,
          scopes: req.scopes.map((s) => s.scope),
          projectAccess: "selected",
          projectIds: [],
          allowProjectCreate: false,
          approvalMode: "REQUIRE_APPROVAL",
        }
      : null);

  const answer = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ redirectTo: string }>(
        `/agents/consent/${requestId}`,
        approve ? { approve, grant: value } : { approve },
      );
      window.location.assign(r.redirectTo);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-6">
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} title="This connection request is no longer valid" />}
      {req && value && (
        <div className="card space-y-5 p-5">
          <div className="flex items-start gap-3">
            <Bot className="mt-1 size-8 shrink-0 text-accent-500" />
            <div>
              <h1 className="text-lg font-semibold">{req.client.name} wants to connect to your OpenManga account</h1>
              <p className="muted text-sm">
                Signed in as <strong>{me?.username}</strong>. After you allow it, you return to{" "}
                <code>{req.redirectHost}</code>.
              </p>
            </div>
          </div>
          <div className="flex gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <TriangleAlert className="size-4 shrink-0 text-amber-500" />
            <div>
              An external AI agent will act <strong>as you</strong> in OpenManga, within what you choose below. Anything
              that generates images, uses a text model with your key, or synthesizes speech with a provider spends{" "}
              <strong>your own provider credits</strong> and counts toward your project budgets. Your API keys
              themselves are never shared with it. You can change or revoke this any time in Agent access.
            </div>
          </div>
          <GrantEditor value={value} onChange={setGrant} offered={req.scopes.map((s) => s.scope)} />
          <ErrorBox error={error} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => answer(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !value.scopes.length || !value.name.trim()}
              onClick={() => answer(true)}
            >
              {busy && <Spinner />} Allow
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
