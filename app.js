(() => {
  const BLOCK_LIST = ["ljxnet.cn", "netart.cn", ".gov.cn"];
  const NODES = {
    "Speed Test": {
      "Cachefly": "https://web1.cachefly.net/speedtest/downloading",
      "Cloudflare Speed": "https://speed.cloudflare.com/__down?bytes=99614720",
      "Steam Akamai": "https://cdn.akamai.steamstatic.com/steam/apps/1063730/extras/NW_Sword_Sorcery_2.gif",
      "Steam Cloudflare": "https://cdn.cloudflare.steamstatic.com/steam/apps/1063730/extras/NW_Sword_Sorcery_2.gif"
    }
  };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  function toast(msg, dur = 2500) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), dur);
  }

  function openModal(title, bodyHTML, footerHTML) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = bodyHTML;
    $('#modalFooter').innerHTML = footerHTML || '';
    $('#modalOverlay').style.display = 'flex';
  }

  function closeModal() {
    $('#modalOverlay').style.display = 'none';
  }

  function formatBytes(n, decimals = [0, 0, 1, 2, 2, 2], suffix = 'bytes') {
    const units = suffix === 'speed'
      ? ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s', 'PB/s']
      : suffix === 'bits'
        ? ['Bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps', 'Pbps']
        : ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let idx = 0;
    let v = n;
    while (v >= 1024 && idx < units.length - 1) {
      v /= 1024;
      idx++;
    }
    return v.toFixed(decimals[idx]) + units[idx];
  }

  // State
  const state = {
    bytesUsed: 0,
    logged: 0,
    lastLogTime: 0,
    recordUse: 0,
    recordTime: 0,
    startUse: 0,
    startTime: 0,
    maxUse: parseInt(localStorage.getItem('maxUse') || '0'),
    maxSpeed: parseInt(localStorage.getItem('maxSpeed') || '0'),
  };

  let isRunning = false;
  let isChecking = false;
  let tasks = [];
  let chartData = [];
  let chartSpeedBuf = [];
  let chartStep = 1;
  let myChart = null;
  let chartVisible = false;

  // DOM refs
  const nodeSelect = $('#nodeSelect');
  const threadSlider = $('#threadSlider');
  const threadNumDisplay = $('#threadNumDisplay');
  const bgToggle = $('#bgToggle');
  const autoToggle = $('#autoToggle');
  const playBtn = $('#playBtn');
  const totalDataEl = $('#totalData');
  const speedEl = $('#speed');
  const bandwidthEl = $('#bandwidth');
  const dataLimitEl = $('#dataLimit');
  const speedLimitEl = $('#speedLimit');
  const speedLabelEl = $('#speedLabel');
  const silentAudio = $('#silentAudio');
  const fullscreenOverlay = $('#fullscreenOverlay');
  const chartWrap = $('#chartWrap');

  // Load saved settings
  const savedUrl = localStorage.getItem('url') || '';
  const savedThreads = parseInt(localStorage.getItem('threadNum') || '8');
  const savedBg = localStorage.getItem('runBackground') === 'true';
  const savedAuto = localStorage.getItem('autoStart') === 'true';

  threadSlider.value = savedThreads;
  threadNumDisplay.textContent = savedThreads;
  bgToggle.checked = savedBg;
  autoToggle.checked = savedAuto;

  // Build node select
  let customNodes = [];
  try { customNodes = JSON.parse(localStorage.getItem('customNodes') || '[]'); } catch(e) {}

  function buildNodeSelect() {
    nodeSelect.innerHTML = '';
    if (customNodes.length) {
      const og1 = document.createElement('optgroup');
      og1.label = 'Custom';
      customNodes.forEach(n => {
        const opt = document.createElement('option');
        opt.value = n.value;
        opt.textContent = n.label;
        og1.appendChild(opt);
      });
      nodeSelect.appendChild(og1);
    }
    Object.entries(NODES).forEach(([group, items]) => {
      const og = document.createElement('optgroup');
      og.label = group;
      Object.entries(items).forEach(([label, url]) => {
        const opt = document.createElement('option');
        opt.value = url;
        opt.textContent = label;
        og.appendChild(opt);
      });
      nodeSelect.appendChild(og);
    });
    if (savedUrl) {
      nodeSelect.value = savedUrl;
    }
  }
  buildNodeSelect();

  function getRunUrl() { return nodeSelect.value; }

  // URL validation
  function urlParser(str) {
    const m = str.match(/https?:\/\/([\w-]+\.)+[\w-]+(:[0-9]+)?(\/\S*)?/);
    return m ? m[0] : '';
  }

  async function checkUrl(url) {
    try {
      const u = new URL(url);
      if (BLOCK_LIST.some(b => u.host.endsWith(b))) {
        throw 'Blocked URL';
      }
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(url, { cache: 'no-store', mode: 'cors', referrerPolicy: 'no-referrer', signal: ctrl.signal });
      clearTimeout(tid);
      if (resp.status === 404) throw 'Resource not found (404)';
      if (!resp.body) throw 'No response body';
      const reader = resp.body.getReader();
      const { value, done } = await reader.read();
      if (!value || value.length <= 0) throw 'Empty response';
      reader.cancel();
      return { status: true, info: '' };
    } catch (err) {
      return { status: false, info: err instanceof Error ? err.message : String(err) };
    }
  }

  // Speed control
  async function speedCtr() {
    if (state.maxSpeed > 0 && (state.bytesUsed - state.recordUse) > state.maxSpeed / 8) {
      await new Promise(r => setTimeout(r, 1000 - (Date.now() % 1000)));
    }
  }

  // Thread
  async function startThread(index) {
    try {
      const url = getRunUrl();
      if (!url) { isRunning = false; updateUI(); return; }
      const resp = await fetch(url, { cache: 'no-store', mode: 'cors', referrerPolicy: 'no-referrer' });
      if (!resp.body) throw 'No body';
      const contentLength = resp.headers.get('content-length');
      const realLength = contentLength ? parseInt(contentLength) : Infinity;
      const reader = resp.body.getReader();
      let decodeLength = 0;
      while (true) {
        if (state.maxSpeed > 0) await speedCtr();
        const { value } = await reader.read();
        const chunkLen = value?.length;
        if (!chunkLen || nodeSelect.value !== url) {
          if (isRunning) startThread(index);
          break;
        }
        let useful = chunkLen;
        if (decodeLength >= realLength) {
          useful = 0;
        } else if (decodeLength + chunkLen > realLength) {
          useful = realLength - decodeLength;
        }
        state.bytesUsed += useful;
        if (index >= parseInt(threadSlider.value) || !isRunning) break;
        decodeLength += chunkLen;
      }
      reader.cancel();
    } catch (err) {
      console.error(err);
      if (isRunning) startThread(index);
    }
  }

  // UI update
  function updateUI() {
    totalDataEl.textContent = formatBytes(state.bytesUsed, [0, 0, 1, 2, 2, 2]);
    dataLimitEl.textContent = state.maxUse ? '/ ' + formatBytes(state.maxUse, [0, 0, 0, 0, 0, 0]) : '';
    speedLimitEl.textContent = state.maxSpeed ? '/ ' + formatBytes(state.maxSpeed * 8, [0, 0, 0, 2, 2, 2], 'bits') : '';
  }

  function setSpeed(speed) {
    if (speed <= 0 || isNaN(speed)) {
      speedEl.textContent = '-';
      bandwidthEl.textContent = '-';
      return;
    }
    speedEl.textContent = formatBytes(speed, [0, 0, 1, 2, 2, 2], 'speed');
    bandwidthEl.textContent = formatBytes(speed * 8, [0, 0, 0, 2, 2, 2], 'bits');
    $('#predMin').textContent = formatBytes(speed * 60, [0, 0, 0, 1, 1, 1], 'speed');
    $('#predHour').textContent = formatBytes(speed * 3600, [0, 0, 0, 1, 1, 1], 'speed');
    $('#predDay').textContent = formatBytes(speed * 86400, [0, 0, 0, 1, 1, 1], 'speed');
    $('#predMon').textContent = formatBytes(speed * 86400 * 30, [0, 0, 0, 1, 1, 1], 'speed');
  }

  function setTitle(speed = 0) {
    if (isRunning) {
      document.title = formatBytes(state.bytesUsed, [0, 0, 0, 0, 0, 0]) + ' ' + formatBytes(speed, [0, 0, 1, 2, 2, 2], 'speed');
    } else {
      document.title = 'NetProbe - Speed Test';
    }
  }

  // Frame / sec events
  function frameEvent() {
    if (!document.hidden) updateUI();
    if (state.maxUse > 0 && state.bytesUsed >= state.maxUse) {
      stopRunning();
    }
  }

  function secEvent() {
    const now = Date.now() / 1000;
    const speed = (state.bytesUsed - state.recordUse) / (now - state.recordTime);
    if (!isNaN(speed) && speed > 0) {
      updateChart(speed);
      setSpeed(speed);
      speedLabelEl.textContent = 'Realtime Speed';
      setTitle(speed);
    } else {
      speedEl.textContent = '-';
      bandwidthEl.textContent = '-';
    }
    state.recordUse = state.bytesUsed;
    state.recordTime = now;
  }

  function startRunning() {
    if (isRunning) return;
    isChecking = true;
    updatePlayBtn();
    checkUrl(getRunUrl()).then(result => {
      isChecking = false;
      if (!result.status) {
        toast('URL check failed: ' + result.info);
        updatePlayBtn();
        return;
      }
      isRunning = true;
      state.bytesUsed = 0;
      state.logged = 0;
      state.lastLogTime = Date.now() / 1000;
      state.startUse = 0;
      state.startTime = Date.now() / 1000;
      state.recordUse = 0;
      state.recordTime = Date.now() / 1000;
      chartData = [];
      chartSpeedBuf = [];
      chartStep = 1;
      clearChart();
      const n = parseInt(threadSlider.value);
      for (let i = 0; i < n; i++) startThread(i);
      tasks.push(setInterval(frameEvent, 16));
      tasks.push(setInterval(secEvent, 1000));
      if (bgToggle.checked) silentAudio.play().catch(() => {});
      updatePlayBtn();
    });
  }

  function stopRunning() {
    if (!isRunning) return;
    isRunning = false;
    tasks.forEach(clearInterval);
    tasks = [];
    silentAudio.pause();
    const speed = (state.bytesUsed - state.startUse) / (Date.now() / 1000 - state.startTime);
    if (!isNaN(speed)) setSpeed(speed);
    speedLabelEl.textContent = 'Average Speed';
    updatePlayBtn();
  }

  function updatePlayBtn() {
    const iconPlay = playBtn.querySelector('.icon-play');
    const iconPause = playBtn.querySelector('.icon-pause');
    const iconLoading = playBtn.querySelector('.icon-loading');
    iconPlay.style.display = 'none';
    iconPause.style.display = 'none';
    iconLoading.style.display = 'none';
    if (isChecking) {
      iconLoading.style.display = 'block';
    } else if (isRunning) {
      iconPause.style.display = 'block';
    } else {
      iconPlay.style.display = 'block';
    }
  }

  // Play button
  playBtn.addEventListener('click', () => {
    if (isChecking) return;
    if (isRunning) {
      stopRunning();
    } else {
      startRunning();
    }
  });

  // Thread slider
  threadSlider.addEventListener('input', () => {
    const v = parseInt(threadSlider.value);
    threadNumDisplay.textContent = v;
    localStorage.setItem('threadNum', v);
    if (isRunning) {
      const cur = tasks.length > 2 ? parseInt(threadSlider.value) : 0;
    }
  });

  // Toggles
  bgToggle.addEventListener('change', () => {
    localStorage.setItem('runBackground', bgToggle.checked);
  });
  autoToggle.addEventListener('change', () => {
    localStorage.setItem('autoStart', autoToggle.checked);
  });

  // Node select
  nodeSelect.addEventListener('change', () => {
    localStorage.setItem('url', nodeSelect.value);
  });

  // Copy URL
  $('#copyUrlBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(getRunUrl()).then(() => toast('URL copied'));
  });

  // Predict popup
  $('#predictBtn').addEventListener('click', (e) => {
    const pop = $('#predictPopup');
    if (pop.style.display === 'none') {
      const rect = e.target.getBoundingClientRect();
      pop.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
      pop.style.top = (rect.bottom + 8) + 'px';
      pop.style.display = 'block';
    } else {
      pop.style.display = 'none';
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#predictBtn') && !e.target.closest('#predictPopup')) {
      $('#predictPopup').style.display = 'none';
    }
  });

  // Chart toggle
  $('#chartToggle').addEventListener('click', () => {
    chartVisible = !chartVisible;
    chartWrap.style.display = chartVisible ? 'block' : 'none';
    if (chartVisible && myChart) {
      setTimeout(() => myChart.resize(), 50);
    }
  });

  // Fullscreen
  let fsTimer = 0;

  function startFsTimer() {
    if (fsTimer) return;
    fsTimer = setInterval(() => {
      if (fullscreenOverlay.style.display === 'none') {
        clearInterval(fsTimer);
        fsTimer = 0;
        return;
      }
      const d = new Date();
      $('#fsTime').textContent = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      $('#fsDate').textContent = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + ' ' + days[d.getDay()];
      $('#fsTotal').textContent = totalDataEl.textContent;
      $('#fsSpeed').textContent = speedEl.textContent;
      $('#fsBand').textContent = bandwidthEl.textContent;
    }, 1000);
  }

  $('#fullscreenBtn').addEventListener('click', () => {
    fullscreenOverlay.style.display = 'flex';
    startFsTimer();
  });

  fullscreenOverlay.addEventListener('click', () => {
    fullscreenOverlay.style.display = 'none';
  });

  // Edit nodes modal
  $('#editNodesBtn').addEventListener('click', () => {
    renderNodeModal();
    openModal('Manage URLs', renderNodeListHTML(), '<button class="btn-primary" id="addNodeBtn">Add URL</button>');
    $('#addNodeBtn').addEventListener('click', () => {
      openModal('Add URL', `
        <div class="form-group">
          <label class="form-label">Name</label>
          <input class="form-input" id="newNodeName" placeholder="My Server">
        </div>
        <div class="form-group">
          <label class="form-label">URL</label>
          <input class="form-input" id="newNodeUrl" placeholder="https://example.com/file">
        </div>
        <div class="alert alert-warn">Browser CORS policy may block some URLs.</div>
        <div class="alert alert-danger">Use at your own risk.</div>
      `, '<button class="btn-primary" id="confirmAddNode">Confirm</button>');
      $('#confirmAddNode').addEventListener('click', addCustomNode);
    });
    $$('.del-node-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        customNodes.splice(idx, 1);
        localStorage.setItem('customNodes', JSON.stringify(customNodes));
        buildNodeSelect();
        renderNodeModal();
        openModal('Manage URLs', renderNodeListHTML(), '<button class="btn-primary" id="addNodeBtn">Add URL</button>');
        $('#addNodeBtn').addEventListener('click', () => {
          openModal('Add URL', `
            <div class="form-group">
              <label class="form-label">Name</label>
              <input class="form-input" id="newNodeName" placeholder="My Server">
            </div>
            <div class="form-group">
              <label class="form-label">URL</label>
              <input class="form-input" id="newNodeUrl" placeholder="https://example.com/file">
            </div>
            <div class="alert alert-warn">Browser CORS policy may block some URLs.</div>
          `, '<button class="btn-primary" id="confirmAddNode">Confirm</button>');
          $('#confirmAddNode').addEventListener('click', addCustomNode);
        });
      });
    });
  });

  function renderNodeListHTML() {
    if (!customNodes.length) return '<div class="empty-msg">No custom URLs</div>';
    return '<ul class="node-list">' + customNodes.map((n, i) =>
      `<li>
        <span class="node-name">${esc(n.label)}</span>
        <span class="node-url">${esc(n.value)}</span>
        <button class="btn-danger del-node-btn" data-idx="${i}">Del</button>
      </li>`
    ).join('') + '</ul>';
  }

  function renderNodeModal() {}

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  async function addCustomNode() {
    const name = $('#newNodeName').value.trim();
    const url = urlParser($('#newNodeUrl').value);
    if (!name || !url) { toast('Please enter name and valid URL'); return; }
    const result = await checkUrl(url);
    if (!result.status) { toast('URL check failed: ' + result.info); return; }
    customNodes.push({ label: name, value: url });
    localStorage.setItem('customNodes', JSON.stringify(customNodes));
    buildNodeSelect();
    toast('URL added');
    closeModal();
  }

  // Edit max use
  $('#editMaxBtn').addEventListener('click', () => {
    openModal('Set Data Limit', `
      <div class="form-group">
        <div class="form-input-group">
          <input class="form-input" type="number" id="maxUseNum" min="1" placeholder="No limit">
          <select class="form-select" id="maxUseType">
            <option value="1048576">MB</option>
            <option value="1073741824" selected>GB</option>
            <option value="1099511627776">TB</option>
          </select>
        </div>
      </div>
    `, '<button class="btn-primary" id="confirmMaxUse">Confirm</button>');
    $('#confirmMaxUse').addEventListener('click', () => {
      const num = parseFloat($('#maxUseNum').value);
      const type = parseInt($('#maxUseType').value);
      state.maxUse = num ? Math.floor(num * type) : 0;
      localStorage.setItem('maxUse', state.maxUse);
      updateUI();
      closeModal();
    });
  });

  // Edit max speed
  $('#editSpeedBtn').addEventListener('click', () => {
    openModal('Set Bandwidth Limit', `
      <div class="form-group">
        <div class="form-input-group">
          <input class="form-input" type="number" id="maxSpeedNum" min="1" placeholder="No limit">
          <select class="form-select" id="maxSpeedType">
            <option value="1024">Kbps</option>
            <option value="1048576" selected>Mbps</option>
            <option value="1073741824">Gbps</option>
          </select>
        </div>
      </div>
      <div class="alert alert-warn">Browser caching limits bandwidth control to average speed only.</div>
    `, '<button class="btn-primary" id="confirmMaxSpeed">Confirm</button>');
    $('#confirmMaxSpeed').addEventListener('click', () => {
      const num = parseFloat($('#maxSpeedNum').value);
      const type = parseInt($('#maxSpeedType').value);
      state.maxSpeed = num ? Math.floor(num * type) : 0;
      localStorage.setItem('maxSpeed', state.maxSpeed);
      updateUI();
      closeModal();
    });
  });

  // Modal close
  $('#modalClose').addEventListener('click', closeModal);
  $('#modalOverlay').addEventListener('click', (e) => {
    if (e.target === $('#modalOverlay')) closeModal();
  });

  // About
  $('#aboutBtn').addEventListener('click', () => {
    openModal('About', `
      <div style="line-height:1.8">
        <strong>NetProbe</strong><br>
        Based on <a href="https://github.com/ljxi/NetworkPanel" target="_blank" style="color:var(--primary)">NetworkPanel</a><br><br>
      </div>
    `);
  });

  // Clipboard paste
  document.addEventListener('paste', (e) => {
    if (!e.clipboardData || !e.clipboardData.items) return;
    if (document.activeElement?.nodeName === 'INPUT') return;
    for (let i = 0; i < e.clipboardData.items.length; i++) {
      const item = e.clipboardData.items[i];
      if (item.type === 'text/plain') {
        item.getAsString(async (str) => {
          const url = urlParser(str);
          if (!url) return;
          toast('Checking URL from clipboard...');
          const result = await checkUrl(url);
          if (result.status) {
            const exists = customNodes.some(n => n.value === url);
            if (!exists) {
              customNodes.push({ label: 'Clipboard', value: url });
              localStorage.setItem('customNodes', JSON.stringify(customNodes));
              buildNodeSelect();
            }
            nodeSelect.value = url;
            localStorage.setItem('url', url);
            toast('URL loaded from clipboard');
          } else {
            toast('Clipboard URL failed: ' + result.info);
          }
        });
        break;
      }
    }
  });

  // Visibility
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isRunning) {
      updateUI();
      setTitle(state.bytesUsed > 0 ? (state.bytesUsed - state.recordUse) / (Date.now() / 1000 - state.recordTime) : 0);
    }
  });

  // Double-tap zoom prevention
  let lastTouchEnd = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 300) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  // IP info (Cloudflare trace)
  async function loadIPInfo() {
    const ipInfo = $('#ipInfo');
    try {
      const cfResp = await fetch('https://cp.cloudflare.com/cdn-cgi/trace', { referrerPolicy: 'no-referrer' });
      const cfText = await cfResp.text();
      const cfIP = cfText.match(/ip=([0-9a-f.:]+)/);
      const cfLoc = cfText.match(/loc=([A-Z]+)/);
      const cfColo = cfText.match(/colo=([A-Z]+)/);

      let html = '';
      if (cfIP) {
        html += `<div class="ip-item">
          <span class="ip-tag cloudflare">CF</span>
          <span class="ip-text">${cfIP[1]} ${cfLoc ? cfLoc[1] : ''} ${cfColo ? cfColo[1] : ''}</span>
        </div>`;
      }
      html += `<div class="ip-item">
        <span class="ip-tag clay" id="latencyTag">-</span>
        <span class="ip-text">Latency</span>
      </div>`;

      ipInfo.innerHTML = html || '<span class="ip-loading">Unable to load IP info</span>';
    } catch (e) {
      const ipInfo = $('#ipInfo');
      if (!ipInfo.querySelector('.ip-tag')) {
        ipInfo.innerHTML = `<div class="ip-item">
          <span class="ip-tag clay" id="latencyTag">-</span>
          <span class="ip-text">Latency</span>
        </div>`;
      }
    }
  }

  // Latency check (every 1 second)
  async function checkLatency() {
    const tag = $('#latencyTag');
    if (!tag) return;
    try {
      const t0 = Date.now();
      await fetch('https://connectivitycheck.platform.hicloud.com/generate_204', { method: 'HEAD', cache: 'no-store', mode: 'no-cors', referrerPolicy: 'no-referrer' });
      tag.textContent = (Date.now() - t0) + 'ms';
    } catch (e) {
      tag.textContent = '-ms';
    }
  }

  loadIPInfo();
  setInterval(loadIPInfo, 60000);
  setInterval(checkLatency, 1000);

  // ECharts
  function initChart() {
    if (myChart) return;
    const el = document.getElementById('chart');
    if (!el) return;
    myChart = echarts.init(el);
    const option = {
      animation: true,
      animationDuration: 800,
      animationEasing: 'cubicOut',
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(15,23,42,0.9)',
        borderColor: 'transparent',
        textStyle: { color: '#e2e8f0', fontSize: 13 },
        formatter: (params) => {
          const p = params[0];
          const t = new Date(p.data[0] * 1000);
          const ts = t.getHours().toString().padStart(2, '0') + ':' + t.getMinutes().toString().padStart(2, '0') + ':' + t.getSeconds().toString().padStart(2, '0');
          return ts + '<br/>' + formatBytes(p.data[1], [0, 0, 1, 2, 2, 2], 'speed');
        }
      },
      xAxis: {
        type: 'time',
        boundaryGap: false,
        axisLabel: {
          show: true,
          color: '#94a3b8',
          fontSize: 11,
          formatter: (val) => {
            const d = new Date(val);
            return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0') + ':' + d.getSeconds().toString().padStart(2, '0');
          }
        },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: '#334155' } },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value',
        axisLabel: {
          show: true,
          color: '#94a3b8',
          fontSize: 11,
          formatter: v => formatBytes(v, [0, 0, 0, 0, 0, 0], 'speed')
        },
        splitLine: { lineStyle: { color: '#1e293b', type: 'dashed' } },
        axisLine: { show: false }
      },
      series: [{
        type: 'line',
        smooth: 0.3,
        symbol: 'none',
        lineStyle: { width: 2, color: '#818cf8' },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(129,140,248,0.35)' },
              { offset: 1, color: 'rgba(129,140,248,0.02)' }
            ]
          }
        },
        data: [[Date.now() / 1000, 0]]
      }],
      grid: { x: 50, y: 30, x2: 16, y2: 28 }
    };
    myChart.setOption(option);
    window.addEventListener('resize', () => myChart && myChart.resize());
  }

  function clearChart() {
    chartSpeedBuf = [];
    chartData = [[Date.now() / 1000, 0]];
    chartStep = 1;
    if (myChart) {
      myChart.setOption({
        series: [{
          data: [[Date.now() / 1000, 0]]
        }]
      });
    }
  }

  function updateChart(speed) {
    if (!chartVisible) return;
    if (!myChart) initChart();
    if (!myChart) return;
    let refresh = false;
    chartSpeedBuf.push(speed);
    while (chartSpeedBuf.length >= chartStep) {
      refresh = true;
      const tmp = chartSpeedBuf.splice(0, chartStep);
      const avg = tmp.includes(0) ? 0 : tmp.reduce((a, b) => a + b, 0) / chartStep;
      chartData.push([Date.now() / 1000, avg]);
    }
    while (chartData.length >= 200) {
      refresh = true;
      const result = [];
      const len = chartData.length % 2 === 0 ? chartData.length : chartData.length - 1;
      for (let i = 0; i < len; i += 2) {
        result.push([chartData[i][0], (chartData[i][1] + chartData[i + 1][1]) / 2]);
      }
      chartData = result;
      chartStep *= 2;
    }
    if (refresh) {
      myChart.setOption({ series: [{ data: chartData }] });
    }
  }

  // Clear chart every 5 minutes
  setInterval(() => {
    if (isRunning && chartVisible) clearChart();
  }, 5 * 60 * 1000);

  // Init
  updateUI();
  updatePlayBtn();
  if (autoToggle.checked) startRunning();
})();
