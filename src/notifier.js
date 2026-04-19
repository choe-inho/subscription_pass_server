// src/notifier.js
// 파이프라인 → 유저 알림 발송
// FCM 토큰은 Supabase user_profiles에 저장됨
//
// 환경변수:
//   FIREBASE_SERVICE_ACCOUNT_JSON — Firebase Admin SDK 서비스 계정 JSON 문자열
//   FIREBASE_PROJECT_ID           — Firebase 프로젝트 ID (서비스 계정에 포함됨)
//   FCM_CHANNEL_ID                — Android 알림 채널 ID (기본: subscription_pass_channel)

import { createRequire } from 'module'
import { supabase } from './utils/supabaseClient.js'
import { logger } from './utils/logger.js'

// ─────────────────────────────────────────
// Firebase Admin SDK 초기화 (지연 초기화)
// ─────────────────────────────────────────

let _messaging = null

function getMessaging() {
  if (_messaging) return _messaging

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (!serviceAccountJson) {
    logger.warn('[FCM] FIREBASE_SERVICE_ACCOUNT_JSON 미설정 — FCM 발송 비활성화')
    return null
  }

  try {
    // ESM 환경에서 firebase-admin 동적 require
    const require = createRequire(import.meta.url)
    const admin   = require('firebase-admin')

    if (!admin.apps.length) {
      const serviceAccount = JSON.parse(serviceAccountJson)
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      })
      logger.info('[FCM] Firebase Admin SDK 초기화 완료')
    }

    _messaging = admin.messaging()
    return _messaging
  } catch (err) {
    logger.error('[FCM] Firebase Admin SDK 초기화 실패', { error: err.message })
    return null
  }
}

// ─────────────────────────────────────────
// 알림 타입 정의
// ─────────────────────────────────────────

const NOTIFICATION_TYPES = {
  NEW_ANNOUNCEMENT: 'announcement',  // 신규 공고 등록
  SUB_START:        'sub_start',     // 청약 시작 D-1
  SUB_END:          'sub_end',       // 청약 마감 D-0
  WINNER:           'winner',        // 당첨자 발표
  COMPETITION_HOT:  'competition',   // 경쟁률 급등
}

// ─────────────────────────────────────────
// 핵심 로직: 유저 × 공고 매핑
// ─────────────────────────────────────────

/**
 * 관심 단지 등록한 유저에게 알림 발송
 * @param {string} announcementId - 공고 UUID
 * @param {string} notificationType - 알림 타입
 * @param {string} title - 알림 제목
 * @param {string} body - 알림 내용
 */
async function notifyInterestedUsers(
  announcementId,
  notificationType,
  title,
  body
) {
  // 1. 이 공고에 관심 등록하고 알림 켠 유저 ID 조회
  const { data: interests, error } = await supabase
    .from('user_interests')
    .select('user_id')
    .eq('announcement_id', announcementId)
    .eq('notify_enabled', true)

  if (error) {
    logger.error('관심 유저 조회 실패', { error: error.message })
    return { sent: 0 }
  }

  if (!interests?.length) {
    logger.debug(`관심 유저 없음: ${announcementId}`)
    return { sent: 0 }
  }

  const userIds = interests.map(i => i.user_id)

  // 2. user_subscription_status 뷰에서 FCM 토큰 + is_pro + 개인 알림 설정 한번에 조회
  // notification_preferences: { push_enabled, subscription_alert, winner_alert, competition_alert }
  const { data: profiles, error: profileError } = await supabase
    .from('user_subscription_status')
    .select('user_id, fcm_token, is_pro, expires_at, notification_preferences')
    .in('user_id', userIds)

  if (profileError) {
    logger.error('프로필 조회 실패', { error: profileError.message })
    return { sent: 0 }
  }

  // interests에 프로필 정보 병합
  const enriched = interests.map(i => {
    const profile = profiles?.find(p => p.user_id === i.user_id) || {}
    return {
      ...i,
      user_profiles: profile,
      users_sub: profile,
    }
  })

  // 3. 알림 타입별 유료 유저 필터링 + 개인 알림 설정 확인
  const targets = filterByPlanAndPreferences(enriched, notificationType)

  if (!targets.length) {
    logger.debug('발송 대상 없음 (플랜·개인설정 필터 후)')
    return { sent: 0 }
  }

  // 4. FCM 토큰 추출
  const tokens = targets
    .map(i => i.user_profiles?.fcm_token)
    .filter(Boolean)

  if (!tokens.length) {
    logger.warn('FCM 토큰 없음 — 알림 발송 불가')
    return { sent: 0 }
  }

  // 4. FCM 발송
  const sent = await sendFCM(tokens, title, body, {
    announcementId,
    type: notificationType,
  })

  // 5. 알림 이력 저장 (notifications 테이블)
  await saveNotificationLog(
    targets.map(i => i.user_id),
    announcementId,
    notificationType,
    title,
    body
  )

  logger.info(`알림 발송 완료: ${sent}명 / 타입: ${notificationType}`)
  return { sent }
}

