const express = require('express');
const passport = require('passport');
const router = express.Router();
const crypto = require('crypto');
const db = require('../models/db');

router.get('/discord', passport.authenticate('discord'));

router.get('/discord/callback', (req, res, next) => {
  passport.authenticate('discord', (err, user, info) => {
    if (err) {
      console.error('[AUTH ERROR] System Error:', err);
      return res.redirect('/?error=system_failure');
    }

    if (!user) {
      console.error('[AUTH ERROR] Authentication Failed. Info:', info);
      return res.redirect('/?error=auth_failed');
    }

    req.logIn(user, (loginErr) => {
      if (loginErr) {
        console.error('[AUTH ERROR] Session Login Error:', loginErr);
        return next(loginErr);
      }

      console.log(`[AUTH SUCCESS] User: ${user.username} (${user.id})`);

      try {
        db.prepare(`UPDATE admins SET discord_username = ? WHERE discord_id = ?`)
          .run(user.username, user.id);

        const ipRaw = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
        const ipHash = crypto.createHash('sha256')
          .update(ipRaw + (process.env.SESSION_SECRET || ''))
          .digest('hex').slice(0, 16);

        db.prepare(`INSERT INTO analytics (event, path, discord_id, ip_hash) VALUES ('login', '/auth/discord/callback', ?, ?)`)
          .run(user.id, ipHash);
          
      } catch (dbErr) {
        console.error('[DATABASE ERROR] Analytics/Admin update failed:', dbErr.message);
      }

      const raw = req.session.returnTo || '/';
      delete req.session.returnTo;
      const returnTo = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
      return res.redirect(returnTo);
    });
  })(req, res, next);
});

router.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/');
  });
});

module.exports = router;
