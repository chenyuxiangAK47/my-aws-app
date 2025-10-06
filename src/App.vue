<template>
  <div class="page">
    <!-- 背景：双 video 交叉淡入 -->
    <video ref="v0" class="bg" :class="{ hidden: active !== 0 }" muted playsinline preload="metadata"></video>
    <video ref="v1" class="bg" :class="{ hidden: active !== 1 }" muted playsinline preload="metadata"></video>

    <!-- 暗角 + 霓虹 + 粒子 -->
    <div class="vignette" aria-hidden></div>
    <div class="neon" aria-hidden></div>
    <canvas ref="canvasRef" id="particles" aria-hidden></canvas>

    <!-- 右上角水印 -->
    <div class="watermark">
      <span class="wm-logo">✨ SceneryX</span>
      <span class="wm-sub">Vue Demo</span>
    </div>

    <!-- 左上角“当前景色” -->
    <div class="pill">当前景色：{{ videos[curIndex].label }}</div>

    <!-- 中央输入卡片 -->
    <main class="center">
      <section class="qa-card">
        <h1>世界在你指尖</h1>
        <p class="subtitle">在这里输入你的问题或指令，按 Enter 直接提交。</p>

        <!-- 🔐 注册/登录切换 + 表单 -->
        <div class="auth-form" style="margin: 12px 0;">
          <!-- 切换按钮 -->
          <div style="display: flex; gap: 8px; justify-content: center; margin-bottom: 8px;">
            <button 
              class="tab-btn" 
              :class="{ active: authMode === 'login' }"
              @click="authMode = 'login'"
            >
              登录
            </button>
            <button 
              class="tab-btn" 
              :class="{ active: authMode === 'register' }"
              @click="authMode = 'register'"
            >
              注册
            </button>
          </div>

          <!-- 输入表单 -->
          <div style="display: flex; flex-direction: column; gap: 8px; align-items: center; width: 80%; margin: 0 auto;">
            <input
              v-model.trim="email"
              type="email"
              class="auth-input"
              placeholder="请输入邮箱"
              :disabled="authLoading"
            />
            <input
              v-model.trim="password"
              type="password"
              class="auth-input"
              placeholder="请输入密码（至少6位）"
              :disabled="authLoading"
            />
          </div>

          <!-- 操作按钮（根据模式动态显示） -->
          <div style="display:flex;align-items:center;gap:8px;justify-content:center; margin-top: 10px;">
            <!-- 登录模式显示登录按钮 -->
            <button v-if="authMode === 'login'" class="auth-btn"
                    :disabled="authLoading || !email || !password || password.length < 6"
                    @click="doLogin">
              {{ authLoading ? '处理中…' : '登录' }}
            </button>

            <!-- 注册模式显示注册按钮 -->
            <button v-else class="auth-btn"
                    :disabled="authLoading || !email || !password || password.length < 6"
                    @click="doRegister">
              {{ authLoading ? '处理中…' : '注册' }}
            </button>

            <button class="auth-btn"
                    :disabled="!token || authLoading"
                    @click="handleLogout">
              退出
            </button>
          </div>

          <p v-if="authError" class="err" style="text-align:center; margin: 8px 0 0; font-size: 13px;">
            {{ authError }}
          </p>
        </div>

        <!-- Token 状态显示 -->
        <div class="token-status" style="margin: 8px 0; font-size: 12px; opacity: 0.8;">
          Token: <code>{{ token ? token.slice(0,16) + '…' : '未登录' }}</code>
          <span v-if="tokenExpText">（过期：{{ tokenExpText }}）</span>
        </div>

        <input
          v-model.trim="text"
          type="text"
          class="input"
          placeholder="例如：帮我预定 9/20 去新西兰的机票…"
          @keydown.enter.exact.prevent="submit"
          :disabled="!token"
        />

        <!-- ✅ 历史记录展示 -->
        <ul class="history">
          <li v-for="msg in history" :key="msg.id" class="hist-item">
            <span class="dot"></span>
            <span class="hist-text">{{ msg.text }}</span>
          </li>
          <li v-if="history.length === 0" class="hist-empty">暂无历史记录</li>
        </ul>

        <!-- 提交结果提示 -->
        <div class="msg" :class="{ ok: messageType==='success', err: messageType==='error' }">
          {{ messageText }}
        </div>
      </section>
    </main>

    <!-- 左下角角标 -->
    <div class="credit">{{ videos[curIndex].label }} · 演示视频</div>
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, ref, computed } from 'vue'

/** ===== 工具函数（全局复用）===== */
// 1. Token 值标准化（过滤 undefined/null）
function normalize(v) {
  return (v && v !== 'undefined' && v !== 'null') ? v : ''
}

