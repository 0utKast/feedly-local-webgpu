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
    norm_title TEXT DEFAULT '',
    norm_link TEXT DEFAULT '',
    PRIMARY KEY (feed_id, guid)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
    article_id UNINDEXED,
    title,
    excerpt,
    feed_title,
    note
  );

  CREATE TABLE IF NOT EXISTS articles_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER DEFAULT 0,
    feed_id INTEGER NOT NULL,
    feed_title TEXT DEFAULT '',
    category_id INTEGER DEFAULT 0,
    category_name TEXT DEFAULT '',
    guid TEXT NOT NULL,
    title TEXT NOT NULL,
    link TEXT NOT NULL,
    pub_date TEXT NOT NULL,
    published_ts INTEGER NOT NULL,
    excerpt TEXT DEFAULT '',
    content_html TEXT DEFAULT '',
    norm_title TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE(feed_id, guid)
  );

  CREATE INDEX IF NOT EXISTS idx_history_published ON articles_history(published_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_history_norm_title ON articles_history(norm_title);

  CREATE TABLE IF NOT EXISTS briefing_reports (
    scope TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    total_articles INTEGER DEFAULT 0,
    clusters_json TEXT NOT NULL,
    categories_json TEXT NOT NULL,
    ai_markdown TEXT DEFAULT '',
    ai_model TEXT DEFAULT '',
    ai_status TEXT DEFAULT 'ready',
    generation_ms INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
`);

try {
  db.exec(`ALTER TABLE feeds ADD COLUMN feed_type TEXT DEFAULT 'rss';`);
} catch {}
try {
  db.exec(`ALTER TABLE dismissed_guids ADD COLUMN norm_title TEXT DEFAULT '';`);
} catch {}
try {
  db.exec(`ALTER TABLE dismissed_guids ADD COLUMN norm_link TEXT DEFAULT '';`);
} catch {}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_dismissed_guid ON dismissed_guids(guid);
  CREATE INDEX IF NOT EXISTS idx_dismissed_title ON dismissed_guids(norm_title);
  CREATE INDEX IF NOT EXISTS idx_dismissed_link ON dismissed_guids(norm_link);
`);

function normalizeArticleTitleKey(title) {
  if (!title) return '';
  return String(title)
    .toLowerCase()
    .replace(/\s+[-–—|]\s+[^-–—|]{2,45}$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeArticleLinkKey(link) {
  if (!link) return '';
  const raw = String(link).trim();
  if (!raw || raw.includes('news.google.com/rss/articles/')) return '';
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref|source|rss)/i.test(k)) {
        u.searchParams.delete(k);
      }
    }
    return (u.origin + u.pathname.replace(/\/+$/, '') + u.search).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

// Corregir timestamps artificiales de feeds sin fecha (<pubDate> ausente tenía milisegundos != 0 por Date.now())
// para que no acaparen la portada por delante de las noticias con fecha real
db.exec(`
  UPDATE articles
  SET published_ts = published_ts - (36 * 3600 * 1000) - (id * 45000)
  WHERE (published_ts % 1000) != 0 AND published_ts > (strftime('%s','now') * 1000 - 12 * 3600 * 1000);
`);

// Limpiar marcas 'none' antiguas para que el nuevo motor de imágenes contextuales pueda resolverlas
db.exec(`UPDATE articles SET image_url = '' WHERE image_url = 'none';`);

// Si varios artículos compartían exactamente el mismo logo genérico de una web, dejarlo solo en el primero
db.exec(`
  UPDATE articles
  SET image_url = ''
  WHERE image_url != ''
    AND id NOT IN (
      SELECT MIN(id) FROM articles WHERE image_url != '' GROUP BY image_url
    );
`);

// Limpiar al arranque artículos que ya estén en dismissed_guids o duplicados exactos entre distintos feeds
function purgeDuplicatesAndDismissedOnStartup() {
  const allDismissed = db.prepare('SELECT feed_id, guid, norm_title, norm_link FROM dismissed_guids').all();
  const dismissedGuidsSet = new Set();
  const dismissedTitlesSet = new Set();
  const dismissedLinksSet = new Set();

  const updateDismissedNorm = db.prepare(
    'UPDATE dismissed_guids SET norm_link = ? WHERE feed_id = ? AND guid = ?'
  );

  for (const d of allDismissed) {
    if (d.guid) dismissedGuidsSet.add(d.guid);
    if (d.norm_title && d.norm_title.length >= 18) dismissedTitlesSet.add(d.norm_title);
    let nl = d.norm_link || '';
    if (!nl && d.guid && d.guid.startsWith('http')) {
      nl = normalizeArticleLinkKey(d.guid);
      if (nl) updateDismissedNorm.run(nl, d.feed_id, d.guid);
    }
    if (nl && nl.length >= 12) dismissedLinksSet.add(nl);
  }

  const allArticles = db
    .prepare("SELECT id, feed_id, guid, title, link, image_url, is_saved, note FROM articles ORDER BY is_saved DESC, (image_url != '') DESC, published_ts DESC, id ASC")
    .all();

  const seenTitleKeys = new Set();
  const seenLinkKeys = new Set();
  const seenGuids = new Set();
  const delArt = db.prepare('DELETE FROM articles WHERE id = ?');
  const insDismissed = db.prepare(
    'INSERT OR IGNORE INTO dismissed_guids (feed_id, guid, dismissed_at, norm_title, norm_link) VALUES (?, ?, ?, ?, ?)'
  );
  const now = Date.now();

  for (const a of allArticles) {
    const isProtected = a.is_saved === 1 || (a.note && a.note.trim() !== '');
    const nt = normalizeArticleTitleKey(a.title);
    const nl = normalizeArticleLinkKey(a.link);

    if (!isProtected) {
      const alreadyDismissed =
        dismissedGuidsSet.has(a.guid) ||
        (nl.length >= 12 && dismissedLinksSet.has(nl)) ||
        (nt.length >= 18 && dismissedTitlesSet.has(nt));

      const isDuplicateUnread =
        seenGuids.has(a.guid) ||
        (nl.length >= 12 && seenLinkKeys.has(nl)) ||
        (nt.length >= 18 && seenTitleKeys.has(nt));

      if (alreadyDismissed || isDuplicateUnread) {
        insDismissed.run(a.feed_id, a.guid, now, nt, nl);
        delArt.run(a.id);
        continue;
      }
    }

    seenGuids.add(a.guid);
    if (nl.length >= 12) seenLinkKeys.add(nl);
    if (nt.length >= 18) seenTitleKeys.add(nt);
  }
}

purgeDuplicatesAndDismissedOnStartup();

// Sincronizar archivo histórico de 72h (para informes de 1h, 12h y 24h aunque las noticias ya se hayan leído)
const upsertHistoryStmt = db.prepare(`
  INSERT OR REPLACE INTO articles_history (
    article_id, feed_id, feed_title, category_id, category_name,
    guid, title, link, pub_date, published_ts, excerpt, content_html, norm_title, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function recordArticleInHistory(item, feedRow, catName = '', articleId = 0) {
  if (!item || !feedRow) return;
  const cutoff72h = Date.now() - 72 * 3600 * 1000;
  const pubTs = Number(item.published_ts ?? item.publishedTs) || Date.now();
  if (pubTs < cutoff72h) return;
  try {
    upsertHistoryStmt.run(
      Number(articleId || item.id || 0),
      Number(feedRow.id || item.feed_id || 0),
      String(feedRow.title || item.feed_title || ''),
      Number(feedRow.category_id || item.category_id || 0),
      String(catName || item.category_name || ''),
      String(item.guid || ''),
      String(item.title || ''),
      String(item.link || ''),
      String(item.pub_date || item.pubDate || new Date(pubTs).toISOString()),
      pubTs,
      String(item.excerpt || ''),
      String(item.content_html || item.contentHtml || ''),
      normalizeArticleTitleKey(item.title),
      Number(item.created_at || Date.now())
    );
  } catch {}
}

function seedAndPruneArticlesHistory() {
  const cutoff72h = Date.now() - 72 * 3600 * 1000;
  db.prepare('DELETE FROM articles_history WHERE published_ts < ?').run(cutoff72h);
  const currentRows = db
    .prepare(`
      SELECT a.*, f.title AS feed_title, f.category_id, c.name AS category_name
      FROM articles a
      JOIN feeds f ON f.id = a.feed_id
      JOIN categories c ON c.id = f.category_id
      WHERE a.published_ts >= ?
    `)
    .all(cutoff72h);
  for (const r of currentRows) {
    recordArticleInHistory(
      r,
      { id: r.feed_id, title: r.feed_title, category_id: r.category_id },
      r.category_name,
      r.id
    );
  }
}

seedAndPruneArticlesHistory();

const recentDismissedBatches = [];
const MAX_UNDO_BATCHES = 20;
let lastScrollDismissTimestamp = 0;

// Caché en memoria de artículos leídos recientemente para permitir guardarlos o extraer texto aunque ya se hayan borrado de articles
const recentlyReadById = new Map();
function rememberRecentlyReadArticle(articleObj) {
  recentlyReadById.set(Number(articleObj.id), articleObj);
  if (recentlyReadById.size > 1500) {
    const oldestKey = recentlyReadById.keys().next().value;
    recentlyReadById.delete(oldestKey);
  }
}

const AUTO_SYNC_INTERVAL_MINUTES = 15;

const syncStatus = {
  isSyncing: false,
  completed: 0,
  total: 0,
  currentFeedTitle: '',
  lastCompletedAt: Date.now(),
  autoSyncMinutes: AUTO_SYNC_INTERVAL_MINUTES
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
// Decodificación HTML, Limpieza y Normalización de URLs de Feedly
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

function normalizeOpmlFeedUrl(rawXmlUrl, title = '', rawHtmlUrl = '') {
  const xmlUrl = decodeHtmlEntities(rawXmlUrl || '').trim();
  const htmlUrl = decodeHtmlEntities(rawHtmlUrl || '').trim();
  const cleanTitle = decodeHtmlEntities(title || '').trim();

  if (/^https?:\/\/feedly\.com\/f\/alert\//i.test(xmlUrl)) {
    const queryTerm = cleanTitle || 'technology';
    return {
      feedUrl: `https://news.google.com/rss/search?q=${encodeURIComponent('"' + queryTerm + '"')}&hl=en-US&gl=US&ceid=US:en`,
      siteUrl: `https://news.google.com/search?q=${encodeURIComponent(queryTerm)}&hl=en-US&gl=US&ceid=US:en`,
      title: `${cleanTitle} (Alerta Google News)`,
      feedType: 'keyword_google'
    };
  }

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

  if (/^https?:\/\/(?:www\.)?reddit\.com\/r\/[^/]+\/\.rss/i.test(xmlUrl)) {
    return {
      feedUrl: xmlUrl.replace(/^http:\/\//i, 'https://'),
      siteUrl: htmlUrl || xmlUrl.replace(/\.rss$/, ''),
      title: cleanTitle,
      feedType: 'reddit_sub'
    };
  }

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
// Importador OPML
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
      folderStack.push(title);
    }
  }

  cleanupEmptyCategories();
  return importedFeeds;
}

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

autoImportWorkspaceOpmlIfNeeded();
rebuildFtsIndex();

