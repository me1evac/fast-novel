const DB_NAME = 'TruyenNhanhDB';
const DB_VER = 2;
const MAX_FILE_SIZE = 7 * 1024 * 1024;
const CHAPTER_PATTERNS = [
  /^(Chương|Chapter|Chapitre|Ch|Chap)\s*(\d+|[IVXLCDM]+)\b(?:[\s:：.\-—–]+([\s\S]*?))?$/gim,
  /^(Phần|Part|Tập|Quyển|Book|Volume)\s*(\d+|[IVXLCDM]+)\b(?:[\s:：.\-—–]+([\s\S]*?))?$/gim,
  /^(Hồi|Bài|Mục|Đoạn|Kỳ)\s*(\d+|[IVXLCDM]+)\b(?:[\s:：.\-—–]+([\s\S]*?))?$/gim,
  /^(Chương|Chapter|Phần|Tập|Hồi|Bài)\s*(Một|Hai|Ba|Bốn|Bố|Năm|Sáu|Bảy|Tám|Chín|Mười)\b(?:[\s:：.\-—–]+([\s\S]*?))?$/gim,
  /^[\[\【〈<\(]\s*(Chương|Chapter|Phần|Tập|Hồi|Bài)\s*(\d+|[IVXLCDM]+)(?:[\s:：.\-—–]+([^\]】〉>\)\]]*?))?\s*[\]】〉>\)]/gim,
];
const SECTION_BREAK = /^[\s\-–—=*~#·]{5,}$/m;
const CHAPTER_TITLE_CLEAN = /^[:\s.\-—–]+|[:\s.\-—–]+$/g;
const PAGE_NUM_RE = /^\d+$/;
const SETTINGS_KEY = 'truyennhanh.settings';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// DOM
const $ = (sel) => document.querySelector(sel);
const dom = {
  loading: $('#loading-overlay'), loadingText: $('#loading-text'),
  libraryView: $('#library-view'), bookGrid: $('#book-grid'),
  emptyState: $('#empty-state'), addBtn: $('#add-book-btn'),
  fileInput: $('#file-input'),
  readerView: $('#reader-view'), readerTitle: $('#reader-title'),
  pagesContainer: $('#pages-container'), readerContent: $('#reader-content'),
  backBtn: $('#back-btn'), sidebarToggle: $('#sidebar-toggle'),
  settingsToggle: $('#settings-toggle'),
  progressFill: $('#progress-fill'), progressText: $('#progress-text'),
  sidebar: $('#sidebar'), sidebarBackdrop: $('#sidebar-backdrop'),
  sidebarClose: $('#sidebar-close'), chapterList: $('#chapter-list'),
  readCount: $('#read-count'),
  settings: $('#settings'), settingsBackdrop: $('#settings-backdrop'),
  settingsClose: $('#settings-close'), darkmodeToggle: $('#darkmode-toggle'), highresToggle: $('#highres-toggle'),
  textmodeToggle: $('#textmode-toggle'),
  bookmarkBtn: $('#bookmark-btn'), bookmarkListBtn: $('#bookmark-list-btn'),
  bookmarkDrawer: $('#bookmark-drawer'), bookmarkBackdrop: $('#bookmark-backdrop'),
  bookmarkClose: $('#bookmark-close'), bookmarkList: $('#bookmark-list'),
  reparseBtn: $('#reparse-btn'),
  parseCollapse: $('#parse-collapse'),
  parseCollapseBody: $('#parse-collapse-body'),
  parseChevron: $('#parse-chevron'),
  modal: $('#modal'), modalText: $('#modal-text'), modalButtons: $('#modal-buttons'),
  zoomInBtn: $('#zoom-in-btn'), zoomOutBtn: $('#zoom-out-btn'),
  zoomLabel: $('#zoom-label'), zoomGroup: $('#zoom-group'),
};

// State
const state = {
  books: [], currentBook: null, currentPage: 0, currentChapter: 0,
  settings: { darkMode: false, highRes: false, textMode: false },
  pdfDoc: null, pageCache: null,
  renderedPages: new Set(),
  _bookmarks: [],
  zoom: 1,
};

// IndexedDB
let _db = null;
function openDB() {
  return new Promise((res, rej) => {
    if (_db) return res(_db);
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('progress')) d.createObjectStore('progress', { keyPath: 'bookId' });
      if (!d.objectStoreNames.contains('bookmarks')) {
        const bmStore = d.createObjectStore('bookmarks', { keyPath: 'id', autoIncrement: true });
        bmStore.createIndex('bookId', 'bookId', { unique: false });
      }
    };
    r.onsuccess = (e) => { _db = e.target.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode) { return openDB().then((db) => db.transaction(store, mode).objectStore(store)); }
async function dbAll(store) { const s = await tx(store, 'readonly'); return new Promise((res, rej) => { const r = s.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function dbGet(store, id) { const s = await tx(store, 'readonly'); return new Promise((res, rej) => { const r = s.get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function dbPut(store, data) { const s = await tx(store, 'readwrite'); return new Promise((res, rej) => { const r = s.put(data); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function dbDel(store, id) { const s = await tx(store, 'readwrite'); return new Promise((res, rej) => { const r = s.delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
async function dbAllByIndex(store, idx, val) {
  const s = await tx(store, 'readonly');
  const i = s.index(idx);
  return new Promise((res, rej) => { const r = i.getAll(val); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

// PDF Parsing
async function extractPageText(page) {
  const tc = await page.getTextContent();
  if (tc.items.length === 0) return '';
  const parts = [];
  let lastY = tc.items[0].transform[5];
  for (const item of tc.items) {
    const y = item.transform[5];
    const fontSize = Math.abs(item.transform[3]) || 10;
    const dy = Math.abs(y - lastY);
    if (dy > fontSize * 1.4) {
      parts.push('\n\n');
    } else if (dy > fontSize * 0.3) {
      parts.push('\n');
    } else if (parts.length > 0) {
      parts.push(' ');
    }
    parts.push(item.str);
    lastY = y;
  }
  return parts.join('');
}

function stripRepeatedLines(pageTexts) {
  const total = pageTexts.length;
  if (total < 3) return;
  const THRESHOLD = Math.ceil(total * 0.6);

  const firstCount = {};
  const lastCount = {};
  const firstLines = [];
  const lastLines = [];

  for (const text of pageTexts) {
    const lines = text.split('\n').filter(l => l.trim());
    let first = lines.length ? lines[0].trim() : '';
    let last = lines.length ? lines[lines.length - 1].trim() : '';
    if (first === last && lines.length === 1) { first = ''; last = ''; }
    const norm = s => s.replace(/\s+/g, ' ').replace(/\d+/g, '#').toLowerCase().trim();
    const nf = norm(first); const nl = norm(last);
    firstLines.push({ orig: first, norm: nf });
    lastLines.push({ orig: last, norm: nl });
    if (nf) firstCount[nf] = (firstCount[nf] || 0) + 1;
    if (nl) lastCount[nl] = (lastCount[nl] || 0) + 1;
  }

  const repeatedFirst = new Set(Object.entries(firstCount).filter(([,c]) => c >= THRESHOLD).map(([k]) => k));
  const repeatedLast  = new Set(Object.entries(lastCount).filter(([,c]) => c >= THRESHOLD).map(([k]) => k));

  for (let i = 0; i < total; i++) {
    let text = pageTexts[i];
    const lines = text.split('\n');
    let changed = false;

    while (lines.length) {
      const t = lines[0].trim();
      const n = t.replace(/\s+/g, ' ').replace(/\d+/g, '#').toLowerCase().trim();
      if (n && repeatedFirst.has(n)) { lines.shift(); changed = true; }
      else break;
    }

    while (lines.length) {
      const t = lines[lines.length - 1].trim();
      const n = t.replace(/\s+/g, ' ').replace(/\d+/g, '#').toLowerCase().trim();
      if (n && repeatedLast.has(n)) { lines.pop(); changed = true; }
      else break;
    }

    if (changed) pageTexts[i] = lines.join('\n');
  }
}

async function parsePDF(file) {
  const buffer = await file.arrayBuffer();
  const pdfData = buffer.slice(0);
  let pdfDoc;
  try {
    pdfDoc = await pdfjsLib.getDocument({ data: buffer, cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/', cMapPacked: true }).promise;
  } catch (e) {
    if (e.name === 'PasswordException') throw e;
    throw new Error('PDFJS_LOAD:' + (e.message || 'unknown'));
  }
  const totalPages = pdfDoc.numPages;
  const pageTexts = [];

  for (let i = 1; i <= totalPages; i++) {
    try {
      const page = await pdfDoc.getPage(i);
      pageTexts.push(await extractPageText(page));
    } catch {
      pageTexts.push('');
    }
  }

  stripRepeatedLines(pageTexts);

  const combined = pageTexts.join('\n\n');
  if (combined.replace(/\s/g, '').length < 50) { pdfDoc.destroy(); throw new Error('SCANNED_PDF'); }

  const { chapters, chapterPages } = detectChapters(pageTexts, combined);

  let coverUrl = '';
  try {
    const p1 = await pdfDoc.getPage(1);
    const vp = p1.getViewport({ scale: 0.3 });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await p1.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    coverUrl = c.toDataURL('image/jpeg', 0.7);
  } catch {}

  pdfDoc.destroy();
  return {
    title: file.name.replace(/\.pdf$/i, '').trim(),
    coverUrl, chapters, chapterPages, totalPages,
    pdfData: pdfData, fileSize: file.size,
    fileName: file.name, createdAt: Date.now(),
    pageTexts,
  };
}

function scoreChapterCandidate(line, idx, lines, isFallback) {
  let score = 0;

  if (line === line.toUpperCase() && line.length >= 5 && line.length <= 80) {
    score += 1;
  }

  let emptyBefore = 0;
  for (let j = idx - 1; j >= 0; j--) {
    if (!lines[j].trim()) emptyBefore++;
    else break;
  }
  if (emptyBefore >= 1) score += 1;
  if (emptyBefore >= 2) score += 1;

  if (line.length < 5 || line.length > 120) score -= 1;
  if (/\d+/.test(line)) score += 1;
  if (/\b(chương|chapter|phần|tập|bài|hồi|mục|quyển|đoạn|kỳ)\b/i.test(line)) score += 2;

  // ——— Negative indicators (dialogue / non-heading patterns) ———
  const trimmed = line.trim();

  // Chứa dấu ngoặc kép → hội thoại
  if (/["""'«»「」]/.test(trimmed)) score -= 3;

  // "WORD ..." hoặc WORD: "..." → lời nhân vật
  if (/^[A-Z\sÀ-Ỹ]+[:：]/.test(trimmed)) score -= 2;

  // Kết thúc bằng ! ? ... → không phải heading
  if (/[!?]$/.test(trimmed)) score -= 1;
  if (/…$/.test(trimmed)) score -= 1;

  // "Trang \d+" → số trang, không phải chương
  if (/^Trang\s+\d+/i.test(trimmed)) score -= 2;

  // ALL CAPS fallback: yêu cầu thêm tín hiệu mạnh
  if (isFallback) {
    const hasKeyword = /\b(chương|chapter|phần|tập|bài|hồi|mục|quyển|đoạn|kỳ|vol|book)\b/i.test(trimmed);
    const hasEmpties = emptyBefore >= 2;
    const hasNumber = /\d+/.test(trimmed);
    if (!hasKeyword && !(hasEmpties && hasNumber)) {
      score -= 2;
    }
  }

  return score;
}

function detectChapters(pageTexts, fullText) {
  const lines = fullText.split('\n');
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Dòng được bọc trong ngoặc kép → hội thoại, không phải chapter
    if ((line.startsWith('"') && line.endsWith('"')) ||
        (line.startsWith('\u201C') && line.endsWith('\u201D')) ||
        (line.startsWith('\u201E') && line.endsWith('\u201D')) ||
        (line.startsWith('\u00AB') && line.endsWith('\u00BB')) ||
        (line.startsWith('\u300C') && line.endsWith('\u300D'))) continue;

    let matched = false;
    for (let pi = 0; pi < CHAPTER_PATTERNS.length; pi++) {
      const p = CHAPTER_PATTERNS[pi];
      p.lastIndex = 0;
      const m = p.exec(line);
      if (m) {
        const keyword = m[1];
        // Keyword lowercased → từ thông thường, không phải heading (vd: "tập võ" ≠ "Tập 1")
        if (keyword && keyword === keyword.toLowerCase() && keyword !== keyword.toUpperCase()) {
          let emptyBefore = 0;
          for (let j = i - 1; j >= 0; j--) { if (!lines[j].trim()) emptyBefore++; else break; }
          if (emptyBefore < 2) continue; // không đủ context mạnh → bỏ qua
        }
        const patternBase = Math.max(4 - pi, 2);
        const ctxScore = scoreChapterCandidate(line, i, lines, false);
        candidates.push({ idx: i, title: line.replace(CHAPTER_TITLE_CLEAN, ''), score: patternBase + ctxScore });
        matched = true;
        break;
      }
    }

    if (!matched && line === line.toUpperCase() && line.length >= 8 && line.length <= 80) {
      const ctxScore = scoreChapterCandidate(line, i, lines, true);
      const total = 1 + ctxScore;
      if (total >= 3) {
        candidates.push({ idx: i, title: line, score: total });
      }
    }
  }

  const MIN_SCORE = 3;
  const filtered = candidates
    .filter(h => h.score >= MIN_SCORE)
    .sort((a, b) => a.idx - b.idx);

  const deduped = [];
  for (const h of filtered) {
    if (deduped.length > 0 && h.idx - deduped[deduped.length - 1].idx <= 2) {
      if (h.score > deduped[deduped.length - 1].score) {
        deduped[deduped.length - 1] = h;
      }
    } else {
      deduped.push(h);
    }
  }

  if (deduped.length === 0) return { chapters: [{ id: 0, title: 'Nội dung', content: fullText }], chapterPages: [0] };

  const cumLines = [];
  let cum = 0;
  for (const t of pageTexts) { cumLines.push(cum); cum += t.split('\n').length; }

  const chapters = [];
  const chapterPages = [];

  for (let i = 0; i < deduped.length; i++) {
    let pg = 0;
    for (let p = cumLines.length - 1; p >= 0; p--) { if (deduped[i].idx >= cumLines[p]) { pg = p; break; } }
    chapterPages.push(pg);

    const end = i + 1 < deduped.length ? deduped[i + 1].idx : lines.length;
    const body = lines.slice(deduped[i].idx + 1, end).map(l => l.trim()).filter(l => !SECTION_BREAK.test(l));
    chapters.push({ id: i, title: deduped[i].title || `Chương ${i+1}`, content: body.join('\n') });
  }

  return { chapters, chapterPages };
}

// === Text Mode ===

async function ensurePageTexts(book) {
  if (book.pageTexts && book.chapters && book.chapters.some(ch => ch.content && ch.content.trim())) return book;
  if (!book.pdfData) return book;
  showLoading('Đang xử lý văn bản...');
  try {
    const pdfDoc = await pdfjsLib.getDocument({ data: book.pdfData.slice(0) }).promise;
    const texts = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      try {
        const page = await pdfDoc.getPage(i);
        texts.push(await extractPageText(page));
      } catch {
        texts.push('');
      }
    }
    pdfDoc.destroy();
    stripRepeatedLines(texts);
    book.pageTexts = texts;
    const combined = texts.join('\n\n');
    const { chapters, chapterPages } = detectChapters(texts, combined);
    book.chapters = chapters;
    book.chapterPages = chapterPages;
    await dbPut('books', book);
  } catch (e) { console.error(e); }
  hideLoading();
  return book;
}

function renderTextContent() {
  const book = state.currentBook;
  const chapters = book.chapters;

  const tc = document.createElement('div');
  tc.id = 'text-content';

  chapters.forEach((ch, i) => {
    const section = document.createElement('section');
    section.className = 'text-chapter';
    section.dataset.chapter = i;

    const h = document.createElement('h2');
    h.className = 'text-chapter-title';
    h.textContent = ch.title;
    section.appendChild(h);

    const body = document.createElement('div');
    body.className = 'text-chapter-body';

    const rawLines = (ch.content || '').split('\n');
    const paragraphs = [];
    let buf = [];

    for (let li = 0; li < rawLines.length; li++) {
      const t = rawLines[li].trim();
      if (!t) { flushPara(buf, paragraphs); continue; }

      if (buf.length) {
        const prev = buf[buf.length - 1];
        if (/^[""«「]/.test(t)) { flushPara(buf, paragraphs); }
        else if (prev.length < 40 && t.length > prev.length * 1.4 && /[.!?…:]$/.test(prev)) { flushPara(buf, paragraphs); }
        else if (/^[-*—•]{3,}$/.test(prev)) { flushPara(buf, paragraphs); }
      }
      buf.push(t);
    }
    flushPara(buf, paragraphs);

    paragraphs.forEach(p => {
      const pEl = document.createElement('p');
      if (PAGE_NUM_RE.test(p)) pEl.className = 'page-num';
      pEl.textContent = p;
      body.appendChild(pEl);
    });

    section.appendChild(body);
    tc.appendChild(section);
  });

  dom.pagesContainer.innerHTML = '';
  dom.pagesContainer.appendChild(tc);
}

function flushPara(buf, paragraphs) {
  if (buf.length) { paragraphs.push(buf.join(' ')); buf.length = 0; }
}

// PDF Runtime
async function loadPdf(data) {
  unloadPdf();
  const clone = data.slice ? data.slice(0) : data;
  state.pdfDoc = await pdfjsLib.getDocument({ data: clone }).promise;
  state.pageCache = new Array(state.pdfDoc.numPages).fill(null);
}

function unloadPdf() {
  if (state.pdfDoc) { state.pdfDoc.destroy(); state.pdfDoc = null; }
  state.pageCache = null; state.renderedPages.clear();
}

function getRenderWidth() { return Math.max(320, Math.min(dom.readerContent.clientWidth, 720)); }

async function renderPageToUrl(pageNum) {
  if (state.pageCache[pageNum]) return state.pageCache[pageNum];
  const page = await state.pdfDoc.getPage(pageNum + 1);
  const highRes = state.settings.highRes;
  const dpr = Math.min(window.devicePixelRatio || 1, highRes ? 3 : 2);
  const w = Math.max(320, Math.min(dom.readerContent.clientWidth, highRes ? 1080 : 720));
  const scale = (w * dpr) / page.getViewport({ scale: 1 }).width;
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const url = c.toDataURL('image/jpeg', 0.85);
  state.pageCache[pageNum] = url;
  return url;
}

// UI
function renderLibrary() {
  if (state.books.length === 0) {
    dom.bookGrid.innerHTML = '';
    dom.emptyState.classList.remove('hidden');
    return;
  }
  dom.emptyState.classList.add('hidden');
  dom.bookGrid.innerHTML = state.books.map(renderBookCard).join('');
  dom.bookGrid.querySelectorAll('.book-card').forEach((card) => {
    setupSwipe(card);
    card.addEventListener('click', () => openReader(Number(card.dataset.id)));
  });
}

function renderBookCard(book) {
  const p = book._progress || 0;
  const c = book.coverUrl ? `<img src="${book.coverUrl}" alt="" loading="lazy">` : '📄';
  return `<div class="book-card-wrapper"><div class="delete-overlay" data-id="${book.id}"></div><div class="book-card" data-id="${book.id}"><button class="card-delete-btn" data-id="${book.id}" aria-label="Xóa">✕</button><div class="book-cover">${c}</div><div class="book-info"><div class="book-title">${esc(book.title)}</div><div class="book-progress-text">${Math.round(p)}%</div><div class="book-progress-bar"><div class="book-progress-fill" style="width:${p}%"></div></div></div></div></div>`;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function switchView(v) {
  dom.libraryView.classList.toggle('active', v === 'library');
  dom.readerView.classList.toggle('active', v === 'reader');
}

function showLoading(t) { dom.loadingText.textContent = t || 'Đang xử lý...'; dom.loading.classList.remove('hidden'); }
function hideLoading() { dom.loading.classList.add('hidden'); }

// Modal
function showAlert(msg) {
  return new Promise(resolve => {
    dom.modalText.textContent = msg;
    dom.modalButtons.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'modal-btn primary';
    btn.textContent = 'OK';
    btn.addEventListener('click', () => { dom.modal.classList.add('hidden'); resolve(); }, { once: true });
    dom.modalButtons.appendChild(btn);
    dom.modal.classList.remove('hidden');
  });
}

function showConfirm(msg) {
  return new Promise(resolve => {
    dom.modalText.textContent = msg;
    dom.modalButtons.innerHTML = '';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn secondary';
    cancelBtn.textContent = 'Hủy';
    cancelBtn.addEventListener('click', () => { dom.modal.classList.add('hidden'); resolve(false); }, { once: true });
    const okBtn = document.createElement('button');
    okBtn.className = 'modal-btn primary';
    okBtn.textContent = 'Xác nhận';
    okBtn.addEventListener('click', () => { dom.modal.classList.add('hidden'); resolve(true); }, { once: true });
    dom.modalButtons.appendChild(cancelBtn);
    dom.modalButtons.appendChild(okBtn);
    dom.modal.classList.remove('hidden');
  });
}

// Reader
async function openReader(bookId) {
  const book = await dbGet('books', bookId);
  if (!book) return;

  state.currentBook = book;
  state._bookmarks = await loadBookmarks(bookId);
  dom.readerTitle.textContent = book.title;

  if (state.settings.textMode) {
    await openTextReader(book);
  } else {
    await openImageReader(book, bookId);
  }
}

async function openImageReader(book, bookId) {
  const prog = await dbGet('progress', bookId);
  state.currentPage = prog && prog.pageIndex != null ? Math.min(prog.pageIndex, book.totalPages - 1) : 0;

  switchView('reader');
  showLoading('Đang mở sách...');

  try { await loadPdf(book.pdfData); } catch (err) {
    console.error(err);
    await showAlert('Không thể mở file PDF.' + (err.message ? ' (' + err.message.substring(0, 100) + ')' : ''));
    switchView('library'); hideLoading(); return;
  }

  dom.pagesContainer.innerHTML = '';
  for (let i = 0; i < book.totalPages; i++) {
    const div = document.createElement('div');
    div.className = 'pdf-page';
    div.dataset.page = i;

    const ld = document.createElement('div');
    ld.className = 'page-loading';
    ld.textContent = 'Đang tải...';
    div.appendChild(ld);

    const num = document.createElement('div');
    num.className = 'page-number';
    num.textContent = `${i + 1}`;
    div.appendChild(num);

    dom.pagesContainer.appendChild(div);
  }

  hideLoading();

  await renderPageDom(state.currentPage);
  renderPageDom(state.currentPage + 1);
  renderPageDom(state.currentPage + 2);
  renderSidebar();

  updateBookmarkBtn();
  updateProgress();
  applyZoom();

  requestAnimationFrame(() => {
    const el = dom.pagesContainer.querySelector(`[data-page="${state.currentPage}"]`);
    if (el) el.scrollIntoView({ block: 'start' });
  });
}

async function openTextReader(book) {
  state.zoom = 1;
  book = await ensurePageTexts(book);
  if (!book.pageTexts || book.pageTexts.join('').trim().length < 50) {
    if (!await showConfirm('PDF này không có văn bản. Chuyển sang chế độ ảnh?')) {
      switchView('library'); return;
    }
    state.settings.textMode = false;
    saveSettings();
    await openImageReader(book, book.id);
    return;
  }

  const prog = await dbGet('progress', book.id);
  state.currentChapter = prog && prog.chapterIndex != null ? Math.min(prog.chapterIndex, book.chapters.length - 1) : 0;

  switchView('reader');
  showLoading('Đang mở...');

  unloadPdf();
  renderTextContent();

  hideLoading();

  renderSidebar();
  updateBookmarkBtn();
  updateProgress();
  applyZoom();

  requestAnimationFrame(() => {
    const el = dom.pagesContainer.querySelector(`[data-chapter="${state.currentChapter}"]`);
    if (el) el.scrollIntoView({ block: 'start' });
  });
}

async function renderPageDom(pn) {
  const book = state.currentBook;
  if (!book || pn < 0 || pn >= book.totalPages) return;
  if (state.renderedPages.has(pn)) return;
  const div = dom.pagesContainer.querySelector(`[data-page="${pn}"]`);
  if (!div) return;
  try {
    state.renderedPages.add(pn);
    const url = await renderPageToUrl(pn);
    const ld = div.querySelector('.page-loading');
    if (ld) ld.remove();
    const img = document.createElement('img');
    img.src = url; img.alt = `Trang ${pn+1}`; img.loading = 'lazy';
    div.insertBefore(img, div.querySelector('.page-number'));
  } catch (e) {
    console.error(e);
    const ld = div.querySelector('.page-loading');
    if (ld) ld.innerHTML = '<span style="color:var(--danger)">Lỗi</span>';
  }
}

// Navigation
function navToPage(pn) {
  if (!state.currentBook) return;
  const c = Math.max(0, Math.min(pn, state.currentBook.totalPages - 1));
  if (c === state.currentPage) return;
  state.currentPage = c;
  renderPageDom(c); renderPageDom(c + 1);
  const el = dom.pagesContainer.querySelector(`[data-page="${c}"]`);
  if (el) el.scrollIntoView({ block: 'start' });
  updateProgress(); savePosition(); renderSidebar(); updateBookmarkBtn();
}

function navToChapter(ci) {
  if (!state.currentBook) return;
  if (state.settings.textMode) {
    const c = Math.max(0, Math.min(ci, state.currentBook.chapters.length - 1));
    if (c === state.currentChapter) return;
    state.currentChapter = c;
    const el = dom.pagesContainer.querySelector(`[data-chapter="${c}"]`);
    if (el) el.scrollIntoView({ block: 'start' });
    updateProgress(); savePosition(); renderSidebar(); updateBookmarkBtn();
  } else {
    navToPage(state.currentBook.chapterPages[ci] || 0);
  }
}

function goPrevChapter() {
  if (!state.currentBook) return;
  if (state.settings.textMode) {
    if (state.currentChapter > 0) navToChapter(state.currentChapter - 1);
  } else {
    const cp = state.currentBook.chapterPages;
    let prev = -1;
    for (let i = cp.length - 1; i >= 0; i--) { if (cp[i] < state.currentPage) { prev = i; break; } }
    navToChapter(prev >= 0 ? prev : 0);
  }
}

function goNextChapter() {
  if (!state.currentBook) return;
  if (state.settings.textMode) {
    if (state.currentChapter < state.currentBook.chapters.length - 1) navToChapter(state.currentChapter + 1);
  } else {
    const cp = state.currentBook.chapterPages;
    for (let i = 0; i < cp.length; i++) { if (cp[i] > state.currentPage) { navToChapter(i); return; } }
    navToPage(state.currentBook.totalPages - 1);
  }
}

// Progress
let _pt = null;

function updateProgress() {
  if (!state.currentBook) return;
  if (state.settings.textMode) {
    const total = state.currentBook.chapters.length;
    const ch = state.currentChapter;
    const pct = total <= 1 ? 0 : (ch / (total - 1)) * 100;
    dom.progressFill.style.width = `${Math.min(100, pct)}%`;
    dom.progressText.textContent = `${Math.round(pct)}% (${ch+1}/${total})`;
    const idx = state.books.findIndex(b => b.id === state.currentBook.id);
    if (idx >= 0) state.books[idx]._progress = pct;
  } else {
    const total = state.currentBook.totalPages;
    const pct = total <= 1 ? 0 : (state.currentPage / (total - 1)) * 100;
    dom.progressFill.style.width = `${Math.min(100, pct)}%`;
    dom.progressText.textContent = `${Math.round(pct)}% (${state.currentPage+1}/${total})`;
    const idx = state.books.findIndex(b => b.id === state.currentBook.id);
    if (idx >= 0) state.books[idx]._progress = pct;
  }
}

async function savePosition() {
  if (!state.currentBook) return;
  if (state.settings.textMode) {
    await dbPut('progress', { bookId: state.currentBook.id, chapterIndex: state.currentChapter, totalChapters: state.currentBook.chapters.length, updatedAt: Date.now() });
  } else {
    await dbPut('progress', { bookId: state.currentBook.id, pageIndex: state.currentPage, totalPages: state.currentBook.totalPages, updatedAt: Date.now() });
  }
}

function handleTextScroll() {
  if (!state.currentBook) return;
  if (state._scrollRaf) return;
  state._scrollRaf = requestAnimationFrame(() => {
    state._scrollRaf = null;

    const cr = dom.readerContent.getBoundingClientRect();
    const cy = cr.top + cr.height / 2;
    const sections = dom.pagesContainer.querySelectorAll('.text-chapter');
    let best = state.currentChapter, bestV = 0;
    for (let i = 0; i < sections.length; i++) {
      const r = sections[i].getBoundingClientRect();
      const dist = Math.abs((r.top + r.height / 2) - cy);
      const v = 1 - dist / cr.height;
      if (v > bestV && r.bottom > cr.top) { bestV = v; best = i; }
    }
    if (best !== state.currentChapter) {
      state.currentChapter = best; updateProgress(); renderSidebar(); updateBookmarkBtn();
    }
  });

  clearTimeout(_pt);
  _pt = setTimeout(savePosition, 500);
}

function handleScroll() {
  if (!state.currentBook || !state.pdfDoc) return;
  if (state._scrollRaf) return;
  state._scrollRaf = requestAnimationFrame(() => {
    state._scrollRaf = null;

    const cr = dom.readerContent.getBoundingClientRect();
    const cy = cr.top + cr.height / 2;
    let best = state.currentPage, bestV = 0;
    const pages = dom.pagesContainer.querySelectorAll('.pdf-page');
    for (let i = 0; i < pages.length; i++) {
      const r = pages[i].getBoundingClientRect();
      const dist = Math.abs((r.top + r.height/2) - cy);
      const v = 1 - dist / cr.height;
      if (v > bestV && r.bottom > cr.top) { bestV = v; best = parseInt(pages[i].dataset.page); }
    }
    if (best !== state.currentPage) { state.currentPage = best; updateProgress(); renderSidebar(); updateBookmarkBtn(); }

    const st = dom.readerContent.scrollTop;
    const sb = st + cr.height;
    const buf = cr.height * 1.5;
    for (let i = 0; i < pages.length; i++) {
      const pn = parseInt(pages[i].dataset.page);
      if (!state.renderedPages.has(pn) && pages[i].offsetTop < sb + buf) {
        renderPageDom(pn);
      }
    }
  });

  clearTimeout(_pt);
  _pt = setTimeout(savePosition, 500);
}

// Swipe to delete
function setupSwipe(card) {
  const w = card.closest('.book-card-wrapper');
  if (!w) return;
  let sx, sy, cx, sw = false;
  card.addEventListener('touchstart', e => {
    const t = e.touches[0]; sx = t.clientX; sy = t.clientY; cx = 0; sw = false; card.classList.add('swiping');
  }, { passive: true });
  card.addEventListener('touchmove', e => {
    const t = e.touches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dy) > Math.abs(dx) * 1.5) { if (sw) { card.style.transform = ''; sw = false; } return; }
    e.preventDefault(); sw = true;
    if (dx < 0) { cx = Math.max(-80, dx); card.style.transform = `translateX(${cx}px)`; } else card.style.transform = '';
  }, { passive: false });
  card.addEventListener('touchend', () => {
    card.classList.remove('swiping');
    card.style.transform = cx < -50 ? 'translateX(-80px)' : '';
    card.dataset.swiped = cx < -50 ? 'true' : '';
    sw = false;
  }, { passive: true });
}

document.addEventListener('click', e => {
  const o = e.target.closest('.delete-overlay');
  if (o) confirmDelete(Number(o.dataset.id));
  const d = e.target.closest('.card-delete-btn');
  if (d) { e.stopPropagation(); confirmDelete(Number(d.dataset.id)); }
  const s = document.querySelector('.book-card[data-swiped="true"]');
  if (s && !s.contains(e.target) && !e.target.closest('.delete-overlay')) { s.style.transform = ''; s.dataset.swiped = ''; }
});

async function confirmDelete(id) {
  if (!await showConfirm('Xóa sách này khỏi tủ sách?')) return;
  const b = state.books.find(x => x.id === id);
  if (!b) return;
  await dbDel('books', id); await dbDel('progress', id);
  const bms = await dbAllByIndex('bookmarks', 'bookId', id);
  for (const bm of bms) await dbDel('bookmarks', bm.id);
  state.books = state.books.filter(x => x.id !== id);
  renderLibrary();
}

// === Bookmarks ===

function bookmarkPageToChapter(book, pageIndex) {
  const cp = book.chapterPages;
  for (let i = cp.length - 1; i >= 0; i--) {
    if (pageIndex >= cp[i]) return i;
  }
  return 0;
}

async function loadBookmarks(bookId) {
  try {
    const s = await tx('bookmarks', 'readonly');
    const i = s.index('bookId');
    return await new Promise((res, rej) => { const r = i.getAll(bookId); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  } catch { return []; }
}

function getBookmarkKey() {
  const book = state.currentBook;
  if (!book) return null;
  if (state.settings.textMode) {
    const pg = book.chapterPages[state.currentChapter] ?? 0;
    return { pageIndex: pg, chapterIndex: state.currentChapter };
  }
  return { pageIndex: state.currentPage, chapterIndex: bookmarkPageToChapter(book, state.currentPage) };
}

async function toggleBookmark() {
  if (!state.currentBook) return;
  const key = getBookmarkKey();
  if (!key) return;
  const existing = state._bookmarks.find(b => b.pageIndex === key.pageIndex);
  if (existing) {
    await dbDel('bookmarks', existing.id);
    state._bookmarks = state._bookmarks.filter(b => b.id !== existing.id);
  } else {
    const chTitle = state.currentBook.chapters[key.chapterIndex]?.title || `Chương ${key.chapterIndex + 1}`;
    const label = `Trang ${key.pageIndex + 1} - ${chTitle}`;
    const bm = { bookId: state.currentBook.id, pageIndex: key.pageIndex, chapterIndex: key.chapterIndex, label, createdAt: Date.now() };
    bm.id = await dbPut('bookmarks', bm);
    state._bookmarks.push(bm);
  }
  updateBookmarkBtn();
  renderBookmarkList();
}

function updateBookmarkBtn() {
  const key = getBookmarkKey();
  const hasBm = key ? state._bookmarks.some(b => b.pageIndex === key.pageIndex) : false;
  dom.bookmarkBtn.classList.toggle('active', hasBm);
}

function renderBookmarkList() {
  if (state._bookmarks.length === 0) {
    dom.bookmarkList.innerHTML = '<div style="padding:24px 16px;text-align:center;color:var(--text-secondary);font-size:14px">Chưa có đánh dấu nào</div>';
    return;
  }
  dom.bookmarkList.innerHTML = state._bookmarks.map(bm =>
    `<div class="chapter-item" data-bmid="${bm.id}" data-pg="${bm.pageIndex}" data-ch="${bm.chapterIndex}">
      <span class="bm-icon">🔖</span>
      <span class="ch-title">${esc(bm.label)}</span>
      <button class="bm-del" data-bmid="${bm.id}" aria-label="Xóa">✕</button>
    </div>`
  ).join('');

  dom.bookmarkList.querySelectorAll('.chapter-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.bm-del')) return;
      const pg = Number(el.dataset.pg);
      const ch = Number(el.dataset.ch);
      if (state.settings.textMode) {
        navToChapter(ch);
      } else {
        navToPage(pg);
      }
      dom.bookmarkDrawer.classList.add('hidden');
    });
    const del = el.querySelector('.bm-del');
    if (del) del.addEventListener('click', async e => {
      e.stopPropagation();
      const id = Number(del.dataset.bmid);
      await dbDel('bookmarks', id);
      state._bookmarks = state._bookmarks.filter(b => b.id !== id);
      renderBookmarkList();
      updateBookmarkBtn();
    });
  });
}

// Zoom
const ZOOM_LEVELS = [0.75, 1, 1.25, 1.5, 2, 3];

function applyZoom() {
  const z = state.zoom;
  const isImg = state.currentBook && !state.settings.textMode;
  if (isImg && z !== 1) {
    dom.pagesContainer.style.width = (z * 100) + '%';
    dom.pagesContainer.style.maxWidth = 'none';
    dom.readerContent.classList.add('zoomed');
  } else {
    dom.pagesContainer.style.width = '';
    dom.pagesContainer.style.maxWidth = '';
    dom.readerContent.classList.remove('zoomed');
  }
  dom.zoomLabel.textContent = `${z}×`;
  dom.zoomGroup.classList.toggle('hidden', !isImg);
}

// Settings
function loadSettings() {
  try { const s = localStorage.getItem(SETTINGS_KEY); if (s) state.settings = { ...state.settings, ...JSON.parse(s) }; } catch {}
  state.settings.textMode = false;
  applySettings();
}

function applySettings() {
  dom.darkmodeToggle.textContent = state.settings.darkMode ? 'Bật' : 'Tắt';
  dom.darkmodeToggle.classList.toggle('active', state.settings.darkMode);
  dom.highresToggle.textContent = state.settings.highRes ? 'Bật' : 'Tắt';
  dom.highresToggle.classList.toggle('active', state.settings.highRes);
  dom.textmodeToggle.textContent = state.settings.textMode ? 'Bật' : 'Tắt';
  dom.textmodeToggle.classList.toggle('active', state.settings.textMode);
  const hideBm = !state.settings.textMode;
  dom.bookmarkBtn.classList.toggle('hidden', hideBm);
  dom.bookmarkListBtn.classList.toggle('hidden', hideBm);
  dom.parseCollapse.classList.toggle('hidden', !state.currentBook || !state.currentBook.pageTexts);
  document.documentElement.setAttribute('data-theme', state.settings.darkMode ? 'dark' : 'light');
  document.querySelector('meta[name="theme-color"]').content = state.settings.darkMode ? '#121212' : '#faf8f5';
}

function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch {} applySettings(); }

async function reparseBook() {
  const book = state.currentBook;
  if (!book || !book.pdfData) return;
  if (!await showConfirm('Phân tích lại file PDF này? Chapter hiện tại sẽ bị xoá và detect lại.')) return;

  showLoading('Đang phân tích lại...');
  try {
    const pdfDoc = await pdfjsLib.getDocument({ data: book.pdfData.slice(0) }).promise;
    const texts = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      try {
        const page = await pdfDoc.getPage(i);
        texts.push(await extractPageText(page));
      } catch {
        texts.push('');
      }
    }
    pdfDoc.destroy();
    stripRepeatedLines(texts);

    const combined = texts.join('\n\n');
    if (combined.replace(/\s/g, '').length < 50) {
      hideLoading();
      await showAlert('Không tìm thấy văn bản trong file PDF này.');
      return;
    }

    const { chapters, chapterPages } = detectChapters(texts, combined);

    book.pageTexts = texts;
    book.chapters = chapters;
    book.chapterPages = chapterPages;
    await dbPut('books', book);

    hideLoading();

    if (state.settings.textMode) {
      await openTextReader(book);
    } else {
      await openImageReader(book, book.id);
    }
  } catch (e) {
    console.error(e);
    hideLoading();
    await showAlert('Lỗi khi phân tích lại: ' + (e.message || ''));
  }
}

// Events
function setupEvents() {
  dom.addBtn.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', handleFile);

  dom.backBtn.addEventListener('click', async () => {
    await savePosition(); unloadPdf();
    state.currentBook = null; state._bookmarks = []; state.zoom = 1;
    switchView('library'); renderLibrary();
  });

  dom.sidebarToggle.addEventListener('click', () => { renderSidebar(); dom.sidebar.classList.remove('hidden'); });
  dom.sidebarClose.addEventListener('click', () => dom.sidebar.classList.add('hidden'));
  dom.sidebarBackdrop.addEventListener('click', () => dom.sidebar.classList.add('hidden'));
  dom.settingsToggle.addEventListener('click', () => dom.settings.classList.remove('hidden'));
  dom.settingsClose.addEventListener('click', () => dom.settings.classList.add('hidden'));
  dom.settingsBackdrop.addEventListener('click', () => dom.settings.classList.add('hidden'));

  dom.reparseBtn.addEventListener('click', async () => { dom.settings.classList.add('hidden'); await reparseBook(); });
  $('#clean-headers-btn').addEventListener('click', async () => {
    dom.settings.classList.add('hidden');
    if (state.currentBook && state.currentBook.pageTexts) {
      stripRepeatedLines(state.currentBook.pageTexts);
      const combined = state.currentBook.pageTexts.join('\n\n');
      const { chapters, chapterPages } = detectChapters(state.currentBook.pageTexts, combined);
      state.currentBook.chapters = chapters;
      state.currentBook.chapterPages = chapterPages;
      await dbPut('books', state.currentBook);
      if (state.settings.textMode) await openTextReader(state.currentBook);
      else await openImageReader(state.currentBook, state.currentBook.id);
    }
  });

  $('#parse-collapse-toggle').addEventListener('click', () => {
    const isOpen = dom.parseCollapseBody.classList.toggle('open');
    dom.parseChevron.classList.toggle('open', isOpen);
  });

  const tooltip = document.getElementById('info-tooltip');
  let tooltipTarget = null;

  function showTooltip(el) {
    const rect = el.getBoundingClientRect();
    const tip = el.getAttribute('data-tip');
    if (!tip) return;
    tooltip.textContent = tip;
    tooltip.classList.remove('hidden');
    tooltip.style.left = rect.left + rect.width / 2 + 'px';
    tooltip.style.top = rect.top - 12 + 'px';
    tooltip.style.transform = 'translate(-50%,-100%)';
    tooltipTarget = el;
  }

  function hideTooltip() {
    tooltip.classList.add('hidden');
    tooltipTarget = null;
  }

  document.querySelectorAll('.info-icon').forEach(el => {
    if (window.matchMedia('(hover: hover)').matches) {
      el.addEventListener('mouseenter', () => showTooltip(el));
      el.addEventListener('mouseleave', hideTooltip);
    } else {
      el.addEventListener('click', e => {
        e.stopPropagation();
        if (tooltipTarget === el) { hideTooltip(); return; }
        showTooltip(el);
      });
    }
  });
  document.addEventListener('click', e => {
    if (tooltipTarget && !e.target.closest('.info-icon')) hideTooltip();
  });

  dom.bookmarkBtn.addEventListener('click', toggleBookmark);
  dom.bookmarkListBtn.addEventListener('click', () => { renderBookmarkList(); dom.bookmarkDrawer.classList.remove('hidden'); });
  dom.bookmarkClose.addEventListener('click', () => dom.bookmarkDrawer.classList.add('hidden'));
  dom.bookmarkBackdrop.addEventListener('click', () => dom.bookmarkDrawer.classList.add('hidden'));

  document.addEventListener('keydown', e => {
    if (!dom.readerView.classList.contains('active')) return;
    if (e.key === 'ArrowLeft') goPrevChapter();
    if (e.key === 'ArrowRight') goNextChapter();
  });

  dom.darkmodeToggle.addEventListener('click', () => { state.settings.darkMode = !state.settings.darkMode; saveSettings(); });
  dom.highresToggle.addEventListener('click', () => {
    state.settings.highRes = !state.settings.highRes;
    saveSettings();
    if (state.currentBook && state.pdfDoc) {
      state.pageCache = new Array(state.pdfDoc.numPages).fill(null);
      state.renderedPages.clear();
      dom.pagesContainer.querySelectorAll('.pdf-page img').forEach(img => img.remove());
      dom.pagesContainer.querySelectorAll('.page-loading').forEach(el => el.classList.remove('hidden'));
      renderPageDom(state.currentPage);
      renderPageDom(state.currentPage + 1);
    }
  });
  dom.textmodeToggle.addEventListener('click', async () => {
    state.settings.textMode = !state.settings.textMode;
    saveSettings();
    if (state.currentBook && dom.readerView.classList.contains('active')) {
      await savePosition();
      if (state.settings.textMode) {
        openTextReader(state.currentBook);
      } else {
        openImageReader(state.currentBook, state.currentBook.id);
      }
    }
  });

  dom.zoomInBtn.addEventListener('click', () => {
    const idx = ZOOM_LEVELS.indexOf(state.zoom);
    if (idx < ZOOM_LEVELS.length - 1) {
      state.zoom = ZOOM_LEVELS[idx + 1];
      applyZoom();
    }
  });

  dom.zoomOutBtn.addEventListener('click', () => {
    const idx = ZOOM_LEVELS.indexOf(state.zoom);
    if (idx > 0) {
      state.zoom = ZOOM_LEVELS[idx - 1];
      applyZoom();
    }
  });

  dom.readerContent.addEventListener('scroll', () => {
    if (state.settings.textMode && state.currentBook) {
      handleTextScroll();
    } else {
      handleScroll();
    }
  });
}

function renderSidebar() {
  const book = state.currentBook;
  if (!book || !book.chapters) return;

  if (state.settings.textMode) {
    const cur = state.currentChapter;
    dom.chapterList.innerHTML = book.chapters.map((ch, i) => {
      const isCurrent = i === cur;
      const isRead = i < cur;
      return `<div class="chapter-item ${isCurrent ? 'current' : ''}" data-ch="${i}"><span class="ch-check">${isRead ? '✓' : ''}</span><span class="ch-title">${esc(ch.title)}</span></div>`;
    }).join('');
    const rc = cur + 1;
    dom.readCount.textContent = `Đã đọc: ${rc}/${book.chapters.length}`;
  } else {
    const cur = state.currentPage;
    const cp = book.chapterPages;
    dom.chapterList.innerHTML = book.chapters.map((ch, i) => {
      const chP = cp[i] || 0;
      const isCurrent = cur >= chP && (i === cp.length - 1 || cur < (cp[i + 1] || book.totalPages));
      const isRead = cur > chP && !isCurrent;
      return `<div class="chapter-item ${isCurrent ? 'current' : ''}" data-ch="${i}"><span class="ch-check">${isRead ? '✓' : ''}</span><span class="ch-title">${esc(ch.title)}</span></div>`;
    }).join('');
    const rc = book.chapters.filter((_, i) => cur > (cp[i] || 0)).length;
    dom.readCount.textContent = `Đã đọc: ${rc}/${book.chapters.length}`;
  }

  dom.chapterList.querySelectorAll('.chapter-item').forEach(el => {
    el.addEventListener('click', () => { navToChapter(Number(el.dataset.ch)); dom.sidebar.classList.add('hidden'); });
  });
}

// File handling
async function handleFile(e) {
  const file = e.target.files[0];
  dom.fileInput.value = '';
  if (!file) return;
  if (!file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf')) { await showAlert('Chỉ hỗ trợ file PDF'); return; }
  if (file.size > MAX_FILE_SIZE) { await showAlert('File quá lớn (tối đa 7MB)'); return; }

  const existing = state.books.find(b => b.fileName === file.name && b.fileSize === file.size);
  if (existing) { openReader(existing.id); return; }

  showLoading('Đang xử lý PDF...');
  try {
    const data = await parsePDF(file);
    data.id = await dbPut('books', data);
    state.books.push(data);
    switchView('library'); renderLibrary();
    await openReader(data.id);
  } catch (err) {
    console.error(err);
    let msg = 'Không thể đọc file PDF.';
    if (err.name === 'PasswordException') msg = 'File PDF có mật khẩu. Vui lòng mở khóa trước.';
    else if (err.message === 'SCANNED_PDF') msg = 'Không tìm thấy văn bản trong file PDF.';
    else if (err.message && err.message.startsWith('PDFJS_LOAD:'))
      msg = 'PDF.js không thể mở file này. Chi tiết: ' + err.message.replace('PDFJS_LOAD:', '');
    else if (err.message) msg += ' (' + err.message.substring(0, 100) + ')';
    await showAlert(msg);
  } finally { hideLoading(); }
}

// Init
async function init() {
  loadSettings(); setupEvents();
  showLoading('Đang tải...');
  try {
    await openDB(); await dbAll('books').then(b => state.books = b);
    for (const book of state.books) {
      const p = await dbGet('progress', book.id);
      if (p) {
        if (p.pageIndex != null && book.totalPages > 0) {
          book._progress = (p.pageIndex / (book.totalPages - 1)) * 100;
        } else if (p.chapterIndex != null && book.chapters && book.chapters.length > 0) {
          book._progress = (p.chapterIndex / (book.chapters.length - 1)) * 100;
        } else {
          book._progress = 0;
        }
      } else {
        book._progress = 0;
      }
    }
    renderLibrary();
  } catch (e) { console.error(e); } finally { hideLoading(); }
}

document.addEventListener('DOMContentLoaded', init);
