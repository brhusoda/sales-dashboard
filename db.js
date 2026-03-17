const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'qbr.db');

let db = null;

async function getDb() {
  if (db) return db;

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Enable WAL mode equivalent (not available in sql.js, but we can still set pragmas)
  db.run('PRAGMA journal_mode = MEMORY');
  db.run('PRAGMA foreign_keys = ON');

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS leads (
      lead_id TEXT PRIMARY KEY,
      first_name TEXT,
      last_name TEXT,
      title TEXT,
      company TEXT,
      email TEXT,
      lead_source TEXT,
      street TEXT,
      rating TEXT,
      lead_owner TEXT,
      lead_status TEXT,
      converted TEXT,
      create_date TEXT,
      last_activity TEXT,
      company_norm TEXT,
      lead_name_norm TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      activity_id TEXT PRIMARY KEY,
      date TEXT,
      company TEXT,
      opportunity TEXT,
      contact TEXT,
      lead TEXT,
      subject TEXT,
      assigned TEXT,
      priority TEXT,
      status TEXT,
      task TEXT,
      comments TEXT,
      company_norm TEXT,
      is_lemlist INTEGER DEFAULT 0,
      lead_name_norm TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS lead_task_links (
      lead_id TEXT,
      company_norm TEXT,
      match_type TEXT,
      confidence REAL,
      PRIMARY KEY (lead_id, company_norm),
      FOREIGN KEY (lead_id) REFERENCES leads(lead_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS next_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id TEXT NOT NULL,
      next_step TEXT NOT NULL,
      owner TEXT,
      due_date TEXT,
      comments TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL,
      FOREIGN KEY (lead_id) REFERENCES leads(lead_id)
    )
  `);

  // Create indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_leads_company_norm ON leads(company_norm)');
  db.run('CREATE INDEX IF NOT EXISTS idx_leads_lead_name_norm ON leads(lead_name_norm)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_company_norm ON tasks(company_norm)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_lead_name_norm ON tasks(lead_name_norm)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_tasks_is_lemlist ON tasks(is_lemlist)');
  db.run('CREATE INDEX IF NOT EXISTS idx_links_company_norm ON lead_task_links(company_norm)');
  db.run('CREATE INDEX IF NOT EXISTS idx_next_steps_lead_id ON next_steps(lead_id)');

  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, buffer);
}

module.exports = { getDb, saveDb };
