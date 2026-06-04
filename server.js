require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const app = express();

// Stripe (payment)
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

// Nodemailer (email verification)
const nodemailer = require('nodemailer');
const mailer = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;

app.use(cors());
// Stripe webhook needs raw body BEFORE json parsing
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ──
const PORT = process.env.PORT || 3000;

// API Keys (all from env, never hardcoded)
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
const DEEPL_KEY = process.env.DEEPL_API_KEY || '';

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');
const JWT_EXPIRY = '7d';

// ── DeepSeek-based pricing (retail: what we charge users) ──
// DeepSeek wholesale: ~$0.2/M chars translate, ~$0.2/1K tokens
// Our retail with healthy margin:
const PRICE_TRANSLATION_PER_M = 2;       // $2 per million chars
const PRICE_CLEAN_PER_1K_TOKENS = 0.40;  // $0.40 per 1K tokens

// DeepSeek wholesale costs (for profit tracking & abuse prevention)
const COST_DEEPSEEK_PER_1K = 0.20;  // DeepSeek charges ~$0.20/1K tokens

// Per-user spending limits (anti-abuse)
const DAILY_SPEND_LIMIT = 50;     // $50/day per user
const MONTHLY_SPEND_LIMIT = 500;  // $500/month per user

// Email verification code helpers
function generateCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
async function sendVerificationEmail(email, code) {
  if (!mailer) { console.log(`[EMAIL] Would send code ${code} to ${email} (SMTP not configured)`); return; }
  await mailer.sendMail({
    from: process.env.SMTP_FROM || 'noreply@databridge.app',
    to: email,
    subject: 'DataBridge - 邮箱验证码',
    text: `您的验证码是：${code}\n\n有效期 10 分钟。如非本人操作请忽略。`,
    html: `<h2>DataBridge 邮箱验证</h2><p>您的验证码是：<strong style="font-size:24px">${code}</strong></p><p>有效期 10 分钟。</p>`
  });
}

// Backend detection
const hasDS = DEEPSEEK_KEY && !DEEPSEEK_KEY.startsWith('your-') && !DEEPSEEK_KEY.startsWith('sk-your-');
const hasOAI = OPENAI_KEY && !OPENAI_KEY.startsWith('your-') && !OPENAI_KEY.startsWith('sk-your-');
const hasDL = DEEPL_KEY && !DEEPL_KEY.startsWith('your-');

const LLM_BACKEND = hasDS ? 'deepseek' : hasOAI ? 'openai' : 'mock';
const TRANSLATION_BACKEND = hasDL ? 'deepl' : LLM_BACKEND;
const DEMO_MODE = LLM_BACKEND === 'mock';

// ── Data ──
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}');
if (!fs.existsSync(USAGE_FILE)) fs.writeFileSync(USAGE_FILE, '[]');

// ── Demo sessions (in-memory, no login) ──
const demoSessions = {};
const DEMO_MAX_PER_TYPE = 5;

// Mock Airtable data for demo mode
const DEMO_FIELDS = [
  { id: 'fld_name', name: 'Company Name', type: 'singleLineText' },
  { id: 'fld_desc', name: 'Description', type: 'multilineText' },
  { id: 'fld_email', name: 'Contact Email', type: 'email' },
  { id: 'fld_phone', name: 'Phone', type: 'phoneNumber' },
  { id: 'fld_revenue', name: 'Revenue', type: 'number' },
];
const DEMO_RECORDS = [
  { id:'rec01', 'Company Name':'  ACME Corp.  ', 'Description':'Leading provider of cloud-based SaaS solutions for enterprise customers worldwide', 'Contact Email':'john@acme  corp.com', 'Phone':'123-456-7890', 'Revenue':50000 },
  { id:'rec02', 'Company Name':'Globex Inc', 'Description':'Enterprise resource planning (ERP) software for manufacturing and supply chain management', 'Contact Email':'jane@globex.com', 'Phone':'+1 (555) 000-1111', 'Revenue':120000 },
  { id:'rec03', 'Company Name':'Initech', 'Description':null, 'Contact Email':'invalid-email', 'Phone':'N/A', 'Revenue':0 },
  { id:'rec04', 'Company Name':'Umbrella Co., Ltd.', 'Description':'Pharmaceutical research and development specializing in vaccines and immunology', 'Contact Email':'info@umbrella.co', 'Phone':'+44 20 7946 0958', 'Revenue':340000 },
  { id:'rec05', 'Company Name':'Hooli   ', 'Description':'Innovative technology solutions and digital transformation consulting for Fortune 500', 'Contact Email':'contact@hooli.io', 'Phone':'650-555-0199', 'Revenue':890000 },
  { id:'rec06', 'Company Name':'  Pied Piper', 'Description':'Decentralized compression algorithm enabling high-efficiency data storage', 'Contact Email':'richard@piedpiper.com', 'Phone':'+1-650-555-0178', 'Revenue':25000 },
  { id:'rec07', 'Company Name':'Stark Industries', 'Description':'Advanced weaponry, defense systems, and clean energy solutions', 'Contact Email':'tony@stark.com', 'Phone':'212-555-0188', 'Revenue':9999999 },
  { id:'rec08', 'Company Name':'Wayne Enterprises', 'Description':'Diversified multinational conglomerate with interests in technology and defense', 'Contact Email':'bruce@wayne.com', 'Phone':'+1-555-0100', 'Revenue':7500000 },
  { id:'rec09', 'Company Name':'Oscorp  Inc.', 'Description':'Genetic research, bio-engineering, and advanced military technology', 'Contact Email':'norman@oscorp com', 'Phone':'555-0190', 'Revenue':620000 },
  { id:'rec10', 'Company Name':' Massive Dynamic', 'Description':'Cutting-edge research in robotics, AI, and quantum computing', 'Contact Email':'walter@massivedynamic.com', 'Phone':'+1-617-555-0147', 'Revenue':4200000 },
];

// Cleanup stale demo sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of Object.entries(demoSessions)) {
    if (now - s.createdAt > 3600000) delete demoSessions[id];
  }
}, 600000);

