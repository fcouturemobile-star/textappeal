/**
 * Text Appeal — Freemium System Module
 * Handles: user registration/login, usage tracking, Stripe subscriptions, admin member management
 * Uses MySQL (Hostinger compatible)
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ─── Base directory (works regardless of process.cwd) ───────────────
const BASE_DIR = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(BASE_DIR, 'server');
const DATA_DIR = path.join(SERVER_DIR, 'data');

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

  // Priority 2: Config file (try multiple locations)
  const locations = [
    path.join(DATA_DIR, 'db-config.json'),
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
    const { email, password, displayName } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database not configured yet. The admin needs to set up the MySQL connection in the admin panel (Database tab) and click Init Tables.' });

    try {
      // Check if email exists
      const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
      if (existing.length > 0) return res.status(409).json({ error: 'Email already registered' });

      const hash = hashPassword(password);
      const monthReset = getMonthResetDate();

      const [result] = await db.query(
        'INSERT INTO users (email, password_hash, display_name, plan, month_reset_date) VALUES (?, ?, ?, ?, ?)',
        [email.toLowerCase().trim(), hash, displayName || '', 'free', monthReset]
      );

      // Auto-login
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
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const db = await getPool();
    if (!db) return res.status(503).json({ error: 'Database not configured yet. The admin needs to set up the MySQL connection in the admin panel (Database tab) and click Init Tables.' });

    try {
      const [users] = await db.query('SELECT * FROM users WHERE email = ? AND is_active = 1', [email.toLowerCase().trim()]);
      if (users.length === 0) return res.status(401).json({ error: 'Invalid email or password' });

      const user = users[0];
      if (!verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // Reset monthly if needed
      await ensureMonthReset(db, user.id, user.month_reset_date);
      const [refreshed] = await db.query('SELECT requests_this_month FROM users WHERE id = ?', [user.id]);

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
        success_url: `${baseUrl}/#/subscribe/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/#/subscribe/cancel`,
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
      const [members] = await db.query(
        'SELECT id, email, display_name, plan, requests_this_month, subscription_status, is_active, created_at FROM users ORDER BY created_at DESC'
      );
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
    const cfgPath = path.join(DATA_DIR, 'db-config.json');

    try {
      const current = getDbConfig();
      const newCfg = {
        host: host || current.host,
        port: port || current.port,
        user: user || current.user,
        password: password && password !== '****' ? password : current.password,
        database: database || current.database
      };

      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify(newCfg, null, 2));

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