// 2. 错误文本清洗（统一解析 JSON 错误/普通错误）
function safeErr(e) {
  const msg = e?.message || ''
  try {
    // 解析后端返回的 JSON 格式错误（如 {"error":"用户已存在"}）
    const errJson = JSON.parse(msg)
    if (errJson?.error) return errJson.error
  } catch {}
  // 非 JSON 错误直接返回
  return msg || '请求失败，请稍后重试'
}

/** ===== 页面状态 ===== */
const history = ref([])
const text = ref('')
const messageType = ref('')
const messageText = ref('')

/** ===== 配置（从 .env 读取） ===== */
const API_BASE = import.meta.env.VITE_API_BASE || ''
const API_SUBMIT  = `${API_BASE}/api/submit`
const API_HISTORY = `${API_BASE}/api/history`
const API_REGISTER = `${API_BASE}/auth/register`
const API_LOGIN    = `${API_BASE}/auth/login`
const API_REFRESH  = `${API_BASE}/auth/refresh`
const API_LOGOUT   = `${API_BASE}/auth/logout`

const videos = [
  { label: '澳洲风光',  src: 'https://my-vue-videos.s3.ap-southeast-2.amazonaws.com/aozhouvideo.mp4' },
  { label: '新西兰峡湾', src: 'https://my-vue-videos.s3.ap-southeast-2.amazonaws.com/xinxilanvideo.mp4' },
]
const INTERVAL_MS = 8000

/** ===== 背景切换 ===== */
const v0 = ref(null), v1 = ref(null)
const active = ref(0)
const curIndex = ref(Math.floor(Math.random() * videos.length))
let timer = null

function applyVideo(el, item, { preload = 'metadata' } = {}) {
  if (!el || !item) return
  el.preload = preload
  el.src = encodeURI(item.src)
  el.loop = true
  el.autoplay = true
  el.muted = true
  el.playsInline = true
  el.playbackRate = 0.5
  el.oncanplay = () => { try { el.play() } catch {} }
}

function nextIndex(cur) {
  let n = cur
  while (n === cur) n = Math.floor(Math.random() * videos.length)
  return n
}

function crossfade() {
  const curEl = active.value === 0 ? v0.value : v1.value
  const nxtEl = active.value === 0 ? v1.value : v0.value
  curIndex.value = nextIndex(curIndex.value)
  applyVideo(nxtEl, videos[curIndex.value], { preload: 'auto' })
  nxtEl.classList.remove('hidden')
  curEl.classList.add('hidden')
  active.value = 1 - active.value
}

/** ===== 账号体系核心逻辑（修复后）===== */
// 认证状态
const authMode = ref('login') // 'login' | 'register'
const email = ref('')
const password = ref('')
const authLoading = ref(false)
const authError = ref('')

// Token 响应式状态（初始化时标准化，全局唯一）
const token = ref(normalize(localStorage.getItem('ACCESS_TOKEN')))
const refreshToken = ref(normalize(localStorage.getItem('REFRESH_TOKEN')))

// 3. Token 存储/清理工具（同步响应式状态与 localStorage）
function setTokens(accessToken, refreshTokenVal) {
  if (accessToken) {
    localStorage.setItem('ACCESS_TOKEN', accessToken)
    token.value = accessToken
  } else {
    localStorage.removeItem('ACCESS_TOKEN')
    token.value = ''
  }
  if (refreshTokenVal) {
    localStorage.setItem('REFRESH_TOKEN', refreshTokenVal)
    refreshToken.value = refreshTokenVal
  } else {
    localStorage.removeItem('REFRESH_TOKEN')
    refreshToken.value = ''
  }
}

// Token 过期时间计算
const tokenExpText = computed(() => {
  if (!token.value) return ''
  try {
    const payload = JSON.parse(atob(token.value.split('.')[1]))
    const expMs = payload.exp * 1000
    return new Date(expMs).toLocaleString()
  } catch { return '解析失败' }
})

/**
 * Token 自动刷新
 * @returns {boolean} 刷新成功返回true，失败返回false
 */
async function refreshAccessToken() {
  if (!refreshToken.value) return false
  try {
    const res = await fetch(API_REFRESH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshToken.value })
    })
    if (!res.ok) throw new Error(await res.text() || 'Token刷新失败')
    
    const data = await res.json()
    setTokens(data.accessToken, data.refreshToken) // 使用统一工具更新Token
    return true
  } catch (err) {
    console.error('Token刷新失败:', err)
    handleLogout(true) // 刷新失败强制退出
    return false
  }
}

/**
 * 封装带Token刷新的请求函数
 * @param {string} url 请求地址
 * @param {object} options fetch配置
 * @returns {Response} 响应对象
 */
