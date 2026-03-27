const db = require('../models/db');

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/auth/discord');
}

function ensureAdmin(req, res, next) {
  if (!req.isAuthenticated()) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/auth/discord');
  }
  const admin = db.prepare('SELECT id FROM admins WHERE discord_id = ?').get(req.user.id);
  if (!admin) {
    return res.status(403).render('error', {
      user: req.user,
      isAdmin: false,
      title: 'Access Denied',
      message: 'You do not have admin privileges.',
      code: 403
    });
  }
  req.isAdmin = true;
  next();
}

function attachUser(req, res, next) {
  res.locals.user = req.user || null;
  res.locals.isAdmin = false;
  res.locals.isOwner = false;
  if (req.user) {
    const admin = db.prepare('SELECT id FROM admins WHERE discord_id = ?').get(req.user.id);
    res.locals.isAdmin = !!admin;
    res.locals.isOwner = !!(process.env.INITIAL_ADMIN_ID && req.user.id === process.env.INITIAL_ADMIN_ID);
  }
  next();
}

module.exports = { ensureAuthenticated, ensureAdmin, attachUser };
