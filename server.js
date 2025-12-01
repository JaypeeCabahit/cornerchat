const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const REPORTS_FILE = path.join(__dirname, 'data', 'reports.log');

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const BAD_WORDS = [
  'badword',
  'stupid',
  'idiot',
  'hate',
  'kill'
];

const MAX_AVATAR_IMAGE_LENGTH = 8 * 1024 * 1024; // ~8 MB base64 string

const clients = new Map(); // clientId -> state
const waitingQueue = []; // ordered list of clientIds waiting for chat
const rooms = new Map(); // roomId -> { members, startedAt }

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = parsedUrl;

  if (req.method === 'GET' && pathname === '/events') {
    return handleEventStream(req, res, parsedUrl.searchParams);
  }

  if (req.method === 'POST' && pathname === '/start') {
    return handleStart(req, res);
  }

  if (req.method === 'POST' && pathname === '/message') {
    return handleMessage(req, res);
  }

  if (req.method === 'POST' && pathname === '/next') {
    return handleNext(req, res);
  }

  if (req.method === 'POST' && pathname === '/disconnect') {
    return handleDisconnect(req, res);
  }

  if (req.method === 'POST' && pathname === '/typing') {
    return handleTyping(req, res);
  }

  if (req.method === 'POST' && pathname === '/report') {
    return handleReport(req, res);
  }

  if (req.method === 'POST' && pathname === '/reaction') {
    return handleReaction(req, res);
  }

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
  }

  return serveStaticFile(pathname, res);
});

function handleEventStream(req, res, searchParams) {
  const clientId = searchParams.get('clientId');
  if (!clientId) {
    res.writeHead(400);
    return res.end('clientId query parameter is required');
  }

  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  };
  res.writeHead(200, headers);

  const state = ensureClientState(clientId);
  state.sse = res;
  state.connectedAt = Date.now();
  state.isConnected = true;

  sendEvent(clientId, 'connected', { clientId });
  pushStatusUpdate(clientId);
  broadcastOnlineCount();

  req.on('close', () => {
    state.isConnected = false;
    state.sse = null;
    cleanupClient(clientId);
  });
}

async function handleStart(req, res) {
  const body = await extractJson(req, res);
  if (!body) return;

  const { clientId, nickname, interests = [], country, countryCode, avatarImage } = body;
  if (!clientId) {
    res.writeHead(400);
    return res.end('clientId is required');
  }
  const client = ensureClientState(clientId);
  client.nickname = sanitizeNickname(nickname);
  client.interests = Array.isArray(interests) ? [...new Set(interests)].slice(0, 5) : [];
  client.country = sanitizeCountryName(country);
  client.countryCode = sanitizeCountryCode(countryCode);
  client.avatarImage = sanitizeAvatarImage(avatarImage);
  client.requestedAt = Date.now();

  if (client.roomId) {
    const displayName = client.nickname || 'Stranger';
    leaveRoom(clientId, { notifyPartner: true, partnerMessage: `${displayName} left the room.`, requeuePartner: true });
  }
  addToQueue(clientId);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'waiting' }));
}

async function handleMessage(req, res) {
  const body = await extractJson(req, res);
  if (!body) return;

  const { clientId, message } = body;
  if (!clientId) {
    res.writeHead(400);
    return res.end('clientId is required');
  }
  const client = clients.get(clientId);
  if (!client || client.status !== 'chatting' || !client.partnerId) {
    res.writeHead(400);
    return res.end('Not currently chatting');
  }

  const text = sanitizeMessage(message || '');
  if (!text.trim()) {
    res.writeHead(400);
    return res.end('Message is empty');
  }

  const timestamp = Date.now();
  const messageId = `msg-${timestamp}-${Math.random().toString(36).substr(2, 9)}`;

  const payload = {
    author: 'you',
    text,
    timestamp,
    messageId
  };
  sendEvent(clientId, 'message', payload);

  const partnerPayload = {
    author: client.nickname || 'Stranger',
    text,
    timestamp,
    messageId
  };
  sendEvent(client.partnerId, 'message', partnerPayload);

  res.writeHead(200);
  res.end('sent');
}

