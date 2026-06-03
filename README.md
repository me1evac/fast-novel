# Truyện Nhanh — PDF Novel Reader

A client-side web app that converts PDF files into a mobile-optimized novel reader. Supports **Image mode** (render PDF pages as images) and **Text mode** (continuous scroll text with chapter headings). All data stays in the browser (IndexedDB + localStorage).

## Tech Stack

- **Language:** Vanilla JS (ES2017+), no framework
- **PDF Engine:** PDF.js 3.11.174 (CDN)
- **Storage:** IndexedDB (books + progress + bookmarks), localStorage (settings)
- **CSS:** Custom properties, CSS Grid, mobile-first, no framework
- **Server:** `npx serve .` or any static server (required for IndexedDB + File API)

## Files

| File | Purpose |
|------|---------|
| `index.html` | Single HTML entry, all views — header buttons use SVG icons |
| `style.css` | All styles, dark/light themes, responsive, text mode, page-number, bookmark SVG |
| `app.js` | All application logic, ~900 lines |
| `README.md` | This file |

## Key Code Locations (`app.js`)

### Text Extraction

| Function | Line | Purpose |
|----------|------|---------|
| `extractPageText()` | 78 | Per-page text extraction preserving line breaks via Y-position tracking |
| `parsePDF()` | 98 | Read PDF, extract text per page, detect chapters, create cover |
| `detectChapters()` | 144 | Regex-based chapter detection from extracted text |
| `ensurePageTexts()` | 181 | Re-extract + regenerate chapters for old books missing content |

### Image Mode

| Function | Line | Purpose |
|----------|------|---------|
| `loadPdf()` / `unloadPdf()` | 243/250 | PDF document lifecycle (clones buffer to avoid detached ArrayBuffer) |
| `renderPageToUrl()` | 257 | Render a PDF page to a JPEG data URL via canvas |
| `openImageReader()` | 320 | Open a book in image mode, create page DOM skeleton, render initial pages |
| `renderPageDom()` | 381 | Lazy-render one page into its placeholder div |
| `navToPage()` | 426 | Navigate to a specific page |
| `handleScroll()` | 531 | Scroll-based page tracking + lazy rendering |

### Text Mode

| Function | Line | Purpose |
|----------|------|---------|
| `renderTextContent()` | 208 | Render continuous scroll text with page-number detection |
| `openTextReader()` | 369 | Open a book in text mode, auto-fallback to image if no text |
| `handleTextScroll()` | 503 | Chapter-based scroll tracking (viewport center detection) |
| `navToChapter()` | 437 | Scroll to a chapter or page (works for both modes) |
| `goPrevChapter()` / `goNextChapter()` | 449/460 | Chapter navigation, works for both modes |

### Bookmark System

| Function | Line | Purpose |
|----------|------|---------|
| `bookmarkPageToChapter()` | 608 | Map any page index to its containing chapter |
| `loadBookmarks()` | 616 | Load bookmarks for current book from IndexedDB |
| `getBookmarkKey()` | 624 | Get `{ pageIndex, chapterIndex }` for current position |
| `toggleBookmark()` | 634 | Add/remove bookmark for current page |
| `updateBookmarkBtn()` | 647 | Update SVG bookmark icon active state (yellow fill) |
| `renderBookmarkList()` | 653 | Render bookmark list drawer with page+chapter labels |

### Shared

| Function | Line | Purpose |
|----------|------|---------|
| `openReader()` | 304 | Dispatch to `openImageReader` / `openTextReader` based on `settings.textMode` |
| `updateProgress()` | 474 | Chapter-based (text) or page-based (image) progress |
| `savePosition()` | 494 | Auto-save position to IndexedDB (debounced 500ms) |
| `renderSidebar()` | 753 | Chapter list with read tracking |
| `applySettings()` | 691 | Apply dark mode, high quality, text mode toggles |
| `loadSettings()` | 671 | Always defaults to image mode (`textMode: false`) |
| `confirmDelete()` | 593 | Delete book + progress + all related bookmarks |
| `init()` | 839 | Bootstrap: open DB (v2), load books, handle both progress shapes |

## State Shape

```js
state = {
  books: [{ id, title, coverUrl, chapters, chapterPages, totalPages, pdfData,
           fileSize, fileName, createdAt, pageTexts, _progress }],
  currentBook: null,
  currentPage: 0,          // image mode: current page index
  currentChapter: 0,       // text mode: current chapter index
  settings: { darkMode: false, highRes: false, textMode: false },
  pdfDoc: null,            // current PDF.js document (image mode only)
  pageCache: null,         // array of data URLs per page (image mode only)
  renderedPages: Set,      // set of rendered page indices (image mode only)
  _bookmarks: [],          // cache of bookmarks for current book
}
```

## IndexedDB Schema

- **DB:** `TruyenNhanhDB` (v2)
- **Store `books`:** `{ id (autoIncrement), title, coverUrl, chapters, chapterPages, totalPages, pdfData, fileSize, fileName, createdAt, pageTexts }`
- **Store `progress`:** `{ bookId (keyPath), pageIndex, totalPages, updatedAt }` (image) or `{ bookId (keyPath), chapterIndex, totalChapters, updatedAt }` (text)
- **Store `bookmarks`:** `{ id (autoIncrement), bookId, pageIndex, chapterIndex, label, createdAt }` — indexed by `bookId`
- **localStorage key:** `truyennhanh.settings` → `{ darkMode, highRes, textMode }`

## Key Behaviors

- **Image Mode** — renders each PDF page as JPEG image, scroll per page, lazy-loads nearby pages
- **Text Mode** — continuous scroll, `<h2>` chapter headings, paragraphs split by blank lines, system-ui font 17px
- **Line-aware extraction** — `extractPageText()` tracks Y-position of PDF text items to preserve actual line breaks within pages
- **Page numbers** — lines consisting only of digits are rendered as centered muted page-number markers
- **Toggle modes** — Settings → "Chế độ văn bản", persists across session; default is image mode
- **Auto-save** — saves `chapterIndex` (text) / `pageIndex` (image) on scroll (debounced 500ms)
- **Manual bookmarks** — page-based: each bookmark stores `pageIndex` + `chapterIndex`; label shows `"Trang X - Chương Y"`
- **Bookmark toggle** — SVG bookmark icon in footer toggles bookmark for current page; yellow fill when active
- **Bookmark visibility** — bookmark buttons hidden in image mode, visible only in text mode
- **Bookmark list** — open book SVG icon opens drawer; click navigates to page (image) or chapter (text)
- **Migration** — old books with missing chapter content get re-extracted + chapters regenerated on first text mode open
- **Buffer safety** — `loadPdf()` clones ArrayBuffer before passing to PDF.js worker to prevent detached buffer errors on mode toggle
- **Chapter navigation** — keyboard ← → arrows (both modes)
- **Swipe to delete** — swipe left on book card → red delete button (also deletes bookmarks)
- **Scanned PDF fallback** — text mode auto-falls back to image mode if extracted text < 50 non-whitespace chars
- **Default mode** — image mode is forced on every app start regardless of saved preference
- **File limit** — 7MB maximum

## Conventions

- All functions use `function` declarations (no arrow functions for named functions)
- DOM queries cached in `dom` object at top of file
- Async/await for all promises
- No build step, no npm dependencies (except PDF.js CDN)
- Vietnamese UI labels throughout
