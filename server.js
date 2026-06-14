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

// Trust Railway/cloud proxy for correct client IP (required for rate limiting)
app.set('trust proxy', 1);

// Redirect HTTP → HTTPS in production (Railway/cloud serve HTTPS, this handles direct HTTP)
app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  next();
});

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

// JWT secret — set JWT_SECRET in env for production persistence!
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const fallback = require('crypto').randomBytes(32).toString('hex');
  console.warn('[WARN] JWT_SECRET not set — using random value. All sessions will expire on restart.');
  return fallback;
})();
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
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@databridge.app',
    to: email,
    subject: 'TableTurn - 邮箱验证码',
    text: `您的验证码是：${code}\n\n有效期 10 分钟。如非本人操作请忽略。`,
    html: `<h2>TableTurn 邮箱验证</h2><p>您的验证码是：<strong style="font-size:24px">${code}</strong></p><p>有效期 10 分钟。</p>`
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
const demoIPUsage = {};  // IP-based rate limiting for demo abuse prevention
const DEMO_MAX_PER_TYPE = 3;
const DEMO_MAX_PER_IP = 10;  // Max total demo requests per IP per day

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

// Cleanup stale demo sessions & IP tracking every hour
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of Object.entries(demoSessions)) {
    if (now - s.createdAt > 3600000) delete demoSessions[id];
  }
  // Clean yesterday's IP records
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  for (const key of Object.keys(demoIPUsage)) {
    if (key.endsWith(yesterday)) delete demoIPUsage[key];
  }
}, 600000);