// ── Helpers ──
function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return f === USERS_FILE ? {} : []; } }
function writeJSON(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

function estimateTokens(text) {
  const hasCJK = /[一-鿿]/.test(text);
  return Math.ceil(text.length / (hasCJK ? 1.5 : 4));
}

// ── Airtable client ──
async function airtableRequest(token, method, url, body = null) {
  const opts = { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || data.error || `Airtable error ${res.status}`);
  return data;
}

// ── Auth Middleware ──
function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// ── Rate Limiter (per user, 10 req/min on execute) ──
const executeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.userId || 'anon',
  handler: (req, res) => {
    res.status(429).json({ error: '请求太频繁，请每分钟最多 10 次', retryAfter: 60 });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// General limiter for auth routes (IP-based, uses default key gen)
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// ── LLM Helpers ──
async function llmChat(messages, maxTokens = 2000, retries = 3) {
  const isDS = LLM_BACKEND === 'deepseek';
  const url = isDS ? `${DEEPSEEK_URL}/chat/completions` : 'https://api.openai.com/v1/chat/completions';
  const key = isDS ? DEEPSEEK_KEY : OPENAI_KEY;
  const model = isDS ? DEEPSEEK_MODEL : OPENAI_MODEL;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: maxTokens }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      const data = await res.json();
      if (res.ok) return data;

      // Retryable errors
      if (res.status === 429 || res.status === 503 || res.status === 502) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        console.log(`[RETRY] ${LLM_BACKEND} ${res.status}, attempt ${attempt + 1}/${retries}, waiting ${Math.round(delay)}ms`);
        if (attempt < retries - 1) { await new Promise(r => setTimeout(r, delay)); continue; }
      }

      // Map common errors to friendly Chinese messages
      const errMap = {
        'rate_limit': 'AI 服务繁忙，请稍后重试',
        'insufficient_quota': 'AI 服务额度不足，请联系管理员',
        'invalid_api_key': 'AI 服务密钥无效',
        'timeout': 'AI 服务响应超时，正在重试...',
        'context_length': '数据量过大，请减少选中行数'
      };
      const msg = data.error?.message || data.error || '';
      for (const [k, v] of Object.entries(errMap)) {
        if (msg.includes(k)) throw new Error(v);
      }
      throw new Error(msg || `${LLM_BACKEND} 服务异常 (${res.status})`);
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('AI 服务响应超时，请减少数据量后重试');
      if (attempt === retries - 1 || !e.message.includes('重试')) throw e;
    }
  }
}

// Batch job queue (in-memory for MVP)
const batchJobs = {};
function createBatchJob(userId, action, records, fields, opts) {
  const jobId = 'job_' + Date.now().toString(36);
  const totalBatches = Math.ceil(records.length / 10);
  batchJobs[jobId] = { jobId, userId, action, fields, opts, totalBatches, completedBatches: 0, progress: 0, status: 'queued', results: { cleaned: {}, translated: {} }, totalCost: 0, createdAt: Date.now(), resultsPerBatch: [] };
  return jobId;
}

// ── Translation ──
async function translateWithDeepL(texts, sourceLang, targetLang) {
  const params = new URLSearchParams();
  params.append('target_lang', targetLang.toUpperCase());
  if (sourceLang && sourceLang !== 'auto') params.append('source_lang', sourceLang.toUpperCase());
  texts.forEach(t => params.append('text', t));
  const res = await fetch('https://api-free.deepl.com/v2/translate', {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${DEEPL_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || 'DeepL error');
  return data.translations.map(t => t.text);
}

async function translateWithLLM(texts, targetLang) {
  const names = { ZH: 'Simplified Chinese', EN: 'English', JA: 'Japanese', KO: 'Korean', FR: 'French', DE: 'German' };
  const targetName = names[targetLang] || targetLang;
  const data = await llmChat([
    { role: 'system', content: `You are a professional translator. Translate each text to ${targetName}. Return ONLY a JSON array of strings, nothing else.` },
    { role: 'user', content: `Translate:\n${JSON.stringify(texts)}` }
  ], 2000);
  const c = data.choices[0].message.content.trim();
  const m = c.match(/\[[\s\S]*\]/);
  return m ? JSON.parse(m[0]) : texts.map(() => '[翻译失败]');
}

// ── Cleaning ──
async function cleanWithLLM(records, instruction, fieldsToClean) {
  const prompt = `Clean this data according to: "${instruction}"

Fields to clean: ${fieldsToClean.join(', ')}
Records:
${JSON.stringify(records.map(r => { const o = {}; fieldsToClean.forEach(f => { if (r[f] !== undefined) o[f] = r[f]; }); return o; }), null, 2)}

Return ONLY a JSON array with cleaned values for each record. No other text.`;

  const data = await llmChat([
    { role: 'system', content: 'You are a precise data cleaning tool. Return valid JSON arrays only.' },
    { role: 'user', content: prompt }
  ], 4000);
  const content = data.choices[0].message.content.trim();
  const m = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
  return { cleaned: JSON.parse(m[1]), usage: data.usage };
}

// ── Mock functions (demo mode) ──
async function mockTranslate(texts, targetLang) {
  await new Promise(r => setTimeout(r, 200));
  const toZH = targetLang === 'ZH' || targetLang === 'zh';
  const map = { 'Hello':'你好','World':'世界','Good morning':'早上好','Cloud':'云端','software':'软件','solutions':'解决方案','enterprise':'企业','data':'数据','platform':'平台','service':'服务','analytics':'分析','machine learning':'机器学习' };
  return texts.map(t => toZH ? t.split(' ').map(w => map[w] || w).join(' ') : t.replace(/你好/g,'Hello').replace(/世界/g,'World'));
}

async function mockClean(records, instruction) {
  await new Promise(r => setTimeout(r, 200));
  const cleaned = records.map(r => {
    const result = {};
    for (const [k, v] of Object.entries(r)) {
      let val = v;
      if (typeof val === 'string') { val = val.trim().replace(/\s{2,}/g, ' ').replace(/\bInc\.?\s*$/i,'Inc.').replace(/\bCorp\.?\s*$/i,'Corp.'); }
      if ((!val || val === 'NULL') && instruction.includes('空值')) val = '[AI 推断]';
      result[k] = val;
    }
    return result;
  });
  const chars = JSON.stringify(records).length;
  return { cleaned, usage: { prompt_tokens: Math.ceil(chars/4), completion_tokens: Math.ceil(chars/6), total_tokens: Math.ceil(chars/4)+Math.ceil(chars/6) } };
}

// ═══════════════ Auth Routes ═══════════════

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: '邮箱和密码不能为空' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });

    const users = readJSON(USERS_FILE);
    const exists = Object.values(users).find(u => u.email === email);
    if (exists) return res.status(409).json({ error: '该邮箱已注册' });

    const userId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const hash = await bcrypt.hash(password, 10);
    const code = generateCode();

    users[userId] = {
      id: userId, email, passwordHash: hash, balance: 0,
      emailVerified: false, verificationCode: code, codeExpiresAt: Date.now() + 600000,
      dailySpend: 0, monthlySpend: 0, spendResetDaily: new Date().toISOString(), spendResetMonthly: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };
    writeJSON(USERS_FILE, users);

    // Send verification email (non-blocking)
    sendVerificationEmail(email, code).catch(e => console.error('Email send failed:', e.message));

    const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    res.status(201).json({ token, user: { id: userId, email, balance: 0, emailVerified: false } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: '邮箱和密码不能为空' });

    const users = readJSON(USERS_FILE);
    const user = Object.values(users).find(u => u.email === email);
    if (!user) return res.status(401).json({ error: '邮箱或密码错误' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: '邮箱或密码错误' });

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    res.json({ token, user: { id: user.id, email: user.email, balance: user.balance } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', authRequired, (req, res) => {
  const users = readJSON(USERS_FILE);
  const user = users[req.userId];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ id: user.id, email: user.email, balance: user.balance, emailVerified: user.emailVerified, createdAt: user.createdAt });
});

