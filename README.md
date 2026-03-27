# ⛏ MCList — Minecraft Server Directory

A full-featured Minecraft server listing website with Discord OAuth, admin review system, animated GIF banners, search, and more.

---

## Features

- 🔐 **Discord OAuth2 login** — users log in with their Discord account
- 📋 **Server submissions** — logged-in users can submit servers for review
- ✅ **Admin approval queue** — admins review, approve, or reject submissions with optional notes
- 🖼️ **GIF banner support** — servers can have animated GIF banners (up to 5MB)
- 🔍 **Search & tag filtering** — search servers by name, IP, description, or tag
- ✏️ **Admin server editing** — admins can edit any server listing or delete it
- 🛡️ **Admin management** — admins can add/remove other admins by pasting Discord IDs
- 📱 **Responsive design** — works on desktop and mobile

---

## Setup

### 1. Clone & Install

```bash
cd mcservers
npm install
```

### 2. Create a Discord Application

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** and give it a name
3. Go to **OAuth2** in the left sidebar
4. Under **Redirects**, add: `http://localhost:3000/auth/discord/callback`
5. Copy your **Client ID** and **Client Secret**

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```env
DISCORD_CLIENT_ID=your_client_id_here
DISCORD_CLIENT_SECRET=your_client_secret_here
DISCORD_CALLBACK_URL=http://localhost:3000/auth/discord/callback

SESSION_SECRET=some_long_random_string_here

PORT=3000
BASE_URL=http://localhost:3000

# Your Discord User ID (enables you as the first admin)
INITIAL_ADMIN_ID=your_discord_user_id_here
```

**How to find your Discord User ID:**
1. Open Discord → Settings → Advanced → Enable **Developer Mode**
2. Right-click your own username anywhere
3. Click **Copy User ID**

### 4. Run

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

Visit [http://localhost:3000](http://localhost:3000)

---

## Project Structure

```
mcservers/
├── app.js                  # Entry point, Express setup
├── .env.example            # Environment template
├── package.json
├── data/                   # Auto-created: SQLite databases
│   ├── mcservers.db        # Main database
│   └── sessions.db         # Session store
├── middleware/
│   └── auth.js             # Auth guards + admin check
├── models/
│   └── db.js               # SQLite setup + schema
├── public/
│   ├── css/main.css        # All styles
│   ├── js/main.js          # Client JS
│   └── uploads/            # Auto-created: uploaded banners
├── routes/
│   ├── auth.js             # /auth/discord, /auth/logout
│   ├── servers.js          # Public + user server routes
│   └── admin.js            # Admin-only routes
└── views/
    ├── layout.ejs           # Main HTML shell
    ├── home.ejs             # Homepage
    ├── error.ejs            # Error page
    ├── servers/
    │   ├── index.ejs        # Server listing/search
    │   ├── show.ejs         # Single server page
    │   ├── submit.ejs       # Submit form
    │   └── my-requests.ejs  # User's submission history
    └── admin/
        ├── dashboard.ejs    # Admin home
        ├── requests.ejs     # Review submissions
        ├── servers.ejs      # Manage all servers
        ├── edit-server.ejs  # Edit a server
        └── admins.ejs       # Manage admins
```

---

## Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Homepage with recent servers |
| GET | `/servers` | Browse/search all servers |
| GET | `/servers/:id` | Single server page |
| GET | `/servers/submit/new` | Submit form (auth required) |
| POST | `/servers/submit/new` | Handle submission |
| GET | `/servers/requests/mine` | User's own submissions |
| GET | `/auth/discord` | Start Discord OAuth |
| GET | `/auth/discord/callback` | OAuth callback |
| GET | `/auth/logout` | Logout |
| GET | `/admin` | Admin dashboard |
| GET | `/admin/requests` | Review pending submissions |
| POST | `/admin/requests/:id/approve` | Approve a submission |
| POST | `/admin/requests/:id/reject` | Reject a submission |
| GET | `/admin/servers` | Manage all live servers |
| GET | `/admin/servers/:id/edit` | Edit server form |
| POST | `/admin/servers/:id/edit` | Save edits |
| POST | `/admin/servers/:id/delete` | Delete a server |
| GET | `/admin/admins` | Manage admins |
| POST | `/admin/admins/add` | Add admin by Discord ID |
| POST | `/admin/admins/:id/delete` | Remove admin |

---

## Deploying to Production

1. Set `NODE_ENV=production` in your environment
2. Update `DISCORD_CALLBACK_URL` and `BASE_URL` to your real domain
3. In Discord Developer Portal, add your production callback URL
4. Use a process manager like PM2:
   ```bash
   npm install -g pm2
   pm2 start app.js --name mclist
   pm2 save
   ```
5. Put Nginx or Caddy in front for HTTPS

---

## Database

The app uses SQLite via `better-sqlite3`. The database file is created automatically at `data/mcservers.db`. Tables:

- `admins` — Discord IDs of site admins
- `servers` — Approved/live server listings  
- `server_requests` — Pending/reviewed submission requests
