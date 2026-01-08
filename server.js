require("dotenv").config();

const path = require("path");
const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcrypt");
const morgan = require("morgan");
const expressLayouts = require("express-ejs-layouts");

const { db, initDb } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

initDb();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("layout", "layout");

app.use(morgan("dev"));
app.use(express.urlencoded({ extended: false }));
app.use(expressLayouts);
app.use(
  session({
    store: new SQLiteStore({ db: "sessions.db", dir: __dirname }),
    secret: process.env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 7 },
  })
);
app.use(express.static(path.join(__dirname, "static")));

function addFlash(req, type, message) {
  if (!req.session.flash) {
    req.session.flash = [];
  }
  req.session.flash.push({ type, message });
}

function consumeFlash(req) {
  const messages = req.session.flash || [];
  req.session.flash = [];
  return messages;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect("/login");
  }
  return next();
}

function requireCreator(req, res, next) {
  return next();
}

function toDateOnly(value) {
  return new Date(`${value}T00:00:00`);
}

function daysRemaining(endDate) {
  const today = new Date();
  const end = toDateOnly(endDate);
  const diffMs = end.getTime() - toDateOnly(today.toISOString().slice(0, 10)).getTime();
  return Math.max(Math.ceil(diffMs / (1000 * 60 * 60 * 24)), 0);
}

app.use((req, res, next) => {
  res.locals.currentUser = req.session.userName
    ? { name: req.session.userName, role: req.session.role }
    : null;
  res.locals.currentPath = req.path;
  res.locals.flash = consumeFlash(req);
  next();
});

app.get("/", (req, res) => {
  if (req.session.userId) {
    return res.redirect("/dashboard");
  }
  return res.redirect("/login");
});

app.get("/registrar", (req, res) => {
  res.render("register", { title: "Criar conta" });
});

