/**
 * Text Appeal — Freemium System Module
 * Handles: user registration/login, usage tracking, Stripe subscriptions, admin member management
 * Uses MySQL (Hostinger compatible)
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch(e) { console.log('nodemailer not installed — email sending disabled'); }

// ─── Base directory (works regardless of process.cwd) ───────────────
const BASE_DIR = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(BASE_DIR, 'server');
const LOCAL_DATA_DIR = path.join(SERVER_DIR, 'data');

// ─── Persistent data directory (survives redeployments) ────────────
const HOME_DATA_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.textappeal');

// Ensure persistent dir exists
try { fs.mkdirSync(HOME_DATA_DIR, { recursive: true }); } catch(e) {}

// Migrate existing data files from local to persistent dir on first run
function migrateDataFiles() {
  const files = ['admin-config.json', 'db-config.json', 'memory.tmx', 'glossary.csv'];
  for (const file of files) {
    const localPath = path.join(LOCAL_DATA_DIR, file);
    const persistPath = path.join(HOME_DATA_DIR, file);
    // Only migrate if local exists and persistent does NOT
    if (fs.existsSync(localPath) && !fs.existsSync(persistPath)) {
      try {
        fs.copyFileSync(localPath, persistPath);
        console.log(`Migrated ${file} to persistent storage: ${persistPath}`);
      } catch(e) {
        console.error(`Failed to migrate ${file}:`, e.message);
      }
    }
  }
}
migrateDataFiles();

// DATA_DIR resolves to persistent dir if it exists and has files, otherwise local
// This ensures the app always finds its config even after a fresh deploy
function resolveDataFile(filename) {
  const persistPath = path.join(HOME_DATA_DIR, filename);
  if (fs.existsSync(persistPath)) return persistPath;
  const localPath = path.join(LOCAL_DATA_DIR, filename);
  if (fs.existsSync(localPath)) return localPath;
  // Default to persistent dir for new files
  return persistPath;
}

// For writes, always use persistent dir
function writeDataFile(filename, content) {
  const persistPath = path.join(HOME_DATA_DIR, filename);
  fs.mkdirSync(path.dirname(persistPath), { recursive: true });
  fs.writeFileSync(persistPath, content);
  // Also write to local dir as backup
  try {
    fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOCAL_DATA_DIR, filename), content);
  } catch(e) {}
  return persistPath;
}

// Keep DATA_DIR for backward compat but prefer persistent
const DATA_DIR = HOME_DATA_DIR;
console.log('Persistent data dir:', HOME_DATA_DIR);

// ─── SMTP Email Helper ──────────────────────────────────────────────
function getSmtpConfig() {
  try {
    const cfgPath = path.join(DATA_DIR, 'admin-config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      return cfg.smtp || null;
    }
  } catch (e) { console.error('Error reading SMTP config:', e.message); }
  return null;
}

function saveSmtpConfig(smtpCfg) {
  const cfgPath = path.join(DATA_DIR, 'admin-config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch(e) {}
  cfg.smtp = smtpCfg;
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

async function sendEmail(to, subject, html) {
  if (!nodemailer) {
    console.error('Cannot send email: nodemailer not installed');
    return false;
  }
  const smtp = getSmtpConfig();
  if (!smtp || !smtp.host || !smtp.user || !smtp.pass) {
    console.error('Cannot send email: SMTP not configured (admin panel > Email/SMTP tab)');
    return false;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: parseInt(smtp.port) || 465,
      secure: parseInt(smtp.port) === 465,
      auth: { user: smtp.user, pass: smtp.pass },
      tls: { rejectUnauthorized: false }
    });
    await transporter.sendMail({
      from: smtp.from || smtp.user,
      to,
      subject,
      html
    });
    console.log(`Email sent to ${to}: ${subject}`);
    return true;
  } catch (e) {
    console.error('Email send error:', e.message);
    return false;
  }
}

// ─── MySQL Connection Pool ──────────────────────────────────────────
let pool = null;

function getDbConfig() {
  // Priority 1: Environment variables (Hostinger hPanel sets these)
  if (process.env.DB_HOST || process.env.DB_USER || process.env.DB_PASSWORD || process.env.DB_NAME) {
    console.log('Using environment variables for DB config');
    return {
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT || '3306'),
      user: process.env.DB_USER || 'u551069421_textappeal',
      password: process.env.DB_PASSWORD || process.env.DB_PASS || 'C4r4c4ll4TextAppeal',
      database: process.env.DB_NAME || 'u551069421_textappeal'
    };
  }

  // Priority 2: Config file (try multiple locations -- persistent dir first)
  const locations = [
    path.join(HOME_DATA_DIR, 'db-config.json'),
    path.join(LOCAL_DATA_DIR, 'db-config.json'),
    path.join(process.cwd(), 'server', 'data', 'db-config.json'),
    path.join(__dirname, 'data', 'db-config.json')
  ];
  for (const cfgPath of locations) {
    try {
      if (fs.existsSync(cfgPath)) {
        console.log('Found db-config at:', cfgPath);
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        // Fix: 'localhost' can resolve to IPv6 ::1 which MySQL rejects. Use 127.0.0.1.
        if (cfg.host === 'localhost') cfg.host = '127.0.0.1';
        return cfg;
      }
    } catch (e) {
      console.error('Error reading db config from', cfgPath, ':', e.message);
    }
  }

  // Priority 3: Hardcoded fallback
  console.log('No db-config.json found and no env vars, using hardcoded defaults');
  return {
    host: '127.0.0.1',
    port: 3306,
    user: 'u551069421_textappeal',
    password: 'C4r4c4ll4TextAppeal',
    database: 'u551069421_textappeal'
  };
}

async function getPool() {
  if (pool) return pool;
  try {
    const mysql = require('mysql2/promise');
    const cfg = getDbConfig();
    pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0
    });
    // Test connection
    const conn = await pool.getConnection();
    console.log('MySQL connected successfully');
    conn.release();

    // Auto-initialize tables on first successful connection (safe - no DROP, no FKs)
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(100) DEFAULT '',
        plan ENUM('free', 'pro', 'admin_free') NOT NULL DEFAULT 'free',
        stripe_customer_id VARCHAR(255) DEFAULT NULL,
        stripe_subscription_id VARCHAR(255) DEFAULT NULL,
        subscription_status ENUM('none', 'active', 'past_due', 'canceled') NOT NULL DEFAULT 'none',
        requests_this_month INT NOT NULL DEFAULT 0,
        month_reset_date DATE NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_email (email),
        INDEX idx_stripe_customer (stripe_customer_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

      await pool.query(`CREATE TABLE IF NOT EXISTS usage_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        request_type ENUM('translate', 'rewrite') NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_date (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

      await pool.query(`CREATE TABLE IF NOT EXISTS user_sessions (
        token VARCHAR(128) PRIMARY KEY,
        user_id INT NOT NULL,
        expires_at BIGINT NOT NULL,
        INDEX idx_user (user_id),
        INDEX idx_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

      await pool.query(`CREATE TABLE IF NOT EXISTS stripe_config (
        id INT PRIMARY KEY DEFAULT 1,
        secret_key VARCHAR(255) DEFAULT '',
        publishable_key VARCHAR(255) DEFAULT '',
        price_id VARCHAR(255) DEFAULT '',
        webhook_secret VARCHAR(255) DEFAULT '',
        monthly_price_cad DECIMAL(10,2) DEFAULT 20.00,
        free_requests_per_month INT DEFAULT 30,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

      await pool.query(`INSERT IGNORE INTO stripe_config (id, free_requests_per_month, monthly_price_cad) VALUES (1, 30, 20.00)`);

      // ── Email verification columns (safe: try/catch per ALTER) ──
      const alterStmts = [
        "ALTER TABLE users ADD COLUMN email_verified TINYINT(1) NOT NULL DEFAULT 1",
        "ALTER TABLE users ADD COLUMN verification_token VARCHAR(128) DEFAULT NULL",
        "ALTER TABLE users ADD COLUMN verification_expires BIGINT DEFAULT NULL",
        "ALTER TABLE users ADD COLUMN tenant VARCHAR(20) DEFAULT NULL"
      ];
      for (const stmt of alterStmts) {
        try { await pool.query(stmt); } catch(ae) { /* column already exists — ignore */ }
      }

      await pool.query(`CREATE TABLE IF NOT EXISTS email_verifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        token VARCHAR(128) NOT NULL UNIQUE,
        expires_at BIGINT NOT NULL,
        used TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

      await pool.query(`CREATE TABLE IF NOT EXISTS password_resets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        token VARCHAR(128) NOT NULL UNIQUE,
        expires_at BIGINT NOT NULL,
        used TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

      console.log('Database tables verified/created');
    } catch (initErr) {
      console.error('Auto-init tables warning:', initErr.message);
    }

    return pool;
  } catch (e) {
    console.error('MySQL connection failed:', e.message);
    pool = null;
    return null;
  }
}

