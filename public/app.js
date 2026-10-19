import { WebGpuCardMediaEngine } from './webgpu-media.js';

const gpuMedia = new WebGpuCardMediaEngine();

const state = {
  filter: 'all', // 'all' | 'saved' | 'notes'
  categoryId: null,
  feedId: null,
  viewTitle: 'Todas las noticias',
  search: '',
  sidebar: {
    categories: [],
    feeds: [],
    totals: { all: 0, saved: 0 },
    canUndoCount: 0
  },
  articles: [],
  activeArticle: null
};

// Referencias DOM
const elAppShell = document.getElementById('app-shell');
const elGpuBadge = document.getElementById('gpu-badge');
const elCountAll = document.getElementById('count-all');
const elCountSaved = document.getElementById('count-saved');
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

// Modales <dialog>
const elAddFeedDialog = document.getElementById('add-feed-dialog');
const elAddFeedForm = document.getElementById('add-feed-form');
const elInputFeedUrl = document.getElementById('input-feed-url');
const elInputFeedCategory = document.getElementById('input-feed-category');
const elInputFeedTitle = document.getElementById('input-feed-title');
const elExistingCategories = document.getElementById('existing-categories');
const elAddFeedError = document.getElementById('add-feed-error');
const elBtnSubmitAddFeed = document.getElementById('btn-submit-add-feed');

const elImportOpmlDialog = document.getElementById('import-opml-dialog');
const elImportOpmlForm = document.getElementById('import-opml-form');
const elInputOpmlFile = document.getElementById('input-opml-file');

// Formateo de fecha y hora legible ("19 oct 2026, 10:35")
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
// Carga de datos y sincronización
// ============================================================================

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
}

async function triggerSync(feedId = null) {
  elBtnSync.classList.add('syncing');
  elSyncLabel.textContent = 'Actualizando...';
  try {
    await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feedId ? { feedId } : {})
    });
    await fetchState();
    // Segunda lectura breve por si el extractor og:image en segundo plano completó nuevas portadas
    setTimeout(() => {
      fetchState().catch(() => {});
    }, 3200);
  } finally {
    elBtnSync.classList.remove('syncing');
    elSyncLabel.textContent = 'Recargar';
  }
}

// ============================================================================
// Renderizado del Panel Izquierdo (Sidebar)
// ============================================================================

function renderSidebar() {
  elCountAll.textContent = state.sidebar.totals.all;
  elCountSaved.textContent = state.sidebar.totals.saved;

  // Resaltar vista superior activa si no hay feed/categoría seleccionada
  document.querySelectorAll('.nav-section .nav-item').forEach((btn) => {
    const view = btn.dataset.view;
    const isActive = !state.feedId && !state.categoryId && state.filter === view;
    btn.classList.toggle('active', isActive);
  });

  // Rellenar datalist de categorías para el modal de añadir feed
  elExistingCategories.innerHTML = state.sidebar.categories
    .map((c) => `<option value="${escapeHtml(c.name)}"></option>`)
    .join('');

  // Construir árbol de Categorías -> Feeds
  const fragment = document.createDocumentFragment();

  for (const cat of state.sidebar.categories) {
    const feedsInCat = state.sidebar.feeds.filter((f) => f.category_id === cat.id);
    const catCount = feedsInCat.reduce((acc, f) => acc + (Number(f.article_count) || 0), 0);

    const catBlock = document.createElement('div');
    catBlock.className = 'category-block';

    const catBtn = document.createElement('button');
    catBtn.type = 'button';
    catBtn.className = 'category-header' + (state.categoryId === cat.id ? ' active' : '');
    catBtn.innerHTML = `
      <span class="nav-item-label">${escapeHtml(cat.name)}</span>
      <span class="nav-count">${catCount}</span>
    `;
    catBtn.addEventListener('click', () => {
      state.categoryId = cat.id;
      state.feedId = null;
      state.filter = 'all';
      state.viewTitle = cat.name;
      fetchState();
    });
    catBlock.appendChild(catBtn);

    for (const feed of feedsInCat) {
      const row = document.createElement('div');
      row.className = 'feed-row' + (state.feedId === feed.id ? ' active' : '');

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'feed-select-btn';
      selectBtn.title = feed.error_msg
        ? `Error: ${feed.error_msg}`
        : `${feed.title} (${feed.feed_url})`;
      selectBtn.innerHTML = `
        <span class="feed-title-text">${escapeHtml(feed.title)}</span>
        <span class="nav-count">${feed.article_count || 0}</span>
      `;
      selectBtn.addEventListener('click', () => {
        state.feedId = feed.id;
        state.categoryId = null;
        state.filter = 'all';
        state.viewTitle = feed.title;
        fetchState();
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-delete-feed';
      delBtn.title = `Eliminar feed «${feed.title}»`;
      delBtn.textContent = '×';
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = window.confirm(`¿Eliminar el feed «${feed.title}» y sus noticias no guardadas?`);
        if (!confirmed) return;
        await fetch(`/api/feeds/${feed.id}`, { method: 'DELETE' });
        if (state.feedId === feed.id) {
          state.feedId = null;
          state.viewTitle = 'Todas las noticias';
        }
        await fetchState();
      });

      row.appendChild(selectBtn);
      row.appendChild(delBtn);
      catBlock.appendChild(row);
    }

    fragment.appendChild(catBlock);
  }

  elCategoriesTree.replaceChildren(fragment);
}

