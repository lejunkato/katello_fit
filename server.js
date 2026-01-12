require("dotenv").config();

const path = require("path");
const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcrypt");
const crypto = require("crypto");
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

function generateInviteCode() {
  return crypto.randomBytes(6).toString("hex");
}

function getLocalDateString(date = new Date()) {
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

function daysRemaining(endDate) {
  const today = new Date(`${getLocalDateString()}T00:00:00`);
  const end = toDateOnly(endDate);
  const diffMs = end.getTime() - toDateOnly(today.toISOString().slice(0, 10)).getTime();
  return Math.max(Math.ceil(diffMs / (1000 * 60 * 60 * 24)), 0);
}

app.use((req, res, next) => {
  res.locals.currentUser = req.session.userName
    ? {
        name: req.session.userName,
        role: req.session.role,
        email: req.session.userEmail,
      }
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

  addFlash(req, "success", "Cadastro criado com sucesso. Faça login.");
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
    addFlash(req, "error", "E-mail ou senha inválidos.");
    return res.redirect("/login");
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    addFlash(req, "error", "E-mail ou senha inválidos.");
    return res.redirect("/login");
  }

  req.session.userId = user.id;
  req.session.userName = user.name;
  req.session.role = user.role;
  req.session.userEmail = user.email;
  return res.redirect("/dashboard");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/dashboard", requireAuth, (req, res) => {
  const visibleChallenges = db
    .prepare(
      `SELECT DISTINCT c.*
       FROM challenges c
       LEFT JOIN challenge_participants cp ON cp.challenge_id = c.id
       WHERE (c.creator_id = ? OR cp.user_id = ?) AND c.status = 'active'
       ORDER BY c.end_date ASC`
    )
    .all(req.session.userId, req.session.userId);

  const creatorChallenges = db
    .prepare("SELECT * FROM challenges WHERE creator_id = ? AND status = 'active'")
    .all(req.session.userId);

  const joinedRows = db
    .prepare("SELECT challenge_id FROM challenge_participants WHERE user_id = ?")
    .all(req.session.userId);
  const joinedIds = new Set(joinedRows.map((row) => row.challenge_id));

  const userExerciseCount = db
    .prepare("SELECT COUNT(id) AS total FROM exercise_logs WHERE user_id = ?")
    .get(req.session.userId).total;
  const userGoal = db
    .prepare("SELECT goal_exercises FROM users WHERE id = ?")
    .get(req.session.userId)?.goal_exercises || 0;

  const activeChallenge = visibleChallenges[0] || null;
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
    activeChallenges: visibleChallenges,
    creatorChallenges: creatorCards,
    joinedIds,
    userExerciseCount,
    userGoal,
    goalProgress:
      userGoal > 0 ? Math.min(Math.round((userExerciseCount / userGoal) * 100), 100) : 0,
    activeChallenge,
    activeStats,
    position: position || "--",
    today: getLocalDateString(),
  });
});

