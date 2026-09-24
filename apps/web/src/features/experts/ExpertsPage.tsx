import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  Copy,
  ImagePlus,
  MessagesSquare,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { type ClipboardEvent, type DragEvent, useEffect, useRef, useState } from "react";
import { api, assetUrl, del, get, patch, post } from "../../api/client.ts";
import { useAction } from "../../api/hooks.ts";
import { AssetImage, ConfirmDialog, clsx, EmptyState, Field, Modal, Spinner, toast } from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";

type Expert = {
  key?: string;
  id?: string;
  name: string;
  description: string;
  systemPrompt: string;
  starters: string[];
  image?: { byDefault: boolean; aspectRatio: number };
};
type ChatRow = {
  id: string;
  title: string;
  expert: string;
  projectId: string | null;
  projectTitle?: string | null;
  systemPrompt: string;
  updatedAt: string;
};
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "done" | "pending" | "awaiting_input" | "failed";
  error: string | null;
  attachments: string[];
  images: string[];
  options: { generateImage?: boolean; aspectRatio?: number; imagePrompt?: string; imageError?: string };
  prompt: string | null;
  model: string | null;
  createdAt: string;
};
type ChatDetail = { chat: ChatRow; project: { id: string; title: string } | null; messages: Message[] };

const keys = {
  experts: ["experts"] as const,
  chats: ["expert-chats"] as const,
  chat: (id: string) => ["expert-chat", id] as const,
};

const ASPECTS: [string, number][] = [
  ["Square 1:1", 1],
  ["Wide 16:9", 16 / 9],
  ["Tall 9:16", 9 / 16],
  ["Landscape 3:2", 3 / 2],
  ["Portrait 2:3", 2 / 3],
];

const idOf = (e: Expert) => e.key ?? e.id ?? "";
/** Same marker as EXPERT_IMAGE_MARKER in @openmanga/prompts, which the web does not import. */
const IMAGE_MARKER = "IMAGE PROMPT:";

function useExperts() {
  return useQuery({
    queryKey: keys.experts,
    queryFn: () => get<{ builtin: Expert[]; custom: Expert[] }>("/experts"),
  });
}

function useProjects() {
  return useQuery({
    queryKey: ["projects", "active"],
    queryFn: () => get<{ projects: { id: string; title: string }[] }>("/projects?status=active"),
    select: (r) => r.projects,
  });
}

/** Uploads an image to a chat, for a message or for a pasted answer. */
async function upload(chatId: string, file: File) {
  const f = new FormData();
  f.set("file", file);
  const r = await api<{ asset: { id: string } }>(`/expert-chats/${chatId}/attachments`, { method: "POST", body: f });
  return r.asset.id;
}

const imagesIn = (files: FileList | File[] | null | undefined) =>
  [...(files ?? [])].filter((f) => f.type.startsWith("image/"));

/**
 * Experts: chats with brainstorming specialists, outside any chapter. Each expert is a system prompt; a chat keeps
 * its own copy, can be about a project, can take images, and can answer with a generated one.
 */
export function ExpertsPage() {
  const { chatId } = useParams({ strict: false }) as { chatId?: string };
  return (
    <div className="flex h-full min-h-0">
      <ChatList activeId={chatId ?? null} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        {chatId ? <ChatView key={chatId} chatId={chatId} /> : <ExpertGallery />}
      </main>
    </div>
  );
}