// ============================================================================
// Parseo RSS / Atom y Extracción de Imágenes
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
    .replace(/submitted by\s+\/u\/\S+\s*\[link\]\s*\[comments\]/gi, '')
    .replace(/\[link\]\s*\[comments\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (articleTitle && text.toLowerCase().startsWith(articleTitle.toLowerCase().slice(0, 35))) {
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

function isLikelyTrackingOrGenericLogo(url) {
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
    lower.includes('lh3.googleusercontent.com/J6_coFbogxhRI9iM864NL_liGXvsQp2AupsKei7z0cNNfDvGUmWUy20nuUhkREQyrpY4bEeIBuc=s0-w300-rw') ||
    lower.includes('s.yimg.com/uu/api/res/') && lower.includes('16x16') ||
    lower.endsWith('.svg') ||
    lower.endsWith('.ico')
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
  const mediaRegex = /<(?:media:thumbnail|media:content)\b([^>]+)>/gi;
  let mMatch;
  while ((mMatch = mediaRegex.exec(itemXml)) !== null) {
    const attrs = mMatch[1];
    const urlMatch = attrs.match(/\burl=["']([^"']+)["']/i);
    if (urlMatch && urlMatch[1]) {
      const candidate = resolveUrl(urlMatch[1], baseUrl);
      if (!isLikelyTrackingOrGenericLogo(candidate)) return candidate;
    }
  }

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
      if ((isImgType || isImgExt) && !isLikelyTrackingOrGenericLogo(urlVal)) {
        return urlVal;
      }
    }
  }

  const combinedHtml = decodeHtmlEntities(htmlBody || '') + '\n' + decodeHtmlEntities(itemXml);
  const imgRegex = /<img\b[^>]*?\b(?:src|data-src|data-original)=["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(combinedHtml)) !== null) {
    const candidate = resolveUrl(imgMatch[1], baseUrl);
    if (!isLikelyTrackingOrGenericLogo(candidate)) {
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
  let itemIndex = 0;
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
        link = resolveUrl(linkTag.trim(), siteUrl);
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
      'prism:publicationDate',
      'dcterms:issued',
      'a10:updated'
    ]);

    // Si el feed no tiene etiqueta de fecha (ej. WikiCFP), asignarle un timestamp determinista
    // basado en su guid/título (anclado varios días atrás) para que no cambie ni se adelante al pulsar Recargar
    const nowMs = Date.now();
    let publishedTs = 0;
    if (rawDate) {
      const parsed = Date.parse(rawDate.trim());
      if (!Number.isNaN(parsed)) {
        publishedTs = Math.min(parsed, nowMs);
      }
    }
    if (!publishedTs) {
      let hash = 0;
      const seedStr = `${guid}|${title}`;
      for (let i = 0; i < seedStr.length; i++) {
        hash = (hash * 31 + seedStr.charCodeAt(i)) >>> 0;
      }
      // Timestamp estable escalonado en una ventana fija de 4 a 9 días atrás (redondeado al segundo)
      const anchorDayMs = Math.floor(nowMs / (86400 * 1000)) * (86400 * 1000);
      publishedTs =
        anchorDayMs - 4 * 86400 * 1000 - (hash % (5 * 86400 * 1000)) - itemIndex * 60000;
      publishedTs = Math.floor(publishedTs / 1000) * 1000;
    }
    const xmlOrder = itemIndex++;

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
      imageUrl,
      _xmlOrder: xmlOrder
    });
  }

  // Ordenar siempre de más reciente a más antigua antes de recortar o insertar
  items.sort((a, b) => {
    const diff = (b.publishedTs || 0) - (a.publishedTs || 0);
    if (diff !== 0) return diff;
    return (a._xmlOrder || 0) - (b._xmlOrder || 0);
  });

  return { feedTitle, siteUrl, items };
}

// ============================================================================
// Motor Inteligente de Obtención de Imágenes (Estilo Feedly):
// 1. Imagen propia del RSS
// 2. Scraping og:image / twitter:image de la web original (descartando logos repetidos)
// 3. Búsqueda automática de fotografía periodística contextual por titular (sin repetir imágenes)
// ============================================================================

let redditFetchChain = Promise.resolve();

async function fetchWithTimeout(url, options = {}, timeoutMs = 9500) {
  const isReddit = /reddit\.com/i.test(String(url || ''));
  if (isReddit) {
    const prev = redditFetchChain;
    let release;
    redditFetchChain = new Promise((r) => {
      release = r;
    });
    await prev;
    setTimeout(release, 2200);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const userAgent = isReddit
      ? 'macOS:com.jesusconde.feedlylocal:v2.1 (by /u/feedly_local)'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent,
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

// Comprueba si una URL de imagen ya está siendo usada por otro artículo distinto en la base de datos
function isImageAlreadyUsedByAnotherArticle(imageUrl, currentArticleId) {
  if (!imageUrl) return false;
  const row = db
    .prepare('SELECT id FROM articles WHERE image_url = ? AND id != ? LIMIT 1')
    .get(imageUrl, Number(currentArticleId) || 0);
  return Boolean(row);
}

async function fetchOgImageForArticle(articleUrl, articleId) {
  if (!articleUrl || !/^https?:\/\//i.test(articleUrl)) return '';
  if (articleUrl.includes('news.google.com/rss/articles/')) return '';
  try {
    const res = await fetchWithTimeout(articleUrl, {}, 4200);
    if (!res.ok) return '';
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return '';

    const html = (await res.text()).slice(0, 95000);
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
        if (
          !isLikelyTrackingOrGenericLogo(resolved) &&
          !isImageAlreadyUsedByAnotherArticle(resolved, articleId)
        ) {
          return resolved;
        }
      }
    }
  } catch {}
  return '';
}

// Búsqueda automática de fotografía contextual única para noticias sin imagen o de Google News / Reddit
async function findContextualNewsImage(article) {
  try {
    // Limpiar el título de sufijos "- Nombre del diario" o códigos de congresos
    let cleanTitle = String(article.title || '')
      .replace(/\s+-\s+[^-]+$/, '')
      .replace(/\[[^\]]+\]/g, ' ')
      .replace(/[^\p{L}\p{N}\s+-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Tomar las primeras 9 palabras significativas del titular + origen/autor si es corto
    const words = cleanTitle.split(' ').filter((w) => w.length > 2).slice(0, 9);
    let query = words.join(' ');
    if (query.length < 15 && article.feed_title) {
      query += ' ' + article.feed_title.replace(/\(Alerta[^)]*\)/i, '').trim();
    }
    if (!query) query = 'technology news';

    const searchUrl = `https://www.bing.com/images/async?q=${encodeURIComponent(
      query
    )}&first=1&count=14&qft=+filterui:photo-photo`;

    const res = await fetchWithTimeout(searchUrl, {}, 4800);
    if (!res.ok) return '';
    const html = await res.text();

    // Extraer todas las miniaturas de alta disponibilidad (turl) de los resultados
    const candidates = [];
    const turlRegex = /turl&quot;:&quot;(https?:\/\/[^&]+?(?:&amp;[^&]+?)*)&quot;/gi;
    let match;
    while ((match = turlRegex.exec(html)) !== null) {
      const rawTurl = decodeHtmlEntities(match[1]);
      if (rawTurl && rawTurl.startsWith('http')) {
        // Pedir recorte panorámico 16:9 limpio (480x270) al CDN de imágenes
        const formattedUrl = `${rawTurl}&w=480&h=270&c=7`;
        candidates.push(formattedUrl);
      }
    }

    if (candidates.length === 0) return '';

    // Elegir la primera imagen relevante que NO esté repetida en ningún otro artículo
    const startOffset = Number(article.id || 0) % Math.min(candidates.length, 4);
    for (let i = 0; i < candidates.length; i++) {
      const idx = (startOffset + i) % candidates.length;
      const candidate = candidates[idx];
      if (!isImageAlreadyUsedByAnotherArticle(candidate, article.id)) {
        return candidate;
      }
    }

    return candidates[0];
  } catch {
    return '';
  }
}

// Evita resoluciones duplicadas simultáneas para el mismo artículo
const inFlightArticleImageResolvers = new Map();

async function resolveAndSaveArticleImage(articleId) {
  const id = Number(articleId);
  if (inFlightArticleImageResolvers.has(id)) {
    return inFlightArticleImageResolvers.get(id);
  }

  const task = (async () => {
    try {
      let row = db
        .prepare(`
          SELECT a.id, a.title, a.link, a.image_url, a.author, f.title AS feed_title
          FROM articles a
          JOIN feeds f ON f.id = a.feed_id
          WHERE a.id = ?
        `)
        .get(id);

      if (!row && recentlyReadById.has(id)) {
        row = recentlyReadById.get(id);
      }

      if (!row) return '';

      // Si ya tiene una imagen única válida, usarla
      if (
        row.image_url &&
        row.image_url !== 'none' &&
        !isImageAlreadyUsedByAnotherArticle(row.image_url, row.id)
      ) {
        return row.image_url;
      }

      // Paso 1: Intentar extraer og:image único del artículo original
      let discovered = await fetchOgImageForArticle(row.link, row.id);

      // Paso 2: Si la fuente no ofrece imagen (o era un logo repetido o es Google News),
      // buscar una fotografía contextual única para el titular de la noticia
      if (!discovered) {
        discovered = await findContextualNewsImage(row);
      }

      if (discovered) {
        db.prepare('UPDATE articles SET image_url = ? WHERE id = ?').run(discovered, row.id);
        if (recentlyReadById.has(id)) {
          recentlyReadById.get(id).image_url = discovered;
        }
        return discovered;
      }

      return '';
    } finally {
      inFlightArticleImageResolvers.delete(id);
    }
  })();

  inFlightArticleImageResolvers.set(id, task);
  return task;
}

// Enriquecedor continuo en segundo plano para pre-cargar imágenes únicas en la BD
let isEnrichingImages = false;
async function enrichMissingArticleImages() {
  if (isEnrichingImages) return;
  isEnrichingImages = true;
  try {
    while (true) {
      const missing = db
        .prepare(`
          SELECT id FROM articles
          WHERE image_url IS NULL OR image_url = ''
          ORDER BY published_ts DESC
          LIMIT 24
        `)
        .all();

      if (missing.length === 0) break;

      // Procesar en lotes de 6 en paralelo
      for (let i = 0; i < missing.length; i += 6) {
        const chunk = missing.slice(i, i + 6);
        await Promise.all(
          chunk.map(async (r) => {
            const url = await resolveAndSaveArticleImage(r.id);
            if (!url) {
              db.prepare("UPDATE articles SET image_url = 'none' WHERE id = ?").run(r.id);
            }
          })
        );
      }
    }
  } finally {
    isEnrichingImages = false;
  }
}

// ============================================================================
// Autodetección de Feeds y Sincronización por Lotes
// ============================================================================

async function discoverFeedUrl(inputUrl) {
  let normalized = inputUrl.trim();
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

    // Comprobar si la noticia ya fue leída/descartada (por guid en cualquier feed, o por enlace/título normalizado)
    const checkDismissedByGuid = db.prepare(
      'SELECT 1 FROM dismissed_guids WHERE guid = ? LIMIT 1'
    );
    const checkDismissedByLink = db.prepare(
      "SELECT 1 FROM dismissed_guids WHERE norm_link = ? AND norm_link != '' LIMIT 1"
    );
    const checkDismissedByTitle = db.prepare(
      "SELECT 1 FROM dismissed_guids WHERE norm_title = ? AND norm_title != '' LIMIT 1"
    );

    const checkExistingGuid = db.prepare(
      'SELECT id FROM articles WHERE guid = ? LIMIT 1'
    );
    const checkExistingTitle = db.prepare(
      'SELECT id, title, link FROM articles WHERE lower(substr(title, 1, 28)) = lower(substr(?, 1, 28)) LIMIT 10'
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
    // Tomar las 20 noticias más recientes del feed e insertarlas de más antigua a más nueva
    // para que la más reciente tenga también el mayor id en desempates (ORDER BY published_ts DESC, id DESC)
    const itemsToProcess = parsed.items.slice(0, 20).reverse();

    for (const item of itemsToProcess) {
      const normTitle = normalizeArticleTitleKey(item.title);
      const normLink = normalizeArticleLinkKey(item.link);

      if (checkDismissedByGuid.get(item.guid)) continue;
      if (normLink.length >= 12 && checkDismissedByLink.get(normLink)) continue;
      if (normTitle.length >= 18 && checkDismissedByTitle.get(normTitle)) continue;

      if (checkExistingGuid.get(item.guid)) continue;

      // Evitar insertar la misma noticia si ya existe en otro feed por título o enlace normalizado
      let duplicateExisting = false;
      const similarCandidates = checkExistingTitle.all(item.title);
      for (const cand of similarCandidates) {
        if (
          (normTitle.length >= 18 && normalizeArticleTitleKey(cand.title) === normTitle) ||
          (normLink.length >= 12 && normalizeArticleLinkKey(cand.link) === normLink)
        ) {
          duplicateExisting = true;
          break;
        }
      }
      if (duplicateExisting) continue;

      // Si la imagen del RSS ya está repetida en otro artículo (ej. un logo fijo del blog),
      // dejarla vacía para que el buscador contextual le asigne una foto única
      let finalImg = item.imageUrl || '';
      if (finalImg && isImageAlreadyUsedByAnotherArticle(finalImg, 0)) {
        finalImg = '';
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
        finalImg,
        now
      );

      insertFts.run(result.lastInsertRowid, item.title, item.excerpt || '', feedRow.title);
      const catRowObj = db.prepare('SELECT name FROM categories WHERE id = ?').get(feedRow.category_id);
      recordArticleInHistory(item, feedRow, catRowObj ? catRowObj.name : '', result.lastInsertRowid);
      addedCount++;
    }

    db.prepare(`
      UPDATE feeds
      SET last_synced_at = ?, error_msg = NULL, site_url = COALESCE(NULLIF(site_url, ''), ?)
      WHERE id = ?
    `).run(new Date().toISOString(), parsed.siteUrl || '', feedRow.id);

    enrichMissingArticleImages().catch(() => {});
    return { feedId: feedRow.id, addedCount, error: null };
  } catch (err) {
    const msg = err && err.message ? err.message : 'Error de conexión';
    db.prepare('UPDATE feeds SET last_synced_at = ?, error_msg = ? WHERE id = ?').run(
      new Date().toISOString(),
      msg,
      feedRow.id
    );
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
    const shouldRunFullHourly = Date.now() - briefingStatus.lastHourlyRunAt >= 55 * 60 * 1000;
    runHourlyBriefingsMonitor({ forceOllama: shouldRunFullHourly }).catch(() => {});
  } finally {
    syncStatus.isSyncing = false;
    syncStatus.currentFeedTitle = '';
    syncStatus.lastCompletedAt = Date.now();
  }
}

function triggerAutoSyncIfNeeded(maxAgeMinutes = AUTO_SYNC_INTERVAL_MINUTES) {
  if (syncStatus.isSyncing) return false;
  const cutoffIso = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  const dueFeeds = db
    .prepare(`
      SELECT * FROM feeds
      WHERE last_synced_at IS NULL OR last_synced_at < ?
      ORDER BY COALESCE(last_synced_at, '') ASC, id ASC
    `)
    .all(cutoffIso);

  if (dueFeeds.length > 0) {
    syncFeedsBatch(dueFeeds, 8).catch((e) => console.error('Error en auto-sync:', e));
    return true;
  }
  return false;
}

// ============================================================================
// Estado, Artículos y Eliminación Inmediata de Leídas
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
        SUM(CASE WHEN a.is_saved = 1 OR (a.note IS NOT NULL AND a.note != '') THEN 1 ELSE 0 END) AS saved_count,
        SUM(CASE WHEN a.note IS NOT NULL AND a.note != '' THEN 1 ELSE 0 END) AS notes_count,
        SUM(CASE WHEN f.feed_type LIKE 'keyword_%' THEN 1 ELSE 0 END) AS keywords_count
      FROM articles a
      JOIN feeds f ON f.id = a.feed_id
    `)
    .get();

  const errorFeedsCount = feeds.filter((f) => Boolean(f.error_msg)).length;

  return {
    categories,
    feeds,
    totals: {
      all: totals?.all_count || 0,
      saved: totals?.saved_count || 0,
      notes: totals?.notes_count || 0,
      keywords: totals?.keywords_count || 0,
      feedsTotal: feeds.length,
      feedsWithError: errorFeedsCount
    },
    canUndoCount: recentDismissedBatches.length,
    syncStatus: { ...syncStatus }
  };
}

function buildArticlesFilterQuery({ feedId, categoryId, filter, search, excludeIds = [] }) {
  const params = [];
  let fromAndWhere = '';

  if (search && search.trim()) {
    const tokens = search
      .trim()
      .replace(/["'*^():-]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t}"*`)
      .join(' AND ');

    if (tokens) {
      fromAndWhere = `
        FROM articles_fts fts
        JOIN articles a ON a.id = fts.article_id
        JOIN feeds f ON f.id = a.feed_id
        JOIN categories c ON c.id = f.category_id
        WHERE articles_fts MATCH ?
      `;
      params.push(tokens);
    }
  }

  if (!fromAndWhere) {
    fromAndWhere = `
      FROM articles a
      JOIN feeds f ON f.id = a.feed_id
      JOIN categories c ON c.id = f.category_id
      WHERE 1=1
    `;
  }

  if (feedId) {
    fromAndWhere += ` AND a.feed_id = ?`;
    params.push(Number(feedId));
  }
  if (categoryId) {
    fromAndWhere += ` AND f.category_id = ?`;
    params.push(Number(categoryId));
  }
  if (filter === 'saved') {
    fromAndWhere += ` AND (a.is_saved = 1 OR (a.note IS NOT NULL AND a.note != ''))`;
  } else if (filter === 'notes') {
    fromAndWhere += ` AND (a.note IS NOT NULL AND a.note != '')`;
  } else if (filter === 'keywords') {
    fromAndWhere += ` AND f.feed_type LIKE 'keyword_%'`;
  }

  const validExclude = Array.isArray(excludeIds)
    ? excludeIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];

  let excludeClause = '';
  const excludeParams = [];
  if (validExclude.length > 0) {
    const capped = validExclude.slice(0, 900);
    const placeholders = capped.map(() => '?').join(',');
    excludeClause = ` AND a.id NOT IN (${placeholders})`;
    excludeParams.push(...capped);
  }

  return { fromAndWhere, params, excludeClause, excludeParams };
}

