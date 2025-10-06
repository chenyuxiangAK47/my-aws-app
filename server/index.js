const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const fs = require('fs');
const fsp = fs.promises;
const jwt = require('jsonwebtoken');
const { z } = require('zod');

// >>> REDIS: 自动降级内存模式（核心修复）
let useRedis = true;
let redis = null;
// 内存兜底存储（Redis不可用时自动切换）
const memStore = new Map();

try {
  const Redis = require('ioredis');
  redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  // Redis连接失败时降级
  redis.on('error', (err) => {
    console.error('[REDIS] 连接失败，自动降级到内存模式:', err.message);
    useRedis = false;
  });
} catch (e) {
  console.error('[REDIS] 模块未安装或初始化失败，使用内存模式:', e.message);
  useRedis = false;
}

// 封装Redis/内存通用方法（所有操作通过这些方法调用，自动适配）
const rExists = async (key) => useRedis ? (await redis.exists(key)) : (memStore.has(key) ? 1 : 0);
const rHSet = async (key, obj) => {
  if (useRedis) return redis.hset(key, obj);
  // 内存模式：合并对象
  memStore.set(key, { ...(memStore.get(key) || {}), ...obj });
  return 1;
};
const rHGetAll = async (key) => {
  if (useRedis) return redis.hgetall(key);
  // 内存模式：返回空对象兜底
  return memStore.get(key) || {};
};
const rSet = async (key, val, ...args) => {
  if (useRedis) return redis.set(key, val, ...args);
  // 内存模式忽略TTL（简单兜底）
  memStore.set(key, val);
  return 'OK';
};
const rGet = async (key) => {
  if (useRedis) return redis.get(key);
  return memStore.get(key) ?? null;
};
const rSAdd = async (key, member) => {
  if (useRedis) return redis.sadd(key, member);
  // 内存模式用Set存储集合
  const set = memStore.get(key) || new Set();
  const beforeSize = set.size;
  set.add(member);
  memStore.set(key, set);
  return set.size - beforeSize;
};
const rSMembers = async (key) => {
  if (useRedis) return redis.smembers(key);
  // 内存模式返回数组
  const set = memStore.get(key);
  return set ? Array.from(set) : [];
};
const rDel = async (...keys) => {
  if (useRedis) return redis.del(...keys);
  // 内存模式批量删除
  let count = 0;
  for (const k of keys) {
    if (memStore.delete(k)) count++;
  }
  return count;
};
const rSRem = async (key, member) => {
  if (useRedis) return redis.srem(key, member);
  // 内存模式删除集合元素
  const set = memStore.get(key);
  if (!set) return 0;
  const beforeSize = set.size;
  set.delete(member);
  memStore.set(key, set);
  return beforeSize - set.size;
};
// <<< REDIS

// >>> 历史缓存工具（基于封装的Redis/内存方法）
function buildHistoryKey({ page = 1, pageSize = 100, limit, since = '', start = '', end = '', keyword = '' }) {
  const p = Number(page) || 1;
  const ps = Number(pageSize || limit || 100) || 100;
  const s = (since || '').toString().trim();
  const st = (start || '').toString().trim();
  const ed = (end || '').toString().trim();
  const kw = (keyword || '').toString().trim().toLowerCase();
  return `history:v2:p=${p}|ps=${ps}|since=${s}|start=${st}|end=${ed}|kw=${kw}`;
}

async function indexHistoryKey(key) {
  await rSAdd('idx:history:all', key);
}
async function invalidateAllHistoryCache() {
  try {
    const keys = await rSMembers('idx:history:all');
    if (keys.length) await rDel(...keys);
    await rDel('idx:history:all');
  } catch (e) {
    console.error('[缓存] 失效失败:', e.message);
  }
}
// <<< 历史缓存工具

