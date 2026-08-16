#!/usr/bin/env node
/**
 * DSH Web GUI 一键全链路健康检查（Node >= 22：内置 fetch / WebSocket / crypto）。
 *
 * 用法:  node healthcheck.mjs [baseUrl]     # 默认 http://127.0.0.1:3080
 *
 * 检查项:
 *   1. GET / 页面（200 且含 window.__DSH_BOOT__）
 *   2. 全部前端资源（/assets/*、/plugins/*、manifest）HTTP 200
 *   3. 后端 RPC: session.list / workspace.list / session.create
 *      （create 用空白会话做端到端验证，随后自动 workspace.archiveSession 清理）
 *   4. WebSocket 事件通道: /api/events.mux（握手+收到帧）、/api/events.host（握手）
 *
 * 退出码: 0 = 全绿；1 = 存在 FAIL（输出里逐项定位）。
 */
const base = (process.argv[2] ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
const TIMEOUT = 10000

const passed = []
const failed = []
const notes = []

const ok = (label) => { passed.push(label); console.log(`[PASS] ${label}`) }
const bad = (label, detail) => {
  failed.push(label)
  console.log(`[FAIL] ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

async function rpc(method, payload = {}) {
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()).result
}

function wsProbe(path, expectFrame, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${new URL(base).host}${path}`)
    let opened = false
    let frames = 0
    let settled = false
    const finish = (pass, detail) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      resolve({ pass, detail })
    }
    const timer = setTimeout(() => finish(false, `timeout (opened=${opened}, frames=${frames})`), timeoutMs)
    ws.onopen = () => { opened = true; if (!expectFrame) finish(true) }
    ws.onmessage = () => { frames += 1; if (expectFrame) finish(true) }
    ws.onerror = () => finish(false, 'websocket error')
    ws.onclose = (ev) => { if (!opened) finish(false, `closed before open (code=${ev.code})`) }
  })
}

console.log(`# DSH Web GUI healthcheck @ ${base}  (${new Date().toISOString()})\n`)

// 1. 页面
let html = ''
try {
  const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(TIMEOUT) })
  html = await res.text()
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  if (!html.includes('__DSH_BOOT__')) throw new Error('page lacks __DSH_BOOT__')
  ok('GET / → 200，含 __DSH_BOOT__')
} catch (e) {
  bad('GET /', String(e))
}

// 2. 前端资源
if (html !== '') {
  const urls = new Set()
  const bootMatch = html.match(/window\.__DSH_BOOT__\s*=\s*(\{.*?\})<\/script>/s)
  if (bootMatch) {
    try {
      for (const entry of JSON.parse(bootMatch[1]).entries ?? []) {
        if (typeof entry.url === 'string' && entry.url.startsWith('/')) urls.add(entry.url)
      }
    } catch (e) {
      notes.push(`__DSH_BOOT__ 解析失败: ${String(e)}`)
    }
  }
  for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    const u = m[1]
    if (u.startsWith('/assets/') || u.startsWith('/plugins/') || u.startsWith('/manifest')) urls.add(u)
  }
  let assetFails = 0
  for (const u of urls) {
    try {
      const r = await fetch(`${base}${u}`, { signal: AbortSignal.timeout(TIMEOUT) })
      if (r.status !== 200) { assetFails += 1; console.log(`[FAIL] asset ${u} → HTTP ${r.status}`) }
    } catch (e) {
      assetFails += 1
      console.log(`[FAIL] asset ${u} → ${String(e)}`)
    }
  }
  if (assetFails === 0) ok(`前端资源 ${urls.size} 项全部 200`)
  else bad('前端资源', `${assetFails}/${urls.size} 项失败`)
}

// 3. 后端 RPC
for (const [method, payload] of [['session.list', {}], ['workspace.list', {}]]) {
  try {
    const result = await rpc(method, payload)
    if (result.ok) ok(`RPC ${method}`)
    else bad(`RPC ${method}`, JSON.stringify(result.error ?? result))
  } catch (e) {
    bad(`RPC ${method}`, String(e))
  }
}
try {
  const created = await rpc('session.create', {})
  if (!created.ok) {
    bad('RPC session.create', JSON.stringify(created.error ?? created))
  } else {
    const sid = created.value.sessionId
    notes.push(`端到端验证创建了测试会话 ${sid}`)
    const archived = await rpc('workspace.archiveSession', { sessionId: sid })
    if (archived.ok) ok(`RPC session.create（测试会话 ${sid.slice(0, 13)}… 已自动归档清理）`)
    else {
      ok('RPC session.create')
      bad('清理测试会话 workspace.archiveSession', JSON.stringify(archived.error ?? archived))
    }
  }
} catch (e) {
  bad('RPC session.create', String(e))
}

// 4. WebSocket 事件通道
{
  const mux = await wsProbe('/api/events.mux', true)
  mux.pass ? ok('WS /api/events.mux 握手成功且收到帧') : bad('WS /api/events.mux', mux.detail)
  const host = await wsProbe('/api/events.host', false)
  host.pass ? ok('WS /api/events.host 握手成功') : bad('WS /api/events.host', host.detail)
}

// 汇总
console.log(`\n=== ${passed.length} 项通过, ${failed.length} 项失败 ===`)
for (const n of notes) console.log(`[note] ${n}`)
if (failed.length > 0) {
  console.log('服务端存在故障，按 SKILL.md 第 3 条逐层定位。')
  process.exit(1)
}
console.log('服务端全链路健康。若用户仍报"新建会话无反应"，按 SKILL.md 第 2 条：先让用户 Ctrl+F5 强刷。')
process.exit(0)