function queryArticlesWithTotal({ feedId, categoryId, filter, search, excludeIds = [], limit = 90 }) {
  const { fromAndWhere, params, excludeClause, excludeParams } = buildArticlesFilterQuery({
    feedId,
    categoryId,
    filter,
    search,
    excludeIds
  });

  const now = Date.now();
  const cutoff24h = now - 24 * 3600 * 1000;
  const cutoff7d = now - 7 * 24 * 3600 * 1000;

  const countRow = db
    .prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN a.published_ts < ? THEN 1 ELSE 0 END) AS older_24h,
        SUM(CASE WHEN a.published_ts < ? THEN 1 ELSE 0 END) AS older_7d
      ${fromAndWhere}
    `)
    .get(cutoff24h, cutoff7d, ...params);

  const totalMatching = countRow?.total || 0;
  const ageCounts = {
    all: totalMatching,
    older24h: countRow?.older_24h || 0,
    older7d: countRow?.older_7d || 0
  };

  const selectSql = `
    SELECT
      a.*,
      f.title AS feed_title,
      f.site_url AS feed_site_url,
      f.feed_type AS feed_type,
      c.name AS category_name
    ${fromAndWhere}
    ${excludeClause}
    ORDER BY a.published_ts DESC, a.id DESC
    LIMIT ?
  `;

  const articles = db
    .prepare(selectSql)
    .all(...params, ...excludeParams, Number(limit));

  return { articles, totalMatching, ageCounts };
}

function queryArticles(opts) {
  return queryArticlesWithTotal(opts).articles;
}

function markArticlesReadAndDeleteImmediate(articleIds, options = {}) {
  if (!Array.isArray(articleIds) || articleIds.length === 0) {
    return { deletedIds: [], preservedSavedIds: [], canUndoCount: recentDismissedBatches.length };
  }

  const deletedIds = [];
  const deletedIdSet = new Set();
  const preservedSavedIds = [];
  const backupArticles = [];
  const now = Date.now();

  const getArticle = db.prepare('SELECT * FROM articles WHERE id = ?');
  const getFeed = db.prepare('SELECT title FROM feeds WHERE id = ?');
  const findDupByGuid = db.prepare(
    'SELECT * FROM articles WHERE guid = ? AND id != ?'
  );
  const findDupCandidatesByTitle = db.prepare(
    'SELECT * FROM articles WHERE lower(substr(title, 1, 25)) = lower(substr(?, 1, 25)) AND id != ?'
  );
  const deleteArticle = db.prepare('DELETE FROM articles WHERE id = ?');
  const deleteFts = db.prepare('DELETE FROM articles_fts WHERE article_id = ?');
  const insertDismissed = db.prepare(`
    INSERT OR REPLACE INTO dismissed_guids (feed_id, guid, dismissed_at, norm_title, norm_link)
    VALUES (?, ?, ?, ?, ?)
  `);

  function dismissSingleRow(row) {
    if (!row || deletedIdSet.has(row.id)) return;
    if (row.is_saved === 1 || (row.note && row.note.trim() !== '')) {
      preservedSavedIds.push(row.id);
      return;
    }

    const feedRow = getFeed.get(row.feed_id);
    const enriched = {
      ...row,
      feed_title: feedRow ? feedRow.title : ''
    };
    backupArticles.push(enriched);
    rememberRecentlyReadArticle(enriched);
    recordArticleInHistory(enriched, { id: row.feed_id, title: enriched.feed_title }, '', row.id);

    const normTitle = normalizeArticleTitleKey(row.title);
    const normLink = normalizeArticleLinkKey(row.link);

    insertDismissed.run(row.feed_id, row.guid, now, normTitle, normLink);
    deleteArticle.run(row.id);
    deleteFts.run(row.id);
    deletedIdSet.add(row.id);
    deletedIds.push(row.id);

    // Si existen copias idénticas de esta misma noticia en otros feeds, marcarlas también como leídas
    for (const dup of findDupByGuid.all(row.guid, row.id)) {
      if (!deletedIdSet.has(dup.id) && dup.is_saved !== 1 && (!dup.note || !dup.note.trim())) {
        dismissSingleRow(dup);
      }
    }
    if (normTitle.length >= 18 || normLink.length >= 12) {
      for (const cand of findDupCandidatesByTitle.all(row.title, row.id)) {
        if (deletedIdSet.has(cand.id)) continue;
        const candTitle = normalizeArticleTitleKey(cand.title);
        const candLink = normalizeArticleLinkKey(cand.link);
        if (
          (normTitle.length >= 18 && candTitle === normTitle) ||
          (normLink.length >= 12 && candLink === normLink)
        ) {
          dismissSingleRow(cand);
        }
      }
    }
  }

  for (const rawId of articleIds) {
    const id = Number(rawId);
    if (!id || deletedIdSet.has(id)) continue;
    const row = getArticle.get(id);
    if (!row) continue;
    dismissSingleRow(row);
  }

  if (backupArticles.length > 0) {
    const isScrollSource = options.source === 'scroll' || options.source === 'open';
    // Si viene del scroll automático y hace menos de 45s que añadimos al lote de scroll, agrupar en el mismo lote de Deshacer
    if (
      isScrollSource &&
      recentDismissedBatches.length > 0 &&
      now - lastScrollDismissTimestamp < 45000 &&
      recentDismissedBatches[recentDismissedBatches.length - 1].length < 250
    ) {
      recentDismissedBatches[recentDismissedBatches.length - 1].push(...backupArticles);
    } else {
      recentDismissedBatches.push(backupArticles);
      if (recentDismissedBatches.length > MAX_UNDO_BATCHES) {
        recentDismissedBatches.shift();
      }
    }
    if (isScrollSource) {
      lastScrollDismissTimestamp = now;
    } else {
      lastScrollDismissTimestamp = 0;
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
// Motor Agéntico Local de Monitoreo Horario e Informes (Gemma 4 + Clustering)
// ============================================================================

const BRIEFING_SCOPES = {
  unread: { key: 'unread', title: 'Actuales (No leídas)', hours: null },
  '1h': { key: '1h', title: 'Última hora (1h)', hours: 1 },
  '12h': { key: '12h', title: 'Últimas 12 horas', hours: 12 },
  '24h': { key: '24h', title: 'Últimas 24 horas', hours: 24 }
};

const BILINGUAL_STOPWORDS = new Set([
  'the','and','for','that','with','from','this','are','was','will','have','has','not','but','what','all','were','when',
  'can','more','out','new','about','into','than','its','over','after','how','who','why','you','your','our','their','his',
  'her','they','them','been','being','just','could','would','should','also','says','said','amid','while','after','before',
  'para','con','los','las','del','una','por','como','más','pero','sus','este','esta','entre','cuando','todo','son','dos',
  'también','fue','había','muy','años','hasta','desde','está','porque','qué','sólo','han','hay','vez','puede','todos',
  'así','nos','parte','tiene','donde','bien','tiempo','mismo','ese','ahora','cada','vida','otro','después','otros',
  'aunque','esa','eso','hace','otra','tan','durante','siempre','día','tanto','ella','tres','dijo','sido','gran','país',
  'según','menos','mundo','año','antes','estado','contra','sino','forma','caso','nada','hacer','general','estaba','poco',
  'estos','mayor','ante','unos','les','algo','hacia','ayer','hecho','primera','mucho','mientras','además','quien',
  'momento','esto','están','pues','hoy','lugar','otras','mejor','nuevo','decir','algunos','entonces','todas','días',
  'debe','cómo','casi','toda','tal','luego','pasado','primer','medio','estas','sea','tenía','nunca','aquí','ver','veces',
  'embargo','personas','grupo','cuenta','pueden','tienen','misma','nueva','cual','fueron','frente','tras','cosas','fin',
  'manera','tener','será','muchos','tipo','cuatro','dentro','nuestro','punto','dice','ello','cualquier','parece','haber',
  'fuera','bajo','grandes','nuestra','ejemplo','habían','hizo','nadie','horas','posible','tarde','lado','allí','eran',
  'estar','unas','final','través','último','modo','cinco','algunas','todavía','meses','esos','nosotros','hora','muchas',
  'alguna','dar','podría','sería','junto','aquel','cuanto','segundo','dicho','cierto','casos','nivel','podía','largo',
  'partir','falta','llegar','propio','cosa','primero','hemos','trata','algún','tuvo','respecto','semana','varios','real',
  'paso','mil','quienes','mayoría','claro','iba','éste','buena','quiere','aquella','van','esas','segunda','puesto','ahí',
  'propia','igual','últimos','ellas','total','creo','tengo','solo','único','pesar','sabe','tampoco','ningún','vista',
  'buen','hubiera','saber','razón','noticias','alerta','google','news','reddit','com','www','http','https'
]);

// Equivalencias canónicas bilingües (ES <-> EN) para fusionar clústeres de una misma noticia internacional
const BILINGUAL_CANONICAL_MAP = new Map([
  ['bolsa', 'ipo_market'],
  ['opi', 'ipo_market'],
  ['ipo', 'ipo_market'],
  ['nasdaq', 'ipo_market'],
  ['cotizará', 'ipo_market'],
  ['cotizar', 'ipo_market'],
  ['s1', 'ipo_market'],
  ['filing', 'ipo_market'],
  ['filed', 'ipo_market'],
  ['files', 'ipo_market'],
  ['public', 'ipo_market'],
  ['billones', 'valuation_scale'],
  ['trillion', 'valuation_scale'],
  ['billion', 'valuation_scale'],
  ['millones', 'valuation_scale'],
  ['valoración', 'valuation_scale'],
  ['valuation', 'valuation_scale'],
  ['pérdidas', 'loss_metric'],
  ['pérdida', 'loss_metric'],
  ['loss', 'loss_metric'],
  ['losses', 'loss_metric'],
  ['ingresos', 'revenue_metric'],
  ['revenue', 'revenue_metric'],
  ['demanda', 'lawsuit_legal'],
  ['demandan', 'lawsuit_legal'],
  ['demandada', 'lawsuit_legal'],
  ['sued', 'lawsuit_legal'],
  ['sues', 'lawsuit_legal'],
  ['lawsuit', 'lawsuit_legal'],
  ['copyright', 'lawsuit_legal'],
  ['canciones', 'music_rights'],
  ['música', 'music_rights'],
  ['music', 'music_rights'],
  ['songs', 'music_rights'],
  ['votantes', 'election_data'],
  ['electorales', 'election_data'],
  ['electoral', 'election_data'],
  ['elecciones', 'election_data'],
  ['election', 'election_data'],
  ['voter', 'election_data'],
  ['voters', 'election_data'],
  ['accedió', 'unauthorized_access'],
  ['accessed', 'unauthorized_access'],
  ['unauthorized', 'unauthorized_access'],
  ['autorización', 'unauthorized_access'],
  ['paywall', 'unauthorized_access'],
  ['inversores', 'investors_risk'],
  ['investors', 'investors_risk']
]);

const briefingFullTextCache = new Map();
db.exec(`
  CREATE TABLE IF NOT EXISTS translations_cache (
    src_text TEXT PRIMARY KEY,
    es_text TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
const getCachedTransStmt = db.prepare('SELECT es_text FROM translations_cache WHERE src_text = ?');
const setCachedTransStmt = db.prepare(
  'INSERT OR REPLACE INTO translations_cache (src_text, es_text, updated_at) VALUES (?, ?, ?)'
);

function isLikelyEnglishText(text) {
  if (!text || text.length < 8) return false;
  // Ignorar etiquetas de versión puras sin espacios (ej. rust-v0.165.0-alpha.2)
  if (!/\s/.test(text.trim())) return false;
  const hasSaxonGenitive = /\b[a-z0-9]+['’]s\b/i.test(text);
  const esAccents = (text.match(/[áéíóúñ¿¡]/gi) || []).length;
  const esHits = (
    text.match(
      /\b(de|la|el|en|los|las|del|por|para|con|una|un|al|se|su|sus|como|pero|sobre|tras|ante|entre|hasta|desde|sin|son|fue|fueron|ha|han|hay|esta|este|estos|estas|todo|todos|puede|pueden|hace|hacen|contra|hacia|durante|mediante|según|más|también|así|ya|no|sí|qué|cómo|cuándo|dónde|quién)\b/gi
    ) || []
  ).length;
  const enHits = (
    text.match(
      /\b(the|and|for|with|from|that|this|after|over|into|amid|while|its|his|her|their|our|your|says|said|files|filed|filing|warns|shows|claims|launches|launched|accessed|access|without|against|could|would|should|new|how|why|what|when|where|who|biggest|bigger|first|last|next|year|years|half|loss|losses|revenue|billion|trillion|million|sued|sues|lawsuit|models|model|training|train|trained|data|in|on|to|of|at|by|as|is|are|was|were|be|been|up|out|off|about|inside|under|between|through|during|before|since|until|despite|towards|open|source|free|vs|caution|input|output|params|steps|tutorial|guide|coding|agents|agent|weakened|misalignment|monitoring|quiet|jump|tops|weekly|usage|rankings|token|volume|surges|surge|cheeky|quip|python|campaign|ally|blushes|comments|crossed|paywall|own|deal|even|knew|voter|voting|election|officials|public|songs|used|permission|former|staffers|startup|hacked|things|can|do|backed|features|testing|aimed|other|kernels|monday|tuesday|wednesday|thursday|friday|saturday|sunday|long|awaited|unveils|time|wall|street|stock|shares|market|report|reports|users|release|released|cut|cuts|live|internet|stop|rogue|attacks|experimental|removed)\b/gi
    ) || []
  ).length;
  if (hasSaxonGenitive && esAccents === 0) return true;
  if (esAccents === 0 && esHits === 0) return true;
  return enHits >= 1 && enHits > esHits;
}

function translateToSpanishFallback(text) {
  if (!text || !isLikelyEnglishText(text)) return text;
  const cached = getCachedTransStmt.get(text);
  if (cached && cached.es_text) return cached.es_text;
  return text;
}

async function translateClustersToSpanishWithOllama(clusters, categoriesBreakdown, modelOverride = null) {
  const toTranslate = [];
  const seen = new Set();

  function collectIfEnglish(str) {
    const clean = String(str || '').trim();
    if (!clean || clean.length < 8) return;
    if (!isLikelyEnglishText(clean)) return;
    const cached = getCachedTransStmt.get(clean);
    if (cached && cached.es_text) return;
    if (!seen.has(clean)) {
      seen.add(clean);
      toTranslate.push(clean);
    }
  }

  for (const cl of clusters) {
    collectIfEnglish(cl.title);
    if (cl.leadExcerpt) collectIfEnglish(cl.leadExcerpt.slice(0, 260));
    if (cl.deepParagraphs && cl.deepParagraphs[0]) {
      collectIfEnglish(cl.deepParagraphs[0].slice(0, 280));
    }
    for (const sa of (cl.sampleArticles || []).slice(0, 5)) {
      collectIfEnglish(sa.title);
    }
  }
  for (const cat of categoriesBreakdown || []) {
    for (const st of (cat.topStories || []).slice(0, 3)) {
      collectIfEnglish(st.title);
    }
  }

  if (toTranslate.length > 0 && briefingStatus.ollamaOnline) {
    const chosenModel = modelOverride || getPreferredOllamaModel();
    const batchSize = 22;
    const now = Date.now();

    for (let i = 0; i < Math.min(toTranslate.length, 66); i += batchSize) {
      const batch = toTranslate.slice(i, i + batchSize);
      const numberedInput = batch.map((t, idx) => `[${idx + 1}] ${t}`).join('\n');
      const prompt = `Traduce fielmente al ESPAÑOL los siguientes titulares y extractos de noticias tecnológicas/financieras. Mantén nombres propios (Anthropic, Claude, OpenAI, SpaceX, xAI, DeepSeek, Qwen, Mistral, S-1, IPO/OPI, Nasdaq) y cifras exactas. Devuelve ÚNICAMENTE las líneas traducidas con su mismo número [1], [2], etc., sin introducciones ni comentarios:\n\n${numberedInput}`;

      try {
        const res = await fetchWithTimeout(
          'http://127.0.0.1:11434/api/chat',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: chosenModel,
              stream: false,
              think: false,
              options: { temperature: 0.1, num_ctx: 4096 },
              messages: [
                {
                  role: 'system',
                  content: 'Eres un traductor periodístico profesional inglés-español. Solo respondes con las líneas numeradas traducidas.'
                },
                { role: 'user', content: prompt }
              ]
            })
          },
          30000
        );
        if (res.ok) {
          const data = await res.json();
          let out = (data?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
          const lines = out.split('\n');
          for (const line of lines) {
            const m = line.trim().match(/^(?:\*\*|\[|\s)*(\d+)(?:\]|\)|\s|\.|:|-|\*)+(.+)$/);
            if (m) {
              const idx = Number(m[1]) - 1;
              const translated = m[2].replace(/^["«*]+|["»*]+$/g, '').trim();
              if (batch[idx] && translated.length >= 6) {
                setCachedTransStmt.run(batch[idx], translated, now);
              }
            }
          }
        }
      } catch {}
    }
  }

  // Aplicar traducciones en caché a todos los clústeres y categorías
  const applyCached = (str) => {
    const clean = String(str || '').trim();
    if (!clean) return clean;
    const row = getCachedTransStmt.get(clean);
    return row && row.es_text ? row.es_text : clean;
  };

  for (const cl of clusters) {
    cl.title = applyCached(cl.title);
    if (cl.leadExcerpt) {
      const sliceKey = cl.leadExcerpt.slice(0, 260).trim();
      const row = getCachedTransStmt.get(sliceKey);
      if (row && row.es_text) cl.leadExcerpt = row.es_text;
    }
    if (cl.deepParagraphs && cl.deepParagraphs[0]) {
      const dpKey = cl.deepParagraphs[0].slice(0, 280).trim();
      const row = getCachedTransStmt.get(dpKey);
      if (row && row.es_text) cl.deepParagraphs[0] = row.es_text;
    }
    for (const sa of cl.sampleArticles || []) {
      sa.title = applyCached(sa.title);
    }
  }
  for (const cat of categoriesBreakdown || []) {
    for (const st of cat.topStories || []) {
      st.title = applyCached(st.title);
    }
  }
}
const briefingStatus = {
  isGenerating: false,
  lastHourlyRunAt: 0,
  preferredModel: 'gemma4:12b',
  availableModels: [],
  ollamaOnline: false
};