// ===== 环境配置 =====
const PORT = process.env.PORT || 3000;
const AWS_REGION = process.env.AWS_REGION || 'ap-southeast-2';
const TABLE_NAME = process.env.TABLE_NAME || 'Messages';
const USE_DDB = (process.env.USE_DDB || 'true').toLowerCase() !== 'false';
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret';

// 兼容多种TTL写法：JWT_ACCESS_TTL=900s/JWT_REFRESH_TTL=7d 或 *_SEC=秒数
function parseDurationToSec(input, defSec) {
  if (!input) return defSec;
  if (/^\d+$/.test(input)) return parseInt(input, 10);
  const m = String(input).trim().match(/^(\d+)\s*([smhd])$/i);
  if (!m) return defSec;
  const n = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  const mul = u === 's' ? 1 : u === 'm' ? 60 : u === 'h' ? 3600 : 86400; // d=天
  return n * mul;
}
const ACCESS_TTL_S = parseDurationToSec(process.env.JWT_ACCESS_TTL, parseInt(process.env.ACCESS_TTL_SEC || '900', 10));
const REFRESH_TTL_S = parseDurationToSec(process.env.JWT_REFRESH_TTL, parseInt(process.env.REFRESH_TTL_SEC || String(7 * 24 * 3600), 10));

// ===== AWS SDK (v3) =====
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

// ===== 应用实例 & 中间件 =====
const app = express();
app.set('trust proxy', 'loopback');

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// JSON日志 + reqId
app.use((req, _res, next) => { req.reqId = Math.random().toString(36).slice(2, 10); next(); });
app.use(morgan((tokens, req, res) => JSON.stringify({
  time: new Date().toISOString(),
  reqId: req.reqId,
  method: tokens.method(req, res),
  url: tokens.url(req, res),
  status: tokens.status(req, res),
  ip: req.ip,
  length: tokens.res(req, res, 'content-length'),
  duration: tokens['response-time'](req, res) + ' ms',
})));

// ===== CORS 配置（宽松匹配，核心修复）=====
const envOrigins = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const allowList = [
  /^http:\/\/localhost(:\d+)?$/,             // 本地开发（任意端口）
  /^http:\/\/13\.238\.255\.17(:\d+)?$/,      // 公网IP（任意端口，解决3000端口被拒问题）
  /^https:\/\/13-238-255-17\.sslip\.io$/,    // sslip域名（无端口）
  ...envOrigins.map(o => new RegExp(o)),     // 环境变量配置的额外规则
];

app.use(cors({
  origin(origin, cb) {
    // 允许无origin请求（如curl、健康检查）
    if (!origin) return cb(null, true);
    // 匹配白名单中的正则或精确值
    const isAllowed = allowList.some(rule => 
      rule.test ? rule.test(origin) : rule === origin
    );
    if (isAllowed) return cb(null, true);
    // 拒绝不匹配的origin
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: false,
}));

// ===== 本地兜底存储 =====
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'history.json');
let history = [];

async function loadHistory() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const buf = await fsp.readFile(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(buf);
    history = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    history = [];
    if (err.code === 'ENOENT') await saveHistory();
    else console.error('加载历史失败:', err);
  }
}
async function saveHistory() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(history, null, 2), 'utf-8');
    await fsp.rename(tmp, DATA_FILE);
  } catch (err) {
    console.error('保存历史失败:', err);
  }
}

// ===== DynamoDB 客户端 =====
let ddbDoc = null;
if (USE_DDB) {
  const ddb = new DynamoDBClient({ region: AWS_REGION });
  ddbDoc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } });
  console.log(`[DDB] Enabled. region=${AWS_REGION}, table=${TABLE_NAME}`);
} else {
  console.log('[DDB] Disabled (USE_DDB=false). Use local file only.');
}