app.post("/atividades", requireAuth, (req, res) => {
  const activity = (req.body.activity || "").trim();
  const loggedOn = req.body.logged_on || getLocalDateString();

  if (!activity) {
    addFlash(req, "error", "Informe o tipo de exercicio.");
    return res.redirect("/dashboard");
  }

  const joinedChallenges = db
    .prepare("SELECT challenge_id FROM challenge_participants WHERE user_id = ?")
    .all(req.session.userId)
    .map((row) => row.challenge_id);

  if (joinedChallenges.length === 0) {
    addFlash(req, "info", "Você não participa de nenhum desafio.");
    return res.redirect("/dashboard");
  }

  const insertLog = db.prepare(
    `INSERT INTO exercise_logs (user_id, challenge_id, count, activity, logged_on, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const now = new Date().toISOString();
  const transaction = db.transaction((challengeIds) => {
    challengeIds.forEach((challengeId) => {
      insertLog.run(
        req.session.userId,
        challengeId,
        1,
        activity,
        loggedOn,
        now
      );
    });
  });

  transaction(joinedChallenges);
  addFlash(req, "success", "Atividade registrada em todos os desafios.");
  return res.redirect("/dashboard");
});

app.get("/perfil", requireAuth, (req, res) => {
  const user = db
    .prepare(
      "SELECT id, name, email, role, created_at, goal_exercises FROM users WHERE id = ?"
    )
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

  const endedChallenges = db
    .prepare(
      `SELECT DISTINCT c.*
       FROM challenges c
       LEFT JOIN challenge_participants cp ON cp.challenge_id = c.id
       WHERE (c.creator_id = ? OR cp.user_id = ?) AND c.status = 'closed'
       ORDER BY c.end_date DESC`
    )
    .all(req.session.userId, req.session.userId);

  const activityBreakdown = db
    .prepare(
      `SELECT activity, COUNT(*) AS total
       FROM exercise_logs
       WHERE user_id = ? AND activity IS NOT NULL AND activity != ''
       GROUP BY activity
       ORDER BY total DESC`
    )
    .all(req.session.userId);

  const today = new Date();
  const getWeekStart = (date) => {
    const d = new Date(date);
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - (day - 1));
    d.setHours(0, 0, 0, 0);
    return d;
  };
  const weekStart = getWeekStart(today);
  const dates = Array.from({ length: 7 }, (_, idx) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + idx);
    return d.toISOString().slice(0, 10);
  });
  const dayNames = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sab", "Dom"];
  const logs = db
    .prepare(
      `SELECT substr(logged_on, 1, 10) AS day, COUNT(*) AS total
       FROM exercise_logs
       WHERE user_id = ? AND substr(logged_on, 1, 10) >= ? AND substr(logged_on, 1, 10) <= ?
       GROUP BY day`
    )
    .all(req.session.userId, dates[0], dates[6]);
  const dayMap = new Map(logs.map((row) => [row.day, row.total]));
  const weeklySeries = dates.map((date) => ({
    label: dayNames[new Date(`${date}T00:00:00`).getDay() === 0 ? 6 : new Date(`${date}T00:00:00`).getDay() - 1],
    total: dayMap.get(date) || 0,
  }));

  res.render("profile", {
    title: "Perfil",
    user,
    createdCount,
    joinedCount,
    exerciseCount,
    activityBreakdown,
    weeklySeries,
    endedChallenges,
  });
});

app.post("/perfil/meta", requireAuth, (req, res) => {
  const goal = Number(req.body.goal_exercises || 0);
  if (goal < 0 || Number.isNaN(goal)) {
    addFlash(req, "error", "Informe uma meta valida.");
    return res.redirect("/perfil");
  }
  db.prepare("UPDATE users SET goal_exercises = ? WHERE id = ?").run(
    goal,
    req.session.userId
  );
  addFlash(req, "success", "Meta atualizada.");
  return res.redirect("/perfil");
});

app.post("/perfil/senha", requireAuth, async (req, res) => {
  const currentPassword = req.body.current_password || "";
  const newPassword = req.body.new_password || "";
  const confirmPassword = req.body.confirm_password || "";

  if (!currentPassword || !newPassword || !confirmPassword) {
    addFlash(req, "error", "Preencha todos os campos de senha.");
    return res.redirect("/perfil");
  }

  if (newPassword.length < 6) {
    addFlash(req, "error", "A nova senha deve ter pelo menos 6 caracteres.");
    return res.redirect("/perfil");
  }

  if (newPassword !== confirmPassword) {
    addFlash(req, "error", "A confirmação de senha não confere.");
    return res.redirect("/perfil");
  }

  const user = db
    .prepare("SELECT password_hash FROM users WHERE id = ?")
    .get(req.session.userId);
  if (!user) {
    addFlash(req, "error", "Usuário não encontrado.");
    return res.redirect("/perfil");
  }

  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) {
    addFlash(req, "error", "Senha atual incorreta.");
    return res.redirect("/perfil");
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
    passwordHash,
    req.session.userId
  );

  addFlash(req, "success", "Senha atualizada com sucesso.");
  return res.redirect("/perfil");
});

app.get("/admin/usuarios", requireAuth, (req, res) => {
  const users = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.created_at,
        (SELECT COUNT(*) FROM challenges c WHERE c.creator_id = u.id) AS challenges_created,
        (SELECT COUNT(*) FROM challenge_participants cp WHERE cp.user_id = u.id) AS challenges_joined,
        (SELECT COUNT(*) FROM exercise_logs e WHERE e.user_id = u.id) AS exercise_count
       FROM users u
       ORDER BY u.created_at DESC`
    )
    .all();

  res.render("admin_users", { title: "Usuários", users });
});