// Email verification
app.post('/api/auth/send-verification', authRequired, async (req, res) => {
  const users = readJSON(USERS_FILE);
  const user = users[req.userId];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.emailVerified) return res.json({ alreadyVerified: true });

  const code = generateCode();
  user.verificationCode = code;
  user.codeExpiresAt = Date.now() + 600000;
  writeJSON(USERS_FILE, users);

  try { await sendVerificationEmail(user.email, code); }
  catch(e) { return res.status(500).json({ error: '发送邮件失败，请稍后重试' }); }
  res.json({ sent: true });
});

app.post('/api/auth/verify-email', authRequired, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: '请输入验证码' });

  const users = readJSON(USERS_FILE);
  const user = users[req.userId];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.emailVerified) return res.json({ alreadyVerified: true });
  if (Date.now() > (user.codeExpiresAt || 0)) return res.status(400).json({ error: '验证码已过期，请重新发送' });
  if (user.verificationCode !== String(code)) return res.status(400).json({ error: '验证码错误' });

  user.emailVerified = true;
  user.verificationCode = null;
  user.codeExpiresAt = null;
  writeJSON(USERS_FILE, users);
  res.json({ verified: true });
});

// ═══════════════ API Routes ═══════════════

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', backend: LLM_BACKEND, demo: DEMO_MODE });
});

// ── Airtable connection (requires auth) ──
app.post('/api/connect', authRequired, async (req, res) => {
  try {
    const { pat, baseId } = req.body;
    if (!pat) return res.status(400).json({ error: 'PAT is required' });
    let url = 'https://api.airtable.com/v0/meta/bases';
    const data = await airtableRequest(pat, 'GET', url);
    res.json({ success: true, bases: (data.bases || []).map(b => ({ id: b.id, name: b.name })) });
  } catch (err) {
    res.status(401).json({ error: 'Connection failed: ' + err.message });
  }
});