async function handleNext(req, res) {
  const body = await extractJson(req, res);
  if (!body) return;
  const { clientId } = body;
  if (!clientId) {
    res.writeHead(400);
    return res.end('clientId is required');
  }
  const client = clients.get(clientId);
  if (!client) {
    res.writeHead(404);
    return res.end('Unknown client');
  }

  if (client.roomId) {
    const displayName = client.nickname || 'Stranger';
    leaveRoom(clientId, {
      notifyPartner: true,
      partnerMessage: `${displayName} skipped to the next chat.`,
      requeuePartner: false
    });
  } else {
    removeFromQueue(clientId);
  }

  addToQueue(clientId);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'waiting' }));
}

async function handleDisconnect(req, res) {
  const body = await extractJson(req, res);
  if (!body) return;
  const { clientId } = body;
  if (!clientId) {
    res.writeHead(400);
    return res.end('clientId is required');
  }
  const client = clients.get(clientId);
  if (client && client.roomId) {
    const displayName = client.nickname || 'Stranger';
    leaveRoom(clientId, {
      notifyPartner: true,
      partnerMessage: `${displayName} ended the chat.`,
      requeuePartner: false
    });
  }
  removeFromQueue(clientId);
  setClientIdle(clientId);

  res.writeHead(200);
  res.end('disconnected');
}

async function handleTyping(req, res) {
  const body = await extractJson(req, res);
  if (!body) return;
  const { clientId, typing } = body;
  if (!clientId) {
    res.writeHead(400);
    return res.end('clientId is required');
  }
  const client = clients.get(clientId);
  if (client && client.partnerId) {
    sendEvent(client.partnerId, 'typing', { typing: Boolean(typing) });
  }
  res.writeHead(204);
  res.end();
}

async function handleReport(req, res) {
  const body = await extractJson(req, res);
  if (!body) return;

  const { clientId, reason = '' } = body;
  if (!clientId) {
    res.writeHead(400);
    return res.end('clientId is required');
  }
  const client = clients.get(clientId);
  const partnerState = client && client.partnerId ? clients.get(client.partnerId) : null;
  const entry = {
    reportId: randomUUID(),
    reporter: clientId,
    partner: client ? client.partnerId : null,
    roomId: client ? client.roomId : null,
    reporterCountry: client ? client.country : null,
    partnerCountry: partnerState ? partnerState.country : null,
    reporterNickname: client ? client.nickname : null,
    partnerNickname: partnerState ? partnerState.nickname : null,
    reporterHasAvatar: client ? Boolean(client.avatarImage) : false,
    partnerHasAvatar: partnerState ? Boolean(partnerState.avatarImage) : false,
    reason: String(reason).slice(0, 200),
    timestamp: new Date().toISOString()
  };

  fs.appendFile(REPORTS_FILE, JSON.stringify(entry) + '\n', (err) => {
    if (err) {
      console.error('Unable to save report', err);
    }
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ saved: true }));
}

async function handleReaction(req, res) {
  const body = await extractJson(req, res);
  if (!body) return;

  const { clientId, messageId, emoji, remove = false } = body;
  if (!clientId || !messageId || !emoji) {
    res.writeHead(400);
    return res.end('clientId, messageId, and emoji are required');
  }

  const client = clients.get(clientId);
  if (!client || !client.partnerId) {
    res.writeHead(400);
    return res.end('Not in a chat');
  }

  // Sanitize emoji (limit to reasonable length)
  const sanitizedEmoji = String(emoji).slice(0, 10);

  // Send reaction event to partner
  sendEvent(client.partnerId, 'reaction', {
    messageId,
    emoji: sanitizedEmoji,
    remove
  });

  res.writeHead(200);
  res.end('ok');
}

