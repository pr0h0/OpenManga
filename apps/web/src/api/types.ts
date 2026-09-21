import type {
  AiUsageRow,
  AssetRow,
  AssetVariantRow,
  AudioAssetRow,
  ChapterRow,
  CharacterOutfitRow,
  CharacterRow,
  CharacterVersionRow,
  DevEmailRow,
  DialogueLineRow,
  ExportJobRow,
  ExportRow,
  GenerationInputRow,
  GenerationJobRow,
  GenerationOutputRow,
  LocationRow,
  LocationVersionRow,
  NarrationLineRow,
  NarrationSegmentRow,
  PageRow,
  PanelRow,
  ProjectRow,
  ProjectStyleRow,
  PropRow,
  PropVersionRow,
  ReferenceAssetRow,
  SceneRow,
  SoundEffectRow,
  StoryAnalysisRow,
  StoryBeatRow,
  StoryRevisionRow,
  StylePresetRow,
  UserRow,
} from "@openmanga/db/types";
import type { LayoutTemplate } from "@openmanga/domain/browser";
import type { PanelSpec } from "@openmanga/schemas";

export type * from "@openmanga/db/types";

export type SessionUser = Pick<UserRow, "id" | "username" | "email" | "displayName" | "role" | "status" | "settings">;

export type ProjectListItem = ProjectRow & {
  stats: { chapters: number; panels: number; generations: number; estimatedSpendUsd: number };
  thumbnailAssetId: string | null;
};

export type ProjectOverview = {
  project: ProjectRow;
  role: "owner" | "editor" | "viewer" | "admin" | null;
  counts: Record<string, number>;
  style: (ProjectStyleRow & { preset: StylePresetRow | null }) | null;
};

export type Reference = ReferenceAssetRow & {
  asset: Pick<
    AssetRow,
    "id" | "width" | "height" | "mimeType" | "byteSize" | "sha256" | "createdAt" | "generationJobId" | "metadata"
  >;
  promptDerivatives: Pick<AssetVariantRow, "id" | "width" | "height" | "byteSize" | "mimeType" | "params">[];
  /** Made from an older description of its version. */
  stale: boolean;
};

export type ContentWarning = { field: string; term: string; match: string; suggestion: string; excerpt: string };

export type CastCard = CharacterRow & {
  currentVersion: CharacterVersionRow | null;
  versionCount: number;
  portraitAssetId: string | null;
  referenceStatus: "none" | "draft" | "approved" | "locked";
  referenceCount: number;
  staleReferences: number;
  contentWarnings: number;
  appearances: number;
  aliases: { id: string; alias: string }[];
};

export type CharacterDetail = {
  character: CharacterRow;
  versions: (CharacterVersionRow & { panelCount: number; contentWarnings: ContentWarning[] })[];
  aliases: { id: string; alias: string; characterId: string }[];
  outfits: CharacterOutfitRow[];
  references: Reference[];
};

export type WorldCard<E, V> = E & {
  currentVersion: V | null;
  previewAssetId: string | null;
  referenceStatus: string;
  appearances: number;
};
export type LocationCard = WorldCard<LocationRow, LocationVersionRow>;
export type PropCard = WorldCard<PropRow, PropVersionRow>;

export type ChapterListItem = Omit<ChapterRow, "lastPlan" | "sourceExcerpt"> & {
  hasPlan: boolean;
  sourceLength: number;
  stats?: { scenes: number; pages: number; panels: number; ready: number; narration: number; narratedPanels: number };
};
/** Just the panel fields the page thumbnail draws; the editor loads the full document separately. */
export type PageThumbPanel = Pick<
  PanelRow,
  "id" | "pageId" | "frame" | "status" | "activeArtworkAssetId" | "review" | "qa"
>;
export type ChapterDetailPage = PageRow & { panelCount: number; readyCount: number; panels: PageThumbPanel[] };
export type ChapterDetail = {
  chapter: ChapterRow;
  scenes: (SceneRow & { beats: StoryBeatRow[] })[];
  pages: ChapterDetailPage[];
};

export type EditorPanel = PanelRow & {
  spec: PanelSpec | null;
  specVersion: number;
  artwork: { id: string; width: number | null; height: number | null } | null;
  latestJob: { id: string; status: string; kind: string; failureReason: string | null } | null;
};
export type PageDocument = {
  page: PageRow;
  chapter: { id: string; title: string; order: number };
  siblings: { id: string; order: number }[];
  readingDirection: "ltr" | "rtl" | "vertical";
  panels: EditorPanel[];
  dialogue: DialogueLineRow[];
  sfx: SoundEffectRow[];
  narration: NarrationLineRow[];
  cast: { id: string; name: string; currentVersionId: string | null }[];
};