app.post("/admin/usuarios/:id/reset", requireAuth, async (req, res) => {
  const userId = Number(req.params.id);
  const tempPassword = crypto.randomBytes(4).toString("hex");
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const result = db
    .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .run(passwordHash, userId);

  if (!result.changes) {
    addFlash(req, "error", "Usuário não encontrado.");
    return res.redirect("/admin/usuarios");
  }

  addFlash(req, "success", `Senha temporaria: ${tempPassword}`);
  return res.redirect("/admin/usuarios");
});

app.post("/admin/usuarios/:id/excluir", requireAuth, (req, res) => {
  const userId = Number(req.params.id);

  if (userId === req.session.userId) {
    addFlash(req, "error", "Você não pode excluir seu próprio usuário.");
    return res.redirect("/admin/usuarios");
  }

  const deleteUser = db.transaction((targetUserId) => {
    const challengeIds = db
      .prepare("SELECT id FROM challenges WHERE creator_id = ?")
      .all(targetUserId)
      .map((row) => row.id);

    if (challengeIds.length) {
      const placeholders = challengeIds.map(() => "?").join(", ");
      db.prepare(
        `DELETE FROM exercise_logs WHERE challenge_id IN (${placeholders})`
      ).run(...challengeIds);
      db.prepare(
        `DELETE FROM challenge_participants WHERE challenge_id IN (${placeholders})`
      ).run(...challengeIds);
      db.prepare(`DELETE FROM challenges WHERE id IN (${placeholders})`).run(
        ...challengeIds
      );
    }

    db.prepare("DELETE FROM exercise_logs WHERE user_id = ?").run(targetUserId);
    db.prepare("DELETE FROM challenge_participants WHERE user_id = ?").run(
      targetUserId
    );
    db.prepare("DELETE FROM users WHERE id = ?").run(targetUserId);
  });

  deleteUser(userId);
  addFlash(req, "success", "Usuário excluído.");
  return res.redirect("/admin/usuarios");
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
  const groupGoal = req.body.group_goal ? Number(req.body.group_goal) : null;
  const prize = (req.body.prize || "").trim();
  const penalty = (req.body.penalty || "").trim();

  if (!description || !startDate || !endDate || !goalCount) {
    addFlash(req, "error", "Descrição, datas e meta são obrigatórios.");
    return res.redirect("/challenges/novo");
  }

  if (groupGoal !== null && (Number.isNaN(groupGoal) || groupGoal <= 0)) {
    addFlash(req, "error", "Meta do grupo deve ser um número válido.");
    return res.redirect("/challenges/novo");
  }

  const inviteCode = generateInviteCode();
  const result = db
    .prepare(
      `INSERT INTO challenges
        (title, description, start_date, end_date, goal_count, group_goal, status, prize, penalty, invite_code, created_at, creator_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      title,
      description || null,
      startDate,
      endDate,
      goalCount,
      groupGoal,
      "active",
      prize || null,
      penalty || null,
      inviteCode,
      new Date().toISOString(),
      req.session.userId
    );

  db.prepare(
    `INSERT INTO challenge_participants (user_id, challenge_id, joined_at)
     VALUES (?, ?, ?)`
  ).run(req.session.userId, result.lastInsertRowid, new Date().toISOString());

  addFlash(req, "success", "Desafio criado!");
  return res.redirect(`/challenges/${result.lastInsertRowid}`);
});

app.get("/challenges/:id", requireAuth, (req, res) => {
  const challengeId = Number(req.params.id);
  const challenge = db
    .prepare("SELECT * FROM challenges WHERE id = ?")
    .get(challengeId);
  if (!challenge) {
    addFlash(req, "error", "Desafio não encontrado.");
    return res.redirect("/dashboard");
  }

  const participant = db
    .prepare(
      "SELECT id FROM challenge_participants WHERE user_id = ? AND challenge_id = ?"
    )
    .get(req.session.userId, challengeId);
  let hasJoined = Boolean(participant);
  const isOwner = challenge.creator_id === req.session.userId;

  if (!hasJoined && !isOwner) {
    addFlash(req, "error", "Você não participa deste desafio.");
    return res.redirect("/dashboard");
  }

  if (challenge.status !== "active") {
    addFlash(req, "info", "Este desafio está encerrado.");
  }

  if (isOwner && !hasJoined) {
    db.prepare(
      `INSERT INTO challenge_participants (user_id, challenge_id, joined_at)
       VALUES (?, ?, ?)`
    ).run(req.session.userId, challengeId, new Date().toISOString());
    hasJoined = true;
  }

  if (!challenge.invite_code) {
    const newCode = generateInviteCode();
    db.prepare("UPDATE challenges SET invite_code = ? WHERE id = ?").run(
      newCode,
      challengeId
    );
    challenge.invite_code = newCode;
  }

  const leaderboardRows = db
    .prepare(
      `SELECT u.id AS user_id, u.name AS name, COALESCE(COUNT(e.id), 0) AS total
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
    userId: row.user_id,
    name: row.name,
    total: row.total,
    remaining: Math.max(challenge.goal_count - row.total, 0),
  }));


  res.render("challenge", {
    title: challenge.title,
    challenge,
    hasJoined,
    leaderboard,
    isOwner,
    today: getLocalDateString(),
    inviteLink: `${req.protocol}://${req.get("host")}/convite/${challenge.invite_code}`,
  });
});

