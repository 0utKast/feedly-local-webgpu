const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3040;
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const dbPath = path.join(DATA_DIR, 'feedly_local.sqlite');
const db = new DatabaseSync(dbPath);

// Inicializar esquema SQLite + FTS5
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    feed_url TEXT NOT NULL UNIQUE,
    site_url TEXT DEFAULT '',
    last_synced_at TEXT DEFAULT NULL,
    error_msg TEXT DEFAULT NULL,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_id INTEGER NOT NULL,
    guid TEXT NOT NULL,
    title TEXT NOT NULL,
    link TEXT NOT NULL,
    pub_date TEXT NOT NULL,
    published_ts INTEGER NOT NULL,
    author TEXT DEFAULT '',
    excerpt TEXT DEFAULT '',
    content_html TEXT DEFAULT '',
    image_url TEXT DEFAULT '',
    is_saved INTEGER DEFAULT 0,
    note TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE(feed_id, guid),
    FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_articles_feed ON articles(feed_id);
  CREATE INDEX IF NOT EXISTS idx_articles_saved ON articles(is_saved);

  -- Tabla ligera de huellas de noticias ya leídas y eliminadas para que no reaparezcan al recargar el RSS
  CREATE TABLE IF NOT EXISTS dismissed_guids (
    feed_id INTEGER NOT NULL,
    guid TEXT NOT NULL,
    dismissed_at INTEGER NOT NULL,
    PRIMARY KEY (feed_id, guid)
  );

  -- Índice FTS5 para búsquedas instantáneas
  CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
    article_id UNINDEXED,
    title,
    excerpt,
    feed_title,
    note
  );
`);

// Pila en memoria para permitir "Deshacer" eliminaciones recientes de noticias leídas
const recentDismissedBatches = [];
const MAX_UNDO_BATCHES = 15;

function rebuildFtsIndex() {
  db.exec(`DELETE FROM articles_fts;`);
  db.exec(`
    INSERT INTO articles_fts (article_id, title, excerpt, feed_title, note)
    SELECT a.id, a.title, a.excerpt, f.title, a.note
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id;
  `);
}

// Semilla inicial limpia si no hay categorías ni feeds
function ensureInitialData() {
  const countRow = db.prepare('SELECT COUNT(*) AS total FROM feeds').get();
  if (countRow && countRow.total > 0) return;

  const insertCat = db.prepare('INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?, ?)');
  insertCat.run('Tecnología y Ciencia', 1);
  insertCat.run('Actualidad y Prensa', 2);
  insertCat.run('Desarrollo y Gráficos', 3);

  const getCat = db.prepare('SELECT id FROM categories WHERE name = ?');
  const catTech = getCat.get('Tecnología y Ciencia').id;
  const catNews = getCat.get('Actualidad y Prensa').id;
  const catDev = getCat.get('Desarrollo y Gráficos').id;

  const insertFeed = db.prepare(`
    INSERT OR IGNORE INTO feeds (category_id, title, feed_url, site_url)
    VALUES (?, ?, ?, ?)
  `);

  insertFeed.run(catTech, 'Xataka', 'https://www.xataka.com/feedburner.xml', 'https://www.xataka.com');
  insertFeed.run(catTech, 'Ars Technica', 'https://feeds.arstechnica.com/arstechnica/index', 'https://arstechnica.com');
  insertFeed.run(catNews, 'El País - Portada', 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada', 'https://elpais.com');
  insertFeed.run(catDev, 'Hacker News (Frontpage)', 'https://hnrss.org/frontpage', 'https://news.ycombinator.com');
}

ensureInitialData();
rebuildFtsIndex();

// ============================================================================
// Utilidades de decodificación HTML, limpieza de extractos y parseo RSS/Atom
// ============================================================================

const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
  '&ndash;': '–',
  '&mdash;': '—',
  '&laquo;': '«',
  '&raquo;': '»',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&hellip;': '…',
  '&euro;': '€',
  '&copy;': '©',
  '&reg;': '®',
  '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú',
  '&Aacute;': 'Á', '&Eacute;': 'É', '&Iacute;': 'Í', '&Oacute;': 'Ó', '&Uacute;': 'Ú',
  '&ntilde;': 'ñ', '&Ntilde;': 'Ñ', '&uuml;': 'ü', '&Uuml;': 'Ü',
  '&iexcl;': '¡', '&iquest;': '¿'
};

function decodeHtmlEntities(str) {
  if (!str) return '';
  let out = String(str);
  // Quitar envoltorios CDATA si quedaron residuales
  out = out.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  out = out.replace(/&#(\d+);/g, (_, dec) => {
    const code = Number(dec);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const code = parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });
  out = out.replace(/&[a-zA-Z0-9]+;/g, (entity) => HTML_ENTITIES[entity] || entity);
  return out;
}

function stripHtmlToExcerpt(html, maxLength = 260) {
  if (!html) return '';
  let text = String(html)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<figure[\s\S]*?<\/figure>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities(text)
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > maxLength) {
    return text.slice(0, maxLength).replace(/\s+\S*$/, '') + '…';
  }
  return text;
}

function isLikelyTrackingImage(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  if (lower.startsWith('data:image/gif')) return true;
  if (
    lower.includes('feedburner.com/~ff/') ||
    lower.includes('feedburner.com/~r/') ||
    lower.includes('doubleclick.net') ||
    lower.includes('1x1') ||
    lower.includes('pixel.') ||
    lower.includes('/spacer.gif') ||
    lower.includes('statcounter') ||
    lower.endsWith('.svg')
  ) {
    return true;
  }
  return false;
}

function resolveUrl(candidate, baseUrl) {
  if (!candidate) return '';
  const cleaned = decodeHtmlEntities(candidate.trim());
  if (!cleaned) return '';
  try {
    if (cleaned.startsWith('//')) {
      return 'https:' + cleaned;
    }
    return new URL(cleaned, baseUrl || 'https://localhost').href;
  } catch {
    return cleaned;
  }
}

function extractTagContent(xmlBlock, tagNames) {
  for (const tag of tagNames) {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`, 'i');
    const match = xmlBlock.match(regex);
    if (match && match[1]) {
      const inner = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
      if (inner) return inner;
    }
  }
  return '';
}

