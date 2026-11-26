const siteOrigin = 'https://lianqiao-assist-2xoqymkdrbe.qoder.zone';
const codePattern = /^[A-Z2-9]{8}$/;
const pairCodePattern = /^[A-HJ-NP-Z2-9]{8}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const codeAlphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const qualityValues = new Set(['uhd', 'original', 'high', 'balanced', 'low']);
const fpsValues = new Set([15, 24, 30, 60, 120]);
const maxFrameBytes = 480 * 1024;
const attempts = new Map();

const json = (data, status = 200, headers = {}) => Response.json(data, {
  status,
  headers: { 'Cache-Control': 'no-store', ...headers },
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeName = (value, fallback) => {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  return clean || fallback;
};
const framePath = (code, version) => `relay-frames/${code}-${version}.jpg`;

function requestIp(request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
}

function allowRequest(ip) {
  const now = Date.now();
  const current = attempts.get(ip);
  if (!current || now - current.window > 60_000) {
    attempts.set(ip, { window: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= 580;
}

function sameOrigin(request) {
  const host = request.headers.get('host');
  if (!host) return false;
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'same-origin' || origin === siteOrigin) return true;
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    if (originUrl.host === host) return true;
    const local = (value) => value === 'localhost' || value === '127.0.0.1' || value === '[::1]';
    return local(originUrl.hostname) && local(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 64 * 1024) throw new Error('body_too_large');
  const text = await request.text();
  if (text.length > 64 * 1024) throw new Error('body_too_large');
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') throw new Error('invalid_json');
    return value;
  } catch {
    throw new Error('invalid_json');
  }
}

const isUuid = (value) => typeof value === 'string' && uuidPattern.test(value);
const validDeviceName = (value) => typeof value === 'string' && value.length <= 24;
const validSecret = (value) => typeof value === 'string' && value.length >= 32 && value.length <= 128;
const deviceIdFrom = (value) => isUuid(value) ? value.toLowerCase() : '';

async function hashSecret(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomCode() {
  const bytes = new Uint8Array(8);
  const limit = 256 - (256 % codeAlphabet.length);
  let code = '';
  while (code.length < 8) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      code += codeAlphabet[byte % codeAlphabet.length];
      if (code.length === 8) break;
    }
  }
  return code;
}

async function registerDevice(supabase, body) {
  const deviceId = deviceIdFrom(body.deviceId);
  if (!deviceId || !validDeviceName(body.name) || !validSecret(body.secret)) throw new Error('invalid_request');
  const name = safeName(body.name, '未命名设备');
  const secretHash = await hashSecret(body.secret);
  const now = new Date().toISOString();
  const { error } = await supabase.from('devices').insert({
    id: deviceId,
    name,
    secret_hash: secretHash,
    created_at: now,
    last_seen_at: now,
  });
  if (!error) return json({ ok: true, deviceId });
  if (error.code !== '23505') throw new Error('database_request_failed');
  const { data, error: updateError } = await supabase.from('devices')
    .update({ name, last_seen_at: now })
    .eq('id', deviceId)
    .eq('secret_hash', secretHash)
    .select('id')
    .maybeSingle();
  if (updateError) throw new Error('database_request_failed');
  if (!data) return json({ error: 'device_conflict' }, 409);
  return json({ ok: true, deviceId });
}

async function authenticateDevice(supabase, body) {
  const deviceId = deviceIdFrom(body.deviceId);
  if (!deviceId || !validSecret(body.secret)) throw new Error('invalid_request');
  const secretHash = await hashSecret(body.secret);
  const { data, error } = await supabase.from('devices')
    .select('id,name,secret_hash')
    .eq('id', deviceId)
    .maybeSingle();
  if (error) throw new Error('database_request_failed');
  if (!data || data.secret_hash !== secretHash) throw new Error('invalid_credentials');
  const { data: device, error: updateError } = await supabase.from('devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', deviceId)
    .eq('secret_hash', secretHash)
    .select('id,name')
    .maybeSingle();
  if (updateError) throw new Error('database_request_failed');
  if (!device) throw new Error('invalid_credentials');
  return { id: device.id, name: device.name };
}

async function loadBinding(supabase, bindingId) {
  const { data, error } = await supabase.from('device_bindings')
    .select('id,host_device_id,controller_device_id,host_name,controller_name,active_room_code,created_at,revoked_at')
    .eq('id', bindingId)
    .maybeSingle();
  if (error) throw new Error('database_request_failed');
  return data;
}

function deviceErrorResponse(error) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'body_too_large') return json({ error: 'body_too_large' }, 413);
  if (message === 'invalid_json' || message === 'invalid_request') return json({ error: message === 'invalid_json' ? 'invalid_json' : 'invalid_request' }, 400);
  if (message === 'invalid_credentials') return json({ error: 'invalid_credentials' }, 401);
  if (message === 'not_allowed') return json({ error: 'not_allowed' }, 403);
  if (message === 'device_conflict' || message === 'invalid_pair_code' || message === 'binding_exists' || message === 'role_taken' || message === 'binding_conflict' || message === 'code_conflict') {
    return json({ error: message }, 409);
  }
  if (message === 'host_not_found' || message === 'binding_not_found' || message === 'session_not_found') return json({ error: message }, 404);
  if (message === 'session_closed') return json({ error: 'session_closed' }, 410);
  return json({ error: 'relay_error' }, 503);
}