function getPreferredOllamaModel() {
  try {
    const row = db.prepare("SELECT value FROM meta_settings WHERE key = 'briefing_ollama_model'").get();
    if (row && row.value) return row.value;
  } catch {}
  return briefingStatus.preferredModel || 'gemma4:12b';
}

function setPreferredOllamaModel(modelName) {
  const clean = String(modelName || '').trim() || 'gemma4:12b';
  briefingStatus.preferredModel = clean;
  db.prepare("INSERT OR REPLACE INTO meta_settings (key, value) VALUES ('briefing_ollama_model', ?)").run(clean);
}

async function detectLocalOllamaModels() {
  try {
    const res = await fetchWithTimeout('http://127.0.0.1:11434/api/tags', {}, 1800);
    if (!res.ok) {
      briefingStatus.ollamaOnline = false;
      return [];
    }
    const data = await res.json();
    const models = Array.isArray(data.models)
      ? data.models.map((m) => m.name).filter(Boolean)
      : [];
    briefingStatus.ollamaOnline = true;
    briefingStatus.availableModels = models;

    const currentPref = getPreferredOllamaModel();
    if (models.length > 0 && !models.includes(currentPref)) {
      const gemma4Pick =
        models.find((m) => /gemma4.*(12b|26b)/i.test(m)) ||
        models.find((m) => /gemma4/i.test(m)) ||
        models.find((m) => /gemma/i.test(m)) ||
        models.find((m) => /qwen3/i.test(m)) ||
        models[0];
      if (gemma4Pick) {
        setPreferredOllamaModel(gemma4Pick);
      }
    }
    return models;
  } catch {
    briefingStatus.ollamaOnline = false;
    return [];
  }
}

