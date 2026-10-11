import { assets, eq, referenceAssets } from "@openmanga/db";
import { z } from "zod";
import { defineMcpTool, Passthrough, type ToolContext } from "../registry.ts";
import { toolError } from "../runtime.ts";
import { cls, projectOf, Uuid } from "./common.ts";

/** Sizes offered, as the app's own display copies: small enough to send, large enough to judge. */
const SIZES = { thumbnail: 384, preview: 1024, large: 2048 } as const;
const VARIANT = { thumbnail: "thumbnail", preview: "preview", large: "web" } as const;
type Size = keyof typeof SIZES;

async function assetProject(ctx: ToolContext, assetId: string) {
  const [a] = await ctx.deps.db.select({ p: assets.projectId }).from(assets).where(eq(assets.id, assetId));
  if (!a?.p) throw toolError(404, "not_found", "Image not found");
  return a.p;
}

/** The stored image behind the target (never a caller-chosen asset of another project), as a display-size copy. */
async function assetImage(ctx: ToolContext, assetId: string, size: Size) {
  const asset = await ctx.deps.assets.get(assetId);
  if (!asset?.mimeType.startsWith("image/")) throw toolError(404, "not_found", "Not an image");
  if (asset.deletedAt) throw toolError(404, "not_found", "This image is in the trash");
  const v = await ctx.deps.assets.ensureResized(asset, VARIANT[size], SIZES[size]);
  if (!v) throw toolError(404, "not_found", "Not an image");
  return {
    data: await ctx.deps.assets.readVariant(v),
    mimeType: v.mimeType,
    width: v.width,
    height: v.height,
    assetId: asset.id,
  };
}

