const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../models/db');
const { ensureAuthenticated } = require('../middleware/auth');

// Multer config
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.gif', '.png', '.jpg', '.jpeg', '.webp'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only image files (gif, png, jpg, webp) are allowed'));
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function deleteBanner(filename) {
  if (!filename) return;
  try { fs.unlinkSync(path.join(uploadsDir, path.basename(filename))); } catch (e) {}
}


// Sanitize and enforce server-side character limits on submission fields
function sanitizeFields(body) {
  return {
    name:        String(body.name        || '').trim().substring(0, 80),
    ip:          String(body.ip          || '').trim().substring(0, 255),
    port:        parseInt(body.port) || 25565,
    description: String(body.description || '').substring(0, 2000),
    website_url: String(body.website_url || '').substring(0, 500),
    version:     String(body.version     || '').trim().substring(0, 30),
    tags:        String(body.tags        || '').trim().substring(0, 200),
  };
}

function getGuidelines() {
  try {
    const { marked } = require('marked');
    const row = db.prepare(`SELECT value FROM site_settings WHERE key = 'submission_guidelines'`).get();
    return row && row.value ? marked.parse(row.value) : '';
  } catch (e) { return ''; }
}

function logUserAction(user, action, targetId, targetName, extra) {
  try {
    db.prepare(`
      INSERT INTO admin_logs (admin_discord_id, admin_username, action, target_type, target_id, target_name, extra)
      VALUES (?, ?, ?, 'user_submission', ?, ?, ?)
    `).run(
      user.id,
      (user.username || '').substring(0, 64),
      action,
      targetId || null,
      targetName ? String(targetName).substring(0, 255) : null,
      extra ? String(extra).substring(0, 500) : null
    );
  } catch (e) { /* never crash on logging */ }
}


// ─── Ping rate limit (per server, per IP) ────────────────────────────────────
const pingTracker = new Map(); // key: `${ip}:${serverId}` -> last ping timestamp
const PING_COOLDOWN_MS = 30 * 1000; // 30 seconds per server per IP

function canPing(ip, serverId) {
  const key = ip + ':' + serverId;
  const last = pingTracker.get(key) || 0;
  if (Date.now() - last < PING_COOLDOWN_MS) return false;
  pingTracker.set(key, Date.now());
  // Clean up old entries every 1000 pings
  if (pingTracker.size > 1000) {
    const cutoff = Date.now() - PING_COOLDOWN_MS;
    for (const [k, v] of pingTracker) { if (v < cutoff) pingTracker.delete(k); }
  }
  return true;
}

// ─── Rate limit tracking (in-memory) ─────────────────────────────────────────
const submissionTracker = new Map();
const RATE_WINDOW_MS   = 10 * 60 * 1000;
const RATE_LIMIT_COUNT = 3;

