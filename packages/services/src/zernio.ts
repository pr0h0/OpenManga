/**
 * Zernio (zernio.com) publishes one video to the social accounts a user connected on Zernio (YouTube, TikTok,
 * Instagram, …). The user's own Zernio API key is a BYOK credential (kind `zernio`); Zernio holds every platform
 * token, so the server only ever sees account ids. Shapes follow https://zernio.com/openapi.json (v1.735).
 */
const BASE = "https://zernio.com/api";

export class ZernioError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Socket, TLS and timeout errors carry internals; the user sees a fixed message instead. */
const unreachable = (e: unknown): never => {
  throw new ZernioError(
    503,
    `Could not reach Zernio${(e as Error)?.name === "TimeoutError" ? " (no answer in time)" : ""}. Try again in a moment.`,
  );
};

async function call<T>(
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string; timeoutMs?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.idempotencyKey ? { "idempotency-key": init.idempotencyKey } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  }).catch(unreachable);
  // The body is read under the same timeout: a reset or timeout here is just as unreachable.
  const text = await res.text().catch(unreachable);
  let json: { error?: unknown; message?: unknown } | undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {}
  // 207: a publishNow where some platform failed; the body carries each platform's result.
  if (!res.ok && res.status !== 207) {
    const msg = json?.error ?? json?.message;
    throw new ZernioError(
      res.status,
      res.status === 401
        ? "Zernio rejected the API key"
        : `Zernio: ${typeof msg === "string" ? msg : `HTTP ${res.status}`}`,
    );
  }
  // A maintenance page or a proxy's reply: never hand callers `undefined` to destructure.
  if (!json || typeof json !== "object") throw new ZernioError(502, "Zernio returned an unexpected response");
  return json as T;
}

export type ZernioAccount = {
  id: string;
  platform: string;
  username: string;
  displayName: string;
  picture: string | null;
  /** False when Zernio says the account must be reconnected (on zernio.com) before it can post. */
  usable: boolean;
};

/** Every account connected to the key's Zernio workspace, across its profiles. Also the key check (free read). */
export async function listZernioAccounts(apiKey: string, fetchImpl?: typeof fetch): Promise<ZernioAccount[]> {
  const { accounts = [] } = await call<{
    accounts?: {
      _id: string;
      platform: string;
      username?: string;
      displayName?: string;
      profilePicture?: string;
      isActive?: boolean;
      needsReconnection?: boolean;
    }[];
  }>(apiKey, "/v1/accounts", {}, fetchImpl);
  return accounts.map((a) => ({
    id: a._id,
    platform: a.platform,
    username: a.username ?? "",
    displayName: a.displayName ?? a.username ?? a.platform,
    picture: a.profilePicture ?? null,
    usable: a.isActive !== false && !a.needsReconnection,
  }));
}

/** Uploads a video to Zernio's storage (presigned PUT, up to 5 GB) and returns the URL posts reference. */
export async function uploadZernioVideo(apiKey: string, name: string, file: Blob): Promise<string> {
  const { uploadUrl, publicUrl } = await call<{ uploadUrl: string; publicUrl: string }>(apiKey, "/v1/media/presign", {
    method: "POST",
    body: { filename: name, contentType: "video/mp4", size: file.size },
  });
  if (!uploadUrl || !publicUrl) throw new ZernioError(502, "Zernio did not return an upload URL");
  // A Blob (a file on disk), not a stream: a presigned PUT needs Content-Length, and a stream body goes chunked.
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "video/mp4" },
    body: file,
    signal: AbortSignal.timeout(60 * 60_000),
  }).catch(unreachable);
  if (!res.ok) throw new ZernioError(res.status, `Zernio upload failed (HTTP ${res.status})`);
  return publicUrl;
}