app.post("/challenges/:id/adicionar", requireAuth, (req, res) => {
  const challengeId = Number(req.params.id);
  const email = (req.body.email || "").trim().toLowerCase();

  if (!email) {
    addFlash(req, "error", "Informe o email do usuario.");
    return res.redirect(`/challenges/${challengeId}`);
  }

  const challenge = db
    .prepare("SELECT id, creator_id FROM challenges WHERE id = ?")
    .get(challengeId);
  if (!challenge) {
    addFlash(req, "error", "Desafio não encontrado.");
    return res.redirect("/dashboard");
  }

  const challengeStatus = db
    .prepare("SELECT status FROM challenges WHERE id = ?")
    .get(challengeId);
  if (!challengeStatus || challengeStatus.status !== "active") {
    addFlash(req, "error", "Este desafio está encerrado.");
    return res.redirect(`/challenges/${challengeId}`);
  }

  const isParticipant = db
    .prepare(
      "SELECT id FROM challenge_participants WHERE user_id = ? AND challenge_id = ?"
    )
    .get(req.session.userId, challengeId);

  if (!isParticipant && challenge.creator_id !== req.session.userId) {
    addFlash(req, "error", "Você não pode adicionar usuários neste desafio.");
    return res.redirect("/dashboard");
  }

  const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!user) {
    addFlash(req, "error", "Usuário não encontrado.");
    return res.redirect(`/challenges/${challengeId}`);
  }

  if (user.id === challenge.creator_id) {
    const creatorParticipant = db
      .prepare(
        "SELECT id FROM challenge_participants WHERE user_id = ? AND challenge_id = ?"
      )
      .get(user.id, challengeId);
    if (!creatorParticipant) {
      db.prepare(
        `INSERT INTO challenge_participants (user_id, challenge_id, joined_at)
         VALUES (?, ?, ?)`
      ).run(user.id, challengeId, new Date().toISOString());
      addFlash(req, "success", "Criador adicionado como participante.");
      return res.redirect(`/challenges/${challengeId}`);
    }
    addFlash(req, "info", "Este usuário já participa do desafio.");
    return res.redirect(`/challenges/${challengeId}`);
  }

  const existing = db
    .prepare(
      "SELECT id FROM challenge_participants WHERE user_id = ? AND challenge_id = ?"
    )
    .get(user.id, challengeId);
  if (existing) {
    addFlash(req, "info", "Usuário já participa deste desafio.");
    return res.redirect(`/challenges/${challengeId}`);
  }

  db.prepare(
    `INSERT INTO challenge_participants (user_id, challenge_id, joined_at)
     VALUES (?, ?, ?)`
  ).run(user.id, challengeId, new Date().toISOString());

  addFlash(req, "success", "Usuário adicionado ao desafio.");
  return res.redirect(`/challenges/${challengeId}`);
});

