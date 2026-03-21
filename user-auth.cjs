/**
 * User Authentication & Freemium Routes
 * Adds /api/user/* endpoints backed by MySQL
 * Loaded by server.js after the main app is initialized
 */
const crypto = require("crypto");

// ─── Config ───
const DB_CONFIG = {
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "u551069421_textappeal",
  password: process.env.DB_PASS || "C4r4c4ll4TextAppeal",
  database: process.env.DB_NAME || "u551069421_textappeal",
  waitForConnections: true,
  connectionLimit: 10,
};

const FREE_REQUESTS_PER_MONTH = 30;
const MONTHLY_PRICE_CAD = 20;
const TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ─── Lightweight password hashing (no bcrypt dependency needed) ───
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return { salt, hash };
}

function verifyPassword(password, storedHash, storedSalt) {
  const { hash } = hashPassword(password, storedSalt);
  return hash === storedHash;
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

// ─── MySQL pool (lazy init) ───
let pool = null;

async function getPool() {
  if (pool) return pool;
  try {
    const mysql = require("mysql2/promise");
    pool = mysql.createPool(DB_CONFIG);
    // Test connection
    const conn = await pool.getConnection();
    conn.release();
    console.log("[user-auth] MySQL connected to", DB_CONFIG.host);
    return pool;
  } catch (err) {
    console.error("[user-auth] MySQL connection failed:", err.message);
    return null;
  }
}

// ─── Initialize tables ───
async function initTables() {
  const db = await getPool();
  if (!db) return false;
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS ta_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        display_name VARCHAR(255) DEFAULT '',
        password_hash VARCHAR(255) NOT NULL,
        password_salt VARCHAR(64) NOT NULL,
        plan ENUM('free','pro','admin_free') DEFAULT 'free',
        subscription_status VARCHAR(50) DEFAULT NULL,
        stripe_customer_id VARCHAR(255) DEFAULT NULL,
        stripe_subscription_id VARCHAR(255) DEFAULT NULL,
        requests_this_month INT DEFAULT 0,
        month_key VARCHAR(7) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS ta_sessions (
        token VARCHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log("[user-auth] Tables ready");
    return true;
  } catch (err) {
    console.error("[user-auth] Table creation error:", err.message);
    return false;
  }
}

// ─── Helper: get user by token ───
async function getUserByToken(token) {
  if (!token) return null;
  const db = await getPool();
  if (!db) return null;
  try {
    const [rows] = await db.execute(
      "SELECT u.* FROM ta_users u JOIN ta_sessions s ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?",
      [token, Date.now()]
    );
    if (rows.length === 0) return null;
    const user = rows[0];
    // Reset monthly counter if month changed
    const monthKey = new Date().toISOString().slice(0, 7);
    if (user.month_key !== monthKey) {
      await db.execute("UPDATE ta_users SET requests_this_month = 0, month_key = ? WHERE id = ?", [monthKey, user.id]);
      user.requests_this_month = 0;
      user.month_key = monthKey;
    }
    return user;
  } catch (err) {
    console.error("[user-auth] getUserByToken error:", err.message);
    return null;
  }
}

// ─── Sanitize user for frontend ───
function sanitizeUser(u) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    plan: u.plan,
    subscriptionStatus: u.subscription_status,
    requestsThisMonth: u.requests_this_month || 0,
    freeLimit: FREE_REQUESTS_PER_MONTH,
    createdAt: u.created_at,
  };
}