// ── Helpers ──
function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return f === USERS_FILE ? {} : []; } }
// Backup directory
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function writeJSON(f, d) {
  // Write main file
  fs.writeFileSync(f, JSON.stringify(d, null, 2));
  // Auto-backup users and reports
  const basename = path.basename(f, '.json');
  if (basename === 'users' || basename === 'reports') {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = path.join(BACKUP_DIR, `${basename}_${ts}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(d, null, 2));
    // Keep only last 10 backups per type
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(b => b.startsWith(basename + '_'))
      .sort()
      .reverse();
    backups.slice(10).forEach(b => fs.unlinkSync(path.join(BACKUP_DIR, b)));
  }
}

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
    const { email, password, demoBonus } = req.body;
    if (!email || !password) return res.status(400).json({ error: '邮箱和密码不能为空' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });

    const users = readJSON(USERS_FILE);
    const exists = Object.values(users).find(u => u.email === email);
    if (exists) return res.status(409).json({ error: '该邮箱已注册' });

    const userId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const hash = await bcrypt.hash(password, 10);
    const code = generateCode();

    // Demo users get $1 free credit (costs us ~$0.02 in API fees)
    const signupBalance = demoBonus ? 1.00 : 0;

    users[userId] = {
      id: userId, email, passwordHash: hash, balance: signupBalance,
      emailVerified: false, verificationCode: code, codeExpiresAt: Date.now() + 600000,
      dailySpend: 0, monthlySpend: 0, spendResetDaily: new Date().toISOString(), spendResetMonthly: new Date().toISOString(),
      demoSignup: !!demoBonus, hasToppedUp: false,
      proPlan: null, proCreditsTranslate: 0, proCreditsClean: 0, proCreditsReset: null,
      createdAt: new Date().toISOString()
    };
    writeJSON(USERS_FILE, users);

    // Send verification email (non-blocking)
    sendVerificationEmail(email, code).catch(e => console.error('Email send failed:', e.message));

    const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    res.status(201).json({ token, user: { id: userId, email, balance: signupBalance, emailVerified: false, demoSignup: !!demoBonus } });
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
    res.json({ token, user: { id: user.id, email: user.email, balance: user.balance, proPlan: user.proPlan, proCreditsTranslate: user.proCreditsTranslate, proCreditsClean: user.proCreditsClean } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', authRequired, (req, res) => {
  const users = readJSON(USERS_FILE);
  const user = users[req.userId];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ id: user.id, email: user.email, balance: user.balance, emailVerified: user.emailVerified, createdAt: user.createdAt, proPlan: user.proPlan, proCreditsTranslate: user.proCreditsTranslate, proCreditsClean: user.proCreditsClean });
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

// Change password (logged in)
app.post('/api/auth/change-password', authRequired, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: '请输入当前密码和新密码' });
    if (newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });

    const users = readJSON(USERS_FILE);
    const user = users[req.userId];
    if (!user) return res.status(404).json({ error: '用户不存在' });

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: '当前密码错误' });

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    writeJSON(USERS_FILE, users);
    res.json({ success: true, message: '密码已更新' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Forgot password — send reset code
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: '请输入邮箱' });

    const users = readJSON(USERS_FILE);
    const user = Object.values(users).find(u => u.email === email);
    // Always return success to prevent email enumeration
    if (!user) return res.json({ sent: true });

    const code = generateCode();
    user.resetCode = code;
    user.resetCodeExpiresAt = Date.now() + 600000; // 10 min
    writeJSON(USERS_FILE, users);

    if (mailer) {
      await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@databridge.app',
        to: email,
        subject: 'TableTurn - Password Reset',
        text: `Your password reset code is: ${code}\n\nValid for 10 minutes.`,
        html: `<h2>TableTurn Password Reset</h2><p>Your reset code: <strong style="font-size:24px">${code}</strong></p><p>Valid for 10 minutes.</p>`
      });
    } else {
      console.log(`[EMAIL] Would send reset code ${code} to ${email}`);
    }
    res.json({ sent: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset password with code
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) return res.status(400).json({ error: '邮箱、验证码和新密码不能为空' });
    if (newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });

    const users = readJSON(USERS_FILE);
    const user = Object.values(users).find(u => u.email === email);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (Date.now() > (user.resetCodeExpiresAt || 0)) return res.status(400).json({ error: '验证码已过期' });
    if (user.resetCode !== String(code)) return res.status(400).json({ error: '验证码错误' });

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.resetCode = null;
    user.resetCodeExpiresAt = null;
    writeJSON(USERS_FILE, users);
    res.json({ success: true, message: '密码已重置，请用新密码登录' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

    // 4. Pro credits: reset monthly if needed
    if (user.proPlan && user.proCreditsReset) {
      const resetDate = new Date(user.proCreditsReset);
      if (now > resetDate) {
        user.proCreditsTranslate = 1000000; // 1M chars free/month
        user.proCreditsClean = 100000;       // 100K tokens free/month
        user.proCreditsReset = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
      }
    }

    // 5. Deduct from Pro credits first, then balance
    let costCoveredByPro = 0;
    if (user.proPlan && (action === 'translate' || action === 'both')) {
      const charsNeeded = (action === 'translate' || action === 'both') ? finalCost / PRICE_TRANSLATION_PER_M * 1000000 : 0;
      // Pro covers up to remaining credits
      const covered = Math.min(charsNeeded, user.proCreditsTranslate || 0);
      costCoveredByPro += (covered / 1000000) * PRICE_TRANSLATION_PER_M;
      user.proCreditsTranslate = Math.max(0, (user.proCreditsTranslate || 0) - covered);
    }
    if (user.proPlan && (action === 'clean' || action === 'both')) {
      const tokensNeeded = (action === 'clean' || action === 'both') ? finalCost / PRICE_CLEAN_PER_1K_TOKENS * 1000 : 0;
      const covered = Math.min(tokensNeeded, user.proCreditsClean || 0);
      costCoveredByPro += (covered / 1000) * PRICE_CLEAN_PER_1K_TOKENS;
      user.proCreditsClean = Math.max(0, (user.proCreditsClean || 0) - covered);
    }

    const remainingCost = parseFloat((finalCost - costCoveredByPro).toFixed(4));
    if (remainingCost > 0 && user.balance < remainingCost) {
      return res.status(402).json({ error: '余额不足', required: remainingCost, balance: user.balance, proCreditsUsed: parseFloat(costCoveredByPro.toFixed(4)), shortfall: parseFloat((remainingCost - user.balance).toFixed(4)) });
    }

    // 6. Execute
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

    // 7. Deduct & track spending
    user.balance = parseFloat((user.balance - remainingCost).toFixed(4));
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

    res.json({ success: true, cost: finalCost, proCreditsUsed: parseFloat(costCoveredByPro.toFixed(4)), remainingCost, newBalance: user.balance, backend: LLM_BACKEND, results, proPlan: user.proPlan, proCreditsLeft: user.proPlan ? { translate: user.proCreditsTranslate, clean: user.proCreditsClean } : null });
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
    if (![2, 10, 50, 100].includes(amount)) return res.status(400).json({ error: '金额须为 $2, $10, $50, 或 $100' });

    const users = readJSON(USERS_FILE);
    const user = users[req.userId];
    const isFirstTopup = !user.hasToppedUp;
    const standardBonuses = { 2: 0, 10: 2, 50: 15, 100: 40 };
    let bonus = standardBonuses[amount] || 0;
    if (isFirstTopup) bonus += parseFloat((amount * 0.2).toFixed(2));
    const total = amount + bonus;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: { currency: 'usd', product_data: { name: 'TableTurn 充值 $' + amount + ' (+$' + bonus + ' 奖励' + (isFirstTopup ? ' 含首次充值奖励' : '') + ')' }, unit_amount: amount * 100 },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${req.headers.origin || 'http://localhost:3000'}?topup=success`,
      cancel_url: `${req.headers.origin || 'http://localhost:3000'}?topup=cancel`,
      metadata: { userId: req.userId, amount: String(amount), bonus: String(bonus), firstTime: String(isFirstTopup) }
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

// ── Pro Plan (monthly subscription, $9/month) ──
app.post('/api/users/me/upgrade-pro', authRequired, (req, res) => {
  try {
    const users = readJSON(USERS_FILE);
    const user = users[req.userId];
    if (!user) return res.status(404).json({ error: '用户不存在' });

    const now = new Date();
    user.proPlan = 'pro_monthly';
    user.proCreditsTranslate = 1000000;  // 1M chars/month
    user.proCreditsClean = 100000;       // 100K tokens/month
    user.proCreditsReset = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
    writeJSON(USERS_FILE, users);

    res.json({ success: true, proPlan: user.proPlan, proCreditsTranslate: user.proCreditsTranslate, proCreditsClean: user.proCreditsClean, message: 'Upgraded to Pro! $9/month. 1M chars translate + 100K tokens clean included.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users/me/cancel-pro', authRequired, (req, res) => {
  try {
    const users = readJSON(USERS_FILE);
    const user = users[req.userId];
    if (!user) return res.status(404).json({ error: '用户不存在' });
    user.proPlan = null;
    user.proCreditsTranslate = 0;
    user.proCreditsClean = 0;
    user.proCreditsReset = null;
    writeJSON(USERS_FILE, users);
    res.json({ success: true, message: 'Pro cancelled. You can still use pay-as-you-go credits.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Topup (new packages: $2/$10/$50/$100, first-time 50% bonus) ──
app.post('/api/users/me/topup', authRequired, (req, res) => {
  try {
    const users = readJSON(USERS_FILE);
    const user = users[req.userId];
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (!user.emailVerified) return res.status(403).json({ error: '请先验证邮箱后再充值', emailNotVerified: true });

    const { amount } = req.body;
    const ta = parseFloat(amount);
    if (![2, 10, 50, 100].includes(ta)) return res.status(400).json({ error: '充值金额须为 $2, $10, $50, 或 $100' });

    // Standard bonuses
    const standardBonuses = { 2: 0, 10: 2, 50: 15, 100: 40 };
    let bonus = standardBonuses[ta] || 0;

    // First-time topup: extra 20% bonus
    const isFirstTopup = !user.hasToppedUp;
    if (isFirstTopup) {
      const firstTimeBonus = parseFloat((ta * 0.2).toFixed(2));
      bonus += firstTimeBonus;
    }

    const total = ta + bonus;
    user.balance = parseFloat((user.balance + total).toFixed(4));
    user.hasToppedUp = true;
    writeJSON(USERS_FILE, users);

    const usage = readJSON(USAGE_FILE);
    usage.push({ userId: req.userId, action: 'topup', details: { amount: ta, bonus, firstTime: isFirstTopup }, cost: 0, timestamp: new Date().toISOString() });
    writeJSON(USAGE_FILE, usage);

    res.json({ success: true, charged: ta, bonus, credited: total, newBalance: users[req.userId].balance, firstTime: isFirstTopup });
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
    tableName: 'Sales Leads (Sample Data)',
    fields: DEMO_FIELDS,
    records: DEMO_RECORDS,
    limits: { maxPerType: DEMO_MAX_PER_TYPE, translateLeft: DEMO_MAX_PER_TYPE, cleanLeft: DEMO_MAX_PER_TYPE }
  });
});

// Demo preview (3 rows, no deduction)
app.post('/api/demo/preview', async (req, res) => {
  try {
    const { sessionId, action, fields, records, sourceLang, targetLang, cleaningInstruction } = req.body;
    if (!sessionId || !action || !fields?.length || !records?.length) return res.status(400).json({ error: 'Missing required fields' });
    if (!['translate','clean','both'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
    const remaining = action === 'both' ? 0 : null;
    const results = records.map(r => {
      const out = {};
      fields.forEach(f => {
        const val = r[f];
        if (val != null && val !== '') {
          out[f] = `[PREVIEW] ${val}`;
        }
      });
      return out;
    });
    res.json({ results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Real preview (3 rows, no charge)
app.post('/api/preview', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    let userId;
    try { const d = jwt.verify(token, JWT_SECRET); userId = d.userId; } catch(e) { return res.status(401).json({ error: 'Invalid session' }); }
    const { action, fields, records, sourceLang, targetLang, cleaningInstruction } = req.body;
    if (!action || !fields?.length || !records?.length) return res.status(400).json({ error: 'Missing required fields' });
    // Use same execute logic but with preview flag
    const result = await executeAIJob(action, fields, records, sourceLang, targetLang, cleaningInstruction);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/demo/execute', async (req, res) => {
  try {
    const { sessionId, action, fields, sourceLang, targetLang, cleaningInstruction } = req.body;
    const session = demoSessions[sessionId];
    if (!session) return res.status(404).json({ error: '演示会话已过期，请重新开始' });

    // IP-based abuse prevention: max DEMO_MAX_PER_IP requests per IP per day
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
    const today = new Date().toISOString().slice(0, 10);
    const ipKey = `${ip}:${today}`;
    if (!demoIPUsage[ipKey]) demoIPUsage[ipKey] = 0;
    if (demoIPUsage[ipKey] >= DEMO_MAX_PER_IP) {
      return res.json({ limitReached: true, type: 'ip', message: '今日演示次数已用完，请明天再试或注册账号' });
    }

    // Check per-session limits
    if (action === 'translate' || action === 'both') {
      if (session.translateUsed >= DEMO_MAX_PER_TYPE) {
        return res.json({ limitReached: true, type: 'translate', message: `免费翻译次数已用完 (${DEMO_MAX_PER_TYPE}/${DEMO_MAX_PER_TYPE})` });
      }
    }
    if (action === 'clean' || action === 'both') {
      if (session.cleanUsed >= DEMO_MAX_PER_TYPE) {
        return res.json({ limitReached: true, type: 'clean', message: `免费清洗次数已用完 (${DEMO_MAX_PER_TYPE}/${DEMO_MAX_PER_TYPE})` });
      }
    }

    // Use mock records
    const records = DEMO_RECORDS.map(r => { const o = {}; fields.forEach(f => { if (r[f] !== undefined) o[f] = r[f]; }); return o; });
    const results = { cleaned: {}, translated: {} };

    // Demo uses real DeepSeek for best impression — cost is negligible (~$0.01/demo user)
    const useRealAI = !DEMO_MODE;

    if (action === 'translate' || action === 'both') {
      const texts = [], textMap = [];
      records.forEach((r, ri) => fields.forEach(f => { if (r[f] && typeof r[f] === 'string') { texts.push(r[f]); textMap.push({ ri, f }); } }));
      if (texts.length > 0) {
        const translated = useRealAI
          ? await translateWithLLM(texts, targetLang || 'ZH')
          : await mockTranslate(texts, targetLang || 'ZH');
        translated.forEach((t, i) => { const { ri, f } = textMap[i]; if (!results.translated[ri]) results.translated[ri] = {}; results.translated[ri][f] = t; });
      }
      session.translateUsed++;
    }

    if (action === 'clean' || action === 'both') {
      const r = useRealAI
        ? await cleanWithLLM(records, cleaningInstruction || 'Clean and standardize data', fields)
        : await mockClean(records, cleaningInstruction || '去除多余空格，标准化公司名');
      r.cleaned.forEach((c, i) => { if (!results.cleaned[i]) results.cleaned[i] = {}; Object.assign(results.cleaned[i], c); });
      session.cleanUsed++;
    }

    demoIPUsage[ipKey]++;

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
// ── Visit tracking ──
const VISITS_FILE = path.join(DATA_DIR, 'visits.json');
let visitsData = fs.existsSync(VISITS_FILE) ? readJSON(VISITS_FILE) : { daily: {}, users: {}, actions: {} };

app.use((req, res, next) => {
  const today = new Date().toISOString().slice(0, 10);
  if (!visitsData.daily[today]) visitsData.daily[today] = { pageviews: 0, uniqueIPs: new Set() };
  visitsData.daily[today].pageviews++;
  const ip = req.ip || 'unknown';
  if (typeof visitsData.daily[today].uniqueIPs.add === 'function') visitsData.daily[today].uniqueIPs.add(ip);
  // Save every 50 requests
  if (visitsData.daily[today].pageviews % 50 === 0) {
    const save = { daily: {}, users: visitsData.users, actions: visitsData.actions };
    for (const [k, v] of Object.entries(visitsData.daily)) {
      save.daily[k] = { pageviews: v.pageviews, uniqueIPs: v.uniqueIPs.size || (v.uniqueIPs instanceof Set ? v.uniqueIPs.size : 1) };
    }
    writeJSON(VISITS_FILE, save);
  }
  next();
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

function adminAuth(req, res, next) {
  if ((req.headers['x-admin-token'] || '') === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: '管理员密码错误' });
}

// Backup management
app.get('/api/admin/backups', adminAuth, (req, res) => {
  const files = fs.readdirSync(BACKUP_DIR).sort().reverse();
  const list = files.map(f => ({
    name: f,
    size: fs.statSync(path.join(BACKUP_DIR, f)).size,
    time: fs.statSync(path.join(BACKUP_DIR, f)).mtime
  }));
  res.json({ count: list.length, backups: list });
});

app.get('/api/admin/backups/download', adminAuth, (req, res) => {
  const name = req.query.file;
  if (!name) return res.status(400).json({ error: '?file=filename required' });
  const filePath = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.download(filePath);
});

// Health check includes backup status
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const users = readJSON(USERS_FILE);
  const usage = readJSON(USAGE_FILE);
  const userList = Object.values(users);
  const now = new Date();
  const thisMonth = usage.filter(u => { const d=new Date(u.timestamp); return d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear(); });
  const rev = parseFloat(thisMonth.reduce((s,u)=>s+(u.cost||0),0).toFixed(2));
  const wholesale = parseFloat(thisMonth.reduce((s,u)=>s+(u.wholesaleCost||0),0).toFixed(2));
  const activeIds = [...new Set(usage.filter(u=>(now-new Date(u.timestamp))<7*86400000).map(u=>u.userId))];
  const backupFiles = fs.readdirSync(BACKUP_DIR);
  res.json({
    totalUsers: userList.length, verifiedUsers: userList.filter(u=>u.emailVerified).length, activeThisWeek: activeIds.length,
    backups: backupFiles.length, lastBackup: backupFiles.length ? backupFiles.sort().reverse()[0] : 'none',
    monthlyRevenue: rev, monthlyWholesale: wholesale, monthlyProfit: parseFloat((rev-wholesale).toFixed(2)),
    margin: rev>0?Math.round((rev-wholesale)/rev*100):0,
    totalBalance: parseFloat(userList.reduce((s,u)=>s+(u.balance||0),0).toFixed(2)),
    topUsers: userList.sort((a,b)=>(b.balance||0)-(a.balance||0)).slice(0,10).map(u=>({id:u.id,email:u.email,balance:u.balance,emailVerified:u.emailVerified}))
  });
});

// Analytics dashboard
// Submit sitemap to search engines (runs on Railway US server)
app.get('/api/admin/submit-sitemap', adminAuth, async (req, res) => {
  const sitemap = 'https://www.tturn.xyz/sitemap.xml';
  const results = {};
  try {
    const r = await fetch(`https://www.google.com/ping?sitemap=${encodeURIComponent(sitemap)}`);
    results.google = r.status;
  } catch(e) { results.google = e.message; }
  try {
    const r = await fetch(`https://www.bing.com/indexnow?url=${encodeURIComponent(sitemap)}&key=databridge2026`);
    results.bing = r.status;
  } catch(e) { results.bing = e.message; }
  res.json({ ok: true, results });
});

app.get('/api/admin/analytics', adminAuth, (req, res) => {
  const usage = readJSON(USAGE_FILE);
  const users = Object.values(readJSON(USERS_FILE));
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const vToday = visitsData.daily[today] || { pageviews: 0, uniqueIPs: new Set() };
  const uvToday = vToday.uniqueIPs instanceof Set ? vToday.uniqueIPs.size : (vToday.uniqueIPs || 0);

  const visitChart = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const v = visitsData.daily[key] || { pageviews: 0, uniqueIPs: new Set() };
    const uv = v.uniqueIPs instanceof Set ? v.uniqueIPs.size : (v.uniqueIPs || 0);
    visitChart.push({ date: key.slice(5), pv: v.pageviews || 0, uv });
  }

  const todayUsage = usage.filter(u => u.timestamp.startsWith(today));
  const translations = todayUsage.filter(u => u.action === 'translate' || u.action === 'both').length;
  const cleanings = todayUsage.filter(u => u.action === 'clean' || u.action === 'both').length;

  res.json({
    today: { pageviews: vToday.pageviews || 0, uniqueVisitors: uvToday, translations, cleanings },
    visitChart,
    totalUsers: users.length,
    activeUsers24h: new Set(usage.filter(u => now - new Date(u.timestamp) < 86400000).map(u => u.userId)).size,
    recentActions: usage.slice(-20).reverse().map(u => ({
      time: u.timestamp ? new Date(u.timestamp).toLocaleString() : '',
      action: u.action, userId: u.userId ? u.userId.slice(0, 8) + '...' : 'anon', cost: u.cost || 0
    }))
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
  res.json({ referralCode: user.referralCode, referralLink: 'https://www.tturn.xyz?ref='+user.referralCode, totalEarned: earned, referredCount: referred });
});

// ═══════════════ Template Marketplace ═══════════════
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');
if (!fs.existsSync(TEMPLATES_FILE)) fs.writeFileSync(TEMPLATES_FILE, JSON.stringify([
  { id:'tpl_clean', name:'通用数据清洗', author:'TableTurn', category:'clean', desc:'去空格 · 公司名标准化 · 邮箱修复', rules:{action:'clean',instruction:'去除首尾多余空格，统一公司后缀格式，修复错误邮箱'}, downloads:128, featured:true },
  { id:'tpl_trans', name:'英文→中文翻译', author:'TableTurn', category:'translate', desc:'产品描述翻译，保留技术术语', rules:{action:'translate',sourceLang:'EN',targetLang:'ZH'}, downloads:95, featured:true },
  { id:'tpl_crm', name:'CRM 数据标准化', author:'TableTurn', category:'both', desc:'清洗+翻译：公司名、职位、地址', rules:{action:'both',instruction:'去除空格，标准化公司名，翻译英文内容',sourceLang:'EN',targetLang:'ZH'}, downloads:67, featured:false },
  { id:'tpl_ecom', name:'电商产品处理', author:'TableTurn', category:'both', desc:'清洗SKU，翻译产品标题和描述', rules:{action:'both',instruction:'标准化SKU格式',sourceLang:'EN',targetLang:'ZH'}, downloads:42, featured:false }
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
    script: `// TableTurn Airtable Scripting Extension\n// 在 Airtable Base → Extensions → Scripting 中粘贴此代码\n\nconst TOKEN = 'YOUR_DATABRIDGE_TOKEN';\nconst API = '${baseUrl}';\nconst TABLE = await input.tableAsync('选择表:');\nconst FIELD = await input.fieldAsync('选择要翻译的字段:', TABLE);\nconst LANG = await input.buttonsAsync('目标语言:', ['中文','English','日本語']);\nconst query = await TABLE.selectRecordsAsync();\nconst records = query.records.filter(r => r.getCellValue(FIELD));\nconst texts = records.map(r => r.getCellValueAsString(FIELD));\nconst resp = await fetch(API+'/api/execute', {\n  method:'POST',\n  headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},\n  body:JSON.stringify({action:'translate',records:texts.map((t,i)=>({id:records[i].id,[FIELD.name]:t})),fields:[FIELD.name],targetLang:LANG==='中文'?'ZH':LANG==='日本語'?'JA':'EN'})\n});\nconst data = await resp.json();\nif(data.success){\n  const updates = records.map((r,i)=>({id:r.id,fields:{[FIELD.name+' (翻译)']:data.results.translated[i]?.[FIELD.name]||''}}));\n  while(updates.length) await TABLE.updateRecordsAsync(updates.splice(0,50));\n  output.markdown('✅ 已翻译 '+records.length+' 条记录');\n}else{output.markdown('❌ '+JSON.stringify(data))}`,
    instructions: ['1. Airtable Base → Extensions → 添加 Scripting','2. 粘贴脚本代码','3. 登录 TableTurn → F12 → Application → Local Storage → 复制 databridge_token','4. 替换 YOUR_DATABRIDGE_TOKEN','5. 点击 Run']
  });
});

// ── Admin page ──
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Legal pages ──
app.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Terms of Service — TableTurn</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.8;color:#111827}
h1{font-size:24px}h2{font-size:18px;margin-top:24px}</style></head><body>
<h1>TableTurn Terms of Service</h1><p>Last updated: June 8, 2026</p>
<h2>1. Service</h2><p>TableTurn provides AI-powered data cleaning and translation. Users connect via Airtable PAT. Billing is usage-based.</p>
<h2>2. User Responsibilities</h2><p>Keep your Airtable PAT and password secure. You are responsible for data legality and must not process illegal or infringing content.</p>
<h2>3. Fees & Payment</h2><p>Translation: $2/million chars. Cleaning: $0.40/1K tokens. Prepaid balance is non-refundable (unless required by law). Balance never expires.</p>
<h2>4. Availability</h2><p>We strive for uptime but are not liable for outages caused by third-party APIs (DeepSeek, Airtable, Stripe).</p>
<h2>5. Data Privacy</h2><p>We only access data transiently during processing. Airtable content is never stored on our servers. See Privacy Policy.</p>
<h2>6. Disclaimer</h2><p>AI-generated results may contain errors. Review critical data before use.</p>
<h2>7. Changes</h2><p>We may update these terms. Major changes will be notified by email.</p>
<p style="margin-top:32px">Contact: support@databridge.app</p>
</body></html>`);
});

app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Privacy Policy — TableTurn</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.8;color:#111827}
h1{font-size:24px}h2{font-size:18px;margin-top:24px}</style></head><body>
<h1>TableTurn Privacy Policy</h1><p>Last updated: June 8, 2026</p>
<h2>1. What We Collect</h2><p>Email, encrypted password, top-up records, and API usage stats. We <strong>do NOT store</strong> your Airtable data content.</p>
<h2>2. Where Your Data Lives</h2><p>Account data is stored on secure servers (Render, Singapore region). Payment processing is handled by Stripe — we never see or store your credit card.</p>
<h2>3. Your Airtable PAT</h2><p><strong>Your PAT stays in your browser and is never uploaded to our server.</strong> It is stored only in your browser's localStorage and transmitted directly to Airtable's API. You can remove it at any time by clearing your browser data or logging out.</p>
<h2>4. Processing</h2><p>Airtable data is transmitted to DeepSeek API for translation/cleaning and immediately discarded. No copies retained.</p>
<h2>5. Cookies</h2><p>JWT tokens for login sessions only. No third-party tracking cookies.</p>
<h2>6. Data Deletion</h2><p>Email support@databridge.app to delete your account. Processed within 7 business days.</p>
<h2>7. Third-Party Services</h2><p>We rely on DeepSeek API (AI), Stripe (payments), and Airtable API (data). Review their privacy policies as well.</p>
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

// ═══════════════ Reports (TableDash) ═══════════════
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
if (!fs.existsSync(REPORTS_FILE)) fs.writeFileSync(REPORTS_FILE, '{}');

const crypto = require('crypto');

// Create report (auth optional — demo users can create too)
app.post('/api/reports/create', (req, res) => {
  try {
    const { title, baseId, tableId, fields, chartType, config, demoSessionId } = req.body;
    if (!title || !fields?.length) return res.status(400).json({ error: 'Title and fields required' });

    // Resolve userId: auth user or demo session
    const userId = req.userId || (demoSessionId ? 'demo_' + demoSessionId : null);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    const isDemo = userId.startsWith('demo_');

    const reports = readJSON(REPORTS_FILE);

    // ── Abuse prevention ──
    const userReports = Object.values(reports).filter(r => r.userId === userId);

    // Limit: max 5 reports for free/demo users
    if (isDemo && userReports.length >= 5) {
      return res.status(429).json({ error: 'Free limit reached (5 reports). Please delete old reports or upgrade to Pro for unlimited.' });
    }

    // Rate limit: 5 reports per hour per user
    const oneHourAgo = Date.now() - 3600000;
    const recentCount = userReports.filter(r => new Date(r.createdAt).getTime() > oneHourAgo).length;
    if (recentCount >= 5) {
      return res.status(429).json({ error: 'Rate limit: 5 reports per hour. Please wait or upgrade to Pro.' });
    }

    // Row limit: 1000 rows for free/demo users
    const recordCount = (config?.records || []).length;
    if (isDemo && recordCount > 1000) {
      return res.status(400).json({ error: 'Free reports limited to 1,000 rows. Upgrade to Pro for unlimited data.' });
    }

    const id = 'rpt_' + Date.now().toString(36);
    reports[id] = {
      id, userId, title, baseId, tableId, fields, chartType: chartType || 'bar',
      config: config || {}, shareToken: null, sharePassword: null, shareExpiry: null,
      viewCount: 0, maxViews: isDemo ? 1000 : 0, // 0 = unlimited (Pro)
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    writeJSON(REPORTS_FILE, reports);
    res.status(201).json(Object.assign(reports[id], { reportLimit: isDemo ? userReports.length + 1 : null, maxReports: isDemo ? 5 : null, rowLimit: isDemo ? 1000 : null }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List user's reports (auth or demo)
app.get('/api/reports/list', (req, res) => {
  let userId = req.query.demoSessionId ? 'demo_' + req.query.demoSessionId : null;
  if (!userId && req.headers.authorization) {
    try { const p = jwt.verify(req.headers.authorization.slice(7), JWT_SECRET); userId = p.userId; } catch {}
  }
  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  const reports = readJSON(REPORTS_FILE);
  const mine = Object.values(reports).filter(r => r.userId === userId)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ reports: mine });
});

// Share a report (generate token)
app.post('/api/reports/:id/share', (req, res) => {
  let userId = req.body.demoSessionId ? 'demo_' + req.body.demoSessionId : req.userId;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  const reports = readJSON(REPORTS_FILE);
  const report = reports[req.params.id];
  if (!report || report.userId !== userId) return res.status(404).json({ error: 'Report not found' });

  const { mode, password, expiry } = req.body; // mode: 'public' | 'password'
  report.shareToken = crypto.randomBytes(16).toString('hex'); // 32-char random, unguessable
  report.shareMode = mode || 'public';
  if (mode === 'password' && password) {
    report.sharePassword = bcrypt.hashSync(password, 10);
  } else {
    report.sharePassword = null;
  }
  report.shareExpiry = expiry || null; // '7d', '30d', null = permanent
  report.updatedAt = new Date().toISOString();
  writeJSON(REPORTS_FILE, reports);

  const shareUrl = `${req.protocol}://${req.get('host')}/r/${report.shareToken}`;
  res.json({ shareUrl, token: report.shareToken, mode: report.shareMode });
});

// Unshare a report
app.post('/api/reports/:id/unshare', (req, res) => {
  let userId = req.body.demoSessionId ? 'demo_' + req.body.demoSessionId : req.userId;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  const reports = readJSON(REPORTS_FILE);
  const report = reports[req.params.id];
  if (!report || report.userId !== userId) return res.status(404).json({ error: 'Report not found' });
  report.shareToken = null; report.sharePassword = null; report.shareMode = null; report.shareExpiry = null;
  report.updatedAt = new Date().toISOString();
  writeJSON(REPORTS_FILE, reports);
  res.json({ ok: true });
});

// AI Insights — analyze report data and return a text summary
app.post('/api/reports/:id/insights', async (req, res) => {
  try {
    const reports = readJSON(REPORTS_FILE);
    const report = reports[req.params.id];
    if (!report) return res.status(404).json({ error: 'Report not found' });

    // Check Pro — AI insights are Pro-only
    const users = readJSON(USERS_FILE);
    const owner = Object.values(users).find(u => u.id === report.userId);
    const isPro = owner && owner.proPlan;
    // Demo users with demo_ prefix always get insights for free (teaser)
    const isDemo = report.userId && report.userId.startsWith('demo_');
    if (!isPro && !isDemo) {
      return res.json({ insights: '🔒 AI Insights is a Pro feature. Upgrade to Pro ($9/month) to unlock AI-powered data analysis on all your reports.', proRequired: true });
    }

    // Return cached if already generated
    if (report.insights) return res.json({ insights: report.insights, cached: true });

    const records = report.config?.records || [];
    if (!records.length) return res.json({ insights: 'Not enough data for insights.' });

    const xField = report.fields[0] || '';
    const yField = report.fields[1] || '';
    const values = records.map(r => parseFloat(r[yField])).filter(v => !isNaN(v));

    // Quick stats
    const sum = values.reduce((a,b) => a+b, 0);
    const avg = values.length ? sum / values.length : 0;
    const max = values.length ? Math.max(...values) : 0;
    const min = values.length ? Math.min(...values) : 0;

    // Call AI for narrative insights
    let aiText = '';
    try {
      const sample = records.slice(0, 10).map(r => ({ [xField]: r[xField], [yField]: r[yField] }));
      const aiResp = await llmChat([
        { role:'system', content:'You are a data analyst. Write 2-3 sentences of actionable insights about this data in plain English. Be specific — mention actual values and trends. Keep it under 150 words. Return only the text, no markdown.' },
        { role:'user', content: `Analyze this data:\nField: ${yField} by ${xField}\nRecords: ${JSON.stringify(sample)}\nStats: sum=${sum.toFixed(2)}, avg=${avg.toFixed(2)}, max=${max.toFixed(2)}, min=${min.toFixed(2)}, count=${values.length}` }
      ], 500);
      aiText = aiResp.choices[0].message.content.trim();
    } catch (aiErr) {
      // Fallback: simple rule-based insights
      aiText = `The total ${yField} across ${values.length} records is ${sum.toFixed(2)}, with an average of ${avg.toFixed(2)}. Values range from ${min.toFixed(2)} to ${max.toFixed(2)}.`;
    }

    const insights = `📊 **Summary**: ${values.length} records · Total ${yField}: **${sum.toFixed(2)}** · Average: **${avg.toFixed(2)}** · Range: ${min.toFixed(2)} — ${max.toFixed(2)}.\n\n💡 **Analysis**: ${aiText}`;

    // Cache in report
    report.insights = insights;
    report.updatedAt = new Date().toISOString();
    writeJSON(REPORTS_FILE, reports);

    res.json({ insights, cached: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Schedule email report (Pro only)
app.post('/api/reports/:id/schedule', async (req, res) => {
  try {
    const reports = readJSON(REPORTS_FILE);
    const report = reports[req.params.id];
    if (!report) return res.status(404).json({ error: 'Report not found' });

    // Verify Pro
    const users = readJSON(USERS_FILE);
    const owner = Object.values(users).find(u => u.id === report.userId);
    const isDemo = report.userId && report.userId.startsWith('demo_');
    if (!owner?.proPlan && !isDemo) {
      return res.status(402).json({ error: 'Scheduled reports are a Pro feature. Please upgrade.' });
    }

    const { email, frequency } = req.body; // frequency: 'weekly' | 'monthly'
    if (!email) return res.status(400).json({ error: 'Email required' });
    report.scheduleEmail = email;
    report.scheduleFrequency = frequency || 'weekly';
    report.updatedAt = new Date().toISOString();
    writeJSON(REPORTS_FILE, reports);
    res.json({ ok: true, schedule: { email, frequency: report.scheduleFrequency } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send report now via email
app.post('/api/reports/:id/send-now', async (req, res) => {
  try {
    const reports = readJSON(REPORTS_FILE);
    const report = reports[req.params.id];
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!mailer) return res.status(500).json({ error: 'Email service not configured' });

    const shareUrl = report.shareToken
      ? `${req.protocol}://${req.get('host')}/r/${report.shareToken}`
      : 'https://www.tturn.xyz';

    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: `📊 TableTurn Report: ${report.title}`,
      html: `<h2>${report.title}</h2>
<p>Your scheduled report from TableTurn.</p>
<p><strong>Fields:</strong> ${(report.fields||[]).join(', ')}</p>
${report.insights ? `<h3>🤖 AI Insights</h3><p>${report.insights.replace(/\n/g,'<br>')}</p>` : ''}
<p><a href="${shareUrl}" style="display:inline-block;padding:12px 24px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">📊 View Full Report</a></p>
<p style="color:#888;font-size:12px;">Sent by TableTurn · <a href="https://www.tturn.xyz">tturn.xyz</a></p>`
    });

    res.json({ ok: true, message: 'Report sent to ' + email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete report
app.delete('/api/reports/:id', (req, res) => {
  let userId = req.query.demoSessionId ? 'demo_' + req.query.demoSessionId : req.userId;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  const reports = readJSON(REPORTS_FILE);
  const report = reports[req.params.id];
  if (!report || report.userId !== userId) return res.status(404).json({ error: 'Report not found' });
  delete reports[req.params.id];
  writeJSON(REPORTS_FILE, reports);
  res.json({ ok: true });
});

// View shared report (public, no auth)
app.get('/r/:token', (req, res) => {
  const reports = readJSON(REPORTS_FILE);
  const report = Object.values(reports).find(r => r.shareToken === req.params.token);
  if (!report) return res.status(404).send('<h2>Report not found or has been removed</h2>');

  // Check expiry
  if (report.shareExpiry) {
    const created = new Date(report.updatedAt);
    const days = parseInt(report.shareExpiry);
    if (Date.now() - created.getTime() > days * 86400000) {
      return res.status(410).send('<h2>This report link has expired</h2>');
    }
  }

  // Password check
  if (report.sharePassword) {
    const pw = req.query.pw || '';
    if (!bcrypt.compareSync(pw, report.sharePassword)) {
      return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="robots" content="noindex,nofollow"><title>Password Required</title>
<style>body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e8e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
input{padding:10px 14px;border:1px solid #2a2a4a;border-radius:8px;background:#131320;color:#fff;font-size:14px}
button{padding:10px 20px;background:#7c3aed;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600}</style></head>
<body><div style="text-align:center"><h3>🔒 Password Required</h3><p style="color:#8888aa">Enter password to view this report</p>
<form method="GET"><input type="password" name="pw" placeholder="Password" autofocus><button type="submit">View Report</button></form></div></body></html>`);
    }
  }

  // Track view count
  report.viewCount = (report.viewCount || 0) + 1;
  if (report.maxViews && report.viewCount > report.maxViews) {
    return res.status(429).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="robots" content="noindex,nofollow"><title>Link Limit Reached</title>
<style>body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#e8e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}
.btn{display:inline-block;padding:12px 24px;background:#7c3aed;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;margin-top:16px}</style></head>
<body><div><h2>📊 Link limit reached</h2><p style="color:#8888aa">This report has exceeded ${report.maxViews} views this month.</p><p style="color:#8888aa">Ask the owner to upgrade to TableTurn Pro for unlimited sharing.</p><a class="btn" href="https://www.tturn.xyz">Try TableTurn</a></div></body></html>`);
  }
  writeJSON(REPORTS_FILE, reports);

  // Check if report belongs to a free/demo user → show upgrade CTA
  const isFreeUser = report.userId && (report.userId.startsWith('demo_') || !report.userId.startsWith('u_'));

  // Render report page
  res.send(renderReportPage(report, isFreeUser));
});

function renderReportPage(report, isFreeUser) {
  const title = report.title || 'Report';
  const xField = (report.fields||[])[0] || '';
  const yField = (report.fields||[])[1] || '';
  const records = report.config?.records || [];
  const chartType = report.chartType || 'bar';
  const bgColors = JSON.stringify(['#7c3aed','#a78bfa','#10b981','#f59e0b','#ef4444','#3b82f6','#ec4899','#8b5cf6']);

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} — TableTurn Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\\/script>
<style>
:root{--bg:#0a0a0f;--surface:#1a1a2e;--border:#2a2a4a;--text:#e8e8f0;--muted:#8888aa;--accent:#7c3aed}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
.header{text-align:center;padding:32px 0 24px}
.header h1{font-size:28px;color:#fff}.header p{color:var(--muted);margin-top:4px}
.chart-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;max-width:800px;margin:0 auto}
.chart-card h3{font-size:14px;color:var(--muted);margin-bottom:12px}
.chart-wrap{position:relative;height:400px}
.footer{text-align:center;padding:24px;color:var(--muted);font-size:12px;margin-top:24px;border-top:1px solid var(--border)}
a{color:var(--accent)}
</style></head><body>
<div class="header"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(yField)} by ${escapeHtml(xField)} · Generated by TableTurn</p></div>
<div class="chart-card"><h3>${escapeHtml(yField)}</h3><div class="chart-wrap"><canvas id="chart0"></canvas></div></div>
${report.insights ? `
<div style="max-width:800px;margin:20px auto;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;">
<h3 style="font-size:14px;color:var(--accent);margin-bottom:8px;">🤖 AI Insights</h3>
<div style="color:var(--text);font-size:14px;line-height:1.7;white-space:pre-wrap;">${escapeHtml(report.insights)}</div>
</div>` : ''}
${isFreeUser ? `
<div style="text-align:center;padding:12px 20px;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;margin:16px 0;border-radius:8px;font-size:13px;">
  <strong>Created with TableTurn Free</strong> — <a href="https://www.tturn.xyz" style="color:#fff;text-decoration:underline;">Upgrade to Pro</a> to remove branding, unlock exports & unlimited reports
</div>` : ''}
<div class="footer">Powered by <a href="https://www.tturn.xyz">TableTurn</a> — AI-Powered Data Tools for Airtable</div>
${isFreeUser ? `
<div style="position:fixed;bottom:20px;right:20px;opacity:0.15;font-size:14px;font-weight:700;color:#888;pointer-events:none;transform:rotate(-15deg);z-index:999;">TableTurn Free</div>` : ''}
<script>
(function(){
var xField=${JSON.stringify(xField)};
var yField=${JSON.stringify(yField)};
var chartType=${JSON.stringify(chartType)};
var bgColors=${bgColors};
var records=${JSON.stringify(records)};
var labels=records.map(function(r){return String(r[xField]||'').slice(0,20);});
var values=records.map(function(r){var v=r[yField];return typeof v==='number'?v:(isNaN(parseFloat(v))?(typeof v==='string'?v.length:0):parseFloat(v));});
new Chart(document.getElementById('chart0'),{
  type:chartType,
  data:{labels:labels,datasets:[{label:yField,data:values,backgroundColor:chartType==='pie'?bgColors:'rgba(124,58,237,0.6)',borderColor:'#7c3aed',borderWidth:1}]},
  options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#8888aa'}}},scales:chartType==='pie'?{}:{x:{ticks:{color:'#8888aa',maxRotation:45}},y:{ticks:{color:'#8888aa'}}}}
});
})();<\\/script>
</body></html>`;
}

function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ═══════════════ Documents (DocuTurn) ═══════════════
const DOC_TEMPLATES = [
  { id:'invoice', name:'Invoice / 报价单', category:'business', icon:'💰',
    desc:'Generate professional invoices from your Airtable data',
    fields:['Company Name','Amount','Date','Description'],
    prompt: 'Generate a professional invoice. Fill in company name, amount, date, and write a 1-2 sentence description of the service.'
  },
  { id:'report', name:'Project Report / 项目报告', category:'business', icon:'📋',
    desc:'Auto-generate project status reports with AI summaries',
    fields:['Project Name','Status','Progress','Notes'],
    prompt: 'Generate a project status report. Summarize progress and notes into a professional paragraph.'
  },
  { id:'receipt', name:'Receipt / 收据', category:'finance', icon:'🧾',
    desc:'Create payment receipts from transaction records',
    fields:['Customer','Amount','Date','Payment Method'],
    prompt: 'Generate a payment receipt with customer name, amount, date, and payment method.'
  },
  { id:'summary', name:'Data Summary / 数据汇总', category:'reports', icon:'📊',
    desc:'AI-generated summary report of any table data',
    fields:[],
    prompt: 'Analyze the provided data and generate a 2-3 paragraph executive summary with key insights.'
  }
];

app.get('/api/documents/templates', (req, res) => {
  res.json({ templates: DOC_TEMPLATES });
});

app.post('/api/documents/generate', async (req, res) => {
  try {
    const { templateId, records, fields } = req.body;
    const template = DOC_TEMPLATES.find(t => t.id === templateId);
    if (!template) return res.status(400).json({ error: 'Template not found' });

    // Use AI to generate document content
    let html = '';
    if (template.id === 'summary') {
      // AI summary mode
      const aiResp = await llmChat([
        { role:'system', content: 'You are a business analyst. Write a clear, professional executive summary in HTML format (use h2, p, ul, li tags). No markdown, just HTML.' },
        { role:'user', content: `${template.prompt}\n\nData:\n${JSON.stringify(records.slice(0,10))}` }
      ], 2000);
      html = aiResp.choices[0].message.content.trim();
      // Strip any markdown code fences
      html = html.replace(/```html?/g, '').replace(/```/g, '');
    } else {
      // Template fill mode
      const aiResp = await llmChat([
        { role:'system', content: 'You are a document generator. Return valid HTML for a professional document. Use h1, h2, p, table, ul tags. Include inline CSS for styling. No markdown fences.' },
        { role:'user', content: `${template.prompt}\n\nRecords to fill:\n${JSON.stringify(records.slice(0,5))}\n\nTemplate fields: ${template.fields.join(', ')}\n\nGenerate a complete, styled HTML document ready for PDF export.` }
      ], 3000);
      html = aiResp.choices[0].message.content.trim();
      html = html.replace(/```html?/g, '').replace(/```/g, '');
    }

    // Wrap in full HTML page for PDF
    const fullHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.7;color:#1a1a2e}
h1{font-size:24px;border-bottom:2px solid #7c3aed;padding-bottom:8px}
h2{font-size:18px;color:#7c3aed;margin-top:20px}
table{width:100%;border-collapse:collapse;margin:16px 0}
th,td{padding:8px 12px;border:1px solid #ddd;text-align:left}
th{background:#f5f3ff}ul li{margin:4px 0}
.footer{margin-top:32px;padding-top:16px;border-top:1px solid #ddd;font-size:11px;color:#888}
</style></head><body>
<div style="text-align:right;color:#7c3aed;font-weight:700;font-size:20px;margin-bottom:24px;">${template.name}</div>
${html}
<div class="footer">Generated by TableTurn · ${new Date().toLocaleDateString()}</div>
</body></html>`;

    res.json({ html: fullHtml, templateId, title: template.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Export document as PDF (server-side)
app.post('/api/documents/export-pdf', authRequired, async (req, res) => {
  try {
    const { html } = req.body;
    if (!html) return res.status(400).json({ error: 'HTML content required' });

    // Attempt Puppeteer PDF generation
    let pdfBuffer = null;
    try {
      const puppeteer = require('puppeteer');
      const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
      pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top:'20mm', bottom:'20mm', left:'15mm', right:'15mm' } });
      await browser.close();
    } catch (puppErr) {
      console.log('[PDF] Puppeteer not available, returning HTML fallback:', puppErr.message);
    }

    if (pdfBuffer) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="TableTurn-document.pdf"');
      return res.send(pdfBuffer);
    }
    // Fallback: return HTML for client-side print
    res.json({ html, fallback: true, message: 'PDF engine unavailable. Use browser print (Ctrl+P) to save as PDF.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = app;

// Only listen when running directly (not on Vercel)
if (require.main === module) {
app.listen(PORT, () => {
  console.log(`\n🚀 TableTurn running at http://localhost:${PORT}`);
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
  console.log(`💳 Topup: $2 (trial) | $10 (+$2) | $50 (+$15) | $100 (+$40) — first-time +50% bonus`);
  console.log(`🎁 Demo signup: $1 free credit`);
  console.log(`💳 Stripe: ${stripe ? '✅ configured' : '❌ NOT SET (simulated checkout)'}`);
  console.log(`📧 Email: ${mailer ? '✅ SMTP configured' : '❌ NOT SET (verification skipped)'}`);
});
}
