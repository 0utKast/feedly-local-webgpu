const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
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

  CREATE TABLE IF NOT EXISTS meta_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

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
    feed_type TEXT DEFAULT 'rss',
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

  CREATE TABLE IF NOT EXISTS dismissed_guids (
    feed_id INTEGER NOT NULL,
    guid TEXT NOT NULL,
    dismissed_at INTEGER NOT NULL,
    PRIMARY KEY (feed_id, guid)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
    article_id UNINDEXED,
    title,
    excerpt,
    feed_title,
    note
  );
`);

// Asegurar columna feed_type si la tabla venía de la versión previa
try {
  db.exec(`ALTER TABLE feeds ADD COLUMN feed_type TEXT DEFAULT 'rss';`);
} catch {
  // Ya existe
}

const recentDismissedBatches = [];
const MAX_UNDO_BATCHES = 15;

// Estado global de sincronización en segundo plano
const syncStatus = {
  isSyncing: false,
  completed: 0,
  total: 0,
  currentFeedTitle: ''
};

function rebuildFtsIndex() {
  db.exec(`DELETE FROM articles_fts;`);
  db.exec(`
    INSERT INTO articles_fts (article_id, title, excerpt, feed_title, note)
    SELECT a.id, a.title, a.excerpt, f.title, a.note
    FROM articles a
    JOIN feeds f ON f.id = a.feed_id;
  `);
}

function cleanupEmptyCategories() {
  db.exec(`
    DELETE FROM categories
    WHERE id NOT IN (SELECT DISTINCT category_id FROM feeds);
  `);
}

// ============================================================================
// Decodificación HTML, Limpieza y Normalización de URLs de Feedly (Google, Reddit, Alertas)
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

// Construye URLs de búsqueda por palabras clave estilo Feedly (Google News, Reddit, Hacker News)
function buildKeywordSearchFeed({ query, provider = 'google_es', subreddit = '', sort = 'new' }) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) throw new Error('Debes indicar al menos una palabra clave.');

  if (provider === 'google_es') {
    const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(cleanQuery)}&hl=es&gl=ES&ceid=ES:es`;
    const siteUrl = `https://news.google.com/search?q=${encodeURIComponent(cleanQuery)}&hl=es&gl=ES&ceid=ES:es`;
    return {
      title: `"${cleanQuery}" - Google News (ES)`,
      feedUrl,
      siteUrl,
      feedType: 'keyword_google'
    };
  }

  if (provider === 'google_en') {
    const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(cleanQuery)}&hl=en-US&gl=US&ceid=US:en`;
    const siteUrl = `https://news.google.com/search?q=${encodeURIComponent(cleanQuery)}&hl=en-US&gl=US&ceid=US:en`;
    return {
      title: `"${cleanQuery}" - Google News`,
      feedUrl,
      siteUrl,
      feedType: 'keyword_google'
    };
  }

  if (provider === 'reddit_search') {
    const cleanSub = String(subreddit || '').replace(/^\/?r\//i, '').trim();
    const validSort = ['new', 'relevance', 'top', 'hot', 'comments'].includes(sort) ? sort : 'new';
    if (cleanSub) {
      const feedUrl = `https://www.reddit.com/r/${encodeURIComponent(cleanSub)}/search.rss?q=${encodeURIComponent(cleanQuery)}&restrict_sr=on&sort=${validSort}`;
      const siteUrl = `https://www.reddit.com/r/${encodeURIComponent(cleanSub)}/search/?q=${encodeURIComponent(cleanQuery)}&restrict_sr=1&sort=${validSort}`;
      return {
        title: `"${cleanQuery}" en r/${cleanSub}`,
        feedUrl,
        siteUrl,
        feedType: 'keyword_reddit'
      };
    } else {
      const feedUrl = `https://www.reddit.com/search.rss?q=${encodeURIComponent(cleanQuery)}&sort=${validSort}`;
      const siteUrl = `https://www.reddit.com/search/?q=${encodeURIComponent(cleanQuery)}&sort=${validSort}`;
      return {
        title: `"${cleanQuery}" - Reddit`,
        feedUrl,
        siteUrl,
        feedType: 'keyword_reddit'
      };
    }
  }

  if (provider === 'reddit_subreddit') {
    const cleanSub = cleanQuery.replace(/^\/?r\//i, '').trim();
    const validSort = ['new', 'hot', 'top'].includes(sort) ? sort : 'new';
    const suffix = validSort === 'top' ? 'top/.rss?t=day' : `${validSort}/.rss`;
    const feedUrl = `https://www.reddit.com/r/${encodeURIComponent(cleanSub)}/${suffix}`;
    const siteUrl = `https://www.reddit.com/r/${encodeURIComponent(cleanSub)}/${validSort}`;
    return {
      title: validSort === 'top' ? `Top posts on r/${cleanSub}` : `r/${cleanSub}`,
      feedUrl,
      siteUrl,
      feedType: 'reddit_sub'
    };
  }

  if (provider === 'hn_search') {
    const feedUrl = `https://hnrss.org/newest?q=${encodeURIComponent(cleanQuery)}`;
    const siteUrl = `https://hn.algolia.com/?q=${encodeURIComponent(cleanQuery)}`;
    return {
      title: `"${cleanQuery}" - Hacker News`,
      feedUrl,
      siteUrl,
      feedType: 'keyword_hn'
    };
  }

  throw new Error('Proveedor de búsqueda no reconocido');
}

// Normaliza URLs propietarias del OPML de Feedly (Alertas, api.reddit.com, Google News antiguos, YouTube)
function normalizeOpmlFeedUrl(rawXmlUrl, title = '', rawHtmlUrl = '') {
  const xmlUrl = decodeHtmlEntities(rawXmlUrl || '').trim();
  const htmlUrl = decodeHtmlEntities(rawHtmlUrl || '').trim();
  const cleanTitle = decodeHtmlEntities(title || '').trim();

  // 1. Alertas internas de Feedly Cloud (https://feedly.com/f/alert/...) -> Convertir a Google News RSS
  if (/^https?:\/\/feedly\.com\/f\/alert\//i.test(xmlUrl)) {
    const queryTerm = cleanTitle || 'technology';
    return {
      feedUrl: `https://news.google.com/rss/search?q=${encodeURIComponent('"' + queryTerm + '"')}&hl=en-US&gl=US&ceid=US:en`,
      siteUrl: `https://news.google.com/search?q=${encodeURIComponent(queryTerm)}&hl=en-US&gl=US&ceid=US:en`,
      title: `${cleanTitle} (Alerta Google News)`,
      feedType: 'keyword_google'
    };
  }

  // 2. Pseudo-URLs de Reddit en Feedly (https://api.reddit.com/subreddit/Nombre;top)
  const redditApiMatch = xmlUrl.match(/^https?:\/\/api\.reddit\.com\/subreddit\/([^/;?]+)(;top)?/i);
  if (redditApiMatch) {
    const sub = redditApiMatch[1];
    const isTop = Boolean(redditApiMatch[2]);
    return {
      feedUrl: isTop
        ? `https://www.reddit.com/r/${sub}/top/.rss?t=day`
        : `https://www.reddit.com/r/${sub}/new/.rss`,
      siteUrl: htmlUrl || `https://www.reddit.com/r/${sub}/`,
      title: cleanTitle || (isTop ? `Top posts on r/${sub}` : `r/${sub}`),
      feedType: 'reddit_sub'
    };
  }

  // 3. URLs de Reddit antiguas en HTTP sin .rss moderno
  if (/^https?:\/\/(?:www\.)?reddit\.com\/r\/[^/]+\/\.rss/i.test(xmlUrl)) {
    return {
      feedUrl: xmlUrl.replace(/^http:\/\//i, 'https://'),
      siteUrl: htmlUrl || xmlUrl.replace(/\.rss$/, ''),
      title: cleanTitle,
      feedType: 'reddit_sub'
    };
  }

  // 4. URLs antiguas de Google News en OPML de Feedly
  if (xmlUrl.includes('news.google.com/news/rss/search/section/q/') || xmlUrl.includes('news.google.com/news?')) {
    let query = '';
    if (htmlUrl) {
      try {
        const u = new URL(htmlUrl);
        query = u.searchParams.get('q') || '';
      } catch {}
    }
    if (!query) {
      const m = xmlUrl.match(/\/q\/([^/?]+)\//i);
      if (m && m[1]) query = decodeURIComponent(m[1]);
    }
    if (!query) {
      query = cleanTitle.replace(/\s*-\s*Google News$/i, '').replace(/^"+|"+$/g, '');
    }
    return {
      feedUrl: `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
      siteUrl: htmlUrl || `https://news.google.com/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
      title: cleanTitle || `"${query}" - Google News`,
      feedType: 'keyword_google'
    };
  }

  if (xmlUrl.includes('news.google.com/rss/search')) {
    return {
      feedUrl: xmlUrl,
      siteUrl: htmlUrl || xmlUrl,
      title: cleanTitle,
      feedType: 'keyword_google'
    };
  }

  // 5. Listas de reproducción de YouTube puestas como página HTML en lugar de XML feed
  const ytPlaylistMatch = xmlUrl.match(/^https?:\/\/(?:www\.)?youtube\.com\/playlist\?list=([a-zA-Z0-9_-]+)/i);
  if (ytPlaylistMatch && ytPlaylistMatch[1]) {
    return {
      feedUrl: `https://www.youtube.com/feeds/videos.xml?playlist_id=${ytPlaylistMatch[1]}`,
      siteUrl: htmlUrl || xmlUrl,
      title: cleanTitle,
      feedType: 'rss'
    };
  }

  return {
    feedUrl: xmlUrl,
    siteUrl: htmlUrl,
    title: cleanTitle,
    feedType: 'rss'
  };
}

// ============================================================================
// Importador OPML Estructurado (Respeta jerarquía de carpetas e ignora vacías)
// ============================================================================

function parseAttrs(attrString) {
  const attrs = {};
  const attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = attrRegex.exec(attrString)) !== null) {
    attrs[m[1].toLowerCase()] = decodeHtmlEntities(m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

function importOpmlContent(opmlXml, replaceDefaults = false) {
  if (replaceDefaults) {
    db.exec(`DELETE FROM articles; DELETE FROM articles_fts; DELETE FROM feeds; DELETE FROM categories;`);
  }

  const insertCat = db.prepare('INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?, ?)');
  const getCat = db.prepare('SELECT id FROM categories WHERE name = ?');
  const insertFeed = db.prepare(`
    INSERT OR IGNORE INTO feeds (category_id, title, feed_url, site_url, feed_type)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tagRegex = /<\/?outline\b([^>]*?)(\/?)>/gi;
  const folderStack = [];
  let importedFeeds = 0;
  let catOrder = 1;

  let match;
  while ((match = tagRegex.exec(opmlXml)) !== null) {
    const fullMatch = match[0];
    const attrStr = match[1] || '';
    const selfClosing = match[2] === '/' || /\/>$/.test(fullMatch);
    const isClosing = fullMatch.startsWith('</');

    if (isClosing) {
      if (folderStack.length > 0) folderStack.pop();
      continue;
    }

    const attrs = parseAttrs(attrStr);
    const xmlUrl = attrs.xmlurl;
    const title = (attrs.title || attrs.text || '').trim();
    const htmlUrl = (attrs.htmlurl || '').trim();

    if (xmlUrl) {
      // Es un feed RSS/Atom
      const categoryName = folderStack.length > 0 ? folderStack[folderStack.length - 1] : 'General';
      insertCat.run(categoryName, catOrder++);
      const catRow = getCat.get(categoryName);

      const normalized = normalizeOpmlFeedUrl(xmlUrl, title, htmlUrl);
      if (catRow && normalized.feedUrl) {
        const res = insertFeed.run(
          catRow.id,
          normalized.title || new URL(normalized.feedUrl).hostname,
          normalized.feedUrl,
          normalized.siteUrl || '',
          normalized.feedType || 'rss'
        );
        if (res.changes > 0) importedFeeds++;
      }
    } else if (!selfClosing && title) {
      // Es una carpeta contenedora con hijos (<outline text="00. Tecnología"> ... </outline>)
      folderStack.push(title);
    }
    // Si es <outline text="tutoriales" /> autocerrada y sin xmlUrl, es una categoría vacía: la ignoramos
  }

  cleanupEmptyCategories();
  return importedFeeds;
}

// Auto-importar el archivo OPML del usuario si está en la carpeta del proyecto
function autoImportWorkspaceOpmlIfNeeded() {
  const alreadyImported = db
    .prepare("SELECT value FROM meta_settings WHERE key = 'workspace_opml_imported'")
    .get();
  if (alreadyImported) return false;

  const files = fs.readdirSync(__dirname).filter((f) => f.toLowerCase().endsWith('.opml'));
  if (files.length === 0) return false;

  const opmlPath = path.join(__dirname, files[0]);
  try {
    const content = fs.readFileSync(opmlPath, 'utf-8');
    const count = importOpmlContent(content, true);
    db.prepare(
      "INSERT OR REPLACE INTO meta_settings (key, value) VALUES ('workspace_opml_imported', ?)"
    ).run(files[0]);
    console.log(`OPML detectado e importado automáticamente (${files[0]}): ${count} fuentes únicas.`);
    return true;
  } catch (err) {
    console.error('Error al auto-importar OPML:', err);
    return false;
  }
}

const didAutoImport = autoImportWorkspaceOpmlIfNeeded();
if (!didAutoImport) {
  const countRow = db.prepare('SELECT COUNT(*) AS total FROM feeds').get();
  if (!countRow || countRow.total === 0) {
    const insertCat = db.prepare('INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?, ?)');
    insertCat.run('00. Tecnología', 1);
    const catId = db.prepare('SELECT id FROM categories WHERE name = ?').get('00. Tecnología').id;
    db.prepare('INSERT OR IGNORE INTO feeds (category_id, title, feed_url, site_url) VALUES (?, ?, ?, ?)')
      .run(catId, 'Xataka', 'https://www.xataka.com/feedburner.xml', 'https://www.xataka.com');
  }
}
rebuildFtsIndex();

// ============================================================================
// Limpieza de extractos y Parseo RSS / Atom / YouTube / Google News / Reddit
// ============================================================================

function stripHtmlToExcerpt(html, maxLength = 260, articleTitle = '') {
  if (!html) return '';
  let text = String(html)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<figure[\s\S]*?<\/figure>/gi, ' ');

  text = decodeHtmlEntities(text)
    .replace(/<[^>]+>/g, ' ')
    // Limpiar coletillas típicas de Reddit RSS
    .replace(/submitted by\s+\/u\/\S+\s*\[link\]\s*\[comments\]/gi, '')
    .replace(/\[link\]\s*\[comments\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // En Google News RSS el description suele repetir el titular exacto seguido del nombre del diario
  if (articleTitle && text.toLowerCase().startsWith(articleTitle.toLowerCase().slice(0, 40))) {
    const sliced = text.slice(articleTitle.length).replace(/^[\s\-–—·|]+/, '').trim();
    if (sliced.length >= 20) {
      text = sliced;
    }
  }

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
    lower.includes('gstatic.com/images/branding/product') ||
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
  // 1. Buscar <media:thumbnail> o <media:content> (YouTube, MRSS, Reddit, etc.)
  const mediaRegex = /<(?:media:thumbnail|media:content)\b([^>]+)>/gi;
  let mMatch;
  while ((mMatch = mediaRegex.exec(itemXml)) !== null) {
    const attrs = mMatch[1];
    const urlMatch = attrs.match(/\burl=["']([^"']+)["']/i);
    if (urlMatch && urlMatch[1]) {
      const candidate = resolveUrl(urlMatch[1], baseUrl);
      if (!isLikelyTrackingImage(candidate)) return candidate;
    }
  }

  // 2. Buscar <enclosure url="..." type="image/...">
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

  // 3. Buscar primera etiqueta <img src="..."> en el contenido HTML decodificado (Reddit, blogs, etc.)
  const combinedHtml = decodeHtmlEntities(htmlBody || '') + '\n' + decodeHtmlEntities(itemXml);
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
  const headerXml = xmlText.replace(/<(item|entry)\b[\s\S]*$/i, '');
  const feedTitleRaw = extractTagContent(headerXml, ['title']) || new URL(feedUrl).hostname;
  const feedTitle = decodeHtmlEntities(feedTitleRaw.replace(/<[^>]+>/g, '')).trim();

  let siteUrl = '';
  const atomAltLink =
    headerXml.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) ||
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

    const rawGuid = extractTagContent(block, ['guid', 'id', 'yt:videoId']) || link || title;
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

    // En Google News RSS existe <source url="...">Medio Original</source>
    const sourcePublisher = decodeHtmlEntities(
      extractTagContent(block, ['source']).replace(/<[^>]+>/g, '')
    ).trim();
    const rawAuthor = extractTagContent(block, ['dc:creator', 'author', 'name']);
    const author =
      sourcePublisher ||
      decodeHtmlEntities(rawAuthor.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

    const contentHtml =
      extractTagContent(block, [
        'content:encoded',
        'content',
        'media:description',
        'description',
        'summary'
      ]) || '';

    let excerpt = stripHtmlToExcerpt(contentHtml, 250, title);
    if (!excerpt && sourcePublisher) {
      excerpt = `Publicado originalmente en ${sourcePublisher}.`;
    }

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
// Red, Autodescubrimiento y Enriquecimiento de Imágenes
// ============================================================================

async function fetchWithTimeout(url, options = {}, timeoutMs = 7500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        Accept:
          'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*;q=0.8',
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
  // Si el usuario escribe r/Subreddit directamente
  if (/^\/?r\/[a-zA-Z0-9_]+$/i.test(normalized)) {
    const sub = normalized.replace(/^\/?r\//i, '');
    return {
      feedUrl: `https://www.reddit.com/r/${sub}/new/.rss`,
      preloadedXml: null
    };
  }

  if (!/^https?:\/\//i.test(normalized)) {
    normalized = 'https://' + normalized;
  }

  // Si es una URL de Reddit directa a un subreddit sin .rss
  const redditSubMatch = normalized.match(/^https?:\/\/(?:www\.)?reddit\.com\/r\/([a-zA-Z0-9_]+)\/?$/i);
  if (redditSubMatch) {
    return {
      feedUrl: `https://www.reddit.com/r/${redditSubMatch[1]}/new/.rss`,
      preloadedXml: null
    };
  }

  const res = await fetchWithTimeout(normalized, {}, 9000);
  if (!res.ok) {
    throw new Error(`No se pudo conectar con ${normalized} (HTTP ${res.status})`);
  }

  const text = await res.text();
  if (/<(rss|feed|rdf:RDF)\b/i.test(text.slice(0, 4000))) {
    return { feedUrl: res.url || normalized, preloadedXml: text };
  }

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

  const origin = new URL(res.url || normalized).origin;
  const commonPaths = ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml'];
  for (const p of commonPaths) {
    try {
      const candidate = origin + p;
      const tryRes = await fetchWithTimeout(candidate, {}, 4000);
      if (tryRes.ok) {
        const tryText = await tryRes.text();
        if (/<(rss|feed|rdf:RDF)\b/i.test(tryText.slice(0, 4000))) {
          return { feedUrl: candidate, preloadedXml: tryText };
        }
      }
    } catch {}
  }

  throw new Error('No se encontró un canal RSS/Atom válido en esa dirección.');
}

async function fetchOgImageForArticle(articleUrl) {
  if (!articleUrl || !/^https?:\/\//i.test(articleUrl)) return '';
  // Evitar hacer scraping sobre wrappers cerrados de Google News que requieren redirección JS
  if (articleUrl.includes('news.google.com/rss/articles/')) return '';
  try {
    const res = await fetchWithTimeout(articleUrl, {}, 4800);
    if (!res.ok) return '';
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return '';

    const html = (await res.text()).slice(0, 85000);
    const metaPatterns = [
      /<meta\b[^>]*property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i,
      /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["']/i,
      /<meta\b[^>]*name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)["']/i,
      /<meta\b[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image(?::src)?["']/i
    ];

    for (const pattern of metaPatterns) {
      const m = html.match(pattern);
      if (m && m[1]) {
        const resolved = resolveUrl(m[1], res.url || articleUrl);
        if (!isLikelyTrackingImage(resolved)) {
          return resolved;
        }
      }
    }
  } catch {}
  return '';
}

let isEnrichingImages = false;
async function enrichMissingArticleImages() {
  if (isEnrichingImages) return;
  isEnrichingImages = true;
  try {
    const missing = db
      .prepare(`
        SELECT id, link FROM articles
        WHERE (image_url IS NULL OR image_url = '')
        ORDER BY published_ts DESC
        LIMIT 15
      `)
      .all();

    const updateStmt = db.prepare('UPDATE articles SET image_url = ? WHERE id = ?');
    for (const row of missing) {
      const ogImg = await fetchOgImageForArticle(row.link);
      updateStmt.run(ogImg || 'none', row.id);
    }
  } finally {
    isEnrichingImages = false;
  }
}

// ============================================================================
// Sincronización por lotes con concurrencia controlada (para soportar +100 feeds)
// ============================================================================

async function syncSingleFeed(feedRow, preloadedXml = null) {
  try {
    let xmlText = preloadedXml;
    if (!xmlText) {
      const res = await fetchWithTimeout(feedRow.feed_url, {}, 7500);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      xmlText = await res.text();
    }

    if (!/<(rss|feed|rdf:RDF)\b/i.test(xmlText.slice(0, 4000))) {
      throw new Error('Respuesta no es un XML RSS/Atom válido');
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
    // Guardar los 20 artículos más recientes de cada feed para no saturar cuando hay >100 feeds
    const itemsToProcess = parsed.items.slice(0, 20);

    for (const item of itemsToProcess) {
      if (checkDismissed.get(feedRow.id, item.guid)) continue;

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

      insertFts.run(result.lastInsertRowid, item.title, item.excerpt || '', feedRow.title);
      addedCount++;
    }

    db.prepare(`
      UPDATE feeds
      SET last_synced_at = ?, error_msg = NULL, site_url = COALESCE(NULLIF(site_url, ''), ?)
      WHERE id = ?
    `).run(new Date().toISOString(), parsed.siteUrl || '', feedRow.id);

    return { feedId: feedRow.id, addedCount, error: null };
  } catch (err) {
    const msg = err && err.message ? err.message : 'Error de conexión';
    db.prepare('UPDATE feeds SET error_msg = ? WHERE id = ?').run(msg, feedRow.id);
    return { feedId: feedRow.id, addedCount: 0, error: msg };
  }
}

async function syncFeedsBatch(feedsList, concurrency = 8) {
  if (syncStatus.isSyncing) return;
  syncStatus.isSyncing = true;
  syncStatus.completed = 0;
  syncStatus.total = feedsList.length;

  try {
    let idx = 0;
    async function worker() {
      while (idx < feedsList.length) {
        const current = feedsList[idx++];
        syncStatus.currentFeedTitle = current.title;
        await syncSingleFeed(current);
        syncStatus.completed++;
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, feedsList.length) }, () => worker());
    await Promise.all(workers);
    enrichMissingArticleImages().catch(() => {});
  } finally {
    syncStatus.isSyncing = false;
    syncStatus.currentFeedTitle = '';
  }
}

// ============================================================================
// Consultas de Estado, Artículos y Eliminación Inmediata de Leídas
// ============================================================================

function getSidebarState() {
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, name ASC').all();
  const feeds = db
    .prepare(`
      SELECT
        f.*,
        c.name AS category_name,
        COUNT(a.id) AS article_count
      FROM feeds f
      JOIN categories c ON c.id = f.category_id
      LEFT JOIN articles a ON a.feed_id = f.id
      GROUP BY f.id
      ORDER BY f.title COLLATE NOCASE ASC
    `)
    .all();

  const totals = db
    .prepare(`
      SELECT
        COUNT(*) AS all_count,
        SUM(CASE WHEN is_saved = 1 OR (note IS NOT NULL AND note != '') THEN 1 ELSE 0 END) AS saved_count
      FROM articles
    `)
    .get();

  const errorFeedsCount = feeds.filter((f) => Boolean(f.error_msg)).length;

  return {
    categories,
    feeds,
    totals: {
      all: totals?.all_count || 0,
      saved: totals?.saved_count || 0,
      feedsTotal: feeds.length,
      feedsWithError: errorFeedsCount
    },
    canUndoCount: recentDismissedBatches.length,
    syncStatus: { ...syncStatus }
  };
}

function queryArticles({ feedId, categoryId, filter, search, limit = 150 }) {
  const params = [];
  let sql = '';

  if (search && search.trim()) {
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
          f.feed_type AS feed_type,
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
        f.feed_type AS feed_type,
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
  } else if (filter === 'keywords') {
    sql += ` AND f.feed_type LIKE 'keyword_%'`;
  }

  sql += ` ORDER BY a.published_ts DESC LIMIT ?`;
  params.push(Number(limit));

  return db.prepare(sql).all(...params);
}

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

async function extractReadableArticle(articleUrl) {
  const res = await fetchWithTimeout(articleUrl, {}, 8500);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

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
// Servidor HTTP
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
      if (data.length > 8 * 1024 * 1024) {
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

    // 2. Sincronizar un feed, una categoría o todos los feeds
    if (req.method === 'POST' && pathname === '/api/sync') {
      const body = await readJsonBody(req);
      if (body.feedId) {
        const feedRow = db.prepare('SELECT * FROM feeds WHERE id = ?').get(Number(body.feedId));
        if (!feedRow) return sendJson(res, 404, { error: 'Feed no encontrado' });
        await syncSingleFeed(feedRow);
        return sendJson(res, 200, { ok: true, sidebar: getSidebarState() });
      }

      let feedsToSync;
      if (body.categoryId) {
        feedsToSync = db
          .prepare('SELECT * FROM feeds WHERE category_id = ? ORDER BY id ASC')
          .all(Number(body.categoryId));
      } else {
        feedsToSync = db.prepare('SELECT * FROM feeds ORDER BY id ASC').all();
      }

      // Lanzar sincronización por lotes en segundo plano para respuesta inmediata
      syncFeedsBatch(feedsToSync, 8).catch((e) => console.error('Error en batch sync:', e));
      return sendJson(res, 200, { ok: true, started: true, sidebar: getSidebarState() });
    }

    // 3. Añadir nuevo feed tradicional (sitio web, RSS/Atom o r/subreddit)
    if (req.method === 'POST' && pathname === '/api/feeds') {
      const body = await readJsonBody(req);
      const rawUrl = (body.url || '').trim();
      const categoryName = (body.categoryName || '00. Tecnología').trim();
      const customTitle = (body.title || '').trim();

      if (!rawUrl) {
        return sendJson(res, 400, { error: 'Debes indicar la URL del feed o sitio web.' });
      }

      const { feedUrl, preloadedXml } = await discoverFeedUrl(rawUrl);

      let xmlText = preloadedXml;
      if (!xmlText) {
        const feedRes = await fetchWithTimeout(feedUrl, {}, 9000);
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
        return sendJson(res, 409, { error: 'Esta fuente ya está añadida en tu lector.' });
      }

      const feedType = feedUrl.includes('reddit.com') ? 'reddit_sub' : 'rss';
      const insertRes = db
        .prepare(`
          INSERT INTO feeds (category_id, title, feed_url, site_url, feed_type)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(catRow.id, finalTitle, feedUrl, parsed.siteUrl || '', feedType);

      const newFeedRow = db.prepare('SELECT * FROM feeds WHERE id = ?').get(insertRes.lastInsertRowid);
      await syncSingleFeed(newFeedRow, xmlText);

      return sendJson(res, 201, {
        ok: true,
        feed: newFeedRow,
        sidebar: getSidebarState()
      });
    }

    // 4. Añadir Feed de Búsqueda por Palabras Clave (Google News, Reddit, Hacker News)
    if (req.method === 'POST' && pathname === '/api/feeds/keyword') {
      const body = await readJsonBody(req);
      const query = (body.query || '').trim();
      const provider = body.provider || 'google_es';
      const subreddit = (body.subreddit || '').trim();
      const sort = body.sort || 'new';
      const categoryName = (body.categoryName || 'Must Read').trim();
      const customTitle = (body.title || '').trim();

      const built = buildKeywordSearchFeed({ query, provider, subreddit, sort });
      const existing = db.prepare('SELECT id FROM feeds WHERE feed_url = ?').get(built.feedUrl);
      if (existing) {
        return sendJson(res, 409, { error: 'Ya existe un feed con esa misma búsqueda.' });
      }

      db.prepare('INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?, 2)').run(categoryName);
      const catRow = db.prepare('SELECT id FROM categories WHERE name = ?').get(categoryName);

      const insertRes = db
        .prepare(`
          INSERT INTO feeds (category_id, title, feed_url, site_url, feed_type)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(catRow.id, customTitle || built.title, built.feedUrl, built.siteUrl, built.feedType);

      const newFeedRow = db.prepare('SELECT * FROM feeds WHERE id = ?').get(insertRes.lastInsertRowid);
      await syncSingleFeed(newFeedRow);

      return sendJson(res, 201, {
        ok: true,
        feed: newFeedRow,
        sidebar: getSidebarState()
      });
    }

    // 5. Eliminación individual de un feed
    if (req.method === 'DELETE' && pathname.startsWith('/api/feeds/')) {
      const feedId = Number(pathname.split('/').pop());
      const articlesOfFeed = db.prepare('SELECT id FROM articles WHERE feed_id = ?').all(feedId);
      const delFts = db.prepare('DELETE FROM articles_fts WHERE article_id = ?');
      for (const a of articlesOfFeed) {
        delFts.run(a.id);
      }
      db.prepare('DELETE FROM feeds WHERE id = ?').run(feedId);
      cleanupEmptyCategories();
      return sendJson(res, 200, { ok: true, sidebar: getSidebarState() });
    }

    // 6. Eliminación en lote de múltiples feeds (para limpieza rápida del OPML)
    if (req.method === 'POST' && pathname === '/api/feeds/bulk-delete') {
      const body = await readJsonBody(req);
      const feedIds = Array.isArray(body.feedIds) ? body.feedIds.map(Number).filter(Boolean) : [];
      if (feedIds.length === 0) {
        return sendJson(res, 400, { error: 'No se seleccionaron fuentes para eliminar.' });
      }

      const getArticles = db.prepare('SELECT id FROM articles WHERE feed_id = ?');
      const delFts = db.prepare('DELETE FROM articles_fts WHERE article_id = ?');
      const delFeed = db.prepare('DELETE FROM feeds WHERE id = ?');

      for (const fId of feedIds) {
        const arts = getArticles.all(fId);
        for (const a of arts) delFts.run(a.id);
        delFeed.run(fId);
      }

      cleanupEmptyCategories();
      return sendJson(res, 200, {
        ok: true,
        deletedCount: feedIds.length,
        sidebar: getSidebarState()
      });
    }

    // 7. Editar título o carpeta de un feed
    if (req.method === 'PATCH' && pathname.startsWith('/api/feeds/')) {
      const feedId = Number(pathname.split('/').pop());
      const body = await readJsonBody(req);
      const feedRow = db.prepare('SELECT * FROM feeds WHERE id = ?').get(feedId);
      if (!feedRow) return sendJson(res, 404, { error: 'Fuente no encontrada' });

      let catId = feedRow.category_id;
      if (body.categoryName && body.categoryName.trim()) {
        const cName = body.categoryName.trim();
        db.prepare('INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?, 5)').run(cName);
        catId = db.prepare('SELECT id FROM categories WHERE name = ?').get(cName).id;
      }
      const newTitle = body.title && body.title.trim() ? body.title.trim() : feedRow.title;

      db.prepare('UPDATE feeds SET title = ?, category_id = ? WHERE id = ?').run(newTitle, catId, feedId);
      cleanupEmptyCategories();
      return sendJson(res, 200, { ok: true, sidebar: getSidebarState() });
    }

    // 8. Marcar noticias como leídas -> Eliminación inmediata excepto guardadas
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

    // 9. Deshacer última eliminación de noticias leídas
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

    // 10. Alternar Guardado o añadir/editar Nota
    if (req.method === 'POST' && pathname.startsWith('/api/articles/') && pathname.endsWith('/save')) {
      const parts = pathname.split('/');
      const articleId = Number(parts[3]);
      const body = await readJsonBody(req);

      const current = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
      if (!current) return sendJson(res, 404, { error: 'Noticia no encontrada' });

      const newSaved =
        typeof body.isSaved === 'boolean' ? (body.isSaved ? 1 : 0) : current.is_saved ? 0 : 1;
      const newNote = typeof body.note === 'string' ? body.note.trim() : current.note;

      db.prepare('UPDATE articles SET is_saved = ?, note = ? WHERE id = ?').run(
        newSaved,
        newNote,
        articleId
      );
      db.prepare('UPDATE articles_fts SET note = ? WHERE article_id = ?').run(newNote, articleId);

      const updated = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
      return sendJson(res, 200, { ok: true, article: updated, sidebar: getSidebarState() });
    }

    // 11. Extraer texto completo de una noticia
    if (req.method === 'GET' && pathname.startsWith('/api/articles/') && pathname.endsWith('/fulltext')) {
      const parts = pathname.split('/');
      const articleId = Number(parts[3]);
      const row = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
      if (!row) return sendJson(res, 404, { error: 'Noticia no encontrada' });

      const paragraphs = await extractReadableArticle(row.link);
      return sendJson(res, 200, { ok: true, paragraphs });
    }

    // 12. Importar archivo OPML manual
    if (req.method === 'POST' && pathname === '/api/opml/import') {
      const body = await readJsonBody(req);
      if (!body.opml || typeof body.opml !== 'string') {
        return sendJson(res, 400, { error: 'Contenido OPML no válido' });
      }
      const importedCount = importOpmlContent(body.opml, Boolean(body.replaceExisting));
      const allFeeds = db.prepare('SELECT * FROM feeds ORDER BY id ASC').all();
      syncFeedsBatch(allFeeds, 8).catch(() => {});
      return sendJson(res, 200, {
        ok: true,
        importedCount,
        sidebar: getSidebarState()
      });
    }

    // 13. Proxy CORS de imágenes para WebGPU
    if (req.method === 'GET' && pathname === '/api/image-proxy') {
      const targetUrl = parsedUrl.searchParams.get('url');
      if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
        res.writeHead(400);
        return res.end('URL inválida');
      }

      try {
        const imgRes = await fetchWithTimeout(
          targetUrl,
          {
            headers: {
              Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
              Referer: new URL(targetUrl).origin
            }
          },
          7000
        );

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

    // 14. Archivos estáticos
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
  const allFeeds = db.prepare('SELECT * FROM feeds ORDER BY id ASC').all();
  const unsynced = db.prepare('SELECT * FROM feeds WHERE last_synced_at IS NULL ORDER BY id ASC').all();
  if (unsynced.length > 0) {
    syncFeedsBatch(unsynced, 8).catch((e) => console.error('Error en sync inicial:', e));
  } else if (allFeeds.length > 0) {
    enrichMissingArticleImages().catch(() => {});
  }
});