function tokenizeForClustering(title, excerpt = '') {
  const cleanTitle = String(title || '')
    .toLowerCase()
    .replace(/\s+[-–—|]\s+[^-–—|]{2,50}$/, '')
    .replace(/s-1/g, 's1');

  const rawWords = cleanTitle
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !BILINGUAL_STOPWORDS.has(w));

  const tokenSet = new Set();
  for (const w of rawWords) {
    const canonical = BILINGUAL_CANONICAL_MAP.get(w) || w;
    tokenSet.add(canonical);
  }

  // Añadir entidades clave del extracto si existen
  if (excerpt) {
    const exWords = String(excerpt)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .filter((w) => BILINGUAL_CANONICAL_MAP.has(w));
    for (const ew of exWords) {
      tokenSet.add(BILINGUAL_CANONICAL_MAP.get(ew));
    }
  }

  return tokenSet;
}

function cleanSourceName(title, feedTitle) {
  const trailingMatch = String(title || '').match(/\s+[-–—|]\s+([^-–—|]{2,42})$/);
  if (trailingMatch && trailingMatch[1]) {
    return trailingMatch[1].trim();
  }
  return String(feedTitle || 'Fuente RSS')
    .replace(/\s*\(Alerta.*?\)/i, '')
    .replace(/^Alerta:\s*/i, '')
    .trim();
}

function stripTrailingSourceFromTitle(title) {
  return String(title || '')
    .replace(/\s+[-–—|]\s+[^-–—|]{2,45}$/, '')
    .trim();
}

function queryArticlesForBriefingScope(scopeKey, categoryId = null) {
  const now = Date.now();
  const activeUnreadMap = new Map();
  const unreadRows = db
    .prepare(`
      SELECT a.id, a.guid, a.title, a.link, a.pub_date, a.published_ts, a.excerpt,
             a.feed_id, f.title AS feed_title, f.category_id, c.name AS category_name
      FROM articles a
      JOIN feeds f ON f.id = a.feed_id
      JOIN categories c ON c.id = f.category_id
      ORDER BY a.published_ts DESC
    `)
    .all();

  for (const r of unreadRows) {
    activeUnreadMap.set(`${r.feed_id}::${r.guid}`, r.id);
  }

  if (scopeKey === 'unread') {
    if (categoryId) {
      return unreadRows
        .filter((r) => Number(r.category_id) === Number(categoryId))
        .map((r) => ({ ...r, unread_id: r.id }));
    }
    return unreadRows.map((r) => ({ ...r, unread_id: r.id }));
  }

  const scopeDef = BRIEFING_SCOPES[scopeKey] || BRIEFING_SCOPES['24h'];
  const cutoffTs = now - (scopeDef.hours || 24) * 3600 * 1000;

  let historyRows = db
    .prepare(`
      SELECT h.*
      FROM articles_history h
      WHERE h.published_ts >= ?
      ORDER BY h.published_ts DESC
    `)
    .all(cutoffTs);

  // Si en "Última hora" hay muy pocas noticias con pubDate de los últimos 60 min (por desfase horario RSS),
  // incluir también las sincronizadas/recibidas durante la última hora
  if (scopeKey === '1h' && historyRows.length < 8) {
    historyRows = db
      .prepare(`
        SELECT h.*
        FROM articles_history h
        WHERE h.published_ts >= ? OR h.created_at >= ?
        ORDER BY h.published_ts DESC
        LIMIT 140
      `)
      .all(cutoffTs, cutoffTs);
  }

  if (categoryId) {
    historyRows = historyRows.filter((r) => Number(r.category_id) === Number(categoryId));
  }

  return historyRows.map((r) => ({
    id: r.article_id || r.id,
    unread_id: activeUnreadMap.get(`${r.feed_id}::${r.guid}`) || null,
    guid: r.guid,
    title: r.title,
    link: r.link,
    pub_date: r.pub_date,
    published_ts: r.published_ts,
    excerpt: r.excerpt,
    feed_id: r.feed_id,
    feed_title: r.feed_title,
    category_id: r.category_id,
    category_name: r.category_name
  }));
}

function cleanExcerptText(excerpt, title = '') {
  if (!excerpt) return '';
  let txt = String(excerpt)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const baseTitle = stripTrailingSourceFromTitle(title);
  if (baseTitle && txt.toLowerCase().startsWith(baseTitle.toLowerCase().slice(0, 32))) {
    return '';
  }
  return txt;
}

const BROAD_ACTOR_TOKENS = new Set([
  'anthropic','claude','openai','chatgpt','google','gemini','apple','meta','microsoft','nvidia',
  'inteligencia','artificial','model','models','modelo','modelos'
]);

function buildTopicClusters(rows) {
  const now = Date.now();
  const clusters = [];

  for (const row of rows) {
    const tks = tokenizeForClustering(row.title, row.excerpt);
    if (tks.size === 0) continue;

    let bestCluster = null;
    let bestScore = 0;

    for (const cl of clusters) {
      let overlap = 0;
      let specificEventOverlap = 0;
      let canonicalOverlap = 0;
      for (const t of tks) {
        if (cl.anchorTokens.has(t)) {
          overlap++;
          if (!BROAD_ACTOR_TOKENS.has(t)) specificEventOverlap++;
          if (t.includes('_')) canonicalOverlap++;
        } else if (cl.allTokens.has(t)) {
          overlap += 0.6;
          if (!BROAD_ACTOR_TOKENS.has(t)) specificEventOverlap += 0.6;
          if (t.includes('_')) canonicalOverlap += 0.7;
        }
      }
      const minLen = Math.max(1, Math.min(tks.size, cl.anchorTokens.size));
      const sim = overlap / minLen;

      if (
        specificEventOverlap >= 1 &&
        ((overlap >= 2.0 && sim >= 0.34) || (canonicalOverlap >= 1 && overlap >= 1.8 && sim >= 0.26))
      ) {
        if (sim > bestScore) {
          bestScore = sim;
          bestCluster = cl;
        }
      }
    }

    if (bestCluster) {
      bestCluster.items.push(row);
      if (bestCluster.items.length <= 5) {
        for (const t of tks) bestCluster.anchorTokens.add(t);
      }
      for (const t of tks) {
        bestCluster.allTokens.add(t);
        bestCluster.tokenFreq.set(t, (bestCluster.tokenFreq.get(t) || 0) + 1);
      }
    } else {
      const tokenFreq = new Map();
      for (const t of tks) tokenFreq.set(t, 1);
      clusters.push({
        anchorTokens: new Set(tks),
        allTokens: new Set(tks),
        tokenFreq,
        items: [row]
      });
    }
  }

  const enrichedClusters = clusters.map((cl, idx) => {
    const uniqueSources = new Set();
    const unreadIds = new Set();
    const categoriesFreq = new Map();
    let newestTs = 0;

    for (const it of cl.items) {
      uniqueSources.add(cleanSourceName(it.title, it.feed_title));
      if (it.unread_id) unreadIds.add(it.unread_id);
      if (it.category_name) {
        categoriesFreq.set(it.category_name, (categoriesFreq.get(it.category_name) || 0) + 1);
      }
      if ((Number(it.published_ts) || 0) > newestTs) {
        newestTs = Number(it.published_ts) || 0;
      }
    }

    // Elegir el mejor artículo de portada para el clúster (preferencia español o con buen extracto)
    const sortedRep = [...cl.items].sort((a, b) => {
      const aEs = /[áéíóúñ¿¡]|(\b(de|la|el|en|con|por|para|bolsa|demanda)\b)/i.test(a.title) ? 1 : 0;
      const bEs = /[áéíóúñ¿¡]|(\b(de|la|el|en|con|por|para|bolsa|demanda)\b)/i.test(b.title) ? 1 : 0;
      if (aEs !== bEs) return bEs - aEs;
      const aEx = cleanExcerptText(a.excerpt, a.title).length > 40 ? 1 : 0;
      const bEx = cleanExcerptText(b.excerpt, b.title).length > 40 ? 1 : 0;
      if (aEx !== bEx) return bEx - aEx;
      return (Number(b.published_ts) || 0) - (Number(a.published_ts) || 0);
    });

    const lead = sortedRep[0] || cl.items[0];
    const dominantCategory =
      [...categoriesFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ||
      lead.category_name ||
      'General';

    const ageHours = Math.max(0.2, (now - (newestTs || now)) / (3600 * 1000));
    const recencyMultiplier = ageHours <= 2 ? 1.35 : ageHours <= 6 ? 1.2 : ageHours <= 12 ? 1.05 : 0.9;
    const isTechnicalCategory =
      !dominantCategory.startsWith('3.') && !dominantCategory.startsWith('6.') ? 1.25 : 1.0;

    // Penalizar series repetitivas de una única web frente a noticias confirmadas por múltiples medios
    const effectiveArticles = uniqueSources.size <= 1 ? Math.min(2, cl.items.length) : cl.items.length;
    const multiSourceBonus = uniqueSources.size >= 3 ? uniqueSources.size * 22 : uniqueSources.size * 12;
    const rawImpact =
      (multiSourceBonus + effectiveArticles * 9) * recencyMultiplier * isTechnicalCategory;

    const topKeywords = [...cl.tokenFreq.entries()]
      .filter(([k]) => !k.includes('_') && k.length >= 4)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k]) => k);

    // Artículos de muestra sin repetir titulares idénticos
    const sampleArticles = [];
    const seenSampleTitles = new Set();
    let bestLeadExcerpt = cleanExcerptText(lead.excerpt, lead.title);

    for (const item of cl.items) {
      const cleanedEx = cleanExcerptText(item.excerpt, item.title);
      if (!bestLeadExcerpt && cleanedEx.length > 45) {
        bestLeadExcerpt = cleanedEx;
      }
      const nt = normalizeArticleTitleKey(item.title).slice(0, 35);
      if (seenSampleTitles.has(nt)) continue;
      seenSampleTitles.add(nt);
      sampleArticles.push({
        id: item.unread_id || item.id,
        unreadId: item.unread_id || null,
        title: stripTrailingSourceFromTitle(item.title),
        source: cleanSourceName(item.title, item.feed_title),
        feedTitle: item.feed_title,
        link: item.link,
        publishedTs: item.published_ts,
        excerpt: cleanedEx
      });
      if (sampleArticles.length >= 7) break;
    }

    return {
      clusterId: `cl_${idx}_${lead.id || 0}`,
      title: stripTrailingSourceFromTitle(lead.title),
      leadSource: cleanSourceName(lead.title, lead.feed_title),
      leadLink: lead.link,
      leadExcerpt: bestLeadExcerpt,
      category: dominantCategory,
      articleCount: cl.items.length,
      sourceCount: uniqueSources.size,
      sources: Array.from(uniqueSources).slice(0, 10),
      unreadIds: Array.from(unreadIds),
      newestTs,
      impactScore: Math.round(rawImpact),
      keywords: topKeywords,
      sampleArticles,
      deepParagraphs: []
    };
  });

  enrichedClusters.sort((a, b) => b.impactScore - a.impactScore || b.articleCount - a.articleCount);
  return enrichedClusters;
}

