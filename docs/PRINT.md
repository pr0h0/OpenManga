# Print workflow

How a project becomes a printed book: the interior PDF, the wraparound cover, and the preflight that checks the
interior before it goes to a printer. Everything here is a deterministic composition like any other export (no AI
calls, nothing spent), queued through `POST /api/projects/:projectId/exports`. The numbers follow Amazon KDP's
paperback specification, the usual reference for print-on-demand; the cover takes a custom paper thickness for other
printers. The geometry lives in `packages/domain/src/print.ts`, so the API's checks and the worker's render use one
layout.

## Interior PDF (`pdf`)

On top of the page size, margin, bleed, DPI and reading direction (`docs/DEPLOYMENT.md`), the `pdf` options take:

| Option | Default | What it does |
| --- | --- | --- |
| `pdf.toc` | `false` | A contents page after the cover (if the PDF has one): every chapter in the scope with the PDF page it starts on. Drawn as an image at the interior page's size, with wide margins so a full-bleed trim never cuts it. |
| `pdf.rectoChapters` | `false` | Every chapter opens on a recto (a right-hand, odd page): a blank page goes before any chapter that would open on a verso. Blank pages are real PDF pages with the book's trim and bleed boxes and no content. |
| `pdf.metadata` | see below | Book metadata in the PDF's document information: `title` (default: the export's title), `author` (the project's author), `subject` (the project description), `keywords` (a list, written comma-separated), `language` (the project language, written as the catalog's `/Lang`). |

A KDP interior has no cover page (the cover is its own file); other page sizes keep the project cover as page 1, and
it counts as a page for recto and contents numbering. Pages are numbered as PDF pages, 1-based: odd pages are rectos.
In a KDP book the trim box sits on the outside edge (the right of a recto, the left of a verso).

## Cover (`print_cover`)

One PDF page: back, spine and front side by side, with 0.125" bleed on every outside edge and the trim box set. It
needs the project cover art (Overview → Generate cover) and a print size: `pdf.pageSize` is any
size but `source` (the UI starts at KDP 6" × 9"). `pdf.dpi` sets the render resolution (300 for print).

- **Spine width**: the page count times the paper's thickness per page: `print.paper` `white` 0.002252", `cream`
  0.0025", `color` 0.002347" (KDP's figures), or `print.paperThicknessMm` for another printer. The page count is
  `print.pageCount`, or else the interior's, counted the way the PDF prints it with the same `pdf.toc` and
  `pdf.rectoChapters` (without a cover page).
- **Front**: the cover art filling the front and its bleed (centre crop), the title near the top and the author near
  the bottom, both inside the safe area (0.125" inside the trim). The title shrinks to fit three lines, down to 14 pt.
- **Spine**: the title, with the author when it fits, reading top to bottom, 0.0625" clear of each fold. KDP prints no
  spine text under 79 pages, so a thinner book gets a plain spine.
- **Back**: a dark wash of the cover art, and the project description at 11 pt (down to 8 pt to fit) above the barcode
  area: 2" × 1.2", 0.25" from the spine fold and the bottom trim, left clear for the printer's barcode.
- **Right-to-left books** (the project's or `pdf.readingDirection` `rtl`) are bound on the right, so the flat cover is
  mirrored: front on the left, back on the right, barcode next to the spine.

### Checks before rendering

`GET /api/projects/:projectId/print/cover?pageSize=&paper=&pageCount=&paperThicknessMm=&chapterId=&toc=&rectoChapters=`
returns the page count, the layout (sizes, panels, safe areas, barcode box, text blocks) and its issues, reading no
image. The Exports page shows it live as the options change. Issues:

| Code | Severity | When |
| --- | --- | --- |
| `no_cover_art` | block | The project has no cover art. The export is refused (400). |
| `art_low_dpi` | warn | The art gives under 300 DPI across the front with bleed; the message says the pixel size needed. |
| `spine_no_text` | info | Under 79 pages: plain spine. |
| `spine_text_small` | warn | The spine is so thin its text would be under 5 pt: plain spine. |
| `spine_text_cut`, `title_cut`, `back_text_cut` | warn | Text did not fit at its smallest size and was shortened with "…". |
| `page_count_low`, `page_count_high` | warn | Outside KDP's 24 to 828 pages (776 on cream). |
| `text_outside_safe` | warn | Found after rendering: the drawn text is measured pixel by pixel against the safe areas, since the layout's glyph widths are estimates. |

The finished job's `result.cover` holds the sizes and every issue. Files: `<title>_<scope>_cover.pdf`, and
`<title>_<scope>_cover_guides.png`, a 1600 px preview with the trim and folds (cyan), safe areas (magenta, dashed) and
the barcode box drawn on, which the Exports page shows.

## Preflight (`print_preflight`)

Renders the interior exactly as the PDF export would with the same `pdf` options (contents page, blank versos, page
size, scale) and measures every page, without writing a PDF. The report is the job's `result.preflight` and the file
`<title>_<scope>_preflight.json`; the Exports page shows its summary, issues, fonts and a table of every page.

| Per page | How it is measured |
| --- | --- |
| `imageDpi` | The page image's pixels across its printed width. |
| `artDpi` | The lowest of any panel's art: the source pixels its crop keeps (focal point and zoom applied) across the panel's printed width. Panels are upscaled into their frames, so this is the number that shows softness. |
| `inkPct` | Total ink (C+M+Y+K) of the darkest 0.5 mm area, through the CMYK profile below. A greyscale or black-and-white project prints with black ink only, so its ink is the grey level (at most 100%). |
| `shiftPct` | The mean colour change of the soft proof against the page, 0–100. The page that shifts most is preselected in the proof viewer. |
| `textOutsideSafe` | Bubbles, captions and SFX (their boxes) outside the safe area: 0.25" inside the trim on a KDP size, with KDP's gutter on the binding side (0.375" up to 150 pages, then 0.5", 0.625", 0.75", 0.875" past 700); 5 mm on other sizes. |

Report-level issues: `low_dpi` (under 300 DPI), `ink_over_limit` (over 300% total ink), `text_outside_safe`,
`page_count_low` (a KDP size under 24 pages), `odd_page_count` (info: a printed book adds a blank last page),
`font_missing` (a lettering font the render server does not have, so a fallback drew it), and `fonts_rasterized`
(info). The font report lists every font the lettering uses, how often, and whether fontconfig on the render server
has it. Fonts are never embedded because none are needed: the PDF holds page images, with the lettering drawn into
the pixels at the page's resolution, so printers' "fonts not embedded" checks pass.

### Soft proof

`GET /api/pages/:id/render.png?proof=cmyk` returns the lettered page converted to CMYK and back to sRGB, so colours a
press cannot reach shift on screen as they will on paper; `?proof=grey` shows it as a black-ink interior. The
preflight report shows a page as rendered next to its proof (`grey` for greyscale and black-and-white projects).

The CMYK profile is libvips's built-in generic one (Graeme Gill's public-domain "Chemical proof"), the only CMYK
profile in the render image: it shows which colours move and roughly how much ink a page takes, not a particular
printer's output. Its separation uses heavy grey replacement, so pure black comes to about 200% ink; the 300% limit
flags dense saturated colour rather than ordinary black.