function ensureClientState(clientId) {
  if (!clientId) {
    return null;
  }
  if (!clients.has(clientId)) {
    clients.set(clientId, {
      id: clientId,
      nickname: 'Stranger',
      interests: [],
      status: 'idle',
      partnerId: null,
      roomId: null,
      sse: null,
      isConnected: false,
      connectedAt: null,
      country: null,
      countryCode: null,
      avatarImage: null
    });
  }
  return clients.get(clientId);
}

function addToQueue(clientId) {
  const client = ensureClientState(clientId);
  if (!client) return;
  removeFromQueue(clientId);
  client.status = 'waiting';
  client.queueSince = Date.now();
  waitingQueue.push(clientId);
  sendEvent(clientId, 'status', { state: 'waiting', message: 'Finding someone to chat with...' });
  attemptMatch(clientId);
}

function removeFromQueue(clientId) {
  const index = waitingQueue.indexOf(clientId);
  if (index >= 0) {
    waitingQueue.splice(index, 1);
  }
}

function attemptMatch(clientId) {
  const client = clients.get(clientId);
  if (!client || client.status !== 'waiting') return;

  let matchIndex = -1;
  for (let i = 0; i < waitingQueue.length; i++) {
    const candidateId = waitingQueue[i];
    if (candidateId === clientId) continue;
    const candidate = clients.get(candidateId);
    if (!candidate || candidate.status !== 'waiting') continue;

    if (haveSharedInterests(client.interests, candidate.interests)) {
      matchIndex = i;
      break;
    }
    if (matchIndex === -1) {
      matchIndex = i;
    }
  }

  if (matchIndex === -1) {
    return;
  }

  const partnerId = waitingQueue.splice(matchIndex, 1)[0];
  removeFromQueue(clientId);

  createRoom(clientId, partnerId);
}

function createRoom(clientId, partnerId) {
  const roomId = randomUUID();
  const client = ensureClientState(clientId);
  const partner = ensureClientState(partnerId);
  if (!client || !partner) return;

  client.status = 'chatting';
  partner.status = 'chatting';
  client.partnerId = partnerId;
  partner.partnerId = clientId;
  client.roomId = roomId;
  partner.roomId = roomId;

  rooms.set(roomId, {
    id: roomId,
    members: [clientId, partnerId],
    createdAt: Date.now()
  });

  sendEvent(clientId, 'status', { state: 'chatting', message: 'You are now chatting with a stranger.' });
  sendEvent(partnerId, 'status', { state: 'chatting', message: 'You are now chatting with a stranger.' });
  sendEvent(clientId, 'partner', {
    nickname: partner.nickname,
    country: partner.country || 'Unknown',
    countryCode: partner.countryCode || null,
    avatarImage: partner.avatarImage,
    interests: partner.interests || []
  });
  sendEvent(partnerId, 'partner', {
    nickname: client.nickname,
    country: client.country || 'Unknown',
    countryCode: client.countryCode || null,
    avatarImage: client.avatarImage,
    interests: client.interests || []
  });
}

function leaveRoom(clientId, options = {}) {
  const { notifyPartner = true, partnerMessage = 'Stranger disconnected.', requeuePartner = false } = options;
  const client = clients.get(clientId);
  if (!client || !client.roomId) return;

  const roomId = client.roomId;
  const room = rooms.get(roomId);
  const partnerId = client.partnerId;
  rooms.delete(roomId);

  client.roomId = null;
  client.partnerId = null;
  client.status = 'idle';
  sendEvent(clientId, 'status', { state: 'idle', message: 'Chat ended.' });

  if (partnerId) {
    const partner = clients.get(partnerId);
    if (partner) {
      partner.roomId = null;
      partner.partnerId = null;
      partner.status = requeuePartner ? 'waiting' : 'idle';
      if (notifyPartner) {
        sendEvent(partnerId, 'status', {
          state: requeuePartner ? 'waiting' : 'partner-left',
          message: partnerMessage
        });
      }
      if (requeuePartner) {
        addToQueue(partnerId);
      }
    }
  }
}