function checkRateLimit(discordId) {
  const now = Date.now();
  const times = (submissionTracker.get(discordId) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (times.length >= RATE_LIMIT_COUNT) {
    const oldest = Math.min(...times);
    const unlocksIn = Math.ceil((RATE_WINDOW_MS - (now - oldest)) / 1000 / 60);
    return { limited: true, unlocksIn };
  }
  times.push(now);
  submissionTracker.set(discordId, times);
  return { limited: false }; 
}

const PAGE_SIZE = 50;
const VALID_SORTS = {
  'top':    `vote_score DESC, created_at DESC`,
  'bottom': `vote_score ASC, created_at DESC`,
  'newest': `created_at DESC`,
  'oldest': `created_at ASC`,
  'online': `online DESC, player_count DESC, created_at DESC`,
};

// ─── Public: Server Listing ───────────────────────────────────────────────────
router.get('/', (req, res) => {
  const q       = req.query.q    || '';
  const tag     = req.query.tag  || '';
  const sortKey = VALID_SORTS[req.query.sort] ? req.query.sort : 'online';
  const page    = Math.max(1, parseInt(req.query.page) || 1);

  let countQuery = `SELECT COUNT(*) as total FROM servers WHERE status = 'approved'`;
  let dataQuery  = `SELECT * FROM servers WHERE status = 'approved'`;
  const params = [];

  if (q) {
    const clause = ` AND (name LIKE ? OR description LIKE ? OR ip LIKE ? OR tags LIKE ?)`;
    countQuery += clause; dataQuery += clause;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (tag) {
    const clause = ` AND tags LIKE ?`;
    countQuery += clause; dataQuery += clause;
    params.push(`%${tag}%`);
  }

  const total       = db.prepare(countQuery).get(...params).total;
  const totalPages  = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);

  dataQuery += ` ORDER BY ${VALID_SORTS[sortKey]} LIMIT ? OFFSET ?`;
  const servers = db.prepare(dataQuery).all(...params, PAGE_SIZE, (currentPage - 1) * PAGE_SIZE);
  servers.forEach(s => { s.tagList = s.tags ? s.tags.split(',').map(t => t.trim()).filter(Boolean) : []; });

  res.render('servers/index', {
    title: q || tag ? `Search: ${q || tag} — Servers` : 'Browse Servers',
    servers, query: q, filterTag: tag, sortKey, currentPage, totalPages, total,
    canonicalPath: '/servers',
    metaDescription: q || tag
      ? `${total} non-pay-to-win Minecraft servers matching "${q || tag}". Browse fair Minecraft servers on AntiP2W.`
      : `Browse ${total} non-pay-to-win Minecraft servers. Search by name, tag, or version. All servers are manually reviewed.`,
    noindex: !!(q || tag || currentPage > 1),
  });
});

// ─── Public: Random Server ────────────────────────────────────────────────────
router.get('/random', (req, res) => {
  const server = db.prepare(`SELECT id FROM servers WHERE status = 'approved' ORDER BY RANDOM() LIMIT 1`).get();
  if (!server) return res.redirect('/servers');
  res.redirect(`/servers/${server.id}`);
});

// ─── Auth: Submit form ────────────────────────────────────────────────────────
router.get('/submit/new', ensureAuthenticated, (req, res) => {
  res.render('servers/submit', { title: 'Submit a Server', errors: [], guidelinesHtml: getGuidelines(), request: null, isUpdate: false });
});

router.post('/submit/new', ensureAuthenticated, upload.single('banner'), (req, res) => {
  const { name, ip, port, description, website_url, version, tags } = sanitizeFields(req.body);
  const remove_banner = req.body.remove_banner;
  const errors = [];

  function rerender(errors) {
    if (req.file) deleteBanner(req.file.filename);
    return res.render('servers/submit', { title: 'Submit a Server', errors, guidelinesHtml: getGuidelines(), request: null, isUpdate: false });
  }

  if (!name || name.trim().length < 2) errors.push('Server name is required (min 2 chars)');
  if (!ip || ip.trim().length < 3) errors.push('Server IP/hostname is required');
  if (description && description.length > 2000) errors.push('Description too long (max 2000 chars)');

  if (!errors.length) {
    const trimmedIp   = ip.trim().toLowerCase();
    const trimmedName = name.trim().toLowerCase();

    // Blacklist check
    const blacklisted = db.prepare(`SELECT * FROM ip_blacklist WHERE ip = ?`).get(trimmedIp);
    if (blacklisted) {
      const rejectNote = blacklisted.reason
        ? `Auto-rejected: this IP was previously rejected (${blacklisted.reason})`
        : `Auto-rejected: this IP is blacklisted.`;
      db.prepare(`
        INSERT INTO server_requests (name, ip, port, description, website_url, banner_filename, version, tags, submitted_by_discord_id, submitted_by_username, status, review_note, reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rejected', ?, CURRENT_TIMESTAMP)
      `).run((name||'').trim(), trimmedIp, parseInt(port)||25565, description||'', website_url||'',
             req.file ? req.file.filename : null, version||'', tags||'', req.user.id, req.user.username, rejectNote);
      db.prepare(`INSERT INTO admin_logs (admin_discord_id, admin_username, action, target_type, target_name, reason, extra) VALUES ('system','system','auto_reject_blacklisted','server_request',?,?,?)`)
        .run(trimmedIp, blacklisted.reason||null, `Submitted by ${req.user.username} (${req.user.id})`);
      db.prepare(`INSERT INTO user_notifications (discord_id, message) VALUES (?, ?)`).run(req.user.id,
        blacklisted.reason ? `❌ Your server submission was automatically rejected. This IP was previously rejected: ${blacklisted.reason}`
                           : `❌ Your server submission was automatically rejected. This IP address is blacklisted.`);
      if (req.file) deleteBanner(req.file.filename);
      return res.redirect('/servers/submitted');
    }

    // Duplicate check
    const duplicate =
      db.prepare(`SELECT id FROM server_requests WHERE (lower(ip)=? OR lower(name)=?) AND status != 'rejected' AND update_of_server_id IS NULL LIMIT 1`).get(trimmedIp, trimmedName) ||
      db.prepare(`SELECT id FROM servers WHERE (lower(ip)=? OR lower(name)=?) AND status='approved' LIMIT 1`).get(trimmedIp, trimmedName);
    if (duplicate) errors.push('A server with the same IP or name has already been submitted.');
  }

  if (errors.length) return rerender(errors);

  const rl = checkRateLimit(req.user.id);
  if (rl.limited) return rerender([`You've submitted too many servers recently. Please wait ~${rl.unlocksIn} minute(s) before submitting again.`]);

  const insertResult = db.prepare(`
    INSERT INTO server_requests (name, ip, port, description, website_url, banner_filename, version, tags, submitted_by_discord_id, submitted_by_username)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name.trim(), ip.trim(), parseInt(port)||25565, description||'', website_url||'',
         req.file ? req.file.filename : null, version||'', tags||'', req.user.id, req.user.username);

  logUserAction(req.user, 'user_submit', insertResult.lastInsertRowid, name.trim(), ip.trim());
  res.redirect('/servers/submitted');
});

// ─── Auth: Submitted confirmation ────────────────────────────────────────────
router.get('/submitted', ensureAuthenticated, (req, res) => {
  res.render('servers/submitted', { title: 'Server Submitted!' });
});

// ─── Auth: My Requests ────────────────────────────────────────────────────────
router.get('/requests/mine', ensureAuthenticated, (req, res) => {
  const rawRequests = db.prepare(`SELECT * FROM server_requests WHERE submitted_by_discord_id = ? ORDER BY created_at DESC`).all(req.user.id);

  // Build a map of live servers by ip|name to detect deleted ones
  const liveByIpName = new Map();
  db.prepare(`SELECT id, ip, name FROM servers WHERE submitted_by_discord_id = ? AND status = 'approved'`).all(req.user.id)
    .forEach(s => liveByIpName.set(s.ip.toLowerCase() + '|' + s.name.toLowerCase(), s.id));

  const requests = rawRequests.map(r => {
    if (r.status === 'approved' && !r.update_of_server_id) {
      const key = (r.ip || '').toLowerCase() + '|' + (r.name || '').toLowerCase();
      const stillLive = liveByIpName.has(key);
      return Object.assign({}, r, { displayStatus: stillLive ? 'approved' : 'deleted' });
    }
    return Object.assign({}, r, { displayStatus: r.status });
  });

  const myServers = db.prepare(`SELECT * FROM servers WHERE submitted_by_discord_id = ? AND status = 'approved' ORDER BY created_at DESC`).all(req.user.id);
  const pendingUpdates = db.prepare(`SELECT update_of_server_id FROM server_requests WHERE submitted_by_discord_id = ? AND status = 'pending' AND update_of_server_id IS NOT NULL`).all(req.user.id);
  const pendingUpdateIds = new Set(pendingUpdates.map(r => r.update_of_server_id));

  const notifications = db.prepare(`SELECT * FROM user_notifications WHERE discord_id = ? ORDER BY created_at DESC LIMIT 20`).all(req.user.id);
  db.prepare(`UPDATE user_notifications SET read = 1 WHERE discord_id = ? AND read = 0`).run(req.user.id);
  res.render('servers/my-requests', { title: 'My Submissions', requests, myServers, pendingUpdateIds, notifications });
});

// ─── Auth: Dismiss all notifications (must be before :id route) ──────────────
router.post('/notifications/dismiss-all', ensureAuthenticated, (req, res) => {
  db.prepare(`DELETE FROM user_notifications WHERE discord_id = ?`).run(req.user.id);
  res.redirect('/servers/requests/mine');
});

// ─── Auth: Dismiss a single notification ─────────────────────────────────────
router.post('/notifications/:id/dismiss', ensureAuthenticated, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.redirect('/servers/requests/mine');
  db.prepare(`DELETE FROM user_notifications WHERE id = ? AND discord_id = ?`).run(id, req.user.id);
  res.redirect('/servers/requests/mine');
});


router.get('/requests/:id/edit', ensureAuthenticated, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.redirect('/servers/requests/mine');
  const request = db.prepare(`SELECT * FROM server_requests WHERE id = ? AND submitted_by_discord_id = ? AND status = 'pending'`).get(id, req.user.id);
  if (!request) return res.status(403).render('error', { title: 'Not Found', message: 'Request not found or cannot be edited.', code: 403 });
  res.render('servers/edit-request', { title: 'Edit Submission', request, errors: [], guidelinesHtml: getGuidelines() });
});

router.post('/requests/:id/edit', ensureAuthenticated, upload.single('banner'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.redirect('/servers/requests/mine');
  const request = db.prepare(`SELECT * FROM server_requests WHERE id = ? AND submitted_by_discord_id = ? AND status = 'pending'`).get(id, req.user.id);
  if (!request) return res.status(403).render('error', { title: 'Not Found', message: 'Request not found or cannot be edited.', code: 403 });

  const { name, ip, port, description, website_url, version, tags } = sanitizeFields(req.body);
  const remove_banner = req.body.remove_banner;
  const errors = [];

  function rerender(errors) {
    if (req.file) deleteBanner(req.file.filename);
    return res.render('servers/edit-request', { title: 'Edit Submission', request, errors, guidelinesHtml: getGuidelines() });
  }

  if (!name || name.trim().length < 2) errors.push('Server name is required (min 2 chars)');
  if (!ip || ip.trim().length < 3) errors.push('Server IP/hostname is required');
  if (description && description.length > 2000) errors.push('Description too long (max 2000 chars)');
  if (errors.length) return rerender(errors);

  // Handle banner update
  let bannerFilename = request.banner_filename;
  if (remove_banner === '1') {
    deleteBanner(bannerFilename);
    bannerFilename = null;
  }
  if (req.file) {
    deleteBanner(bannerFilename);
    bannerFilename = req.file.filename;
  }

  db.prepare(`
    UPDATE server_requests SET name=?, ip=?, port=?, description=?, website_url=?, banner_filename=?, version=?, tags=? WHERE id=?
  `).run(name.trim(), ip.trim(), parseInt(port)||25565, description||'', website_url||'', bannerFilename, version||'', tags||'', id);

  logUserAction(req.user, 'user_edit_submission', id, name.trim(), ip.trim());
  res.redirect('/servers/requests/mine');
});

// ─── Auth: Delete pending request ─────────────────────────────────────────────
router.post('/requests/:id/delete', ensureAuthenticated, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.redirect('/servers/requests/mine');
  const request = db.prepare(`SELECT * FROM server_requests WHERE id = ? AND submitted_by_discord_id = ?`).get(id, req.user.id);
  if (!request) return res.status(403).render('error', { title: 'Not Found', message: 'Request not found.', code: 403 });

  // Only allow deleting pending requests (not already-approved ones that became live servers)
  if (request.status !== 'pending') return res.redirect('/servers/requests/mine');

  deleteBanner(request.banner_filename);
  db.prepare(`DELETE FROM server_requests WHERE id = ?`).run(id);
  logUserAction(req.user, 'user_cancel_submission', id, request.name, request.ip);
  res.redirect('/servers/requests/mine');
});

// ─── Auth: Delete own live server ─────────────────────────────────────────────
router.post('/my-servers/:id/delete', ensureAuthenticated, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.redirect('/servers/requests/mine');
  const server = db.prepare(`SELECT * FROM servers WHERE id = ? AND submitted_by_discord_id = ? AND status = 'approved'`).get(id, req.user.id);
  if (!server) return res.status(403).render('error', { title: 'Not Found', message: 'Server not found.', code: 403 });

  deleteBanner(server.banner_filename);
  // Also cancel any pending update requests for this server
  const pendingUpdates = db.prepare(`SELECT * FROM server_requests WHERE update_of_server_id = ? AND status = 'pending'`).all(id);
  pendingUpdates.forEach(u => deleteBanner(u.banner_filename));
  db.prepare(`DELETE FROM server_requests WHERE update_of_server_id = ? AND status = 'pending'`).run(id);
  db.prepare(`DELETE FROM server_votes WHERE server_id = ?`).run(id);
  db.prepare(`DELETE FROM servers WHERE id = ?`).run(id);
  logUserAction(req.user, 'user_delete_server', id, server.name, server.ip);
  res.redirect('/servers/requests/mine');
});

// ─── Auth: Submit update for approved server ──────────────────────────────────
router.get('/my-servers/:id/update', ensureAuthenticated, (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.redirect('/servers/requests/mine');
  const server = db.prepare(`SELECT * FROM servers WHERE id = ? AND submitted_by_discord_id = ? AND status = 'approved'`).get(id, req.user.id);
  if (!server) return res.status(403).render('error', { title: 'Not Found', message: 'Server not found.', code: 403 });

  // Check if there's already a pending update
  const existingUpdate = db.prepare(`SELECT id FROM server_requests WHERE update_of_server_id = ? AND status = 'pending'`).get(id);
  if (existingUpdate) return res.redirect('/servers/requests/mine?error=update_pending');

  res.render('servers/submit', { title: `Update: ${server.name}`, errors: [], guidelinesHtml: getGuidelines(), request: server, isUpdate: true });
});

router.post('/my-servers/:id/update', ensureAuthenticated, upload.single('banner'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.redirect('/servers/requests/mine');
  const server = db.prepare(`SELECT * FROM servers WHERE id = ? AND submitted_by_discord_id = ? AND status = 'approved'`).get(id, req.user.id);
  if (!server) return res.status(403).render('error', { title: 'Not Found', message: 'Server not found.', code: 403 });

  // Check again for existing pending update
  const existingUpdate = db.prepare(`SELECT id FROM server_requests WHERE update_of_server_id = ? AND status = 'pending'`).get(id);
  if (existingUpdate) {
    if (req.file) deleteBanner(req.file.filename);
    return res.redirect('/servers/requests/mine?error=update_pending');
  }

  const { name, ip, port, description, website_url, version, tags } = sanitizeFields(req.body);
  const remove_banner = req.body.remove_banner;
  const errors = [];

  function rerender(errors) {
    if (req.file) deleteBanner(req.file.filename);
    return res.render('servers/submit', { title: `Update: ${server.name}`, errors, guidelinesHtml: getGuidelines(), request: server, isUpdate: true });
  }

  if (!name || name.trim().length < 2) errors.push('Server name is required (min 2 chars)');
  if (!ip || ip.trim().length < 3) errors.push('Server IP/hostname is required');
  if (description && description.length > 2000) errors.push('Description too long (max 2000 chars)');
  if (errors.length) return rerender(errors);

  // Handle banner: carry over existing server banner if not changed
  let bannerFilename = server.banner_filename;
  if (remove_banner === '1') bannerFilename = null;
  if (req.file) bannerFilename = req.file.filename;

  const updateResult = db.prepare(`
    INSERT INTO server_requests (name, ip, port, description, website_url, banner_filename, version, tags, submitted_by_discord_id, submitted_by_username, update_of_server_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name.trim(), ip.trim(), parseInt(port)||25565, description||'', website_url||'',
         bannerFilename, version||'', tags||'', req.user.id, req.user.username, id);

  logUserAction(req.user, 'user_submit_update', updateResult.lastInsertRowid, name.trim(), `update of server #${id} (${server.ip})`);
  res.redirect('/servers/submitted');
});

// ─── Auth: Vote on a server ───────────────────────────────────────────────────
router.post('/:id/vote', ensureAuthenticated, (req, res) => {
  const id   = parseInt(req.params.id);
  const vote = parseInt(req.body.vote);
  if (!id || (vote !== 1 && vote !== -1)) return res.status(400).json({ error: 'Invalid request' });

  const server = db.prepare(`SELECT id FROM servers WHERE id = ? AND status = 'approved'`).get(id);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const existing = db.prepare(`SELECT * FROM server_votes WHERE server_id = ? AND user_discord_id = ?`).get(id, req.user.id);
  if (existing) {
    if (existing.vote === vote) {
      db.prepare(`DELETE FROM server_votes WHERE server_id = ? AND user_discord_id = ?`).run(id, req.user.id);
    } else {
      db.prepare(`UPDATE server_votes SET vote = ? WHERE server_id = ? AND user_discord_id = ?`).run(vote, id, req.user.id);
    }
  } else {
    db.prepare(`INSERT INTO server_votes (server_id, user_discord_id, vote) VALUES (?, ?, ?)`).run(id, req.user.id, vote);
  }

  const result = db.prepare(`SELECT COALESCE(SUM(vote), 0) as score FROM server_votes WHERE server_id = ?`).get(id);
  db.prepare(`UPDATE servers SET vote_score = ? WHERE id = ?`).run(result.score, id);
  const newVote = db.prepare(`SELECT vote FROM server_votes WHERE server_id = ? AND user_discord_id = ?`).get(id, req.user.id);
  return res.json({ score: result.score, userVote: newVote ? newVote.vote : 0 });
});

// ─── Auth: Ping a server (rate-limited, auth required) ───────────────────────
router.get('/:id/ping', ensureAuthenticated, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid id' });

  const server = db.prepare(`SELECT id, ip, port FROM servers WHERE id = ? AND status = 'approved'`).get(id);
  if (!server) return res.status(404).json({ error: 'not found' });

  // Rate limit: one ping per server per user every 30 seconds
  if (!canPing(req.user.id, id)) {
    return res.status(429).json({ error: 'Please wait before pinging again.', cached: true });
  }

  const { pingServer } = require('../models/pinger');
  const result = await pingServer(server.ip, server.port || 25565, 4000);
  const updateStmt = db.prepare(`UPDATE servers SET online=?, player_count=?, max_player_count=CASE WHEN ? > 0 THEN ? ELSE max_player_count END, last_checked=CURRENT_TIMESTAMP WHERE id=?`);
  if (result) {
    updateStmt.run(1, result.players, result.maxPlayers, result.maxPlayers, server.id);
    res.json({ online: true, players: result.players, maxPlayers: result.maxPlayers });
  } else {
    updateStmt.run(0, 0, 0, 0, server.id);
    res.json({ online: false, players: 0 });
  }
});

// ─── Public: View Single Server ───────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(404).render('error', { title: '404', message: 'Server not found', code: 404 });
  const server = db.prepare(`SELECT * FROM servers WHERE id = ? AND status = 'approved'`).get(id);
  if (!server) return res.status(404).render('error', { title: '404', message: 'Server not found', code: 404 });
  server.tagList = server.tags ? server.tags.split(',').map(t => t.trim()).filter(Boolean) : [];

  const voteData = db.prepare(`SELECT COALESCE(SUM(vote),0) as score, SUM(CASE WHEN vote=1 THEN 1 ELSE 0 END) as ups, SUM(CASE WHEN vote=-1 THEN 1 ELSE 0 END) as downs FROM server_votes WHERE server_id=?`).get(id);
  let userVote = 0;
  if (req.user) {
    const uv = db.prepare(`SELECT vote FROM server_votes WHERE server_id=? AND user_discord_id=?`).get(id, req.user.id);
    userVote = uv ? uv.vote : 0;
  }

  const BASE_URL = process.env.BASE_URL || 'https://antip2w.duckdns.org';
  const serverDesc = server.description
    ? server.description.substring(0, 160).replace(/\n/g, ' ')
    : `${server.name} is a non-pay-to-win Minecraft server. IP: ${server.ip}${server.port !== 25565 ? ':' + server.port : ''}.`;
  const ogImage = server.banner_filename
    ? `${BASE_URL}/uploads/${server.banner_filename}`
    : `${BASE_URL}/img/Logo.png`;
  const tags = server.tagList.join(', ');

  const schemaJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'VideoGame',
    name: server.name,
    description: serverDesc,
    url: `${BASE_URL}/servers/${server.id}`,
    image: ogImage,
    ...(server.version ? { softwareVersion: server.version } : {}),
    genre: tags || 'Minecraft Server',
    gamePlatform: 'Minecraft',
  });

  res.render('servers/show', {
    title: server.name,
    server, voteData, userVote,
    canonicalPath: `/servers/${server.id}`,
    metaDescription: serverDesc,
    metaKeywords: `${server.name} minecraft, ${tags}, non p2w minecraft server, ${server.ip}`,
    ogTitle: `${server.name} — Non-P2W Minecraft Server`,
    ogImage,
    ogType: 'article',
    schemaJson,
  });
});


