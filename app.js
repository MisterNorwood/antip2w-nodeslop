require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const ConnectSQLite = require('connect-sqlite3')(session);
const fs = require('fs');
const multer = require('multer');

const { attachUser } = require('./middleware/auth');

// Ensure data dir
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const app = express();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, 'public/uploads'));
  },
  filename: function (req, file, cb) {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) return cb(new Error('Invalid file type'));
    cb(null, true);
  }
});

// ─── Security Headers ─────────────────────────────────────────────────────────
const crypto = require('crypto');
app.disable('x-powered-by');

app.use((req, res, next) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;

  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  res.setHeader('Server', '');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net`,
    `style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com`,
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' https://cdn.discordapp.com data:",
    "connect-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  if (!req.path.match(/\.(css|js|png|jpg|jpeg|gif|webp|ico|woff2?)$/)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  next();
});

// ─── View Engine ──────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ─── Static Files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// trust proxy before session so req.secure is correct at session init time
app.set('trust proxy', 1);

// ─── Session ──────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret-please-change',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  store: new ConnectSQLite({ db: 'sessions.db', dir: dataDir }),
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // set to true in production behind HTTPS via env or reverse proxy config
  }
}));

// ─── Passport ─────────────────────────────────────────────────────────────────
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_CALLBACK_URL,
  scope: ['identify'],
  state: true,
}, (accessToken, refreshToken, profile, done) => {
  return done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(passport.initialize());
app.use(passport.session());

// ─── CSRF Protection ──────────────────────────────────────────────────────────
const csrf = require('csurf');

// Read token exclusively from X-CSRF-Token header — set by main.js fetch interceptor.
// Custom headers require CORS preflight, which browsers block cross-origin,
// making the header the unforgeable proof of same-origin.
const csrfProtection = csrf({
  cookie: false,
  value: (req) => req.headers['x-csrf-token'] || '',
});

app.use((req, res, next) => {
  const skipPaths = ['/auth/discord', '/auth/discord/callback'];
  if (skipPaths.some(p => req.path.startsWith(p))) return next();
  return csrfProtection(req, res, next);
});

app.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken ? req.csrfToken() : '';
  next();
});

// ─── Global Locals ────────────────────────────────────────────────────────────
app.use(attachUser);
app.use((req, res, next) => {
  res.locals.successMsg = req.query.success || null;
  res.locals.errorMsg = req.query.error || null;
  res.locals.noindex = req.path.startsWith('/admin') || req.path.startsWith('/auth') ||
    req.path.startsWith('/servers/requests') || req.path.startsWith('/servers/submit') ||
    req.path.startsWith('/servers/my-servers');
  if (req.user) {
    const db = require('./models/db');
    const row = db.prepare(`SELECT COUNT(*) as c FROM user_notifications WHERE discord_id = ? AND read = 0`).get(req.user.id);
    res.locals.unreadNotifs = row ? row.c : 0;
  } else {
    res.locals.unreadNotifs = 0;
  }
  next();
});

// ─── Analytics Middleware ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.match(/\.(css|js|png|jpg|jpeg|gif|webp|ico|woff2?|txt|xml)$/)) return next();
  if (req.path.startsWith('/admin')) return next();
  if (req.path.startsWith('/auth')) return next();

  try {
    const db = require('./models/db');
    const ipRaw = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
    const ipHash = crypto.createHash('sha256').update(ipRaw + process.env.SESSION_SECRET).digest('hex').slice(0, 16);
    const discordId = req.user ? req.user.id : null;
    db.prepare(`INSERT INTO analytics (event, path, discord_id, ip_hash) VALUES (?, ?, ?, ?)`)
      .run('pageview', req.path, discordId, ipHash);
  } catch(e) {}
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/auth', require('./routes/auth'));
app.use('/servers', require('./routes/servers'));
app.use('/admin', require('./routes/admin'));

// Home page
app.get('/', (req, res) => {
  const db = require('./models/db');
  const servers = db.prepare(`SELECT * FROM servers WHERE status = 'approved' ORDER BY online DESC, player_count DESC, created_at DESC LIMIT 6`).all();
  servers.forEach(s => {
    s.tagList = s.tags ? s.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  });
  const totalServers = db.prepare(`SELECT COUNT(*) as c FROM servers WHERE status = 'approved'`).get().c;
  const BASE_URL = process.env.BASE_URL || 'https://antip2w.duckdns.org';
  res.render('home', {
    title: 'Minecraft Server List',
    servers,
    totalServers,
    canonicalPath: '/',
    metaDescription: `Discover ${totalServers} non-pay-to-win Minecraft servers. AntiP2W is a community-curated directory of fair Minecraft servers where gameplay comes first — no loot boxes, no pay-to-win ranks.`,
    metaKeywords: 'minecraft server list, non p2w minecraft, anti pay to win minecraft, fair minecraft servers, free to play minecraft',
    ogTitle: `AntiP2W — ${totalServers} Non-Pay-to-Win Minecraft Servers`,
    ogImage: `${BASE_URL}/img/Logo.png`,
    schemaJson: JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'AntiP2W',
      url: BASE_URL,
      description: 'Community-curated directory of non-pay-to-win Minecraft servers',
      potentialAction: {
        '@type': 'SearchAction',
        target: { '@type': 'EntryPoint', urlTemplate: `${BASE_URL}/servers?q={search_term_string}` },
        'query-input': 'required name=search_term_string'
      }
    })
  });
});

app.get('/privacy', (req, res) => {
  res.render('privacy', { title: 'Privacy Policy', canonicalPath: '/privacy', metaDescription: 'AntiP2W Privacy Policy — what data we collect and how to delete your account.' });
});

app.get('/tos', (req, res) => {
  res.render('tos', { title: 'Terms of Service', canonicalPath: '/tos', metaDescription: 'AntiP2W Terms of Service — rules for submitting and using the directory.' });
});

app.get('/leaderboard', (req, res) => {
  const db = require('./models/db');
  const topSubmitters = db.prepare(`SELECT submitted_by_discord_id, submitted_by_username, COUNT(*) as server_count FROM servers WHERE status='approved' AND submitted_by_discord_id != 'deleted' AND submitted_by_discord_id IS NOT NULL GROUP BY submitted_by_discord_id ORDER BY server_count DESC LIMIT 10`).all();
  const topRated = db.prepare(`SELECT submitted_by_discord_id, submitted_by_username, SUM(vote_score) as total_score, COUNT(*) as server_count FROM servers WHERE status='approved' AND submitted_by_discord_id != 'deleted' AND submitted_by_discord_id IS NOT NULL GROUP BY submitted_by_discord_id HAVING total_score > 0 ORDER BY total_score DESC LIMIT 10`).all();
  res.render('leaderboard', { title: 'Leaderboard', topSubmitters, topRated, canonicalPath: '/leaderboard', metaDescription: 'AntiP2W leaderboard — top contributors by approved servers and community rating.' });
});

app.get('/robots.txt', (req, res) => {
  const BASE_URL = process.env.BASE_URL || 'https://antip2w.duckdns.org';
  res.type('text/plain').send(['User-agent: *','Allow: /','Allow: /servers','Allow: /servers/*','Disallow: /admin','Disallow: /auth','Disallow: /servers/submit','Disallow: /servers/requests','Disallow: /servers/my-servers','',`Sitemap: ${BASE_URL}/sitemap.xml`].join('\n'));
});

app.get('/sitemap.xml', (req, res) => {
  const BASE_URL = process.env.BASE_URL || 'https://antip2w.duckdns.org';
  const db = require('./models/db');
  const servers = db.prepare(`SELECT id, updated_at FROM servers WHERE status='approved' ORDER BY id`).all();
  const today = new Date().toISOString().split('T')[0];
  const urls = [
    { loc: `${BASE_URL}/`, changefreq: 'daily', priority: '1.0', lastmod: today },
    { loc: `${BASE_URL}/servers`, changefreq: 'hourly', priority: '0.9', lastmod: today },
    ...servers.map(s => ({ loc: `${BASE_URL}/servers/${s.id}`, changefreq: 'weekly', priority: '0.7', lastmod: (s.updated_at || today).split('T')[0] }))
  ];
  res.type('application/xml').send(['<?xml version="1.0" encoding="UTF-8"?>','<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',...urls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`),'</urlset>'].join('\n'));
});

