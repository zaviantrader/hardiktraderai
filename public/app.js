(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  const loginScreen = $('loginScreen');
  const loginForm = $('loginForm');
  const passwordInput = $('password');
  const loginError = $('loginError');

  const mainScreen = $('mainScreen');
  const pairTitle = $('pairTitle');
  const logoutBtn = $('logout');
  const pairBtn = $('pairBtn');
  const otcPairBtn = $('otcPairBtn');
  const livePairBtn = $('livePairBtn');
  const pairLabel = $('pairLabel');
  const musicBtn = $('musicBtn');

  const timeframeSelect = $('timeframe');
  const pairSelect = $('pair');

  const spinner = $('spinner');
  const scanText = $('scanText');
  const entryText = $('entryText');

  const liveResult = $('liveResult');
  const liveSticker = $('liveSticker');
  const liveDirection = $('liveDirection');
  const liveInfo = $('liveInfo');

  const countdownEl = $('countdown');
  const progressBar = $('progressBar');
  const chartCanvas = $('chart');

  const getSignalBtn = $('getSignal');
  const successMsg = $('successMsg');
  const scanCard = $('scanCard');

  // WIN animation video element.
  // Added dynamically, so index.html does not need editing.
  let resultVideo = $('resultVideo');

  if (!resultVideo && liveResult) {
    resultVideo = document.createElement('video');
    resultVideo.id = 'resultVideo';
    resultVideo.autoplay = true;
    resultVideo.muted = true;
    resultVideo.loop = true;
    resultVideo.playsInline = true;
    resultVideo.controls = false;
    resultVideo.hidden = true;

    resultVideo.style.width = '120px';
    resultVideo.style.height = '120px';
    resultVideo.style.objectFit = 'contain';
    resultVideo.style.margin = '0 auto';

    liveSticker.insertAdjacentElement('afterend', resultVideo);
  }

  let token = localStorage.getItem('tjp_token') || null;
  let soundEnabled = true;
  let musicEnabled = false;
  let scanning = false;
  let countdownTimer = null;
  let resultTimer = null;
  let chartAnimId = null;

  function showLogin() {
    loginScreen.hidden = false;
    mainScreen.hidden = true;

    token = null;
    localStorage.removeItem('tjp_token');

    resetScanUI();
  }

  function showMain() {
    loginScreen.hidden = true;
    mainScreen.hidden = false;
  }

  function hideResultVideo() {
    if (!resultVideo) return;

    resultVideo.pause();
    resultVideo.removeAttribute('src');
    resultVideo.load();
    resultVideo.hidden = true;
  }

  function showResultImage(src, alt) {
    hideResultVideo();

    // Reset image state before switching CALL/PUT/WIN/LOSS stickers.
    liveSticker.onerror = function () {
      console.error('Signal sticker failed to load:', liveSticker.src);
      liveSticker.alt = alt + ' image unavailable';
      liveSticker.style.display = 'none';
    };

    liveSticker.onload = function () {
      liveSticker.style.display = 'block';
    };

    liveSticker.hidden = false;
    liveSticker.style.display = 'block';
    liveSticker.alt = alt;
    liveSticker.src = src;
  }

  function showWinVideo() {
    liveSticker.hidden = true;

    resultVideo.hidden = false;
    resultVideo.src = '/assets/win.webm';
    resultVideo.currentTime = 0;

    const playback = resultVideo.play();

    if (playback && typeof playback.catch === 'function') {
      playback.catch(error => {
        console.error('WIN video playback failed:', error);

        resultVideo.hidden = true;
        liveSticker.hidden = false;
        liveSticker.src = '/assets/win.webp';
        liveSticker.alt = 'WIN';
      });
    }
  }

  function resetScanUI() {
    scanning = false;

    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }

    if (resultTimer) {
      clearTimeout(resultTimer);
      resultTimer = null;
    }

    spinner.hidden = false;
    spinner.style.display = '';

    scanText.hidden = false;
    scanText.textContent = 'Ready for signal';

    entryText.hidden = true;
    entryText.textContent = '';

    liveResult.hidden = true;
    successMsg.hidden = true;
    successMsg.style.color = '';

    scanCard.classList.remove(
      'scanning',
      'waiting',
      'has-result'
    );

    countdownEl.textContent = '--';
    progressBar.style.width = '0%';

    getSignalBtn.disabled = false;
    getSignalBtn.textContent = 'GET SIGNAL';

    hideResultVideo();
  }

  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function formatTime(date) {
    return (
      pad(date.getHours()) + ':' +
      pad(date.getMinutes()) + ':' +
      pad(date.getSeconds())
    );
  }

  function getNextEntryTime(tfLabel) {
    const now = new Date();

    const secondsMap = {
      '10 Seconds': 10,
      '15 Seconds': 15,
      '30 Seconds': 30,
      '1 Minute': 60,
      '5 Minutes': 300
    };

    const interval = secondsMap[tfLabel] || 60;
    const ms = now.getTime();
    const next = (Math.floor(ms / (interval * 1000)) + 1)
      * interval * 1000;

    return new Date(next);
  }

  function toWaitMs(tf) {
    const map = {
      '10 Seconds': 10000,
      '15 Seconds': 15000,
      '30 Seconds': 30000,
      '1 Minute': 60000,
      '5 Minutes': 300000
    };

    return map[tf] || 60000;
  }

  async function tryAutoLogin() {
    if (!token) {
      showLogin();
      return;
    }

    showMain();

    await loadConfig();
    drawChart();
  }


  // Public access request flow and configurable affiliate destination.
  const requestForm = $('accessRequestForm');
  if (requestForm) {
    fetch('/api/public-config').then(r => r.json()).then(cfg => {
      const link = $('affiliateLink');
      if (link) link.href = cfg.affiliateUrl;
    }).catch(() => {});
    requestForm.addEventListener('submit', async e => {
      e.preventDefault();
      const message = $('requestMessage');
      message.hidden = false; message.textContent = 'Submitting request…';
      try {
        const response = await fetch('/api/access-request', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ telegram: $('telegram').value, accountId: $('accountId').value, depositReference: $('depositReference').value }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not submit request.');
        message.textContent = 'Request submitted. Contact @Tarderhardik on Telegram for manual verification.';
        requestForm.reset();
      } catch (err) { message.textContent = err.message || 'Connection error'; }
    });
  }

  loginForm.addEventListener('submit', async function (e) {
    e.preventDefault();

    loginError.hidden = true;

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          password: passwordInput.value
        })
      });

      const data = await res.json();

      if (!res.ok) {
        loginError.hidden = false;
        loginError.textContent =
          data.error || 'Wrong password';
        return;
      }

      token = data.token;

      localStorage.setItem('tjp_token', token);
      passwordInput.value = '';

      showMain();

      await loadConfig();
      drawChart();

    } catch (error) {
      loginError.hidden = false;
      loginError.textContent = 'Connection error';
    }
  });

  logoutBtn.addEventListener('click', showLogin);

  let otcPairs = [];
  let livePairs = [];
  let currentPairMode = 'otc';

  async function loadConfig() {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Config request failed');

      otcPairs = Array.isArray(data.pairs) ? data.pairs : [];
      livePairs = Array.isArray(data.livePairs) ? data.livePairs : [];

      timeframeSelect.innerHTML = '';
      (data.timeframes || []).forEach(timeframe => {
        const option = document.createElement('option');
        option.value = timeframe;
        option.textContent = timeframe;
        timeframeSelect.appendChild(option);
      });

      if (data.timeframes && data.timeframes.length) {
        timeframeSelect.value = data.timeframes.find(t => t === '1 Minute') || data.timeframes[0];
      }
      setPairMode('otc');
    } catch (error) {
      console.error('Config load failed:', error);
      scanText.textContent = 'Unable to load pairs. Please refresh.';
    }
  }

  function setPairMode(mode) {
    currentPairMode = mode;
    const pairs = mode === 'otc' ? otcPairs : livePairs;
    const previousPair = pairSelect.value;
    pairSelect.innerHTML = '';

    pairs.forEach(pair => {
      const option = document.createElement('option');
      option.value = pair;
      option.textContent = pair;
      pairSelect.appendChild(option);
    });

    pairSelect.value = pairs.includes(previousPair) ? previousPair : (pairs[0] || '');
    pairTitle.textContent = pairSelect.value || (mode === 'otc' ? 'OTC Pair' : 'Live Pair');
    if (pairLabel) pairLabel.textContent = mode === 'otc' ? 'OTC PAIR' : 'LIVE PAIR';
    otcPairBtn.classList.toggle('active', mode === 'otc');
    livePairBtn.classList.toggle('active', mode === 'live');
  }

  pairSelect.addEventListener('change', function () {
    pairTitle.textContent = pairSelect.value;
  });

  pairBtn.addEventListener('click', function () {
    pairSelect.focus();
    if (typeof pairSelect.showPicker === 'function') {
      try { pairSelect.showPicker(); } catch (_) {}
    }
  });

  otcPairBtn.addEventListener('click', function () { setPairMode('otc'); });
  livePairBtn.addEventListener('click', function () { setPairMode('live'); });

  musicBtn.addEventListener('click', function () {
    musicEnabled = !musicEnabled;

    musicBtn.textContent =
      musicEnabled ? 'Music ON' : 'Music OFF';

    musicBtn.classList.toggle('active', musicEnabled);
  });

  function playBeep() {
    if (!soundEnabled) return;

    try {
      const AudioContext =
        window.AudioContext || window.webkitAudioContext;

      if (!AudioContext) return;

      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.frequency.value = 880;
      osc.type = 'sine';

      gain.gain.setValueAtTime(0.18, ctx.currentTime);

      gain.gain.exponentialRampToValueAtTime(
        0.001,
        ctx.currentTime + 0.25
      );

      osc.start();
      osc.stop(ctx.currentTime + 0.25);

      osc.onended = () => ctx.close();

    } catch (_) {}
  }

  function drawChart() {
    if (!chartCanvas) return;

    const ctx = chartCanvas.getContext('2d');
    const w = chartCanvas.width;
    const h = chartCanvas.height;

    function render() {
      ctx.fillStyle = '#0a0e1a';
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(107,92,255,0.08)';
      ctx.lineWidth = 1;

      for (let i = 0; i < 5; i++) {
        const y = (h / 5) * i;

        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const points = 40;
      const now = Date.now() / 1000;

      ctx.beginPath();
      ctx.strokeStyle = '#6b5cff';
      ctx.lineWidth = 2;

      for (let i = 0; i < points; i++) {
        const x = (w / (points - 1)) * i;

        const y =
          h / 2 +
          Math.sin(now * 0.4 + i * 0.35) * 28 +
          Math.cos(now * 0.25 + i * 0.2) * 12;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.stroke();

      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();

      ctx.fillStyle = 'rgba(107,92,255,0.08)';
      ctx.fill();

      chartAnimId = requestAnimationFrame(render);
    }

    if (chartAnimId) {
      cancelAnimationFrame(chartAnimId);
    }

    render();
  }

  getSignalBtn.addEventListener('click', function () {
    if (scanning) return;

    startSignalFlow();
  });

  async function startSignalFlow() {
    scanning = true;

    getSignalBtn.disabled = true;
    getSignalBtn.textContent = 'SCANNING...';

    successMsg.hidden = true;
    liveResult.hidden = true;

    hideResultVideo();

    scanCard.classList.remove('has-result');
    scanCard.classList.add('scanning');

    spinner.hidden = false;
    spinner.style.display = '';

    scanText.hidden = false;
    scanText.textContent = 'CALCULATING NEXT ENTRY...';

    entryText.hidden = true;

    const pair = pairSelect.value;
    const timeframe = timeframeSelect.value;
    const entry = getNextEntryTime(timeframe);

    await sleep(500);

    entryText.hidden = false;
    entryText.textContent =
      'ENTRY TIME: ' + formatTime(entry);

    scanText.textContent = 'WAITING FOR ENTRY TIME';

    scanCard.classList.add('waiting');

    const totalMs = Math.max(1, entry.getTime() - Date.now());

    function updateCountdown() {
      const remainingMs = entry.getTime() - Date.now();

      const remaining = Math.max(
        0,
        Math.ceil(remainingMs / 1000)
      );

      countdownEl.textContent = remaining + 's';

      const elapsed = totalMs - Math.max(0, remainingMs);

      progressBar.style.width =
        Math.min(100, (elapsed / totalMs) * 100) + '%';

      if (remainingMs <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;

        progressBar.style.width = '100%';

        generateSignal(pair, timeframe);
      }
    }

    updateCountdown();
    countdownTimer = setInterval(updateCountdown, 200);
  }

  async function checkResultUntilReady(signalId, expiryTime) {
    while (Date.now() < expiryTime) {
      await sleep(Math.min(1000, expiryTime - Date.now()));
    }

    while (true) {
      const response = await fetch('/api/check-result', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token
        },
        body: JSON.stringify({ signalId })
      });

      const data = await response.json().catch(() => ({}));

      if (response.status === 401) {
        showLogin();
        throw new Error('Session expired. Please log in again.');
      }

      if (response.status === 202 && data.status === 'WAITING') {
        await sleep(
          Math.max(500, (data.remainingSeconds || 1) * 1000)
        );
        continue;
      }

      if (!response.ok) {
        throw new Error(data.error || 'Result check failed');
      }

      return data;
    }
  }

  async function generateSignal(pair, timeframe) {
    scanText.textContent = 'GENERATING SIGNAL...';

    entryText.hidden = true;

    spinner.hidden = false;
    spinner.style.display = '';

    try {
      const response = await fetch('/api/signal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token
        },
        body: JSON.stringify({ pair, timeframe })
      });

      const data = await response.json().catch(() => ({}));

      if (response.status === 401) {
        showLogin();
        return;
      }

      if (!response.ok) {
        throw new Error(data.error || 'Signal API error');
      }

      const signal = data.signal;

      spinner.style.display = 'none';
      scanText.hidden = true;
      entryText.hidden = true;

      liveResult.hidden = false;

      showResultImage(
        signal.direction === 'CALL'
          ? '/assets/call.webp'
          : '/assets/put.webp',
        signal.direction
      );

      liveDirection.textContent = signal.direction;

      liveDirection.className =
        'direction ' + signal.direction.toLowerCase();

      liveInfo.textContent =
        signal.pair + ' • ' + signal.timeframe +
        '\nEntry: ' + signal.entryPrice;

      liveInfo.style.whiteSpace = 'pre-line';

      scanCard.classList.remove('scanning', 'waiting');
      scanCard.classList.add('has-result');

      successMsg.hidden = false;
      successMsg.style.color = '#35ee8a';

      successMsg.textContent =
        '✓ Signal generated • Waiting for expiry...';

      playBeep();

      const expiryTime =
        signal.entryTime +
        (signal.durationSeconds || toWaitMs(timeframe) / 1000) * 1000;

      // Keep the result checker active until the API returns a final result.
      resultTimer = setTimeout(async function () {
        try {
          successMsg.textContent = 'Checking final result...';

          const result = await checkResultUntilReady(
            signal.signalId,
            expiryTime
          );

          if (result.result === 'WIN') {
            showWinVideo();
          } else if (result.result === 'LOSS') {
            showResultImage('/assets/loss.webp', 'LOSS');
          } else {
            showResultImage('/assets/draw.webp', 'DRAW');
          }

          liveDirection.textContent = result.result;

          liveDirection.className =
            'direction ' +
            (
              result.result === 'WIN' ? 'call' :
              result.result === 'LOSS' ? 'put' : ''
            );

          liveInfo.textContent =
            result.pair + ' • ' + result.timeframe +
            '\nEntry: ' + result.entryPrice +
            ' → Exit: ' + result.exitPrice +
            '\n' + result.result +
            ' (' + result.diffPips + ' pips)';

          liveInfo.style.whiteSpace = 'pre-line';

          if (result.result === 'WIN') {
            successMsg.textContent =
              '✓ WIN — Price moved in your direction';

            successMsg.style.color = '#35ee8a';
          } else if (result.result === 'LOSS') {
            successMsg.textContent =
              '✗ LOSS — Price moved against signal';

            successMsg.style.color = '#ff5876';
          } else {
            successMsg.textContent =
              'DRAW — Entry and exit prices were equal';

            successMsg.style.color = '#aeb7d0';
          }

          playBeep();

        } catch (error) {
          console.error('Result error:', error);

          successMsg.textContent =
            error.message || 'Result check failed';

          successMsg.style.color = '#ff5876';
        } finally {
          resultTimer = null;
        }
      }, Math.max(0, expiryTime - Date.now()));

    } catch (error) {
      console.error('Signal generation error:', error);

      spinner.style.display = 'none';

      scanText.hidden = false;
      scanText.textContent = 'SIGNAL ERROR';

      entryText.hidden = false;
      entryText.textContent =
        error.message || 'Unable to generate signal';

      liveResult.hidden = true;

      scanCard.classList.remove('scanning', 'waiting');

    } finally {
      scanning = false;

      getSignalBtn.disabled = false;
      getSignalBtn.textContent = 'GET SIGNAL';

      countdownEl.textContent = '--';
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  tryAutoLogin();
})();