// ─── Auth: Delete account data ────────────────────────────────────────────────
router.post('/account/delete', ensureAuthenticated, (req, res) => {
  const userId = req.user.id;

  // Anonymise server_requests (keep for admin history but remove personal identifiers)
  db.prepare(`UPDATE server_requests SET submitted_by_discord_id='deleted', submitted_by_username='[deleted]' WHERE submitted_by_discord_id=?`).run(userId);

  // Anonymise approved servers — keep listing live but mark as deleted account
  db.prepare(`UPDATE servers SET submitted_by_discord_id='deleted', submitted_by_username='[deleted]' WHERE submitted_by_discord_id=?`).run(userId);

  // Delete votes
  db.prepare(`DELETE FROM server_votes WHERE user_discord_id=?`).run(userId);

  // Recalculate vote scores for affected servers (run after deleting votes)
  const affected = db.prepare(`SELECT DISTINCT server_id FROM server_votes WHERE user_discord_id=?`).all(userId);
  // Note: votes already deleted above, so recalculate from remaining
  db.prepare(`UPDATE servers SET vote_score=(SELECT COALESCE(SUM(vote),0) FROM server_votes WHERE server_id=servers.id)`).run();

  // Delete notifications
  db.prepare(`DELETE FROM user_notifications WHERE discord_id=?`).run(userId);

  // Delete from analytics (privacy)
  db.prepare(`DELETE FROM analytics WHERE discord_id=?`).run(userId);

  // Log the deletion (no personal info stored)
  db.prepare(`INSERT INTO admin_logs (admin_discord_id, admin_username, action, target_type, extra) VALUES ('system','system','user_account_deletion','user',?)`).run('Account deleted by user');

  // Log out
  req.logout((err) => {
    if (err) console.error('[account delete logout]', err);
    res.redirect('/?success=account_deleted');
  });
});

module.exports = router;
