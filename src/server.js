// src/server.js
// RevenueCat 웹훅 수신 + 구독 상태 Supabase 동기화 HTTP 서버
// ─────────────────────────────────────────────────────────────
// 환경변수:
//   REVENUECAT_WEBHOOK_SECRET — RevenueCat 대시보드에서 설정한 Authorization 토큰
//   PORT                      — 서버 포트 (기본 3000)
//
// RevenueCat 이벤트 흐름:
//   INITIAL_PURCHASE / RENEWAL / UNCANCELLATION → subscriptions.is_active=true, plan='pro'
//   CANCELLATION / EXPIRATION / BILLING_ISSUE   → subscriptions.is_active=false

import express from 'express'
import 'dotenv/config'
import { supabase } from './utils/supabaseClient.js'
import { logger } from './utils/logger.js'

const app = express()
app.use(express.json({ limit: '1mb' }))

// ─────────────────────────────────────────
// RevenueCat 이벤트 분류
// ─────────────────────────────────────────

const ACTIVE_EVENTS = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'PRODUCT_CHANGE',
  'SUBSCRIBER_ALIAS',
])

const INACTIVE_EVENTS = new Set([
  'CANCELLATION',
  'EXPIRATION',
  'BILLING_ISSUE',
  'REQUEST_TRIAL_CANCELLATION',
])

// ─────────────────────────────────────────
// 웹훅 엔드포인트
// ─────────────────────────────────────────

/**
 * POST /webhook/revenuecat
 * RevenueCat → 서버 → Supabase subscriptions 테이블 업데이트
 *
 * RevenueCat Payload 구조:
 * {
 *   api_version: "1.0",
 *   event: {
 *     id: string,
 *     type: "INITIAL_PURCHASE" | "RENEWAL" | ...,
 *     app_user_id: string,         ← Supabase auth.users.id와 동일하게 설정
 *     original_app_user_id: string,
 *     product_id: string,
 *     expiration_at_ms: number | null,
 *     purchased_at_ms: number,
 *     environment: "PRODUCTION" | "SANDBOX",
 *   }
 * }
 */
