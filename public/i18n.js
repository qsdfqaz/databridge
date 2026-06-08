// DataBridge i18n - Full bilingual support
const I18N = {
  zh: {
    // Auth
    login: '登录', register: '注册', email: '邮箱', password: '密码', passwordHint: '至少6位',
    loginBtn: '登录', registerBtn: '注册', forgotPassword: '忘记密码？',
    agreeTerms: '我已阅读并同意', terms: '服务条款', privacy: '隐私政策',
    authNote: '🔐 注册需要邮箱验证。密码加密存储。',
    patNote: '🔒 你的 Airtable PAT 仅保存在浏览器本地，我们不上传也不存储。',
    // Demo
    demoTitle: '不想注册？先试试看效果',
    demoBtn: '🎮 体验演示（免费 3 次）',
    demoDesc: '使用示例数据 · 翻译和清洗各 3 次免费 · 无需注册',
    // Header
    disconnect: 'Disconnected', logout: 'Logout', dashboard: '📊 用量',
    templates: '🧩 模板', script: '📜 Airtable脚本', changePwd: '🔑',
    endDemo: '结束演示', demoUser: '🎮 演示用户', demoData: '🎮 演示数据',
    freeTrial: '🎮 免费试用', sampleLabel: 'Sales Leads (示例数据)',
    demoBanner: '🎮 演示模式', demoCounter: '翻译 {t}/{m} · 清洗 {c}/{m}',
    // Connect
    connectTitle: '🔌 连接 Airtable', connectDesc: '输入 Airtable PAT 和 Base ID',
    connectBtn: '连接', connectHelp: '在 {link} 创建 PAT，需要 data.records:read + data.records:write + schema.bases:read',
    table: '表', fields: '字段', loadRecords: '加载数据', rows: '行',
    selectRows: '选择行数', search: '搜索',
    recordInfo: '共 {n} 条示例数据 · {f} 个字段', noRecords: '暂无数据',
    // Actions
    actions: '⚡ 操作', pricing: '💰 翻译 $2/百万字符 · 清洗 $0.40/千token · DeepSeek 驱动',
    translate: '翻译', translateTitle: '🌐 翻译', clean: '清洗', cleanTitle: '🧹 智能清洗',
    bothBtn: '⚡ 一键清洗+翻译', source: '源语言', target: '目标语言',
    autoDetect: '自动检测', chinese: '中文', english: '英语', japanese: '日语',
    instruction: '清洗指令', instPlaceholder: '去空格、标准化公司名、标记空值...',
    batchMode: '🔄 批量模式（500+ 行后台处理，带进度）',
    // Results
    results: '✅ 执行结果', writeBack: '📤 写回 Airtable',
    // Cost
    costTitle: {translate:'🌐 翻译成本', clean:'🧹 清洗成本', both:'⚡ 清洗+翻译成本'},
    estimateLine: {translate:'翻译 ({chars} 字符 × $2/M)', clean:'清洗 ({tokens} tokens × $0.40/1K)'},
    // Dashboard
    recentActivity: '📋 最近操作', recentTime: '时间', recentAction: '操作', recentDetail: '详情', recentCost: '费用',
    statTranslations: '翻译次数', statCleanings: '清洗次数',
    chartTrans: '🟣 翻译次数', chartClean: '🟢 清洗次数',
    // Templates
    templatesDesc: '精选清洗和翻译方案，一键应用到工作台',
    // Topup
    topupDesc: '用不完不过期，可留到下月。翻译 $2/M 字符 · 清洗 $0.40/K token',
    topupTrans: '翻译 / 百万字符', topupClean: '清洗 / 千 token',
    // Upgrade
    upgradeDesc: '你已经体验了 DataBridge 的翻译和清洗能力。<br>注册后即可连接你自己的 Airtable，处理真实数据。',
    // Toast
    demoStarted: '🎮 演示模式已启动！翻译和清洗各可免费试用 3 次',
    demoDone: '✅ 免费试用完成！剩余: 翻译 {tl} 次 · 清洗 {cl} 次',
    noTransLeft: '翻译免费次数已用完', noCleanLeft: '清洗免费次数已用完',
    demoReadOnly: '演示模式使用只读数据，注册后可写回你自己的 Airtable',
    demoNoTopup: '演示模式无需充值，注册后即可充值使用',
    // Footer
    footerTerms: '服务条款', footerPrivacy: '隐私政策', footerPowered: 'Powered by DeepSeek',
    // Action labels in tables
    actionLabels: {translate:'🌐翻译', clean:'🧹清洗', both:'⚡清洗+翻译', topup:'💳充值', batch:'🔄批量'},
    // Email verify
    emailNotVerified: '⚠️ 邮箱未验证', verifyNote: '充值和使用服务需要先验证邮箱',
    sendCode: '发送验证码', verifyCode: '验证', codePlaceholder: '6位验证码',
    // Password modals
    pwdChangeTitle: '修改密码', currentPwd: '当前密码', newPwd: '新密码', updatePwd: '更新密码',
    forgotTitle: '重置密码 / Reset Password', forgotDesc: '输入注册邮箱获取验证码',
    sendResetBtn: '发送验证码 / Send Code', resetBtn: '重置密码 / Reset',
    closeBtn: '关闭 Close',
  },
  en: {
    login: 'Login', register: 'Register', email: 'Email', password: 'Password', passwordHint: '6+ characters',
    loginBtn: 'Login', registerBtn: 'Register', forgotPassword: 'Forgot password?',
    agreeTerms: 'I agree to the', terms: 'Terms', privacy: 'Privacy',
    authNote: 'Your password is encrypted. Email verification required.',
    patNote: 'Your Airtable PAT stays in your browser — never uploaded to our server.',
    demoTitle: 'Not ready to sign up? Try the demo first',
    demoBtn: '🎮 Live Demo (3 Free)',
    demoDesc: 'Sample data · 3 free translations & cleanings · No registration',
    disconnect: 'Disconnected', logout: 'Logout', dashboard: '📊 Usage',
    templates: '🧩 Templates', script: '📜 Script', changePwd: '🔑',
    endDemo: 'End Demo', demoUser: '🎮 Demo User', demoData: '🎮 Demo Data',
    freeTrial: '🎮 Free Trial', sampleLabel: 'Sales Leads (Sample)',
    demoBanner: '🎮 Demo Mode', demoCounter: 'Translate {t}/{m} · Clean {c}/{m}',
    connectTitle: 'Connect Airtable', connectDesc: 'Enter your Airtable PAT and Base ID to get started',
    connectBtn: 'Connect', connectHelp: 'Create a PAT at {link} with scopes: data.records:read + data.records:write + schema.bases:read',
    table: 'Table', fields: 'Fields', loadRecords: 'Load Records', rows: 'rows',
    selectRows: 'Select Rows', search: 'Search',
    recordInfo: '{n} sample records · {f} fields', noRecords: 'No records',
    actions: '⚡ Actions', pricing: '💰 Translate $2/M chars · Clean $0.40/1K tokens · Powered by DeepSeek',
    translate: 'Translate', translateTitle: '🌐 Translate', clean: 'Clean', cleanTitle: '🧹 Clean',
    bothBtn: '⚡ Translate + Clean', source: 'Source', target: 'Target',
    autoDetect: 'Auto Detect', chinese: 'Chinese', english: 'English', japanese: 'Japanese',
    instruction: 'Instruction', instPlaceholder: 'e.g. Remove spaces, standardize names, mark empty...',
    batchMode: '🔄 Batch mode (500+ rows, background processing)',
    results: '✅ Results', writeBack: '📤 Write Back',
    costTitle: {translate:'🌐 Translation Cost', clean:'🧹 Cleaning Cost', both:'⚡ Translate+Clean Cost'},
    estimateLine: {translate:'Translate ({chars} chars × $2/M)', clean:'Clean ({tokens} tokens × $0.40/1K)'},
    recentActivity: '📋 Recent Activity', recentTime: 'Time', recentAction: 'Action', recentDetail: 'Details', recentCost: 'Cost',
    statTranslations: 'Translations', statCleanings: 'Cleanings',
    chartTrans: '🟣 Translations', chartClean: '🟢 Cleanings',
    templatesDesc: 'Curated cleaning & translation templates — one click to apply',
    topupDesc: 'Balance never expires. Translate $2/M chars · Clean $0.40/K token',
    topupTrans: 'Translation / M chars', topupClean: 'Cleaning / K tokens',
    upgradeDesc: 'You\'ve tried DataBridge. Ready for more?<br>Register to connect your own Airtable base with real data.',
    demoStarted: '🎮 Demo mode started! 3 free translations & cleanings',
    demoDone: '✅ Done! Remaining: Translate {tl} · Clean {cl}',
    noTransLeft: 'No free translations left', noCleanLeft: 'No free cleanings left',
    demoReadOnly: 'Demo mode is read-only. Register to write to your own Airtable',
    demoNoTopup: 'Registration required to top up',
    footerTerms: 'Terms', footerPrivacy: 'Privacy', footerPowered: 'Powered by DeepSeek',
    actionLabels: {translate:'🌐 Translate', clean:'🧹 Clean', both:'⚡ Trans+Clean', topup:'💳 Topup', batch:'🔄 Batch'},
    emailNotVerified: '⚠️ Email not verified', verifyNote: 'Verify your email to top up and use the service',
    sendCode: 'Send Code', verifyCode: 'Verify', codePlaceholder: '6-digit code',
    pwdChangeTitle: 'Change Password', currentPwd: 'Current Password', newPwd: 'New Password', updatePwd: 'Update Password',
    forgotTitle: 'Reset Password', forgotDesc: 'Enter your email to receive a reset code',
    sendResetBtn: 'Send Code', resetBtn: 'Reset Password',
    closeBtn: 'Close',
  }
};

let currentLang = localStorage.getItem('databridge_lang') || 'en';

function t(key, vars) {
  let str = I18N[currentLang]?.[key];
  if (!str) str = I18N.zh[key];
  if (!str) return key;
  if (typeof str === 'object') return str;
  if (vars) for (const [k, v] of Object.entries(vars)) str = str.replace(`{${k}}`, v);
  return str;
}

function switchLang(lang) {
  localStorage.setItem('databridge_lang', lang);
  location.reload();  // Full reload — all text rebuilt in new language
}

function initLang() {
  document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('title');
  const btn = document.getElementById('btn-lang');
  if (btn) btn.textContent = '🌐 ' + (currentLang === 'zh' ? 'EN' : '中文');
}

document.addEventListener('DOMContentLoaded', initLang);