// ─────────────────────────────────────────
// 플랜 + 개인 알림 설정 통합 필터링
// ─────────────────────────────────────────

/**
 * 알림 타입별 플랜(Pro/Free) 및 개인 알림 설정(notification_preferences)을
 * 모두 확인해 최종 발송 대상을 반환.
 *
 * 필터 순서:
 *  1. push_enabled = false → 전체 푸시 거부
 *  2. Pro 구독 만료 체크 (expires_at < now → is_pro=false로 취급)
 *  3. 알림 타입별 Pro 전용 필터 (Pro Only: SUB_START, COMPETITION_HOT)
 *  4. 개인 설정 키 확인 (subscription_alert, winner_alert, competition_alert)
 */
function filterByPlanAndPreferences(interests, notificationType) {
  // 알림 타입 → 개인 설정 키 매핑
  const PREF_KEY_MAP = {
    [NOTIFICATION_TYPES.NEW_ANNOUNCEMENT]: 'subscription_alert',
    [NOTIFICATION_TYPES.SUB_START]:        'subscription_alert',
    [NOTIFICATION_TYPES.SUB_END]:          'subscription_alert',
    [NOTIFICATION_TYPES.WINNER]:           'winner_alert',
    [NOTIFICATION_TYPES.COMPETITION_HOT]:  'competition_alert',
  }

  // Pro 전용 알림
  const proOnly = new Set([
    NOTIFICATION_TYPES.SUB_START,
    NOTIFICATION_TYPES.COMPETITION_HOT,
  ])

  const now = new Date()

  return interests.filter(i => {
    const profile = i.users_sub || {}
    const prefs   = profile.notification_preferences || {}

    // ① 전체 푸시 비활성화 체크
    if (prefs.push_enabled === false) return false

    // ② Pro 구독 만료 실시간 체크
    //    뷰의 is_pro는 is_active 기반이나, webhook 지연 대비로 expires_at도 확인
    const isActuallyPro = profile.is_pro === true &&
      (!profile.expires_at || new Date(profile.expires_at) > now)

    // ③ Pro 전용 알림은 실제 Pro 유저만
    if (proOnly.has(notificationType) && !isActuallyPro) return false

    // ④ 개인 알림 설정 키 확인 (키 없으면 기본값 true로 허용)
    const prefKey = PREF_KEY_MAP[notificationType]
    if (prefKey && prefs[prefKey] === false) return false

    return true
  })
}

// ─────────────────────────────────────────
// FCM 발송 (Firebase Admin SDK)
// ─────────────────────────────────────────

const FCM_CHANNEL_ID = process.env.FCM_CHANNEL_ID || 'subscription_pass_channel'
const FCM_CHUNK_SIZE = 500   // sendEachForMulticast 최대 토큰 수