app.post('/webhook/revenuecat', async (req, res) => {
  // 1. Secret 검증
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET
  if (secret) {
    const auth = req.headers['authorization']
    if (auth !== `Bearer ${secret}`) {
      logger.warn('[RevenueCat] 웹훅 인증 실패 — 잘못된 시크릿')
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  const payload = req.body
  const event   = payload?.event

  if (!event) {
    logger.warn('[RevenueCat] 잘못된 페이로드 — event 없음')
    return res.status(400).json({ error: 'Missing event' })
  }

  logger.info(`[RevenueCat] 이벤트 수신: ${event.type}`, {
    userId:      event.app_user_id,
    productId:   event.product_id,
    environment: event.environment,
  })

  // SANDBOX 이벤트는 처리하되 로그에 표시
  if (event.environment === 'SANDBOX') {
    logger.debug('[RevenueCat] SANDBOX 이벤트 — 실제 DB 반영됩니다')
  }

  try {
    await handleRevenueCatEvent(event)
    return res.status(200).json({ ok: true })
  } catch (err) {
    logger.error('[RevenueCat] 이벤트 처리 실패', { error: err.message })
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ─────────────────────────────────────────
// 이벤트 처리
// ─────────────────────────────────────────

async function handleRevenueCatEvent(event) {
  const {
    app_user_id:  userId,
    id:           revenueCatId,
    type:         eventType,
    product_id:   productId,
    expiration_at_ms: expiresAtMs,
    purchased_at_ms:  purchasedAtMs,
  } = event

  if (!userId) {
    logger.warn('[RevenueCat] app_user_id 없음 — 무시')
    return
  }

  const expiresAt   = expiresAtMs  ? new Date(expiresAtMs).toISOString()  : null
  const purchasedAt = purchasedAtMs ? new Date(purchasedAtMs).toISOString() : null

  if (ACTIVE_EVENTS.has(eventType)) {
    await upsertSubscription({
      userId,
      revenueCatId,
      plan:       'pro',
      isActive:   true,
      expiresAt,
      startedAt:  purchasedAt ?? new Date().toISOString(),
    })
  } else if (INACTIVE_EVENTS.has(eventType)) {
    await upsertSubscription({
      userId,
      revenueCatId,
      plan:     'free',
      isActive: false,
      expiresAt,
      startedAt: null,
    })
  } else {
    logger.debug(`[RevenueCat] 처리하지 않는 이벤트: ${eventType}`)
  }
}

// ─────────────────────────────────────────
// Supabase subscriptions upsert
// ─────────────────────────────────────────

async function upsertSubscription({ userId, revenueCatId, plan, isActive, expiresAt, startedAt }) {
  const payload = {
    user_id:        userId,
    plan,
    is_active:      isActive,
    expires_at:     expiresAt,
    updated_at:     new Date().toISOString(),
  }

  // revenue_cat_id, started_at는 활성화 시에만 갱신
  if (revenueCatId) payload.revenue_cat_id = revenueCatId
  if (startedAt)    payload.started_at     = startedAt

  const { error } = await supabase
    .from('subscriptions')
    .upsert(payload, { onConflict: 'user_id' })

  if (error) {
    logger.error('[RevenueCat] subscriptions upsert 실패', {
      error: error.message,
      userId,
    })
    throw error
  }

  logger.info(`[RevenueCat] 구독 업데이트 완료`, {
    userId: userId.slice(0, 8) + '...',
    plan,
    isActive,
    expiresAt,
  })
}

// ─────────────────────────────────────────
// 내부 API 인증 미들웨어
// ─────────────────────────────────────────

/**
 * verifySupabaseJwt: Supabase JWT 검증 미들웨어
 * Authorization: Bearer <supabase-access-token>
 * → req.user 에 { id, email, ... } 세팅
 */
async function verifySupabaseJwt(req, res, next) {
  const authHeader = req.headers['authorization'] || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' })
  }

  try {
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }
    req.user = data.user
    next()
  } catch (err) {
    logger.error('[Auth] JWT 검증 실패', { error: err.message })
    return res.status(500).json({ error: 'Auth verification failed' })
  }
}

/**
 * requirePro: Pro 구독 여부 검증 미들웨어
 * verifySupabaseJwt 이후에 사용해야 함
 * subscriptions 테이블에서 is_active=true & plan='pro' & expires_at > now 확인
 */
async function requirePro(req, res, next) {
  const userId = req.user?.id
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  try {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('plan, is_active, expires_at')
      .eq('user_id', userId)
      .eq('is_active', true)
      .eq('plan', 'pro')
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.status(403).json({ error: 'Pro subscription required' })
    }

    // 만료 시간 검증 (DB is_active가 아직 false로 업데이트 안 됐을 경우 대비)
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      return res.status(403).json({ error: 'Subscription expired' })
    }

    req.subscription = data
    next()
  } catch (err) {
    logger.error('[requirePro] 구독 확인 실패', { error: err.message })
    return res.status(500).json({ error: 'Subscription check failed' })
  }
}

// ─────────────────────────────────────────
// Pro 상태 확인 엔드포인트
// ─────────────────────────────────────────

/**
 * GET /subscription/status
 * Authorization: Bearer <supabase-access-token>
 * → { isPro, plan, expiresAt, daysRemaining }
 *
 * 클라이언트가 웹훅 처리 후 구독 상태를 즉시 확인할 때 사용
 * (Realtime 지연 보완용)
 */
app.get('/subscription/status', verifySupabaseJwt, async (req, res) => {
  const userId = req.user.id

  try {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('plan, is_active, expires_at, started_at')
      .eq('user_id', userId)
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error

    if (!data) {
      return res.json({ isPro: false, plan: 'free', expiresAt: null, daysRemaining: null })
    }

    const isExpired = data.expires_at && new Date(data.expires_at) < new Date()
    const isPro = data.is_active && data.plan === 'pro' && !isExpired

    let daysRemaining = null
    if (isPro && data.expires_at) {
      const diffMs = new Date(data.expires_at).getTime() - Date.now()
      daysRemaining = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)))
    }

    return res.json({
      isPro,
      plan: isPro ? 'pro' : 'free',
      expiresAt: data.expires_at ?? null,
      daysRemaining,
    })
  } catch (err) {
    logger.error('[subscription/status] 오류', { error: err.message })
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ─────────────────────────────────────────
// 헬스체크
// ─────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    ok:      true,
    service: 'subscription-pass-server',
    time:    new Date().toISOString(),
  })
})

// ─────────────────────────────────────────
// 서버 시작 (단독 실행용)
// ─────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10)

app.listen(PORT, () => {
  logger.info(`🌐 웹훅 서버 시작 — http://localhost:${PORT}`)
  logger.info('  POST /webhook/revenuecat    RevenueCat 구독 이벤트')
  logger.info('  GET  /subscription/status   Pro 구독 상태 조회 (JWT 인증)')
  logger.info('  GET  /health                헬스체크')
})

export { app, verifySupabaseJwt, requirePro }
