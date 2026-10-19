import { WebGpuCardMediaEngine } from './webgpu-media.js';

const gpuMedia = new WebGpuCardMediaEngine();

const state = {
  filter: 'all', // 'all' | 'keywords' | 'saved' | 'notes'
  categoryId: null,
  feedId: null,
  viewTitle: 'Todas las noticias',
  search: '',
  sidebar: {
    categories: [],
    feeds: [],
    totals: { all: 0, saved: 0, feedsTotal: 0, feedsWithError: 0 },
    canUndoCount: 0,
    syncStatus: { isSyncing: false, completed: 0, total: 0 }
  },
  articles: [],
  activeArticle: null,
  managerSelectedIds: new Set(),
  expandedCategories: new Set()
};

// Referencias DOM
const elAppShell = document.getElementById('app-shell');
const elGpuBadge = document.getElementById('gpu-badge');
const elCountAll = document.getElementById('count-all');
const elCountSaved = document.getElementById('count-saved');
const elCountFeedsTotal = document.getElementById('count-feeds-total');
const elCategoriesTree = document.getElementById('categories-tree');
const elViewTitle = document.getElementById('current-view-title');
const elViewSubtitle = document.getElementById('current-view-subtitle');
const elSearchInput = document.getElementById('search-input');
const elBtnClearSearch = document.getElementById('btn-clear-search');
const elBtnUndo = document.getElementById('btn-undo-dismiss');
const elSelectCols = document.getElementById('select-columns');
const elSelectTone = document.getElementById('select-tone-mode');
const elBtnMarkAllRead = document.getElementById('btn-mark-all-read');
const elBtnSync = document.getElementById('btn-sync');
const elSyncLabel = document.getElementById('sync-label');
const elCardsGrid = document.getElementById('cards-grid');
const elEmptyState = document.getElementById('empty-state');

// Reader Drawer DOM
const elReaderBackdrop = document.getElementById('reader-backdrop');
const elReaderDrawer = document.getElementById('reader-drawer');
const elReaderFeedTitle = document.getElementById('reader-feed-title');
const elReaderDate = document.getElementById('reader-date');
const elReaderTitle = document.getElementById('reader-title');
const elReaderLinkOriginal = document.getElementById('reader-link-original');
const elReaderNoteInput = document.getElementById('reader-note-input');
const elReaderBtnSaveNote = document.getElementById('reader-btn-save-note');
const elReaderBtnSave = document.getElementById('reader-btn-save');
const elReaderBtnReadDelete = document.getElementById('reader-btn-read-delete');
const elReaderBtnFulltext = document.getElementById('reader-btn-fulltext');
const elReaderContent = document.getElementById('reader-content');
const elReaderBtnClose = document.getElementById('reader-btn-close');

// Modal Añadir Fuente / Búsqueda por Palabra Clave
const elAddFeedDialog = document.getElementById('add-feed-dialog');
const elAddKeywordForm = document.getElementById('add-keyword-form');
const elInputKwQuery = document.getElementById('input-kw-query');
const elSelectKwProvider = document.getElementById('select-kw-provider');
const elInputKwCategory = document.getElementById('input-kw-category');
const elRedditExtraFields = document.getElementById('reddit-extra-fields');
const elFieldRedditSub = document.getElementById('field-reddit-sub');
const elInputKwSubreddit = document.getElementById('input-kw-subreddit');
const elSelectKwSort = document.getElementById('select-kw-sort');
const elInputKwTitle = document.getElementById('input-kw-title');
const elAddKwError = document.getElementById('add-kw-error');
const elBtnSubmitKw = document.getElementById('btn-submit-kw');

const elAddFeedForm = document.getElementById('add-feed-form');
const elInputFeedUrl = document.getElementById('input-feed-url');
const elInputFeedCategory = document.getElementById('input-feed-category');
const elInputFeedTitle = document.getElementById('input-feed-title');
const elExistingCategories = document.getElementById('existing-categories');
const elAddFeedError = document.getElementById('add-feed-error');
const elBtnSubmitAddFeed = document.getElementById('btn-submit-add-feed');

// Modal Gestor y Limpieza de Fuentes
const elManageDialog = document.getElementById('manage-feeds-dialog');
const elManageSummary = document.getElementById('manage-feeds-summary');
const elManagerSearchInput = document.getElementById('manager-search-input');
const elManagerCategoryFilter = document.getElementById('manager-category-filter');
const elManagerStatusFilter = document.getElementById('manager-status-filter');
const elManagerFeedsList = document.getElementById('manager-feeds-list');
const elBtnBulkDelete = document.getElementById('btn-bulk-delete');
const elBulkSelectedCount = document.getElementById('bulk-selected-count');

