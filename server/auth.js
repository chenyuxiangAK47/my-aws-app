// server/auth.js
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev_access_secret';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret';
const ACCESS_TTL   = process.env.JWT_ACCESS_TTL   || '15m';
const REFRESH_TTL  = process.env.JWT_REFRESH_TTL  || '7d';
const USERS_TABLE  = process.env.USERS_TABLE || 'Users';

// ---- Storage layer: DynamoDB (primary) + file fallback ----
let useFile = false;
let ddb;
try {
  const { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
  ddb = {
    client: new DynamoDBClient({}),
    get: async (username) => {
      const { Item } = await ddb.client.send(new GetItemCommand({
        TableName: USERS_TABLE,
        Key: { username: { S: username } }
      }));
      if (!Item) return null;
      return {
        username: Item.username.S,
        passwordHash: Item.passwordHash.S,
        refreshToken: Item.refreshToken?.S || null,
      };
    },
    put: async (u) => {
      await ddb.client.send(new PutItemCommand({
        TableName: USERS_TABLE,
        Item: {
          username:     { S: u.username },
          passwordHash: { S: u.passwordHash },
          refreshToken: { S: u.refreshToken || '' },
        }
      }));
    },
    setRefresh: async (username, token) => {
      const { UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
      await ddb.client.send(new UpdateItemCommand({
        TableName: USERS_TABLE,
        Key: { username: { S: username } },
        UpdateExpression: 'SET refreshToken = :t',
        ExpressionAttributeValues: { ':t': { S: token || '' } }
      }));
    }
  };
} catch {
  useFile = true;
}

const fileStorePath = path.join(__dirname, 'users.local.json');
const fileStore = {
  load: () => {
    if (!fs.existsSync(fileStorePath)) return {};
    try { return JSON.parse(fs.readFileSync(fileStorePath, 'utf8')); }
    catch { return {}; }
  },
  save: (obj) => fs.writeFileSync(fileStorePath, JSON.stringify(obj, null, 2)),
  async get(username) {
    const db = fileStore.load();
    return db[username] || null;
  },
  async put(u) {
    const db = fileStore.load();
    db[u.username] = u;
    fileStore.save(db);
  },
  async setRefresh(username, token) {
    const db = fileStore.load();
    if (!db[username]) return;
    db[username].refreshToken = token || '';
    fileStore.save(db);
  }
};

const store = useFile ? fileStore : ddb;

// ---- helpers ----
function signAccess(payload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
}
function signRefresh(payload) {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_TTL });
}

// ---- routes ----
// register
router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username/password required' });
    const exists = await store.get(username);
    if (exists) return res.status(409).json({ error: 'user exists' });
    const passwordHash = await bcrypt.hash(password, 10);
    await store.put({ username, passwordHash, refreshToken: '' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'register failed' });
  }
});

// login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await store.get(username);
    if (!user) return res.status(401).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });

    const accessToken = signAccess({ sub: username });
    const refreshToken = signRefresh({ sub: username, ver: Date.now() });
    await store.setRefresh(username, refreshToken);

    res.json({ accessToken, refreshToken, tokenType: 'Bearer', expiresIn: ACCESS_TTL });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'login failed' });
  }
});

// refresh
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });

    let payload;
    try {
      payload = jwt.verify(refreshToken, REFRESH_SECRET);
    } catch {
      return res.status(401).json({ error: 'invalid refresh token' });
    }

    const user = await store.get(payload.sub);
    if (!user || user.refreshToken !== refreshToken) {
      return res.status(401).json({ error: 'refresh token mismatch' });
    }

    const accessToken = signAccess({ sub: payload.sub });
    res.json({ accessToken, tokenType: 'Bearer', expiresIn: ACCESS_TTL });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'refresh failed' });
  }
});

// logout
router.post('/logout', async (req, res) => {
  try {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username required' });
    await store.setRefresh(username, '');
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'logout failed' });
  }
});

module.exports = router;
