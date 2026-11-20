PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS ps_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, queue_revision INTEGER NOT NULL DEFAULT 0, queue_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ps_devices (user_id INTEGER NOT NULL REFERENCES ps_users(id) ON DELETE CASCADE, device_id TEXT NOT NULL, caption TEXT NOT NULL, device_type TEXT NOT NULL, PRIMARY KEY(user_id,device_id));
CREATE TABLE IF NOT EXISTS ps_subscriptions (user_id INTEGER NOT NULL REFERENCES ps_users(id) ON DELETE CASCADE, url_hash TEXT NOT NULL, url TEXT NOT NULL, active INTEGER NOT NULL, changed_at INTEGER NOT NULL, PRIMARY KEY(user_id,url_hash));
CREATE TABLE IF NOT EXISTS ps_actions (user_id INTEGER NOT NULL REFERENCES ps_users(id) ON DELETE CASCADE, action_key TEXT NOT NULL, action_json TEXT NOT NULL, played_at INTEGER NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY(user_id,action_key));
CREATE TABLE IF NOT EXISTS ps_queue_history (user_id INTEGER NOT NULL REFERENCES ps_users(id) ON DELETE CASCADE, revision INTEGER NOT NULL, queue_json TEXT NOT NULL, changed_at INTEGER NOT NULL, PRIMARY KEY(user_id,revision));