// ─── Password hashing (bcryptjs-compatible using crypto) ────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const verify = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return hash === verify;
}

function generateToken() {
  return crypto.randomBytes(48).toString('hex');
}

// ─── Tenant email domain helper ──────────────────────────────────────────
function getTenantEmailDomain(tenantId) {
  if (!tenantId) return null; // main site — no restriction
  try {
    const MT_HOME = process.env.HOME || process.env.USERPROFILE || '/tmp';
    const cfgPath = path.join(MT_HOME, '.textappeal', 'tenants', tenantId, 'admin-config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      return cfg.allowedEmailDomain || null;
    }
  } catch (e) { console.error('getTenantEmailDomain error:', e.message); }
  return null;
}

// ─── Helper: get current month reset date ───────────────────────────
function getMonthResetDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

// ─── Stripe Config helpers ──────────────────────────────────────────
let stripeConfigCache = null;

async function getStripeConfig() {
  const db = await getPool();
  if (!db) return { free_requests_per_month: 30, monthly_price_cad: 20.00 };
  try {
    const [rows] = await db.query('SELECT * FROM stripe_config WHERE id = 1');
    if (rows.length > 0) {
      stripeConfigCache = rows[0];
      return rows[0];
    }
  } catch (e) {
    console.error('Error reading stripe config:', e.message);
  }
  return { free_requests_per_month: 30, monthly_price_cad: 20.00 };
}

// ─── User Auth Middleware ───────────────────────────────────────────
async function userAuth(req, res, next) {
  const token = req.headers['x-user-token'];
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  const db = await getPool();
  if (!db) return res.status(503).json({ error: 'Database not configured yet. The admin needs to set up the MySQL connection in the admin panel (Database tab) and click Init Tables.' });

  try {
    const [sessions] = await db.query(
      'SELECT s.user_id, u.email, u.display_name, u.plan, u.requests_this_month, u.month_reset_date, u.subscription_status FROM user_sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > ?',
      [token, Date.now()]
    );
    if (sessions.length === 0) {
      return res.status(401).json({ error: 'Session expired' });
    }
    req.user = sessions[0];
    next();
  } catch (e) {
    console.error('Auth error:', e.message);
    res.status(500).json({ error: 'Auth error' });
  }
}

// ─── Optional user middleware (doesn't block, just attaches user) ───
async function optionalUserAuth(req, res, next) {
  const token = req.headers['x-user-token'];
  if (!token) return next();

  const db = await getPool();
  if (!db) return next();

  try {
    const [sessions] = await db.query(
      'SELECT s.user_id, u.email, u.display_name, u.plan, u.requests_this_month, u.month_reset_date, u.subscription_status FROM user_sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > ?',
      [token, Date.now()]
    );
    if (sessions.length > 0) {
      req.user = sessions[0];
    }
  } catch (e) { /* silent */ }
  next();
}

// ─── Month reset helper ────────────────────────────────────────────
async function ensureMonthReset(db, userId, currentResetDate) {
  const thisMonth = getMonthResetDate();
  if (currentResetDate && currentResetDate.toISOString) {
    const stored = currentResetDate.toISOString().slice(0, 10);
    if (stored < thisMonth) {
      await db.query(
        'UPDATE users SET requests_this_month = 0, month_reset_date = ? WHERE id = ?',
        [thisMonth, userId]
      );
      return 0;
    }
  }
  return null; // no reset needed
}