/** The chats, beside the page on a wide screen; on a phone, listed on the gallery page itself. */
function ChatList({ activeId, inline }: { activeId: string | null; inline?: boolean }) {
  const chats = useQuery({ queryKey: keys.chats, queryFn: () => get<{ chats: ChatRow[] }>("/expert-chats") });
  const [q, setQ] = useState("");
  const shown = (chats.data?.chats ?? []).filter(
    (c) => !q.trim() || `${c.title} ${c.projectTitle ?? ""}`.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <aside
      className={
        inline
          ? "card flex flex-col md:hidden"
          : "hidden w-72 shrink-0 flex-col border-r border-[var(--border)] md:flex"
      }
    >
      <div className="space-y-2 p-3">
        <Link to="/experts" className="btn-primary w-full justify-center">
          <Plus className="size-4" /> New chat
        </Link>
        <input
          className="input text-sm"
          placeholder="Search chats"
          aria-label="Search chats"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Chats">
        {chats.isLoading && <Spinner className="m-3" />}
        {shown.map((c) => (
          <Link
            key={c.id}
            to="/experts/$chatId"
            params={{ chatId: c.id }}
            className={clsx(
              "block rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--panel-2)]",
              c.id === activeId && "bg-[var(--panel-2)] font-medium",
            )}
          >
            <div className="truncate">{c.title}</div>
            {c.projectTitle && <div className="muted truncate text-xs">{c.projectTitle}</div>}
          </Link>
        ))}
        {!chats.isLoading && !shown.length && <p className="muted px-2 text-xs">No chats yet.</p>}
      </nav>
    </aside>
  );
}

function ExpertGallery() {
  const experts = useExperts();
  const projects = useProjects();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const [editing, setEditing] = useState<Expert | "new" | null>(null);
  const [removing, setRemoving] = useState<Expert | null>(null);
  const start = useAction(
    (expert: string) => post<{ chat: ChatRow }>("/expert-chats", { expert, projectId: projectId || null }),
    {
      invalidate: [keys.chats],
      onSuccess: (r) => navigate({ to: "/experts/$chatId", params: { chatId: r.chat.id } }),
    },
  );
  const remove = useAction((id: string) => del(`/experts/${id}`), {
    invalidate: [keys.experts],
    success: "Expert deleted",
    onSuccess: () => setRemoving(null),
  });
  const card = (e: Expert, custom: boolean) => (
    <li key={idOf(e)} className="card flex flex-col gap-2 p-4">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-4 shrink-0 text-accent-500" />
        <div className="min-w-0 flex-1">
          <h3 className="font-medium">{e.name}</h3>
          <p className="muted text-sm">{e.description || "Your own expert."}</p>
        </div>
      </div>
      <div className="mt-auto flex gap-1">
        <button
          type="button"
          className="btn-primary flex-1 justify-center"
          disabled={start.isPending}
          onClick={() => start.mutate(idOf(e))}
        >
          Start chat
        </button>
        <button
          type="button"
          className="btn-ghost px-2"
          title={custom ? "Edit" : "Make your own version of this expert"}
          aria-label={custom ? `Edit ${e.name}` : `Customize ${e.name}`}
          onClick={() => setEditing(custom ? e : { ...e, key: undefined, name: `My ${e.name}` })}
        >
          <Pencil className="size-4" />
        </button>
        {custom && (
          <button
            type="button"
            className="btn-ghost px-2 text-red-500"
            aria-label={`Delete ${e.name}`}
            onClick={() => setRemoving(e)}
          >
            <Trash2 className="size-4" />
          </button>
        )}
      </div>
    </li>
  );
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto">
          <h1 className="text-xl font-semibold tracking-tight">Experts</h1>
          <p className="muted text-sm">
            Brainstorm and develop with a specialist. Chats are kept, so you can come back to any of them.
          </p>
        </div>
        <Field label="Talk about a project">
          <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">No project</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <ChatList activeId={null} inline />
      {experts.isLoading && <Spinner />}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {experts.data?.builtin.map((e) => card(e, false))}
        {experts.data?.custom.map((e) => card(e, true))}
        <li>
          <button
            type="button"
            className="card flex h-full w-full flex-col items-center justify-center gap-2 border-dashed p-4 text-sm hover:bg-[var(--panel-2)]"
            onClick={() => setEditing("new")}
          >
            <Plus className="size-5" /> Write your own expert
          </button>
        </li>
      </ul>
      {editing && (
        <ExpertEditor
          expert={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: keys.experts });
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        title={`Delete ${removing?.name ?? "expert"}?`}
        confirmLabel="Delete"
        danger
        busy={remove.isPending}
        onConfirm={() => removing?.id && remove.mutate(removing.id)}
        onClose={() => setRemoving(null)}
      >
        Chats with it keep their own copy of its prompt.
      </ConfirmDialog>
    </div>
  );
}

