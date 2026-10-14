
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const TWELVE_API_KEY = process.env.TWELVE_DATA_API_KEY || '1c4595a0e0c54c9eb1d7e346cfdd26c1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hardiktrader22';
const AFFILIATE_URL = process.env.QUOTEX_AFFILIATE_URL || 'https://broker-qx.pro/sign-up/?lid=2148663';

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000
    })
  : null;

// User/admin sessions are stored in PostgreSQL for Vercel serverless reliability.
// Signal records remain in memory; use persistent storage if signals must survive cold starts.
const pendingSignals = new Map();

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PAIRS = [
  'EUR/USD OTC', 'GBP/USD OTC', 'USD/JPY OTC',
  'USD/CAD OTC', 'USD/CHF OTC', 'AUD/USD OTC',
  'AUD/CAD OTC', 'AUD/NZD OTC', 'NZD/CAD OTC',
  'USD/BRL OTC', 'USD/INR OTC', 'EUR/GBP OTC'
];


const LIVE_PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CAD', 'USD/CHF',
  'AUD/USD', 'AUD/CAD', 'AUD/NZD', 'NZD/CAD', 'EUR/GBP',
  'CAD/CHF', 'EUR/JPY', 'GBP/JPY', 'NZD/USD', 'EUR/CHF',
  'GBP/CHF', 'AUD/JPY', 'CHF/JPY', 'EUR/AUD', 'GBP/AUD'
];

const ALL_PAIRS = [...PAIRS, ...LIVE_PAIRS];

const TIMEFRAMES = [
  '10 Seconds', '15 Seconds', '30 Seconds',
  '1 Minute', '5 Minutes'
];

const TIMEFRAME_SECONDS = {
  '10 Seconds': 10,
  '15 Seconds': 15,
  '30 Seconds': 30,
  '1 Minute': 60,
  '5 Minutes': 300
};

let dbReady;

async function ensureDatabase() {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured.');
  }

  if (!dbReady) {
    dbReady = pool.query(`
      CREATE TABLE IF NOT EXISTS access_requests (
        id TEXT PRIMARY KEY,
        telegram TEXT NOT NULL,
        account_id TEXT NOT NULL,
        deposit_reference TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        password TEXT UNIQUE,
        approved_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS app_sessions (
        token TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
        access_request_id TEXT REFERENCES access_requests(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS app_sessions_expires_at_idx
        ON app_sessions (expires_at);
    `).catch(error => {
      dbReady = null;
      throw error;
    });
  }

  await dbReady;
}

function toSymbol(pair) {
  return pair.replace(' OTC', '');
}

function toSeconds(timeframe) {
  return TIMEFRAME_SECONDS[timeframe] || 60;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : '';

  if (!token) {
    return res.status(401).json({ error: 'Please log in again.' });
  }

  try {
    await ensureDatabase();
    const result = await pool.query(
      `SELECT token FROM app_sessions
       WHERE token = $1 AND role = 'user' AND expires_at > NOW()`,
      [token]
    );

    if (!result.rowCount) {
      return res.status(401).json({
        error: 'Session expired. Please log in again.'
      });
    }

    req.token = token;
    return next();
  } catch (error) {
    console.error('Auth error:', error.message);
    return res.status(500).json({ error: 'Authentication service unavailable.' });
  }
}

async function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : '';

  if (!token) {
    return res.status(401).json({ error: 'Admin authentication required.' });
  }

  try {
    await ensureDatabase();
    const result = await pool.query(
      `SELECT token FROM app_sessions
       WHERE token = $1 AND role = 'admin' AND expires_at > NOW()`,
      [token]
    );

    if (!result.rowCount) {
      return res.status(401).json({ error: 'Admin session expired. Please log in again.' });
    }

    return next();
  } catch (error) {
    console.error('Admin auth error:', error.message);
    return res.status(500).json({ error: 'Admin authentication service unavailable.' });
  }
}

async function getPrice(pair) {
  if (!TWELVE_API_KEY) {
    throw new Error('TWELVE_DATA_API_KEY is not configured.');
  }

  const url = new URL('https://api.twelvedata.com/price');
  url.searchParams.set('symbol', toSymbol(pair));
  url.searchParams.set('apikey', TWELVE_API_KEY);

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.status === 'error') {
    throw new Error(data.message || 'Price API request failed.');
  }

  const price = Number(data.price);

  if (!Number.isFinite(price)) {
    throw new Error('Valid market price unavailable.');
  }

  return price;
}