function renderTopbar() {
  elViewTitle.textContent = state.viewTitle;
  const count = state.articles.length;
  elViewSubtitle.textContent =
    count === 1 ? '1 noticia' : `${count} noticias`;

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
    gpuMedia.attachCardCanvas(canvas, article.image_url, article.feed_title || article.title);

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
    metaRow.innerHTML = `
      <span class="card-origin" title="${escapeHtml(article.feed_title)}">${escapeHtml(article.feed_title)}</span>
      <span aria-hidden="true">·</span>
      <a
        href="${escapeHtml(article.link)}"
        target="_blank"
        rel="noopener noreferrer"
        class="card-original-link"
        title="Abrir noticia original en pestaña nueva"
      >${escapeHtml(formattedDate)} ↗</a>
    `;

    // 4. Pequeño extracto del contenido debajo (+ vista previa de nota si existe)
    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'card-body';

    const pExcerpt = document.createElement('p');
    pExcerpt.className = 'card-excerpt';
    pExcerpt.textContent =
      article.excerpt || 'Sin resumen adicional en el feed. Pulsa para abrir el lector o visitar el enlace original.';
    bodyWrap.appendChild(pExcerpt);

    if (hasNote) {
      const noteDiv = document.createElement('div');
      noteDiv.className = 'card-note-preview';
      noteDiv.textContent = `Nota: ${article.note}`;
      bodyWrap.appendChild(noteDiv);
    }

    // 5. Pie de acciones (Leída/Eliminar inmediato, Guardar, Nota)
    const footer = document.createElement('footer');
    footer.className = 'card-footer';

    const btnRead = document.createElement('button');
    btnRead.type = 'button';
    btnRead.className = 'card-action-btn';
    if (isSaved || hasNote) {
      btnRead.textContent = 'Protegida (Guardada)';
      btnRead.title = 'Esta noticia está guardada o tiene nota, por lo que no se elimina al marcar como leída.';
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
// Acciones de Noticias: Eliminación Inmediata al Leer, Deshacer, Guardar y Notas
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

// ============================================================================
// Cajón Lateral de Lectura (Slide-over Reader)
// ============================================================================

function openReaderDrawer(article) {
  state.activeArticle = article;
  elReaderFeedTitle.textContent = article.feed_title || '';
  elReaderDate.textContent = formatPubDate(article.published_ts || article.pub_date);
  elReaderTitle.textContent = article.title;
  elReaderLinkOriginal.href = article.link;
  elReaderNoteInput.value = article.note || '';

  // Mostrar el HTML del feed de forma segura o el extracto
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
  // Alternar barra lateral izquierda
  document.getElementById('btn-toggle-sidebar').addEventListener('click', () => {
    elAppShell.classList.toggle('sidebar-collapsed');
  });

  // Navegación de vistas principales (Todas, Guardadas, Con notas)
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

  // Selector de número de tarjetas por fila
  elSelectCols.addEventListener('change', () => {
    const val = elSelectCols.value;
    if (val === 'auto') {
      elCardsGrid.removeAttribute('data-fixed-cols');
    } else {
      elCardsGrid.setAttribute('data-fixed-cols', val);
    }
  });

  // Selector de modo de imagen WebGPU WGSL
  elSelectTone.addEventListener('change', () => {
    gpuMedia.setToneMode(Number(elSelectTone.value));
  });

  // Marcar todas las visibles como leídas (y eliminarlas salvo guardadas)
  elBtnMarkAllRead.addEventListener('click', async () => {
    const deletableIds = state.articles
      .filter((a) => a.is_saved !== 1 && (!a.note || !a.note.trim()))
      .map((a) => a.id);
    if (deletableIds.length === 0) return;
    await markReadAndDelete(deletableIds);
  });

  // Botón Deshacer último borrado de leídas
  elBtnUndo.addEventListener('click', async () => {
    const res = await fetch('/api/articles/undo-dismiss', { method: 'POST' });
    if (res.ok) {
      await fetchState();
    }
  });

  // Botón Recargar
  elBtnSync.addEventListener('click', () => {
    triggerSync(state.feedId || null);
  });

  // Controles del Reader Drawer
  elReaderBtnClose.addEventListener('click', closeReaderDrawer);
  elReaderBackdrop.addEventListener('click', closeReaderDrawer);

  elReaderBtnReadDelete.addEventListener('click', () => {
    if (state.activeArticle) {
      markReadAndDelete([state.activeArticle.id]);
    }
  });

  elReaderBtnSave.addEventListener('click', () => {
    if (state.activeArticle) {
      toggleSaveArticle(state.activeArticle);
    }
  });

  elReaderBtnSaveNote.addEventListener('click', () => {
    if (state.activeArticle) {
      toggleSaveArticle(state.activeArticle, elReaderNoteInput.value);
    }
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

  // Atajo Escape para cerrar panel de lectura
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && elReaderDrawer.classList.contains('open')) {
      closeReaderDrawer();
    }
  });

  // Modal Añadir Feed
  const openAddModal = () => {
    elAddFeedError.hidden = true;
    elInputFeedUrl.value = '';
    elInputFeedTitle.value = '';
    elAddFeedDialog.showModal();
    elInputFeedUrl.focus();
  };

  document.getElementById('btn-open-add-feed').addEventListener('click', openAddModal);
  document.getElementById('btn-add-feed-bottom').addEventListener('click', openAddModal);
  document.getElementById('btn-close-add-feed').addEventListener('click', () => elAddFeedDialog.close());
  document.getElementById('btn-cancel-add-feed').addEventListener('click', () => elAddFeedDialog.close());

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
      if (!res.ok) {
        throw new Error(data.error || 'No se pudo añadir el feed');
      }
      elAddFeedDialog.close();
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

  // Modal Importar OPML
  document.getElementById('btn-import-opml').addEventListener('click', () => {
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
      triggerSync();
    }
  });
}

// ============================================================================
// Arranque de la Aplicación
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
  if (state.articles.length === 0) {
    await triggerSync();
  }
}

bootstrap();
