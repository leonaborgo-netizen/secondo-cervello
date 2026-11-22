const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data'));
const UP = path.join(DATA, 'uploads');
fs.mkdirSync(UP, { recursive: true });

const db = new Database(path.join(DATA, 'brain.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT UNIQUE,
  content     TEXT NOT NULL,
  title       TEXT,
  summary     TEXT,
  category    TEXT NOT NULL DEFAULT 'Altro' CHECK (category IN ('Lavoro','Economia','Salute','Famiglia','Altro')),
  priority    TEXT NOT NULL DEFAULT 'media' CHECK (priority IN ('alta','media','bassa')),
  tags        TEXT NOT NULL DEFAULT '[]',
  audio_url   TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS reminders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id      INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  due_date     TEXT,
  is_completed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_context (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id       INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_cat ON notes(category);
CREATE INDEX IF NOT EXISTS idx_rem_due ON reminders(is_completed, due_date);
CREATE INDEX IF NOT EXISTS idx_att_note ON attachments(note_id);
`);

module.exports = { db, UP, DATA };
