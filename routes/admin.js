const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../models/db');
const { ensureAdmin } = require('../middleware/auth');

// Multer for admin edits
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
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
    else cb(new Error('Invalid file type'));
  }
});

// Apply admin check to all routes
router.use(ensureAdmin);

// ─── Helper: write an admin log entry ────────────────────────────────────────
function logAction(req, action, targetType, targetId, targetName, reason = null, extra = null) {
  db.prepare(`
    INSERT INTO admin_logs (admin_discord_id, admin_username, action, target_type, target_id, target_name, reason, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id,
    (req.user.username || '').substring(0, 64),
    action,
    targetType,
    targetId || null,
    targetName ? String(targetName).substring(0, 255) : null,
    reason    ? String(reason).substring(0, 500)     : null,
    extra     ? String(extra).substring(0, 500)      : null
  );
}

// ─── Analytics Dashboard ──────────────────────────────────────────────────────
router.get('/analytics', (req, res) => {
  // Pageviews per day for last 30 days
  const dailyViews = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as views, COUNT(DISTINCT ip_hash) as unique_visitors
    FROM analytics WHERE event='pageview' AND created_at >= datetime('now', '-30 days')
    GROUP BY date(created_at) ORDER BY day ASC
  `).all();

  // Logins per day for last 30 days
  const dailyLogins = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as logins, COUNT(DISTINCT discord_id) as unique_users
    FROM analytics WHERE event='login' AND created_at >= datetime('now', '-30 days')
    GROUP BY date(created_at) ORDER BY day ASC
  `).all();

  // Top pages
  const topPages = db.prepare(`
    SELECT path, COUNT(*) as views FROM analytics
    WHERE event='pageview' AND created_at >= datetime('now', '-30 days')
    GROUP BY path ORDER BY views DESC LIMIT 15
  `).all();

  // Totals
  const totals = db.prepare(`
    SELECT
      COUNT(CASE WHEN event='pageview' THEN 1 END) as total_views,
      COUNT(DISTINCT CASE WHEN event='pageview' THEN ip_hash END) as unique_visitors,
      COUNT(CASE WHEN event='login' THEN 1 END) as total_logins,
      COUNT(DISTINCT CASE WHEN event='login' THEN discord_id END) as unique_users
    FROM analytics WHERE created_at >= datetime('now', '-30 days')
  `).get();

  // Today
  const today = db.prepare(`
    SELECT
      COUNT(CASE WHEN event='pageview' THEN 1 END) as views,
      COUNT(DISTINCT CASE WHEN event='pageview' THEN ip_hash END) as unique_visitors,
      COUNT(CASE WHEN event='login' THEN 1 END) as logins
    FROM analytics WHERE date(created_at) = date('now')
  `).get();

  res.render('admin/analytics', { title: 'Analytics', dailyViews, dailyLogins, topPages, totals, today });
});

// ─── Dashboard ────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const pendingCount = db.prepare(`SELECT COUNT(*) as c FROM server_requests WHERE status = 'pending'`).get().c;
  const serverCount  = db.prepare(`SELECT COUNT(*) as c FROM servers WHERE status = 'approved'`).get().c;
  const adminCount   = db.prepare(`SELECT COUNT(*) as c FROM admins`).get().c;
  const recentRequests = db.prepare(`SELECT * FROM server_requests ORDER BY created_at DESC LIMIT 5`).all();
  res.render('admin/dashboard', { title: 'Admin Dashboard', pendingCount, serverCount, adminCount, recentRequests });
});

// ─── Manage Pending Requests ──────────────────────────────────────────────────
router.get('/requests', (req, res) => {
  const safeStatuses = ['pending', 'approved', 'rejected'];
  const status = safeStatuses.includes(req.query.status) ? req.query.status : 'pending';
  const requests = db.prepare(`SELECT * FROM server_requests WHERE status = ? ORDER BY created_at DESC`).all(status);

  // Build a map of blacklisted IPs for quick lookup
  const blacklistRows = db.prepare(`SELECT ip, reason FROM ip_blacklist`).all();
  const blacklistMap = {};
  blacklistRows.forEach(r => { blacklistMap[r.ip.toLowerCase()] = r.reason; });

  res.render('admin/requests', { title: 'Server Requests', requests, statusFilter: status, blacklistMap });
});

router.post('/requests/:id/approve', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.redirect('/admin/requests?error=not_found');
  const request = db.prepare(`SELECT * FROM server_requests WHERE id = ?`).get(id);
  if (!request) return res.redirect('/admin/requests?error=not_found');

  if (request.update_of_server_id) {
    // This is an update request — replace the existing live server
    const liveServer = db.prepare(`SELECT * FROM servers WHERE id = ?`).get(request.update_of_server_id);
    if (liveServer) {
      // Delete old banner only if it's different from the update's banner
      if (liveServer.banner_filename && liveServer.banner_filename !== request.banner_filename) {
        try { fs.unlinkSync(path.join(uploadsDir, path.basename(liveServer.banner_filename))); } catch(e) {}
      }
      db.prepare(`
        UPDATE servers SET name=?, ip=?, port=?, description=?, website_url=?, banner_filename=?, version=?, tags=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).run(request.name, request.ip, request.port, request.description, request.website_url,
             request.banner_filename, request.version, request.tags, request.update_of_server_id);
    }
    db.prepare(`UPDATE server_requests SET status='approved', reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id, id);
    db.prepare(`INSERT INTO user_notifications (discord_id, message) VALUES (?, ?)`).run(request.submitted_by_discord_id,
      `✅ Your update to "${request.name}" has been approved and is now live!`);
    logAction(req, 'approve_update', 'server_request', id, request.name);
  } else {
    // Normal new server approval
    db.prepare(`
      INSERT INTO servers (name, ip, port, description, website_url, banner_filename, version, tags, status, submitted_by_discord_id, submitted_by_username)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)
    `).run(request.name, request.ip, request.port, request.description, request.website_url,
           request.banner_filename, request.version, request.tags,
           request.submitted_by_discord_id, request.submitted_by_username);
    db.prepare(`UPDATE server_requests SET status='approved', reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id, id);
    db.prepare(`INSERT INTO user_notifications (discord_id, message) VALUES (?, ?)`).run(request.submitted_by_discord_id,
      `✅ Your server "${request.name}" has been approved and is now live!`);
    logAction(req, 'approve_request', 'server_request', id, request.name);
  }

  res.redirect('/admin/requests?success=approved');
});

