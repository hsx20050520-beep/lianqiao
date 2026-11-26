(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const views = [...document.querySelectorAll('.view')];
  const qualities = {
    original: { quality: 0.92, maxWidth: Number.MAX_SAFE_INTEGER, bitrate: 12_000_000, scale: 1 },
    high: { quality: 0.84, maxWidth: 1920, bitrate: 6_000_000, scale: 1 },
    balanced: { quality: 0.68, maxWidth: 1280, bitrate: 3_000_000, scale: 1.5 },
    low: { quality: 0.52, maxWidth: 854, bitrate: 1_200_000, scale: 3 },
  };
  const qualityLabels = { original: '原画', high: '高清', balanced: '均衡', low: '省流' };
  const state = {
    mode: 'host',
    phase: 'idle',
    room: '',
    name: '',
    peerName: '',
    device: null,
    bindings: [],
    transport: { connected: false, pollController: null, frameController: null, frameVersion: 0, controlVersion: 0, frameLoopRunning: false },
    intentionalClose: false,
    approved: false,
    pointerAllowed: true,
    chatAllowed: true,
    pointerEnabled: true,
    quality: 'original',
    fps: 30,
    remoteMobile: false,
    webrtcActive: false,
    webrtcRtt: null,
    usingTurn: false,
    webrtcSetupPromise: null,
    webrtcGeneration: 0,
    peerConnection: null,
    pendingIce: [],
    captureStream: null,
    captureTimer: null,
    captureRaf: 0,
    testPainter: null,
    captureCanvas: document.createElement('canvas'),
    probeCanvas: document.createElement('canvas'),
    blackFrameCount: 0,
    captureWarningShown: false,
    decodeErrorShown: false,
    capturing: false,
    hasFrame: false,
    sessionStart: 0,
    sessionTimer: null,
    statsTimer: null,
    pingTimer: null,
    frameBytes: 0,
    frameCount: 0,
    lastStatsBytes: 0,
    lastStatsAt: 0,
    lastPingAt: 0,
    pointerPending: null,
    pointerFrame: 0,
    lastPointerSent: 0,
    pointerHideTimer: null,
    chatTotal: 0,
  };

  function isMobileDevice() {
    return Boolean(navigator.userAgentData?.mobile) || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function safeName(value, fallback) {
    const clean = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
    return clean || fallback;
  }

  function generateCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  }

  function normalizeCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  }

  function formatCode(value) {
    const code = normalizeCode(value);
    return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
  }

  function isLocalDev() {
    return ['127.0.0.1', 'localhost'].includes(location.hostname);
  }

  function relayOrigin() {
    return isLocalDev() ? 'http://127.0.0.1:8010' : location.origin;
  }

  function relayUrl(op, extra = {}) {
    const url = new URL(`${relayOrigin()}/functions/v1/app`);
    url.search = new URLSearchParams({ action: 'relay', op, room: state.room, role: state.mode, name: state.name, ...extra }).toString();
    return url.toString();
  }

  function showOnly(id) {
    views.forEach((view) => view.classList.toggle('is-visible', view.id === id));
  }

  function toast(message, type = '') {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    $('toastRegion').appendChild(node);
    setTimeout(() => node.remove(), 3600);
  }

  async function copyText(text, successMessage) {
    try {
      await navigator.clipboard.writeText(text);
      toast(successMessage, 'success');
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      toast(copied ? successMessage : '复制失败，请手动复制', copied ? 'success' : 'error');
    }
  }

  function setRelay(status, label) {
    $('relayPill').classList.toggle('connected', status === 'connected');
    $('relayPill').classList.toggle('error', status === 'error');
    $('relayLabel').textContent = label;
  }

  function clearTimers() {
    clearInterval(state.sessionTimer);
    clearInterval(state.statsTimer);
    clearInterval(state.pingTimer);
    state.sessionTimer = null;
    state.statsTimer = null;
    state.pingTimer = null;
  }

  function startTimers() {
    clearTimers();
    state.sessionStart = Date.now();
    state.sessionTimer = setInterval(updateTimer, 1000);
    state.statsTimer = setInterval(updateStats, 1000);
    state.pingTimer = setInterval(sendPing, 5000);
    updateTimer();
    sendPing();
  }

  function updateTimer() {
    const seconds = Math.max(0, Math.floor((Date.now() - state.sessionStart) / 1000));
    const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
    const rest = (seconds % 60).toString().padStart(2, '0');
    $('sessionTimer').textContent = `${minutes}:${rest}`;
  }

  async function updateStats() {
    if (state.webrtcActive && state.peerConnection) {
      try {
        const reports = await state.peerConnection.getStats();
        const localCandidateTypes = new Map();
        const remoteCandidateTypes = new Map();
        reports.forEach((report) => {
          if (report.type === 'local-candidate') localCandidateTypes.set(report.id, report.candidateType);
          if (report.type === 'remote-candidate') remoteCandidateTypes.set(report.id, report.candidateType);
        });
        let fps = state.fps;
        let totalBytes = 0;
        reports.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            const localType = report.localCandidateType || localCandidateTypes.get(report.localCandidateId);
            const remoteType = report.remoteCandidateType || remoteCandidateTypes.get(report.remoteCandidateId);
            state.usingTurn = localType === 'relay' || remoteType === 'relay';
            if (Number.isFinite(report.currentRoundTripTime)) {
              state.webrtcRtt = Math.max(1, Math.round(report.currentRoundTripTime * 1000));
            }
          }
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            fps = Number(report.framesPerSecond || fps);
            totalBytes = Number(report.bytesReceived || 0);
          } else if (report.type === 'outbound-rtp' && report.kind === 'video') {
            fps = Number(report.framesPerSecond || fps);
            totalBytes = Number(report.bytesSent || 0);
          }
        });
        const now = performance.now();
        const elapsed = state.lastStatsAt ? (now - state.lastStatsAt) / 1000 : 1;
        const kbps = state.lastStatsAt ? Math.max(0, (totalBytes - state.lastStatsBytes) / 1024 / elapsed) : 0;
        state.lastStatsBytes = totalBytes;
        state.lastStatsAt = now;
        $('mediaStats').textContent = `${Math.round(fps)} fps · ${Math.round(kbps)} KB/s`;
        const mediaQuality = state.remoteMobile ? '安卓兼容' : qualityLabels[state.quality];
        $('mediaBadgeText').textContent = `${state.usingTurn ? 'TURN 加密' : 'WebRTC 直连'} ${mediaQuality} · ${state.fps} fps${state.webrtcRtt ? ` · ${state.webrtcRtt}ms` : ''}`;
        $('mediaShell').dataset.transport = state.usingTurn ? 'turn' : 'webrtc';
        $('activePeerDetail').textContent = `${mediaQuality} · ${state.usingTurn ? 'TURN 加密' : '直连'} · ${state.fps} fps`;
        return;
      } catch {}
    }
    const fps = state.frameCount;
    const kbps = Math.round(state.frameBytes / 1024);
    $('mediaStats').textContent = `${fps} fps · ${kbps} KB/s`;
    state.frameCount = 0;
    state.frameBytes = 0;
  }

  function sendPing() {
    if (state.phase !== 'active' || !state.transport.connected) return;
    state.lastPingAt = performance.now();
    sendJson({ type: 'ping', at: Date.now() });
  }

  async function sendJson(payload) {
    if (!state.transport.connected) return false;
    try {
      const response = await fetch(relayUrl('send'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: state.room, role: state.mode, name: state.name, ...payload }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function sendFrame(buffer) {
    if (!state.transport.connected) return false;
    try {
      const response = await fetch(relayUrl('frame'), { method: 'POST', body: buffer });
      return response.ok;
    } catch {
      return false;
    }
  }

  function render() {
    const active = state.phase === 'active';
    $('hostTab').classList.toggle('active', state.mode === 'host');
    $('controllerTab').classList.toggle('active', state.mode === 'controller');
    $('hostTab').setAttribute('aria-selected', String(state.mode === 'host'));
    $('controllerTab').setAttribute('aria-selected', String(state.mode === 'controller'));

    const titles = {
      idle: state.mode === 'host' ? '准备共享' : '准备连接',
      connecting: '正在建立加密连接',
      waiting: state.mode === 'host' ? '等待对方加入' : '等待对方确认',
      pending: '等待你的确认',
      active: '远程协助进行中',
      error: '连接已中断',
    };
    $('stageTitle').textContent = titles[state.phase] || '准备开始';
    $('stageDot').classList.toggle('live', ['connecting', 'waiting', 'pending'].includes(state.phase));
    $('stageDot').classList.toggle('stage-dot-active', active);
    $('stageMeta').textContent = active ? 'HTTPS 加密中转 · 对方已授权' : '端到端配对 · 显式授权';
    $('stageMeta').hidden = active && state.mode === 'host';

    const badges = { idle: '未连接', connecting: '连接中', waiting: '等待中', pending: '待确认', active: '已连接', error: '已断开' };
    $('sessionBadge').textContent = badges[state.phase] || '未连接';
    $('sessionBadge').classList.toggle('active', active);
    $('permissionSummary').textContent = active ? (state.mode === 'host' ? `指针${state.pointerAllowed ? '开' : '关'} · 聊天${state.chatAllowed ? '开' : '关'}` : '由对方控制') : '等待授权';

    $('pointerPermission').disabled = state.mode !== 'host';
    $('chatPermission').disabled = state.mode !== 'host';
    $('pointerPermission').checked = state.pointerAllowed;
    $('chatPermission').checked = state.chatAllowed;
    $('pointerButton').disabled = !state.pointerAllowed;
    $('pointerButton').classList.toggle('active', state.pointerEnabled && state.pointerAllowed);
    $('pointerButton').setAttribute('aria-pressed', String(state.pointerEnabled && state.pointerAllowed));
    $('chatInput').disabled = !active || !state.chatAllowed;
    $('chatSend').disabled = !active || !state.chatAllowed;

    const activeBinding = bindingForRole(state.mode);
    $('hostSubmitText').textContent = activeBinding?.role === 'host' ? '创建已绑定会话' : '创建协助会话';
    $('controllerSubmitText').textContent = activeBinding?.role === 'controller' ? '连接已绑定设备' : '连接会话';
    $('joinCodeField').hidden = activeBinding?.role === 'controller';
    $('codeHint').textContent = activeBinding?.role === 'controller' ? `已绑定：${activeBinding.peerName}，无需配对码。` : '配对码由被协助端生成，仅在本次会话有效。';

    $('hostVideo').hidden = state.mode !== 'host';
    $('hostCanvas').hidden = state.mode !== 'host' || !state.captureStream || state.webrtcActive;
    $('remoteVideo').hidden = state.mode !== 'controller' || !state.webrtcActive;
    $('remoteCanvas').hidden = state.mode !== 'controller' || state.webrtcActive;
    $('controllerToolbar').hidden = state.mode !== 'controller' || !active;
    $('diagnosticShareButton').hidden = state.mode !== 'host' || !active;
    $('diagnosticButton').hidden = state.mode !== 'host' || !active;
    $('stopSharingButton').hidden = state.mode !== 'host' || !active;
    $('startSharingButton').hidden = state.mode !== 'host' || !active || Boolean(state.captureStream);
    $('testPatternButton').hidden = state.mode !== 'host' || !active || Boolean(state.captureStream);
    $('mediaPlaceholder').hidden = state.mode === 'host' ? Boolean(state.captureStream) : (state.hasFrame || state.webrtcActive);
    $('qualitySelect').value = state.quality;
    $('fpsSelect').value = String(state.fps);
    $('mediaShell').dataset.quality = state.quality;
    $('mediaShell').dataset.fps = String(state.fps);
    $('mediaShell').dataset.transport = state.webrtcActive ? (state.usingTurn ? 'turn' : 'webrtc') : 'relay';

    if (active) {
      const mediaQuality = state.remoteMobile ? '安卓兼容' : qualityLabels[state.quality];
      $('activePeerName').textContent = state.peerName || (state.mode === 'host' ? '协助者' : '被协助者');
      $('peerAvatar').textContent = (state.peerName || '协').slice(0, 1);
      $('activePeerDetail').textContent = state.mode === 'host'
        ? (state.webrtcActive ? `${mediaQuality} · ${state.usingTurn ? 'TURN 加密' : '直连'} · ${state.fps} fps` : state.captureStream ? '兼容中转 · 省流模式' : '等待开始共享')
        : (state.webrtcActive ? `${mediaQuality} · ${state.usingTurn ? 'TURN 加密' : '直连'} · ${state.fps} fps` : state.hasFrame ? '兼容中转接收中' : '等待对方共享');
      $('mediaBadgeText').textContent = state.captureWarningShown
        ? '检测到全黑画面 · 请重新选择窗口'
        : state.webrtcActive
          ? `${state.usingTurn ? 'TURN 加密' : 'WebRTC 直连'} ${mediaQuality} · ${state.fps} fps${state.webrtcRtt ? ` · ${state.webrtcRtt}ms` : ''}`
          : state.mode === 'host'
            ? (state.captureStream ? '兼容中转 · 正在共享' : '已连接 · 等待你开始共享')
            : (state.hasFrame ? '正在接收共享画面' : '已连接 · 等待对方共享');
    }

    $('stageFooterText').textContent = state.mode === 'host'
      ? '你可以随时停止共享；网页版不会远程操作键鼠或打开文件。'
      : '移动指针即可让对方看到位置；点击画面可发送强调提示。';
    $('permissionNote').innerHTML = state.mode === 'host'
      ? '<svg><use href="#i-info"></use></svg>网页版不会远程操作键鼠或打开文件。'
      : '<svg><use href="#i-info"></use></svg>共享权限由被协助端实时控制。';
  }

  function setMode(mode, force = false) {
    if (mode === state.mode && state.phase === 'idle') return;
    if (!force && state.phase !== 'idle') {
      if (!confirm('切换角色会结束当前会话，确定继续吗？')) return;
      endSession(false, '已切换角色');
    }
    state.mode = mode;
    state.phase = 'idle';
    showOnly(mode === 'host' ? 'hostIdleView' : 'controllerIdleView');
    render();
  }

  function loadDeviceIdentity() {
    try {
      const saved = JSON.parse(localStorage.getItem('lianqiao.device.v1') || 'null');
      if (saved?.id && saved?.secret) return saved;
    } catch {}
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const secret = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const device = { id: crypto.randomUUID(), secret, name: safeName($('hostName').value || $('controllerName').value, '我的设备') };
    try { localStorage.setItem('lianqiao.device.v1', JSON.stringify(device)); } catch {}
    return device;
  }

  async function deviceRequest(op, payload = {}) {
    if (!state.device) throw new Error('设备尚未注册');
    const url = new URL(`${relayOrigin()}/functions/v1/app`);
    url.search = new URLSearchParams({ action: 'device', op }).toString();
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, deviceId: state.device.id, secret: state.device.secret, ...payload }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '设备服务暂时不可用');
    return data;
  }

  async function registerDevice() {
    state.device = loadDeviceIdentity();
    $('deviceName').value = state.device.name;
    try {
      await deviceRequest('register', { name: state.device.name });
      await refreshBindings();
    } catch {}
  }

  function bindingForRole(role) {
    return state.bindings.find((binding) => binding.role === role) || null;
  }

  function renderBindings() {
    const box = $('bindingList');
    box.replaceChildren();
    $('bindingCount').textContent = String(state.bindings.length);
    if (!state.bindings.length) {
      const empty = document.createElement('p');
      empty.className = 'binding-empty';
      empty.textContent = '还没有绑定设备。';
      box.appendChild(empty);
      return;
    }
    state.bindings.forEach((binding) => {
      const row = document.createElement('div');
      row.className = 'binding-item';
      const info = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = binding.peerName;
      const role = document.createElement('small');
      role.textContent = binding.role === 'host' ? '对方作为协助端' : '对方作为被协助端';
      info.append(name, role);
      const actions = document.createElement('div');
      actions.className = 'binding-item-actions';
      const connect = document.createElement('button');
      connect.type = 'button';
      connect.className = 'secondary-button';
      connect.textContent = '连接';
      connect.addEventListener('click', () => {
        $('bindingDialog').close();
        setMode(binding.role, true);
        state.name = safeName(state.device.name, binding.role === 'host' ? '被协助端' : '协助者');
        state.room = '';
        connectRelay();
      });
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'text-button danger-text';
      revoke.textContent = '解绑';
      revoke.addEventListener('click', async () => {
        if (!confirm(`确定解绑“${binding.peerName}”吗？`)) return;
        try {
          await deviceRequest('bind-revoke', { bindingId: binding.id });
          await refreshBindings();
          render();
        } catch (error) {
          toast(error instanceof Error ? error.message : '解绑失败', 'error');
        }
      });
      actions.append(connect, revoke);
      row.append(info, actions);
      box.appendChild(row);
    });
  }

  async function refreshBindings() {
    try {
      const data = await deviceRequest('bind-list');
      state.bindings = Array.isArray(data.bindings) ? data.bindings : [];
    } catch {
      state.bindings = [];
    }
    renderBindings();
    render();
  }

  async function connectRelay() {
    state.intentionalClose = false;
    state.remoteMobile = false;
    state.phase = 'connecting';
    const binding = bindingForRole(state.mode);
    $('displayCode').textContent = binding ? '已绑定设备' : formatCode(state.room);
    $('waitingKicker').textContent = state.mode === 'host' ? '会话已创建' : '正在连接';
    $('waitingTitle').textContent = state.mode === 'host' ? '等待协助者加入' : '等待对方确认';
    $('waitingCopy').textContent = state.mode === 'host' ? '把配对码或邀请链接发给信任的人。' : '连接请求已发送，请等待被协助端确认。';
    showOnly('waitingView');
    render();

    try {
      if (binding) {
        const op = state.mode === 'host' ? 'create-bound' : 'join-bound';
        const data = await deviceRequest(op, { bindingId: binding.id });
        state.room = String(data.room || '');
        if (!state.room) throw new Error('绑定会话不可用');
      } else {
        const op = state.mode === 'host' ? 'create' : 'join';
        const response = await fetch(relayUrl(op), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ room: state.room, name: state.name }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          const messages = { 404: '没有找到这个会话，请检查配对码', 409: '会话或角色已被占用', 429: '连接过于频繁，请稍后再试' };
          throw new Error(messages[response.status] || data.error || '无法连接中转服务');
        }
      }
      state.transport.connected = true;
      state.transport.frameVersion = 0;
      state.transport.controlVersion = 0;
      state.phase = 'waiting';
      setRelay('connected', 'HTTPS 中转已连接');
      if (state.mode === 'controller') {
        $('waitingKicker').textContent = '连接请求已发送';
        $('waitingTitle').textContent = '等待对方确认';
        $('waitingCopy').textContent = '被协助端会看到你的称呼；同意后才会开始传输。';
      } else if (binding) {
        $('waitingCopy').textContent = '已通过设备绑定创建会话，无需再发送配对码。';
      }
      showOnly('waitingView');
      render();
      pollLoop();
    } catch (error) {
      handleDisconnect(error instanceof Error ? error.message : '无法连接中转服务');
    }
  }

  async function pollLoop() {
    while (state.transport.connected) {
      const controller = new AbortController();
      state.transport.pollController = controller;
      try {
        const response = await fetch(relayUrl('poll', { after: String(state.transport.controlVersion) }), { signal: controller.signal, cache: 'no-store' });
        if (response.status === 410) {
          handleDisconnect('会话已结束');
          return;
        }
        if (response.status === 204) continue;
        if (!response.ok) throw new Error('中转连接异常');
        const data = await response.json();
        if (Number.isSafeInteger(data.after)) state.transport.controlVersion = data.after;
        if (Array.isArray(data.messages)) data.messages.forEach(handleRelayMessage);
      } catch (error) {
        if (!state.transport.connected || controller.signal.aborted) return;
        handleDisconnect(error instanceof Error ? error.message : '中转连接已断开');
        return;
      } finally {
        if (state.transport.pollController === controller) state.transport.pollController = null;
      }
    }
  }

  async function startFrameLoop() {
    if (state.mode !== 'controller' || state.transport.frameLoopRunning || !state.transport.connected) return;
    state.transport.frameLoopRunning = true;
    while (state.transport.connected && state.approved) {
      const controller = new AbortController();
      state.transport.frameController = controller;
      try {
        const response = await fetch(relayUrl('frame-poll', { after: String(state.transport.frameVersion) }), { signal: controller.signal, cache: 'no-store' });
        if (response.status === 410) {
          handleDisconnect('会话已结束');
          return;
        }
        if (response.status === 204) continue;
        if (!response.ok) throw new Error('画面中转异常');
        const buffer = await response.arrayBuffer();
        state.transport.frameVersion = Number(response.headers.get('X-Frame-Version') || state.transport.frameVersion + 1);
        if (buffer.byteLength) drawRemoteFrame(buffer);
      } catch (error) {
        if (!state.transport.connected || controller.signal.aborted) return;
        handleDisconnect(error instanceof Error ? error.message : '画面中转已断开');
        return;
      } finally {
        if (state.transport.frameController === controller) state.transport.frameController = null;
      }
    }
    state.transport.frameLoopRunning = false;
  }

  function closeTransport() {
    state.transport.connected = false;
    state.transport.pollController?.abort();
    state.transport.frameController?.abort();
    state.transport.pollController = null;
    state.transport.frameController = null;
    state.transport.frameLoopRunning = false;
  }

  function handleRelayMessage(message) {
    if (!message || typeof message.type !== 'string') return;

    switch (message.type) {
      case 'ready':
        state.phase = 'waiting';
        if (state.mode === 'controller') {
          $('waitingKicker').textContent = '连接请求已发送';
          $('waitingTitle').textContent = '等待对方确认';
          $('waitingCopy').textContent = '被协助端会看到你的称呼；同意后才会开始传输。';
        }
        showOnly('waitingView');
        render();
        break;
      case 'peer-joined':
        if (state.mode !== 'host') return;
        state.peerName = safeName(message.name, '协助者');
        state.phase = 'pending';
        $('peerName').textContent = state.peerName;
        showOnly('approvalView');
        render();
        break;
      case 'approved':
        state.approved = true;
        state.phase = 'active';
        state.peerName = safeName(message.peerName, state.mode === 'host' ? '协助者' : '被协助者');
        state.pointerAllowed = message.pointer !== false;
        state.chatAllowed = message.chat !== false;
        state.hasFrame = false;
        showOnly('activeView');
        addChat('会话已建立，可以开始协助。', 'system', true);
        startTimers();
        render();
        if (state.mode === 'controller') {
          sendJson({ type: 'media-settings', quality: state.quality, fps: state.fps, mobile: isMobileDevice() });
          ensureWebRTC();
          startFrameLoop();
        }
        toast('连接成功', 'success');
        break;
      case 'rejected':
        toast('对方拒绝了本次连接', 'error');
        endSession(false, '对方拒绝了连接');
        break;
      case 'peer-left':
        addChat('对方已断开连接。', 'system', true);
        if (state.mode === 'controller') {
          handleDisconnect('对方已结束会话');
        } else {
          stopCapture(false);
          clearTimers();
          state.approved = false;
          state.phase = 'waiting';
          state.peerName = '';
          state.hasFrame = false;
          $('waitingKicker').textContent = '会话仍保留';
          $('waitingTitle').textContent = '协助者已断开';
          $('waitingCopy').textContent = '会话暂时保留，等待对方重新加入并确认。';
          showOnly('waitingView');
          render();
        }
        break;
      case 'permissions':
        state.pointerAllowed = Boolean(message.pointer);
        state.chatAllowed = Boolean(message.chat);
        render();
        break;
      case 'chat':
        if (typeof message.text === 'string') addChat(message.text.slice(0, 500), message.from === state.mode ? 'own' : 'peer');
        break;
      case 'cursor':
        if (state.mode === 'host' && state.pointerAllowed && Number.isFinite(message.x) && Number.isFinite(message.y)) {
          showRemotePointer(message.x, message.y, Boolean(message.click));
        }
        break;
      case 'media-settings':
        if (state.mode === 'host' && qualities[message.quality] && [15, 24, 30, 60].includes(Number(message.fps))) {
          const mobileChanged = state.remoteMobile !== Boolean(message.mobile);
          state.quality = message.quality;
          state.fps = Number(message.fps);
          state.remoteMobile = Boolean(message.mobile);
          applyQuality(state.quality);
          applyFps(state.fps);
          if (mobileChanged && state.peerConnection && state.captureStream) {
            closeWebRTC();
            setupWebRTC(state.captureStream);
          }
          render();
        }
        break;
      case 'webrtc-offer':
        if (state.mode === 'controller') handleWebRTCOffer(message.sdp);
        break;
      case 'webrtc-answer':
        if (state.mode === 'host') handleWebRTCAnswer(message.sdp);
        break;
      case 'webrtc-ice':
        handleWebRTCIce(message.candidate);
        break;
      case 'quality':
        if (state.mode === 'host' && qualities[message.value]) applyQuality(message.value);
        break;
      case 'screen-stopped':
        if (state.mode === 'controller') {
          state.hasFrame = false;
          clearRemoteCanvas();
          render();
        }
        break;
      case 'pong':
        if (state.lastPingAt) {
          $('latencyValue').textContent = `${Math.max(1, Math.round(performance.now() - state.lastPingAt))} ms`;
          state.lastPingAt = 0;
        }
        break;
      case 'error':
        toast(safeName(message.message, '会话出现错误'), 'error');
        break;
    }
  }

  function handleDisconnect(message) {
    closeTransport();
    stopCapture(false);
    clearTimers();
    state.approved = false;
    state.hasFrame = false;
    state.phase = 'error';
    state.room = '';
    state.peerName = '';
    clearRemoteCanvas();
    $('remotePointer').hidden = true;
    addChat(message, 'system', true);
    showOnly(state.mode === 'host' ? 'hostIdleView' : 'controllerIdleView');
    setRelay('error', '中转连接已断开');
    render();
    toast(message, 'error');
    setTimeout(() => {
      if (state.phase === 'error') {
        state.phase = 'idle';
        render();
      }
    }, 2200);
  }

  function endSession(notify = true, systemMessage = '会话已结束') {
    state.intentionalClose = true;
    if (notify) sendJson({ type: 'bye' });
    closeTransport();
    stopCapture(false);
    clearTimers();
    state.approved = false;
    state.hasFrame = false;
    state.phase = 'idle';
    state.room = '';
    state.peerName = '';
    state.intentionalClose = false;
    clearRemoteCanvas();
    $('remotePointer').hidden = true;
    $('latencyValue').textContent = '—';
    $('mediaStats').textContent = '0 fps · 0 KB/s';
    addChat(systemMessage, 'system', true);
    showOnly(state.mode === 'host' ? 'hostIdleView' : 'controllerIdleView');
    setRelay('', '中转服务待连接');
    render();
  }

  function addChat(text, from, system = false) {
    const box = $('chatMessages');
    const empty = box.querySelector('.chat-empty');
    if (empty) empty.remove();
    const node = document.createElement('div');
    node.className = `chat-message ${system ? 'system' : from === 'own' ? 'own' : ''}`;
    const body = document.createElement('span');
    body.textContent = text;
    node.appendChild(body);
    if (!system) {
      state.chatTotal += 1;
      $('chatCount').textContent = String(state.chatTotal);
      const time = document.createElement('time');
      time.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      node.appendChild(time);
    }
    box.appendChild(node);
    box.scrollTop = box.scrollHeight;
  }

  function sendChat(text) {
    const clean = String(text || '').trim().slice(0, 500);
    if (!clean || !state.chatAllowed || state.phase !== 'active') return;
    if (sendJson({ type: 'chat', text: clean })) {
      addChat(clean, 'own');
      $('chatInput').value = '';
    }
  }

  async function waitForFirstFrame() {
    const video = $('hostVideo');
    if (!video.requestVideoFrameCallback) return;
    await Promise.race([
      new Promise((resolve) => video.requestVideoFrameCallback(resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }

  async function startCapture() {
    if (state.mode !== 'host' || state.phase !== 'active') return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast('当前浏览器不支持屏幕共享，请使用电脑版 Chrome 或 Edge', 'error');
      return;
    }
    $('startSharingButton').disabled = true;
    try {
      stopCapture(false);
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor', frameRate: { ideal: state.fps, max: state.fps } },
        audio: false,
      });
      state.captureStream = stream;
      $('hostVideo').srcObject = stream;
      $('hostVideo').hidden = false;
      await $('hostVideo').play();
      await waitForFirstFrame();
      setupWebRTC(stream);
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        stopCapture(true);
        addChat('你已停止浏览器共享。', 'system', true);
      });
      startCaptureLoop();
      render();
      toast('屏幕共享已开始', 'success');
    } catch (error) {
      const message = error?.name === 'NotAllowedError' ? '你取消了屏幕共享，未开始传输画面' : '无法开始屏幕共享，请检查浏览器权限';
      toast(message, 'error');
    } finally {
      $('startSharingButton').disabled = false;
    }
  }

  async function startTestPattern() {
    if (state.mode !== 'host' || state.phase !== 'active') return;
    if (!HTMLCanvasElement.prototype.captureStream) {
      toast('当前浏览器不支持测试画面', 'error');
      return;
    }
    $('testPatternButton').disabled = true;
    try {
      stopCapture(false);
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 540;
      const context = canvas.getContext('2d');
      let tick = 0;
      const draw = () => {
        context.fillStyle = '#0b1220';
        context.fillRect(0, 0, 960, 540);
        context.strokeStyle = 'rgba(197,242,119,.12)';
        context.lineWidth = 1;
        for (let x = 0; x < 960; x += 48) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, 540); context.stroke(); }
        for (let y = 0; y < 540; y += 48) { context.beginPath(); context.moveTo(0, y); context.lineTo(960, y); context.stroke(); }
        context.fillStyle = '#c5f277';
        context.fillRect(70, 90, 10, 360);
        context.fillStyle = '#edf3f7';
        context.font = '700 54px sans-serif';
        context.fillText('连桥 · 测试画面', 120, 220);
        context.fillStyle = '#8b99a7';
        context.font = '24px sans-serif';
        context.fillText('如果你能看到这条信息，说明中转与显示正常。', 120, 275);
        context.fillStyle = `hsl(${tick * 7 % 360} 75% 60%)`;
        context.beginPath();
        context.arc(780 + Math.sin(tick / 8) * 45, 150 + Math.cos(tick / 10) * 25, 28, 0, Math.PI * 2);
        context.fill();
        tick += 1;
      };
      draw();
      const stream = canvas.captureStream(15);
      state.captureStream = stream;
      $('hostVideo').srcObject = stream;
      $('hostVideo').hidden = false;
      await $('hostVideo').play();
      await waitForFirstFrame();
      setupWebRTC(stream);
      state.testPainter = setInterval(draw, 80);
      startCaptureLoop();
      render();
      toast('测试画面已开始发送', 'success');
    } catch {
      toast('无法启动测试画面', 'error');
    } finally {
      $('testPatternButton').disabled = false;
    }
  }

  function stopFallbackCaptureLoop() {
    clearInterval(state.captureTimer);
    cancelAnimationFrame(state.captureRaf);
    state.captureTimer = null;
    state.captureRaf = 0;
  }

  function closeWebRTC() {
    const pc = state.peerConnection;
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try { pc.close(); } catch {}
    }
    state.peerConnection = null;
    state.webrtcActive = false;
    state.usingTurn = false;
    state.webrtcSetupPromise = null;
    state.webrtcGeneration += 1;
    state.pendingIce = [];
    if (state.mode === 'controller') {
      $('remoteVideo').pause();
      $('remoteVideo').srcObject = null;
    }
  }

  function markWebRTCConnected() {
    if (!state.peerConnection || state.webrtcActive) return;
    state.webrtcActive = true;
    state.webrtcRtt = null;
    state.usingTurn = false;
    state.lastStatsBytes = 0;
    state.lastStatsAt = 0;
    stopFallbackCaptureLoop();
    if (state.mode === 'controller') {
      state.hasFrame = true;
      state.transport.frameController?.abort();
      state.transport.frameLoopRunning = false;
    }
    render();
    toast('WebRTC 原画直连已建立', 'success');
  }

  function fallbackFromWebRTC(force = false) {
    if (!state.peerConnection || (!force && state.webrtcActive)) return;
    closeWebRTC();
    if (state.mode === 'host' && state.captureStream) startCaptureLoop();
    if (state.mode === 'controller' && state.approved) startFrameLoop();
    render();
    toast('直连未建立，已切换 Qoder 兼容中转', 'error');
  }

  async function fetchIceServers() {
    const defaults = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: ['stun:stun.cloudflare.com:3478'] },
      { urls: ['stun:openrelay.metered.ca:80'] },
    ];
    try {
      const url = new URL(`${relayOrigin()}/functions/v1/app`);
      url.search = new URLSearchParams({ action: 'turn-credentials', room: state.room, role: state.mode }).toString();
      const response = await fetch(url.toString(), { cache: 'no-store' });
      if (!response.ok) return defaults;
      const data = await response.json();
      if (!data.ok || !Array.isArray(data.iceServers)) return defaults;
      return [...defaults, ...data.iceServers];
    } catch {
      return defaults;
    }
  }

  async function ensureWebRTC() {
    if (state.mode !== 'controller' || typeof RTCPeerConnection === 'undefined') return null;
    if (state.peerConnection) return state.peerConnection;
    if (state.webrtcSetupPromise) return state.webrtcSetupPromise;
    const generation = state.webrtcGeneration;
    state.webrtcSetupPromise = (async () => {
      const iceServers = await fetchIceServers();
      if (generation !== state.webrtcGeneration || !state.approved || !state.transport.connected) return null;
      const pc = new RTCPeerConnection({
        iceServers,
        iceCandidatePoolSize: 4,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      });
      state.peerConnection = pc;
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.onicecandidate = (event) => {
        if (event.candidate) sendJson({ type: 'webrtc-ice', candidate: event.candidate.toJSON() });
      };
      pc.ontrack = (event) => {
        const video = $('remoteVideo');
        video.srcObject = event.streams[0] || new MediaStream([event.track]);
        video.hidden = false;
        if (isMobileDevice()) {
          event.track.onmute = () => {
            setTimeout(() => {
              if (event.track.muted && state.webrtcActive) fallbackFromWebRTC(true);
            }, 2500);
          };
          event.track.onended = () => fallbackFromWebRTC(true);
        }
        video.play().then(markWebRTCConnected).catch(() => fallbackFromWebRTC(true));
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') markWebRTCConnected();
        else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) fallbackFromWebRTC(true);
      };
      return pc;
    })();
    try { return await state.webrtcSetupPromise; }
    finally { state.webrtcSetupPromise = null; }
  }

  function preferAndroidVP8(pc) {
    const transceiver = pc.getTransceivers().find((item) => item.sender.track?.kind === 'video' || item.receiver.track?.kind === 'video');
    if (!transceiver?.setCodecPreferences || typeof RTCRtpSender === 'undefined') return;
    const codecs = RTCRtpSender.getCapabilities('video')?.codecs?.filter((codec) => codec.mimeType.toLowerCase() === 'video/vp8') || [];
    if (codecs.length) {
      try { transceiver.setCodecPreferences(codecs); } catch {}
    }
  }

  async function setupWebRTC(stream) {
    if (state.mode !== 'host' || typeof RTCPeerConnection === 'undefined') return;
    closeWebRTC();
    const generation = state.webrtcGeneration;
    const iceServers = await fetchIceServers();
    if (generation !== state.webrtcGeneration || !state.captureStream || !state.approved) return;
    const pc = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 4,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    state.peerConnection = pc;
    pc.onicecandidate = (event) => {
      if (event.candidate) sendJson({ type: 'webrtc-ice', candidate: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') markWebRTCConnected();
      else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) fallbackFromWebRTC();
    };
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    if (state.remoteMobile) preferAndroidVP8(pc);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendJson({ type: 'webrtc-offer', sdp: pc.localDescription?.sdp || '' });
      applyFps(state.fps);
      applyQuality(state.quality);
    } catch {
      fallbackFromWebRTC();
    }
  }

  async function handleWebRTCOffer(sdp) {
    if (typeof sdp !== 'string') return;
    const pc = await ensureWebRTC();
    if (!pc) return;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      for (const candidate of state.pendingIce.splice(0)) await pc.addIceCandidate(candidate);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendJson({ type: 'webrtc-answer', sdp: pc.localDescription?.sdp || '' });
    } catch {
      fallbackFromWebRTC();
    }
  }

  async function handleWebRTCAnswer(sdp) {
    const pc = state.peerConnection;
    if (!pc || typeof sdp !== 'string') return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp });
      for (const candidate of state.pendingIce.splice(0)) await pc.addIceCandidate(candidate);
    } catch {
      fallbackFromWebRTC();
    }
  }

  async function handleWebRTCIce(candidate) {
    const pc = state.peerConnection;
    if (!pc || !candidate || typeof candidate !== 'object') return;
    if (!pc.remoteDescription) {
      state.pendingIce.push(candidate);
      if (state.pendingIce.length > 20) state.pendingIce.shift();
      return;
    }
    try { await pc.addIceCandidate(candidate); } catch {}
  }

  function applyEncodingQuality() {
    const pc = state.peerConnection;
    if (!pc) return;
    const sender = pc.getSenders().find((item) => item.track?.kind === 'video');
    if (!sender) return;
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) parameters.encodings = [{}];
      const profile = qualities[state.quality];
      let scale = profile.scale;
      let bitrate = profile.bitrate;
      let fps = state.fps;
      if (state.remoteMobile) {
        const settings = sender.track.getSettings();
        scale = Math.max(scale, Math.ceil((settings.width || 1920) / 1280), Math.ceil((settings.height || 1080) / 720));
        bitrate = Math.min(bitrate, 4_000_000);
        fps = Math.min(fps, 30);
      }
      parameters.encodings[0].maxBitrate = bitrate;
      parameters.encodings[0].scaleResolutionDownBy = scale;
      parameters.encodings[0].maxFramerate = fps;
      parameters.degradationPreference = 'maintain-framerate';
      sender.setParameters(parameters).catch(() => {});
    } catch {}
  }

  async function applyFps(fps) {
    if (![15, 24, 30, 60].includes(fps)) return;
    state.fps = fps;
    $('fpsSelect').value = String(fps);
    const track = state.captureStream?.getVideoTracks()[0];
    if (track?.applyConstraints) {
      try { await track.applyConstraints({ frameRate: { ideal: fps, max: fps } }); } catch {}
    }
    applyEncodingQuality();
    if (!state.webrtcActive && state.captureStream) startCaptureLoop();
    render();
  }

  function startCaptureLoop() {
    clearInterval(state.captureTimer);
    cancelAnimationFrame(state.captureRaf);
    state.captureTimer = null;
    state.captureRaf = 0;
    const fps = Math.min(state.fps, 8);
    const video = $('hostVideo');
    if (video.requestVideoFrameCallback) {
      let lastFrame = 0;
      const tick = (now) => {
        if (!state.captureStream) return;
        if (now - lastFrame >= 1000 / fps) {
          captureFrame();
          lastFrame = now;
        }
        state.captureRaf = video.requestVideoFrameCallback(tick);
      };
      state.captureRaf = video.requestVideoFrameCallback(tick);
    } else {
      state.captureTimer = setInterval(captureFrame, 1000 / fps);
    }
  }

  async function captureFrame() {
    const video = $('hostVideo');
    if (state.capturing || !state.captureStream || !state.approved || video.readyState < 2 || !video.videoWidth) return;
    state.capturing = true;
    try {
      const selected = qualities[state.quality];
      const settings = { ...selected, maxWidth: Math.min(selected.maxWidth, 1280), quality: Math.min(selected.quality, 0.72) };
      const scale = Math.min(1, settings.maxWidth / video.videoWidth);
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      const canvas = state.captureCanvas;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = canvas.getContext('2d', { alpha: false });
      context.drawImage(video, 0, 0, width, height);
      const preview = $('hostCanvas');
      if (preview.width !== width || preview.height !== height) {
        preview.width = width;
        preview.height = height;
      }
      preview.getContext('2d', { alpha: false })?.drawImage(canvas, 0, 0);

      const probe = state.probeCanvas;
      if (!probe.width) { probe.width = 24; probe.height = 24; }
      const probeContext = probe.getContext('2d', { willReadFrequently: true });
      probeContext.drawImage(canvas, 0, 0, probe.width, probe.height);
      const pixels = probeContext.getImageData(0, 0, probe.width, probe.height).data;
      let brightness = 0;
      for (let index = 0; index < pixels.length; index += 4) brightness += pixels[index] + pixels[index + 1] + pixels[index + 2];
      brightness /= (pixels.length / 4) * 3;
      if (brightness < 2) state.blackFrameCount += 1;
      else state.blackFrameCount = 0;
      if (state.blackFrameCount >= 3 && !state.captureWarningShown) {
        state.captureWarningShown = true;
        $('mediaBadgeText').textContent = '检测到全黑画面 · 请重新选择窗口';
        toast('采集到的画面为全黑，请尝试共享窗口，或关闭浏览器硬件加速后重试', 'error');
        addChat('检测到采集画面为全黑，请重新选择要共享的窗口。', 'system', true);
      } else if (brightness >= 2 && state.captureWarningShown) {
        state.captureWarningShown = false;
        $('mediaBadgeText').textContent = '正在共享此屏幕';
      }

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', settings.quality));
      if (!blob || blob.size > 480 * 1024 || !state.transport.connected) return;
      const buffer = await blob.arrayBuffer();
      if (!await sendFrame(buffer)) return;
      state.frameBytes += blob.size;
      state.frameCount += 1;
    } finally {
      state.capturing = false;
    }
  }

  function stopCapture(notify = true) {
    closeWebRTC();
    clearInterval(state.captureTimer);
    clearInterval(state.testPainter);
    cancelAnimationFrame(state.captureRaf);
    state.captureTimer = null;
    state.testPainter = null;
    state.captureRaf = 0;
    state.captureStream?.getTracks().forEach((track) => track.stop());
    state.captureStream = null;
    $('hostVideo').pause();
    $('hostVideo').srcObject = null;
    $('hostVideo').hidden = true;
    $('hostCanvas').hidden = true;
    $('hostCanvas').getContext('2d')?.clearRect(0, 0, $('hostCanvas').width, $('hostCanvas').height);
    state.blackFrameCount = 0;
    state.captureWarningShown = false;
    state.capturing = false;
    if (notify && state.phase === 'active') sendJson({ type: 'screen-stopped' });
    render();
  }

  function applyQuality(value) {
    if (!qualities[value]) return;
    state.quality = value;
    $('qualitySelect').value = value;
    applyEncodingQuality();
    if (!state.webrtcActive && state.captureStream) startCaptureLoop();
    render();
  }

  function clearRemoteCanvas() {
    const canvas = $('remoteCanvas');
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }

  async function drawRemoteFrame(buffer) {
    const blob = new Blob([buffer], { type: 'image/jpeg' });
    let source;
    let width;
    let height;
    let revoke = () => {};
    try {
      if ('createImageBitmap' in window) {
        try {
          const bitmap = await createImageBitmap(blob);
          source = bitmap;
          width = bitmap.width;
          height = bitmap.height;
          revoke = () => bitmap.close();
        } catch {
          source = null;
        }
      }
      if (!source) {
        const url = URL.createObjectURL(blob);
        const image = new Image();
        image.src = url;
        await image.decode();
        source = image;
        width = image.naturalWidth;
        height = image.naturalHeight;
        revoke = () => URL.revokeObjectURL(url);
      }
      const canvas = $('remoteCanvas');
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      canvas.getContext('2d', { alpha: false })?.drawImage(source, 0, 0, width, height);
      revoke();
      state.hasFrame = true;
      state.decodeErrorShown = false;
      state.frameBytes += blob.size;
      state.frameCount += 1;
      render();
    } catch {
      if (!state.decodeErrorShown) {
        state.decodeErrorShown = true;
        $('mediaBadgeText').textContent = '画面解码失败 · 请更新浏览器';
        toast('协助端无法解码画面帧，请更新 Chrome、Edge 或 Safari', 'error');
      }
    }
  }

  function containedRect(container, width, height) {
    const box = container.getBoundingClientRect();
    const scale = Math.min(box.width / width, box.height / height);
    const displayedWidth = width * scale;
    const displayedHeight = height * scale;
    return { left: box.left + (box.width - displayedWidth) / 2, top: box.top + (box.height - displayedHeight) / 2, width: displayedWidth, height: displayedHeight };
  }

  function showRemotePointer(x, y, click) {
    const video = $('hostVideo');
    if (!video.videoWidth || !video.videoHeight) return;
    const rect = containedRect($('mediaShell'), video.videoWidth, video.videoHeight);
    const shell = $('mediaShell').getBoundingClientRect();
    const pointer = $('remotePointer');
    pointer.style.left = `${rect.left - shell.left + x * rect.width}px`;
    pointer.style.top = `${rect.top - shell.top + y * rect.height}px`;
    pointer.hidden = false;
    clearTimeout(state.pointerHideTimer);
    state.pointerHideTimer = setTimeout(() => { pointer.hidden = true; }, 5000);
    if (click) {
      pointer.classList.remove('click');
      void pointer.offsetWidth;
      pointer.classList.add('click');
    }
  }

  function queuePointer(event, click = false) {
    if (state.mode !== 'controller' || !state.pointerEnabled || !state.pointerAllowed || !state.hasFrame) return;
    const canvas = $('remoteCanvas');
    const rect = containedRect(canvas, canvas.width, canvas.height);
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    state.pointerPending = { x, y, click: click || Boolean(state.pointerPending?.click) };
    if (!state.pointerFrame) {
      state.pointerFrame = requestAnimationFrame(() => {
        state.pointerFrame = 0;
        const now = performance.now();
        if (now - state.lastPointerSent < 32 || !state.pointerPending) return;
        sendJson({ type: 'cursor', ...state.pointerPending });
        state.pointerPending = null;
        state.lastPointerSent = now;
      });
    }
  }

  async function checkRelayHealth() {
    try {
      const response = await fetch(`${relayOrigin()}/functions/v1/app?action=health`, { cache: 'no-store' });
      if (response.ok) setRelay('connected', '中转服务就绪');
    } catch {
      setRelay('', '中转服务待连接');
    }
  }

  $('hostForm').addEventListener('submit', (event) => {
    event.preventDefault();
    state.name = safeName($('hostName').value, '被协助端');
    state.room = generateCode();
    localStorage.setItem('lianqiao-host-name', state.name);
    connectRelay();
  });

  $('controllerForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const binding = bindingForRole('controller');
    if (!binding) {
      const code = normalizeCode($('joinCode').value);
      if (code.length !== 8) {
        toast('请输入完整的 8 位配对码', 'error');
        $('joinCode').focus();
        return;
      }
      state.room = code;
    } else {
      state.room = '';
    }
    state.name = safeName($('controllerName').value, '协助者');
    localStorage.setItem('lianqiao-controller-name', state.name);
    connectRelay();
  });

  $('joinCode').addEventListener('input', () => {
    $('joinCode').value = formatCode($('joinCode').value);
  });

  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));

  $('copyCodeButton').addEventListener('click', () => copyText(state.room, '配对码已复制'));
  $('copyLinkButton').addEventListener('click', () => {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('join', state.room);
    copyText(url.toString(), '邀请链接已复制');
  });
  $('cancelWaitingButton').addEventListener('click', () => endSession(true, '已取消会话'));
  $('approveButton').addEventListener('click', () => sendJson({ type: 'approve' }));
  $('rejectButton').addEventListener('click', () => {
    sendJson({ type: 'reject' });
    endSession(false, '已拒绝连接');
  });

  $('pointerPermission').addEventListener('change', () => {
    state.pointerAllowed = $('pointerPermission').checked;
    sendJson({ type: 'permissions', pointer: state.pointerAllowed, chat: state.chatAllowed });
    render();
  });
  $('chatPermission').addEventListener('change', () => {
    state.chatAllowed = $('chatPermission').checked;
    sendJson({ type: 'permissions', pointer: state.pointerAllowed, chat: state.chatAllowed });
    render();
  });

  $('chatForm').addEventListener('submit', (event) => {
    event.preventDefault();
    sendChat($('chatInput').value);
  });
  $('startSharingButton').addEventListener('click', startCapture);
  $('diagnosticShareButton').addEventListener('click', startCapture);
  $('testPatternButton').addEventListener('click', startTestPattern);
  $('diagnosticButton').addEventListener('click', startTestPattern);
  $('stopSharingButton').addEventListener('click', () => endSession(true, '你已结束共享'));
  $('disconnectButton').addEventListener('click', () => endSession(true, '你已离开会话'));
  $('pointerButton').addEventListener('click', () => {
    state.pointerEnabled = !state.pointerEnabled;
    render();
  });
  function sendMediaSettings() {
    state.quality = $('qualitySelect').value;
    state.fps = Number($('fpsSelect').value);
    sendJson({ type: 'media-settings', quality: state.quality, fps: state.fps, mobile: isMobileDevice() });
    render();
  }
  $('qualitySelect').addEventListener('change', sendMediaSettings);
  $('fpsSelect').addEventListener('change', sendMediaSettings);
  $('fullscreenButton').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $('mediaShell').requestFullscreen();
    } catch {
      toast('当前浏览器不支持全屏显示', 'error');
    }
  });
  $('remoteCanvas').addEventListener('pointermove', (event) => queuePointer(event));
  $('remoteCanvas').addEventListener('pointerdown', (event) => {
    event.preventDefault();
    $('remoteCanvas').setPointerCapture?.(event.pointerId);
    queuePointer(event, true);
  });

  $('openBindingButton').addEventListener('click', async () => {
    await registerDevice();
    $('bindingDialog').showModal();
  });
  $('closeBindingButton').addEventListener('click', () => $('bindingDialog').close());
  $('saveDeviceNameButton').addEventListener('click', async () => {
    if (!state.device) return;
    state.device.name = safeName($('deviceName').value, '我的设备');
    try { localStorage.setItem('lianqiao.device.v1', JSON.stringify(state.device)); } catch {}
    try {
      await deviceRequest('register', { name: state.device.name });
      toast('设备名称已保存', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '保存失败', 'error');
    }
  });
  $('generateBindCodeButton').addEventListener('click', async () => {
    try {
      const data = await deviceRequest('bind-create');
      $('bindCodeText').textContent = formatCode(data.code);
      $('bindCodeResult').hidden = false;
    } catch (error) {
      toast(error instanceof Error ? error.message : '生成绑定码失败', 'error');
    }
  });
  $('copyBindCodeButton').addEventListener('click', () => copyText($('bindCodeText').textContent.replace('-', ''), '绑定码已复制'));
  $('redeemBindCode').addEventListener('input', () => { $('redeemBindCode').value = formatCode($('redeemBindCode').value); });
  $('redeemBindCodeButton').addEventListener('click', async () => {
    const code = normalizeCode($('redeemBindCode').value);
    if (code.length !== 8) {
      toast('请输入完整的 8 位绑定码', 'error');
      return;
    }
    try {
      await deviceRequest('bind-redeem', { code, name: state.device.name });
      $('redeemBindCode').value = '';
      await refreshBindings();
      toast('设备绑定成功', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : '绑定失败', 'error');
    }
  });

  $('helpButton').addEventListener('click', () => $('helpDialog').showModal());
  $('closeHelpButton').addEventListener('click', () => $('helpDialog').close());
  $('confirmHelpButton').addEventListener('click', () => $('helpDialog').close());
  $('helpDialog').addEventListener('click', (event) => {
    if (event.target === $('helpDialog')) $('helpDialog').close();
  });

  window.addEventListener('beforeunload', () => {
    state.intentionalClose = true;
    closeTransport();
    state.captureStream?.getTracks().forEach((track) => track.stop());
  });

  try {
    $('hostName').value = localStorage.getItem('lianqiao-host-name') || '';
    $('controllerName').value = localStorage.getItem('lianqiao-controller-name') || '';
  } catch {}

  const invite = new URLSearchParams(location.search).get('join');
  if (invite && normalizeCode(invite).length === 8) {
    state.mode = 'controller';
    $('joinCode').value = formatCode(invite);
  }

  render();
  checkRelayHealth();
  registerDevice();
})();
