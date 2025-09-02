<template>
  <div class="page">
    <!-- 背景：双 video 交叉淡入 -->
    <video ref="v0" class="bg" :class="{ hidden: active !== 0 }" muted playsinline preload="auto"></video>
    <video ref="v1" class="bg" :class="{ hidden: active !== 1 }" muted playsinline preload="auto"></video>

    <!-- 暗角 + 霓虹 + 粒子 -->
    <div class="vignette" aria-hidden></div>
    <div class="neon" aria-hidden></div>
    <canvas ref="canvasRef" id="particles" aria-hidden></canvas>

    <!-- 右上角水印 -->
    <div class="watermark">
      <span class="wm-logo">✨ SceneryX</span>
      <span class="wm-sub">Vue Demo</span>
    </div>

    <!-- 顶部右侧“当前景色” -->
    <div class="pill">当前景色：{{ videos[curIndex].label }}</div>

    <!-- 中央输入框 -->
    <main class="center">
      <section class="qa-card">
        <h1>世界在你指尖</h1>
        <p class="subtitle">在这里输入你的问题或指令，按 Enter 直接提交。</p>

        <input
          v-model.trim="text"
          type="text"
          class="input"
          placeholder="例如：帮我预定 9/20 去新西兰的机票…"
          @keydown.enter.exact.prevent="submit"
        />

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
import { onMounted, onBeforeUnmount, ref } from 'vue'

/** ===== 配置 ===== */
const API_ENDPOINT = '/api/submit'
const videos = [
  { label: '日本·东京夜景', src: '/videos/video1.mp4' },
  { label: '意大利·多洛米蒂', src: '/videos/video1.mp4' },
  { label: '冰岛·瀑布',     src: '/videos/video1.mp4' },
  { label: '中国·桂林山水', src: '/videos/video1.mp4' },
  { label: '新西兰·峡湾',   src: '/videos/video1.mp4' },
]
const INTERVAL_MS = 8000

/** ===== 背景切换 ===== */
const v0 = ref(null), v1 = ref(null)
const active = ref(0)
const curIndex = ref(Math.floor(Math.random() * videos.length))
let timer = null
function applyVideo(el, item) {
  if (!el || !item) return
  el.src = encodeURI(item.src)
  el.loop = true
  el.autoplay = true
  el.muted = true
  el.playsInline = true
  el.playbackRate = 0.5   // ✅ 设置 0.5 倍速
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
  applyVideo(nxtEl, videos[curIndex.value])
  nxtEl.classList.remove('hidden')
  curEl.classList.add('hidden')
  active.value = 1 - active.value
}

/** ===== 提交逻辑 ===== */
const text = ref('')
const messageType = ref('')
const messageText = ref('')
async function submit() {
  if (!text.value) {
    messageType.value = 'error'
    messageText.value = '请输入内容后再提交'
    return
  }
  try {
    const res = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.value }),
    })
    if (!res.ok) throw new Error(await res.text())
    const data = await res.json().catch(() => ({}))
    const msg = data?.message || 'OK，已发送到后台！'
    messageType.value = 'success'
    messageText.value = msg
    text.value = ''
  } catch (err) {
    messageType.value = 'error'
    messageText.value = '提交失败：' + (err?.message || '网络错误')
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
  applyVideo(v0.value, videos[curIndex.value])
  const pre = nextIndex(curIndex.value); applyVideo(v1.value, videos[pre])
  v1.value.classList.add('hidden'); timer = setInterval(crossfade, INTERVAL_MS)
  stopParticles = startParticles()
})
onBeforeUnmount(() => { if (timer) clearInterval(timer); stopParticles() })
</script>

<style scoped>
.page {
  position: relative; min-height: 100vh; width: 100%; overflow: hidden;
  background: transparent; color: #fff;
}
.bg { position: fixed; inset: 0; z-index: -2; width: 100%; height: 100%;
  object-fit: cover; filter: saturate(1.05) contrast(1.05) brightness(0.95);
  transition: opacity 1s ease; opacity: 1; }
.bg.hidden { opacity: 0; }

.vignette { position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background: radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,.25) 100%); }

#particles { position: fixed; inset: 0; z-index: 0; pointer-events: none; }

.watermark, .pill {
  background: rgba(255,255,255,.10);
  border: 1px solid rgba(255,255,255,.25);
  backdrop-filter: blur(8px);
  color: #fff;
  opacity: .85;
}
.watermark { position: fixed; top: 18px; right: 18px; z-index: 20;
  display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 12px; }
.pill { position: fixed; top: 18px; left: 18px; z-index: 20;
  font-size: 12px; border-radius: 999px; padding: 6px 10px; }

/* 输入框居中 */
.center {
  position: relative; z-index: 10; height: 100vh;
  display: flex; flex-direction: column; justify-content: center; align-items: center;
}
.qa-card {
  background: rgba(255,255,255,.12);
  border: 1px solid rgba(255,255,255,.28);
  backdrop-filter: blur(14px);
  border-radius: 20px;
  padding: 18px;
  width: min(80vw, 600px);   /* ✅ 缩小整体宽度 */
  text-align: center;
  box-shadow: 0 8px 30px rgba(0,0,0,.35); /* ✅ 卡片阴影 */
}
.qa-card h1 { 
  margin: 4px 0 6px; 
  font-size: clamp(20px, 2.4vw, 30px);
}
.subtitle { 
  margin: 0 0 12px; 
  color: rgba(255,255,255,.90); 
  font-size: 14px;
}

/* 输入框美化 */
.input {
  width: 80%;              /* ✅ 改成占卡片宽度的 80% */
  max-width: 400px;        /* ✅ 给一个最大宽度限制 */
  margin: 0 auto;          /* ✅ 居中 */
  display: block;

  border-radius: 18px;
  padding: 10px 14px;
  font-size: 14px;
  color:#fff;
  border: 1px solid rgba(255,255,255,.25);
  background: rgba(0,0,0,.35);
  outline: none;
  box-shadow: 0 4px 12px rgba(0,0,0,.35);
}

.msg { margin-top: 8px; min-height: 1.2em; font-size: 13px; }
.ok { color: #86efac; } 
.err { color: #fda4af; }

.credit {
  position: fixed; left: 16px; bottom: 14px; z-index: 10;
  font-size: 12px; color: #fff; opacity: .9;
  border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.10);
  border-radius: 999px; padding: 6px 10px; backdrop-filter: blur(8px);
}
</style>