app.get('/api/bases/:baseId/tables', authRequired, async (req, res) => {
  try {
    const pat = req.headers['x-airtable-pat'];
    if (!pat) return res.status(400).json({ error: 'PAT header required' });
    const url = `https://api.airtable.com/v0/meta/bases/${req.params.baseId}/tables`;
    const data = await airtableRequest(pat, 'GET', url);
    res.json({ tables: (data.tables || []).map(t => ({ id: t.id, name: t.name })) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/bases/:baseId/tables/:tableId/fields', authRequired, async (req, res) => {
  try {
    const pat = req.headers['x-airtable-pat'];
    if (!pat) return res.status(400).json({ error: 'PAT header required' });
    const url = `https://api.airtable.com/v0/meta/bases/${req.params.baseId}/tables`;
    const data = await airtableRequest(pat, 'GET', url);
    const table = (data.tables || []).find(t => t.id === req.params.tableId);
    if (!table) return res.status(404).json({ error: 'Table not found' });
    res.json({ fields: (table.fields || []).map(f => ({ id: f.id, name: f.name, type: f.type })) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/records', authRequired, async (req, res) => {
  try {
    const pat = req.headers['x-airtable-pat'];
    if (!pat) return res.status(400).json({ error: 'PAT header required' });
    const { baseId, tableId, maxRecords = 50, offset } = req.body;
    let url = `https://api.airtable.com/v0/${baseId}/${tableId}?maxRecords=${maxRecords}`;
    if (offset) url += `&offset=${offset}`;
    const data = await airtableRequest(pat, 'GET', url);
    res.json({
      records: (data.records || []).map(r => ({ id: r.id, ...r.fields })),
      offset: data.offset || null
    });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Estimate ──
app.post('/api/estimate', authRequired, (req, res) => {
  try {
    const { action, records, fields, sourceLang, targetLang, cleaningInstruction } = req.body;
    if (!records || !records.length) return res.status(400).json({ error: 'No records' });

    let cost = 0;
    const breakdown = {};

    if (action === 'translate' || action === 'both') {
      let chars = 0;
      records.forEach(r => fields.forEach(f => { if (r[f] && typeof r[f] === 'string') chars += r[f].length; }));
      const tc = (chars / 1_000_000) * PRICE_TRANSLATION_PER_M;
      breakdown.translation = { chars, rate: `$${PRICE_TRANSLATION_PER_M}/M chars`, cost: parseFloat(tc.toFixed(4)) };
      cost += tc;
    }

    if (action === 'clean' || action === 'both') {
      let tokens = 0;
      records.forEach(r => fields.forEach(f => { if (r[f] && typeof r[f] === 'string') tokens += estimateTokens(r[f]); }));
      if (cleaningInstruction) tokens += estimateTokens(cleaningInstruction);
      tokens = Math.ceil(tokens * 1.2);
      const cc = (tokens / 1000) * PRICE_CLEAN_PER_1K_TOKENS;
      breakdown.cleaning = { tokens, rate: `$${PRICE_CLEAN_PER_1K_TOKENS}/1K tokens`, cost: parseFloat(cc.toFixed(4)) };
      cost += cc;
    }

    res.json({ action, recordCount: records.length, fieldCount: fields.length, breakdown, totalCost: parseFloat(cost.toFixed(4)), minimumCost: 0.01, finalCost: parseFloat(Math.max(cost, 0.01).toFixed(4)) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Execute (rate limited) ──
app.post('/api/execute', authRequired, executeLimiter, async (req, res) => {
  try {
    const { action, records, fields, sourceLang, targetLang, cleaningInstruction } = req.body;
    if (!records || !records.length) return res.status(400).json({ error: 'No records' });

    const users = readJSON(USERS_FILE);
    const user = users[req.userId];
    if (!user) return res.status(404).json({ error: '用户不存在' });

    // 1. Estimate cost
    let estCost = 0, totalTokens = 0;
    if (action === 'translate' || action === 'both') {
      let chars = 0;
      records.forEach(r => fields.forEach(f => { if (r[f] && typeof r[f] === 'string') chars += r[f].length; }));
      estCost += (chars / 1_000_000) * PRICE_TRANSLATION_PER_M;
    }
    if (action === 'clean' || action === 'both') {
      let tokens = 0;
      records.forEach(r => fields.forEach(f => { if (r[f] && typeof r[f] === 'string') tokens += estimateTokens(r[f]); }));
      if (cleaningInstruction) tokens += estimateTokens(cleaningInstruction);
      tokens = Math.ceil(tokens * 1.2);
      estCost += (tokens / 1000) * PRICE_CLEAN_PER_1K_TOKENS;
    }
    const finalCost = parseFloat(Math.max(estCost, 0.01).toFixed(4));

    // 2. Anti-abuse: check daily/monthly spending limits
    const now = new Date();
    const lastDaily = new Date(user.spendResetDaily || user.createdAt);
    const lastMonthly = new Date(user.spendResetMonthly || user.createdAt);
    if (now.toDateString() !== lastDaily.toDateString()) { user.dailySpend = 0; user.spendResetDaily = now.toISOString(); }
    if (now.getMonth() !== lastMonthly.getMonth() || now.getFullYear() !== lastMonthly.getFullYear()) { user.monthlySpend = 0; user.spendResetMonthly = now.toISOString(); }
    if (user.dailySpend + finalCost > DAILY_SPEND_LIMIT) return res.status(429).json({ error: `日消费已达上限 $${DAILY_SPEND_LIMIT}，请明天再试` });
    if (user.monthlySpend + finalCost > MONTHLY_SPEND_LIMIT) return res.status(429).json({ error: `月消费已达上限 $${MONTHLY_SPEND_LIMIT}` });

    // 3. Check email verified
    if (!user.emailVerified) return res.status(403).json({ error: '请先验证邮箱后再使用', emailNotVerified: true });

    // 4. Check balance BEFORE calling APIs
    if (user.balance < finalCost) {
      return res.status(402).json({ error: '余额不足', required: finalCost, balance: user.balance, shortfall: parseFloat((finalCost - user.balance).toFixed(4)) });
    }

    // 3. Execute
    const results = { cleaned: {}, translated: {} };

    if (action === 'translate' || action === 'both') {
      const texts = [], textMap = [];
      records.forEach((r, ri) => fields.forEach(f => { if (r[f] && typeof r[f] === 'string') { texts.push(r[f]); textMap.push({ ri, f }); } }));
      if (texts.length > 0) {
        const translated = TRANSLATION_BACKEND === 'deepl'
          ? await translateWithDeepL(texts, sourceLang || 'auto', targetLang || 'ZH')
          : TRANSLATION_BACKEND !== 'mock'
            ? await translateWithLLM(texts, targetLang || 'ZH')
            : await mockTranslate(texts, targetLang || 'ZH');
        translated.forEach((t, i) => { const { ri, f } = textMap[i]; if (!results.translated[ri]) results.translated[ri] = {}; results.translated[ri][f] = t; });
      }
    }

    if (action === 'clean' || action === 'both') {
      const r = DEMO_MODE
        ? await mockClean(records, cleaningInstruction || 'Clean data')
        : await cleanWithLLM(records, cleaningInstruction || 'Clean and standardize data', fields);
      r.cleaned.forEach((c, i) => { if (!results.cleaned[i]) results.cleaned[i] = {}; Object.assign(results.cleaned[i], c); });
    }

    // 5. Deduct & track spending
    user.balance = parseFloat((user.balance - finalCost).toFixed(4));
    user.dailySpend = parseFloat(((user.dailySpend || 0) + finalCost).toFixed(4));
    user.monthlySpend = parseFloat(((user.monthlySpend || 0) + finalCost).toFixed(4));

    // Track wholesale cost for profit monitoring
    const wholesaleCost = parseFloat(((totalTokens || 0) / 1000 * COST_DEEPSEEK_PER_1K).toFixed(4));
    user._lastWholesaleCost = wholesaleCost;

    writeJSON(USERS_FILE, users);

    const usage = readJSON(USAGE_FILE);
    usage.push({ userId: req.userId, action, details: { recordCount: records.length, fields }, cost: finalCost, wholesaleCost, timestamp: new Date().toISOString() });
    writeJSON(USAGE_FILE, usage);

    // Alert if profit margin too thin (<20%)
    if (wholesaleCost > 0 && (finalCost - wholesaleCost) / finalCost < 0.2) {
      console.log(`[MARGIN] User ${req.userId}: retail $${finalCost} - wholesale $${wholesaleCost} = margin below 20%`);
    }

    res.json({ success: true, cost: finalCost, newBalance: user.balance, backend: LLM_BACKEND, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Write back ──
app.post('/api/writeback-v2', authRequired, async (req, res) => {
  try {
    const pat = req.headers['x-airtable-pat'];
    if (!pat) return res.status(400).json({ error: 'PAT header required' });
    const { baseId, tableId, updates } = req.body;
    if (!updates || !updates.length) return res.status(400).json({ error: 'No updates' });
    const url = `https://api.airtable.com/v0/${baseId}/${tableId}`;
    const data = await airtableRequest(pat, 'PATCH', url, { records: updates });
    res.json({ success: true, updated: (data.records || []).length });
  } catch (err) { res.status(400).json({ error: 'Write-back failed: ' + err.message }); }
});

// ── User info (requires auth, must match) ──
app.get('/api/users/me', authRequired, (req, res) => {
  const users = readJSON(USERS_FILE);
  const user = users[req.userId];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ id: user.id, email: user.email, balance: user.balance, createdAt: user.createdAt });
});

// ── Stripe Checkout ──
app.post('/api/stripe/create-checkout', authRequired, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: '支付系统未配置 (STRIPE_SECRET_KEY 未设置)' });
    const { amount } = req.body;
    const bonuses = { 10: 2, 50: 15, 100: 40 };
    if (!bonuses[amount]) return res.status(400).json({ error: '金额须为 $10, $50, 或 $100' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: { currency: 'usd', product_data: { name: `DataBridge 充值 $${amount} (+$${bonuses[amount]} 奖励)` }, unit_amount: amount * 100 },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${req.headers.origin || 'http://localhost:3000'}?topup=success`,
      cancel_url: `${req.headers.origin || 'http://localhost:3000'}?topup=cancel`,
      metadata: { userId: req.userId, amount: String(amount), bonus: String(bonuses[amount]) }
    });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stripe webhook (raw body, no JSON parsing)
app.post('/api/stripe/webhook', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  try {
    const sig = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
    if (event.type === 'checkout.session.completed') {
      const { userId, amount, bonus } = event.data.object.metadata;
      const users = readJSON(USERS_FILE);
      if (users[userId]) {
        const total = parseInt(amount) + parseInt(bonus);
        users[userId].balance = parseFloat((users[userId].balance + total).toFixed(4));
        writeJSON(USERS_FILE, users);
        const usage = readJSON(USAGE_FILE);
        usage.push({ userId, action: 'stripe_topup', details: { amount: parseInt(amount), bonus: parseInt(bonus) }, cost: 0, timestamp: new Date().toISOString() });
        writeJSON(USAGE_FILE, usage);
        console.log(`[STRIPE] User ${userId} topped up $${amount} + $${bonus} bonus`);
      }
    }
    res.json({ received: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Topup (new packages: $10/$50/$100) ──
app.post('/api/users/me/topup', authRequired, (req, res) => {
  try {
    const users = readJSON(USERS_FILE);
    const user = users[req.userId];
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (!user.emailVerified) return res.status(403).json({ error: '请先验证邮箱后再充值', emailNotVerified: true });

    const { amount } = req.body;
    const ta = parseFloat(amount);
    const bonuses = { 10: 2, 50: 15, 100: 40 };
    if (!bonuses[ta]) return res.status(400).json({ error: '充值金额须为 $10, $50, 或 $100' });

    const bonus = bonuses[ta];
    const total = ta + bonus;
    user.balance = parseFloat((user.balance + total).toFixed(4));
    writeJSON(USERS_FILE, users);

    const usage = readJSON(USAGE_FILE);
    usage.push({ userId: req.userId, action: 'topup', details: { amount: ta, bonus }, cost: 0, timestamp: new Date().toISOString() });
    writeJSON(USAGE_FILE, usage);

    res.json({ success: true, charged: ta, bonus, credited: total, newBalance: users[req.userId].balance });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/users/me/usage', authRequired, (req, res) => {
  const usage = readJSON(USAGE_FILE);
  const userUsage = usage.filter(u => u.userId === req.userId);

  // Aggregate stats
  const now = new Date();
  const thisMonth = userUsage.filter(u => new Date(u.timestamp).getMonth() === now.getMonth() && new Date(u.timestamp).getFullYear() === now.getFullYear());
  const thisWeek = userUsage.filter(u => (now - new Date(u.timestamp)) < 7 * 86400000);

  const stats = {
    totalSpent: parseFloat(userUsage.reduce((s, u) => s + (u.cost || 0), 0).toFixed(4)),
    thisMonth: parseFloat(thisMonth.reduce((s, u) => s + (u.cost || 0), 0).toFixed(4)),
    thisWeek: parseFloat(thisWeek.reduce((s, u) => s + (u.cost || 0), 0).toFixed(4)),
    translateCount: userUsage.filter(u => u.action === 'translate' || u.action === 'both').length,
    cleanCount: userUsage.filter(u => u.action === 'clean' || u.action === 'both').length,
    topupCount: userUsage.filter(u => u.action === 'topup' || u.action === 'stripe_topup').length,
    // Monthly breakdown for chart
    monthlyBreakdown: getMonthlyBreakdown(userUsage),
    recent: userUsage.slice(-50).reverse()
  };
  res.json(stats);
});

function getMonthlyBreakdown(usage) {
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const total = usage.filter(u => u.timestamp.startsWith(key)).reduce((s, u) => s + (u.cost || 0), 0);
    const translate = usage.filter(u => u.timestamp.startsWith(key) && (u.action === 'translate' || u.action === 'both')).length;
    const clean = usage.filter(u => u.timestamp.startsWith(key) && (u.action === 'clean' || u.action === 'both')).length;
    months.push({ month: key, cost: parseFloat(total.toFixed(2)), translate, clean });
  }
  return months;
}

// ── Batch execute (async, with progress) ──
app.post('/api/batch/execute', authRequired, executeLimiter, async (req, res) => {
  try {
    const { action, records, fields, sourceLang, targetLang, cleaningInstruction } = req.body;
    if (!records || !records.length) return res.status(400).json({ error: 'No records' });

    const BATCH_SIZE = 10;
    const jobId = createBatchJob(req.userId, action, records, fields, { sourceLang, targetLang, cleaningInstruction });
    res.json({ jobId, totalRecords: records.length, totalBatches: Math.ceil(records.length / BATCH_SIZE) });

    // Process in background
    processBatchJob(jobId, req.userId, action, records, fields, BATCH_SIZE, { sourceLang, targetLang, cleaningInstruction });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function processBatchJob(jobId, userId, action, records, fields, batchSize, opts) {
  const job = batchJobs[jobId];
  if (!job) return;
  job.status = 'running';

  const users = readJSON(USERS_FILE);
  const user = users[userId];

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);

    try {
      // Estimate + check balance
      let estCost = 0;
      if (action === 'translate' || action === 'both') {
        let chars = 0;
        batch.forEach(r => fields.forEach(f => { if (r[f] && typeof r[f] === 'string') chars += r[f].length; }));
        estCost += (chars / 1_000_000) * PRICE_TRANSLATION_PER_M;
      }
      if (action === 'clean' || action === 'both') {
        let tokens = 0;
        batch.forEach(r => fields.forEach(f => { if (r[f] && typeof r[f] === 'string') tokens += estimateTokens(r[f]); }));
        tokens = Math.ceil(tokens * 1.2);
        estCost += (tokens / 1000) * PRICE_CLEAN_PER_1K_TOKENS;
      }
      const batchCost = parseFloat(Math.max(estCost, 0.01).toFixed(4));

      if (user.balance < batchCost) {
        job.status = 'failed'; job.error = '余额不足';
        return;
      }

      const results = { cleaned: {}, translated: {} };

      if (action === 'translate' || action === 'both') {
        const texts = [], textMap = [];
        batch.forEach((r, ri) => fields.forEach(f => { if (r[f] && typeof r[f] === 'string') { texts.push(r[f]); textMap.push({ ri: i + ri, f }); } }));
        if (texts.length > 0) {
          const translated = TRANSLATION_BACKEND === 'deepl'
            ? await translateWithDeepL(texts, opts.sourceLang || 'auto', opts.targetLang || 'ZH')
            : TRANSLATION_BACKEND !== 'mock'
              ? await translateWithLLM(texts, opts.targetLang || 'ZH')
              : await mockTranslate(texts, opts.targetLang || 'ZH');
          translated.forEach((t, idx) => { const { ri, f } = textMap[idx]; if (!job.results.translated[ri]) job.results.translated[ri] = {}; job.results.translated[ri][f] = t; });
        }
      }

      if (action === 'clean' || action === 'both') {
        const r = DEMO_MODE
          ? await mockClean(batch, opts.cleaningInstruction || 'Clean data')
          : await cleanWithLLM(batch, opts.cleaningInstruction || 'Clean data', fields);
        r.cleaned.forEach((c, idx) => { const ri = i + idx; if (!job.results.cleaned[ri]) job.results.cleaned[ri] = {}; Object.assign(job.results.cleaned[ri], c); });
      }

      user.balance = parseFloat((user.balance - batchCost).toFixed(4));
      user.dailySpend = parseFloat(((user.dailySpend || 0) + batchCost).toFixed(4));
      user.monthlySpend = parseFloat(((user.monthlySpend || 0) + batchCost).toFixed(4));
      job.totalCost = parseFloat((job.totalCost + batchCost).toFixed(4));

      writeJSON(USERS_FILE, users);

      const usage = readJSON(USAGE_FILE);
      usage.push({ userId, action: 'batch_' + action, details: { batch: job.completedBatches + 1, records: batch.length }, cost: batchCost, timestamp: new Date().toISOString() });
      writeJSON(USAGE_FILE, usage);
    } catch (err) {
      job.status = 'failed'; job.error = err.message;
      return;
    }

    job.completedBatches++;
    job.progress = Math.round((job.completedBatches / job.totalBatches) * 100);
  }

  job.status = 'completed';
}

app.get('/api/batch/:jobId', authRequired, (req, res) => {
  const job = batchJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.userId !== req.userId) return res.status(403).json({ error: '无权访问' });
  res.json({
    jobId: job.jobId, status: job.status, progress: job.progress,
    totalBatches: job.totalBatches, completedBatches: job.completedBatches,
    totalCost: job.totalCost, error: job.error,
    results: job.status === 'completed' ? job.results : null
  });
});

// ═══════════════ Demo Mode (no login, 5 free per type) ═══════════════

app.post('/api/demo/start', (req, res) => {
  const sid = 'demo_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  demoSessions[sid] = { translateUsed: 0, cleanUsed: 0, createdAt: Date.now() };
  res.json({
    sessionId: sid,
    baseId: 'app_demo_base',
    tableId: 'tbl_demo_leads',
    tableName: 'Sales Leads (演示数据)',
    fields: DEMO_FIELDS,
    records: DEMO_RECORDS,
    limits: { maxPerType: DEMO_MAX_PER_TYPE, translateLeft: DEMO_MAX_PER_TYPE, cleanLeft: DEMO_MAX_PER_TYPE }
  });
});

app.post('/api/demo/execute', async (req, res) => {
  try {
    const { sessionId, action, fields, sourceLang, targetLang, cleaningInstruction } = req.body;
    const session = demoSessions[sessionId];
    if (!session) return res.status(404).json({ error: '演示会话已过期，请重新开始' });

    // Check limits
    if (action === 'translate' || action === 'both') {
      if (session.translateUsed >= DEMO_MAX_PER_TYPE) {
        return res.json({ limitReached: true, type: 'translate', message: '免费翻译次数已用完 (5/5)' });
      }
    }
    if (action === 'clean' || action === 'both') {
      if (session.cleanUsed >= DEMO_MAX_PER_TYPE) {
        return res.json({ limitReached: true, type: 'clean', message: '免费清洗次数已用完 (5/5)' });
      }
    }

    // Use mock records
    const records = DEMO_RECORDS.map(r => { const o = {}; fields.forEach(f => { if (r[f] !== undefined) o[f] = r[f]; }); return o; });
    const results = { cleaned: {}, translated: {} };

    // Execute (always free, never call real APIs for demo)
    if (action === 'translate' || action === 'both') {
      const texts = [], textMap = [];
      records.forEach((r, ri) => fields.forEach(f => { if (r[f] && typeof r[f] === 'string') { texts.push(r[f]); textMap.push({ ri, f }); } }));
      if (texts.length > 0) {
        const translated = TRANSLATION_BACKEND !== 'mock'
          ? await translateWithLLM(texts, targetLang || 'ZH')
          : await mockTranslate(texts, targetLang || 'ZH');
        translated.forEach((t, i) => { const { ri, f } = textMap[i]; if (!results.translated[ri]) results.translated[ri] = {}; results.translated[ri][f] = t; });
      }
      session.translateUsed++;
    }

    if (action === 'clean' || action === 'both') {
      const r = await mockClean(records, cleaningInstruction || '去除多余空格，标准化公司名');
      r.cleaned.forEach((c, i) => { if (!results.cleaned[i]) results.cleaned[i] = {}; Object.assign(results.cleaned[i], c); });
      session.cleanUsed++;
    }

    const tl = DEMO_MAX_PER_TYPE - session.translateUsed;
    const cl = DEMO_MAX_PER_TYPE - session.cleanUsed;

    res.json({
      success: true,
      cost: 0,
      free: true,
      backend: TRANSLATION_BACKEND !== 'mock' ? 'deepseek' : 'mock',
      results,
      limits: {
        translateUsed: session.translateUsed, translateLeft: tl,
        cleanUsed: session.cleanUsed, cleanLeft: cl,
        maxPerType: DEMO_MAX_PER_TYPE
      },
      // Signal to frontend: show upgrade prompt if any type exhausted
      showUpgradePrompt: tl <= 0 || cl <= 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════ Admin Panel ═══════════════
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

function adminAuth(req, res, next) {
  if ((req.headers['x-admin-token'] || '') === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: '管理员密码错误' });
}

app.get('/api/admin/stats', adminAuth, (req, res) => {
  const users = readJSON(USERS_FILE);
  const usage = readJSON(USAGE_FILE);
  const userList = Object.values(users);
  const now = new Date();
  const thisMonth = usage.filter(u => { const d=new Date(u.timestamp); return d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear(); });
  const rev = parseFloat(thisMonth.reduce((s,u)=>s+(u.cost||0),0).toFixed(2));
  const wholesale = parseFloat(thisMonth.reduce((s,u)=>s+(u.wholesaleCost||0),0).toFixed(2));
  const activeIds = [...new Set(usage.filter(u=>(now-new Date(u.timestamp))<7*86400000).map(u=>u.userId))];
  res.json({
    totalUsers: userList.length, verifiedUsers: userList.filter(u=>u.emailVerified).length, activeThisWeek: activeIds.length,
    monthlyRevenue: rev, monthlyWholesale: wholesale, monthlyProfit: parseFloat((rev-wholesale).toFixed(2)),
    margin: rev>0?Math.round((rev-wholesale)/rev*100):0,
    totalBalance: parseFloat(userList.reduce((s,u)=>s+(u.balance||0),0).toFixed(2)),
    topUsers: userList.sort((a,b)=>(b.balance||0)-(a.balance||0)).slice(0,10).map(u=>({id:u.id,email:u.email,balance:u.balance,emailVerified:u.emailVerified}))
  });
});

// ═══════════════ Referral System ═══════════════
function generateRefCode() { return 'r_'+Date.now().toString(36).slice(-4)+Math.random().toString(36).slice(2,5); }

// Patch referral codes into existing users (lazy init)
const _origGetUser = (id) => {
  const users = readJSON(USERS_FILE);
  const user = users[id];
  if (user && !user.referralCode) { user.referralCode = generateRefCode(); writeJSON(USERS_FILE, users); }
  return user;
};

app.get('/api/users/me/referral', authRequired, (req, res) => {
  const users = readJSON(USERS_FILE);
  const user = users[req.userId];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (!user.referralCode) { user.referralCode = generateRefCode(); writeJSON(USERS_FILE, users); }
  const usage = readJSON(USAGE_FILE);
  const earned = parseFloat(usage.filter(u=>u.action==='referral_bonus'&&u.userId===req.userId).reduce((s,u)=>s+(u.cost||0),0).toFixed(2));
  const referred = Object.values(users).filter(u=>u.referredBy===user.referralCode).length;
  res.json({ referralCode: user.referralCode, referralLink: 'https://databridge.app?ref='+user.referralCode, totalEarned: earned, referredCount: referred });
});

// ═══════════════ Template Marketplace ═══════════════
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
if (!fs.existsSync(TEMPLATES_FILE)) fs.writeFileSync(TEMPLATES_FILE, JSON.stringify([
  { id:'tpl_clean', name:'通用数据清洗', author:'DataBridge', category:'clean', desc:'去空格 · 公司名标准化 · 邮箱修复', rules:{action:'clean',instruction:'去除首尾多余空格，统一公司后缀格式，修复错误邮箱'}, downloads:128, featured:true },
  { id:'tpl_trans', name:'英文→中文翻译', author:'DataBridge', category:'translate', desc:'产品描述翻译，保留技术术语', rules:{action:'translate',sourceLang:'EN',targetLang:'ZH'}, downloads:95, featured:true },
  { id:'tpl_crm', name:'CRM 数据标准化', author:'DataBridge', category:'both', desc:'清洗+翻译：公司名、职位、地址', rules:{action:'both',instruction:'去除空格，标准化公司名，翻译英文内容',sourceLang:'EN',targetLang:'ZH'}, downloads:67, featured:false },
  { id:'tpl_ecom', name:'电商产品处理', author:'DataBridge', category:'both', desc:'清洗SKU，翻译产品标题和描述', rules:{action:'both',instruction:'标准化SKU格式',sourceLang:'EN',targetLang:'ZH'}, downloads:42, featured:false }
], null, 2));

app.get('/api/templates', (req, res) => {
  const tpls = readJSON(TEMPLATES_FILE);
  res.json({ templates: tpls, featured: tpls.filter(t=>t.featured) });
});

app.post('/api/templates', authRequired, (req, res) => {
  const { name, desc, rules, category } = req.body;
  if (!name||!rules) return res.status(400).json({ error: '名称和规则不能为空' });
  const tpls = readJSON(TEMPLATES_FILE);
  const tpl = { id:'tpl_'+Date.now().toString(36), name, desc:desc||'', category:category||'clean', author:req.userEmail, rules, downloads:0, featured:false, createdAt:new Date().toISOString() };
  tpls.push(tpl); writeJSON(TEMPLATES_FILE, tpls);
  res.status(201).json(tpl);
});

// ═══════════════ Airtable Script ═══════════════
app.get('/api/airtable-script', (req, res) => {
  const baseUrl = process.env.APP_URL || 'http://localhost:3000';
  res.json({
    script: `// DataBridge Airtable Scripting Extension\n// 在 Airtable Base → Extensions → Scripting 中粘贴此代码\n\nconst TOKEN = 'YOUR_DATABRIDGE_TOKEN';\nconst API = '${baseUrl}';\nconst TABLE = await input.tableAsync('选择表:');\nconst FIELD = await input.fieldAsync('选择要翻译的字段:', TABLE);\nconst LANG = await input.buttonsAsync('目标语言:', ['中文','English','日本語']);\nconst query = await TABLE.selectRecordsAsync();\nconst records = query.records.filter(r => r.getCellValue(FIELD));\nconst texts = records.map(r => r.getCellValueAsString(FIELD));\nconst resp = await fetch(API+'/api/execute', {\n  method:'POST',\n  headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},\n  body:JSON.stringify({action:'translate',records:texts.map((t,i)=>({id:records[i].id,[FIELD.name]:t})),fields:[FIELD.name],targetLang:LANG==='中文'?'ZH':LANG==='日本語'?'JA':'EN'})\n});\nconst data = await resp.json();\nif(data.success){\n  const updates = records.map((r,i)=>({id:r.id,fields:{[FIELD.name+' (翻译)']:data.results.translated[i]?.[FIELD.name]||''}}));\n  while(updates.length) await TABLE.updateRecordsAsync(updates.splice(0,50));\n  output.markdown('✅ 已翻译 '+records.length+' 条记录');\n}else{output.markdown('❌ '+JSON.stringify(data))}`,
    instructions: ['1. Airtable Base → Extensions → 添加 Scripting','2. 粘贴脚本代码','3. 登录 DataBridge → F12 → Application → Local Storage → 复制 databridge_token','4. 替换 YOUR_DATABRIDGE_TOKEN','5. 点击 Run']
  });
});

// ── Admin page ──
app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>DataBridge 管理面板</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 20px;color:#111827;background:#f8f9fb}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:20px;margin-bottom:16px}
h2{font-size:18px;margin-bottom:12px}.stat{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f3f4f6}
.stat .val{font-weight:700}.green{color:#059669}.red{color:#dc2626}
table{width:100%;border-collapse:collapse;font-size:13px}th{background:#f9fafb;padding:8px 12px;text-align:left;border-bottom:1px solid #e5e7eb}
td{padding:7px 12px;border-bottom:1px solid #f3f4f6}
input{padding:8px 12px;border:1px solid #e5e7eb;border-radius:6px;font-size:14px;margin-right:8px}
button{padding:8px 16px;background:#4f46e5;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px}
#login-box{text-align:center;padding:60px 0}#stats-area{display:none}</style></head><body>
<div id="login-box"><h2>🔐 管理员登录</h2><input type="password" id="pwd" placeholder="管理员密码"><button onclick="login()">登录</button></div>
<div id="stats-area"><h2>📊 DataBridge 管理面板</h2><div id="cards"></div><h3>👥 Top 10 用户</h3><table id="users"><thead><tr><th>ID</th><th>邮箱</th><th>余额</th><th>已验证</th></tr></thead><tbody></tbody></table></div>
<script>
let token='';
function login(){token=document.getElementById('pwd').value;load();}
async function load(){
  const r=await fetch('/api/admin/stats',{headers:{'x-admin-token':token}});
  if(!r.ok){alert('密码错误');return}
  const d=await r.json();
  document.getElementById('login-box').style.display='none';
  document.getElementById('stats-area').style.display='';
  document.getElementById('cards').innerHTML=
    '<div class="card"><h3>概览</h3>'+['总用户:'+d.totalUsers,'已验证:'+d.verifiedUsers,'本周活跃:'+d.activeThisWeek,'总余额:$'+d.totalBalance].map(s=>'<div class="stat"><span>'+s.split(':')[0]+'</span><span class="val">'+s.split(':')[1]+'</span></div>').join('')+'</div>'+
    '<div class="card"><h3>本月财务</h3>'+['收入:$'+d.monthlyRevenue,'成本:$'+d.monthlyWholesale,'利润:$'+d.monthlyProfit,'利润率:'+d.margin+'%'].map(s=>'<div class="stat"><span>'+s.split(':')[0]+'</span><span class="val '+(s.includes('利润')?'green':'')+'">'+s.split(':')[1]+'</span></div>').join('')+'</div>';
  document.getElementById('users').querySelector('tbody').innerHTML=d.topUsers.map(u=>'<tr><td>'+u.id+'</td><td>'+u.email+'</td><td>$'+(u.balance||0).toFixed(2)+'</td><td>'+(u.emailVerified?'✅':'❌')+'</td></tr>').join('');
}
</script></body></html>`);
});

// ── Legal pages ──
app.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>服务条款 - DataBridge</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.8;color:#111827}
h1{font-size:24px}h2{font-size:18px;margin-top:24px}</style></head><body>
<h1>DataBridge 服务条款</h1><p>最后更新：2026年6月2日</p>
<h2>1. 服务说明</h2><p>DataBridge 提供基于 AI 的数据清洗和翻译服务，用户通过连接 Airtable 使用本服务。服务按实际用量计费。</p>
<h2>2. 用户责任</h2><p>用户负责保管 Airtable PAT 和账户密码。用户保证其数据来源合法，不包含违法或侵权内容。</p>
<h2>3. 费用与支付</h2><p>翻译 $2/百万字符，清洗 $0.40/千token。充值后余额不可退款（法律另有规定除外）。未使用的余额永不过期。</p>
<h2>4. 服务可用性</h2><p>我们尽力保证服务可用，但不承担因第三方 API（DeepSeek、Airtable）故障导致的服务中断责任。</p>
<h2>5. 数据隐私</h2><p>我们仅在处理请求时临时访问用户数据，不存储用户的 Airtable 数据内容。详见隐私政策。</p>
<h2>6. 免责声明</h2><p>AI 生成的翻译和清洗结果可能存在误差，用户应自行审核重要数据。</p>
<h2>7. 条款修改</h2><p>我们保留修改本条款的权利，重大变更将通过邮件通知。</p>
<p style="margin-top:32px">如有问题：support@databridge.app</p>
</body></html>`);
});

app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>隐私政策 - DataBridge</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.8;color:#111827}
h1{font-size:24px}h2{font-size:18px;margin-top:24px}</style></head><body>
<h1>DataBridge 隐私政策</h1><p>最后更新：2026年6月2日</p>
<h2>1. 我们收集什么</h2><p>注册邮箱、密码（加密存储）、充值记录、API 调用次数和费用。我们<strong>不存储</strong>您的 Airtable 数据内容。</p>
<h2>2. 数据使用方式</h2><p>您的 Airtable 数据仅在被处理时临时传输到 DeepSeek/OpenAI API，处理完成后不保留副本。</p>
<h2>3. 数据存储</h2><p>用户账户信息存储在服务器本地 JSON 文件中。支付信息由 Stripe 处理，我们不在服务器存储信用卡信息。</p>
<h2>4. Cookie</h2><p>我们使用 JWT token 维持登录状态，不设置第三方跟踪 Cookie。</p>
<h2>5. 数据删除</h2><p>您可以通过 support@databridge.app 请求删除账户及所有关联数据，我们将在 7 个工作日内处理。</p>
<h2>6. 第三方服务</h2><p>本服务依赖 DeepSeek API（数据处理）、Stripe（支付）、Airtable API（数据连接）。请同时参阅这些服务的隐私政策。</p>
</body></html>`);
});

// ── Start ──
// Enforce: at least one API key must be configured
if (!hasDS && !hasOAI && !hasDL) {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  ⚠️  未配置 API Key！                      ║');
  console.log('║                                          ║');
  console.log('║  请编辑 .env 文件，填入以下任意一个：       ║');
  console.log('║  DEEPSEEK_API_KEY=sk-... (推荐，国内可用)  ║');
  console.log('║  OPENAI_API_KEY=sk-...                   ║');
  console.log('║                                          ║');
  console.log('║  没有 Key 也能用，但是 🎭 Demo 模拟模式     ║');
  console.log('╚══════════════════════════════════════════╝\n');
}

app.listen(PORT, () => {
  console.log(`\n🚀 DataBridge running at http://localhost:${PORT}`);
  if (DEMO_MODE) {
    console.log('🎭 DEMO MODE — no API keys, using mock');
    console.log('   Set DEEPSEEK_API_KEY in .env → auto-switch to real AI');
  } else {
    console.log(`🧠 LLM: ${LLM_BACKEND === 'deepseek' ? 'DeepSeek (国内直连)' : 'OpenAI'}`);
    console.log(`🌐 Translation: ${TRANSLATION_BACKEND === 'deepl' ? 'DeepL' : LLM_BACKEND}`);
  }
  console.log('🔐 Auth: JWT (email + password + email verification)');
  console.log('🛡️  Rate limit: 10 req/min/user · Daily cap $50 · Monthly cap $500');
  console.log(`💰 Pricing: translate $${PRICE_TRANSLATION_PER_M}/M chars (~￥1/50万字) · clean $${PRICE_CLEAN_PER_1K_TOKENS}/1K tokens`);
  console.log(`💳 Topup: $10 (+$2) | $50 (+$15) | $100 (+$40)`);
  console.log(`💳 Stripe: ${stripe ? '✅ configured' : '❌ NOT SET (simulated checkout)'}`);
  console.log(`📧 Email: ${mailer ? '✅ SMTP configured' : '❌ NOT SET (verification skipped)'}`);
});
