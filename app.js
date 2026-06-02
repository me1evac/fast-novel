const DB_NAME = 'TruyenNhanhDB';
const DB_VER = 1;
const MAX_FILE_SIZE = 7 * 1024 * 1024;
const CHAPTER_PATTERNS = [
  /^(Chương|Chapter|Chapitre)\s*(\d+|[IVXLCDM]+)\b(?:[\s:：]*([\s\S]*?))?$/gim,
  /^(Phần|Part|Tập|Quyển|Book|Volume)\s*(\d+|[IVXLCDM]+)\b(?:[\s:：]*([\s\S]*?))?$/gim,
  /^(Hồi)\s*(\d+)\b(?:[\s:：]*([\s\S]*?))?$/gim,
];
const SECTION_BREAK = /^[\s\-–—=*]{5,}$/gm;
const CHAPTER_TITLE_CLEAN = /^[:\s]+|[:\s]+$/g;
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
  tapLeft: $('#tap-left'), tapRight: $('#tap-right'),
  progressFill: $('#progress-fill'), progressText: $('#progress-text'),
  sidebar: $('#sidebar'), sidebarBackdrop: $('#sidebar-backdrop'),
  sidebarClose: $('#sidebar-close'), chapterList: $('#chapter-list'),
  readCount: $('#read-count'),
  settings: $('#settings'), settingsBackdrop: $('#settings-backdrop'),
  settingsClose: $('#settings-close'), darkmodeToggle: $('#darkmode-toggle'),
};

// State
const state = {
  books: [], currentBook: null, currentPage: 0,
  settings: { darkMode: false },
  pdfDoc: null, pageCache: null,
  renderedPages: new Set(),
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

// PDF Parsing
async function parsePDF(file) {
  const buffer = await file.arrayBuffer();
  const pdfData = buffer.slice(0); // Clone BEFORE passing to PDF.js (worker transfers & detaches original)
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
      const tc = await page.getTextContent();
      pageTexts.push(tc.items.map((item) => item.str).join(' '));
    } catch {
      pageTexts.push('');
    }
  }

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
  };
}

function detectChapters(pageTexts, fullText) {
  const lines = fullText.split('\n');
  const headings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    for (const p of CHAPTER_PATTERNS) {
      p.lastIndex = 0;
      if (p.test(line)) { headings.push({ idx: i, title: line.replace(CHAPTER_TITLE_CLEAN, '') }); break; }
    }
  }

  if (headings.length === 0) return { chapters: [{ id: 0, title: 'Nội dung' }], chapterPages: [0] };

  // Map headings to pages via cumulative line counts
  const cumLines = [];
  let cum = 0;
  for (const t of pageTexts) { cumLines.push(cum); cum += t.split('\n').length; }

  const chapters = [];
  const chapterPages = [];

  for (let i = 0; i < headings.length; i++) {
    let pg = 0;
    for (let p = cumLines.length - 1; p >= 0; p--) { if (headings[i].idx >= cumLines[p]) { pg = p; break; } }
    chapterPages.push(pg);

    const end = i + 1 < headings.length ? headings[i + 1].idx : lines.length;
    const body = lines.slice(headings[i].idx + 1, end).map(l => l.trim()).filter(l => l && !SECTION_BREAK.test(l));
    chapters.push({ id: i, title: headings[i].title || `Chương ${i+1}`, content: body.join('\n') });
  }

  return { chapters, chapterPages };
}