app.get('/llms.txt', (req, res) => {
  const BASE_URL = process.env.BASE_URL || 'https://antip2w.duckdns.org';
  const db = require('./models/db');
  const servers = db.prepare(`SELECT id, name, ip, port, description, tags, version FROM servers WHERE status='approved' ORDER BY vote_score DESC, player_count DESC`).all();
  const serverList = servers.map(s => {
    const ip = s.ip + (s.port && s.port !== 25565 ? ':' + s.port : '');
    const desc = s.description ? ' — ' + s.description.substring(0, 100).replace(/\n/g, ' ') : '';
    return `- [${s.name}](${BASE_URL}/servers/${s.id}): ${ip}${desc}${s.tags ? ' [' + s.tags + ']' : ''}`;
  }).join('\n');
  res.type('text/plain').send(`# AntiP2W — Non-Pay-to-Win Minecraft Server Directory\n\n> A community-run directory of Minecraft servers that do not use pay-to-win mechanics.\n> All servers are manually reviewed by admins before listing.\n\n## Key Pages\n\n- [Home](${BASE_URL}/)\n- [Browse Servers](${BASE_URL}/servers)\n\n## Listed Servers\n\n${serverList}\n\n## Contact\nDiscord: https://dsc.gg/ap2w`);
});

// ─── CSRF Error Handler ───────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).render('error', { title: 'Invalid Form Submission', message: 'Your form session expired or the request was invalid. Please go back and try again.', code: 403 });
  }
  next(err);
});

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', req.method, req.path, err.message);
  res.status(500).render('error', { title: 'Server Error', message: 'Something went wrong. Please try again.', code: 500 });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('error', { title: '404 Not Found', message: 'The page you are looking for does not exist.', code: 404 });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🟢 MCServers running at http://localhost:${PORT}`);
  const db = require('./models/db');
  const { pollAllServers } = require('./models/pinger');
  const runPoll = () => pollAllServers(db).catch(e => console.error('[pinger] error:', e));
  runPoll();
  setInterval(runPoll, 2 * 60 * 1000);
});