router.post('/requests/:id/reject', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.redirect('/admin/requests?error=not_found');
  const request = db.prepare(`SELECT * FROM server_requests WHERE id = ?`).get(id);
  if (!request) return res.redirect('/admin/requests?error=not_found');

  const note = (req.body.note || '').substring(0, 500);
  const addToBlacklist = req.body.blacklist === '1' && note;

  db.prepare(`UPDATE server_requests SET status = 'rejected', reviewed_by = ?, review_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(req.user.id, note, id);

  // Delete banner file when rejecting (it's never going to be shown)
  // For update requests: only delete if banner differs from the live server's banner
  if (request.banner_filename) {
    let safeToDelete = true;
    if (request.update_of_server_id) {
      const liveServer = db.prepare(`SELECT banner_filename FROM servers WHERE id = ?`).get(request.update_of_server_id);
      if (liveServer && liveServer.banner_filename === request.banner_filename) safeToDelete = false;
    }
    if (safeToDelete) {
      try { fs.unlinkSync(path.join(uploadsDir, path.basename(request.banner_filename))); } catch(e) {}
    }
  }

  // Add IP to blacklist if requested
  if (addToBlacklist) {
    const ip = request.ip.trim().toLowerCase();
    db.prepare(`INSERT INTO ip_blacklist (ip, reason, added_by, source_request_id) VALUES (?, ?, ?, ?) ON CONFLICT(ip) DO UPDATE SET reason=excluded.reason, added_by=excluded.added_by, source_request_id=excluded.source_request_id, created_at=CURRENT_TIMESTAMP`)
      .run(ip, note, req.user.id, id);
    logAction(req, 'blacklist_ip', 'ip_blacklist', id, ip, note);
  }

  // For update requests: rejection doesn't affect the live server — just notify
  const isUpdate = !!request.update_of_server_id;
  const notifMsg = isUpdate
    ? (note ? `❌ Your update to "${request.name}" was rejected. Reason: ${note}` : `❌ Your update to "${request.name}" was rejected. Your current live listing is unchanged.`)
    : (note ? `❌ Your server "${request.name}" was rejected. Reason: ${note}` : `❌ Your server "${request.name}" was rejected.`);
  db.prepare(`INSERT INTO user_notifications (discord_id, message) VALUES (?, ?)`).run(request.submitted_by_discord_id, notifMsg);

  logAction(req, isUpdate ? 'reject_update' : 'reject_request', 'server_request', id, request.name, note || null);
  res.redirect('/admin/requests?success=rejected');
});

// ─── Manage Servers ───────────────────────────────────────────────────────────
router.get('/servers', (req, res) => {
  const q = req.query.q || '';
  let servers;
  if (q) {
    servers = db.prepare(`SELECT * FROM servers WHERE name LIKE ? OR ip LIKE ? ORDER BY created_at DESC`).all(`%${q}%`, `%${q}%`);
  } else {
    servers = db.prepare(`SELECT * FROM servers ORDER BY created_at DESC`).all();
  }
  res.render('admin/servers', { title: 'Manage Servers', servers, query: q });
});

router.get('/servers/:id/edit', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.redirect('/admin/servers?error=not_found');
  const server = db.prepare(`SELECT * FROM servers WHERE id = ?`).get(id);
  if (!server) return res.redirect('/admin/servers?error=not_found');
  server.tagList = server.tags ? server.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  res.render('admin/edit-server', { title: `Edit: ${server.name}`, server, errors: [] });
});

router.post('/servers/:id/edit', upload.single('banner'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.redirect('/admin/servers?error=not_found');
  const server = db.prepare(`SELECT * FROM servers WHERE id = ?`).get(id);
  if (!server) return res.redirect('/admin/servers?error=not_found');

  const { name, ip, port, description, website_url, version, tags, remove_banner, edit_reason } = req.body;
  const errors = [];

  if (!name || name.trim().length < 2) errors.push('Name is required');
  if (!ip || ip.trim().length < 3) errors.push('IP is required');
  if (description && description.length > 2000) errors.push('Description too long (max 2000 chars)');

  if (errors.length) {
    if (req.file) fs.unlinkSync(req.file.path);
    server.tagList = server.tags ? server.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    return res.render('admin/edit-server', { title: `Edit: ${server.name}`, server, errors });
  }

  let bannerFilename = server.banner_filename;
  if (remove_banner === '1') {
    if (bannerFilename) {
      const oldPath = path.join(uploadsDir, path.basename(bannerFilename));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    bannerFilename = null;
  }
  if (req.file) {
    if (bannerFilename) {
      const oldPath = path.join(uploadsDir, path.basename(bannerFilename));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    bannerFilename = req.file.filename;
  }

  const safeReason = (edit_reason || '').trim().substring(0, 500) || null;

  db.prepare(`
    UPDATE servers SET name=?, ip=?, port=?, description=?, website_url=?, banner_filename=?, version=?, tags=?, last_edit_reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(name.trim(), ip.trim(), parseInt(port) || 25565, description || '', website_url || '',
    bannerFilename, version || '', tags || '', safeReason, id);

  // Notify owner if edit reason provided
  if (server.submitted_by_discord_id && safeReason) {
    db.prepare(`INSERT INTO user_notifications (discord_id, message) VALUES (?, ?)`)
      .run(server.submitted_by_discord_id, `✏️ Your server "${name.trim()}" was edited by an admin. Reason: ${safeReason}`);
  }

  logAction(req, 'edit_server', 'server', id, server.name, safeReason);
  res.redirect('/admin/servers?success=updated');
});

