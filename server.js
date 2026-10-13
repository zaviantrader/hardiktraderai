const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ CONFIGURATION ============
const TWELVE_API_KEY = process.env.TWELVE_DATA_API_KEY || '1c4595a0e0c54c9eb1d7e346cfdd26c1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hardiktrader22';
const AFFILIATE_URL = process.env.QUOTEX_AFFILIATE_URL || 'https://broker-qx.pro/sign-up/?lid=2148663';
const fs = require('fs');
const DATA_FILE = path.join(__dirname, 'access-requests.json');
let accessRequests = [];
try { accessRequests = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) {}
function saveRequests() { fs.writeFileSync(DATA_FILE, JSON.stringify(accessRequests, null, 2)); }
const adminTokens = new Set();
const passwords = new Set();
// =======================================

const activeTokens = new Set();
const pendingSignals = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PAIRS = [
  'EUR/USD OTC',
  'GBP/USD OTC',
  'USD/JPY OTC',
  'USD/CAD OTC',
  'USD/CHF OTC',
  'AUD/USD OTC',
  'AUD/CAD OTC',
  'AUD/NZD OTC',
  'NZD/CAD OTC',
  'USD/BRL OTC',
  'USD/INR OTC',
  'EUR/GBP OTC'
];

const TIMEFRAMES = [
  '10 Seconds',
  '15 Seconds',
  '30 Seconds',
  '1 Minute',
  '5 Minutes'
];

const TIMEFRAME_SECONDS = {
  '10 Seconds': 10,
  '15 Seconds': 15,
  '30 Seconds': 30,
  '1 Minute': 60,
  '5 Minutes': 300
};

// ============ PAIR SYMBOL ============
function toSymbol(pair) {
  return pair.replace(' OTC', '');
}

// ============ TIMEFRAME ============
function toSeconds(timeframe) {
  return TIMEFRAME_SECONDS[timeframe] || 60;
}

// ============ FETCH PRICE ============
async function getPrice(pair) {
  if (
    !TWELVE_API_KEY ||
    TWELVE_API_KEY ===
      'PASTE_YOUR_NEW_TWELVE_DATA_API_KEY'
  ) {
    throw new Error('Configure your Twelve Data API key');
  }

  const symbol = toSymbol(pair);

  const url =
    `https://api.twelvedata.com/price` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&apikey=${encodeURIComponent(TWELVE_API_KEY)}`;

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Price API HTTP ${response.status}`);
  }

  if (
    data.status === 'error' ||
    data.price === undefined ||
    data.price === null
  ) {
    throw new Error(
      data.message || 'Price unavailable from Twelve Data'
    );
  }

  const price = Number(data.price);

  if (!Number.isFinite(price)) {
    throw new Error('Invalid price received from API');
  }

  return price;
}