async function sendFCM(tokens, title, body, data = {}) {
  if (!tokens.length) return 0

  const messaging = getMessaging()

  // Firebase 미설정 시 시뮬레이션 모드
  if (!messaging) {
    logger.info(`[FCM 시뮬레이션] ${tokens.length}명에게 발송 예정`)
    logger.info(`  제목: ${title}`)
    logger.info(`  내용: ${body}`)
    return tokens.length
  }

  // data 필드는 모두 string이어야 함
  const stringData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, v != null ? String(v) : ''])
  )

  // 토큰 청크 분할 (최대 500개)
  let totalSuccess = 0
  let totalFailure = 0

  for (let i = 0; i < tokens.length; i += FCM_CHUNK_SIZE) {
    const chunk = tokens.slice(i, i + FCM_CHUNK_SIZE)

    const message = {
      notification: { title, body },
      data:         stringData,
      android: {
        notification: {
          channelId:   FCM_CHANNEL_ID,
          priority:    'high',
          defaultSound: true,
        },
        priority: 'high',
      },
      apns: {
        payload: {
          aps: {
            alert: { title, body },
            sound: 'default',
            badge: 1,
          },
        },
      },
      tokens: chunk,
    }

    try {
      const response = await messaging.sendEachForMulticast(message)
      totalSuccess += response.successCount
      totalFailure += response.failureCount

      // 무효 토큰 정리 (등록 해제된 토큰)
      if (response.failureCount > 0) {
        const invalidTokens = []
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const code = resp.error?.code
            if (
              code === 'messaging/registration-token-not-registered' ||
              code === 'messaging/invalid-registration-token'
            ) {
              invalidTokens.push(chunk[idx])
            }
            logger.debug(`[FCM] 발송 실패: ${code}`)
          }
        })

        if (invalidTokens.length > 0) {
          await cleanupInvalidTokens(invalidTokens)
        }
      }
    } catch (err) {
      logger.error('[FCM] 멀티캐스트 발송 오류', { error: err.message })
    }
  }

  logger.info(`[FCM] 발송 결과 — 성공: ${totalSuccess}, 실패: ${totalFailure}`)
  return totalSuccess
}

// ─────────────────────────────────────────
// 무효 FCM 토큰 정리
// ─────────────────────────────────────────

async function cleanupInvalidTokens(tokens) {
  const { error } = await supabase
    .from('user_profiles')
    .update({ fcm_token: null })
    .in('fcm_token', tokens)

  if (error) {
    logger.warn('[FCM] 무효 토큰 정리 실패', { error: error.message })
  } else {
    logger.info(`[FCM] 무효 토큰 ${tokens.length}개 정리 완료`)
  }
}

// ─────────────────────────────────────────
// 알림 이력 저장
// ─────────────────────────────────────────

async function saveNotificationLog(
  userIds,
  announcementId,
  type,
  title,
  body
) {
  const logs = userIds.map(userId => ({
    user_id:         userId,
    announcement_id: announcementId,
    type,
    title,
    body,
    is_read:         false,
    sent_at:         new Date().toISOString(),
  }))

  const { error } = await supabase
    .from('notifications')
    .insert(logs)

  if (error) {
    logger.warn('알림 이력 저장 실패', { error: error.message })
  }
}

// ─────────────────────────────────────────
// 공개 알림 함수들
// pipeline.js에서 수집 완료 후 호출
// ─────────────────────────────────────────

/**
 * 신규 공고 등록 알림
 * - 관심 지역이 일치하는 유저에게 발송
 */