app.post("/registrar", async (req, res) => {
  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";

  if (!name || !email || !password) {
    addFlash(req, "error", "Preencha todos os campos obrigatorios.");
    return res.redirect("/registrar");
  }

  const existing = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(email);
  if (existing) {
    addFlash(req, "error", "Este email ja esta cadastrado.");
    return res.redirect("/registrar");
  }

  const passwordHash = await bcrypt.hash(password, 10);
  db.prepare(
    `INSERT INTO users (name, email, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(name, email, passwordHash, "participant", new Date().toISOString());

  addFlash(req, "success", "Cadastro criado com sucesso. Faca login.");
  return res.redirect("/login");
});

app.get("/login", (req, res) => {
  res.render("login", { title: "Entrar" });
});

app.post("/login", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";

  const user = db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email);
  if (!user) {
    addFlash(req, "error", "Email ou senha invalidos.");
    return res.redirect("/login");
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    addFlash(req, "error", "Email ou senha invalidos.");
    return res.redirect("/login");
  }

  req.session.userId = user.id;
  req.session.userName = user.name;
  req.session.role = user.role;
  return res.redirect("/dashboard");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/dashboard", requireAuth, (req, res) => {
  const challenges = db
    .prepare("SELECT * FROM challenges ORDER BY end_date ASC")
    .all();

  const creatorChallenges = db
    .prepare("SELECT * FROM challenges WHERE creator_id = ?")
    .all(req.session.userId);

  const joinedRows = db
    .prepare("SELECT challenge_id FROM challenge_participants WHERE user_id = ?")
    .all(req.session.userId);
  const joinedIds = new Set(joinedRows.map((row) => row.challenge_id));

  const userExerciseCount = db
    .prepare("SELECT COUNT(id) AS total FROM exercise_logs WHERE user_id = ?")
    .get(req.session.userId).total;

  const activeChallenge = challenges[0] || null;
  let activeStats = null;
  if (activeChallenge) {
    const participantCount = db
      .prepare(
        "SELECT COUNT(*) AS total FROM challenge_participants WHERE challenge_id = ?"
      )
      .get(activeChallenge.id).total;
    const userTotal = db
      .prepare(
        "SELECT COUNT(id) AS total FROM exercise_logs WHERE user_id = ? AND challenge_id = ?"
      )
      .get(req.session.userId, activeChallenge.id).total;
    const progressPercent = activeChallenge.goal_count
      ? Math.min(Math.round((userTotal / activeChallenge.goal_count) * 100), 100)
      : 0;
    activeStats = {
      participantCount,
      userTotal,
      progressPercent,
      daysRemaining: daysRemaining(activeChallenge.end_date),
    };
  }

  const leaderboardRows = activeChallenge
    ? db
        .prepare(
          `SELECT u.id AS user_id, COALESCE(COUNT(e.id), 0) AS total
           FROM users u
           JOIN challenge_participants cp ON cp.user_id = u.id
           LEFT JOIN exercise_logs e
             ON e.user_id = u.id AND e.challenge_id = cp.challenge_id
           WHERE cp.challenge_id = ?
           GROUP BY u.id
           ORDER BY total DESC, u.name ASC`
        )
        .all(activeChallenge.id)
    : [];
  const position =
    leaderboardRows.findIndex((row) => row.user_id === req.session.userId) + 1;

  const creatorCards = creatorChallenges.map((challenge) => {
    const participantCount = db
      .prepare(
        "SELECT COUNT(*) AS total FROM challenge_participants WHERE challenge_id = ?"
      )
      .get(challenge.id).total;
    const userTotal = db
      .prepare(
        "SELECT COUNT(id) AS total FROM exercise_logs WHERE user_id = ? AND challenge_id = ?"
      )
      .get(req.session.userId, challenge.id).total;
    const progressPercent = challenge.goal_count
      ? Math.min(Math.round((userTotal / challenge.goal_count) * 100), 100)
      : 0;
    return {
      ...challenge,
      participantCount,
      progressPercent,
      daysRemaining: daysRemaining(challenge.end_date),
    };
  });

  res.render("dashboard", {
    title: "Dashboard",
    activeChallenges: challenges,
    creatorChallenges: creatorCards,
    joinedIds,
    userExerciseCount,
    activeChallenge,
    activeStats,
    position: position || "--",
  });
});

app.get("/perfil", requireAuth, (req, res) => {
  const user = db
    .prepare("SELECT id, name, email, role, created_at FROM users WHERE id = ?")
    .get(req.session.userId);
  const createdCount = db
    .prepare("SELECT COUNT(*) AS total FROM challenges WHERE creator_id = ?")
    .get(req.session.userId).total;
  const joinedCount = db
    .prepare(
      "SELECT COUNT(*) AS total FROM challenge_participants WHERE user_id = ?"
    )
    .get(req.session.userId).total;
  const exerciseCount = db
    .prepare("SELECT COUNT(id) AS total FROM exercise_logs WHERE user_id = ?")
    .get(req.session.userId).total;

  res.render("profile", {
    title: "Perfil",
    user,
    createdCount,
    joinedCount,
    exerciseCount,
  });
});

app.get("/challenges/novo", requireAuth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.render("create_challenge", { title: "Novo desafio", today });
});

app.post("/challenges/novo", requireAuth, (req, res) => {
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim();
  const startDate = req.body.start_date;
  const endDate = req.body.end_date;
  const goalCount = Number(req.body.goal_count || 0);
  const prize = (req.body.prize || "").trim();
  const penalty = (req.body.penalty || "").trim();

  if (!description || !startDate || !endDate || !goalCount) {
    addFlash(req, "error", "Descricao, datas e meta sao obrigatorios.");
    return res.redirect("/challenges/novo");
  }

  const result = db
    .prepare(
      `INSERT INTO challenges
        (title, description, start_date, end_date, goal_count, prize, penalty, created_at, creator_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title,
      description || null,
      startDate,
      endDate,
      goalCount,
      prize || null,
      penalty || null,
      new Date().toISOString(),
      req.session.userId
    );

  addFlash(req, "success", "Desafio criado!");
  return res.redirect(`/challenges/${result.lastInsertRowid}`);
});

app.get("/challenges/:id", requireAuth, (req, res) => {
  const challengeId = Number(req.params.id);
  const challenge = db
    .prepare("SELECT * FROM challenges WHERE id = ?")
    .get(challengeId);
  if (!challenge) {
    addFlash(req, "error", "Desafio nao encontrado.");
    return res.redirect("/dashboard");
  }

  const participant = db
    .prepare(
      "SELECT id FROM challenge_participants WHERE user_id = ? AND challenge_id = ?"
    )
    .get(req.session.userId, challengeId);
  const hasJoined = Boolean(participant);

  const leaderboardRows = db
    .prepare(
      `SELECT u.name AS name, COALESCE(COUNT(e.id), 0) AS total
       FROM users u
       JOIN challenge_participants cp ON cp.user_id = u.id
       LEFT JOIN exercise_logs e
         ON e.user_id = u.id AND e.challenge_id = cp.challenge_id
       WHERE cp.challenge_id = ?
       GROUP BY u.id
       ORDER BY total DESC, u.name ASC`
    )
    .all(challengeId);

  const leaderboard = leaderboardRows.map((row) => ({
    name: row.name,
    total: row.total,
    remaining: Math.max(challenge.goal_count - row.total, 0),
  }));

  res.render("challenge", {
    title: challenge.title,
    challenge,
    hasJoined,
    leaderboard,
    isOwner: challenge.creator_id === req.session.userId,
    today: new Date().toISOString().slice(0, 10),
  });
});

app.post("/challenges/:id/entrar", requireAuth, (req, res) => {
  const challengeId = Number(req.params.id);

  const existing = db
    .prepare(
      "SELECT id FROM challenge_participants WHERE user_id = ? AND challenge_id = ?"
    )
    .get(req.session.userId, challengeId);
  if (existing) {
    addFlash(req, "info", "Voce ja participa deste desafio.");
    return res.redirect(`/challenges/${challengeId}`);
  }

  db.prepare(
    `INSERT INTO challenge_participants (user_id, challenge_id, joined_at)
     VALUES (?, ?, ?)`
  ).run(req.session.userId, challengeId, new Date().toISOString());

  addFlash(req, "success", "Participacao confirmada. Bora treinar!");
  return res.redirect(`/challenges/${challengeId}`);
});

app.post("/challenges/:id/log", requireAuth, (req, res) => {
  const challengeId = Number(req.params.id);
  const activity = (req.body.activity || "").trim();
  const loggedOn = req.body.logged_on || new Date().toISOString().slice(0, 10);

  if (!activity) {
    addFlash(req, "error", "Informe o tipo de exercicio.");
    return res.redirect(`/challenges/${challengeId}`);
  }

  const isParticipant = db
    .prepare(
      "SELECT id FROM challenge_participants WHERE user_id = ? AND challenge_id = ?"
    )
    .get(req.session.userId, challengeId);
  if (!isParticipant) {
    addFlash(req, "error", "Entre no desafio antes de registrar treinos.");
    return res.redirect(`/challenges/${challengeId}`);
  }

  db.prepare(
    `INSERT INTO exercise_logs (user_id, challenge_id, count, activity, logged_on, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    req.session.userId,
    challengeId,
    1,
    activity,
    loggedOn,
    new Date().toISOString()
  );

  addFlash(req, "success", "Treino registrado!");
  return res.redirect(`/challenges/${challengeId}`);
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