// Modal Importar OPML
const elImportOpmlDialog = document.getElementById('import-opml-dialog');
const elImportOpmlForm = document.getElementById('import-opml-form');
const elInputOpmlFile = document.getElementById('input-opml-file');

const dateTimeFormatter = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
});

function formatPubDate(tsOrIso) {
  try {
    const d = new Date(tsOrIso);
    if (Number.isNaN(d.getTime())) return '';
    return dateTimeFormatter.format(d);
  } catch {
    return '';
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================================
// Carga de datos y seguimiento de sincronización en vivo
// ============================================================================

let syncPollTimer = null;

async function fetchState() {
  const params = new URLSearchParams();
  if (state.feedId) params.set('feedId', state.feedId);
  if (state.categoryId) params.set('categoryId', state.categoryId);
  if (state.filter) params.set('filter', state.filter);
  if (state.search) params.set('search', state.search);

  const res = await fetch(`/api/state?${params.toString()}`);
  if (!res.ok) throw new Error('Error al obtener estado');
  const data = await res.json();

  state.sidebar = data.sidebar;
  state.articles = data.articles;

  renderSidebar();
  renderTopbar();
  renderCardsGrid();
  if (elManageDialog.open) {
    renderFeedManagerList();
  }

  // Si el servidor está sincronizando lotes en segundo plano, hacer polling suave
  const ss = state.sidebar.syncStatus;
  if (ss && ss.isSyncing) {
    elBtnSync.classList.add('syncing');
    elSyncLabel.textContent = `Sincronizando ${ss.completed}/${ss.total}`;
    if (!syncPollTimer) {
      syncPollTimer = setTimeout(() => {
        syncPollTimer = null;
        fetchState().catch(() => {});
      }, 2200);
    }
  } else {
    elBtnSync.classList.remove('syncing');
    elSyncLabel.textContent = 'Recargar';
  }
}

async function triggerSync() {
  elBtnSync.classList.add('syncing');
  elSyncLabel.textContent = 'Iniciando...';
  const payload = {};
  if (state.feedId) payload.feedId = state.feedId;
  else if (state.categoryId) payload.categoryId = state.categoryId;

  await fetch('/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  await fetchState();
}

// ============================================================================
// Renderizado del Panel Izquierdo (Sidebar)
// ============================================================================

function renderSidebar() {
  elCountAll.textContent = state.sidebar.totals.all;
  elCountSaved.textContent = state.sidebar.totals.saved;
  elCountFeedsTotal.textContent = state.sidebar.totals.feedsTotal || state.sidebar.feeds.length;

  document.querySelectorAll('.nav-section .nav-item').forEach((btn) => {
    const view = btn.dataset.view;
    const isActive = !state.feedId && !state.categoryId && state.filter === view;
    btn.classList.toggle('active', isActive);
  });

  elExistingCategories.innerHTML = state.sidebar.categories
    .map((c) => `<option value="${escapeHtml(c.name)}"></option>`)
    .join('');

  const fragment = document.createDocumentFragment();

  for (const cat of state.sidebar.categories) {
    const feedsInCat = state.sidebar.feeds.filter((f) => f.category_id === cat.id);
    if (feedsInCat.length === 0) continue;

    const catCount = feedsInCat.reduce((acc, f) => acc + (Number(f.article_count) || 0), 0);
    const hasActiveFeedInside = feedsInCat.some((f) => f.id === state.feedId);
    const isCatActive = state.categoryId === cat.id || (!state.expandedCategories.has(cat.id) && hasActiveFeedInside);

    const catBlock = document.createElement('details');
    catBlock.className = 'category-block';
    if (state.expandedCategories.has(cat.id)) {
      catBlock.open = true;
    }

    const catSummary = document.createElement('summary');
    catSummary.className = 'category-header' + (isCatActive ? ' active' : '');
    catSummary.innerHTML = `
      <span class="cat-chevron" title="Desplegar / contraer fuentes" aria-hidden="true">▸</span>
      <span class="nav-item-label">${escapeHtml(cat.name)}</span>
      <span class="nav-count">${catCount}</span>
    `;

    catSummary.addEventListener('click', (e) => {
      e.preventDefault();
      const clickedChevron = e.target.closest('.cat-chevron');
      const currentlyOpen = state.expandedCategories.has(cat.id);

      if (clickedChevron) {
        if (currentlyOpen) {
          state.expandedCategories.delete(cat.id);
          catBlock.open = false;
        } else {
          state.expandedCategories.add(cat.id);
          catBlock.open = true;
        }
        return;
      }

      if (!currentlyOpen) {
        // Si estaba cerrada: desplegar sus fuentes y mostrar las noticias de la categoría
        state.expandedCategories.add(cat.id);
        catBlock.open = true;
        state.categoryId = cat.id;
        state.feedId = null;
        state.filter = 'all';
        state.viewTitle = cat.name;
        fetchState();
      } else {
        // Si estaba abierta: contraer la lista de fuentes (y si estábamos dentro de una fuente hija, volver a la categoría)
        state.expandedCategories.delete(cat.id);
        catBlock.open = false;
        if (state.categoryId !== cat.id || state.feedId !== null) {
          state.categoryId = cat.id;
          state.feedId = null;
          state.filter = 'all';
          state.viewTitle = cat.name;
          fetchState();
        }
      }
    });

    // Sincronizar si el navegador abre el <details> automáticamente (p. ej. al buscar en página con Cmd+F)
    catBlock.addEventListener('toggle', () => {
      if (catBlock.open) {
        state.expandedCategories.add(cat.id);
      } else {
        state.expandedCategories.delete(cat.id);
      }
    });

    catBlock.appendChild(catSummary);

    const feedsListEl = document.createElement('div');
    feedsListEl.className = 'category-feeds-list';

    for (const feed of feedsInCat) {
      const row = document.createElement('div');
      row.className = 'feed-row' + (state.feedId === feed.id ? ' active' : '');

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'feed-select-btn';
      selectBtn.title = feed.error_msg
        ? `⚠ Error: ${feed.error_msg}\n(${feed.feed_url})`
        : `${feed.title}\n(${feed.feed_url})`;
      selectBtn.innerHTML = `
        <span class="feed-title-text">${escapeHtml(feed.title)}</span>
        <span class="nav-count">${feed.error_msg ? '!' : feed.article_count || 0}</span>
      `;
      selectBtn.addEventListener('click', () => {
        state.expandedCategories.add(cat.id);
        state.feedId = feed.id;
        state.categoryId = null;
        state.filter = 'all';
        state.viewTitle = feed.title;
        fetchState();
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-delete-feed';
      delBtn.title = `Eliminar fuente «${feed.title}» inmediatamente`;
      delBtn.textContent = '×';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch(`/api/feeds/${feed.id}`, { method: 'DELETE' });
        if (state.feedId === feed.id) {
          state.feedId = null;
          state.viewTitle = 'Todas las noticias';
        }
        await fetchState();
      });

      row.appendChild(selectBtn);
      row.appendChild(delBtn);
      feedsListEl.appendChild(row);
    }

    catBlock.appendChild(feedsListEl);
    fragment.appendChild(catBlock);
  }

  elCategoriesTree.replaceChildren(fragment);
}

function renderTopbar() {
  elViewTitle.textContent = state.viewTitle;
  const count = state.articles.length;
  elViewSubtitle.textContent = count === 1 ? '1 noticia' : `${count} noticias mostradas`;
  elBtnUndo.hidden = !(state.sidebar.canUndoCount > 0);
}

// ============================================================================
// Renderizado de las Tarjetas (3 por fila + WebGPU/WGSL)
// ============================================================================

function renderCardsGrid() {
  if (state.articles.length === 0) {
    elCardsGrid.replaceChildren();
    elEmptyState.hidden = false;
    return;
  }

  elEmptyState.hidden = true;
  const fragment = document.createDocumentFragment();

  for (const article of state.articles) {
    const isSaved = article.is_saved === 1;
    const hasNote = Boolean(article.note && article.note.trim());

    const card = document.createElement('article');
    card.className = 'news-card' + (hasNote ? ' has-note' : '');
    card.dataset.id = article.id;

    // 1. Cabecera de Imagen 16:9 procesada con WebGPU/WGSL
    const mediaWrap = document.createElement('div');
    mediaWrap.className = 'card-media-wrap';

    const canvas = document.createElement('canvas');
    canvas.className = 'card-media-canvas';
    canvas.width = 640;
    canvas.height = 360;
    mediaWrap.appendChild(canvas);

    if (hasNote || isSaved) {
      const badge = document.createElement('span');
      badge.className = 'card-badge-saved' + (hasNote ? ' is-note' : '');
      badge.textContent = hasNote ? 'Con nota' : 'Guardada';
      mediaWrap.appendChild(badge);
    }

    mediaWrap.addEventListener('click', () => openReaderDrawer(article));
    gpuMedia.attachCardCanvas(canvas, article.id, article.title);

    card.addEventListener('mouseenter', () => gpuMedia.setCardHover(canvas, true));
    card.addEventListener('mouseleave', () => gpuMedia.setCardHover(canvas, false));

    // 2. Título de la noticia
    const titleWrap = document.createElement('div');
    titleWrap.className = 'card-title-wrap';
    const h2 = document.createElement('h2');
    h2.className = 'card-title';
    h2.textContent = article.title;
    h2.addEventListener('click', () => openReaderDrawer(article));
    titleWrap.appendChild(h2);

    // 3. Origen, Fecha y Hora enlazado al original
    const metaRow = document.createElement('div');
    metaRow.className = 'card-meta';
    const formattedDate = formatPubDate(article.published_ts || article.pub_date);
    const originLabel =
      article.author && article.feed_type === 'keyword_google'
        ? `${article.feed_title} · ${article.author}`
        : article.feed_title;

    metaRow.innerHTML = `
      <span class="card-origin" title="${escapeHtml(originLabel)}">${escapeHtml(originLabel)}</span>
      <span aria-hidden="true">·</span>
      <a
        href="${escapeHtml(article.link)}"
        target="_blank"
        rel="noopener noreferrer"
        class="card-original-link"
        title="Abrir noticia original en pestaña nueva"
      >${escapeHtml(formattedDate)} ↗</a>
    `;

    // 4. Pequeño extracto del contenido debajo
    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'card-body';

    const pExcerpt = document.createElement('p');
    pExcerpt.className = 'card-excerpt';
    pExcerpt.textContent =
      article.excerpt ||
      'Sin resumen adicional en el feed. Pulsa para abrir el lector o visitar el enlace original.';
    bodyWrap.appendChild(pExcerpt);

    if (hasNote) {
      const noteDiv = document.createElement('div');
      noteDiv.className = 'card-note-preview';
      noteDiv.textContent = `Nota: ${article.note}`;
      bodyWrap.appendChild(noteDiv);
    }

    // 5. Pie de acciones
    const footer = document.createElement('footer');
    footer.className = 'card-footer';

    const btnRead = document.createElement('button');
    btnRead.type = 'button';
    btnRead.className = 'card-action-btn';
    if (isSaved || hasNote) {
      btnRead.textContent = 'Protegida (Guardada)';
      btnRead.title =
        'Esta noticia está guardada o tiene nota, por lo que no se elimina al marcar como leída.';
    } else {
      btnRead.textContent = '✓ Leída (Eliminar)';
      btnRead.title = 'Marcar como leída y eliminar inmediatamente de la lista';
    }
    btnRead.addEventListener('click', () => markReadAndDelete([article.id]));

    const rightActions = document.createElement('div');
    rightActions.className = 'card-action-Group';

    const btnSave = document.createElement('button');
    btnSave.type = 'button';
    btnSave.className = 'card-action-btn' + (isSaved ? ' is-active' : '');
    btnSave.textContent = isSaved ? '★ Guardada' : '☆ Guardar';
    btnSave.title = 'Guardar noticia para evitar su eliminación al leer';
    btnSave.addEventListener('click', () => toggleSaveArticle(article));

    const btnNote = document.createElement('button');
    btnNote.type = 'button';
    btnNote.className = 'card-action-btn' + (hasNote ? ' is-active' : '');
    btnNote.textContent = hasNote ? '✎ Nota' : '+ Nota';
    btnNote.title = 'Añadir o editar nota en esta noticia';
    btnNote.addEventListener('click', () => {
      openReaderDrawer(article);
      setTimeout(() => elReaderNoteInput.focus(), 120);
    });

    rightActions.appendChild(btnSave);
    rightActions.appendChild(btnNote);

    footer.appendChild(btnRead);
    footer.appendChild(rightActions);

    card.appendChild(mediaWrap);
    card.appendChild(titleWrap);
    card.appendChild(metaRow);
    card.appendChild(bodyWrap);
    card.appendChild(footer);

    fragment.appendChild(card);
  }

  elCardsGrid.replaceChildren(fragment);
}

// ============================================================================
// Gestor y Limpieza de Fuentes en Lote (Feed Manager)
// ============================================================================

function openFeedManager() {
  state.managerSelectedIds.clear();
  // Poblar selector de carpetas
  const currentCatVal = elManagerCategoryFilter.value;
  elManagerCategoryFilter.innerHTML =
    `<option value="">Todas las carpetas</option>` +
    state.sidebar.categories
      .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
      .join('');
  elManagerCategoryFilter.value = currentCatVal;

  renderFeedManagerList();
  elManageDialog.showModal();
}

function getFilteredManagerFeeds() {
  const q = (elManagerSearchInput.value || '').trim().toLowerCase();
  const catId = elManagerCategoryFilter.value ? Number(elManagerCategoryFilter.value) : null;
  const status = elManagerStatusFilter.value || 'all';

  return state.sidebar.feeds.filter((f) => {
    if (catId && f.category_id !== catId) return false;
    if (status === 'error' && !f.error_msg) return false;
    if (status === 'empty' && (Number(f.article_count) || 0) > 0) return false;
    if (status === 'keywords' && !(f.feed_type && f.feed_type.startsWith('keyword_'))) return false;
    if (q) {
      const hay = `${f.title} ${f.feed_url} ${f.site_url} ${f.category_name}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function updateBulkSelectionButtons() {
  const count = state.managerSelectedIds.size;
  elBulkSelectedCount.textContent = count;
  elBtnBulkDelete.disabled = count === 0;
}

function renderFeedManagerList() {
  const allFeeds = state.sidebar.feeds;
  const errCount = allFeeds.filter((f) => Boolean(f.error_msg)).length;
  const filtered = getFilteredManagerFeeds();

  elManageSummary.textContent = `${allFeeds.length} fuentes totales · ${errCount} con error de conexión · Mostrando ${filtered.length}`;
  updateBulkSelectionButtons();

  const fragment = document.createDocumentFragment();

  for (const feed of filtered) {
    const row = document.createElement('div');
    row.className = 'manager-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.managerSelectedIds.has(feed.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.managerSelectedIds.add(feed.id);
      else state.managerSelectedIds.delete(feed.id);
      updateBulkSelectionButtons();
    });

    const typeLabel =
      feed.feed_type === 'keyword_google'
        ? 'Google News'
        : feed.feed_type === 'keyword_reddit'
        ? 'Reddit Search'
        : feed.feed_type === 'reddit_sub'
        ? 'Reddit'
        : feed.feed_type === 'keyword_hn'
        ? 'HN Search'
        : 'RSS';

    const info = document.createElement('div');
    info.className = 'manager-item-info';
    info.innerHTML = `
      <div class="manager-item-title-row">
        <span class="manager-item-title" title="${escapeHtml(feed.title)}">${escapeHtml(feed.title)}</span>
        <span class="manager-type-pill">${typeLabel}</span>
      </div>
      <span class="manager-item-url" title="${escapeHtml(feed.feed_url)}">${escapeHtml(feed.feed_url)}</span>
    `;

    // Selector rápido para mover de carpeta
    const catSelect = document.createElement('select');
    catSelect.className = 'select-minimal';
    catSelect.title = 'Cambiar carpeta';
    catSelect.innerHTML = state.sidebar.categories
      .map(
        (c) =>
          `<option value="${escapeHtml(c.name)}" ${
            c.id === feed.category_id ? 'selected' : ''
          }>${escapeHtml(c.name)}</option>`
      )
      .join('');
    catSelect.addEventListener('change', async () => {
      await fetch(`/api/feeds/${feed.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryName: catSelect.value })
      });
      await fetchState();
    });

    const statusSpan = document.createElement('span');
    statusSpan.className = 'manager-status' + (feed.error_msg ? ' is-error' : '');
    statusSpan.title = feed.error_msg || `${feed.article_count || 0} noticias disponibles`;
    statusSpan.textContent = feed.error_msg
      ? `⚠ ${feed.error_msg}`
      : `${feed.article_count || 0} noticias`;

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-subtle';
    delBtn.textContent = 'Eliminar';
    delBtn.addEventListener('click', async () => {
      state.managerSelectedIds.delete(feed.id);
      await fetch(`/api/feeds/${feed.id}`, { method: 'DELETE' });
      if (state.feedId === feed.id) {
        state.feedId = null;
        state.viewTitle = 'Todas las noticias';
      }
      await fetchState();
    });

    row.appendChild(checkbox);
    row.appendChild(info);
    row.appendChild(catSelect);
    row.appendChild(statusSpan);
    row.appendChild(delBtn);

    fragment.appendChild(row);
  }

  elManagerFeedsList.replaceChildren(fragment);
}