// ===== 工具函数 =====
function httpError(status, message, code = 'ERR_GENERIC') {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// JWT 鉴权中间件（requiredRole 可传 'admin'）
function auth(requiredRole = null) {
  return (req, _res, next) => {
    const raw = req.get('authorization') || '';
    if (!raw.startsWith('Bearer ')) return next(httpError(401, 'Missing Bearer token', 'ERR_NO_TOKEN'));
    const token = raw.slice(7);
    try {
      const payload = jwt.verify(token, ACCESS_SECRET);
      req.user = payload; // { uid, role, ... }
      if (requiredRole && payload.role !== requiredRole) {
        return next(httpError(403, 'Forbidden', 'ERR_FORBIDDEN'));
      }
      next();
    } catch {
      next(httpError(401, 'Invalid or expired token', 'ERR_BAD_TOKEN'));
    }
  };
}

// ===== DynamoDB 读写 =====
async function ddbPut(item) {
  if (!ddbDoc) return false;
  try {
    await ddbDoc.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
    return true;
  } catch (e) {
    console.error('[DDB] Put error:', e);
    return false;
  }
}

// 表无 sort key：Scan → 本地按 timeISO 排序
async function ddbScanRecent(limit = 100) {
  if (!ddbDoc) return null;
  try {
    let items = [];
    let ExclusiveStartKey;
    do {
      const out = await ddbDoc.send(new ScanCommand({
        TableName: TABLE_NAME,
        ProjectionExpression: '#id, #text, ip, ua, timeISO, timeLocal',
        ExpressionAttributeNames: { '#id': 'id', '#text': 'text' },
        ExclusiveStartKey,
      }));
      if (out.Items) items.push(...out.Items);
      ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey && items.length < limit * 3);

    items.sort((a, b) => new Date(a.timeISO) - new Date(b.timeISO));
    return items.slice(-limit);
  } catch (e) {
    console.error('[DDB] Scan error:', e);
    return null;
  }
}

// ===== 限流 =====
const authLimiter = rateLimit({
  windowMs: 60_000, // 1 分钟
  max: 10,          // 每分钟最多 10 次
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(['/auth/register', '/auth/login', '/auth/refresh', '/auth/logout', '/auth/logout-all'], authLimiter);

const normalLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false });
app.use('/api/', normalLimiter);

// ===== 账号鉴权（register/login/refresh/logout）=====
const bcrypt = require('bcryptjs');

// Redis Key 规范（基于封装方法，自动适配内存）
const rkUser = (email) => `user:${email.toLowerCase()}`;         // Hash: { hash, role, createdAt }
const rkRTJti = (jti) => `rt:jti:${jti}`;                         // String: uid (TTL=refresh时长)
const rkRTUserSet = (uid) => `rt:uidset:${uid}`;                  // Set: 该 uid 持有的 jti 集合

// 小工具
function newId() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
function signAccess(payloadExtra) {
  return jwt.sign(payloadExtra, ACCESS_SECRET, { expiresIn: ACCESS_TTL_S });
}
function signRefresh(uid) {
  const jti = newId();
  const token = jwt.sign({ uid, jti }, REFRESH_SECRET, { expiresIn: REFRESH_TTL_S });
  return { token, jti };
}

async function allowRefreshJti(uid, jti, ttl = REFRESH_TTL_S) {
  await rSet(rkRTJti(jti), uid, 'EX', ttl);
  await rSAdd(rkRTUserSet(uid), jti);
}
async function revokeRefreshJti(jti) {
  const key = rkRTJti(jti);
  const uid = await rGet(key);
  if (uid) await rSRem(rkRTUserSet(uid), jti);
  await rDel(key);
}
async function revokeAllRefreshByUid(uid) {
  const setKey = rkRTUserSet(uid);
  const allJti = await rSMembers(setKey);
  if (allJti && allJti.length) await rDel(...allJti.map(rkRTJti));
  await rDel(setKey);
}

// —— 校验 Schema
const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6, '密码至少 6 位'),
});
const LoginSchema = RegisterSchema;
const RefreshSchema = z.object({
  refreshToken: z.string().min(10),
});