router.post('/servers/:id/delete', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.redirect('/admin/servers?error=not_found');
  const server = db.prepare(`SELECT * FROM servers WHERE id = ?`).get(id);
  if (server) {
    const reason = (req.body.reason || '').trim().substring(0, 500) || null;

    if (server.banner_filename) {
      const p = path.join(uploadsDir, path.basename(server.banner_filename));
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    // Notify the submitter
    if (server.submitted_by_discord_id) {
      const notifMsg = reason
        ? `🗑️ Your server "${server.name}" was removed from the listing. Reason: ${reason}`
        : `🗑️ Your server "${server.name}" was removed from the listing.`;
      db.prepare(`INSERT INTO user_notifications (discord_id, message) VALUES (?, ?)`).run(server.submitted_by_discord_id, notifMsg);
    }

    // Also clean up votes
    db.prepare(`DELETE FROM server_votes WHERE server_id = ?`).run(id);
    db.prepare(`DELETE FROM servers WHERE id = ?`).run(id);

    logAction(req, 'delete_server', 'server', id, server.name, reason);
  }
  res.redirect('/admin/servers?success=deleted');
});

// ─── IP Blacklist Management ──────────────────────────────────────────────────
router.get('/blacklist', (req, res) => {
  const entries = db.prepare(`SELECT * FROM ip_blacklist ORDER BY created_at DESC`).all();
  res.render('admin/blacklist', { title: 'IP Blacklist', entries });
});