async function requestWithRefresh(url, options = {}) {
  // 自动添加Token头部
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
    ...(token.value ? { Authorization: `Bearer ${token.value}` } : {})
  }

  const res = await fetch(url, { ...options, headers })

  // 处理401（Token过期）
  if (res.status === 401) {
    const refreshSuccess = await refreshAccessToken()
    if (refreshSuccess) {
      // 刷新成功后重试请求
      return fetch(url, {
        ...options,
        headers: { ...headers, Authorization: `Bearer ${token.value}` }
      })
    }
  }

  return res
}

/**
 * 独立登录函数（外层作用域，模板可直接调用）
 */
async function doLogin() {
  authError.value = '' // 清空历史错误
  try {
    authLoading.value = true
    const res = await fetch(API_LOGIN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value, password: password.value })
    })

    if (!res.ok) throw new Error(await res.text() || '登录失败')
    
    const data = await res.json()
    // 校验响应Token有效性
    if (!data.accessToken || !data.refreshToken) {
      throw new Error('登录响应缺少Token，请联系管理员')
    }

    // 存储Token并清空表单
    setTokens(data.accessToken, data.refreshToken)
    email.value = ''
    password.value = ''
    
    // 加载用户历史记录
    await loadHistory()
  } catch (err) {
    authError.value = safeErr(err) // 统一错误处理
  } finally {
    authLoading.value = false
  }
}

/**
 * 独立注册函数（外层作用域，模板可直接调用）
 */
async function doRegister() {
  authError.value = '' // 清空历史错误
  try {
    authLoading.value = true
    const res = await fetch(API_REGISTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value, password: password.value })
    })

    // 兼容400（参数错误）和409（用户已存在）状态码
    if ([400, 409].includes(res.status)) {
      const errText = await res.text()
      authError.value = /User exists/i.test(errText) 
        ? '用户已存在，请直接登录' 
        : (safeErr(new Error(errText)) || '注册参数错误')
      return
    }

    if (!res.ok) throw new Error(await res.text() || '注册失败')

    // 注册成功提示（明确引导登录）
    authError.value = '注册成功！请使用该账号登录'
  } catch (err) {
    authError.value = safeErr(err) // 统一错误处理
  } finally {
    authLoading.value = false
  }
}

/**
 * 退出登录函数（外层作用域，模板可直接调用）
 * @param {boolean} skipApi 是否跳过后端接口（用于Token失效时）
 */