// —— 路由：注册
app.post('/auth/register', async (req, res, next) => {
  try {
    const { email, password } = RegisterSchema.parse(req.body || {});
    const key = rkUser(email);
    const existed = await rExists(key); // 使用封装方法
    if (existed) return res.status(409).json({ error: 'User exists' }); // 409更符合资源冲突语义

    const hash = await bcrypt.hash(password, 10);
    await rHSet(key, { // 使用封装方法
      hash,
      role: 'user',
      createdAt: new Date().toISOString(),
    });

    res.json({ message: 'Registered' });
  } catch (err) {
    if (err?.issues) err.status = 400;
    next(err);
  }
});

// —— 路由：登录
app.post('/auth/login', async (req, res, next) => {
  try {
    const { email, password } = LoginSchema.parse(req.body || {});
    const key = rkUser(email);
    const user = await rHGetAll(key); // 使用封装方法
    if (!user || !user.hash) return res.status(400).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.hash);
    if (!ok) return res.status(400).json({ error: 'Invalid credentials' });

    const uid = email.toLowerCase();
    const role = user.role || 'user';

    const accessToken = signAccess({ uid, role });
    const { token: refreshToken, jti } = signRefresh(uid);
    await allowRefreshJti(uid, jti);

    res.json({ accessToken, accessTTL: ACCESS_TTL_S, refreshToken, refreshTTL: REFRESH_TTL_S });
  } catch (err) {
    if (err?.issues) err.status = 400;
    next(err);
  }
});

// —— 路由：刷新（单次轮转）
app.post('/auth/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = RefreshSchema.parse(req.body || {});
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, REFRESH_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const { uid, jti } = decoded || {};
    if (!uid || !jti) return res.status(401).json({ error: 'Malformed refresh token' });

    const valid = await rGet(rkRTJti(jti)); // 使用封装方法
    if (valid !== uid) return res.status(401).json({ error: 'Refresh token revoked' });

    // 撤销旧jti
    await revokeRefreshJti(jti);

    // 重新获取用户角色（可能已变更）
    const user = await rHGetAll(rkUser(uid)); // 使用封装方法
    const role = user?.role || 'user';

    const accessToken = signAccess({ uid, role });
    const { token: newRefreshToken, jti: newJti } = signRefresh(uid);
    await allowRefreshJti(uid, newJti);

    res.json({ accessToken, accessTTL: ACCESS_TTL_S, refreshToken: newRefreshToken, refreshTTL: REFRESH_TTL_S });
  } catch (err) {
    if (err?.issues) err.status = 400;
    next(err);
  }
});

// —— 路由：登出（撤销当前refresh）
app.post('/auth/logout', async (req, res) => {
  const raw = req.get('authorization') || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';

  if (!token) return res.status(400).json({ error: 'Missing refresh token (in Authorization header)' });

  try {
    const { jti } = jwt.verify(token, REFRESH_SECRET);
    if (jti) await revokeRefreshJti(jti);
  } catch { /* 忽略无效token */ }

  res.json({ message: 'Logged out' });
});

// —— 路由：强制全端下线（仅admin）
app.post('/auth/logout-all', auth('admin'), async (req, res) => {
  const uid = (req.body?.uid || '').toLowerCase().trim();
  if (!uid) return res.status(400).json({ error: 'uid required' });
  await revokeAllRefreshByUid(uid);
  res.json({ message: `All refresh tokens revoked for ${uid}` });
});

// ===== 基础路由 =====
app.get('/api/health', (req, res) => {
  res.json({ 
    ok: true, 
    ip: req.ip, 
    time: new Date().toISOString(), 
    version: '1.0.0', 
    ddb: !!ddbDoc,
    redis: useRedis ? 'connected' : 'in-memory' // 增加Redis状态反馈
  });
});

// Day1：文件读写
const PLAYGROUND_DIR = path.join(__dirname, 'playground');