export type PromptPreview = {
  template: { name: string; version: number };
  compiledPrompt: string;
  generatedPrompt: string;
  usesOverride: boolean;
  aspectRatio: number;
  references: {
    index: number;
    role: string;
    label: string;
    assetId: string;
    canonicalWidth: number | null;
    canonicalHeight: number | null;
    subjectVersionId: string | null;
  }[];
  characters: { name: string; versionNumber: number; hasReference: boolean }[];
  provider: string;
  model: string;
  quality: string;
};

export type ArtworkVersion = {
  versionNumber: number;
  assetId: string;
  width: number | null;
  height: number | null;
  parentAssetId: string | null;
  createdAt: string;
  status: string;
  generationJobId: string | null;
  kind: string | null;
  operation: string | null;
  cancelled: boolean;
};

export type JobListItem = Omit<GenerationJobRow, "compiledPrompt" | "input"> & {
  costUsd: number;
  outputAssetId: string | null;
};
export type JobDetail = {
  job: GenerationJobRow;
  inputs: (GenerationInputRow & {
    variant: AssetVariantRow | null;
    sentAs: "prompt_ref_derivative" | "full_resolution";
  })[];
  outputs: GenerationOutputRow[];
  usage: AiUsageRow[];
  retries: { id: string; status: string; createdAt: string }[];
  totals: {
    costUsd: number;
    textInputTokens: number;
    textOutputTokens: number;
    imageInputTokens: number;
    imageOutputTokens: number;
  };
};

export type NarrationSegment = NarrationSegmentRow & {
  audio: AudioAssetRow | null;
  stale: boolean;
  job: { id: string; status: string; failureReason: string | null; failureCode: string | null } | null;
};
export type NarrationDoc = {
  chapter: { id: string; title: string };
  language?: string;
  tracks?: { language: string; lines: number }[];
  defaults: { voice: string; speed: number };
  lines: (NarrationLineRow & { segments: NarrationSegment[] })[];
};
export type Voice = { id: string; name: string; language: string; gender?: string };
export type TtsStatus = {
  enabled: boolean;
  provider?: string;
  status: { ok: boolean; state: string; detail?: string };
  voices: Voice[];
};

export type ExportListItem = ExportJobRow & {
  /** Null for project-wide exports; set for anything scoped to one chapter. */
  chapter: { id: string; title: string; order: number } | null;
  files: (ExportRow & { byteSize: number; mimeType: string })[];
};

export type UsageSummary = {
  windows: Record<"today" | "7d" | "30d" | "lifetime", { costUsd: number; calls: number }>;
  unpricedCalls: number;
  breakdown: {
    byProvider: Record<string, number>;
    imagesUsd: number;
    textUsd: number;
    mockUsd: number;
    kokoroLocalUsd: number;
  };
  providers: {
    provider: string;
    model: string;
    cost: number;
    calls: number;
    text_in: number;
    text_out: number;
    image_in: number;
    image_out: number;
    cached: number;
    images: number;
    unpriced: number;
  }[];
  operations: {
    operation: string;
    label: string;
    cost: number;
    calls: number;
    avg_latency: number;
    failures: number;
  }[];
  daily: { day: string; provider: string; cost: number }[];
  referenceExperiments: {
    ref_size: string;
    generations: number;
    avg_image_input_tokens: number;
    avg_cost: number;
    avg_latency: number;
  }[];
  quality: {
    generatedPanels: number;
    regeneratedPanels: number;
    approvedPanels: number;
    regenerationRate: number;
    acceptanceRate: number;
  };
};

export type Meta = {
  layouts: LayoutTemplate[];
  /** Only the server's own runnable providers: local TTS, and the fakes in mock mode. Null under BYOK. */
  providers: {
    image: { provider: string; model: string; quality: string } | null;
    text: { provider: string; model: string } | null;
    tts: { provider: string } | null;
  };
  mockMode: boolean;
  ttsEnabled: boolean;
  referenceDefaults: { maxWidth: number; maxHeight: number; fit: string };
};

export type StoryState = {
  revisions: (Pick<
    StoryRevisionRow,
    | "id"
    | "revisionNumber"
    | "source"
    | "inputKind"
    | "title"
    | "lockedAt"
    | "createdAt"
    | "updatedAt"
    | "contentSha256"
  > & { length: number })[];
  latest: StoryRevisionRow | null;
  analyses: StoryAnalysisRow[];
};

export type { AssetRow, DevEmailRow };