async function enrichTopClustersWithDeepRead(clusters, maxClusters = 4) {
  const targets = clusters.slice(0, maxClusters);
  await Promise.all(
    targets.map(async (cl) => {
      for (const sample of cl.sampleArticles.slice(0, 2)) {
        if (!sample.link || sample.link.includes('news.google.com/rss/articles/')) continue;
        if (briefingFullTextCache.has(sample.link)) {
          cl.deepParagraphs = briefingFullTextCache.get(sample.link);
          return;
        }
        try {
          const paras = await Promise.race([
            extractReadableArticle(sample.link),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2800))
          ]);
          if (Array.isArray(paras) && paras.length > 0) {
            const cleanParas = paras
              .map((p) => p.text)
              .filter((t) => t && t.length >= 60)
              .slice(0, 3);
            if (cleanParas.length > 0) {
              briefingFullTextCache.set(sample.link, cleanParas);
              cl.deepParagraphs = cleanParas;
              return;
            }
          }
        } catch {}
      }
    })
  );
}

function buildCategoryBreakdown(rows) {
  const byCat = new Map();
  for (const r of rows) {
    const cat = r.category_name || 'General';
    if (!byCat.has(cat)) {
      byCat.set(cat, []);
    }
    byCat.get(cat).push(r);
  }

  const result = [];
  for (const [catName, items] of byCat.entries()) {
    const catClusters = buildTopicClusters(items);
    result.push({
      category: catName,
      totalArticles: items.length,
      topStories: catClusters.slice(0, 4).map((c) => ({
        title: c.title,
        source: c.leadSource,
        link: c.leadLink,
        articleCount: c.articleCount,
        unreadIds: c.unreadIds,
        sampleId: c.sampleArticles[0]?.id || null,
        excerpt: c.leadExcerpt ? c.leadExcerpt.slice(0, 180) : ''
      }))
    });
  }

  result.sort((a, b) => a.category.localeCompare(b.category, 'es'));
  return result;
}

function buildClusterShortDescription(cl) {
  if (cl.deepParagraphs && cl.deepParagraphs.length > 0) {
    return cl.deepParagraphs[0].slice(0, 300) + (cl.deepParagraphs[0].length > 300 ? '…' : '');
  }
  if (cl.leadExcerpt && cl.leadExcerpt.length >= 25) {
    return cl.leadExcerpt.slice(0, 260) + (cl.leadExcerpt.length > 260 ? '…' : '');
  }
  // Si el RSS era de solo titulares (ej. Google News), construir el resumen corto con los ángulos de otros medios del clúster
  const angles = (cl.sampleArticles || [])
    .slice(1, 4)
    .map((sa) => sa.title)
    .filter((t) => t && t !== cl.title);
  if (angles.length > 0) {
    return angles.join(' · ');
  }
  return '';
}

function buildStructuredExecutiveMarkdown(scopeTitle, totalArticles, clusters, categoriesBreakdown) {
  if (totalArticles === 0 || clusters.length === 0) {
    return `### Sin noticias registradas en «${scopeTitle}»\n\nNo se han encontrado artículos dentro de esta ventana temporal. Pulsa **Recargar** en la barra superior para sincronizar las fuentes RSS.`;
  }

  const star = clusters[0];
  const lines = [];

  lines.push(`### 🌟 Noticia Estrella del Momento`);
  lines.push(`**${star.title}**`);

  const starDesc = buildClusterShortDescription(star);
  if (starDesc) {
    lines.push(`${starDesc}`);
  }

  const starDetails = [];
  for (const sa of star.sampleArticles.slice(1, 5)) {
    if (sa.title && sa.title !== star.title) {
      starDetails.push(`${sa.title} (*${sa.source}*)`);
    }
  }

  if (starDetails.length > 0) {
    lines.push(`- **Puntos clave y cobertura complementaria:**`);
    for (const d of starDetails) {
      lines.push(`  - ${d}`);
    }
  }

  lines.push(
    `- **Medios donde ha aparecido (${star.articleCount} noticias en ${star.sourceCount} medios):** ${star.sources.slice(0, 8).join(', ')}.`
  );

  if (clusters.length > 1) {
    lines.push(`\n### 🔥 Grandes Temas en Tendencia (${scopeTitle})`);
    for (const cl of clusters.slice(1, 8)) {
      const shortDesc = buildClusterShortDescription(cl);
      const descPart = shortDesc ? ` — ${shortDesc}` : '';
      const sourcesPart = ` *(Aparecido en ${cl.articleCount} fuentes: ${cl.sources.slice(0, 5).join(', ')})*`;
      lines.push(`- **${cl.title}**${descPart}${sourcesPart}`);
    }
  }

  const techCats = categoriesBreakdown.filter((c) => !c.category.startsWith('3.'));
  if (techCats.length > 0) {
    lines.push(`\n### 📂 Radar Destacado por Carpetas Temáticas`);
    for (const cat of techCats) {
      if (cat.topStories.length === 0) continue;
      lines.push(`- **${cat.category} (${cat.totalArticles} noticias):**`);
      for (const st of cat.topStories.slice(0, 3)) {
        const descSnippet = st.excerpt ? ` — ${st.excerpt.slice(0, 120)}${st.excerpt.length > 120 ? '…' : ''}` : '';
        const countBadge = st.articleCount > 1 ? ` *(${st.articleCount} medios: ${st.source})*` : ` *(${st.source})*`;
        lines.push(`  - **${st.title}**${descSnippet}${countBadge}`);
      }
    }
  }

  return lines.join('\n');
}

async function synthesizeWithLocalOllama(scopeTitle, totalArticles, clusters, categoriesBreakdown, modelOverride = null) {
  const models = await detectLocalOllamaModels();
  if (!briefingStatus.ollamaOnline || models.length === 0) {
    return null;
  }

  const chosenModel = modelOverride || getPreferredOllamaModel();
  const topClustersText = clusters
    .slice(0, 10)
    .map((c, idx) => {
      const subTitles = c.sampleArticles
        .slice(0, 4)
        .map((s) => `"${s.title}" (${s.source})`)
        .join(' | ');
      const deep = c.deepParagraphs && c.deepParagraphs[0] ? `\n   Texto extraído: ${c.deepParagraphs[0].slice(0, 260)}` : '';
      return `${idx + 1}. [IMPACTO: ${c.articleCount} artículos en ${c.sourceCount} medios | Categoría: ${c.category}] Titular: ${c.title}\n   Variantes y cifras en titulares: ${subTitles}\n   Extracto: ${(c.leadExcerpt || '').slice(0, 220)}${deep}`;
    })
    .join('\n\n');

  const catsText = categoriesBreakdown
    .filter((c) => !c.category.startsWith('3.'))
    .map((c) => {
      const tops = c.topStories.slice(0, 3).map((s) => `${s.title} (${s.source})`).join(' · ');
      return `- ${c.category} (${c.totalArticles} arts): ${tops}`;
    })
    .join('\n');

  const fechaActualEs = new Intl.DateTimeFormat('es-ES', {
    dateStyle: 'long',
    timeStyle: 'short'
  }).format(new Date());

  const prompt = `Fecha actual: ${fechaActualEs}.
Analiza este dossier en vivo de ${totalArticles} noticias del lector RSS (${scopeTitle}) y redacta ÍNTEGRAMENTE EN ESPAÑOL un Informe Ejecutivo periodístico claro, denso en datos reales (fechas exactas, cifras en dólares/euros, porcentajes, nombres propios) y directo al grano. Traduce al español cualquier término o cita que esté en inglés.

REGLA ESTRICTA DE FORMATO:
Empieza tu respuesta DIRECTAMENTE con el encabezado "### 🌟 Noticia Estrella del Momento". PROHIBIDO escribir títulos previos como "# BOLETÍN EJECUTIVO", "Fecha: ..." o "Asunto: ...".

ESTRUCTURA OBLIGATORIA EN MARKDOWN (Respeta este orden en cada punto: 1º Título de la noticia en español, 2º Descripción/resumen corto de los hechos en español y 3º al final los medios en los que ha aparecido):
### 🌟 Noticia Estrella del Momento
Pon en primer lugar el titular en negrita (en español) y una descripción clara del suceso integrando fechas, cifras y datos clave, y solo al final indica los medios donde ha aparecido.

### 🔥 Grandes Temas en Tendencia
En cada viñeta coloca SIEMPRE primero el titular en negrita (en español) seguido de una breve descripción del hecho, y deja para el final entre paréntesis los medios en los que ha aparecido.

### 📂 Lo Más Destacado por Áreas Técnicas (IA, Modelos Locales, C++, Ciencia y Tecnología)
Sintetiza las novedades técnicas clave de las carpetas especializadas indicando primero la noticia y su resumen en español, y al final la fuente.

DOSSIER DE CLÚSTERES PRINCIPALES:
${topClustersText}

RADAR POR CARPETAS:
${catsText}`;

  const t0 = performance.now();
  const res = await fetchWithTimeout(
    'http://127.0.0.1:11434/api/chat',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chosenModel,
        stream: false,
        think: false,
        options: {
          temperature: 0.2,
          num_ctx: 8192
        },
        messages: [
          {
            role: 'system',
            content:
              'Eres un analista jefe de inteligencia tecnológica y financiera. Redactas informes en español precisos y directos. Empiezas siempre directamente en "### 🌟 Noticia Estrella del Momento" sin cabeceras de memorando ni campos de Fecha o Asunto.'
          },
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    },
    45000
  );

  if (!res.ok) return null;
  const data = await res.json();
  let content = data?.message?.content || '';
  // Limpiar bloques <think>...</think> y cualquier cabecera de memorando previa al primer ###
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const firstH3 = content.indexOf('### ');
  if (firstH3 > 0) {
    content = content.slice(firstH3).trim();
  }
  content = content.replace(/\[Fecha[^\]]*\]/gi, fechaActualEs);
  if (!content || content.length < 80) return null;

  const elapsedMs = Math.round(performance.now() - t0);
  const evalCount = Number(data?.eval_count) || 0;
  const evalDurationSec = (Number(data?.eval_duration) || 0) / 1e9;
  const tps = evalDurationSec > 0 ? (evalCount / evalDurationSec).toFixed(1) : null;

  return {
    markdown: content,
    model: tps ? `${chosenModel} (${tps} t/s)` : chosenModel,
    elapsedMs
  };
}