router.post('/blacklist/add', (req, res) => {
  const ip = (req.body.ip || '').trim().toLowerCase();
  const reason = (req.body.reason || '').trim().substring(0, 500);
  if (!ip) return res.redirect('/admin/blacklist?error=no_ip');

  db.prepare(`
    INSERT INTO ip_blacklist (ip, reason, added_by)
    VALUES (?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET reason=excluded.reason, added_by=excluded.added_by, created_at=CURRENT_TIMESTAMP
  `).run(ip, reason || null, req.user.id);

  logAction(req, 'blacklist_ip', 'ip_blacklist', null, ip, reason || null);
  res.redirect('/admin/blacklist?success=added');
});

router.post('/blacklist/:id/remove', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.redirect('/admin/blacklist?error=not_found');
  const entry = db.prepare(`SELECT * FROM ip_blacklist WHERE id = ?`).get(id);
  if (entry) {
    db.prepare(`DELETE FROM ip_blacklist WHERE id = ?`).run(id);
    logAction(req, 'unblacklist_ip', 'ip_blacklist', id, entry.ip);
  }
  res.redirect('/admin/blacklist?success=removed');
});

// ─── Site Guidelines ──────────────────────────────────────────────────────────
router.get('/guidelines', (req, res) => {
  const row = db.prepare(`SELECT value FROM site_settings WHERE key = 'submission_guidelines'`).get();
  const guidelines = row ? row.value : '';
  res.render('admin/guidelines', { title: 'Edit Submission Guidelines', guidelines, errors: [] });
});