app.get('/api/fs-test', async (req, res, next) => {
  try {
    const name = (req.query.file || 'hello.txt').toString();
    const filePath = path.join(PLAYGROUND_DIR, path.basename(name));
    const content = await fsp.readFile(filePath, 'utf-8');
    res.json({ file: path.basename(name), content });
  } catch {
    next(httpError(404, 'File not found', 'ERR_FILE_NOT_FOUND'));
  }
});

app.post('/api/fs-test', async (req, res, next) => {
  try {
    const name = ((req.body && req.body.file) || '').toString().trim() || 'note.txt';
    const content = ((req.body && req.body.content) || '').toString();
    const filePath = path.join(PLAYGROUND_DIR, path.basename(name));
    await fsp.mkdir(PLAYGROUND_DIR, { recursive: true });
    await fsp.writeFile(filePath, content, 'utf-8');
    res.json({ message: 'saved', file: path.basename(name) });
  } catch (err) {
    next(err);
  }
});

// ===== S3 预签名上传 =====
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const S3_BUCKET = process.env.S3_BUCKET;
if (!S3_BUCKET) {
  console.warn('⚠️  S3_BUCKET 未配置，/file/presign 路由将不可用');
}
const s3 = S3_BUCKET ? new S3Client({ region: AWS_REGION }) : null;

// 生成预签名 URL
app.post('/file/presign', auth(), async (req, res, next) => {
  try {
    if (!S3_BUCKET || !s3) throw new Error('S3 配置未初始化');
    
    const schema = z.object({
      filename: z.string().min(1),
      contentType: z.string().min(1),
    });
    const { filename, contentType } = schema.parse(req.body || {});
    const uid = req.user.uid;

    const key = `uploads/${uid}/${Date.now()}-${path.basename(filename)}`;

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ContentType: contentType,
    });

    const url = await getSignedUrl(s3, command, { expiresIn: 3600 }); // 1h
    res.json({ url, key });
  } catch (err) {
    if (err?.issues) err.status = 400;
    next(err);
  }
});

// 开发登录：生成 JWT（修复旧 SECRET 问题）
app.post('/api/dev/login', (req, res) => {
  const { uid, role } = req.body || {};
  if (!uid || !role) return res.status(400).json({ error: 'uid/role 必填' });
  const token = jwt.sign({ uid, role }, ACCESS_SECRET, { expiresIn: ACCESS_TTL_S }); // 统一用ACCESS_SECRET
  res.json({ token, ttl: ACCESS_TTL_S });
});