function extractImageFromItemXml(itemXml, htmlBody, baseUrl) {
  // 1. Buscar <media:content> o <media:thumbnail>
  const mediaMatch = itemXml.match(/<(?:media:content|media:thumbnail)\b[^>]*?\burl=["']([^"']+)["'][^>]*>/i);
  if (mediaMatch && mediaMatch[1]) {
    const candidate = resolveUrl(mediaMatch[1], baseUrl);
    if (!isLikelyTrackingImage(candidate)) return candidate;
  }

  // 2. Buscar <enclosure url="..." type="image/..."> o con extensión de imagen
  const enclosureRegex = /<enclosure\b([^>]+)>/gi;
  let encMatch;
  while ((encMatch = enclosureRegex.exec(itemXml)) !== null) {
    const attrs = encMatch[1];
    const urlMatch = attrs.match(/\burl=["']([^"']+)["']/i);
    const typeMatch = attrs.match(/\btype=["']([^"']+)["']/i);
    if (urlMatch && urlMatch[1]) {
      const urlVal = resolveUrl(urlMatch[1], baseUrl);
      const isImgType = typeMatch && typeMatch[1].toLowerCase().startsWith('image/');
      const isImgExt = /\.(jpe?g|png|webp|avif)(\?|$)/i.test(urlVal);
      if ((isImgType || isImgExt) && !isLikelyTrackingImage(urlVal)) {
        return urlVal;
      }
    }
  }

  // 3. Buscar <itunes:image href="...">
  const itunesMatch = itemXml.match(/<itunes:image\b[^>]*?\bhref=["']([^"']+)["'][^>]*>/i);
  if (itunesMatch && itunesMatch[1]) {
    const candidate = resolveUrl(itunesMatch[1], baseUrl);
    if (!isLikelyTrackingImage(candidate)) return candidate;
  }

  // 4. Buscar primera etiqueta <img src="..."> en el contenido HTML del ítem
  const combinedHtml = (htmlBody || '') + '\n' + decodeHtmlEntities(itemXml);
  const imgRegex = /<img\b[^>]*?\b(?:src|data-src|data-original)=["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(combinedHtml)) !== null) {
    const candidate = resolveUrl(imgMatch[1], baseUrl);
    if (!isLikelyTrackingImage(candidate)) {
      return candidate;
    }
  }

  return '';
}