async function handleDevice(request, supabase) {
  try {
    const body = await readJson(request);
    const op = body.op;
    if (op === 'register') return await registerDevice(supabase, body);

    if (op === 'bind-create') {
      const device = await authenticateDevice(supabase, body);
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = randomCode();
        const { error } = await supabase.from('device_pair_codes').insert({
          code,
          host_device_id: device.id,
          expires_at: expiresAt,
          used_at: null,
        });
        if (!error) return json({ ok: true, code, expiresAt });
        if (error.code !== '23505') throw new Error('database_request_failed');
      }
      throw new Error('code_conflict');
    }

    if (op === 'bind-redeem') {
      const code = typeof body.code === 'string' ? body.code.toUpperCase() : '';
      if (!pairCodePattern.test(code) || !validDeviceName(body.name)) throw new Error('invalid_request');
      const controller = await authenticateDevice(supabase, body);
      const now = new Date().toISOString();
      const { data: claimed, error: claimError } = await supabase.from('device_pair_codes')
        .update({ used_at: now })
        .eq('code', code)
        .is('used_at', null)
        .gt('expires_at', now)
        .select('host_device_id')
        .maybeSingle();
      if (claimError) throw new Error('database_request_failed');
      if (!claimed) return json({ error: 'invalid_pair_code' }, 409);
      const { data: host, error: hostError } = await supabase.from('devices')
        .select('id,name')
        .eq('id', claimed.host_device_id)
        .maybeSingle();
      if (hostError) throw new Error('database_request_failed');
      if (!host) return json({ error: 'host_not_found' }, 404);
      const controllerName = safeName(body.name, '协助者');
      const bindingId = crypto.randomUUID();
      const { error: bindingError } = await supabase.from('device_bindings').insert({
        id: bindingId,
        host_device_id: host.id,
        controller_device_id: controller.id,
        host_name: safeName(host.name, '被协助端'),
        controller_name: controllerName,
        active_room_code: null,
        created_at: now,
        revoked_at: null,
      });
      if (bindingError?.code === '23505') return json({ error: 'binding_exists' }, 409);
      if (bindingError) throw new Error('database_request_failed');
      return json({ ok: true, binding: { id: bindingId, hostName: safeName(host.name, '被协助端'), controllerName, role: 'controller' } }, 201);
    }

    if (op === 'bind-list') {
      const device = await authenticateDevice(supabase, body);
      const { data, error } = await supabase.from('device_bindings')
        .select('id,host_device_id,controller_device_id,host_name,controller_name,active_room_code,created_at')
        .is('revoked_at', null)
        .or(`host_device_id.eq.${device.id},controller_device_id.eq.${device.id}`)
        .order('created_at', { ascending: false });
      if (error) throw new Error('database_request_failed');
      const bindings = (data || []).map((binding) => ({
        id: binding.id,
        role: binding.host_device_id === device.id ? 'host' : 'controller',
        peerName: binding.host_device_id === device.id ? binding.controller_name : binding.host_name,
        activeRoomCode: binding.active_room_code,
        createdAt: binding.created_at,
      }));
      return json({ ok: true, bindings });
    }

    if (op === 'bind-revoke') {
      if (!isUuid(body.bindingId)) throw new Error('invalid_request');
      const device = await authenticateDevice(supabase, body);
      const binding = await loadBinding(supabase, body.bindingId);
      if (!binding) return json({ error: 'binding_not_found' }, 404);
      if (binding.host_device_id !== device.id && binding.controller_device_id !== device.id) return json({ error: 'not_allowed' }, 403);
      if (!binding.revoked_at) {
        const { error } = await supabase.from('device_bindings')
          .update({ revoked_at: new Date().toISOString() })
          .eq('id', binding.id)
          .is('revoked_at', null);
        if (error) throw new Error('database_request_failed');
      }
      return json({ ok: true });
    }

    if (op === 'create-bound') {
      if (!isUuid(body.bindingId)) throw new Error('invalid_request');
      const device = await authenticateDevice(supabase, body);
      const binding = await loadBinding(supabase, body.bindingId);
      if (!binding || binding.revoked_at) return json({ error: 'binding_not_found' }, 404);
      if (binding.host_device_id !== device.id) return json({ error: 'not_allowed' }, 403);
      const previousCode = binding.active_room_code || null;
      if (previousCode && !codePattern.test(previousCode)) throw new Error('database_request_failed');
      if (previousCode) {
        const room = await getRoom(supabase, previousCode);
        if (room && !room.closed) return json({ ok: true, room: previousCode });
      }
      const now = new Date().toISOString();
      let roomCode = '';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        roomCode = randomCode();
        const { error } = await supabase.from('relay_rooms').insert({
          code: roomCode,
          host_name: safeName(binding.host_name, '被协助端'),
          approved: false,
          pointer_allowed: true,
          chat_allowed: true,
          control_allowed: false,
          frame_version: 0,
          created_at: now,
          updated_at: now,
          closed: false,
        });
        if (!error) break;
        if (error.code !== '23505') throw new Error('database_request_failed');
        roomCode = '';
      }
      if (!roomCode) throw new Error('code_conflict');
      let update = supabase.from('device_bindings')
        .update({ active_room_code: roomCode })
        .eq('id', binding.id)
        .eq('host_device_id', device.id)
        .is('revoked_at', null);
      update = previousCode ? update.eq('active_room_code', previousCode) : update.is('active_room_code', null);
      const { data: updated, error } = await update.select('id').maybeSingle();
      if (error) throw new Error('database_request_failed');
      if (!updated) {
        try {
          await supabase.from('relay_rooms').update({ closed: true, updated_at: new Date().toISOString() }).eq('code', roomCode);
        } catch {}
        throw new Error('binding_conflict');
      }
      return json({ ok: true, room: roomCode });
    }

    if (op === 'join-bound') {
      if (!isUuid(body.bindingId)) throw new Error('invalid_request');
      const device = await authenticateDevice(supabase, body);
      const binding = await loadBinding(supabase, body.bindingId);
      if (!binding || binding.revoked_at) return json({ error: 'binding_not_found' }, 404);
      if (binding.controller_device_id !== device.id) return json({ error: 'not_allowed' }, 403);
      const code = binding.active_room_code;
      if (!code) return json({ error: 'session_not_found' }, 404);
      if (!codePattern.test(code)) throw new Error('database_request_failed');
      const room = await getRoom(supabase, code);
      if (!room) return json({ error: 'session_not_found' }, 404);
      if (room.closed) return json({ error: 'session_closed' }, 410);
      const controllerName = safeName(binding.controller_name, '协助者');
      const { data, error } = await supabase.from('relay_rooms')
        .update({ controller_name: controllerName, approved: true, control_allowed: false, updated_at: new Date().toISOString() })
        .eq('code', code)
        .eq('closed', false)
        .is('controller_name', null)
        .select('code')
        .maybeSingle();
      if (error) throw new Error('database_request_failed');
      if (!data) {
        const latest = await getRoom(supabase, code);
        if (!latest) return json({ error: 'session_not_found' }, 404);
        if (latest.closed) return json({ error: 'session_closed' }, 410);
        return json({ error: 'role_taken' }, 409);
      }
      await enqueue(supabase, code, 'host', { type: 'approved', peerName: controllerName, pointer: room.pointer_allowed, chat: room.chat_allowed, control: false });
      await enqueue(supabase, code, 'controller', { type: 'approved', peerName: room.host_name, pointer: room.pointer_allowed, chat: room.chat_allowed, control: false });
      return json({ ok: true, room: code }, 201);
    }

    return json({ error: 'not_found' }, 404);
  } catch (error) {
    return deviceErrorResponse(error);
  }
}