// 历史：分页 + 筛选 + 缓存
app.get('/api/history', async (req, res, next) => {
  try {
    const schema = z.object({
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().min(1).max(500).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      since: z.string().datetime().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      keyword: z.string().optional().default(''),
    }).superRefine((q, ctx) => {
      const toMs = (s) => {
        if (!s) return null;
        const ms = Date.parse(s);
        return Number.isNaN(ms) ? null : ms;
      };
      const s = toMs(q.start);
      const e = toMs(q.end);
      if (q.start && s === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'start 非法日期', path: ['start'] });
      if (q.end && e === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'end 非法日期', path: ['end'] });
      if (s != null && e != null && s > e) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'start 不能大于 end', path: ['start'] });
    });

    const q = schema.parse({
      page: req.query.page,
      pageSize: req.query.pageSize,
      limit: req.query.limit,
      since: req.query.since,
      start: req.query.start,
      end: req.query.end,
      keyword: req.query.keyword,
    });

    const pageSize = q.pageSize ?? q.limit ?? 100;
    const page = q.page ?? 1;

    // 查缓存
    const cacheKey = buildHistoryKey({
      page, pageSize, limit: q.limit, since: q.since ?? '',
      start: q.start ?? '', end: q.end ?? '', keyword: q.keyword ?? ''
    });
    const cached = await rGet(cacheKey).catch(() => null); // 使用封装方法
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(JSON.parse(cached));
    }

    // 回源数据
    let list = (await ddbScanRecent(page * pageSize * 3)) ?? history;

    // 筛选逻辑
    if (q.since) {
      const sinceMs = Date.parse(q.since);
      if (!Number.isNaN(sinceMs)) list = list.filter(x => Date.parse(x.timeISO) >= sinceMs);
    }
    const toMs = (s) => (s ? Date.parse(s) : NaN);
    const startMs = toMs(q.start);
    const endMs = toMs(q.end);
    if (!Number.isNaN(startMs)) list = list.filter(x => Date.parse(x.timeISO) >= startMs);
    if (!Number.isNaN(endMs)) list = list.filter(x => Date.parse(x.timeISO) <= endMs);
    const kw = (q.keyword || '').trim().toLowerCase();
    if (kw) list = list.filter(x => (x.text || '').toString().toLowerCase().includes(kw));

    // 排序分页
    list.sort((a, b) => new Date(a.timeISO) - new Date(b.timeISO));
    const recent = list.slice(-page * pageSize);
    const startIdx = Math.max(0, recent.length - pageSize);
    const pageData = recent.slice(startIdx);

    const payload = { page, pageSize, count: pageData.length, items: pageData };

    // 写缓存
    await rSet(cacheKey, JSON.stringify(payload), 'EX', Number(process.env.HISTORY_CACHE_TTL || 60)).catch(() => {}); // 使用封装方法
    await indexHistoryKey(cacheKey).catch(() => {});
    res.setHeader('X-Cache', 'MISS');

    res.json(payload);
  } catch (err) {
    if (err?.issues) err.status = 400;
    next(err);
  }
});

// 提交（需要登录）
app.post('/api/submit', auth(), async (req, res, next) => {
  try {
    const Body = z.object({
      text: z.string().trim().min(1, 'text 不能为空').max(500, 'text 过长（<=500）'),
    });
    const { text } = Body.parse(req.body);

    const now = new Date();
    const item = {
      id: newId(),
      text,
      ip: req.ip,
      ua: req.get('user-agent') || '',
      timeISO: now.toISOString(),
      timeLocal: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
      uid: req.user?.uid || 'anonymous',
    };

    const ok = await ddbPut(item);
    if (!ok) {
      history.push(item);
      if (history.length > 1000) history = history.slice(-1000);
      await saveHistory();
    }

    await invalidateAllHistoryCache().catch(() => {});

    res.json({ message: '已收到，感谢提交！', item, persisted: ok ? 'dynamodb' : 'file' });
  } catch (err) {
    if (err?.issues) err.status = 400;
    next(err);
  }
});

// 清空历史（仅admin）
app.delete('/api/history', adminLimiter, auth('admin'), async (_req, res, next) => {
  try {
    history = [];
    await saveHistory();
    await invalidateAllHistoryCache().catch(() => {});
    res.json({ message: '本地历史已清空（DynamoDB 未清理）' });
  } catch (err) {
    next(err);
  }
});

// ===== 404 & 错误处理 =====
app.use((req, res) => {
  res.status(404).json({ error: { code: 'ERR_NOT_FOUND', message: 'Not Found' } });
});
app.use((err, req, res, _next) => {
  const status = Number(err.status || 500);
  const code = err.code || 'ERR_GENERIC';
  if (status >= 500) console.error('Server Error:', err);
  res.status(status).json({ error: { code, message: err.message || 'Internal Server Error' } });
});

// ===== 启动 =====
loadHistory().then(() => {
  app.listen(PORT, () => {
    console.log(`API running at http://localhost:${PORT}`);
    console.log(`Redis 状态: ${useRedis ? '已连接' : '内存模式'}`);
    console.log(`CORS 白名单匹配规则: ${JSON.stringify(allowList.map(rule => rule.toString()))}`);
  });
});