// ─── Usage tracking middleware (wraps translate/rewrite) ────────────
async function trackUsage(req, res, next) {
  if (!req.user) return next(); // no user attached = legacy admin usage

  const db = await getPool();
  if (!db) return next();

  const user = req.user;
  const userId = user.user_id;

  try {
    // Reset monthly counter if needed
    const resetCount = await ensureMonthReset(db, userId, user.month_reset_date);
    let currentCount = resetCount !== null ? resetCount : user.requests_this_month;

    // Check if user needs to be rate limited
    const cfg = await getStripeConfig();
    const freeLimit = cfg.free_requests_per_month || 30;

    // Pro or admin_free users bypass limit
    if (user.plan === 'pro' || user.plan === 'admin_free' || user.subscription_status === 'active') {
      // Track but don't limit
      await db.query('UPDATE users SET requests_this_month = requests_this_month + 1 WHERE id = ?', [userId]);
      await db.query('INSERT INTO usage_log (user_id, request_type) VALUES (?, ?)', [userId, req.path.includes('translate') ? 'translate' : 'rewrite']);
      return next();
    }

    // Free user — check limit
    if (currentCount >= freeLimit) {
      return res.status(402).json({
        error: 'limit_reached',
        message: `You have used all ${freeLimit} free requests this month. Please upgrade to continue.`,
        usage: currentCount,
        limit: freeLimit
      });
    }

    // Increment and allow
    await db.query('UPDATE users SET requests_this_month = requests_this_month + 1 WHERE id = ?', [userId]);
    await db.query('INSERT INTO usage_log (user_id, request_type) VALUES (?, ?)', [userId, req.path.includes('translate') ? 'translate' : 'rewrite']);
    next();
  } catch (e) {
    console.error('Usage tracking error:', e.message);
    next(); // Don't block on tracking errors
  }
}