async function getRoom(supabase, code) {
  const { data, error } = await supabase.from('relay_rooms')
    .select('code,host_name,controller_name,approved,pointer_allowed,chat_allowed,control_allowed,frame_version,created_at,updated_at,closed')
    .eq('code', code)
    .maybeSingle();
  if (error) throw new Error('database_request_failed');
  return data;
}

async function enqueue(supabase, code, role, payload) {
  const id = Date.now() * 1000 + crypto.getRandomValues(new Uint32Array(1))[0] % 1000;
  const { error } = await supabase.from('relay_messages').insert({
    id,
    room_code: code,
    target_role: role,
    payload,
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error('message_write_failed');
}

async function removeFrame(storage, code, version = 0) {
  const paths = [];
  if (version > 0) paths.push(framePath(code, version));
  if (version > 1) paths.push(framePath(code, version - 1));
  if (!paths.length) return;
  try { await storage.remove(paths); } catch {}
}

async function cleanup(supabase) {
  if (Math.random() > 0.04) return;
  const now = Date.now();
  try {
    await supabase.from('relay_messages').delete().lt('created_at', new Date(now - 10 * 60_000).toISOString());
    await supabase.from('relay_rooms').delete().eq('closed', true).lt('updated_at', new Date(now - 30_000).toISOString());
    await supabase.from('relay_rooms').delete().lt('created_at', new Date(now - 2 * 60 * 60_000).toISOString());
  } catch {}
}

async function pollMessages(supabase, code, role, after, signal) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (signal?.aborted) return new Response(null, { status: 204 });
    const room = await getRoom(supabase, code);
    if (!room) return json({ error: 'session_not_found' }, 404);
    const { data, error } = await supabase.from('relay_messages')
      .select('id,payload')
      .eq('room_code', code)
      .eq('target_role', role)
      .gt('id', after)
      .order('id', { ascending: true })
      .limit(100);
    if (error) throw new Error('database_request_failed');
    if (Array.isArray(data) && data.length) {
      return json({ messages: data.map((row) => row.payload), after: Number(data[data.length - 1].id) });
    }
    if (room.closed) return json({ error: 'session_closed' }, 410);
    await sleep(150);
  }
  return new Response(null, { status: 204 });
}