router.post('/guidelines', (req, res) => {
  const text = (req.body.guidelines || '').substring(0, 20000);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO site_settings (key, value, updated_by, updated_at)
    VALUES ('submission_guidelines', ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at
  `).run(text, req.user.id, now);
  logAction(req, 'edit_guidelines', 'site_settings', null, 'submission_guidelines');
  res.redirect('/admin/guidelines?success=saved');
});
// ─── Admin Logs ───────────────────────────────────────────────────────────────

// Delete a single log entry — owner only
router.post('/logs/delete-all', (req, res) => {
  const ownerId = process.env.INITIAL_ADMIN_ID;
  if (!ownerId || req.user.id !== ownerId) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'Only the site owner can delete log entries.', code: 403 });
  }
  db.prepare(`DELETE FROM admin_logs`).run();
  res.redirect('/admin/logs?success=deleted');
});

router.post('/logs/:id/delete', (req, res) => {
  const ownerId = process.env.INITIAL_ADMIN_ID;
  if (!ownerId || req.user.id !== ownerId) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'Only the site owner can delete log entries.', code: 403 });
  }
  const id = parseInt(req.params.id);
  if (id > 0) db.prepare(`DELETE FROM admin_logs WHERE id = ?`).run(id);
  res.redirect('/admin/logs?success=deleted');
});

router.get('/logs', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const PAGE_SIZE = 50;
  const filterAdmin = req.query.admin || '';
  const filterAction = req.query.action || '';

  let countQ = `SELECT COUNT(*) as total FROM admin_logs WHERE 1=1`;
  let dataQ  = `SELECT * FROM admin_logs WHERE 1=1`;
  const params = [];

  if (filterAdmin) {
    countQ += ` AND (admin_discord_id = ? OR admin_username LIKE ?)`;
    dataQ  += ` AND (admin_discord_id = ? OR admin_username LIKE ?)`;
    params.push(filterAdmin, `%${filterAdmin}%`);
  }
  if (filterAction) {
    countQ += ` AND action = ?`;
    dataQ  += ` AND action = ?`;
    params.push(filterAction);
  }

  const total = db.prepare(countQ).get(...params).total;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);

  dataQ += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  const logs = db.prepare(dataQ).all(...params, PAGE_SIZE, (currentPage - 1) * PAGE_SIZE);

  const actionTypes = db.prepare(`SELECT DISTINCT action FROM admin_logs ORDER BY action`).all().map(r => r.action);
  const admins = db.prepare(`SELECT DISTINCT admin_discord_id, admin_username FROM admin_logs ORDER BY admin_username`).all();

  res.render('admin/logs', { title: 'Admin Logs', logs, total, currentPage, totalPages, filterAdmin, filterAction, actionTypes, admins, isOwner: !!(process.env.INITIAL_ADMIN_ID && req.user.id === process.env.INITIAL_ADMIN_ID) });
});

// ─── Manage Admins ────────────────────────────────────────────────────────────
router.get('/admins', (req, res) => {
  const admins = db.prepare(`SELECT * FROM admins ORDER BY created_at DESC`).all();
  res.render('admin/admins', { title: 'Manage Admins', admins, errors: [] });
});

router.post('/admins/add', (req, res) => {
  const discordId       = (req.body.discord_id || '').trim();
  const discordUsername = (req.body.discord_username || '').trim().substring(0, 64);
  const errors = [];

  if (!discordId || !/^\d{17,20}$/.test(discordId)) {
    errors.push('Invalid Discord ID (must be 17-20 digit number)');
  }

  if (!errors.length) {
    const existing = db.prepare(`SELECT id FROM admins WHERE discord_id = ?`).get(discordId);
    if (existing) errors.push('This Discord ID is already an admin');
  }

  if (errors.length) {
    const admins = db.prepare(`SELECT * FROM admins ORDER BY created_at DESC`).all();
    return res.render('admin/admins', { title: 'Manage Admins', admins, errors });
  }

  db.prepare(`INSERT INTO admins (discord_id, discord_username, added_by) VALUES (?, ?, ?)`)
    .run(discordId, discordUsername || null, req.user.id);
  logAction(req, 'add_admin', 'admin', null, discordUsername || discordId);
  res.redirect('/admin/admins?success=added');
});

router.post('/admins/:id/delete', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.redirect('/admin/admins?error=not_found');
  const admin = db.prepare(`SELECT * FROM admins WHERE id = ?`).get(id);
  if (admin && admin.discord_id === req.user.id) {
    return res.redirect('/admin/admins?error=cannot_remove_self');
  }
  if (admin) {
    db.prepare(`DELETE FROM admins WHERE id = ?`).run(id);
    logAction(req, 'remove_admin', 'admin', id, admin.discord_username || admin.discord_id);
  }
  res.redirect('/admin/admins?success=removed');
});

module.exports = router;
