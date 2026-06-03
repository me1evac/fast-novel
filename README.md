# Truyện Nhanh — PDF Novel Reader

A client-side web app that converts PDF files into a mobile-optimized novel reader. Supports **Image mode** (render PDF pages as images) and **Text mode** (continuous scroll text with chapter headings, zoom controls, smart paragraph grouping). All data stays in the browser (IndexedDB + localStorage). No API calls — on-device AI / regex only.

## Tech Stack

- **Language:** Vanilla JS (ES2017+), no framework
- **PDF Engine:** PDF.js 3.11.174 (CDN)
- **Storage:** IndexedDB (books + progress + bookmarks), localStorage (settings)
- **CSS:** Custom properties, CSS Grid, mobile-first, no framework
- **Server:** `npx serve .` or any static server (required for IndexedDB + File API)

## Files

| File | Purpose |
|------|---------|
| `index.html` | Single HTML entry, all views — settings drawer, tooltip element, modal |
| `style.css` | All styles, dark/light themes, responsive, text mode, page-number, zoom controls, collapsible settings, tooltip |
| `app.js` | All application logic, ~1230 lines |
| `README.md` | This file |

## Key Code Locations (`app.js`)

> Line numbers are approximate — always search by function name.

### Text Extraction & Cleaning

| Function | Purpose |
|----------|---------|
| `extractPageText()` | Per-page text extraction; `\n` for line breaks, `\n\n` for paragraph breaks (Y-gap > 1.4×fontSize) |
| `stripRepeatedLines()` | Remove running headers/footers via frequency analysis (≥60% of pages, normalized: lowercase, digits→#) |
| `parsePDF()` | Full pipeline: extract text → strip repeated lines → detect chapters → render cover |
| `detectChapters()` | Regex + heuristic chapter detection from extracted text |
| `ensurePageTexts()` | Re-extract + strip headers + regenerate chapters for old books missing content |
| `reparseBook()` | Full re-extraction with current pipeline (triggered from Settings) |

### Chapter Detection (`detectChapters()`)

| Feature | Purpose |
|---------|---------|
| `CHAPTER_PATTERNS` | Regex patterns: `Chương`, `Ch`, `Chap`, `Bài`, `Mục`, `Đoạn`, `Kỳ`, Vietnamese numerals (`Một`, `Hai`…), bracket formats (`[Chương 1]`, `【Chương 1】`) |
| `scoreChapterCandidate()` | Positive: ALL CAPS, empty lines before, numbers, keywords. Negative: quotes, speech endings (`!?…`), `Trang \d+` |
| Lowercase rejection | Lowercase keyword matches (e.g. `tập`) require ≥2 empty lines before |
| ALL CAPS fallback | Requires keyword or (2 empties + number); min length 8 |

### Image Mode

| Function | Purpose |
|----------|---------|
| `loadPdf()` / `unloadPdf()` | PDF document lifecycle (clones buffer to avoid detached ArrayBuffer) |
| `renderPageToUrl()` | Render a PDF page to a JPEG data URL via canvas |
| `openImageReader()` | Open a book in image mode, create page DOM skeleton, render initial pages |
| `renderPageDom()` | Lazy-render one page into its placeholder div |
| `navToPage()` | Navigate to a specific page |
| `handleScroll()` | Scroll-based page tracking + lazy rendering |

### Zoom Controls (Image Mode)

| Feature | Purpose |
|---------|---------|
| `ZOOM_LEVELS` | `[0.75, 1, 1.25, 1.5, 2, 3]` |
| Zoom mechanism | Width-based (no `transform: scale`), canvas renders at `clientWidth × dpr` |
| A+/A− buttons | In reader header, updates zoom label |
| Pinch-to-zoom | Enabled via `touch-action` when zoomed >1 |

### Text Mode

| Function | Purpose |
|----------|---------|
| `renderTextContent()` | Smart paragraph grouping: blank lines, dialogue-start (`"`, `"`, `«`, `「`), short-line rag (prev < 40 chars + ends sentence + next 1.4× longer), scene break markers |
| `openTextReader()` | Open a book in text mode, auto-fallback to image if no text |
| `handleTextScroll()` | Chapter-based scroll tracking (viewport center detection) |
| `navToChapter()` | Scroll to a chapter or page (works for both modes) |
| `goPrevChapter()` / `goNextChapter()` | Chapter navigation, works for both modes |

### Header / Footer Cleanup

| Feature | Purpose |
|---------|---------|
| `stripRepeatedLines()` | Scans first & last line of each page; if a normalized line appears on ≥60% of pages, removes it. Runs automatically in `parsePDF()`, `ensurePageTexts()`, `reparseBook()`, and `openTextReader()`. Also triggerable via Settings → "Làm sạch header lặp". |

### Bookmark System

| Function | Purpose |
|----------|---------|
| `bookmarkPageToChapter()` | Map any page index to its containing chapter |
| `loadBookmarks()` | Load bookmarks for current book from IndexedDB |
| `getBookmarkKey()` | Get `{ pageIndex, chapterIndex }` for current position |
| `toggleBookmark()` | Add/remove bookmark for current page |
| `updateBookmarkBtn()` | Update SVG bookmark icon active state (yellow fill) |
| `renderBookmarkList()` | Render bookmark list drawer with page+chapter labels |

### Settings UI

| Feature | Purpose |
|---------|---------|
| Dark mode | Toggle, persists via localStorage |
| High quality | Upscale rendered pages to 1080p |
| Text mode | Toggle, falls back to image if PDF is scanned |
| **Tuỳ chọn nâng cao** (collapsible) | Contains "Phân tích lại" and "Làm sạch header lặp". Only shows when a book with extracted text is loaded. |
| Info tooltips | SVG info icon next to each toggle; desktop hover / mobile tap; tooltip element is `position: fixed` at body level to avoid overflow clipping |

### Shared

| Function | Purpose |
|----------|---------|
| `openReader()` | Dispatch to `openImageReader` / `openTextReader` based on `settings.textMode` |
| `updateProgress()` | Chapter-based (text) or page-based (image) progress |
| `savePosition()` | Auto-save position to IndexedDB (debounced 500ms) |
| `renderSidebar()` | Chapter list with read tracking |
| `showAlert()` / `showConfirm()` | Custom modal – replaces native `alert()` / `confirm()` |
| `applySettings()` | Apply dark mode, high quality, text mode toggles |
| `loadSettings()` | Always defaults to image mode (`textMode: false`) |
| `confirmDelete()` | Delete book + progress + all related bookmarks |
| `init()` | Bootstrap: open DB (v3), load books, handle both progress shapes |

## State Shape

```js
state = {
  books: [{ id, title, coverUrl, chapters, chapterPages, totalPages, pdfData,
           fileSize, fileName, createdAt, pageTexts, _progress }],
  currentBook: null,
  currentPage: 0,          // image mode: current page index
  currentChapter: 0,       // text mode: current chapter index
  zoom: 1,                 // image mode zoom level
  settings: { darkMode: false, highRes: false, textMode: false },
  pdfDoc: null,            // current PDF.js document (image mode only)
  pageCache: null,         // array of data URLs per page (image mode only)
  renderedPages: Set,      // set of rendered page indices (image mode only)
  _bookmarks: [],          // cache of bookmarks for current book
}
```

## IndexedDB Schema

- **DB:** `TruyenNhanhDB` (v3)
- **Store `books`:** `{ id (autoIncrement), title, coverUrl, chapters, chapterPages, totalPages, pdfData, fileSize, fileName, createdAt, pageTexts }`
- **Store `progress`:** `{ bookId (keyPath), pageIndex, totalPages, updatedAt }` (image) or `{ bookId (keyPath), chapterIndex, totalChapters, updatedAt }` (text)
- **Store `bookmarks`:** `{ id (autoIncrement), bookId, pageIndex, chapterIndex, label, createdAt }` — indexed by `bookId`
- **localStorage key:** `truyennhanh.settings` → `{ darkMode, highRes, textMode }`

## Key Behaviors

- **Image Mode** — renders each PDF page as JPEG image, scroll per page, lazy-loads nearby pages
- **Zoom (Image Mode)** — A+/A− buttons cycle `ZOOM_LEVELS`; width-based zoom (no `transform: scale`); pinch-to-zoom when zoomed >1
- **Text Mode** — continuous scroll, `<h2>` chapter headings, smart paragraph grouping (blank lines, dialogue-start, short-line rag, scene break markers), system-ui font 17px
- **Line-aware extraction** — `extractPageText()` tracks Y-position of PDF text items; larger Y-gap (>1.4×fontSize) → `\n\n` (paragraph break)
- **Header/footer removal** — `stripRepeatedLines()` runs automatically; removes lines that appear on ≥60% of pages
- **Chapter detection** — multi-pattern regex + scoring; ALL CAPS chapters, Vietnamese numerals, bracket formats; lowercase keyword rejection prevents false positives
- **Re-parse** — "Phân tích lại" in Settings: re-extract text + re-detect chapters from stored PDF data
- **Page numbers** — lines consisting only of digits are rendered as centered muted page-number markers
- **Toggle modes** — Settings → "Chế độ văn bản", persists across session; default is image mode
- **Auto-save** — saves `chapterIndex` (text) / `pageIndex` (image) on scroll (debounced 500ms)
- **Custom modal** — replaces native `alert()`/`confirm()` for consistent dark/light theming
- **Manual bookmarks** — page-based: each bookmark stores `pageIndex` + `chapterIndex`; label shows `"Trang X - Chương Y"`
- **Bookmark toggle** — SVG bookmark icon in footer toggles bookmark for current page; yellow fill when active
- **Bookmark visibility** — bookmark buttons hidden in image mode, visible only in text mode
- **Bookmark list** — open book SVG icon opens drawer; click navigates to page (image) or chapter (text)
- **Migration** — old books with missing chapter content get re-extracted + chapters regenerated on first text mode open
- **Buffer safety** — `loadPdf()` clones ArrayBuffer before passing to PDF.js worker to prevent detached buffer errors on mode toggle
- **Chapter navigation** — keyboard ← → arrows (both modes)
- **Swipe to delete** — swipe left on book card → red delete button (also deletes bookmarks)
- **Scanned PDF fallback** — text mode auto-falls back to image mode if extracted text < 50 non-whitespace chars
- **Settings reset on file open** — `handleFile()` resets `state.settings` to defaults and clears localStorage before opening any new or existing file
- **Default mode** — image mode is forced on every app start regardless of saved preference
- **File limit** — 7MB maximum
- **Mobile UI** — chapter list with `min-height: 48px`, `border-left: 3px solid var(--accent)` for current chapter; no `box-shadow` on `.pdf-page`; `line-height: 1.6`

## Conventions

- All functions use `function` declarations (no arrow functions for named functions)
- DOM queries cached in `dom` object at top of file
- Async/await for all promises
- No build step, no npm dependencies (except PDF.js CDN)
- Vietnamese UI labels throughout

## Changelog

### v4 (current)
- Per-book settings via `{ darkMode, books: { [id]: { highRes, textMode } } }` — `darkMode` global, phần còn lại lưu riêng theo từng sách
- Settings reset về mặc định (`highRes=false, textMode=false`) khi thoát về màn hình thư viện
- Thumbnail cố định `200×267` (3:4), render center-crop fill
- `ZOOM_LEVELS` mở rộng: 0.5, 0.75, 1, 1.15, 1.25, 1.5, 1.75, 2, 2.5, 3
- Fix bug delete: `stopPropagation` trực tiếp trên `.card-delete-btn` — không còn mở sách khi xoá
- "Tuỳ chọn nâng cao" chỉ hiện khi đang ở chế độ văn bản
- Book title truncation: 1 dòng với `text-overflow: ellipsis`

### v3
- Settings reset on file open (localStorage cleared per `handleFile()`)
- `stripRepeatedLines()` runs in `openTextReader()` for old books without re-parse
- Collapsible "Tuỳ chọn nâng cao" in Settings (only when text data exists)
- SVG info tooltips (desktop hover / mobile tap, `position: fixed` to avoid overflow clipping)
- Header/footer auto-removal via `stripRepeatedLines()` (frequency ≥60%)
- Smart paragraph grouping in `renderTextContent()` (dialogue-start, short-line rag, scene breaks)
- Paragraph break detection in `extractPageText()` (Y-gap >1.4×fontSize)
- Zoom controls in image mode (A+/A− buttons, width-based zoom)
- Custom modal replacing `alert()`/`confirm()`
- Re-parse button in Settings
- Expanded chapter patterns + scoring heuristics
- Lowercase keyword rejection for chapter headings