async function pollFrame(supabase, storage, code, after, signal) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (signal?.aborted) return new Response(null, { status: 204 });
    const room = await getRoom(supabase, code);
    if (!room) return json({ error: 'session_not_found' }, 404);
    if (room.closed) return json({ error: 'session_closed' }, 410);
    const version = Number(room.frame_version || 0);
    if (version > after) {
      const file = await storage.download(framePath(code, version));
      if (!file.ok) return json({ error: 'frame_unavailable' }, 503);
      return new Response(file.body, {
        headers: { 'Content-Type': 'image/jpeg', 'X-Frame-Version': String(version), 'Cache-Control': 'no-store' },
      });
    }
    await sleep(100);
  }
  return new Response(null, { status: 204 });
}

async function handleSend(supabase, storage, room, role, message) {
  if (typeof message.type !== 'string') return json({ error: 'invalid_message' }, 400);
  const now = new Date().toISOString();
  switch (message.type) {
    case 'approve': {
      if (role !== 'host' || !room.controller_name || room.approved) return json({ error: 'not_allowed' }, 403);
      const { data, error } = await supabase.from('relay_rooms')
        .update({ approved: true, updated_at: now })
        .eq('code', room.code)
        .eq('approved', false)
        .select('code')
        .maybeSingle();
      if (error) throw new Error('database_request_failed');
      if (!data) return json({ error: 'not_allowed' }, 409);
      await enqueue(supabase, room.code, 'host', { type: 'approved', peerName: room.controller_name, pointer: room.pointer_allowed, chat: room.chat_allowed, control: room.control_allowed === true });
      await enqueue(supabase, room.code, 'controller', { type: 'approved', peerName: room.host_name, pointer: room.pointer_allowed, chat: room.chat_allowed, control: room.control_allowed === true });
      return json({ ok: true }, 202);
    }
    case 'reject': {
      if (role !== 'host' || !room.controller_name) return json({ error: 'not_allowed' }, 403);
      await supabase.from('relay_rooms').update({ closed: true, updated_at: now }).eq('code', room.code);
      await enqueue(supabase, room.code, 'controller', { type: 'rejected' });
      await removeFrame(storage, room.code, Number(room.frame_version || 0));
      return json({ ok: true }, 202);
    }
    case 'permissions': {
      if (role !== 'host') return json({ error: 'not_allowed' }, 403);
      const pointer = message.pointer !== false;
      const chat = message.chat !== false;
      const control = message.control === true;
      const { error } = await supabase.from('relay_rooms').update({ pointer_allowed: pointer, chat_allowed: chat, control_allowed: control, updated_at: now }).eq('code', room.code);
      if (error) throw new Error('database_request_failed');
      if (room.approved) await enqueue(supabase, room.code, 'controller', { type: 'permissions', pointer, chat, control });
      return json({ ok: true }, 202);
    }
    case 'chat': {
      if (!room.approved || !room.chat_allowed || typeof message.text !== 'string') return json({ error: 'not_allowed' }, 403);
      const text = message.text.trim().slice(0, 500);
      if (!text) return json({ error: 'invalid_message' }, 400);
      await enqueue(supabase, room.code, role === 'host' ? 'controller' : 'host', { type: 'chat', from: role, name: role === 'host' ? room.host_name : room.controller_name, text, at: Date.now() });
      return json({ ok: true }, 202);
    }
    case 'cursor': {
      if (role !== 'controller' || !room.approved || !room.pointer_allowed) return json({ error: 'not_allowed' }, 403);
      const x = Number(message.x);
      const y = Number(message.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return json({ error: 'invalid_cursor' }, 400);
      await enqueue(supabase, room.code, 'host', { type: 'cursor', x, y, click: message.click === true });
      return json({ ok: true }, 202);
    }
    case 'control': {
      if (role !== 'controller' || !room.approved || room.control_allowed !== true) return json({ error: 'not_allowed' }, 403);
      const action = message.action;
      if (action === 'mousemove') {
        const x = Number(message.x);
        const y = Number(message.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return json({ error: 'invalid_control' }, 400);
        await enqueue(supabase, room.code, 'host', { type: 'control', action, x, y });
      } else if (action === 'click') {
        const button = [0, 1, 2].includes(Number(message.button)) ? Number(message.button) : 0;
        await enqueue(supabase, room.code, 'host', { type: 'control', action, button });
      } else if (action === 'wheel') {
        const delta = Math.max(-1000, Math.min(1000, Number(message.delta) || 0));
        await enqueue(supabase, room.code, 'host', { type: 'control', action, delta });
      } else if (action === 'key') {
        if (typeof message.key !== 'string' || !message.key || message.key.length > 32) return json({ error: 'invalid_control' }, 400);
        await enqueue(supabase, room.code, 'host', { type: 'control', action, key: message.key, down: message.down !== false, modifiers: { ctrl: message.modifiers?.ctrl === true, alt: message.modifiers?.alt === true, shift: message.modifiers?.shift === true, meta: message.modifiers?.meta === true } });
      } else {
        return json({ error: 'invalid_control' }, 400);
      }
      return json({ ok: true }, 202);
    }
    case 'quality': {
      if (role !== 'controller' || !room.approved || typeof message.value !== 'string' || !qualityValues.has(message.value)) return json({ error: 'not_allowed' }, 403);
      await enqueue(supabase, room.code, 'host', { type: 'quality', value: message.value });
      return json({ ok: true }, 202);
    }
    case 'android-degrade': {
      if (role !== 'controller' || !room.approved) return json({ error: 'not_allowed' }, 403);
      await enqueue(supabase, room.code, 'host', { type: 'android-degrade' });
      return json({ ok: true }, 202);
    }
    case 'media-settings': {
      if (role !== 'controller' || !room.approved || typeof message.quality !== 'string' || !qualityValues.has(message.quality)) return json({ error: 'not_allowed' }, 403);
      const fps = Number(message.fps);
      if (!fpsValues.has(fps)) return json({ error: 'invalid_fps' }, 400);
      await enqueue(supabase, room.code, 'host', { type: 'media-settings', quality: message.quality, fps, mobile: message.mobile === true });
      return json({ ok: true }, 202);
    }
    case 'webrtc-offer': {
      if (role !== 'host' || !room.approved || typeof message.sdp !== 'string' || message.sdp.length > 32_768) return json({ error: 'not_allowed' }, 403);
      await enqueue(supabase, room.code, 'controller', { type: 'webrtc-offer', sdp: message.sdp });
      return json({ ok: true }, 202);
    }
    case 'webrtc-answer': {
      if (role !== 'controller' || !room.approved || typeof message.sdp !== 'string' || message.sdp.length > 32_768) return json({ error: 'not_allowed' }, 403);
      await enqueue(supabase, room.code, 'host', { type: 'webrtc-answer', sdp: message.sdp });
      return json({ ok: true }, 202);
    }
    case 'webrtc-ice': {
      if (!room.approved || !message.candidate || typeof message.candidate !== 'object') return json({ error: 'not_allowed' }, 403);
      await enqueue(supabase, room.code, role === 'host' ? 'controller' : 'host', { type: 'webrtc-ice', candidate: message.candidate });
      return json({ ok: true }, 202);
    }
    case 'screen-stopped': {
      if (role === 'host' && room.approved) {
        await enqueue(supabase, room.code, 'controller', { type: 'screen-stopped' });
        await removeFrame(storage, room.code, Number(room.frame_version || 0));
      }
      return json({ ok: true }, 202);
    }
    case 'ping':
      await enqueue(supabase, room.code, role, { type: 'pong', at: Date.now() });
      return json({ ok: true }, 202);
    case 'bye': {
      if (role === 'host') {
        await supabase.from('relay_rooms').update({ closed: true, updated_at: now }).eq('code', room.code);
        await enqueue(supabase, room.code, 'controller', { type: 'peer-left' });
        await removeFrame(storage, room.code, Number(room.frame_version || 0));
      } else {
        await supabase.from('relay_rooms').update({ controller_name: null, approved: false, control_allowed: false, updated_at: now }).eq('code', room.code);
        await enqueue(supabase, room.code, 'host', { type: 'peer-left' });
      }
      return json({ ok: true }, 202);
    }
    default:
      return json({ error: 'unsupported_message' }, 400);
  }
}

function base64UrlSafe(bytes) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

async function turnCredentials(env) {
  const secret = env?.('TURN_AUTH_SECRET');
  if (typeof secret !== 'string' || secret.length < 32) {
    return json({ ok: false, error: 'turn_not_configured', iceServers: [] }, 503);
  }
  try {
    const username = `${Math.floor(Date.now() / 1000) + 3600}:lianqiao-${crypto.randomUUID()}`;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
    const credential = base64UrlSafe(new Uint8Array(signature));
    return json({
      ok: true,
      iceServers: [{
        urls: ['turn:39.96.62.110:3478?transport=udp', 'turn:39.96.62.110:3478?transport=tcp'],
        username,
        credential,
      }],
    });
  } catch {
    return json({ ok: false, error: 'turn_unavailable', iceServers: [] }, 503);
  }
}

export async function handleRelay({ request, supabase, storage, env }) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: 'GET, POST, OPTIONS' } });
  if (url.searchParams.get('action') === 'health' && request.method === 'GET') return json({ ok: true, service: 'lianqiao-relay', transport: 'database-long-poll' });
  if (url.searchParams.get('action') === 'turn-credentials' && request.method === 'GET') {
    if (!sameOrigin(request)) return json({ error: 'origin_not_allowed' }, 403);
    if (!allowRequest(requestIp(request))) return json({ error: 'rate_limited' }, 429);
    const code = (url.searchParams.get('room') || '').toUpperCase();
    const role = url.searchParams.get('role');
    const room = await getRoom(supabase, code);
    if (!room || !room.approved || (role !== 'host' && role !== 'controller')) return json({ error: 'not_allowed' }, 403);
    if ((role === 'host' && !room.host_name) || (role === 'controller' && !room.controller_name)) return json({ error: 'role_not_joined' }, 403);
    return await turnCredentials(env);
  }
  if (url.searchParams.get('action') === 'device') {
    if (!sameOrigin(request)) return json({ error: 'origin_not_allowed' }, 403);
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    if (!allowRequest(requestIp(request))) return json({ error: 'rate_limited' }, 429);
    return await handleDevice(request, supabase);
  }
  if (url.searchParams.get('action') !== 'relay') return json({ ok: false, error: 'not_found' }, 404);
  if (!sameOrigin(request)) return json({ error: 'origin_not_allowed' }, 403);
  if (!allowRequest(requestIp(request))) return json({ error: 'rate_limited' }, 429);
  cleanup(supabase);

  const op = url.searchParams.get('op') || '';
  try {
    if (op === 'create' && request.method === 'POST') {
      const body = await readJson(request);
      const code = String(body.room || '').toUpperCase();
      if (!codePattern.test(code)) return json({ error: 'invalid_room' }, 400);
      const now = new Date().toISOString();
      const { error } = await supabase.from('relay_rooms').insert({
        code,
        host_name: safeName(body.name, '被协助端'),
        approved: false,
        pointer_allowed: true,
        chat_allowed: true,
        control_allowed: false,
        frame_version: 0,
        created_at: now,
        updated_at: now,
        closed: false,
      });
      if (error?.code === '23505') return json({ error: 'room_exists' }, 409);
      if (error) throw new Error('database_request_failed');
      return json({ ok: true, room: code }, 201);
    }

    if (op === 'join' && request.method === 'POST') {
      const body = await readJson(request);
      const code = String(body.room || '').toUpperCase();
      const room = await getRoom(supabase, code);
      if (!room || room.closed) return json({ error: 'session_not_found' }, 404);
      if (room.controller_name) return json({ error: 'role_taken' }, 409);
      const { data, error } = await supabase.from('relay_rooms')
        .update({ controller_name: safeName(body.name, '协助者'), approved: false, control_allowed: false, updated_at: new Date().toISOString() })
        .eq('code', code)
        .is('controller_name', null)
        .select('code')
        .maybeSingle();
      if (error) throw new Error('database_request_failed');
      if (!data) return json({ error: 'role_taken' }, 409);
      await enqueue(supabase, code, 'host', { type: 'peer-joined', name: safeName(body.name, '协助者') });
      return json({ ok: true }, 201);
    }

    if (op === 'send' && request.method === 'POST') {
      const body = await readJson(request);
      const code = String(body.room || '').toUpperCase();
      const role = body.role;
      const room = await getRoom(supabase, code);
      if (!room || (role !== 'host' && role !== 'controller')) return json({ error: 'session_not_found' }, 404);
      if (room.closed) return json({ error: 'session_closed' }, 410);
      if ((role === 'host' && !room.host_name) || (role === 'controller' && !room.controller_name)) return json({ error: 'role_not_joined' }, 403);
      return await handleSend(supabase, storage, room, role, body);
    }

    if (op === 'poll' && request.method === 'GET') {
      const code = (url.searchParams.get('room') || '').toUpperCase();
      const role = url.searchParams.get('role');
      const after = Math.max(0, Number(url.searchParams.get('after') || 0) || 0);
      const room = await getRoom(supabase, code);
      if (!room || (role !== 'host' && role !== 'controller')) return json({ error: 'session_not_found' }, 404);
      if ((role === 'host' && !room.host_name) || (role === 'controller' && !room.controller_name)) return json({ error: 'role_not_joined' }, 403);
      return await pollMessages(supabase, code, role, after, request.signal);
    }

    if (op === 'frame' && request.method === 'POST') {
      const code = (url.searchParams.get('room') || '').toUpperCase();
      const role = url.searchParams.get('role');
      const room = await getRoom(supabase, code);
      if (!room || role !== 'host') return json({ error: 'session_not_found' }, 404);
      if (!room.approved || !room.controller_name || room.closed) return json({ error: 'not_allowed' }, 403);
      const frame = await request.arrayBuffer();
      if (!frame.byteLength || frame.byteLength > maxFrameBytes) return json({ error: 'invalid_frame' }, 413);
      const version = Number(room.frame_version || 0) + 1;
      await storage.upload(framePath(code, version), new Uint8Array(frame), { contentType: 'image/jpeg', upsert: true });
      const { data: updated, error } = await supabase.from('relay_rooms')
        .update({ frame_version: version, updated_at: new Date().toISOString() })
        .eq('code', code)
        .eq('frame_version', room.frame_version)
        .select('code')
        .maybeSingle();
      if (error) throw new Error('database_request_failed');
      if (!updated) return json({ error: 'frame_version_conflict' }, 409);
      if (version > 2) {
        try { await storage.remove([framePath(code, version - 2)]); } catch {}
      }
      return json({ ok: true, version }, 202);
    }

    if (op === 'frame-poll' && request.method === 'GET') {
      const code = (url.searchParams.get('room') || '').toUpperCase();
      const role = url.searchParams.get('role');
      const after = Math.max(0, Number(url.searchParams.get('after') || 0) || 0);
      const room = await getRoom(supabase, code);
      if (!room || role !== 'controller') return json({ error: 'session_not_found' }, 404);
      if (!room.controller_name || !room.approved || room.closed) return json({ error: 'not_allowed' }, 403);
      return await pollFrame(supabase, storage, code, after, request.signal);
    }

    return json({ error: 'not_found' }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'relay_error';
    if (message === 'body_too_large') return json({ error: 'body_too_large' }, 413);
    if (message === 'invalid_json') return json({ error: 'invalid_json' }, 400);
    return json({ error: 'relay_error' }, 503);
  }
}