function parseFeedXml(xmlText, feedUrl) {
  const feedTitleRaw =
    extractTagContent(xmlText.replace(/<(item|entry)\b[\s\S]*$/i, ''), ['title']) ||
    new URL(feedUrl).hostname;
  const feedTitle = decodeHtmlEntities(feedTitleRaw.replace(/<[^>]+>/g, '')).trim();

  let siteUrl = '';
  const headerXml = xmlText.replace(/<(item|entry)\b[\s\S]*$/i, '');
  const atomAltLink = headerXml.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ||
                      headerXml.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["']/i);
  if (atomAltLink && atomAltLink[1]) {
    siteUrl = resolveUrl(atomAltLink[1], feedUrl);
  } else {
    const rssLink = extractTagContent(headerXml, ['link']);
    if (rssLink && !rssLink.startsWith('<')) {
      siteUrl = resolveUrl(rssLink, feedUrl);
    }
  }
  if (!siteUrl) {
    try {
      siteUrl = new URL(feedUrl).origin;
    } catch {
      siteUrl = feedUrl;
    }
  }

  const items = [];
  const isAtom = /<feed\b/i.test(xmlText) && /<entry\b/i.test(xmlText);
  const itemRegex = isAtom
    ? /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi
    : /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;

  let match;
  while ((match = itemRegex.exec(xmlText)) !== null) {
    const block = match[1];
    const rawTitle = extractTagContent(block, ['title']);
    const title = decodeHtmlEntities(rawTitle.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!title) continue;

    let link = '';
    if (isAtom) {
      const altMatch =
        block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ||
        block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["']/i) ||
        block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
      if (altMatch && altMatch[1]) link = resolveUrl(altMatch[1], siteUrl);
    } else {
      const linkTag = extractTagContent(block, ['link', 'guid']);
      if (linkTag && /^https?:\/\//i.test(linkTag.trim())) {
        link = linkTag.trim();
      } else {
        const hrefMatch = block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
        if (hrefMatch && hrefMatch[1]) link = resolveUrl(hrefMatch[1], siteUrl);
      }
    }
    if (!link) link = siteUrl;

    const rawGuid = extractTagContent(block, ['guid', 'id']) || link || title;
    const guid = decodeHtmlEntities(rawGuid).trim();

    const rawDate = extractTagContent(block, [
      'pubDate',
      'published',
      'updated',
      'dc:date',
      'dcterms:issued'
    ]);
    let publishedTs = Date.now();
    if (rawDate) {
      const parsed = Date.parse(rawDate.trim());
      if (!Number.isNaN(parsed)) {
        publishedTs = parsed;
      }
    }

    const rawAuthor = extractTagContent(block, ['dc:creator', 'author', 'name']);
    const author = decodeHtmlEntities(rawAuthor.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

    const contentHtml =
      extractTagContent(block, ['content:encoded', 'content', 'description', 'summary']) || '';
    const excerpt = stripHtmlToExcerpt(contentHtml, 250);
    const imageUrl = extractImageFromItemXml(block, contentHtml, link || siteUrl);

    items.push({
      guid,
      title,
      link,
      pubDate: new Date(publishedTs).toISOString(),
      publishedTs,
      author,
      excerpt,
      contentHtml: decodeHtmlEntities(contentHtml),
      imageUrl
    });
  }

  return { feedTitle, siteUrl, items };
}

// ============================================================================
// Fetch con timeout y autodetección de feeds + extractor og:image
// ============================================================================

async function fetchWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 FeedlyLocal/1.0',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*;q=0.8',
        ...(options.headers || {})
      }
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverFeedUrl(inputUrl) {
  let normalized = inputUrl.trim();
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = 'https://' + normalized;
  }

  const res = await fetchWithTimeout(normalized, {}, 10000);
  if (!res.ok) {
    throw new Error(`No se pudo conectar con ${normalized} (HTTP ${res.status})`);
  }

  const text = await res.text();
  // ¿Es ya un XML de RSS/Atom?
  if (/<(rss|feed|rdf:RDF)\b/i.test(text.slice(0, 4000))) {
    return { feedUrl: res.url || normalized, preloadedXml: text };
  }

  // Buscar <link rel="alternate" type="application/rss+xml" href="..."> en el HTML
  const linkTags = text.match(/<link\b[^>]+>/gi) || [];
  for (const tag of linkTags) {
    const isAlt = /\brel=["'][^"']*alternate[^"']*["']/i.test(tag);
    const isFeedType = /\btype=["']application\/(rss|atom|rdf)\+xml["']/i.test(tag);
    if (isAlt && isFeedType) {
      const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/i);
      if (hrefMatch && hrefMatch[1]) {
        const candidateUrl = resolveUrl(hrefMatch[1], res.url || normalized);
        return { feedUrl: candidateUrl, preloadedXml: null };
      }
    }
  }

  // Probar rutas comunes si la web no declaró <link rel="alternate">
  const origin = new URL(res.url || normalized).origin;
  const commonPaths = ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml'];
  for (const p of commonPaths) {
    try {
      const candidate = origin + p;
      const tryRes = await fetchWithTimeout(candidate, {}, 4500);
      if (tryRes.ok) {
        const tryText = await tryRes.text();
        if (/<(rss|feed|rdf:RDF)\b/i.test(tryText.slice(0, 4000))) {
          return { feedUrl: candidate, preloadedXml: tryText };
        }
      }
    } catch {
      // continuar probando
    }
  }

  throw new Error('No se encontró un canal RSS/Atom válido en esa dirección.');
}

async function fetchOgImageForArticle(articleUrl) {
  if (!articleUrl || !/^https?:\/\//i.test(articleUrl)) return '';
  try {
    const res = await fetchWithTimeout(articleUrl, {}, 5500);
    if (!res.ok) return '';
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return '';

    const html = (await res.text()).slice(0, 90000);
    const metaPatterns = [
      /<meta\b[^>]*property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i,
      /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["']/i,
      /<meta\b[^>]*name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i,
      /<meta\b[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image(?::src)?["']/i
    ];

    for (const pattern of metaPatterns) {
      const m = html.match(pattern);
      if (m && m[1]) {
        const resolved = resolveUrl(m[1], articleUrl);
        if (!isLikelyTrackingImage(resolved)) {
          return resolved;
        }
      }
    }
  } catch {
    // Silenciar fallos individuales de scraping og:image
  }
  return '';
}

// Enriquecedor en segundo plano para artículos que llegaron sin imagen en el RSS
let isEnrichingImages = false;
async function enrichMissingArticleImages() {
  if (isEnrichingImages) return;
  isEnrichingImages = true;
  try {
    const missing = db.prepare(`
      SELECT id, link FROM articles
      WHERE (image_url IS NULL OR image_url = '')
      ORDER BY published_ts DESC
      LIMIT 18
    `).all();

    const updateStmt = db.prepare('UPDATE articles SET image_url = ? WHERE id = ?');
    for (const row of missing) {
      const ogImg = await fetchOgImageForArticle(row.link);
      if (ogImg) {
        updateStmt.run(ogImg, row.id);
      } else {
        // Marcar con 'none' para no reintentar indefinidamente enlaces que no tienen og:image
        updateStmt.run('none', row.id);
      }
    }
  } finally {
    isEnrichingImages = false;
  }
}

// ============================================================================
// Sincronización de un Feed o de todos los Feeds
// ============================================================================

async function syncSingleFeed(feedRow, preloadedXml = null) {
  try {
    let xmlText = preloadedXml;
    if (!xmlText) {
      const res = await fetchWithTimeout(feedRow.feed_url, {}, 10000);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      xmlText = await res.text();
    }

    const parsed = parseFeedXml(xmlText, feedRow.feed_url);

    const checkDismissed = db.prepare(
      'SELECT 1 FROM dismissed_guids WHERE feed_id = ? AND guid = ?'
    );
    const checkExisting = db.prepare(
      'SELECT id, image_url FROM articles WHERE feed_id = ? AND guid = ?'
    );
    const insertArticle = db.prepare(`
      INSERT INTO articles (
        feed_id, guid, title, link, pub_date, published_ts,
        author, excerpt, content_html, image_url, is_saved, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?)
    `);
    const insertFts = db.prepare(`
      INSERT INTO articles_fts (article_id, title, excerpt, feed_title, note)
      VALUES (?, ?, ?, ?, '')
    `);

    let addedCount = 0;
    const now = Date.now();

    // Limitar a los 35 artículos más recientes por feed para mantener agilidad
    const itemsToProcess = parsed.items.slice(0, 35);

    for (const item of itemsToProcess) {
      // Si ya fue leída y eliminada previamente, no volver a insertarla jamás
      const wasDismissed = checkDismissed.get(feedRow.id, item.guid);
      if (wasDismissed) continue;

      const existing = checkExisting.get(feedRow.id, item.guid);
      if (existing) {
        if ((!existing.image_url || existing.image_url === 'none') && item.imageUrl) {
          db.prepare('UPDATE articles SET image_url = ? WHERE id = ?').run(item.imageUrl, existing.id);
        }
        continue;
      }

      const result = insertArticle.run(
        feedRow.id,
        item.guid,
        item.title,
        item.link,
        item.pubDate,
        item.publishedTs,
        item.author || '',
        item.excerpt || '',
        item.contentHtml || '',
        item.imageUrl || '',
        now
      );

      insertFts.run(
        result.lastInsertRowid,
        item.title,
        item.excerpt || '',
        feedRow.title
      );
      addedCount++;
    }

    db.prepare(`
      UPDATE feeds
      SET last_synced_at = ?, error_msg = NULL, site_url = COALESCE(NULLIF(site_url, ''), ?)
      WHERE id = ?
    `).run(new Date().toISOString(), parsed.siteUrl || '', feedRow.id);

    // Disparar enriquecimiento asíncrono de og:image para noticias sin foto
    enrichMissingArticleImages().catch(() => {});

    return { feedId: feedRow.id, addedCount, error: null };
  } catch (err) {
    const msg = err && err.message ? err.message : 'Error de sincronización';
    db.prepare('UPDATE feeds SET error_msg = ? WHERE id = ?').run(msg, feedRow.id);
    return { feedId: feedRow.id, addedCount: 0, error: msg };
  }
}

async function syncAllFeeds() {
  const feeds = db.prepare('SELECT * FROM feeds ORDER BY id ASC').all();
  const results = await Promise.all(feeds.map((f) => syncSingleFeed(f)));
  return results;
}

// ============================================================================
// Extractor de artículo completo bajo demanda (Modo Lectura)
// ============================================================================

async function extractReadableArticle(articleUrl) {
  const res = await fetchWithTimeout(articleUrl, {}, 9000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // Extraer bloques <article> o <main> o párrafos <p> principales
  const articleMatch =
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) ||
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const scopeHtml = articleMatch ? articleMatch[1] : html;

  const paragraphs = [];
  const pRegex = /<(p|h2|h3|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = pRegex.exec(scopeHtml)) !== null) {
    const tag = m[1].toLowerCase();
    const text = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (text.length >= 45 || (tag !== 'p' && text.length >= 12)) {
      paragraphs.push({ tag, text });
    }
  }
  return paragraphs.slice(0, 45);
}

// ============================================================================
// Importador OPML (Feedly export)
// ============================================================================

function importOpmlContent(opmlXml) {
  const insertCat = db.prepare('INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?, ?)');
  const getCat = db.prepare('SELECT id FROM categories WHERE name = ?');
  const insertFeed = db.prepare(`
    INSERT OR IGNORE INTO feeds (category_id, title, feed_url, site_url)
    VALUES (?, ?, ?, ?)
  `);

  let currentCatName = 'Importados de Feedly';
  insertCat.run(currentCatName, 10);
  let importedFeeds = 0;

  const outlineRegex = /<outline\b([^>]*?)(\/?)>/gi;
  let match;
  while ((match = outlineRegex.exec(opmlXml)) !== null) {
    const attrs = match[1];
    const xmlUrlMatch = attrs.match(/\bxmlUrl=["']([^"']+)["']/i);
    const titleMatch = attrs.match(/\b(?:title|text)=["']([^"']+)["']/i);
    const htmlUrlMatch = attrs.match(/\bhtmlUrl=["']([^"']+)["']/i);

    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : '';

    if (!xmlUrlMatch && title) {
      // Es una carpeta / categoría de OPML
      currentCatName = title;
      insertCat.run(currentCatName, 10);
    } else if (xmlUrlMatch && xmlUrlMatch[1]) {
      const feedUrl = decodeHtmlEntities(xmlUrlMatch[1]).trim();
      const siteUrl = htmlUrlMatch ? decodeHtmlEntities(htmlUrlMatch[1]).trim() : '';
      const catRow = getCat.get(currentCatName);
      if (catRow) {
        const res = insertFeed.run(
          catRow.id,
          title || new URL(feedUrl).hostname,
          feedUrl,
          siteUrl
        );
        if (res.changes > 0) importedFeeds++;
      }
    }
  }
  return importedFeeds;
}

// ============================================================================
// Servidor HTTP + API REST + Proxy de Imágenes para WebGPU
// ============================================================================

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) {
        reject(new Error('Payload demasiado grande'));
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function getSidebarState() {
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, name ASC').all();
  const feeds = db.prepare(`
    SELECT
      f.*,
      COUNT(a.id) AS article_count
    FROM feeds f
    LEFT JOIN articles a ON a.feed_id = f.id
    GROUP BY f.id
    ORDER BY f.title ASC
  `).all();

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS all_count,
      SUM(CASE WHEN is_saved = 1 OR (note IS NOT NULL AND note != '') THEN 1 ELSE 0 END) AS saved_count
    FROM articles
  `).get();

  return {
    categories,
    feeds,
    totals: {
      all: totals?.all_count || 0,
      saved: totals?.saved_count || 0
    },
    canUndoCount: recentDismissedBatches.length
  };
}

function queryArticles({ feedId, categoryId, filter, search, limit = 120 }) {
  const params = [];
  let sql = '';

  if (search && search.trim()) {
    // Limpiar consulta para FTS5 seguro
    const tokens = search
      .trim()
      .replace(/["'*^():-]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t}"*`)
      .join(' AND ');

    if (tokens) {
      sql = `
        SELECT
          a.*,
          f.title AS feed_title,
          f.site_url AS feed_site_url,
          c.name AS category_name
        FROM articles_fts fts
        JOIN articles a ON a.id = fts.article_id
        JOIN feeds f ON f.id = a.feed_id
        JOIN categories c ON c.id = f.category_id
        WHERE articles_fts MATCH ?
      `;
      params.push(tokens);
    }
  }

  if (!sql) {
    sql = `
      SELECT
        a.*,
        f.title AS feed_title,
        f.site_url AS feed_site_url,
        c.name AS category_name
      FROM articles a
      JOIN feeds f ON f.id = a.feed_id
      JOIN categories c ON c.id = f.category_id
      WHERE 1=1
    `;
  }

  if (feedId) {
    sql += ` AND a.feed_id = ?`;
    params.push(Number(feedId));
  }
  if (categoryId) {
    sql += ` AND f.category_id = ?`;
    params.push(Number(categoryId));
  }
  if (filter === 'saved') {
    sql += ` AND (a.is_saved = 1 OR (a.note IS NOT NULL AND a.note != ''))`;
  } else if (filter === 'notes') {
    sql += ` AND (a.note IS NOT NULL AND a.note != '')`;
  }

  sql += ` ORDER BY a.published_ts DESC LIMIT ?`;
  params.push(Number(limit));

  return db.prepare(sql).all(...params);
}

// Eliminar inmediatamente noticias leídas salvo que estén guardadas o tengan nota
function markArticlesReadAndDeleteImmediate(articleIds) {
  if (!Array.isArray(articleIds) || articleIds.length === 0) {
    return { deletedIds: [], preservedSavedIds: [] };
  }

  const deletedIds = [];
  const preservedSavedIds = [];
  const backupArticles = [];
  const now = Date.now();

  const getArticle = db.prepare('SELECT * FROM articles WHERE id = ?');
  const getFeed = db.prepare('SELECT title FROM feeds WHERE id = ?');
  const deleteArticle = db.prepare('DELETE FROM articles WHERE id = ?');
  const deleteFts = db.prepare('DELETE FROM articles_fts WHERE article_id = ?');
  const insertDismissed = db.prepare(`
    INSERT OR REPLACE INTO dismissed_guids (feed_id, guid, dismissed_at)
    VALUES (?, ?, ?)
  `);

  for (const rawId of articleIds) {
    const id = Number(rawId);
    const row = getArticle.get(id);
    if (!row) continue;

    // Regla del usuario: eliminación inmediata una vez leída EXCEPTO que se guarde (o tenga nota)
    if (row.is_saved === 1 || (row.note && row.note.trim() !== '')) {
      preservedSavedIds.push(id);
      continue;
    }

    const feedRow = getFeed.get(row.feed_id);
    backupArticles.push({
      ...row,
      feed_title: feedRow ? feedRow.title : ''
    });

    insertDismissed.run(row.feed_id, row.guid, now);
    deleteArticle.run(id);
    deleteFts.run(id);
    deletedIds.push(id);
  }

  if (backupArticles.length > 0) {
    recentDismissedBatches.push(backupArticles);
    if (recentDismissedBatches.length > MAX_UNDO_BATCHES) {
      recentDismissedBatches.shift();
    }
  }

  return { deletedIds, preservedSavedIds, canUndoCount: recentDismissedBatches.length };
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.wgsl': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // 1. Estado general y artículos
    if (req.method === 'GET' && pathname === '/api/state') {
      const feedId = parsedUrl.searchParams.get('feedId');
      const categoryId = parsedUrl.searchParams.get('categoryId');
      const filter = parsedUrl.searchParams.get('filter') || 'all';
      const search = parsedUrl.searchParams.get('search') || '';

      const sidebar = getSidebarState();
      const articles = queryArticles({ feedId, categoryId, filter, search });
      return sendJson(res, 200, { sidebar, articles });
    }

    // 2. Sincronizar todos los feeds o uno específico
    if (req.method === 'POST' && pathname === '/api/sync') {
      const body = await readJsonBody(req);
      let syncResults;
      if (body.feedId) {
        const feedRow = db.prepare('SELECT * FROM feeds WHERE id = ?').get(Number(body.feedId));
        if (!feedRow) return sendJson(res, 404, { error: 'Feed no encontrado' });
        syncResults = [await syncSingleFeed(feedRow)];
      } else {
        syncResults = await syncAllFeeds();
      }
      const sidebar = getSidebarState();
      return sendJson(res, 200, { ok: true, syncResults, sidebar });
    }

    // 3. Añadir nuevo feed (con autodetección RSS/Atom)
    if (req.method === 'POST' && pathname === '/api/feeds') {
      const body = await readJsonBody(req);
      const rawUrl = (body.url || '').trim();
      const categoryName = (body.categoryName || 'General').trim();
      const customTitle = (body.title || '').trim();

      if (!rawUrl) {
        return sendJson(res, 400, { error: 'Debes indicar la URL del feed o sitio web.' });
      }

      const { feedUrl, preloadedXml } = await discoverFeedUrl(rawUrl);

      let xmlText = preloadedXml;
      if (!xmlText) {
        const feedRes = await fetchWithTimeout(feedUrl, {}, 10000);
        if (!feedRes.ok) {
          return sendJson(res, 400, { error: `No se pudo descargar el feed (${feedRes.status})` });
        }
        xmlText = await feedRes.text();
      }

      const parsed = parseFeedXml(xmlText, feedUrl);
      db.prepare('INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?, 5)').run(categoryName);
      const catRow = db.prepare('SELECT id FROM categories WHERE name = ?').get(categoryName);

      const finalTitle = customTitle || parsed.feedTitle || new URL(feedUrl).hostname;
      const existingFeed = db.prepare('SELECT id FROM feeds WHERE feed_url = ?').get(feedUrl);
      if (existingFeed) {
        return sendJson(res, 409, { error: 'Este feed ya está añadido en tu lector.' });
      }

      const insertRes = db.prepare(`
        INSERT INTO feeds (category_id, title, feed_url, site_url)
        VALUES (?, ?, ?, ?)
      `).run(catRow.id, finalTitle, feedUrl, parsed.siteUrl || '');

      const newFeedRow = db.prepare('SELECT * FROM feeds WHERE id = ?').get(insertRes.lastInsertRowid);
      await syncSingleFeed(newFeedRow, xmlText);

      return sendJson(res, 201, {
        ok: true,
        feed: newFeedRow,
        sidebar: getSidebarState()
      });
    }

    // 4. Eliminar un feed
    if (req.method === 'DELETE' && pathname.startsWith('/api/feeds/')) {
      const feedId = Number(pathname.split('/').pop());
      const articlesOfFeed = db.prepare('SELECT id FROM articles WHERE feed_id = ?').all(feedId);
      const delFts = db.prepare('DELETE FROM articles_fts WHERE article_id = ?');
      for (const a of articlesOfFeed) {
        delFts.run(a.id);
      }
      db.prepare('DELETE FROM feeds WHERE id = ?').run(feedId);
      // Limpiar categorías huérfanas sin feeds si no son las base
      return sendJson(res, 200, { ok: true, sidebar: getSidebarState() });
    }

    // 5. Marcar noticias como leídas -> Eliminación inmediata excepto guardadas
    if (req.method === 'POST' && pathname === '/api/articles/mark-read') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body.articleIds) ? body.articleIds : [];
      const result = markArticlesReadAndDeleteImmediate(ids);
      return sendJson(res, 200, {
        ok: true,
        ...result,
        sidebar: getSidebarState()
      });
    }

    // 6. Deshacer última eliminación de noticias leídas
    if (req.method === 'POST' && pathname === '/api/articles/undo-dismiss') {
      const batch = recentDismissedBatches.pop();
      if (!batch || batch.length === 0) {
        return sendJson(res, 400, { error: 'No hay eliminaciones recientes para deshacer.' });
      }

      const restoreArticle = db.prepare(`
        INSERT OR IGNORE INTO articles (
          id, feed_id, guid, title, link, pub_date, published_ts,
          author, excerpt, content_html, image_url, is_saved, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const restoreFts = db.prepare(`
        INSERT INTO articles_fts (article_id, title, excerpt, feed_title, note)
        VALUES (?, ?, ?, ?, ?)
      `);
      const removeDismissed = db.prepare(
        'DELETE FROM dismissed_guids WHERE feed_id = ? AND guid = ?'
      );

      for (const item of batch) {
        removeDismissed.run(item.feed_id, item.guid);
        restoreArticle.run(
          item.id,
          item.feed_id,
          item.guid,
          item.title,
          item.link,
          item.pub_date,
          item.published_ts,
          item.author,
          item.excerpt,
          item.content_html,
          item.image_url,
          item.is_saved,
          item.note,
          item.created_at
        );
        restoreFts.run(item.id, item.title, item.excerpt, item.feed_title || '', item.note || '');
      }

      return sendJson(res, 200, {
        ok: true,
        restoredCount: batch.length,
        sidebar: getSidebarState()
      });
    }

    // 7. Alternar Guardado (protege frente a eliminación) o añadir/editar Nota
    if (req.method === 'POST' && pathname.startsWith('/api/articles/') && pathname.endsWith('/save')) {
      const parts = pathname.split('/');
      const articleId = Number(parts[3]);
      const body = await readJsonBody(req);

      const current = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
      if (!current) return sendJson(res, 404, { error: 'Noticia no encontrada' });

      const newSaved = typeof body.isSaved === 'boolean' ? (body.isSaved ? 1 : 0) : (current.is_saved ? 0 : 1);
      const newNote = typeof body.note === 'string' ? body.note.trim() : current.note;

      db.prepare('UPDATE articles SET is_saved = ?, note = ? WHERE id = ?').run(newSaved, newNote, articleId);
      db.prepare('UPDATE articles_fts SET note = ? WHERE article_id = ?').run(newNote, articleId);

      const updated = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
      return sendJson(res, 200, { ok: true, article: updated, sidebar: getSidebarState() });
    }

    // 8. Extraer texto completo de una noticia para el panel de lectura
    if (req.method === 'GET' && pathname.startsWith('/api/articles/') && pathname.endsWith('/fulltext')) {
      const parts = pathname.split('/');
      const articleId = Number(parts[3]);
      const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
      if (!row) return sendJson(res, 404, { error: 'Noticia no encontrada' });

      const paragraphs = await extractReadableArticle(row.link);
      return sendJson(res, 200, { ok: true, paragraphs });
    }

    // 9. Importar archivo OPML de Feedly
    if (req.method === 'POST' && pathname === '/api/opml/import') {
      const body = await readJsonBody(req);
      if (!body.opml || typeof body.opml !== 'string') {
        return sendJson(res, 400, { error: 'Contenido OPML no válido' });
      }
      const importedCount = importOpmlContent(body.opml);
      // Lanzar sincronización en segundo plano
      syncAllFeeds().catch(() => {});
      return sendJson(res, 200, {
        ok: true,
        importedCount,
        sidebar: getSidebarState()
      });
    }

    // 10. Proxy CORS de imágenes para WebGPU (copyExternalImageToTexture requiere CORS limpio)
    if (req.method === 'GET' && pathname === '/api/image-proxy') {
      const targetUrl = parsedUrl.searchParams.get('url');
      if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
        res.writeHead(400);
        return res.end('URL inválida');
      }

      try {
        const imgRes = await fetchWithTimeout(targetUrl, {
          headers: {
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Referer': new URL(targetUrl).origin
          }
        }, 7500);

        if (!imgRes.ok) {
          res.writeHead(404);
          return res.end();
        }

        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        const arrayBuf = await imgRes.arrayBuffer();
        res.writeHead(200, {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400'
        });
        return res.end(Buffer.from(arrayBuf));
      } catch {
        res.writeHead(404);
        return res.end();
      }
    }

    // 11. Archivos estáticos de /public
    let relPath = pathname === '/' ? '/index.html' : pathname;
    const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(PUBLIC_DIR, safePath);

    if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
  } catch (err) {
    console.error('Error en servidor:', err);
    sendJson(res, 500, { error: err.message || 'Error interno del servidor' });
  }
});

server.listen(PORT, () => {
  console.log(`Feedly Local (WebGPU) escuchando en http://localhost:${PORT}`);
  // Sincronización inicial automática si los feeds aún no se han descargado
  const unsynced = db.prepare('SELECT COUNT(*) AS c FROM articles').get();
  if (!unsynced || unsynced.c === 0) {
    syncAllFeeds().catch((e) => console.error('Error en sync inicial:', e));
  } else {
    enrichMissingArticleImages().catch(() => {});
  }
});