// PDF Runtime
async function loadPdf(data) {
  unloadPdf();
  state.pdfDoc = await pdfjsLib.getDocument({ data }).promise;
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
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = (getRenderWidth() * dpr) / page.getViewport({ scale: 1 }).width;
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

// Reader
async function openReader(bookId) {
  // Reload from IndexedDB to get a fresh, non-detached buffer
  const book = await dbGet('books', bookId);
  if (!book) return;

  state.currentBook = book;
  dom.readerTitle.textContent = book.title;

  const prog = await dbGet('progress', bookId);
  state.currentPage = prog ? Math.min(prog.pageIndex, book.totalPages - 1) : 0;

  switchView('reader');
  showLoading('Đang mở sách...');

  try { await loadPdf(book.pdfData); } catch (err) {
    console.error(err);
    alert('Không thể mở file PDF.' + (err.message ? ' (' + err.message.substring(0, 100) + ')' : ''));
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

  // Render only the current page + 2 buffers ahead — rest is lazy
  await renderPageDom(state.currentPage);
  renderPageDom(state.currentPage + 1);
  renderPageDom(state.currentPage + 2);
  renderSidebar();

  requestAnimationFrame(() => {
    const el = dom.pagesContainer.querySelector(`[data-page="${state.currentPage}"]`);
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
    const url = await renderPageToUrl(pn);
    state.renderedPages.add(pn);
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
  updateProgress(); savePosition(); renderSidebar();
}

function navToChapter(ci) {
  if (!state.currentBook) return;
  navToPage(state.currentBook.chapterPages[ci] || 0);
}

function goPrevChapter() {
  if (!state.currentBook) return;
  const cp = state.currentBook.chapterPages;
  let prev = -1;
  for (let i = cp.length - 1; i >= 0; i--) { if (cp[i] < state.currentPage) { prev = i; break; } }
  navToChapter(prev >= 0 ? prev : 0);
}

function goNextChapter() {
  if (!state.currentBook) return;
  const cp = state.currentBook.chapterPages;
  for (let i = 0; i < cp.length; i++) { if (cp[i] > state.currentPage) { navToChapter(i); return; } }
  navToPage(state.currentBook.totalPages - 1);
}

// Progress
let _pt = null;

function updateProgress() {
  if (!state.currentBook) return;
  const total = state.currentBook.totalPages;
  const pct = total <= 1 ? 0 : (state.currentPage / (total - 1)) * 100;
  dom.progressFill.style.width = `${Math.min(100, pct)}%`;
  dom.progressText.textContent = `${Math.round(pct)}% (${state.currentPage+1}/${total})`;
  const idx = state.books.findIndex(b => b.id === state.currentBook.id);
  if (idx >= 0) state.books[idx]._progress = pct;
}

async function savePosition() {
  if (!state.currentBook) return;
  await dbPut('progress', { bookId: state.currentBook.id, pageIndex: state.currentPage, totalPages: state.currentBook.totalPages, updatedAt: Date.now() });
}

function handleScroll() {
  if (!state.currentBook || !state.pdfDoc) return;
  if (state._scrollRaf) return;
  state._scrollRaf = requestAnimationFrame(() => {
    state._scrollRaf = null;

    // Determine current page by viewport center
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
    if (best !== state.currentPage) { state.currentPage = best; updateProgress(); renderSidebar(); }

    // Lazy render: render unrendered pages within 1.5 viewports ahead
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
  if (!confirm('Xóa sách này khỏi tủ sách?')) return;
  const b = state.books.find(x => x.id === id);
  if (!b) return;
  await dbDel('books', id); await dbDel('progress', id);
  state.books = state.books.filter(x => x.id !== id);
  renderLibrary();
}

// Settings
function loadSettings() {
  try { const s = localStorage.getItem(SETTINGS_KEY); if (s) state.settings = { ...state.settings, ...JSON.parse(s) }; } catch {}
  applySettings();
}

function applySettings() {
  dom.darkmodeToggle.textContent = state.settings.darkMode ? 'Bật' : 'Tắt';
  dom.darkmodeToggle.classList.toggle('active', state.settings.darkMode);
  document.documentElement.setAttribute('data-theme', state.settings.darkMode ? 'dark' : 'light');
  document.querySelector('meta[name="theme-color"]').content = state.settings.darkMode ? '#121212' : '#faf8f5';
}

function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch {} applySettings(); }

// Events
function setupEvents() {
  dom.addBtn.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', handleFile);

  dom.backBtn.addEventListener('click', async () => {
    await savePosition(); unloadPdf(); state.currentBook = null;
    switchView('library'); renderLibrary();
  });

  dom.sidebarToggle.addEventListener('click', () => { renderSidebar(); dom.sidebar.classList.remove('hidden'); });
  dom.sidebarClose.addEventListener('click', () => dom.sidebar.classList.add('hidden'));
  dom.sidebarBackdrop.addEventListener('click', () => dom.sidebar.classList.add('hidden'));
  dom.settingsToggle.addEventListener('click', () => dom.settings.classList.remove('hidden'));
  dom.settingsClose.addEventListener('click', () => dom.settings.classList.add('hidden'));
  dom.settingsBackdrop.addEventListener('click', () => dom.settings.classList.add('hidden'));

  dom.tapLeft.addEventListener('click', goPrevChapter);
  dom.tapRight.addEventListener('click', goNextChapter);

  document.addEventListener('keydown', e => {
    if (!dom.readerView.classList.contains('active')) return;
    if (e.key === 'ArrowLeft') goPrevChapter();
    if (e.key === 'ArrowRight') goNextChapter();
  });

  dom.darkmodeToggle.addEventListener('click', () => { state.settings.darkMode = !state.settings.darkMode; saveSettings(); });
  dom.readerContent.addEventListener('scroll', handleScroll);
}

function renderSidebar() {
  const book = state.currentBook;
  if (!book || !book.chapters) return;
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

  dom.chapterList.querySelectorAll('.chapter-item').forEach(el => {
    el.addEventListener('click', () => { navToChapter(Number(el.dataset.ch)); dom.sidebar.classList.add('hidden'); });
  });
}

// File handling
async function handleFile(e) {
  const file = e.target.files[0];
  dom.fileInput.value = '';
  if (!file) return;
  if (!file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf')) { alert('Chỉ hỗ trợ file PDF'); return; }
  if (file.size > MAX_FILE_SIZE) { alert('File quá lớn (tối đa 7MB)'); return; }

  const existing = state.books.find(b => b.fileName === file.name && b.fileSize === file.size);
  if (existing) { openReader(existing.id); return; }

  showLoading('Đang xử lý PDF...');
  try {
    const data = await parsePDF(file);
    data.id = await dbPut('books', data);
    state.books.push(data);
    switchView('library'); renderLibrary();
    openReader(data.id);
  } catch (err) {
    console.error(err);
    let msg = 'Không thể đọc file PDF.';
    if (err.name === 'PasswordException') msg = 'File PDF có mật khẩu. Vui lòng mở khóa trước.';
    else if (err.message === 'SCANNED_PDF') msg = 'Không tìm thấy văn bản trong file PDF.';
    else if (err.message && err.message.startsWith('PDFJS_LOAD:'))
      msg = 'PDF.js không thể mở file này. Chi tiết: ' + err.message.replace('PDFJS_LOAD:', '');
    else if (err.message) msg += ' (' + err.message.substring(0, 100) + ')';
    alert(msg);
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
      book._progress = p && book.totalPages > 0 ? (p.pageIndex / (book.totalPages - 1)) * 100 : 0;
    }
    renderLibrary();
  } catch (e) { console.error(e); } finally { hideLoading(); }
}

document.addEventListener('DOMContentLoaded', init);