const saveBriefingStmt = db.prepare(`
  INSERT OR REPLACE INTO briefing_reports (
    scope, title, total_articles, clusters_json, categories_json,
    ai_markdown, ai_model, ai_status, generation_ms, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

async function generateAndStoreBriefingForScope(scopeKey, { useOllama = true, modelOverride = null, deepRead = true } = {}) {
  const scopeDef = BRIEFING_SCOPES[scopeKey] || BRIEFING_SCOPES.unread;
  const t0 = performance.now();

  if (useOllama && !briefingStatus.ollamaOnline) {
    await detectLocalOllamaModels();
  }

  const rows = queryArticlesForBriefingScope(scopeDef.key);
  const clusters = buildTopicClusters(rows);
  const categoriesBreakdown = buildCategoryBreakdown(rows);

  if (deepRead && clusters.length > 0) {
    await enrichTopClustersWithDeepRead(clusters, 3).catch(() => {});
  }

  const topClustersToSave = clusters.slice(0, 14);
  const hasExisting = db
    .prepare('SELECT 1 FROM briefing_reports WHERE scope = ?')
    .get(scopeDef.key);

  if (!hasExisting) {
    const initialMd = buildStructuredExecutiveMarkdown(
      scopeDef.title,
      rows.length,
      topClustersToSave,
      categoriesBreakdown
    );
    saveBriefingStmt.run(
      scopeDef.key,
      scopeDef.title,
      rows.length,
      JSON.stringify(topClustersToSave),
      JSON.stringify(categoriesBreakdown),
      initialMd,
      'Motor Algorítmico Local + Deep Read',
      'ready',
      Math.round(performance.now() - t0),
      Date.now()
    );
  }

  // Traducir siempre al español todos los titulares y extractos en inglés de los clústeres
  await translateClustersToSpanishWithOllama(
    topClustersToSave,
    categoriesBreakdown,
    modelOverride
  ).catch(() => {});

  const structuredMd = buildStructuredExecutiveMarkdown(
    scopeDef.title,
    rows.length,
    topClustersToSave,
    categoriesBreakdown
  );

  let finalMarkdown = structuredMd;
  let finalModel = 'Motor Algorítmico Local + Deep Read';
  let elapsedMs = Math.round(performance.now() - t0);

  if (!useOllama || rows.length === 0) {
    saveBriefingStmt.run(
      scopeDef.key,
      scopeDef.title,
      rows.length,
      JSON.stringify(topClustersToSave),
      JSON.stringify(categoriesBreakdown),
      finalMarkdown,
      finalModel,
      'ready',
      elapsedMs,
      Date.now()
    );
  }

  if (useOllama && rows.length > 0) {
    try {
      const llmResult = await synthesizeWithLocalOllama(
        scopeDef.title,
        rows.length,
        topClustersToSave,
        categoriesBreakdown,
        modelOverride
      );
      if (llmResult && llmResult.markdown) {
        finalMarkdown = llmResult.markdown;
        finalModel = llmResult.model;
      }
    } catch {}
    elapsedMs = Math.round(performance.now() - t0);
    saveBriefingStmt.run(
      scopeDef.key,
      scopeDef.title,
      rows.length,
      JSON.stringify(topClustersToSave),
      JSON.stringify(categoriesBreakdown),
      finalMarkdown,
      finalModel,
      'ready',
      elapsedMs,
      Date.now()
    );
  }

  return getStoredBriefingReport(scopeDef.key);
}

function getStoredBriefingReport(scopeKey) {
  const row = db.prepare('SELECT * FROM briefing_reports WHERE scope = ?').get(scopeKey);
  if (!row) return null;
  let clusters = [];
  let categories = [];
  try {
    clusters = JSON.parse(row.clusters_json || '[]');
  } catch {}
  try {
    categories = JSON.parse(row.categories_json || '[]');
  } catch {}

  const applyCached = (str) => {
    const clean = String(str || '').trim();
    if (!clean) return clean;
    const tr = getCachedTransStmt.get(clean);
    return tr && tr.es_text ? tr.es_text : clean;
  };

  // Sincronizar en vivo los IDs aún no leídos y aplicar traducciones en caché a cada clúster
  const currentUnreadIdsSet = new Set(
    db.prepare('SELECT id FROM articles').all().map((r) => r.id)
  );
  for (const cl of clusters) {
    cl.title = applyCached(cl.title);
    if (cl.leadExcerpt) {
      cl.leadExcerpt = applyCached(cl.leadExcerpt.slice(0, 260));
    }
    if (cl.deepParagraphs && cl.deepParagraphs[0]) {
      cl.deepParagraphs[0] = applyCached(cl.deepParagraphs[0].slice(0, 280));
    }
    for (const sa of cl.sampleArticles || []) {
      sa.title = applyCached(sa.title);
    }
    cl.shortDescription = buildClusterShortDescription(cl);
    if (Array.isArray(cl.unreadIds)) {
      cl.unreadIds = cl.unreadIds.filter((id) => currentUnreadIdsSet.has(id));
    }
  }
  for (const cat of categories) {
    for (const st of cat.topStories || []) {
      st.title = applyCached(st.title);
    }
  }

  let cleanAiMarkdown = String(row.ai_markdown || '');
  const firstH3 = cleanAiMarkdown.indexOf('### ');
  if (firstH3 > 0) {
    cleanAiMarkdown = cleanAiMarkdown.slice(firstH3).trim();
  }

  return {
    scope: row.scope,
    title: row.title,
    totalArticles: row.total_articles,
    clusters,
    categories,
    aiMarkdown: cleanAiMarkdown,
    aiModel: row.ai_model,
    aiStatus: row.ai_status,
    generationMs: row.generation_ms,
    updatedAt: row.updated_at
  };
}

async function runHourlyBriefingsMonitor({ forceOllama = true } = {}) {
  if (briefingStatus.isGenerating) return;
  briefingStatus.isGenerating = true;
  try {
    seedAndPruneArticlesHistory();
    await detectLocalOllamaModels();
    for (const scopeKey of ['unread', '1h', '12h', '24h']) {
      await generateAndStoreBriefingForScope(scopeKey, {
        useOllama: forceOllama && briefingStatus.ollamaOnline,
        deepRead: scopeKey === 'unread' || scopeKey === '24h'
      });
    }
    briefingStatus.lastHourlyRunAt = Date.now();
  } catch (err) {
    console.error('Error en monitoreo horario de informes:', err);
  } finally {
    briefingStatus.isGenerating = false;
  }
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

async function streamImageUrlToResponse(targetUrl, res) {
  const imgRes = await fetchWithTimeout(
    targetUrl,
    {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: new URL(targetUrl).origin
      }
    },
    6000
  );

  if (!imgRes.ok) {
    throw new Error(`Image HTTP ${imgRes.status}`);
  }

  const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    throw new Error('Not an image content-type');
  }

  const arrayBuf = await imgRes.arrayBuffer();
  if (arrayBuf.byteLength < 600) {
    throw new Error('Image too small (tracking pixel)');
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=86400'
  });
  res.end(Buffer.from(arrayBuf));
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
    const hostHeader = String(req.headers.host || 'localhost');
    const hostnameOnly = hostHeader.split(':')[0].toLowerCase();
    const userAgent = String(req.headers['user-agent'] || '');

    // Redirección automática opcional para marcador compartido en red local hacia loopback seguro (WebGPU)
    const lanBookmarkHost = (process.env.LAN_BOOKMARK_HOST || '192.168.1.225').toLowerCase();
    if (hostnameOnly === lanBookmarkHost) {
      if (/Macintosh|Mac OS X/i.test(userAgent)) {
        res.writeHead(302, { Location: `http://localhost:${PORT}${req.url || '/'}` });
        return res.end();
      }
      if (/Windows/i.test(userAgent)) {
        res.writeHead(302, { Location: `http://127.0.0.1:${PORT}${req.url || '/'}` });
        return res.end();
      }
    }

    const parsedUrl = new URL(req.url, `http://${hostHeader}`);
    const pathname = parsedUrl.pathname;

    // 1. Estado general y artículos
    if (req.method === 'GET' && pathname === '/api/state') {
      const feedId = parsedUrl.searchParams.get('feedId');
      const categoryId = parsedUrl.searchParams.get('categoryId');
      const filter = parsedUrl.searchParams.get('filter') || 'all';
      const search = parsedUrl.searchParams.get('search') || '';
      const limit = Number(parsedUrl.searchParams.get('limit')) || 90;

      // Al abrir o consultar el lector, si hay fuentes sin sincronizar en los últimos 10 minutos,
      // iniciar automáticamente su actualización en segundo plano (estilo Feedly)
      triggerAutoSyncIfNeeded(10);

      const sidebar = getSidebarState();
      const { articles, totalMatching, ageCounts } = queryArticlesWithTotal({
        feedId,
        categoryId,
        filter,
        search,
        limit
      });
      return sendJson(res, 200, {
        sidebar,
        articles,
        totalMatching,
        ageCounts,
        hasMore: totalMatching > articles.length
      });
    }

    // 1b. Paginación / Scroll infinito de artículos sin recargar la vista
    if (req.method === 'GET' && pathname === '/api/articles') {
      const feedId = parsedUrl.searchParams.get('feedId');
      const categoryId = parsedUrl.searchParams.get('categoryId');
      const filter = parsedUrl.searchParams.get('filter') || 'all';
      const search = parsedUrl.searchParams.get('search') || '';
      const limit = Number(parsedUrl.searchParams.get('limit')) || 90;
      const excludeRaw = parsedUrl.searchParams.get('excludeIds') || '';
      const excludeIds = excludeRaw
        ? excludeRaw.split(',').map(Number).filter(Boolean)
        : [];

      const { articles, totalMatching, ageCounts } = queryArticlesWithTotal({
        feedId,
        categoryId,
        filter,
        search,
        excludeIds,
        limit
      });
      return sendJson(res, 200, {
        articles,
        totalMatching,
        ageCounts,
        sidebar: getSidebarState()
      });
    }

    // 2. Endpoint Inteligente de Imagen por Artículo (/api/article-image/:id)
    // Garantiza que cada tarjeta obtenga una foto real y única aunque el RSS original no la incluya
    if (req.method === 'GET' && pathname.startsWith('/api/article-image/')) {
      const articleId = Number(pathname.split('/').pop());
      if (!articleId) {
        res.writeHead(400);
        return res.end();
      }

      let imageUrl = await resolveAndSaveArticleImage(articleId);
      if (imageUrl) {
        try {
          await streamImageUrlToResponse(imageUrl, res);
          return;
        } catch {
          // Si la URL original del medio falló (403/404), buscar fotografía contextual de respaldo
          let row = db
            .prepare(`
              SELECT a.id, a.title, f.title AS feed_title
              FROM articles a
              JOIN feeds f ON f.id = a.feed_id
              WHERE a.id = ?
            `)
            .get(articleId);

          if (!row && recentlyReadById.has(articleId)) {
            row = recentlyReadById.get(articleId);
          }

          if (row) {
            const fallbackUrl = await findContextualNewsImage(row);
            if (fallbackUrl) {
              db.prepare('UPDATE articles SET image_url = ? WHERE id = ?').run(fallbackUrl, articleId);
              try {
                await streamImageUrlToResponse(fallbackUrl, res);
                return;
              } catch {}
            }
          }
        }
      }

      res.writeHead(404);
      return res.end();
    }

    // 3. Sincronizar feeds
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

      syncFeedsBatch(feedsToSync, 8).catch((e) => console.error('Error en batch sync:', e));
      return sendJson(res, 200, { ok: true, started: true, sidebar: getSidebarState() });
    }

    // 4. Añadir nuevo feed tradicional
    if (req.method === 'POST' && pathname === '/api/feeds') {
      const body = await readJsonBody(req);
      const rawUrl = (body.url || '').trim();
      const categoryName = (body.categoryName || '4. Actualidad Tecnológica').trim();
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

    // 5. Añadir Feed de Búsqueda por Palabras Clave
    if (req.method === 'POST' && pathname === '/api/feeds/keyword') {
      const body = await readJsonBody(req);
      const query = (body.query || '').trim();
      const provider = body.provider || 'google_es';
      const subreddit = (body.subreddit || '').trim();
      const sort = body.sort || 'new';
      const categoryName = (body.categoryName || '3. Alertas de Búsqueda').trim();
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

    // 6. Eliminación individual de un feed
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

    // 7. Eliminación en lote de múltiples feeds
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

    // 8. Editar título o carpeta de un feed
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

    // 9. Marcar noticias como leídas -> Eliminación inmediata excepto guardadas
    // Soporta las tres modalidades de Feedly: todas ('all'), >24 horas ('older_24h') y >1 semana ('older_7d')
    if (req.method === 'POST' && pathname === '/api/articles/mark-read') {
      const body = await readJsonBody(req);
      let ids = Array.isArray(body.articleIds) ? body.articleIds : [];

      if (body.markAllInView) {
        const { fromAndWhere, params } = buildArticlesFilterQuery({
          feedId: body.feedId,
          categoryId: body.categoryId,
          filter: body.filter,
          search: body.search
        });

        let ageWhere = '';
        const ageParams = [];
        const ageScope = body.ageScope || 'all';
        if (ageScope === 'older_24h') {
          ageWhere = ' AND a.published_ts < ?';
          ageParams.push(Date.now() - 24 * 3600 * 1000);
        } else if (ageScope === 'older_7d') {
          ageWhere = ' AND a.published_ts < ?';
          ageParams.push(Date.now() - 7 * 24 * 3600 * 1000);
        }

        const allViewRows = db
          .prepare(`SELECT a.id ${fromAndWhere}${ageWhere}`)
          .all(...params, ...ageParams);
        ids = allViewRows.map((r) => r.id);
      }

      const result = markArticlesReadAndDeleteImmediate(ids, { source: body.source || 'manual' });
      return sendJson(res, 200, {
        ok: true,
        ...result,
        sidebar: getSidebarState()
      });
    }

    // 10. Deshacer última eliminación de noticias leídas
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
        'DELETE FROM dismissed_guids WHERE guid = ?'
      );

      for (const item of batch) {
        removeDismissed.run(item.guid);
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

    // 11. Alternar Guardado o añadir/editar Nota (incluso si acababa de marcarse como leída al abrir/hacer scroll)
    if (req.method === 'POST' && pathname.startsWith('/api/articles/') && pathname.endsWith('/save')) {
      const parts = pathname.split('/');
      const articleId = Number(parts[3]);
      const body = await readJsonBody(req);

      let current = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);

      // Si ya se había marcado como leída en la sesión actual, restaurarla automáticamente a articles
      if (!current && recentlyReadById.has(articleId)) {
        const cached = recentlyReadById.get(articleId);
        db.prepare('DELETE FROM dismissed_guids WHERE guid = ?').run(cached.guid);
        db.prepare(`
          INSERT OR IGNORE INTO articles (
            id, feed_id, guid, title, link, pub_date, published_ts,
            author, excerpt, content_html, image_url, is_saved, note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          cached.id,
          cached.feed_id,
          cached.guid,
          cached.title,
          cached.link,
          cached.pub_date,
          cached.published_ts,
          cached.author,
          cached.excerpt,
          cached.content_html,
          cached.image_url,
          1,
          cached.note || '',
          cached.created_at
        );
        db.prepare(`
          INSERT INTO articles_fts (article_id, title, excerpt, feed_title, note)
          VALUES (?, ?, ?, ?, ?)
        `).run(cached.id, cached.title, cached.excerpt, cached.feed_title || '', cached.note || '');
        current = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
      }

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

    // 12. Extraer texto completo de una noticia
    if (req.method === 'GET' && pathname.startsWith('/api/articles/') && pathname.endsWith('/fulltext')) {
      const parts = pathname.split('/');
      const articleId = Number(parts[3]);
      let row = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
      if (!row && recentlyReadById.has(articleId)) {
        row = recentlyReadById.get(articleId);
      }
      if (!row) return sendJson(res, 404, { error: 'Noticia no encontrada' });

      const paragraphs = await extractReadableArticle(row.link);
      return sendJson(res, 200, { ok: true, paragraphs });
    }

    // 12b. Obtener detalle individual de una noticia (desde articles, caché o histórico de 72h)
    if (req.method === 'GET' && /^\/api\/articles\/\d+$/.test(pathname)) {
      const articleId = Number(pathname.split('/').pop());
      let row = db
        .prepare(`
          SELECT a.*, f.title AS feed_title, f.site_url AS feed_site_url, c.name AS category_name
          FROM articles a
          JOIN feeds f ON f.id = a.feed_id
          JOIN categories c ON c.id = f.category_id
          WHERE a.id = ?
        `)
        .get(articleId);

      if (!row && recentlyReadById.has(articleId)) {
        row = recentlyReadById.get(articleId);
      }
      if (!row) {
        row = db
          .prepare('SELECT * FROM articles_history WHERE article_id = ? OR id = ? LIMIT 1')
          .get(articleId, articleId);
      }
      if (!row) return sendJson(res, 404, { error: 'Noticia no encontrada' });
      return sendJson(res, 200, { ok: true, article: row });
    }

    // 12c. Consultar los 4 Informes Pre-elaborados (Actuales, 1h, 12h, 24h)
    if (req.method === 'GET' && pathname === '/api/briefings') {
      await detectLocalOllamaModels();

      const reports = {};
      for (const scopeKey of ['unread', '1h', '12h', '24h']) {
        let rep = getStoredBriefingReport(scopeKey);
        if (!rep) {
          rep = await generateAndStoreBriefingForScope(scopeKey, {
            useOllama: briefingStatus.ollamaOnline,
            deepRead: false
          });
        }
        reports[scopeKey] = rep;
      }

      // Actualizar contador vivo de no leídas sin destruir la síntesis de Gemma 4 ni las traducciones
      if (reports.unread) {
        const currentUnreadCount = db.prepare('SELECT COUNT(*) AS c FROM articles').get()?.c || 0;
        reports.unread.totalArticles = currentUnreadCount;
      }

      return sendJson(res, 200, {
        ok: true,
        reports,
        status: {
          isGenerating: briefingStatus.isGenerating,
          lastHourlyRunAt: briefingStatus.lastHourlyRunAt,
          preferredModel: getPreferredOllamaModel(),
          availableModels: briefingStatus.availableModels,
          ollamaOnline: briefingStatus.ollamaOnline
        }
      });
    }

    // 12d. Regenerar informe con Gemma 4 / Ollama local + Deep Read bajo demanda
    if (req.method === 'POST' && pathname === '/api/briefings/generate') {
      const body = await readJsonBody(req);
      const scope = body.scope || 'unread';
      const modelOverride = body.model ? String(body.model).trim() : null;
      if (modelOverride) {
        setPreferredOllamaModel(modelOverride);
      }

      await detectLocalOllamaModels();

      if (scope === 'all') {
        await runHourlyBriefingsMonitor({ forceOllama: true });
      } else {
        await generateAndStoreBriefingForScope(scope, {
          useOllama: true,
          modelOverride: getPreferredOllamaModel(),
          deepRead: true
        });
      }

      const reports = {};
      for (const sk of ['unread', '1h', '12h', '24h']) {
        reports[sk] = getStoredBriefingReport(sk);
      }

      return sendJson(res, 200, {
        ok: true,
        reports,
        status: {
          isGenerating: briefingStatus.isGenerating,
          lastHourlyRunAt: Date.now(),
          preferredModel: getPreferredOllamaModel(),
          availableModels: briefingStatus.availableModels,
          ollamaOnline: briefingStatus.ollamaOnline
        }
      });
    }

    // 12e. Guardar preferencia de modelo local (ej. gemma4:12b, gemma4:26b)
    if (req.method === 'POST' && pathname === '/api/briefings/settings') {
      const body = await readJsonBody(req);
      if (body.model) {
        setPreferredOllamaModel(body.model);
      }
      await detectLocalOllamaModels();
      return sendJson(res, 200, {
        ok: true,
        preferredModel: getPreferredOllamaModel(),
        availableModels: briefingStatus.availableModels,
        ollamaOnline: briefingStatus.ollamaOnline
      });
    }

    // 13. Importar archivo OPML manual
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

    // 14. Proxy CORS directo de imágenes
    if (req.method === 'GET' && pathname === '/api/image-proxy') {
      const targetUrl = parsedUrl.searchParams.get('url');
      if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
        res.writeHead(400);
        return res.end('URL inválida');
      }

      try {
        await streamImageUrlToResponse(targetUrl, res);
        return;
      } catch {
        res.writeHead(404);
        return res.end();
      }
    }

    // 15. Archivos estáticos
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
  if (!triggerAutoSyncIfNeeded(AUTO_SYNC_INTERVAL_MINUTES)) {
    enrichMissingArticleImages().catch(() => {});
  }
  // Pre-elaborar informes al iniciar y activar monitoreo automático cada 60 minutos
  setTimeout(() => {
    runHourlyBriefingsMonitor({ forceOllama: true }).catch(() => {});
  }, 1500);

  setInterval(() => {
    runHourlyBriefingsMonitor({ forceOllama: true }).catch(() => {});
  }, 60 * 60 * 1000);

  // Demonio de actualización automática cada 15 minutos en segundo plano (estilo Feedly)
  setInterval(() => {
    triggerAutoSyncIfNeeded(AUTO_SYNC_INTERVAL_MINUTES);
  }, 2 * 60 * 1000);
});