// ============================================================================
// Acciones de Noticias y Lector Lateral
// ============================================================================

async function markReadAndDelete(articleIds) {
  if (!articleIds || articleIds.length === 0) return;
  const res = await fetch('/api/articles/mark-read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ articleIds })
  });
  if (!res.ok) return;
  const data = await res.json();

  if (state.activeArticle && data.deletedIds.includes(state.activeArticle.id)) {
    closeReaderDrawer();
  }
  await fetchState();
}

async function toggleSaveArticle(article, customNote = undefined) {
  const payload = {
    isSaved: customNote !== undefined ? true : !(article.is_saved === 1)
  };
  if (customNote !== undefined) {
    payload.note = customNote;
  }

  const res = await fetch(`/api/articles/${article.id}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) return;
  const data = await res.json();
  if (state.activeArticle && state.activeArticle.id === article.id) {
    state.activeArticle = { ...state.activeArticle, ...data.article };
    syncReaderDrawerButtons();
  }
  await fetchState();
}

function openReaderDrawer(article) {
  state.activeArticle = article;
  elReaderFeedTitle.textContent = article.feed_title || '';
  elReaderDate.textContent = formatPubDate(article.published_ts || article.pub_date);
  elReaderTitle.textContent = article.title;
  elReaderLinkOriginal.href = article.link;
  elReaderNoteInput.value = article.note || '';

  if (article.content_html && article.content_html.trim()) {
    elReaderContent.innerHTML = sanitizeFeedHtml(article.content_html);
  } else {
    elReaderContent.innerHTML = `<p>${escapeHtml(article.excerpt || '')}</p>`;
  }

  syncReaderDrawerButtons();
  elReaderBackdrop.hidden = false;
  elReaderDrawer.classList.add('open');
  elReaderDrawer.setAttribute('aria-hidden', 'false');
}

function syncReaderDrawerButtons() {
  if (!state.activeArticle) return;
  const isSaved = state.activeArticle.is_saved === 1;
  const hasNote = Boolean(state.activeArticle.note && state.activeArticle.note.trim());
  elReaderBtnSave.textContent = isSaved ? '★ Guardada (Protegida)' : '☆ Guardar (Proteger)';
  elReaderBtnReadDelete.disabled = isSaved || hasNote;
  elReaderBtnReadDelete.textContent =
    isSaved || hasNote
      ? 'Noticia protegida (Guardada)'
      : '✓ Marcar leída y eliminar';
}

function closeReaderDrawer() {
  elReaderDrawer.classList.remove('open');
  elReaderDrawer.setAttribute('aria-hidden', 'true');
  elReaderBackdrop.hidden = true;
  state.activeArticle = null;
}

function sanitizeFeedHtml(rawHtml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawHtml, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, form').forEach((el) => el.remove());
  doc.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return doc.body.innerHTML;
}

// ============================================================================
// Eventos de Interfaz
// ============================================================================

function bindEvents() {
  document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
    elAppShell.classList.toggle('sidebar-collapsed');
  });

  document.querySelectorAll('.nav-section .nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      state.filter = view;
      state.feedId = null;
      state.categoryId = null;
      state.viewTitle =
        view === 'saved'
          ? 'Noticias guardadas'
          : view === 'notes'
          ? 'Noticias con notas'
          : view === 'keywords'
          ? 'Alertas de búsqueda (Google / Reddit / HN)'
          : 'Todas las noticias';
      fetchState();
    });
  });

  // Buscador instantáneo FTS5
  let searchDebounce = null;
  elSearchInput.addEventListener('input', () => {
    const val = elSearchInput.value;
    elBtnClearSearch.hidden = !val;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.search = val;
      fetchState();
    }, 180);
  });

  elBtnClearSearch.addEventListener('click', () => {
    elSearchInput.value = '';
    elBtnClearSearch.hidden = true;
    state.search = '';
    fetchState();
  });

  elSelectCols.addEventListener('change', () => {
    const val = elSelectCols.value;
    if (val === 'auto') {
      elCardsGrid.removeAttribute('data-fixed-cols');
    } else {
      elCardsGrid.setAttribute('data-fixed-cols', val);
    }
  });

  elSelectTone.addEventListener('change', () => {
    gpuMedia.setToneMode(Number(elSelectTone.value));
  });

  elBtnMarkAllRead.addEventListener('click', async () => {
    const deletableIds = state.articles
      .filter((a) => a.is_saved !== 1 && (!a.note || !a.note.trim()))
      .map((a) => a.id);
    if (deletableIds.length === 0) return;
    await markReadAndDelete(deletableIds);
  });

  elBtnUndo.addEventListener('click', async () => {
    const res = await fetch('/api/articles/undo-dismiss', { method: 'POST' });
    if (res.ok) await fetchState();
  });

  elBtnSync.addEventListener('click', () => triggerSync());

  // Reader Drawer
  elReaderBtnClose.addEventListener('click', closeReaderDrawer);
  elReaderBackdrop.addEventListener('click', closeReaderDrawer);
  elReaderBtnReadDelete.addEventListener('click', () => {
    if (state.activeArticle) markReadAndDelete([state.activeArticle.id]);
  });
  elReaderBtnSave.addEventListener('click', () => {
    if (state.activeArticle) toggleSaveArticle(state.activeArticle);
  });
  elReaderBtnSaveNote.addEventListener('click', () => {
    if (state.activeArticle) toggleSaveArticle(state.activeArticle, elReaderNoteInput.value);
  });

  elReaderBtnFulltext.addEventListener('click', async () => {
    if (!state.activeArticle) return;
    elReaderBtnFulltext.textContent = 'Extrayendo artículo original...';
    elReaderBtnFulltext.disabled = true;
    try {
      const res = await fetch(`/api/articles/${state.activeArticle.id}/fulltext`);
      const data = await res.json();
      if (data.paragraphs && data.paragraphs.length > 0) {
        elReaderContent.innerHTML = data.paragraphs
          .map((p) => `<${p.tag}>${escapeHtml(p.text)}</${p.tag}>`)
          .join('');
      }
    } finally {
      elReaderBtnFulltext.textContent = 'Extraer texto completo del artículo original';
      elReaderBtnFulltext.disabled = false;
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && elReaderDrawer.classList.contains('open')) {
      closeReaderDrawer();
    }
  });

  // Pestañas dentro del modal "+ Añadir Fuente / Alerta"
  document.querySelectorAll('.modal-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      const target = tabBtn.dataset.tab;
      document.querySelectorAll('.modal-tab').forEach((b) => b.classList.toggle('active', b === tabBtn));
      document.querySelectorAll('.tab-panel').forEach((panel) => {
        panel.hidden = panel.dataset.panel !== target;
      });
    });
  });

  // Chips de sugerencias rápidas ("Inteligencia Artificial", "Gemini", "Claude"...)
  document.querySelectorAll('.chip-btn').forEach((chip) => {
    chip.addEventListener('click', () => {
      elInputKwQuery.value = chip.dataset.kw || '';
      elInputKwQuery.focus();
    });
  });

  // Mostrar/ocultar opciones extra cuando se elige Reddit
  elSelectKwProvider.addEventListener('change', () => {
    const val = elSelectKwProvider.value;
    const isReddit = val === 'reddit_search' || val === 'reddit_subreddit';
    elRedditExtraFields.hidden = !isReddit;
    elFieldRedditSub.hidden = val !== 'reddit_search';
  });

  const openAddModal = () => {
    elAddKwError.hidden = true;
    elAddFeedError.hidden = true;
    elInputKwQuery.value = '';
    elInputKwTitle.value = '';
    elInputFeedUrl.value = '';
    elInputFeedTitle.value = '';
    elAddFeedDialog.showModal();
    elInputKwQuery.focus();
  };

  document.getElementById('btn-open-add-feed').addEventListener('click', openAddModal);
  document.getElementById('btn-add-feed-bottom').addEventListener('click', openAddModal);
  document.getElementById('btn-close-add-feed').addEventListener('click', () => elAddFeedDialog.close());
  document.querySelectorAll('.btn-cancel-add').forEach((btn) => {
    btn.addEventListener('click', () => elAddFeedDialog.close());
  });

  // Envío de formulario 1: Búsqueda por Palabra Clave (Google News / Reddit / HN)
  elAddKeywordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    elAddKwError.hidden = true;
    elBtnSubmitKw.disabled = true;
    elBtnSubmitKw.textContent = 'Creando y buscando noticias...';

    try {
      const res = await fetch('/api/feeds/keyword', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: elInputKwQuery.value,
          provider: elSelectKwProvider.value,
          categoryName: elInputKwCategory.value,
          subreddit: elInputKwSubreddit.value,
          sort: elSelectKwSort.value,
          title: elInputKwTitle.value
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo crear la alerta de búsqueda');

      elAddFeedDialog.close();
      if (data.feed.category_id) state.expandedCategories.add(data.feed.category_id);
      state.feedId = data.feed.id;
      state.categoryId = null;
      state.viewTitle = data.feed.title;
      await fetchState();
    } catch (err) {
      elAddKwError.textContent = err.message;
      elAddKwError.hidden = false;
    } finally {
      elBtnSubmitKw.disabled = false;
      elBtnSubmitKw.textContent = 'Crear fuente de búsqueda';
    }
  });

  // Envío de formulario 2: URL de sitio web o RSS tradicional
  elAddFeedForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    elAddFeedError.hidden = true;
    elBtnSubmitAddFeed.disabled = true;
    elBtnSubmitAddFeed.textContent = 'Detectando y sincronizando...';

    try {
      const res = await fetch('/api/feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: elInputFeedUrl.value,
          categoryName: elInputFeedCategory.value,
          title: elInputFeedTitle.value
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo añadir la fuente');

      elAddFeedDialog.close();
      if (data.feed.category_id) state.expandedCategories.add(data.feed.category_id);
      state.feedId = data.feed.id;
      state.categoryId = null;
      state.viewTitle = data.feed.title;
      await fetchState();
    } catch (err) {
      elAddFeedError.textContent = err.message;
      elAddFeedError.hidden = false;
    } finally {
      elBtnSubmitAddFeed.disabled = false;
      elBtnSubmitAddFeed.textContent = 'Añadir y sincronizar';
    }
  });

  // Eventos del Gestor y Limpieza de Fuentes
  document.getElementById('btn-open-manage-feeds').addEventListener('click', openFeedManager);
  document.getElementById('btn-manage-feeds-bottom').addEventListener('click', openFeedManager);
  document.getElementById('btn-close-manage-feeds').addEventListener('click', () => elManageDialog.close());
  document.getElementById('btn-done-manage-feeds').addEventListener('click', () => elManageDialog.close());

  elManagerSearchInput.addEventListener('input', renderFeedManagerList);
  elManagerCategoryFilter.addEventListener('change', renderFeedManagerList);
  elManagerStatusFilter.addEventListener('change', renderFeedManagerList);

  document.getElementById('btn-select-all-visible').addEventListener('click', () => {
    for (const f of getFilteredManagerFeeds()) {
      state.managerSelectedIds.add(f.id);
    }
    renderFeedManagerList();
  });

  document.getElementById('btn-select-all-errors').addEventListener('click', () => {
    state.managerSelectedIds.clear();
    for (const f of state.sidebar.feeds) {
      if (f.error_msg) state.managerSelectedIds.add(f.id);
    }
    elManagerStatusFilter.value = 'error';
    renderFeedManagerList();
  });

  document.getElementById('btn-deselect-all').addEventListener('click', () => {
    state.managerSelectedIds.clear();
    renderFeedManagerList();
  });

  elBtnBulkDelete.addEventListener('click', async () => {
    const ids = Array.from(state.managerSelectedIds);
    if (ids.length === 0) return;
    elBtnBulkDelete.disabled = true;
    await fetch('/api/feeds/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedIds: ids })
    });
    state.managerSelectedIds.clear();
    if (state.feedId && ids.includes(state.feedId)) {
      state.feedId = null;
      state.viewTitle = 'Todas las noticias';
    }
    await fetchState();
  });

  // Modal Importar OPML adicional
  document.getElementById('btn-open-opml-from-manager').addEventListener('click', () => {
    elInputOpmlFile.value = '';
    elImportOpmlDialog.showModal();
  });
  document.getElementById('btn-close-opml').addEventListener('click', () => elImportOpmlDialog.close());
  document.getElementById('btn-cancel-opml').addEventListener('click', () => elImportOpmlDialog.close());

  elImportOpmlForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = elInputOpmlFile.files[0];
    if (!file) return;
    const text = await file.text();
    const res = await fetch('/api/opml/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opml: text })
    });
    if (res.ok) {
      elImportOpmlDialog.close();
      await fetchState();
    }
  });
}

// ============================================================================
// Arranque
// ============================================================================

async function bootstrap() {
  bindEvents();
  const gpuReady = await gpuMedia.init();
  if (gpuReady) {
    elGpuBadge.textContent = 'WebGPU · WGSL';
    elGpuBadge.classList.add('active');
  } else {
    elGpuBadge.textContent = 'Canvas 2D';
  }

  await fetchState();
}

bootstrap();