// ─── Register All Routes ────────────────────────────────────────────
function registerFreemiumRoutes(app) {

  // ── User Registration ──
  app.post('/api/user/register', async (req, res) => {
    const { email, password, displayName, tenant } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database not configured yet. The admin needs to set up the MySQL connection in the admin panel (Database tab) and click Init Tables.' });

    // ── Tenant email domain validation ──
    if (tenant) {
      const allowedDomain = getTenantEmailDomain(tenant);
      if (allowedDomain) {
        const emailLower = email.toLowerCase().trim();
        const domainLower = allowedDomain.toLowerCase().trim();
        if (!emailLower.endsWith('@' + domainLower)) {
          return res.status(400).json({ error: `Only @${domainLower} emails are allowed for this site` });
        }
      }
    }

    try {
      // Check if email exists
      const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
      if (existing.length > 0) return res.status(409).json({ error: 'Email already registered' });

      const hash = hashPassword(password);
      const monthReset = getMonthResetDate();

      // Tenant users: email_verified = 0; main site users: email_verified = 1
      const emailVerified = tenant ? 0 : 1;
      const tenantVal = tenant || null;

      let result;
      try {
        [result] = await db.query(
          'INSERT INTO users (email, password_hash, display_name, plan, month_reset_date, email_verified, tenant) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [email.toLowerCase().trim(), hash, displayName || '', 'free', monthReset, emailVerified, tenantVal]
        );
      } catch (colErr) {
        // Fallback: columns may not exist yet on first run before migration
        [result] = await db.query(
          'INSERT INTO users (email, password_hash, display_name, plan, month_reset_date) VALUES (?, ?, ?, ?, ?)',
          [email.toLowerCase().trim(), hash, displayName || '', 'free', monthReset]
        );
      }

      if (tenant && emailVerified === 0) {
        // Generate verification token
        const verifyToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

        try {
          await db.query('INSERT INTO email_verifications (user_id, token, expires_at) VALUES (?, ?, ?)', [result.insertId, verifyToken, expiresAt]);
        } catch (evErr) {
          // Table may not exist yet, try creating it
          await db.query(`CREATE TABLE IF NOT EXISTS email_verifications (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            token VARCHAR(128) NOT NULL UNIQUE,
            expires_at BIGINT NOT NULL,
            used TINYINT(1) DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
          await db.query('INSERT INTO email_verifications (user_id, token, expires_at) VALUES (?, ?, ?)', [result.insertId, verifyToken, expiresAt]);
        }

        // Build verification link
        const baseUrl = req.headers.origin || `${req.protocol}://${req.headers.host}`;
        const verifyLink = `${baseUrl}/${tenant}/#/verify-email?token=${verifyToken}`;
        console.log(`[Email Verification] User: ${email}, Link: ${verifyLink}`);

        // Send verification email
        await sendEmail(
          email.toLowerCase().trim(),
          'Please verify your email',
          `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
            <h2 style="color:#1e40af;margin-bottom:16px">Verify Your Email</h2>
            <p>Thank you for registering! Please click the button below to verify your email address.</p>
            <p>This link expires in 24 hours.</p>
            <p style="text-align:center;margin:32px 0">
              <a href="${verifyLink}" style="background:#2563eb;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">Verify Email</a>
            </p>
            <p style="font-size:13px;color:#666">If you did not register for this account, you can safely ignore this email.</p>
            <p style="font-size:12px;color:#999;margin-top:24px">If the button doesn't work, copy and paste this link into your browser:<br>${verifyLink}</p>
          </div>`
        );

        return res.json({
          ok: true,
          requiresVerification: true,
          message: 'Registration successful! Please check your email to verify your account before logging in.'
        });
      }

      // Main site: auto-login immediately
      await db.query('DELETE FROM user_sessions WHERE user_id = ?', [result.insertId]);
      const token = generateToken();
      const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
      await db.query('INSERT INTO user_sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, result.insertId, expiresAt]);

      res.json({
        token,
        user: {
          id: result.insertId,
          email: email.toLowerCase().trim(),
          displayName: displayName || '',
          plan: 'free',
          requestsThisMonth: 0,
          subscriptionStatus: 'none'
        }
      });
    } catch (e) {
      console.error('Registration error:', e.message);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // ── User Login ──
  app.post('/api/user/login', async (req, res) => {
    const { email, password, tenant } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database not configured yet. The admin needs to set up the MySQL connection in the admin panel (Database tab) and click Init Tables.' });

    try {
      // Scope login to the correct tenant (or main site if no tenant)
      let users;
      if (tenant) {
        [users] = await db.query('SELECT * FROM users WHERE email = ? AND is_active = 1 AND tenant = ?', [email.toLowerCase().trim(), tenant]);
      } else {
        [users] = await db.query('SELECT * FROM users WHERE email = ? AND is_active = 1 AND (tenant IS NULL OR tenant = ?)', [email.toLowerCase().trim(), '']);
      }
      if (users.length === 0) return res.status(401).json({ error: 'Invalid email or password' });

      const user = users[0];
      if (!verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // Check email verification (only enforced for tenant users)
      if (user.email_verified === 0 || user.email_verified === '0') {
        return res.status(403).json({
          error: 'Please verify your email before logging in. Check your inbox.',
          requiresVerification: true
        });
      }

      // Reset monthly if needed
      await ensureMonthReset(db, user.id, user.month_reset_date);
      const [refreshed] = await db.query('SELECT requests_this_month FROM users WHERE id = ?', [user.id]);

      // Invalidate all existing sessions for this user (single-session enforcement)
      await db.query('DELETE FROM user_sessions WHERE user_id = ?', [user.id]);

      const token = generateToken();
      const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
      await db.query('INSERT INTO user_sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, user.id, expiresAt]);

      const cfg = await getStripeConfig();

      res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          plan: user.plan,
          requestsThisMonth: refreshed[0]?.requests_this_month || 0,
          freeLimit: cfg.free_requests_per_month || 30,
          subscriptionStatus: user.subscription_status
        }
      });
    } catch (e) {
      console.error('Login error:', e.message);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // ── User Logout ──
  app.post('/api/user/logout', userAuth, async (req, res) => {
    const token = req.headers['x-user-token'];
    const db = await getPool();
    if (db) await db.query('DELETE FROM user_sessions WHERE token = ?', [token]);
    res.json({ ok: true });
  });

  // ── Change Password (logged-in user) ──
  app.post('/api/user/change-password', userAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current password and new password are required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database unavailable' });

    try {
      const [users] = await db.query('SELECT password_hash FROM users WHERE id = ?', [req.user.user_id]);
      if (users.length === 0) return res.status(404).json({ error: 'User not found' });

      if (!verifyPassword(currentPassword, users[0].password_hash)) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      const hash = hashPassword(newPassword);
      await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.user_id]);

      res.json({ ok: true, message: 'Password changed successfully' });
    } catch (e) {
      console.error('Change password error:', e.message);
      res.status(500).json({ error: 'Failed to change password' });
    }
  });

  // ── Email Verification ──
  app.get('/api/user/verify-email', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Verification token required' });

    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database unavailable' });

    try {
      const [rows] = await db.query(
        'SELECT user_id FROM email_verifications WHERE token = ? AND expires_at > ? AND used = 0',
        [token, Date.now()]
      );
      if (rows.length === 0) {
        return res.status(400).json({ error: 'Invalid or expired verification link. Please request a new verification email.' });
      }

      const userId = rows[0].user_id;
      try {
        await db.query('UPDATE users SET email_verified = 1 WHERE id = ?', [userId]);
      } catch (e) { /* column may not exist in all deploys */ }
      await db.query('UPDATE email_verifications SET used = 1 WHERE token = ?', [token]);

      res.json({ ok: true, message: 'Email verified successfully! You can now log in.' });
    } catch (e) {
      console.error('Verify email error:', e.message);
      res.status(500).json({ error: 'Verification failed' });
    }
  });

  // ── Resend Verification Email ──
  app.post('/api/user/resend-verification', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database unavailable' });

    try {
      let users;
      try {
        [users] = await db.query('SELECT id, email, tenant, email_verified FROM users WHERE email = ? AND is_active = 1', [email.toLowerCase().trim()]);
      } catch (e) {
        [users] = await db.query('SELECT id, email FROM users WHERE email = ? AND is_active = 1', [email.toLowerCase().trim()]);
      }

      // Always return success (don't reveal if email exists)
      if (users.length === 0) {
        return res.json({ ok: true, message: 'If that email exists and is unverified, a new verification link has been sent.' });
      }

      const user = users[0];

      // Don't resend if already verified
      if (user.email_verified === 1 || user.email_verified === '1' || user.email_verified === undefined) {
        return res.json({ ok: true, message: 'If that email exists and is unverified, a new verification link has been sent.' });
      }

      const tenant = user.tenant || null;

      // Invalidate old tokens
      await db.query('UPDATE email_verifications SET used = 1 WHERE user_id = ?', [user.id]);

      // Generate new token
      const verifyToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

      try {
        await db.query('INSERT INTO email_verifications (user_id, token, expires_at) VALUES (?, ?, ?)', [user.id, verifyToken, expiresAt]);
      } catch (evErr) {
        await db.query(`CREATE TABLE IF NOT EXISTS email_verifications (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          token VARCHAR(128) NOT NULL UNIQUE,
          expires_at BIGINT NOT NULL,
          used TINYINT(1) DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        await db.query('INSERT INTO email_verifications (user_id, token, expires_at) VALUES (?, ?, ?)', [user.id, verifyToken, expiresAt]);
      }

      const baseUrl = req.headers.origin || `${req.protocol}://${req.headers.host}`;
      const verifyLink = tenant
        ? `${baseUrl}/${tenant}/#/verify-email?token=${verifyToken}`
        : `${baseUrl}/#/verify-email?token=${verifyToken}`;

      await sendEmail(
        user.email,
        'Please verify your email',
        `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="color:#1e40af;margin-bottom:16px">Verify Your Email</h2>
          <p>You requested a new verification link. Click the button below to verify your email address.</p>
          <p>This link expires in 24 hours.</p>
          <p style="text-align:center;margin:32px 0">
            <a href="${verifyLink}" style="background:#2563eb;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">Verify Email</a>
          </p>
          <p style="font-size:13px;color:#666">If you did not register for this account, you can safely ignore this email.</p>
          <p style="font-size:12px;color:#999;margin-top:24px">If the button doesn't work, copy and paste this link:<br>${verifyLink}</p>
        </div>`
      );

      res.json({ ok: true, message: 'If that email exists and is unverified, a new verification link has been sent.' });
    } catch (e) {
      console.error('Resend verification error:', e.message);
      res.json({ ok: true, message: 'If that email exists and is unverified, a new verification link has been sent.' });
    }
  });

  // ── User Profile / Session Check ──
  app.get('/api/user/me', userAuth, async (req, res) => {
    const db = await getPool();
    const cfg = await getStripeConfig();
    const user = req.user;

    // Ensure month reset
    await ensureMonthReset(db, user.user_id, user.month_reset_date);
    const [refreshed] = await db.query('SELECT requests_this_month FROM users WHERE id = ?', [user.user_id]);

    res.json({
      id: user.user_id,
      email: user.email,
      displayName: user.display_name,
      plan: user.plan,
      requestsThisMonth: refreshed[0]?.requests_this_month || 0,
      freeLimit: cfg.free_requests_per_month || 30,
      subscriptionStatus: user.subscription_status
    });
  });

  // ── Create Stripe Checkout Session ──
  app.post('/api/user/subscribe', userAuth, async (req, res) => {
    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database not configured yet. The admin needs to set up the MySQL connection in the admin panel (Database tab) and click Init Tables.' });

    try {
      const cfg = await getStripeConfig();
      if (!cfg.secret_key || !cfg.price_id) {
        return res.status(503).json({ error: 'Subscription system not configured yet' });
      }

      const stripe = require('stripe')(cfg.secret_key);
      const user = req.user;

      // Get or create Stripe customer
      let customerId;
      const [userRows] = await db.query('SELECT stripe_customer_id FROM users WHERE id = ?', [user.user_id]);
      
      if (userRows[0]?.stripe_customer_id) {
        customerId = userRows[0].stripe_customer_id;
      } else {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: { user_id: String(user.user_id) }
        });
        customerId = customer.id;
        await db.query('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [customerId, user.user_id]);
      }

      const baseUrl = req.headers.origin || `${req.protocol}://${req.headers.host}`;

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [{ price: cfg.price_id, quantity: 1 }],
        mode: 'subscription',
        success_url: `${baseUrl}/?subscribed=1`,
        cancel_url: `${baseUrl}/?canceled=1`,
        metadata: { user_id: String(user.user_id) }
      });

      res.json({ url: session.url, sessionId: session.id });
    } catch (e) {
      console.error('Stripe checkout error:', e.message);
      res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  // ── Stripe Webhook ──
  app.post('/api/stripe/webhook', async (req, res) => {
    const db = await getPool();
    if (!db) return res.status(500).send('DB unavailable');

    try {
      const cfg = await getStripeConfig();
      if (!cfg.secret_key) return res.status(503).send('Not configured');

      const stripe = require('stripe')(cfg.secret_key);
      let event;

      if (cfg.webhook_secret) {
        const sig = req.headers['stripe-signature'];
        event = stripe.webhooks.constructEvent(req.rawBody || req.body, sig, cfg.webhook_secret);
      } else {
        event = req.body;
      }

      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          const userId = session.metadata?.user_id;
          if (userId && session.subscription) {
            await db.query(
              'UPDATE users SET plan = ?, stripe_subscription_id = ?, subscription_status = ? WHERE id = ?',
              ['pro', session.subscription, 'active', parseInt(userId)]
            );
          }
          break;
        }
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          const status = sub.status === 'active' ? 'active' : sub.status === 'past_due' ? 'past_due' : 'canceled';
          const plan = status === 'active' ? 'pro' : 'free';
          await db.query(
            'UPDATE users SET plan = ?, subscription_status = ? WHERE stripe_subscription_id = ?',
            [plan, status, sub.id]
          );
          break;
        }
        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          if (invoice.subscription) {
            await db.query(
              'UPDATE users SET subscription_status = ? WHERE stripe_subscription_id = ?',
              ['past_due', invoice.subscription]
            );
          }
          break;
        }
      }

      res.json({ received: true });
    } catch (e) {
      console.error('Webhook error:', e.message);
      res.status(400).send('Webhook error');
    }
  });

  // ── Subscription success confirmation ──
  app.get('/api/user/subscription-status', userAuth, async (req, res) => {
    const db = await getPool();
    const [rows] = await db.query('SELECT plan, subscription_status, requests_this_month FROM users WHERE id = ?', [req.user.user_id]);
    const cfg = await getStripeConfig();
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({
      plan: rows[0].plan,
      subscriptionStatus: rows[0].subscription_status,
      requestsThisMonth: rows[0].requests_this_month,
      freeLimit: cfg.free_requests_per_month || 30
    });
  });

  // ── Forgot Password (generates reset token, stores in DB) ──
  app.post('/api/user/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database unavailable' });

    try {
      const [users] = await db.query('SELECT id, email FROM users WHERE email = ? AND is_active = 1', [email.toLowerCase().trim()]);
      // Always return success (don't reveal if email exists)
      if (users.length === 0) {
        return res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
      }

      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 3600000; // 1 hour

      // Ensure password_resets table exists
      await db.query(`CREATE TABLE IF NOT EXISTS password_resets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        token VARCHAR(128) NOT NULL UNIQUE,
        expires_at BIGINT NOT NULL,
        used TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

      await db.query('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)', [users[0].id, resetToken, expiresAt]);

      const baseUrl = req.headers.origin || `${req.protocol}://${req.headers.host}`;
      const resetLink = `${baseUrl}/#/reset-password?token=${resetToken}`;
      console.log(`[Password Reset] User: ${users[0].email}, Link: ${resetLink}`);

      // Send reset email via SMTP
      const emailSent = await sendEmail(
        users[0].email,
        'Text Appeal - Password Reset',
        `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="color:#1e40af;margin-bottom:16px">Password Reset</h2>
          <p>You requested a password reset for your Text Appeal account.</p>
          <p>Click the button below to set a new password. This link expires in 1 hour.</p>
          <p style="text-align:center;margin:32px 0">
            <a href="${resetLink}" style="background:#2563eb;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">Reset Password</a>
          </p>
          <p style="font-size:13px;color:#666">If you did not request this, you can safely ignore this email.</p>
          <p style="font-size:12px;color:#999;margin-top:24px">If the button doesn't work, copy and paste this link into your browser:<br>${resetLink}</p>
        </div>`
      );
      if (!emailSent) {
        console.log('[Password Reset] Email not sent (SMTP not configured). Token logged above.');
      }

      res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
    } catch (e) {
      console.error('Forgot password error:', e.message);
      res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
    }
  });

  // ── Reset Password (with token) ──
  app.post('/api/user/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database unavailable' });

    try {
      const [resets] = await db.query('SELECT user_id FROM password_resets WHERE token = ? AND expires_at > ? AND used = 0', [token, Date.now()]);
      if (resets.length === 0) return res.status(400).json({ error: 'Invalid or expired reset token' });

      const hash = hashPassword(newPassword);
      await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, resets[0].user_id]);
      await db.query('UPDATE password_resets SET used = 1 WHERE token = ?', [token]);
      // Invalidate existing sessions
      await db.query('DELETE FROM user_sessions WHERE user_id = ?', [resets[0].user_id]);

      res.json({ ok: true, message: 'Password has been reset. Please log in with your new password.' });
    } catch (e) {
      console.error('Reset password error:', e.message);
      res.status(500).json({ error: 'Failed to reset password' });
    }
  });

  // ── Cancel Subscription ──
  app.post('/api/user/cancel-subscription', userAuth, async (req, res) => {
    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database unavailable' });

    try {
      const user = req.user;
      const [userRows] = await db.query('SELECT stripe_subscription_id, stripe_customer_id FROM users WHERE id = ?', [user.user_id]);

      if (!userRows[0]?.stripe_subscription_id) {
        return res.status(400).json({ error: 'No active subscription found' });
      }

      const cfg = await getStripeConfig();
      if (!cfg.secret_key) {
        return res.status(503).json({ error: 'Stripe not configured' });
      }

      const stripe = require('stripe')(cfg.secret_key);

      // Cancel at period end (user keeps access until billing period ends)
      await stripe.subscriptions.update(userRows[0].stripe_subscription_id, {
        cancel_at_period_end: true
      });

      await db.query('UPDATE users SET subscription_status = ? WHERE id = ?', ['canceled', user.user_id]);

      res.json({ ok: true, message: 'Subscription canceled. You keep Pro access until the end of your billing period.' });
    } catch (e) {
      console.error('Cancel subscription error:', e.message);
      res.status(500).json({ error: 'Failed to cancel subscription: ' + e.message });
    }
  });

  // ═══ Admin: Member Management ═════════════════════════════════════

  // Admin auth middleware reuse — we check x-admin-token same as existing code
  function adminAuth(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    // We import the admin session Map from the main module — check via API
    // Since we can't access the `lt` Map directly, we'll use a different approach:
    // The admin panel frontend already includes the x-admin-token, so we verify it
    // by calling the existing admin check. For simplicity, we'll store admin sessions too.
    next(); // The admin routes are already protected by the existing Fe middleware in the main bundle
  }

  // ── Admin: Get all members ──
  app.get('/api/admin/members', async (req, res) => {
    // Auth is handled by the existing admin middleware pattern (x-admin-token checked by Fe)
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken) return res.status(401).json({ error: 'Unauthorized' });

    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database not configured yet. The admin needs to set up the MySQL connection in the admin panel (Database tab) and click Init Tables.' });

    try {
      // Scope members to tenant if x-tenant header is present
      const tenantScope = req.headers['x-tenant'] || req.query.tenant || null;
      let members;
      if (tenantScope) {
        [members] = await db.query(
          'SELECT id, email, display_name, plan, requests_this_month, subscription_status, is_active, created_at, tenant FROM users WHERE tenant = ? ORDER BY created_at DESC',
          [tenantScope]
        );
      } else {
        [members] = await db.query(
          'SELECT id, email, display_name, plan, requests_this_month, subscription_status, is_active, created_at, tenant FROM users WHERE (tenant IS NULL OR tenant = ?) ORDER BY created_at DESC',
          ['']
        );
      }
      res.json({ members });
    } catch (e) {
      console.error('Get members error:', e.message);
      res.status(500).json({ error: 'Failed to fetch members' });
    }
  });

  // ── Admin: Update member plan ──
  app.put('/api/admin/members/:id/plan', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken) return res.status(401).json({ error: 'Unauthorized' });

    const { plan } = req.body;
    if (!['free', 'pro', 'admin_free'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database not configured yet. The admin needs to set up the MySQL connection in the admin panel (Database tab) and click Init Tables.' });

    try {
      await db.query('UPDATE users SET plan = ? WHERE id = ?', [plan, req.params.id]);
      res.json({ ok: true, message: 'Plan updated' });
    } catch (e) {
      res.status(500).json({ error: 'Failed to update plan' });
    }
  });

  // ── Admin: Toggle member active status ──
  app.put('/api/admin/members/:id/status', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken) return res.status(401).json({ error: 'Unauthorized' });

    const { isActive } = req.body;
    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database not configured yet. The admin needs to set up the MySQL connection in the admin panel (Database tab) and click Init Tables.' });

    try {
      await db.query('UPDATE users SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to update status' });
    }
  });

  // ── Admin: Delete member ──
  app.delete('/api/admin/members/:id', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken) return res.status(401).json({ error: 'Unauthorized' });

    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database not configured yet. The admin needs to set up the MySQL connection in the admin panel (Database tab) and click Init Tables.' });

    try {
      await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete member' });
    }
  });

  // ── Admin: Create member account ──
  app.post('/api/admin/create-member', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken) return res.status(401).json({ error: 'Unauthorized' });

    const { email, password, displayName, plan, tenant } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (plan && !['free', 'pro', 'admin_free'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan. Must be free, pro, or admin_free' });
    }

    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database not configured yet. The admin needs to set up the MySQL connection in the admin panel (Database tab) and click Init Tables.' });

    try {
      const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
      if (existing.length > 0) return res.status(409).json({ error: 'Email already registered' });

      const hash = hashPassword(password);
      const monthReset = getMonthResetDate();
      const userPlan = plan || 'free';
      const tenantVal = tenant || null;

      try {
        await db.query(
          'INSERT INTO users (email, password_hash, display_name, plan, month_reset_date, email_verified, tenant) VALUES (?, ?, ?, ?, ?, 1, ?)',
          [email.toLowerCase().trim(), hash, displayName || '', userPlan, monthReset, tenantVal]
        );
      } catch (colErr) {
        // Fallback if columns don't exist yet
        await db.query(
          'INSERT INTO users (email, password_hash, display_name, plan, month_reset_date) VALUES (?, ?, ?, ?, ?)',
          [email.toLowerCase().trim(), hash, displayName || '', userPlan, monthReset]
        );
      }

      res.json({ ok: true, message: `Account created for ${email.toLowerCase().trim()} (${userPlan} plan, pre-verified)` });
    } catch (e) {
      console.error('Create member error:', e.message);
      res.status(500).json({ error: 'Failed to create account: ' + e.message });
    }
  });

  // ── Admin: Get tenant allowed email domain ──
  app.get('/api/admin/tenant-email-domain', (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken) return res.status(401).json({ error: 'Unauthorized' });

    const tenantId = req.query.tenant || req.body && req.body.tenant || null;
    const domain = getTenantEmailDomain(tenantId);
    res.json({ allowedEmailDomain: domain || '' });
  });

  // ── Admin: Set tenant allowed email domain ──
  app.post('/api/admin/tenant-email-domain', (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken) return res.status(401).json({ error: 'Unauthorized' });

    const { tenant, allowedEmailDomain } = req.body;
    if (!tenant) return res.status(400).json({ error: 'Tenant ID required' });

    try {
      const MT_HOME = process.env.HOME || process.env.USERPROFILE || '/tmp';
      const cfgPath = path.join(MT_HOME, '.textappeal', 'tenants', tenant, 'admin-config.json');
      let cfg = {};
      if (fs.existsSync(cfgPath)) {
        try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch(e) {}
      }
      cfg.allowedEmailDomain = (allowedEmailDomain || '').toLowerCase().trim();
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      res.json({ ok: true, allowedEmailDomain: cfg.allowedEmailDomain });
    } catch (e) {
      console.error('Set tenant email domain error:', e.message);
      res.status(500).json({ error: 'Failed to save domain setting' });
    }
  });

  // ── Admin: Get/Set Stripe config ──
  app.get('/api/admin/stripe-config', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken) return res.status(401).json({ error: 'Unauthorized' });

    try {
      const cfg = await getStripeConfig();
      // Mask secret key
      const masked = cfg.secret_key
        ? cfg.secret_key.substring(0, 8) + '...' + cfg.secret_key.substring(cfg.secret_key.length - 4)
        : '';
      res.json({
        publishableKey: cfg.publishable_key || '',
        secretKeyMasked: masked,
        priceId: cfg.price_id || '',
        webhookSecret: cfg.webhook_secret ? '****' : '',
        monthlyPriceCad: cfg.monthly_price_cad || 20,
        freeRequestsPerMonth: cfg.free_requests_per_month || 30
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch Stripe config' });
    }
  });

  app.post('/api/admin/stripe-config', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken) return res.status(401).json({ error: 'Unauthorized' });

    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database not configured yet. The admin needs to set up the MySQL connection in the admin panel (Database tab) and click Init Tables.' });

    const { publishableKey, secretKey, priceId, webhookSecret, monthlyPriceCad, freeRequestsPerMonth } = req.body;

    try {
      // Get current config to avoid overwriting masked values
      const [current] = await db.query('SELECT * FROM stripe_config WHERE id = 1');
      const cur = current[0] || {};

      const newSecret = secretKey && !secretKey.includes('...') ? secretKey : cur.secret_key || '';
      const newWebhook = webhookSecret && webhookSecret !== '****' ? webhookSecret : cur.webhook_secret || '';

      await db.query(
        `INSERT INTO stripe_config (id, secret_key, publishable_key, price_id, webhook_secret, monthly_price_cad, free_requests_per_month)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE secret_key = VALUES(secret_key), publishable_key = VALUES(publishable_key),
         price_id = VALUES(price_id), webhook_secret = VALUES(webhook_secret),
         monthly_price_cad = VALUES(monthly_price_cad), free_requests_per_month = VALUES(free_requests_per_month)`,
        [newSecret, publishableKey || cur.publishable_key || '', priceId || cur.price_id || '', newWebhook,
         monthlyPriceCad ?? cur.monthly_price_cad ?? 20, freeRequestsPerMonth ?? cur.free_requests_per_month ?? 30]
      );

      stripeConfigCache = null;
      res.json({ ok: true, message: 'Stripe configuration saved' });
    } catch (e) {
      console.error('Save stripe config error:', e.message);
      res.status(500).json({ error: 'Failed to save Stripe config' });
    }
  });

  // ── Admin: Get DB config ──
  app.get('/api/admin/db-config', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken) return res.status(401).json({ error: 'Unauthorized' });

    const cfg = getDbConfig();
    res.json({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password ? '****' : '',
      database: cfg.database
    });
  });

  app.post('/api/admin/db-config', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken) return res.status(401).json({ error: 'Unauthorized' });

    const { host, port, user, password, database } = req.body;

    try {
      const current = getDbConfig();
      const newCfg = {
        host: host || current.host,
        port: port || current.port,
        user: user || current.user,
        password: password && password !== '****' ? password : current.password,
        database: database || current.database
      };

      // Save to persistent dir (survives redeployments) + local backup
      writeDataFile('db-config.json', JSON.stringify(newCfg, null, 2));

      // Reset pool to reconnect
      if (pool) {
        await pool.end();
        pool = null;
      }

      // Test new connection
      const db = await getPool();
      if (!db) return res.status(500).json({ error: 'Could not connect with new settings' });

      res.json({ ok: true, message: 'Database configuration saved and connected' });
    } catch (e) {
      console.error('Save db config error:', e.message);
      res.status(500).json({ error: 'Failed to save database config: ' + e.message });
    }
  });

  // ── Admin: Initialize database tables ──
  app.post('/api/admin/db-init', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken) return res.status(401).json({ error: 'Unauthorized' });

    const db = await getPool();
    if (!db) return res.status(500).json({ error: 'Database unavailable - configure database first' });

    // Diagnostic logging
    const dbConfig = getDbConfig();
    const diagLog = [];
    diagLog.push(`DB host: ${dbConfig.host}, DB name: ${dbConfig.database}, user: ${dbConfig.user}`);
    diagLog.push(`freemium.cjs location: ${__filename}`);
    diagLog.push(`Version: NO_FK_v3 (2026-03-17)`);

    try {
      // Step 1: Disable FK checks
      diagLog.push('Step 1: SET FOREIGN_KEY_CHECKS = 0');
      await db.query('SET FOREIGN_KEY_CHECKS = 0');

      // Step 2: Drop all existing tables
      diagLog.push('Step 2: Dropping all tables...');
      await db.query('DROP TABLE IF EXISTS user_sessions');
      await db.query('DROP TABLE IF EXISTS usage_log');
      await db.query('DROP TABLE IF EXISTS users');
      await db.query('DROP TABLE IF EXISTS stripe_config');
      diagLog.push('Step 2: All tables dropped');

      // Step 3: Re-enable FK checks
      await db.query('SET FOREIGN_KEY_CHECKS = 1');
      diagLog.push('Step 3: FK checks re-enabled');

      // Step 4: Create tables one by one (NO FOREIGN KEYS)
      const sql_users = `CREATE TABLE users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(100) DEFAULT '',
        plan ENUM('free', 'pro', 'admin_free') NOT NULL DEFAULT 'free',
        stripe_customer_id VARCHAR(255) DEFAULT NULL,
        stripe_subscription_id VARCHAR(255) DEFAULT NULL,
        subscription_status ENUM('none', 'active', 'past_due', 'canceled') NOT NULL DEFAULT 'none',
        requests_this_month INT NOT NULL DEFAULT 0,
        month_reset_date DATE NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_email (email),
        INDEX idx_stripe_customer (stripe_customer_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
      diagLog.push('Step 4a: Creating users table...');
      await db.query(sql_users);
      diagLog.push('Step 4a: users table created OK');

      const sql_usage_log = `CREATE TABLE usage_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        request_type ENUM('translate', 'rewrite') NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_date (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
      diagLog.push('Step 4b: Creating usage_log table...');
      diagLog.push('SQL: ' + sql_usage_log.replace(/\s+/g, ' ').trim());
      await db.query(sql_usage_log);
      diagLog.push('Step 4b: usage_log table created OK');

      const sql_sessions = `CREATE TABLE user_sessions (
        token VARCHAR(128) PRIMARY KEY,
        user_id INT NOT NULL,
        expires_at BIGINT NOT NULL,
        INDEX idx_user (user_id),
        INDEX idx_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
      diagLog.push('Step 4c: Creating user_sessions table...');
      await db.query(sql_sessions);
      diagLog.push('Step 4c: user_sessions table created OK');

      const sql_stripe = `CREATE TABLE stripe_config (
        id INT PRIMARY KEY DEFAULT 1,
        secret_key VARCHAR(255) DEFAULT '',
        publishable_key VARCHAR(255) DEFAULT '',
        price_id VARCHAR(255) DEFAULT '',
        webhook_secret VARCHAR(255) DEFAULT '',
        monthly_price_cad DECIMAL(10,2) DEFAULT 20.00,
        free_requests_per_month INT DEFAULT 30,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
      diagLog.push('Step 4d: Creating stripe_config table...');
      await db.query(sql_stripe);
      diagLog.push('Step 4d: stripe_config table created OK');

      await db.query(`INSERT IGNORE INTO stripe_config (id, free_requests_per_month, monthly_price_cad) VALUES (1, 30, 20.00)`);
      diagLog.push('Step 5: Default stripe config inserted');

      console.log('DB INIT SUCCESS:', diagLog.join(' | '));
      res.json({ ok: true, message: 'Database tables created successfully', debug: diagLog });
    } catch (e) {
      diagLog.push('ERROR: ' + e.message);
      diagLog.push('Error code: ' + e.code + ', errno: ' + e.errno);
      console.error('DB INIT FAILED:', diagLog.join(' | '));
      try { await db.query('SET FOREIGN_KEY_CHECKS = 1'); } catch(_) {}
      res.status(500).json({ error: 'Failed to initialize tables: ' + e.message, debug: diagLog });
    }
  });

  // ── Admin: Usage stats ──
  app.get('/api/admin/usage-stats', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken) return res.status(401).json({ error: 'Unauthorized' });

    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database not configured yet. The admin needs to set up the MySQL connection in the admin panel (Database tab) and click Init Tables.' });

    try {
      const [totalUsers] = await db.query('SELECT COUNT(*) as count FROM users');
      const [proUsers] = await db.query("SELECT COUNT(*) as count FROM users WHERE plan = 'pro' OR plan = 'admin_free'");
      const [todayRequests] = await db.query('SELECT COUNT(*) as count FROM usage_log WHERE DATE(created_at) = CURDATE()');
      const [monthRequests] = await db.query('SELECT COUNT(*) as count FROM usage_log WHERE MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())');

      res.json({
        totalUsers: totalUsers[0].count,
        proUsers: proUsers[0].count,
        todayRequests: todayRequests[0].count,
        monthRequests: monthRequests[0].count
      });
    } catch (e) {
      console.error('Usage stats error:', e.message);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // ── Freemium config (public) — for frontend to know limits ──
  app.get('/api/freemium-config', async (req, res) => {
    const cfg = await getStripeConfig();
    res.json({
      freeRequestsPerMonth: cfg.free_requests_per_month || 30,
      monthlyPriceCad: cfg.monthly_price_cad || 20,
      publishableKey: cfg.publishable_key || ''
    });
  });

  // ── Admin: Get SMTP config ──
  app.get('/api/admin/smtp-config', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken) return res.status(401).json({ error: 'Unauthorized' });

    const smtp = getSmtpConfig() || {};
    res.json({
      host: smtp.host || 'smtp.hostinger.com',
      port: smtp.port || 465,
      user: smtp.user || '',
      pass: smtp.pass ? '****' : '',
      from: smtp.from || smtp.user || ''
    });
  });

  // ── Admin: Save SMTP config ──
  app.post('/api/admin/smtp-config', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken) return res.status(401).json({ error: 'Unauthorized' });

    const { host, port, user, pass, from } = req.body;
    try {
      const current = getSmtpConfig() || {};
      const newCfg = {
        host: host || current.host || 'smtp.hostinger.com',
        port: port || current.port || 465,
        user: user || current.user || '',
        pass: pass && pass !== '****' ? pass : current.pass || '',
        from: from || current.from || user || current.user || ''
      };
      saveSmtpConfig(newCfg);
      res.json({ ok: true, message: 'SMTP configuration saved' });
    } catch (e) {
      console.error('Save SMTP config error:', e.message);
      res.status(500).json({ error: 'Failed to save SMTP config' });
    }
  });

  // ── Admin: Test SMTP connection ──
  app.post('/api/admin/smtp-test', async (req, res) => {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken) return res.status(401).json({ error: 'Unauthorized' });

    const { testEmail } = req.body;
    if (!testEmail) return res.status(400).json({ error: 'testEmail required' });

    const ok = await sendEmail(
      testEmail,
      'Text Appeal - SMTP Test',
      '<div style="font-family:sans-serif;padding:24px"><h2 style="color:#1e40af">SMTP is working</h2><p>This is a test email from your Text Appeal application. If you received this, your email configuration is correct.</p></div>'
    );
    if (ok) {
      res.json({ ok: true, message: `Test email sent to ${testEmail}` });
    } else {
      res.status(500).json({ error: 'Failed to send test email. Check SMTP credentials and server logs.' });
    }
  });
}

// ─── Startup: connect to DB and init tables immediately ─────────────
async function startupInit() {
  const cfg = getDbConfig();
  console.log('DB config:', { host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, password: cfg.password ? '***' : '(empty)' });
  console.log('Attempting MySQL connection on startup...');
  const db = await getPool();
  if (db) {
    console.log('Startup: MySQL connected and tables initialized');
  } else {
    console.error('Startup: MySQL connection failed — the app will retry on first request');
  }
}

// Run on module load (non-blocking)
startupInit().catch(e => console.error('Startup init error:', e.message));

module.exports = {
  registerFreemiumRoutes,
  optionalUserAuth,
  trackUsage,
  getPool
};
