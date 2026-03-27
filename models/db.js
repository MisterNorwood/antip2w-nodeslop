const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'mcservers.db');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT UNIQUE NOT NULL,
    discord_username TEXT,
    added_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ip TEXT NOT NULL,
    port INTEGER DEFAULT 25565,
    description TEXT,
    website_url TEXT,
    banner_filename TEXT,
    version TEXT,
    tags TEXT,
    status TEXT DEFAULT 'pending',
    submitted_by_discord_id TEXT,
    submitted_by_username TEXT,
    online INTEGER DEFAULT 0,
    player_count INTEGER DEFAULT 0,
    max_player_count INTEGER DEFAULT 0,
    vote_score INTEGER DEFAULT 0,
    last_edit_reason TEXT,
    last_checked DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS server_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ip TEXT NOT NULL,
    port INTEGER DEFAULT 25565,
    description TEXT,
    website_url TEXT,
    banner_filename TEXT,
    version TEXT,
    tags TEXT,
    submitted_by_discord_id TEXT NOT NULL,
    submitted_by_username TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    reviewed_by TEXT,
    review_note TEXT,
    update_of_server_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS server_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    user_discord_id TEXT NOT NULL,
    vote INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server_id, user_discord_id)
  );

  CREATE TABLE IF NOT EXISTS admin_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_discord_id TEXT NOT NULL,
    admin_username TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER,
    target_name TEXT,
    reason TEXT,
    extra TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT NOT NULL,
    message TEXT NOT NULL,
    read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_by TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ip_blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL UNIQUE,
    reason TEXT,
    added_by TEXT,
    source_request_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    path TEXT,
    discord_id TEXT,
    ip_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migrations for existing DBs
const adminCols = db.pragma('table_info(admins)').map(c => c.name);
if (!adminCols.includes('discord_username')) db.exec(`ALTER TABLE admins ADD COLUMN discord_username TEXT`);

const serverCols = db.pragma('table_info(servers)').map(c => c.name);
if (!serverCols.includes('online'))           db.exec(`ALTER TABLE servers ADD COLUMN online INTEGER DEFAULT 0`);
if (!serverCols.includes('player_count'))     db.exec(`ALTER TABLE servers ADD COLUMN player_count INTEGER DEFAULT 0`);
if (!serverCols.includes('max_player_count')) db.exec(`ALTER TABLE servers ADD COLUMN max_player_count INTEGER DEFAULT 0`);
if (!serverCols.includes('last_checked'))     db.exec(`ALTER TABLE servers ADD COLUMN last_checked DATETIME`);
if (!serverCols.includes('vote_score'))       db.exec(`ALTER TABLE servers ADD COLUMN vote_score INTEGER DEFAULT 0`);
if (!serverCols.includes('last_edit_reason')) db.exec(`ALTER TABLE servers ADD COLUMN last_edit_reason TEXT`);

const reqCols = db.pragma('table_info(server_requests)').map(c => c.name);
if (!reqCols.includes('update_of_server_id')) db.exec(`ALTER TABLE server_requests ADD COLUMN update_of_server_id INTEGER`);

// Seed default submission guidelines if not already set
const existingGuidelines = db.prepare(`SELECT key FROM site_settings WHERE key = 'submission_guidelines'`).get();
if (!existingGuidelines) {
  const defaultGuidelines = `## Submission Guidelines

Before submitting your server, please make sure it meets the following criteria:

### ✅ Your server must:
- Be **free-to-play** — all gameplay features accessible without payment
- Not sell ranks, kits, or items that provide a gameplay advantage
- Not have pay-walled access to game modes or worlds
- Be an **active** Minecraft server (not offline or abandoned)

### ❌ Your server must NOT:
- Sell items, resources, or gear that affect PvP or survival balance
- Require payment to access core gameplay features
- Have loot boxes or gacha mechanics tied to real money

### 📝 Tips for a good submission:
- Use a clear, accurate server name
- Write a helpful description explaining what makes your server unique
- Add relevant tags so players can find your server easily
- Upload a banner image to make your listing stand out

Servers that do not meet these guidelines will be rejected. If you believe your server was incorrectly rejected, please reach out on our [Discord](https://dsc.gg/ap2w).`;
  db.prepare(`INSERT INTO site_settings (key, value, updated_by) VALUES ('submission_guidelines', ?, 'system')`).run(defaultGuidelines);
}

const initialAdminId = process.env.INITIAL_ADMIN_ID;
if (initialAdminId && initialAdminId !== 'your_discord_user_id_here') {
  const existing = db.prepare('SELECT id FROM admins WHERE discord_id = ?').get(initialAdminId);
  if (!existing) {
    db.prepare('INSERT INTO admins (discord_id, added_by) VALUES (?, ?)').run(initialAdminId, 'system');
    console.log(`✅ Initial admin seeded: ${initialAdminId}`);
  }
}

module.exports = db;