export type ZernioPublishInput = {
  targets: { accountId: string; platform: string }[];
  title: string;
  caption: string;
  tags: string[];
  visibility: "public" | "unlisted" | "private";
  /** Platforms that label AI media get the disclosure (the art and voice are generated). */
  aiGenerated: boolean;
  /** TikTok's Direct Post rules: the creator saw the video and agreed to post it. */
  tiktokConsent: boolean;
};

/** Pure: the POST /v1/posts body publishing one video now to every target. */
export function zernioPostBody(input: ZernioPublishInput, mediaUrl: string, externalId: string) {
  const ai = input.aiGenerated;
  const specific = (platform: string): Record<string, unknown> | undefined => {
    switch (platform) {
      case "youtube":
        return {
          title: (input.title || "Untitled").slice(0, 100),
          visibility: input.visibility,
          madeForKids: false,
          containsSyntheticMedia: ai,
        };
      case "tiktok":
        return {
          privacyLevel: "PUBLIC_TO_EVERYONE",
          allowComment: true,
          allowDuet: true,
          allowStitch: true,
          contentPreviewConfirmed: input.tiktokConsent,
          expressConsentGiven: input.tiktokConsent,
          commercialContentType: "none",
          videoMadeWithAi: ai,
        };
      case "instagram":
        return { shareToFeed: true, isAiGenerated: ai };
      case "facebook":
        return { contentType: "reel", ...(input.title ? { title: input.title.slice(0, 255) } : {}), isAiGenerated: ai };
      case "twitter":
        return { madeWithAi: ai };
      default:
        return undefined;
    }
  };
  return {
    content: input.caption,
    mediaItems: [{ type: "video", url: mediaUrl }],
    platforms: input.targets.map((t) => {
      const psd = specific(t.platform);
      return { platform: t.platform, accountId: t.accountId, ...(psd ? { platformSpecificData: psd } : {}) };
    }),
    ...(input.tags.length ? { tags: input.tags } : {}),
    publishNow: true,
    externalId,
    metadata: { source: "openmanga" },
  };
}

export type ZernioPlatformResult = {
  platform: string;
  accountId: string;
  status: string;
  url: string | null;
  error: string | null;
};

/**
 * Publishes now. The idempotency key makes a retried job return the first post instead of posting twice; Zernio also
 * refuses the same content to the same account within 24 hours.
 */
export async function publishZernioPost(
  apiKey: string,
  body: ReturnType<typeof zernioPostBody>,
  idempotencyKey: string,
): Promise<{ postId: string; status: string; platforms: ZernioPlatformResult[] }> {
  const res = await call<{
    post?: {
      _id: string;
      status: string;
      platforms?: {
        platform: string;
        accountId?: string | { _id: string } | null;
        status?: string;
        platformPostUrl?: string;
        errorMessage?: string;
      }[];
    };
  }>(apiKey, "/v1/posts", { method: "POST", body, idempotencyKey, timeoutMs: 30 * 60_000 }).catch((e: unknown) => {
    // No answer, a gateway error or a reply we can't read is not "not published": Zernio may have posted it, and a
    // new job would post it again. (Unreachable and unreadable replies are 503/502 too.)
    if (e instanceof ZernioError && e.status >= 500)
      throw new ZernioError(
        e.status,
        "Zernio did not confirm the post, so it may already be live. Check zernio.com before publishing again.",
      );
    throw e;
  });
  const post = res.post;
  if (!post)
    throw new ZernioError(502, "Zernio did not return the post, so it may already be live. Check zernio.com first.");
  return {
    postId: post._id,
    status: post.status,
    // Read defensively: the post is live by now, so an odd shape must not turn into a failure.
    platforms: (Array.isArray(post.platforms) ? post.platforms : []).map((p) => ({
      platform: p.platform,
      accountId: typeof p.accountId === "string" ? p.accountId : (p.accountId?._id ?? ""),
      status: p.status ?? post.status,
      url: p.platformPostUrl ?? null,
      error: p.errorMessage ?? null,
    })),
  };
}