// ============ RSI(14) + EMA(9/21) CONFIRMATION ============
async function generateDirection(pair) {
  if (!TWELVE_API_KEY) throw new Error('Set TWELVE_DATA_API_KEY to enable RSI/EMA signals.');
  const symbol = toSymbol(pair);
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1min&outputsize=60&apikey=${encodeURIComponent(TWELVE_API_KEY)}`;
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.status === 'error' || !Array.isArray(data.values) || data.values.length < 30) throw new Error(data.message || 'Not enough candle data for RSI/EMA confirmation. OTC pairs may not be supported by the market data provider.');
  const closes = data.values.slice().reverse().map(c => Number(c.close));
  const ema = (period) => { const k = 2 / (period + 1); let value = closes.slice(0, period).reduce((a,b)=>a+b,0)/period; for(let i=period;i<closes.length;i++) value=closes[i]*k+value*(1-k); return value; };
  let gains=0, losses=0;
  for(let i=closes.length-14;i<closes.length;i++){ const d=closes[i]-closes[i-1]; if(d>0) gains+=d; else losses-=d; }
  const avgGain=gains/14, avgLoss=losses/14;
  const rsi=avgLoss===0?100:100-(100/(1+(avgGain/avgLoss)));
  const fast=ema(9), slow=ema(21);
  if(fast>slow && rsi>=50 && rsi<70) return 'CALL';
  if(fast<slow && rsi<=50 && rsi>30) return 'PUT';
  throw new Error(`No clear RSI/EMA setup (RSI ${rsi.toFixed(1)}). Wait for confirmation; no signal generated.`);
}

// ============ AUTHENTICATION ============
function requireAuth(req, res, next) {
  const authorization =
    req.headers.authorization || '';

  if (!authorization.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Unauthorized. Please log in again.'
    });
  }

  const token = authorization.slice(7);

  if (!activeTokens.has(token)) {
    return res.status(401).json({
      error: 'Invalid session. Please log in again.'
    });
  }

  req.token = token;
  next();
}

// ============ ACCESS REQUEST / ADMIN APPROVAL ============
app.get('/api/public-config', (req, res) => res.json({ affiliateUrl: AFFILIATE_URL, contact: '@Tarderhardik' }));
app.post('/api/access-request', (req, res) => {
  const { telegram, accountId, depositReference } = req.body || {};
  if (!telegram || !accountId || !depositReference) return res.status(400).json({ error: 'Telegram username, account ID and deposit reference are required.' });
  if (String(telegram).length > 80 || String(accountId).length > 120 || String(depositReference).length > 300) return res.status(400).json({ error: 'Please check the submitted details.' });
  const request = { id: crypto.randomBytes(8).toString('hex'), telegram: String(telegram).trim(), accountId: String(accountId).trim(), depositReference: String(depositReference).trim(), status: 'PENDING', createdAt: new Date().toISOString(), password: null };
  accessRequests.unshift(request); saveRequests();
  res.json({ success: true, message: 'Request submitted. Contact @Tarderhardik on Telegram for manual verification.' });
});
app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD === 'CHANGE_ME_ADMIN_PASSWORD' || (req.body || {}).password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid admin password. Set ADMIN_PASSWORD in environment first.' });
  const token = crypto.randomBytes(32).toString('hex'); adminTokens.add(token); res.json({ success: true, token });
});
function requireAdmin(req, res, next) { const token = (req.headers.authorization || '').replace(/^Bearer /, ''); if (!token || !adminTokens.has(token)) return res.status(401).json({ error: 'Admin authentication required.' }); next(); }
app.get('/api/admin/requests', requireAdmin, (req, res) => res.json({ requests: accessRequests }));
app.post('/api/admin/approve/:id', requireAdmin, (req, res) => {
  const item = accessRequests.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Request not found.' });
  if (!item.password) { item.password = 'HT-' + crypto.randomBytes(5).toString('hex').toUpperCase(); item.status = 'APPROVED'; item.approvedAt = new Date().toISOString(); saveRequests(); }
  res.json({ success: true, password: item.password, telegram: item.telegram });
});
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || !accessRequests.some(x => x.password === password && x.status === 'APPROVED')) return res.status(401).json({ error: 'Password not approved. Submit your access request first.' });
  const token = crypto.randomBytes(32).toString('hex'); activeTokens.add(token); res.json({ success: true, token });
});

// ============ CONFIG ============
app.get('/api/config', (req, res) => {
  res.json({
    pairs: PAIRS,
    timeframes: TIMEFRAMES
  });
});

// ============ GENERATE SIGNAL ============
app.post('/api/signal', requireAuth, async (req, res) => {
  try {
    const { pair, timeframe } = req.body || {};

    if (!pair || !timeframe) {
      return res.status(400).json({
        error: 'Please select a pair and timeframe.'
      });
    }

    if (
      !PAIRS.includes(pair) ||
      !TIMEFRAMES.includes(timeframe)
    ) {
      return res.status(400).json({
        error: 'Invalid pair or timeframe.'
      });
    }

    const entryPrice = await getPrice(pair);
    const direction = await generateDirection(pair);

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

    // Remove old, unfinished signals after 15 minutes.
    setTimeout(() => {
      const saved = pendingSignals.get(signalId);

      if (saved && saved.status === 'PENDING') {
        pendingSignals.delete(signalId);
      }
    }, 15 * 60 * 1000).unref?.();

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
      error: 'Unable to fetch entry price. Check your API key, API quota and pair availability.'
    });
  }
});

// ============ CHECK WIN / LOSS ============
app.post(
  '/api/check-result',
  requireAuth,
  async (req, res) => {
    try {
      const { signalId } = req.body || {};

      if (!signalId) {
        return res.status(400).json({
          error: 'Signal ID is required.'
        });
      }

      const signal = pendingSignals.get(signalId);

      if (!signal || signal.userToken !== req.token) {
        return res.status(404).json({
          error: 'Signal not found or expired.'
        });
      }

      // Return the saved result if already checked.
      if (signal.status === 'COMPLETED') {
        return res.json({
          success: true,
          ...signal.result
        });
      }

      // Do not check the result before expiry.
      const expiryTime =
        signal.entryTime + signal.durationSeconds * 1000;

      const remainingMs = expiryTime - Date.now();

      if (remainingMs > 0) {
        return res.status(202).json({
          success: false,
          status: 'WAITING',
          message: 'Signal has not expired yet.',
          remainingSeconds: Math.ceil(remainingMs / 1000),
          expiryTime
        });
      }

      // Prevent concurrent checks for the same signal.
      if (signal.status === 'CHECKING') {
        return res.status(409).json({
          error: 'This signal is already being checked. Try again shortly.'
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

      let result;

      if (exitPrice === signal.entryPrice) {
        result = 'DRAW';
      } else if (
        signal.direction === 'CALL' &&
        exitPrice > signal.entryPrice
      ) {
        result = 'WIN';
      } else if (
        signal.direction === 'PUT' &&
        exitPrice < signal.entryPrice
      ) {
        result = 'WIN';
      } else {
        result = 'LOSS';
      }

      const difference = exitPrice - signal.entryPrice;

      const multiplier = signal.pair.includes('JPY')
        ? 100
        : 10000;

      const resultData = {
        result,
        direction: signal.direction,
        pair: signal.pair,
        timeframe: signal.timeframe,
        entryPrice: signal.entryPrice,
        exitPrice,
        difference,
        diffPips: Number(
          (difference * multiplier).toFixed(2)
        ),
        completedAt: Date.now()
      };

      signal.status = 'COMPLETED';
      signal.result = resultData;

      res.json({
        success: true,
        ...resultData
      });
    } catch (error) {
      console.error(
        'Check result error:',
        error.message
      );

      res.status(502).json({
        error: 'Unable to fetch exit price. Check API connectivity and quota, then try again.'
      });
    }
  }
);

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'Hardik Trader',
    timestamp: new Date().toISOString()
  });
});

// ============ HOME PAGE ============
app.get('/', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ============ START SERVER ============
app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Hardik Trader running on port ${PORT}`
  );
});
