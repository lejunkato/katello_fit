const path = require("path");
const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH || path.join(__dirname, "app.db");
const db = new Database(dbPath);

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'participant',
      goal_exercises INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      goal_count INTEGER NOT NULL,
      group_goal INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      prize TEXT,
      penalty TEXT,
      invite_code TEXT,
      created_at TEXT NOT NULL,
      creator_id INTEGER NOT NULL,
      FOREIGN KEY(creator_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS challenge_participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      challenge_id INTEGER NOT NULL,
      joined_at TEXT NOT NULL,
      UNIQUE(user_id, challenge_id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(challenge_id) REFERENCES challenges(id)
    );

    CREATE TABLE IF NOT EXISTS exercise_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      challenge_id INTEGER NOT NULL,
      count INTEGER NOT NULL,
      activity TEXT,
      logged_on TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(challenge_id) REFERENCES challenges(id)
    );
  `);

  const columns = db.prepare("PRAGMA table_info(exercise_logs)").all();
  const hasActivity = columns.some((col) => col.name === "activity");
  if (!hasActivity) {
    db.exec("ALTER TABLE exercise_logs ADD COLUMN activity TEXT");
  }

  const challengeColumns = db.prepare("PRAGMA table_info(challenges)").all();
  const hasInvite = challengeColumns.some((col) => col.name === "invite_code");
  if (!hasInvite) {
    db.exec("ALTER TABLE challenges ADD COLUMN invite_code TEXT");
  }

  const hasGroupGoal = challengeColumns.some((col) => col.name === "group_goal");
  if (!hasGroupGoal) {
    db.exec("ALTER TABLE challenges ADD COLUMN group_goal INTEGER");
  }

  const hasStatus = challengeColumns.some((col) => col.name === "status");
  if (!hasStatus) {
    db.exec("ALTER TABLE challenges ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }

  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  const hasGoal = userColumns.some((col) => col.name === "goal_exercises");
  if (!hasGoal) {
    db.exec("ALTER TABLE users ADD COLUMN goal_exercises INTEGER DEFAULT 0");
  }
}

module.exports = { db, initDb };