export async function notifyNewAnnouncement(announcement) {
  const { id, house_name, region_name, subscription_start } = announcement

  // notification_preferences 포함해서 조회 (개인 알림 설정 반영)
  const { data: profiles } = await supabase
    .from('user_subscription_status')
    .select('user_id, fcm_token, interest_regions, is_pro, expires_at, notification_preferences')
    .contains('interest_regions', [region_name])

  if (!profiles?.length) return

  // 개인 알림 설정 필터링 (push_enabled + subscription_alert 체크)
  const now = new Date()
  const eligible = profiles.filter(p => {
    const prefs = p.notification_preferences || {}
    if (prefs.push_enabled === false) return false
    if (prefs.subscription_alert === false) return false
    return true
  })

  const tokens = eligible.map(p => p.fcm_token).filter(Boolean)
  if (!tokens.length) return

  const dDay = calcDDay(subscription_start)

  await sendFCM(
    tokens,
    `🏠 ${region_name} 새 청약 공고`,
    `${house_name} - 청약 ${dDay}`,
    { announcementId: id, type: NOTIFICATION_TYPES.NEW_ANNOUNCEMENT }
  )

  await saveNotificationLog(
    eligible.map(p => p.user_id),
    id,
    NOTIFICATION_TYPES.NEW_ANNOUNCEMENT,
    `🏠 ${region_name} 새 청약 공고`,
    `${house_name} - 청약 ${dDay}`
  )
}

/**
 * 청약 D-1 알림 (유료 전용)
 * - 매일 04:00 파이프라인에서 내일 청약 시작 공고 체크
 */
export async function notifySubscriptionTomorrow() {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().split('T')[0]

  // 내일 청약 시작하는 공고 조회
  const { data: announcements } = await supabase
    .from('announcements')
    .select('id, house_name, region_name')
    .eq('subscription_start', tomorrowStr)
    .eq('status', 'upcoming')

  if (!announcements?.length) {
    logger.debug('내일 청약 시작 공고 없음')
    return
  }

  for (const ann of announcements) {
    await notifyInterestedUsers(
      ann.id,
      NOTIFICATION_TYPES.SUB_START,
      `📅 내일 청약 시작!`,
      `${ann.house_name} 청약이 내일 시작됩니다. 서류 준비하셨나요?`
    )
  }
}

/**
 * 청약 마감일 알림 (무료 포함)
 */
export async function notifySubscriptionToday() {
  const today = new Date().toISOString().split('T')[0]

  const { data: announcements } = await supabase
    .from('announcements')
    .select('id, house_name')
    .eq('subscription_end', today)

  if (!announcements?.length) return

  for (const ann of announcements) {
    await notifyInterestedUsers(
      ann.id,
      NOTIFICATION_TYPES.SUB_END,
      `⏰ 오늘 청약 마감!`,
      `${ann.house_name} 오늘까지 청약 접수입니다.`
    )
  }
}

/**
 * 당첨자 발표 알림 (무료 포함)
 */
export async function notifyWinnerAnnouncement() {
  const today = new Date().toISOString().split('T')[0]

  const { data: announcements } = await supabase
    .from('announcements')
    .select('id, house_name')
    .eq('winner_date', today)

  if (!announcements?.length) return

  for (const ann of announcements) {
    await notifyInterestedUsers(
      ann.id,
      NOTIFICATION_TYPES.WINNER,
      `🎉 당첨자 발표`,
      `${ann.house_name} 당첨자 발표가 났습니다. 확인해보세요!`
    )
  }
}

/**
 * 경쟁률 급등 알림 (유료 전용)
 * - 경쟁률이 이전 대비 급격히 오를 때
 */
export async function notifyHotCompetition() {
  // 최근 2시간 내 경쟁률이 10배 이상 오른 공고 조회
  const { data: hotOnes } = await supabase
    .from('competition_rates')
    .select('announcement_id, general_rate, announcements(house_name)')
    .gt('general_rate', 50)   // 50:1 이상
    .gt('recorded_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())

  if (!hotOnes?.length) return

  for (const item of hotOnes) {
    await notifyInterestedUsers(
      item.announcement_id,
      NOTIFICATION_TYPES.COMPETITION_HOT,
      `🔥 경쟁률 급등!`,
      `${item.announcements?.house_name} 현재 경쟁률 ${item.general_rate}:1 돌파!`
    )
  }
}

// ─────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────

function calcDDay(dateStr) {
  if (!dateStr) return ''
  const target = new Date(dateStr)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diff = Math.ceil((target - today) / (1000 * 60 * 60 * 24))
  if (diff === 0) return 'D-Day'
  if (diff > 0) return `D-${diff}`
  return `D+${Math.abs(diff)}`
}