app.get("/convite/:code", requireAuth, (req, res) => {
  const code = req.params.code;
  const challenge = db
    .prepare("SELECT * FROM challenges WHERE invite_code = ?")
    .get(code);
  if (!challenge) {
    addFlash(req, "error", "Convite invalido.");
    return res.redirect("/dashboard");
  }

  if (challenge.status !== "active") {
    addFlash(req, "error", "Este desafio está encerrado.");
    return res.redirect("/dashboard");
  }

  if (challenge.creator_id === req.session.userId) {
    return res.redirect(`/challenges/${challenge.id}`);
  }

  const existing = db
    .prepare(
      "SELECT id FROM challenge_participants WHERE user_id = ? AND challenge_id = ?"
    )
    .get(req.session.userId, challenge.id);
  if (!existing) {
    db.prepare(
      `INSERT INTO challenge_participants (user_id, challenge_id, joined_at)
       VALUES (?, ?, ?)`
    ).run(req.session.userId, challenge.id, new Date().toISOString());
  }

  addFlash(req, "success", "Você entrou no desafio!");
  return res.redirect(`/challenges/${challenge.id}`);
});

app.post("/challenges/:id/entrar", requireAuth, (req, res) => {
  const challengeId = Number(req.params.id);
  const challenge = db
    .prepare("SELECT status FROM challenges WHERE id = ?")
    .get(challengeId);
  if (!challenge || challenge.status !== "active") {
    addFlash(req, "error", "Este desafio está encerrado.");
    return res.redirect(`/challenges/${challengeId}`);
  }

  const existing = db
    .prepare(
      "SELECT id FROM challenge_participants WHERE user_id = ? AND challenge_id = ?"
    )
    .get(req.session.userId, challengeId);
  if (existing) {
    addFlash(req, "info", "Você já participa deste desafio.");
    return res.redirect(`/challenges/${challengeId}`);
  }

  db.prepare(
    `INSERT INTO challenge_participants (user_id, challenge_id, joined_at)
     VALUES (?, ?, ?)`
  ).run(req.session.userId, challengeId, new Date().toISOString());

  addFlash(req, "success", "Participação confirmada. Bora treinar!");
  return res.redirect(`/challenges/${challengeId}`);
});

app.post("/challenges/:id/log", requireAuth, (req, res) => {
  const challengeId = Number(req.params.id);
  const activity = (req.body.activity || "").trim();
  const loggedOn = req.body.logged_on || getLocalDateString();

  if (!activity) {
    addFlash(req, "error", "Informe o tipo de exercício.");
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

app.post("/challenges/:id/encerrar", requireAuth, (req, res) => {
  const challengeId = Number(req.params.id);
  const challenge = db
    .prepare("SELECT id, creator_id FROM challenges WHERE id = ?")
    .get(challengeId);
  if (!challenge) {
    addFlash(req, "error", "Desafio não encontrado.");
    return res.redirect("/dashboard");
  }
  if (challenge.creator_id !== req.session.userId) {
    addFlash(req, "error", "Você não pode encerrar este desafio.");
    return res.redirect(`/challenges/${challengeId}`);
  }
  db.prepare("UPDATE challenges SET status = 'closed' WHERE id = ?").run(
    challengeId
  );
  addFlash(req, "success", "Desafio encerrado.");
  return res.redirect("/perfil");
});

app.post("/challenges/:id/excluir", requireAuth, (req, res) => {
  const challengeId = Number(req.params.id);
  const challenge = db
    .prepare("SELECT id, creator_id FROM challenges WHERE id = ?")
    .get(challengeId);
  if (!challenge) {
    addFlash(req, "error", "Desafio não encontrado.");
    return res.redirect("/dashboard");
  }
  if (challenge.creator_id !== req.session.userId) {
    addFlash(req, "error", "Você não pode excluir este desafio.");
    return res.redirect(`/challenges/${challengeId}`);
  }

  const transaction = db.transaction((id) => {
    db.prepare("DELETE FROM exercise_logs WHERE challenge_id = ?").run(id);
    db.prepare("DELETE FROM challenge_participants WHERE challenge_id = ?").run(
      id
    );
    db.prepare("DELETE FROM challenges WHERE id = ?").run(id);
  });

  transaction(challengeId);
  addFlash(req, "success", "Desafio excluído.");
  return res.redirect("/dashboard");
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