// ─── Register routes ───
function registerUserRoutes(app) {
  // Freemium config (public)
  app.get("/api/freemium-config", (req, res) => {
    res.json({
      freeRequestsPerMonth: FREE_REQUESTS_PER_MONTH,
      monthlyPriceCad: MONTHLY_PRICE_CAD,
    });
  });

  // Register
  app.post("/api/user/register", async (req, res) => {
    const { email, password, displayName } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const db = await getPool();
    if (!db) return res.status(500).json({ error: "Database unavailable" });
    try {
      // Check if exists
      const [existing] = await db.execute("SELECT id FROM ta_users WHERE email = ?", [email.toLowerCase().trim()]);
      if (existing.length > 0) return res.status(409).json({ error: "An account with this email already exists" });
      // Create user
      const { salt, hash } = hashPassword(password);
      const monthKey = new Date().toISOString().slice(0, 7);
      const [result] = await db.execute(
        "INSERT INTO ta_users (email, display_name, password_hash, password_salt, plan, requests_this_month, month_key) VALUES (?, ?, ?, ?, 'free', 0, ?)",
        [email.toLowerCase().trim(), displayName || "", hash, salt, monthKey]
      );
      // Create session
      const token = generateToken();
      await db.execute("INSERT INTO ta_sessions (token, user_id, expires_at) VALUES (?, ?, ?)", [token, result.insertId, Date.now() + TOKEN_EXPIRY_MS]);
      // Return
      const [users] = await db.execute("SELECT * FROM ta_users WHERE id = ?", [result.insertId]);
      res.json({ token, user: sanitizeUser(users[0]) });
    } catch (err) {
      console.error("[user-auth] Register error:", err.message);
      res.status(500).json({ error: "Registration failed" });
    }
  });

  // Login
  app.post("/api/user/login", async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    const db = await getPool();
    if (!db) return res.status(500).json({ error: "Database unavailable" });
    try {
      const [rows] = await db.execute("SELECT * FROM ta_users WHERE email = ?", [email.toLowerCase().trim()]);
      if (rows.length === 0) return res.status(401).json({ error: "Invalid email or password" });
      const user = rows[0];
      if (!verifyPassword(password, user.password_hash, user.password_salt)) {
        return res.status(401).json({ error: "Invalid email or password" });
      }
      // Create session
      const token = generateToken();
      await db.execute("INSERT INTO ta_sessions (token, user_id, expires_at) VALUES (?, ?, ?)", [token, user.id, Date.now() + TOKEN_EXPIRY_MS]);
      // Reset month if needed
      const monthKey = new Date().toISOString().slice(0, 7);
      if (user.month_key !== monthKey) {
        await db.execute("UPDATE ta_users SET requests_this_month = 0, month_key = ? WHERE id = ?", [monthKey, user.id]);
        user.requests_this_month = 0;
      }
      res.json({ token, user: sanitizeUser(user) });
    } catch (err) {
      console.error("[user-auth] Login error:", err.message);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // Get current user
  app.get("/api/user/me", async (req, res) => {
    const token = req.headers["x-user-token"];
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    res.json(sanitizeUser(user));
  });

  // Logout
  app.post("/api/user/logout", async (req, res) => {
    const token = req.headers["x-user-token"];
    if (token) {
      const db = await getPool();
      if (db) {
        try { await db.execute("DELETE FROM ta_sessions WHERE token = ?", [token]); } catch (e) {}
      }
    }
    res.json({ ok: true });
  });

  // Forgot password (stub - shows success message regardless)
  app.post("/api/user/forgot-password", async (req, res) => {
    // Always return success to avoid email enumeration
    res.json({ ok: true, message: "If that email exists, a reset link has been sent." });
  });

  // Subscribe (creates Stripe checkout or returns message)
  app.post("/api/user/subscribe", async (req, res) => {
    const token = req.headers["x-user-token"];
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    try {
      const stripe = require("stripe");
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) return res.status(503).json({ error: "Subscription service not configured" });
      const stripeClient = stripe(stripeKey);
      // Get or create Stripe customer
      let customerId = user.stripe_customer_id;
      if (!customerId) {
        const customer = await stripeClient.customers.create({ email: user.email });
        customerId = customer.id;
        const db = await getPool();
        await db.execute("UPDATE ta_users SET stripe_customer_id = ? WHERE id = ?", [customerId, user.id]);
      }
      // Create checkout session
      const priceId = process.env.STRIPE_PRICE_ID;
      if (!priceId) return res.status(503).json({ error: "Subscription price not configured" });
      const session = await stripeClient.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: (process.env.APP_URL || "https://textappeal.pro") + "?subscribed=1",
        cancel_url: (process.env.APP_URL || "https://textappeal.pro") + "?canceled=1",
      });
      res.json({ url: session.url });
    } catch (err) {
      console.error("[user-auth] Subscribe error:", err.message);
      res.status(500).json({ error: "Subscription service error" });
    }
  });

  // Cancel subscription
  app.post("/api/user/cancel-subscription", async (req, res) => {
    const token = req.headers["x-user-token"];
    const user = await getUserByToken(token);
    if (!user) return res.status(401).json({ error: "Not authenticated" });
    try {
      if (!user.stripe_subscription_id) return res.status(400).json({ error: "No active subscription" });
      const stripe = require("stripe");
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) return res.status(503).json({ error: "Subscription service not configured" });
      const stripeClient = stripe(stripeKey);
      await stripeClient.subscriptions.update(user.stripe_subscription_id, { cancel_at_period_end: true });
      const db = await getPool();
      await db.execute("UPDATE ta_users SET subscription_status = 'canceling' WHERE id = ?", [user.id]);
      res.json({ ok: true });
    } catch (err) {
      console.error("[user-auth] Cancel error:", err.message);
      res.status(500).json({ error: "Cancellation failed" });
    }
  });

  // ─── Middleware: increment request count on translate/rewrite ───
  app.use("/api/translate", async (req, res, next) => {
    if (req.method !== "POST") return next();
    const token = req.headers["x-user-token"];
    if (token) {
      const user = await getUserByToken(token);
      if (user) {
        const db = await getPool();
        if (db) {
          try { await db.execute("UPDATE ta_users SET requests_this_month = requests_this_month + 1 WHERE id = ?", [user.id]); } catch (e) {}
        }
      }
    }
    next();
  });

  app.use("/api/rewrite", async (req, res, next) => {
    if (req.method !== "POST") return next();
    const token = req.headers["x-user-token"];
    if (token) {
      const user = await getUserByToken(token);
      if (user) {
        const db = await getPool();
        if (db) {
          try { await db.execute("UPDATE ta_users SET requests_this_month = requests_this_month + 1 WHERE id = ?", [user.id]); } catch (e) {}
        }
      }
    }
    next();
  });

  // ─── Cleanup expired sessions periodically ───
  setInterval(async () => {
    const db = await getPool();
    if (db) {
      try { await db.execute("DELETE FROM ta_sessions WHERE expires_at < ?", [Date.now()]); } catch (e) {}
    }
  }, 60 * 60 * 1000); // every hour
}

module.exports = { registerUserRoutes, initTables };