function setClientIdle(clientId) {
  const client = clients.get(clientId);
  if (!client) return;
  client.status = 'idle';
  client.partnerId = null;
  client.roomId = null;
  sendEvent(clientId, 'status', { state: 'idle', message: 'You are offline.' });
}

function cleanupClient(clientId) {
  const client = clients.get(clientId);
  if (!client) return;
  if (client.roomId) {
    const displayName = client.nickname || 'Stranger';
    leaveRoom(clientId, { notifyPartner: true, partnerMessage: `${displayName} disconnected.`, requeuePartner: false });
  }
  removeFromQueue(clientId);
  clients.delete(clientId);
  broadcastOnlineCount();
}

function pushStatusUpdate(clientId) {
  const client = clients.get(clientId);
  if (!client) return;
  sendEvent(clientId, 'status', { state: client.status, message: statusMessageFor(client.status) });
}

function statusMessageFor(state) {
  switch (state) {
    case 'waiting':
      return 'Finding someone to chat with...';
    case 'chatting':
      return 'You are now chatting.';
    default:
      return 'Ready when you are.';
  }
}

function sendEvent(clientId, event, payload) {
  const client = clients.get(clientId);
  if (!client || !client.sse) return;
  client.sse.write(`event: ${event}\n`);
  client.sse.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastOnlineCount() {
  const onlineCount = Array.from(clients.values()).filter((client) => client.isConnected).length;
  clients.forEach((client) => {
    if (client.sse) {
      sendEvent(client.id, 'online', { count: onlineCount });
    }
  });
}

function serveStaticFile(requestPath, res) {
  let filePath = path.join(PUBLIC_DIR, requestPath === '/' ? 'index.html' : requestPath);
  const normalizedPath = path.normalize(filePath);
  if (!normalizedPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Access denied');
  }

  fs.stat(normalizedPath, (err, stats) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }

    if (stats.isDirectory()) {
      filePath = path.join(normalizedPath, 'index.html');
    } else {
      filePath = normalizedPath;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500);
        return res.end('Server error');
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
}

function sanitizeNickname(value) {
  if (!value) return 'Stranger';
  return String(value).slice(0, 20).replace(/[^a-z0-9\s_\-]/gi, '').trim() || 'Stranger';
}

function sanitizeCountryName(value) {
  if (!value) return null;
  return String(value).slice(0, 40).replace(/[^a-z\s\-']/gi, '').trim() || null;
}

function sanitizeCountryCode(value) {
  if (!value) return null;
  const code = String(value).trim().slice(0, 3).toUpperCase();
  return /^[A-Z]{2,3}$/.test(code) ? code : null;
}

function sanitizeMessage(text) {
  let cleaned = String(text).slice(0, 500);
  BAD_WORDS.forEach((word) => {
    const regex = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi');
    cleaned = cleaned.replace(regex, '***');
  });
  return cleaned;
}

function sanitizeAvatarImage(value) {
  if (!value || typeof value !== 'string') return null;
  if (!value.startsWith('data:image/') || !value.includes('base64,')) return null;
  if (value.length > MAX_AVATAR_IMAGE_LENGTH) return null;
  const safe = value.replace(/\s/g, '');
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+$/.test(safe) ? safe : null;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function haveSharedInterests(a = [], b = []) {
  if (!a.length || !b.length) return false;
  const setB = new Set(b);
  return a.some((interest) => setB.has(interest));
}

function extractJson(req, res) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        req.connection.destroy();
      }
    });
    req.on('end', () => {
      try {
        const parsed = data ? JSON.parse(data) : {};
        resolve(parsed);
      } catch (err) {
        res.writeHead(400);
        res.end('Invalid JSON');
        resolve(null);
      }
    });
  });
}

server.listen(PORT, () => {
  console.log(`The Corner chat server running on http://localhost:${PORT}`);
});

module.exports = server;
