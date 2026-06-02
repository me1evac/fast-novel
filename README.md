# Truyện Nhanh — PDF Novel Reader

A client-side web app that turns PDF files into a mobile-optimized novel reading experience. Preserves the original PDF formatting by rendering each page as an image.

## Tech Stack

| Layer | Choice |
|-------|--------|
| Language | Vanilla JavaScript (ES2017+) |
| PDF Engine | PDF.js 3.11.174 (CDN) |
| Storage | IndexedDB (books + progress), localStorage (settings) |
| CSS | Custom properties, CSS Grid, mobile-first |
| Server (dev) | `npx serve .` or any static file server |

## File Structure

```
truyennhanh/
├── index.html       # Single HTML entry — all views
├── style.css        # All styles — dark/light themes, responsive
├── app.js           # All application logic
└── README.md        # This file
```

Zero build step. Zero dependencies (except PDF.js loaded from CDN).

## Running Locally

```sh
cd truyennhanh
npx serve .
# then open http://localhost:3000 in browser
```

A static HTTP server is required (IndexedDB + File API don't work from `file://`).

## Architecture

### Views (hash-less SPA via CSS class toggles)

| View | Selector | Description |
|------|----------|-------------|
| Library | `#library-view` | Grid of book cards with cover, title, progress. Add button → file picker. |
| Reader | `#reader-view` | Scrolling PDF page images. Header, footer with progress bar. |
| Chapters | `#sidebar` | Slide-in from left. List of chapters with checkmarks. |
| Settings | `#settings` | Slide-in from right. Dark mode toggle. |

### Data Flow

```
User picks PDF file
    → file.arrayBuffer()
    → Clone buffer (pdfData — for storage)
    → pdfjsLib.getDocument({ data: originalBuffer })  — original gets transferred
    → Extract text per page for chapter detection
    → detectChapters() — finds headings, maps to page numbers
    → Render page 1 as JPEG for cover thumbnail
    → { title, coverUrl, chapters, chapterPages, totalPages, pdfData, ... }
    → dbPut('books', bookData) — saves to IndexedDB
    → dbGet('books', id) — reload fresh copy (undetached buffer)
    → loadPdf(fresh.pdfData) — render pages as user scrolls
```

### IndexedDB Schema

**Database:** `TruyenNhanhDB` (version 1)

**Object store: `books`**
- `id` — auto-increment (keyPath)
- `title` — book title (filename without .pdf)
- `coverUrl` — JPEG data URL of page 1
- `chapters` — `[{ id, title, content }]`
- `chapterPages` — array mapping chapter index → page number
- `totalPages` — number of PDF pages
- `pdfData` — raw PDF ArrayBuffer (cloned before PDF.js touches it)
- `fileSize`, `fileName`, `createdAt`

**Object store: `progress`**
- `bookId` — foreign key to books store (keyPath)
- `pageIndex` — current page number (0-based)
- `totalPages` — total pages at last save
- `updatedAt` — timestamp

### Chapter Detection

Regex patterns tested against each line of extracted text:

```
Chương 1, Chapter 1, Chapitre 1
Phần 1, Part 1, Tập 1, Quyển 1, Book 1, Volume 1
Hồi 1
```

Section break lines (`---`, `***`, `=====`) as secondary separator.

Headings are mapped to page numbers using cumulative line counts per page.

### PDF Page Rendering

- Pages rendered at reader width (max 720px, min 320px)
- Resolution multiplied by `devicePixelRatio` (capped at 2×) for sharp text on Retina/HiDPI screens
- JPEG quality 0.85
- Cached in memory (`state.pageCache`) during session
- First visible page renders immediately; remaining pages render in background
- Re-creates PDF document from stored ArrayBuffer each time reader opens

## Key Behaviors

- **Swipe to delete** — swipe left on book card → red delete button
- **Desktop delete** — hover card → ✕ button top-right
- **Progress** — auto-saved to IndexedDB on scroll (debounced 500ms)
- **Cache** — same filename + size → skip re-parse
- **Scanned PDF** — if extracted text < 50 chars → error message
- **File limit** — 7MB maximum

## Settings

Stored in localStorage under key `truyennhanh.settings`:

```json
{ "darkMode": false }
```

## Potential Upgrades

- **Virtual scrolling** — for very long PDFs, only render visible pages
- **Text search** — search within extracted chapter text
- **Bookmarks** — save multiple positions per book
- **Export highlights** — save selected text regions
- **Multiple file formats** — EPUB, MOBI (needs additional parser)
- **Offline worker** — bundle PDF.js worker locally instead of CDN
- **Upload via URL** — fetch PDF from URL (needs CORS proxy or backend)
- **Pagination mode** — single-page view with tap-to-turn instead of scroll