export const imageTools = [
  defineMcpTool({
    name: "get_image",
    title: "Get image",
    description:
      "Look at an image itself, returned as image content (not just its id): a panel's current artwork (kind=panel), a page as readers see it, with its speech bubbles, SFX and captions composited (kind=page), a character/location/prop/style reference image (kind=reference, the reference id), or any image asset of a project (kind=asset). size: thumbnail (384 px), preview (1024 px, default) or large (2048 px). Use it to check artwork, consistency or lettering before deciding what to change. Read-only; nothing is generated or spent.",
    input: z.object({
      kind: z.enum(["panel", "page", "reference", "asset"]),
      id: Uuid.describe("The panel, page, reference or asset id."),
      size: z.enum(["thumbnail", "preview", "large"]).default("preview"),
    }),
    output: z
      .object({
        kind: z.string(),
        id: z.string(),
        mimeType: z.string(),
        width: z.number().nullable(),
        height: z.number().nullable(),
        bytes: z.number(),
      })
      .passthrough(),
    scopes: ["panels:read", "library:read", "projects:read"],
    scopesFor: (a) =>
      a.kind === "panel" || a.kind === "page"
        ? ["panels:read"]
        : a.kind === "reference"
          ? ["library:read"]
          : ["projects:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/panels/:id", "GET /api/pages/:id/render.png", "GET /api/assets/:id"],
    actionKeys: [],
    // A read, but classified anyway: the image's project must be one the user belongs to and the connection may see.
    classify: async ({ kind, id }, ctx) =>
      cls(
        "read",
        "image.get",
        kind === "asset"
          ? await assetProject(ctx, id)
          : await projectOf(ctx, kind === "reference" ? "reference" : kind, id),
        "Read an image",
      ),
    handler: async ({ kind, id, size }, ctx) => {
      let img: { data: Uint8Array; mimeType: string; width: number | null; height: number | null; assetId?: string };
      if (kind === "page") {
        // The lettered page, composited exactly as the app previews it.
        const r = await ctx.invokeBinary(`/api/pages/${id}/render.png`, {
          query: { width: Math.min(SIZES[size], 1600) },
        });
        img = { ...r, width: null, height: null };
      } else if (kind === "panel") {
        const { panel } = await ctx.invoke<{ panel: { activeArtworkAssetId: string | null } }>(
          "GET",
          `/api/panels/${id}`,
        );
        if (!panel.activeArtworkAssetId)
          throw toolError(
            404,
            "not_found",
            "This panel has no artwork yet. Generate it (generate_panel) or check get_panel.",
          );
        img = await assetImage(ctx, panel.activeArtworkAssetId, size);
      } else if (kind === "reference") {
        const [ref] = await ctx.deps.db
          .select({ assetId: referenceAssets.assetId })
          .from(referenceAssets)
          .where(eq(referenceAssets.id, id));
        if (!ref) throw toolError(404, "not_found", "Reference not found");
        img = await assetImage(ctx, ref.assetId, size);
      } else {
        await ctx.invoke("GET", `/api/assets/${id}`); // the route's own access check
        img = await assetImage(ctx, id, size);
      }
      return {
        data: {
          kind,
          id,
          assetId: img.assetId,
          mimeType: img.mimeType,
          width: img.width,
          height: img.height,
          bytes: img.data.byteLength,
        },
        content: [{ type: "image", data: Buffer.from(img.data).toString("base64"), mimeType: img.mimeType }],
      };
    },
  }),

  defineMcpTool({
    name: "manage_assets",
    title: "Asset library and trash",
    description:
      "The project's stored images and files, as the app's Assets and Trash pages show them. list: newest first (trash=true lists the trash instead; type filters, e.g. panel_art, reference, cover, audio). trash: move an asset to trash (not one that is a panel's active artwork or locked; delete class). restore: bring it back from trash. delete: PERMANENTLY delete an asset that is already in trash, with its file (not a locked reference; cannot be undone; delete class). Panel artwork versions and reference images also have their own trash actions (manage_panel_artwork, manage_references).",
    input: z.object({
      action: z.enum(["list", "trash", "restore", "delete"]),
      projectId: Uuid.optional().describe("For list."),
      assetId: Uuid.optional().describe("For trash, restore, delete."),
      trash: z.boolean().default(false).describe("list: the trash instead of live assets."),
      type: z.string().max(40).optional().describe("list: only this asset type."),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    output: Passthrough,
    scopes: ["projects:read", "projects:write"],
    scopesFor: (a) => (a.action === "list" ? ["projects:read"] : ["projects:write"]),
    sensitivity: "delete",
    idempotent: false,
    routes: [
      "GET /api/projects/:projectId/assets",
      "POST /api/assets/:id/trash",
      "POST /api/assets/:id/restore",
      "DELETE /api/assets/:id",
    ],
    actionKeys: ["asset.trash", "asset.restore", "asset.delete"],
    classify: async (a, ctx) => {
      if (a.action === "list") {
        if (!a.projectId) throw toolError(400, "bad_request", "projectId is required");
        return cls("read", "asset.list", a.projectId, "List assets");
      }
      if (!a.assetId) throw toolError(400, "bad_request", "assetId is required");
      const [row] = await ctx.deps.db
        .select({ p: assets.projectId, type: assets.type, status: assets.status, deletedAt: assets.deletedAt })
        .from(assets)
        .where(eq(assets.id, a.assetId));
      if (!row?.p) throw toolError(404, "not_found", "Asset not found");
      const target = { status: row.status, deletedAt: row.deletedAt?.toISOString() ?? null };
      if (a.action === "restore") return cls("write", "asset.restore", row.p, `Restore a ${row.type} asset from trash`);
      return a.action === "trash"
        ? cls("delete", "asset.trash", row.p, `Move a ${row.type} asset to trash`, { target })
        : cls("delete", "asset.delete", row.p, `Permanently delete a trashed ${row.type} asset and its file`, {
            target,
          });
    },
    handler: async (a, ctx) => {
      if (a.action === "list") {
        const r = await ctx.invoke<{ assets: Record<string, unknown>[]; storage: unknown }>(
          "GET",
          `/api/projects/${a.projectId}/assets`,
          { query: { trash: a.trash ? "1" : "0", type: a.type, limit: a.limit } },
        );
        return {
          data: {
            storage: r.storage,
            assets: r.assets.map(({ id, type, mimeType, width, height, byteSize, status, deletedAt, createdAt }) => ({
              id,
              type,
              mimeType,
              width,
              height,
              byteSize,
              status,
              deletedAt,
              createdAt,
            })),
          },
        };
      }
      const path = `/api/assets/${a.assetId}`;
      return {
        data:
          a.action === "delete" ? await ctx.invoke("DELETE", path) : await ctx.invoke("POST", `${path}/${a.action}`),
      };
    },
  }),
  defineMcpTool({
    name: "asset_library",
    title: "Search and file assets",
    description:
      "The asset library. search: the project's files with their tags, collections and favourite mark, filtered by q (name, type or tag), type, tag, collection, favourite, characterId / locationId / propId (its reference images and the panels it is drawn in), source (generated, uploaded, derived), model, from / to (dates); view unused (images nothing uses) or duplicates (the same file stored twice). get: one asset with where it came from (job, model, template, upload name, tool) and what uses it. similar: images that look like it, scored 0–1 (no AI). mark: set an asset's tags, collections or favourite. bulk: tag, untag, collect, uncollect, favourite, unfavourite, trash or restore many (trash may need approval).",
    input: z.object({
      action: z.enum(["search", "get", "similar", "mark", "bulk"]),
      projectId: Uuid.optional(),
      assetId: Uuid.optional(),
      filters: z
        .object({
          q: z.string().max(200).optional(),
          type: z.string().max(40).optional(),
          tag: z.string().max(60).optional(),
          collection: z.string().max(60).optional(),
          favourite: z.boolean().optional(),
          characterId: Uuid.optional(),
          locationId: Uuid.optional(),
          propId: Uuid.optional(),
          source: z.enum(["generated", "uploaded", "derived"]).optional(),
          model: z.string().max(120).optional(),
          from: z.string().max(10).optional(),
          to: z.string().max(10).optional(),
          view: z.enum(["unused", "duplicates"]).optional(),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .optional(),
      marks: z
        .object({
          tags: z.array(z.string().max(60)).max(50).optional(),
          collections: z.array(z.string().max(60)).max(50).optional(),
          favourite: z.boolean().optional(),
        })
        .optional(),
      bulk: z
        .object({
          ids: z.array(Uuid).min(1).max(500),
          action: z.enum(["tag", "untag", "collect", "uncollect", "favourite", "unfavourite", "trash", "restore"]),
          value: z.string().max(60).optional(),
        })
        .optional(),
    }),
    output: Passthrough,
    scopes: ["projects:read"],
    scopesFor: (a) => (a.action === "mark" || a.action === "bulk" ? ["projects:write"] : ["projects:read"]),
    sensitivity: "delete",
    idempotent: false,
    routes: [
      "GET /api/projects/:projectId/assets",
      "GET /api/assets/:id",
      "GET /api/assets/:id/similar",
      "PUT /api/assets/:id/marks",
      "POST /api/projects/:projectId/assets/bulk",
    ],
    actionKeys: ["asset.mark", "asset.bulk"],
    classify: async (a, ctx) => {
      let projectId = a.projectId ?? null;
      if (a.assetId) {
        const [row] = await ctx.deps.db.select({ p: assets.projectId }).from(assets).where(eq(assets.id, a.assetId));
        if (!row?.p) throw toolError(404, "not_found", "Asset not found");
        projectId = row.p;
      }
      if (!projectId) throw toolError(400, "bad_request", "projectId or assetId is required");
      if (a.action === "mark") return cls("write", "asset.mark", projectId, "File an asset");
      if (a.action === "bulk")
        return cls(
          a.bulk?.action === "trash" ? "delete" : "write",
          "asset.bulk",
          projectId,
          `${a.bulk?.action ?? "Change"} ${a.bulk?.ids.length ?? 0} assets`,
        );
      return cls("read", "asset.read", projectId, "Read the asset library");
    },
    handler: async (a, ctx) => {
      const need = (v: unknown, what: string) => {
        if (!v) throw toolError(400, "bad_request", `${what} is required for ${a.action}`);
      };
      if (a.action === "search") {
        need(a.projectId, "projectId");
        const { favourite, ...f } = a.filters ?? { limit: 50 };
        return {
          data: await ctx.invoke("GET", `/api/projects/${a.projectId}/assets`, {
            query: { ...f, ...(favourite ? { favourite: "1" } : {}) },
          }),
        };
      }
      if (a.action === "bulk") {
        need(a.projectId, "projectId");
        need(a.bulk, "bulk");
        return { data: await ctx.invoke("POST", `/api/projects/${a.projectId}/assets/bulk`, { body: a.bulk }) };
      }
      need(a.assetId, "assetId");
      if (a.action === "get") return { data: await ctx.invoke("GET", `/api/assets/${a.assetId}`) };
      if (a.action === "similar") return { data: await ctx.invoke("GET", `/api/assets/${a.assetId}/similar`) };
      need(a.marks, "marks");
      return { data: await ctx.invoke("PUT", `/api/assets/${a.assetId}/marks`, { body: a.marks }) };
    },
  }),
];