async function handleLogout(skipApi = false) {
  // 调用后端退出接口（使refreshToken失效）
  if (!skipApi && refreshToken.value) {
    try {
      await fetch(API_LOGOUT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${refreshToken.value}` }
      })
    } catch (err) {
      console.error('退出登录接口调用失败:', err)
    }
  }

  // 清理Token与页面状态
  setTokens('', '')
  history.value = []
  authError.value = ''
}

/** ===== 历史记录加载 ===== */
async function loadHistory() {
  if (!token.value) return
  try {
    const res = await requestWithRefresh(`${API_HISTORY}?page=1&pageSize=20`)
    
    if (!res.ok) throw new Error(await res.text() || '加载历史失败')
    const data = await res.json()
    history.value = Array.isArray(data?.items) ? data.items : []
  } catch (err) {
    messageType.value = 'error'
    messageText.value = '加载历史失败：' + safeErr(err) // 统一错误处理
    console.error('加载历史失败:', err)
  }
}

/** ===== 提交逻辑 ===== */
async function submit() {
  if (!token.value) {
    messageType.value = 'error'
    messageText.value = '请先登录后提交'
    return
  }
  if (!text.value) {
    messageType.value = 'error'
    messageText.value = '请输入内容后再提交'
    return
  }

  try {
    const res = await requestWithRefresh(API_SUBMIT, {
      method: 'POST',
      body: JSON.stringify({ text: text.value })
    })

    if (!res.ok) throw new Error(await res.text() || '提交失败')
    const data = await res.json().catch(() => ({}))
    
    messageType.value = 'success'
    messageText.value = data?.message || '提交成功！'
    text.value = ''
    await loadHistory() // 提交后刷新历史
  } catch (err) {
    messageType.value = 'error'
    messageText.value = '提交失败：' + safeErr(err) // 统一错误处理
  }
}

/** ===== 粒子层 ===== */
const canvasRef = ref(null)
let rafId = 0, stopParticles = () => {}

function startParticles () {
  const canvas = canvasRef.value, ctx = canvas.getContext('2d')
  function resize(){ canvas.width = innerWidth; canvas.height = innerHeight }
  resize(); addEventListener('resize', resize)
  
  let parts = Array.from({ length: 70 }, () => ({
    x: Math.random()*canvas.width, y: Math.random()*canvas.height,
    r: Math.random()*1.6+0.6, vx: (Math.random()-0.5)*0.28,
    vy: (Math.random()-0.5)*0.28, a: Math.random()*0.6+0.2
  }))

  function loop(){
    ctx.clearRect(0,0,canvas.width,canvas.height)
    for(const p of parts){
      p.x+=p.vx; p.y+=p.vy
      if(p.x<0||p.x>canvas.width) p.vx*=-1
      if(p.y<0||p.y>canvas.height) p.vy*=-1
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2)
      ctx.fillStyle=`rgba(255,255,255,${p.a})`; ctx.fill()
    }
    rafId=requestAnimationFrame(loop)
  }
  loop()
  return () => { cancelAnimationFrame(rafId); removeEventListener('resize', resize) }
}

/** ===== 生命周期 ===== */
onMounted(() => {
  // 初始化视频背景
  applyVideo(v0.value, videos[curIndex.value], { preload: 'metadata' })
  const pre = nextIndex(curIndex.value)
  applyVideo(v1.value, videos[pre], { preload: 'none' })
  v1.value.classList.add('hidden')
  timer = setInterval(crossfade, INTERVAL_MS)

  // 初始化粒子效果
  stopParticles = startParticles()

  // 页面加载时加载历史（若已登录）
  if (token.value) {
    loadHistory()
  }
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  stopParticles()
})
</script>

<style scoped>
/* 原有样式保留，新增认证相关样式 */  /* ✅ 注释没问题，保持 CSS 注释语法 */
.page{position:relative;min-height:100vh;width:100%;overflow:hidden;background:transparent;color:#fff}
.bg{position:fixed;inset:0;z-index:-2;width:100%;height:100%;object-fit:cover;filter:saturate(1.05) contrast(1.05) brightness(0.95);transition:opacity 1s ease;opacity:1}
.bg.hidden{opacity:0}
.vignette{position:fixed;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(ellipse at center,rgba(0,0,0,0) 45%,rgba(0,0,0,.25) 100%)}
#particles{position:fixed;inset:0;z-index:0;pointer-events:none}
.watermark,.pill{background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.25);backdrop-filter:blur(8px);color:#fff;opacity:.85}
.watermark{position:fixed;top:18px;right:18px;z-index:20;display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:12px}
.pill{position:fixed;top:18px;left:18px;z-index:20;font-size:12px;border-radius:999px;padding:6px 10px}
.center{position:relative;z-index:10;height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center}
.qa-card{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.28);backdrop-filter:blur(14px);border-radius:20px;padding:18px;width:min(80vw,600px);text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.35)}
.qa-card h1{margin:4px 0 6px;font-size:clamp(20px,2.4vw,30px)}
.subtitle{margin:0 0 12px;color:rgba(255,255,255,.90);font-size:14px}
.input{width:80%;max-width:400px;margin:0 auto 10px;display:block;border-radius:18px;padding:10px 14px;font-size:14px;color:#fff;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.35);outline:none;box-shadow:0 4px 12px rgba(0,0,0,.35);opacity:1;cursor:text}
.input:disabled{opacity:0.6;cursor:not-allowed}
.history{list-style:none;padding:8px 10px;margin:8px auto 6px;width:88%;max-width:480px;max-height:160px;overflow:auto;text-align:left;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.25);border-radius:14px;backdrop-filter:blur(10px)}
.history::-webkit-scrollbar{width:8px;height:8px}
.history::-webkit-scrollbar-thumb{background:rgba(255,255,255,.25);border-radius:999px}
.history::-webkit-scrollbar-track{background:transparent}
.hist-item{display:flex;align-items:flex-start;gap:8px;padding:6px 4px;border-bottom:1px dashed rgba(255,255,255,.15)}
.hist-item:last-child{border-bottom:0}
.dot{width:6px;height:6px;margin-top:7px;border-radius:999px;background:rgba(99,102,241,.9);flex:0 0 auto}
.hist-text{opacity:.95;line-height:1.35;word-break:break-word}
.hist-empty{text-align:center;opacity:.75;padding:8px 0}
.msg{margin-top:6px;min-height:1.2em;font-size:13px}
.ok{color:#86efac}
.err{color:#fda4af}
.credit{position:fixed;left:16px;bottom:14px;z-index:10;font-size:12px;color:#fff;opacity:.9;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.10);border-radius:999px;padding:6px 10px;backdrop-filter:blur(8px)}

/* 新增认证相关样式 */
.tab-btn{background:transparent;border:1px solid rgba(255,255,255,.25);border-radius:8px;padding:4px 12px;color:#fff;cursor:pointer;transition:all 0.2s}
.tab-btn.active{background:rgba(99,102,241,.4);border-color:rgba(99,102,241,.6)}
.auth-input{width:100%;max-width:300px;border-radius:8px;padding:8px 12px;font-size:14px;color:#fff;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.35);outline:none}
.auth-btn{border-radius:8px;padding:6px 14px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;transition:all 0.2s}
.auth-btn:disabled{opacity:0.5;cursor:not-allowed}
.auth-btn:not(:disabled):hover{background:rgba(255,255,255,.2)}
</style>