async function generateDirection(pair) {
  if (!TWELVE_API_KEY) {
    throw new Error('TWELVE_DATA_API_KEY is not configured.');
  }

  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', toSymbol(pair));
  url.searchParams.set('interval', '1min');
  url.searchParams.set('outputsize', '60');
  url.searchParams.set('apikey', TWELVE_API_KEY);

  const response = await fetch(url);
  const data = await response.json();

  if (
    !response.ok ||
    data.status === 'error' ||
    !Array.isArray(data.values) ||
    data.values.length < 30
  ) {
    throw new Error(
      data.message ||
      'Insufficient candle data. OTC symbols may not be supported.'
    );
  }

  const closes = data.values
    .slice()
    .reverse()
    .map(candle => Number(candle.close));

  if (closes.some(value => !Number.isFinite(value))) {
    throw new Error('Invalid candle data.');
  }

  function ema(period) {
    const k = 2 / (period + 1);
    let value = closes
      .slice(0, period)
      .reduce((sum, price) => sum + price, 0) / period;

    for (let i = period; i < closes.length; i++) {
      value = closes[i] * k + value * (1 - k);
    }

    return value;
  }

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - 14; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];

    if (change > 0) gains += change;
    else losses -= change;
  }

  const averageGain = gains / 14;
  const averageLoss = losses / 14;

  const rsi = averageLoss === 0
    ? 100
    : 100 - 100 / (1 + averageGain / averageLoss);

  const fastEMA = ema(9);
  const slowEMA = ema(21);

  if (fastEMA > slowEMA && rsi >= 50 && rsi < 70) {
    return 'CALL';
  }

  if (fastEMA < slowEMA && rsi <= 50 && rsi > 30) {
    return 'PUT';
  }

  throw new Error(
    `No clear RSI/EMA setup (RSI ${rsi.toFixed(1)}).`
  );
}

// Public configuration
app.get('/api/public-config', (req, res) => {
  res.json({
    affiliateUrl: AFFILIATE_URL,
    contact: '@Tarderhardik'
  });
});

// Submit an access request
app.post('/api/access-request', async (req, res) => {
  try {
    const { telegram, accountId, depositReference } = req.body || {};

    if (!telegram || !accountId || !depositReference) {
      return res.status(400).json({
        error: 'Telegram username, account ID and deposit reference are required.'
      });
    }

    const values = [
      String(telegram).trim(),
      String(accountId).trim(),
      String(depositReference).trim()
    ];

    if (
      values.some(value => !value) ||
      values[0].length > 80 ||
      values[1].length > 120 ||
      values[2].length > 300
    ) {
      return res.status(400).json({
        error: 'Please check the submitted details.'
      });
    }

    await ensureDatabase();

    const id = crypto.randomBytes(8).toString('hex');

    await pool.query(
      `INSERT INTO access_requests
       (id, telegram, account_id, deposit_reference)
       VALUES ($1, $2, $3, $4)`,
      [id, ...values]
    );

    return res.json({
      success: true,
      message: 'Request submitted. Contact @Tarderhardik for manual verification.'
    });
  } catch (error) {
    console.error('Access request error:', error.message);

    return res.status(500).json({
      error: 'Could not save your request. Please try again later.'
    });
  }
});

// Admin login (persistent session)
app.post('/api/admin/login', async (req, res) => {
  try {
    if (!ADMIN_PASSWORD) {
      return res.status(503).json({ error: 'ADMIN_PASSWORD is not configured.' });
    }

    if ((req.body || {}).password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid admin password.' });
    }

    await ensureDatabase();
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO app_sessions (token, role, expires_at)
       VALUES ($1, 'admin', NOW() + INTERVAL '7 days')`,
      [token]
    );

    return res.json({ success: true, token });
  } catch (error) {
    console.error('Admin login error:', error.message);
    return res.status(500).json({ error: 'Admin login service unavailable.' });
  }
});

// List access requests
app.get('/api/admin/requests', requireAdmin, async (req, res) => {
  try {
    await ensureDatabase();

    const result = await pool.query(`
      SELECT
        id,
        telegram,
        account_id AS "accountId",
        deposit_reference AS "depositReference",
        status,
        created_at AS "createdAt",
        password,
        approved_at AS "approvedAt"
      FROM access_requests
      ORDER BY created_at DESC
    `);

    return res.json({ requests: result.rows });
  } catch (error) {
    console.error('Load requests error:', error.message);

    return res.status(500).json({
      error: 'Could not load access requests.'
    });
  }
});

// Approve a request and generate its access password
app.post('/api/admin/approve/:id', requireAdmin, async (req, res) => {
  try {
    await ensureDatabase();

    const password = 'HT-' +
      crypto.randomBytes(5).toString('hex').toUpperCase();

    const result = await pool.query(`
      UPDATE access_requests
      SET password = COALESCE(password, $1),
          status = 'APPROVED',
          approved_at = COALESCE(approved_at, NOW())
      WHERE id = $2
      RETURNING id, telegram, password, status
    `, [password, req.params.id]);

    if (!result.rowCount) {
      return res.status(404).json({
        error: 'Request not found.'
      });
    }

    return res.json({
      success: true,
      password: result.rows[0].password,
      telegram: result.rows[0].telegram
    });
  } catch (error) {
    console.error('Approve request error:', error.message);

    return res.status(500).json({
      error: 'Could not approve request.'
    });
  }
});

// User login using approved password
app.post('/api/login', async (req, res) => {
  try {
    const password = String((req.body || {}).password || '').trim();

    if (!password) {
      return res.status(401).json({
        error: 'Enter your approved access password.'
      });
    }

    await ensureDatabase();

    const result = await pool.query(
      `SELECT id FROM access_requests
       WHERE password = $1 AND status = 'APPROVED'`,
      [password]
    );

    if (!result.rowCount) {
      return res.status(401).json({
        error: 'Password not approved or invalid.'
      });
    }

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO app_sessions (token, role, access_request_id, expires_at)
       VALUES ($1, 'user', $2, NOW() + INTERVAL '7 days')`,
      [token, result.rows[0].id]
    );

    return res.json({ success: true, token });
  } catch (error) {
    console.error('User login error:', error.message);

    return res.status(500).json({
      error: 'Login service is temporarily unavailable.'
    });
  }
});

