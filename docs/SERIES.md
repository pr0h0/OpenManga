# Series and shared libraries

A **series** is a level above projects: episodes (ordinary projects) that share one **library** of cast, places,
props, style and story bible, and one channel profile. It is its owner's; each episode is shared with collaborators
like any project.

## The library

Creating a series (`POST /api/series`, the **Series** page) also creates its library: a project of its own
(`projects.series_role = 'library'`), hidden from the project list and opened from the series. Its characters,
locations, props (with versions, outfits, aliases and reference images), its style and its bible facts are edited
with the usual project pages. Its type, language, colour mode, reading direction and format are what new episodes
start with.

## Episodes follow the library

An episode keeps entities of its own that **follow** the library's (`characters`, `locations` and `props` have
`source_id`, the library entry they follow, and `synced_version_id`, the library version they copied last;
`project_styles.source_id` and `bible_facts.source_id` do the same). A **sync** (`POST /api/series/:id/sync`, one
episode or all):

- adds each library entry the episode lacks, or links an unlinked one of the same name;
- gives each linked entry whose library version moved on a new version with the library's description (and
  immutable traits, outfits by name, aliases). Its reference rows point at **the same image assets** as the
  library's, so no image is copied;
- copies the library's current style as a new style version of the episode (with its references), and the bible
  facts (without chapter bounds, which belong to the library's chapters), updating and removing them as the library
  changes.

Panels keep the versions they were drawn with until migrated, as with any new version. Entities of the episode's own
are left alone. The dashboard counts what an episode is **behind**: library entries without an up-to-date link, a
newer style, changed or removed facts. New episodes and adopted projects are synced at once.

A story analysis in an episode matches its cast by name, so a linked character is reused, not duplicated.

**Shared images.** Anyone in an episode may see the library's images it uses (the CDN allows them through any
episode of the series). While episodes use an image it cannot be trashed or deleted from the library, and when a
library project is permanently deleted, every image still referenced elsewhere is handed to a project that uses it
instead of being deleted.

## Episodes

- **Add an episode** (`POST /api/series/:id/episodes`): a new project shaped like the library, with the series'
  channel profile, numbered after the last, optionally with its story.
- **Adopt a project** (`POST /api/series/:id/adopt`): one of your projects becomes the next episode; its
  characters, places and props named like the library's become linked (and take the library's version). With
  `applyProfile` the series' channel profile is re-applied to it.
- **Split a long story** (`POST /api/series/:id/split`): cut at its chapter headings (`Chapter 3`, `CHAPTER IV:
  …`, `Part One`, `Episode 5`, `# Title`), `perEpisode` chapters each, or by size at paragraph breaks when it has
  none. Without `confirm` it previews; with it, each part becomes an episode with that part as its story (at most
  50 at a time).
- **Detach** (`POST /api/series/:id/episodes/:projectId/detach`): the project leaves the series and keeps what it
  has as its own.

## Dashboard and appearances

`GET /api/series/:id` gives each episode's status, chapters, panels drawn, spend, exports, open comments and how far
it is behind, with totals. `GET /api/series/:id/appearances?kind=character|location|prop&id=` finds every panel
showing a library entry across the episodes, by chapter.

## MCP

`list_series`, `get_series` (dashboard or appearances) and `manage_series` (create, update, add_episode, adopt,
detach, sync, split). A series spans projects, so they need a connection with access to all projects, and the
permission to create projects for anything that makes one.