function ExpertEditor({
  expert,
  onClose,
  onSaved,
}: {
  expert: Expert | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(expert?.name ?? "");
  const [description, setDescription] = useState(expert?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(expert?.systemPrompt ?? "");
  const [starters, setStarters] = useState((expert?.starters ?? []).join("\n"));
  const save = useAction(
    () => {
      const body = {
        name: name.trim(),
        description,
        systemPrompt,
        starters: starters
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 8),
      };
      return expert?.id ? patch(`/experts/${expert.id}`, body) : post("/experts", body);
    },
    { success: "Expert saved", onSuccess: onSaved },
  );
  return (
    <Modal
      open
      onClose={onClose}
      title={expert?.id ? `Edit ${expert.name}` : "Your own expert"}
      wide
      footer={
        <button
          type="button"
          className="btn-primary"
          disabled={!name.trim() || !systemPrompt.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </button>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="What it is for">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field
          label="System prompt"
          hint="Who the expert is and how it answers. Sent before every chat with it; a chat can adjust its own copy."
        >
          <textarea
            className="input min-h-56 font-mono text-xs"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </Field>
        <Field label="Openers" hint="One per line: suggestions shown on a new chat.">
          <textarea className="input min-h-20 text-sm" value={starters} onChange={(e) => setStarters(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function ChatView({ chatId }: { chatId: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: keys.chat(chatId),
    queryFn: () => get<ChatDetail>(`/expert-chats/${chatId}`),
    // Replies are written in the background: look again until the last one is in.
    refetchInterval: (q) => (q.state.data?.messages.at(-1)?.status === "pending" ? 1500 : false),
  });
  const experts = useExperts();
  const projects = useProjects();
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inv = [keys.chat(chatId), keys.chats];
  const update = useAction((b: Record<string, unknown>) => patch(`/expert-chats/${chatId}`, b), { invalidate: inv });
  const remove = useAction(() => del(`/expert-chats/${chatId}`), {
    invalidate: [keys.chats],
    onSuccess: () => navigate({ to: "/experts" }),
  });
  const bottom = useRef<HTMLDivElement>(null);
  const count = detail.data?.messages.length ?? 0;
  const lastStatus = detail.data?.messages.at(-1)?.status;
  const live = useLiveReply(chatId, lastStatus === "pending");
  useEffect(() => {
    if (count) bottom.current?.scrollIntoView({ block: "end" });
  }, [count, lastStatus, live?.content.length]);
  if (detail.isLoading) return <Spinner className="m-6" />;
  if (!detail.data) return <EmptyState title="Chat not found" />;
  const { chat, project, messages } = detail.data;
  const all = [...(experts.data?.builtin ?? []), ...(experts.data?.custom ?? [])];
  const expert = all.find((e) => idOf(e) === chat.expert);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2">
        <Link to="/experts" className="btn-ghost p-1.5 md:hidden" aria-label="All chats">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <input
            key={chat.title}
            className="w-full truncate bg-transparent font-semibold outline-none focus:underline"
            defaultValue={chat.title}
            aria-label="Chat title"
            onBlur={(e) =>
              e.target.value.trim() && e.target.value !== chat.title && update.mutate({ title: e.target.value.trim() })
            }
          />
          <div className="muted text-xs">{expert?.name ?? "Expert (deleted)"}</div>
        </div>
        <select
          className="input w-auto py-1 text-xs"
          aria-label="Project this chat is about"
          value={project?.id ?? ""}
          onChange={(e) => update.mutate({ projectId: e.target.value || null })}
        >
          <option value="">No project</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <button type="button" className="btn-ghost p-1.5" title="System prompt" onClick={() => setEditingPrompt(true)}>
          <Settings2 className="size-4" />
        </button>
        <button
          type="button"
          className="btn-ghost p-1.5 text-red-500"
          aria-label="Delete chat"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-3xl space-y-4">
          {!messages.length && (
            <EmptyState
              icon={<MessagesSquare className="size-8" />}
              title={`Chat with ${expert?.name ?? "the expert"}`}
            >
              {expert?.description}
              {project && (
                <>
                  {" "}
                  Talking about <strong>{project.title}</strong>.
                </>
              )}
            </EmptyState>
          )}
          {messages.map((m, i) => (
            <MessageItem
              key={m.id}
              chatId={chatId}
              // The live text is newer than the saved copy the page polls, until the reply is complete.
              message={
                m.status === "pending" && live?.messageId === m.id && live.content.length > m.content.length
                  ? { ...m, content: live.content }
                  : m
              }
              last={i === messages.length - 1}
            />
          ))}
          <div ref={bottom} />
        </div>
      </div>
      <Composer
        chatId={chatId}
        busy={lastStatus === "pending" || lastStatus === "awaiting_input"}
        starters={messages.length ? [] : (expert?.starters ?? [])}
        imageDefault={expert?.image}
        onSent={() => qc.invalidateQueries({ queryKey: keys.chat(chatId) })}
      />
      {editingPrompt && (
        <PromptEditor
          value={chat.systemPrompt}
          onClose={() => setEditingPrompt(false)}
          onSave={(systemPrompt) => {
            update.mutate({ systemPrompt });
            setEditingPrompt(false);
          }}
        />
      )}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this chat?"
        confirmLabel="Delete"
        danger
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onClose={() => setConfirmDelete(false)}
      >
        Its messages go with it. Images it made stay in your library.
      </ConfirmDialog>
    </div>
  );
}

/** The reply being written, as it arrives, while one is. Providers that do not stream simply send nothing. */
function useLiveReply(chatId: string, pending: boolean) {
  const [live, setLive] = useState<{ messageId: string; content: string } | null>(null);
  useEffect(() => {
    if (!pending) {
      setLive(null);
      return;
    }
    const es = new EventSource(`/api/expert-chats/${chatId}/stream`, { withCredentials: true });
    es.addEventListener("message", (e) => {
      try {
        setLive(JSON.parse((e as MessageEvent<string>).data) as { messageId: string; content: string });
      } catch {}
    });
    return () => es.close();
  }, [chatId, pending]);
  return live;
}

function PromptEditor({ value, onClose, onSave }: { value: string; onClose: () => void; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  return (
    <Modal
      open
      onClose={onClose}
      title="This chat's system prompt"
      wide
      footer={
        <button type="button" className="btn-primary" disabled={!text.trim()} onClick={() => onSave(text.trim())}>
          Save
        </button>
      }
    >
      <p className="muted mb-2 text-xs">
        Who the expert is in this chat. Changing it here changes this chat only, from its next reply.
      </p>
      <textarea className="input min-h-72 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  );
}

function MessageItem({ chatId, message: m, last }: { chatId: string; message: Message; last: boolean }) {
  const qc = useQueryClient();
  const aiText = useAiBody("text");
  const aiImage = useAiBody("image");
  const retry = useAction(() => post(`/expert-chats/${chatId}/retry`, { ...aiText(), imageAi: aiImage().ai }), {
    invalidate: [keys.chat(chatId)],
  });
  const mine = m.role === "user";
  // While a reply is still arriving, its image prompt line is not part of the answer: it is drawn, then shown apart.
  const shown = m.status === "pending" ? m.content.split(IMAGE_MARKER)[0]!.trimEnd() : m.content;
  const copy = () =>
    navigator.clipboard.writeText(m.content).then(
      () => toast.success("Copied"),
      () => toast.error("Could not copy"),
    );
  return (
    <div className={clsx("flex", mine ? "justify-end" : "justify-start")}>
      <div
        className={clsx(
          "max-w-[90%] rounded-2xl px-4 py-2.5 text-sm",
          mine ? "bg-accent-600/15" : "border border-[var(--border)] bg-[var(--panel)]",
        )}
      >
        {m.attachments.length > 0 && <ImageRow ids={m.attachments} />}
        {shown && <div className="whitespace-pre-wrap break-words leading-relaxed">{shown}</div>}
        {m.status === "pending" && (
          <div className="muted flex items-center gap-2 text-xs">
            <Spinner />{" "}
            {!m.content ? "Thinking…" : m.options.generateImage ? "Writing, then drawing the image…" : "Writing…"}
          </div>
        )}
        {m.images.length > 0 && <ImageRow ids={m.images} large />}
        {m.options.imagePrompt && (
          <details className="mt-1 text-xs">
            <summary className="muted cursor-pointer">Image prompt</summary>
            <p className="mt-1 whitespace-pre-wrap">{m.options.imagePrompt}</p>
          </details>
        )}
        {m.options.imageError && <p className="mt-1 text-xs text-amber-600">No image: {m.options.imageError}</p>}
        {m.status === "failed" && <p className="text-xs text-red-500">{m.error ?? "The reply failed."}</p>}
        {m.status === "awaiting_input" && (
          <ManualAnswer
            chatId={chatId}
            message={m}
            onDone={() => qc.invalidateQueries({ queryKey: keys.chat(chatId) })}
          />
        )}
        {!mine && m.status !== "pending" && m.status !== "awaiting_input" && (
          <div className="muted mt-1 flex items-center gap-1 text-[11px]">
            {m.model && m.model !== "manual" && <span className="mr-auto truncate">{m.model}</span>}
            {m.content && (
              <button type="button" className="btn-ghost px-1 py-0" onClick={copy} aria-label="Copy reply">
                <Copy className="size-3" />
              </button>
            )}
            {last && (
              <button
                type="button"
                className="btn-ghost px-1 py-0"
                disabled={retry.isPending}
                onClick={() => retry.mutate()}
                title="Write this reply again"
              >
                <RotateCcw className="size-3" /> {m.status === "failed" ? "Retry" : "Again"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ImageRow({ ids, large }: { ids: string[]; large?: boolean }) {
  return (
    <div className="my-1.5 flex flex-wrap gap-1.5">
      {ids.map((id) => (
        <a key={id} href={assetUrl(id)} target="_blank" rel="noreferrer" title="Open full size">
          <AssetImage
            assetId={id}
            variant={large ? "preview" : "thumbnail"}
            alt=""
            fit="contain"
            className={clsx("rounded-lg", large ? "max-h-96 w-auto max-w-full" : "size-20")}
          />
        </a>
      ))}
    </div>
  );
}

/** No key: copy the conversation into any chat, paste its answer back, and upload the image it made if any. */
function ManualAnswer({ chatId, message: m, onDone }: { chatId: string; message: Message; onDone: () => void }) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const aiImage = useAiBody("image");
  const answer = useAction(
    () => post(`/expert-messages/${m.id}/answer`, { text, images, imageAi: images.length ? null : aiImage().ai }),
    { onSuccess: onDone },
  );
  const add = async (files: FileList | null) => {
    try {
      for (const f of imagesIn(files)) {
        const id = await upload(chatId, f);
        setImages((x) => [...x, id]);
      }
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="mt-1 space-y-2 text-xs">
      <p className="font-medium">Waiting for an answer pasted from any chat</p>
      <button
        type="button"
        className="btn-secondary text-xs"
        onClick={() =>
          navigator.clipboard.writeText(m.prompt ?? "").then(
            () => toast.success("Conversation copied"),
            () => toast.error("Could not copy"),
          )
        }
      >
        <Copy className="size-3.5" /> Copy the conversation
      </button>
      <textarea
        className="input min-h-28 text-sm"
        placeholder="Paste the answer here"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {images.length > 0 && <ImageRow ids={images} />}
      <div className="flex flex-wrap items-center gap-1">
        <label className="btn-ghost cursor-pointer text-xs">
          <ImagePlus className="size-3.5" /> Add the image it made
          <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => add(e.target.files)} />
        </label>
        <button
          type="button"
          className="btn-primary ml-auto text-xs"
          disabled={(!text.trim() && !images.length) || answer.isPending}
          onClick={() => answer.mutate()}
        >
          Use this answer
        </button>
      </div>
    </div>
  );
}

function Composer({
  chatId,
  busy,
  starters,
  imageDefault,
  onSent,
}: {
  chatId: string;
  busy: boolean;
  starters: string[];
  imageDefault?: { byDefault: boolean; aspectRatio: number };
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  const [generateImage, setGenerateImage] = useState(imageDefault?.byDefault ?? false);
  const [aspectRatio, setAspectRatio] = useState(imageDefault?.aspectRatio ?? 1);
  const [dragging, setDragging] = useState(false);
  // The expert list may load after the chat: take its image defaults when they arrive.
  useEffect(() => {
    if (imageDefault) {
      setGenerateImage(imageDefault.byDefault);
      setAspectRatio(imageDefault.aspectRatio);
    }
  }, [imageDefault?.byDefault, imageDefault?.aspectRatio]);
  const aiText = useAiBody("text");
  const aiImage = useAiBody("image");
  const send = useAction(
    () =>
      post(`/expert-chats/${chatId}/messages`, {
        text,
        attachments,
        generateImage,
        aspectRatio,
        ...aiText(),
        imageAi: generateImage ? aiImage().ai : null,
      }),
    {
      invalidate: [keys.chats],
      onSuccess: () => {
        setText("");
        setAttachments([]);
        onSent();
      },
    },
  );
  const add = async (files: FileList | File[] | null) => {
    const list = imagesIn(files);
    if (!list.length) return;
    setUploading((n) => n + list.length);
    for (const f of list) {
      try {
        const id = await upload(chatId, f);
        setAttachments((a) => [...a, id]);
      } catch (e) {
        toast.error(e);
      }
      setUploading((n) => n - 1);
    }
  };
  const canSend = !busy && !uploading && !send.isPending && (text.trim() || attachments.length);
  return (
    <div
      className={clsx("border-t border-[var(--border)] p-3", dragging && "bg-accent-600/10")}
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setDragging(false);
        add(e.dataTransfer.files);
      }}
    >
      <div className="mx-auto max-w-3xl space-y-2">
        {starters.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {starters.map((s) => (
              <button
                key={s}
                type="button"
                className="chip border border-[var(--border)] text-left text-xs"
                onClick={() => setText(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {(attachments.length > 0 || uploading > 0) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {attachments.map((id) => (
              <div key={id} className="relative">
                <AssetImage assetId={id} alt="" className="size-14 rounded-lg" />
                <button
                  type="button"
                  className="absolute -right-1 -top-1 rounded-full bg-[var(--panel)] p-0.5 shadow"
                  aria-label="Remove image"
                  onClick={() => setAttachments((a) => a.filter((x) => x !== id))}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            {uploading > 0 && <Spinner />}
          </div>
        )}
        <textarea
          className="input min-h-20 text-sm"
          placeholder={busy ? "The expert is answering…" : "Message the expert — drop or paste images here"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e: ClipboardEvent) => {
            const files = imagesIn(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              add(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && canSend) {
              e.preventDefault();
              send.mutate();
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="btn-ghost cursor-pointer text-xs" title="Attach images">
            <ImagePlus className="size-4" /> Image
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                add(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={generateImage} onChange={(e) => setGenerateImage(e.target.checked)} />
            Generate image
          </label>
          {generateImage && (
            <>
              <select
                className="input w-auto py-0.5 text-xs"
                aria-label="Image shape"
                value={aspectRatio}
                onChange={(e) => setAspectRatio(Number(e.target.value))}
              >
                {ASPECTS.map(([label, v]) => (
                  <option key={label} value={v}>
                    {label}
                  </option>
                ))}
              </select>
              <span className="muted">Image model</span>
              <AiChip cap="image" />
            </>
          )}
          <span className="muted ml-auto">Text model</span>
          <AiChip cap="text" />
          <button type="button" className="btn-primary" disabled={!canSend} onClick={() => send.mutate()}>
            <Send className="size-4" /> Send
          </button>
        </div>
      </div>
    </div>
  );
}