// Public pair and timeframe configuration
app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ pairs: PAIRS, livePairs: LIVE_PAIRS, timeframes: TIMEFRAMES });
});

// Generate a signal
app.post('/api/signal', requireAuth, async (req, res) => {
  try {
    const { pair, timeframe } = req.body || {};

    if (!ALL_PAIRS.includes(pair) || !TIMEFRAMES.includes(timeframe)) {
      return res.status(400).json({
        error: 'Select a valid pair and timeframe.'
      });
    }

    const [entryPrice, direction] = await Promise.all([
      getPrice(pair),
      generateDirection(pair)
    ]);

    const signalId = crypto.randomBytes(24).toString('hex');
    const entryTime = Date.now();
    const durationSeconds = toSeconds(timeframe);

    const signal = {
      signalId,
      userToken: req.token,
      pair,
      timeframe,
      direction,
      entryPrice,
      entryTime,
      durationSeconds,
      status: 'PENDING',
      result: null
    };

    pendingSignals.set(signalId, signal);

    res.json({
      success: true,
      signal: {
        signalId,
        pair,
        timeframe,
        direction,
        entryPrice,
        entryTime,
        expiryTime: entryTime + durationSeconds * 1000,
        durationSeconds
      }
    });
  } catch (error) {
    console.error('Signal error:', error.message);

    res.status(502).json({
      error: 'Unable to generate a signal. Check market-data support and API quota.'
    });
  }
});

// Check result after expiry
app.post('/api/check-result', requireAuth, async (req, res) => {
  try {
    const { signalId } = req.body || {};
    const signal = pendingSignals.get(signalId);

    if (!signal || signal.userToken !== req.token) {
      return res.status(404).json({
        error: 'Signal not found or expired.'
      });
    }

    if (signal.status === 'COMPLETED') {
      return res.json({ success: true, ...signal.result });
    }

    const expiryTime =
      signal.entryTime + signal.durationSeconds * 1000;

    if (Date.now() < expiryTime) {
      return res.status(202).json({
        success: false,
        status: 'WAITING',
        remainingSeconds: Math.ceil((expiryTime - Date.now()) / 1000),
        expiryTime
      });
    }

    if (signal.status === 'CHECKING') {
      return res.status(409).json({
        error: 'Result is already being checked.'
      });
    }

    signal.status = 'CHECKING';

    let exitPrice;

    try {
      exitPrice = await getPrice(signal.pair);
    } catch (error) {
      signal.status = 'PENDING';
      throw error;
    }

    const result = exitPrice === signal.entryPrice
      ? 'DRAW'
      : (
          (signal.direction === 'CALL' && exitPrice > signal.entryPrice) ||
          (signal.direction === 'PUT' && exitPrice < signal.entryPrice)
        ) ? 'WIN' : 'LOSS';

    const difference = exitPrice - signal.entryPrice;

    signal.result = {
      result,
      direction: signal.direction,
      pair: signal.pair,
      timeframe: signal.timeframe,
      entryPrice: signal.entryPrice,
      exitPrice,
      difference,
      diffPips: Number(
        (difference * (signal.pair.includes('JPY') ? 100 : 10000)).toFixed(2)
      ),
      completedAt: Date.now()
    };

    signal.status = 'COMPLETED';

    return res.json({ success: true, ...signal.result });
  } catch (error) {
    console.error('Check result error:', error.message);

    return res.status(502).json({
      error: 'Unable to fetch exit price. Check market-data availability.'
    });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    if (!pool) {
      return res.status(503).json({
        status: 'error',
        database: 'not_configured'
      });
    }

    await pool.query('SELECT 1');

    return res.json({
      status: 'online',
      database: 'connected',
      service: 'Hardik Trader',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Health check error:', error.message);

    return res.status(503).json({
      status: 'error',
      database: 'disconnected'
    });
  }
});

// Website pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Vercel can import the Express app as a handler.
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Hardik Trader running on port ${PORT}`);
  });
}

module.exports = app;
