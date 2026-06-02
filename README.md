# Truyện Nhanh — PDF Novel Reader

A client-side web app that converts PDF files into a mobile-optimized novel reader. Renders each PDF page as an image in a scrolling view. All data stays in the browser (IndexedDB + localStorage).

## Tech Stack

- **Language:** Vanilla JS (ES2017+), no framework
- **PDF Engine:** PDF.js 3.11.174 (CDN)
- **Storage:** IndexedDB (books + progress), localStorage (settings)
- **CSS:** Custom properties, CSS Grid, mobile-first, no framework
- **Server:** `npx serve .` or any static server (required for IndexedDB + File API)

## Files

| File | Purpose |
|------|---------|
| `index.html` | Single HTML entry, all views (library, reader, sidebar, settings) |
| `style.css` | All styles, dark/light themes, responsive breakpoints |
| `app.js` | All application logic, ~530 lines |
| `README.md` | This file |

## Key Code Locations (`app.js`)

| Function | Line | Purpose |
|----------|------|---------|
| `parsePDF()` | 65 | Read PDF, extract text, detect chapters, create cover thumbnail |
| `detectChapters()` | 113 | Regex-based chapter detection from extracted text |
| `loadPdf()` / `unloadPdf()` | 149/155 | PDF document lifecycle management |
| `renderPageToUrl()` | 162 | Render a PDF page to a JPEG data URL via canvas. Uses DPR (capped at 2×) for sharp text. When `settings.highRes` is on: DPR cap=3, render width=1080px |
| `openReader()` | 210 | Open a book, create page DOM skeleton, render initial pages |
| `renderPageDom()` | 263 | Lazy-render one page into its placeholder div |
| `navToPage()` | 283 | Navigate to a specific page |
| `goPrevChapter()` / `goNextChapter()` | 299/307 | Chapter navigation (keyboard ← → only) |
| `handleScroll()` | 333 | Scroll-based page tracking + lazy rendering |
| `renderLibrary()` | 179 | Render the book grid |
| `renderSidebar()` | 451 | Render chapter list sidebar |
| `handleFile()` | 473 | File picker → parse → store → open |
| `deleteBook()` | 398 | Confirm + delete from IndexedDB |
| `applySettings()` | 415 | Apply dark mode + high quality toggles |
| `init()` | 517 | Bootstrap: open DB, load books, render |

## State Shape

```js
state = {
  books: [{ id, title, coverUrl, chapters, chapterPages, totalPages, pdfData, fileSize, fileName, createdAt, _progress }],
  currentBook: null,
  currentPage: 0,
  settings: { darkMode: false, highRes: false },  // persisted to localStorage
  pdfDoc: null,       // current PDF.js document
  pageCache: null,    // array of data URLs per page
  renderedPages: Set  // set of rendered page indices
}
```

## IndexedDB Schema

- **DB:** `TruyenNhanhDB` (v1)
- **Store `books`:** `{ id (autoIncrement), title, coverUrl, chapters, chapterPages, totalPages, pdfData, fileSize, fileName, createdAt }`
- **Store `progress`:** `{ bookId (keyPath), pageIndex, totalPages, updatedAt }`
- **localStorage key:** `truyennhanh.settings` → `{ darkMode, highRes }`

## Key Behaviors

- **Swipe to delete** — swipe left on book card → red delete button
- **Desktop delete** — hover card → ✕ button
- **Chapter navigation** — keyboard ← → arrows only (screen tap zones removed)
- **Progress** — auto-saved to IndexedDB on scroll (debounced 500ms)
- **Cache** — same filename + size → skip re-parse
- **Scanned PDF** — if extracted text < 50 chars → error message
- **File limit** — 7MB maximum
- **High quality mode** — Settings toggle → renders at up to 1080px / 3× DPR (off by default)

## Conventions

- All functions use `function` declarations (no arrow functions for named functions)
- DOM queries cached in `dom` object at top of file
- Async/await for all promises
- No build step, no npm dependencies (except PDF.js CDN)
- Vietnamese UI labels throughout
