// src/collectors/announcements.js
// 청약 공고 수집 및 정제
//
// 실제 API 응답 필드명 (2026.04.05 확인)
// HOUSE_MANAGE_NO, HOUSE_NM, SUBSCRPT_AREA_CODE_NM,
// RCEPT_BGNDE, RCEPT_ENDDE, PRZWNER_PRESNATN_DE ...

import { fetchAnnouncements } from '../utils/apiClient.js'
import { batchUpsert, supabase } from '../utils/supabaseClient.js'
import { logger } from '../utils/logger.js'

// ─────────────────────────────────────────
// 데이터 변환 (실제 API 필드 → DB 컬럼)
// ─────────────────────────────────────────

function transformAnnouncement(raw) {
  return {
    // 식별자 (upsert 기준)
    announcement_no:    raw.HOUSE_MANAGE_NO,

    // 기본 정보
    house_name:         raw.HOUSE_NM || '',
    region_name:        raw.SUBSCRPT_AREA_CODE_NM || '',   // 예: 부산, 서울
    district_name:      null,                               // 상세 주소에서 파싱 필요
    address:            raw.HSSPLY_ADRES || '',

    // 주택 구분
    house_type:         raw.HOUSE_DTL_SECD_NM || '',        // 민영 / 국민
    supply_type:        raw.HOUSE_SECD_NM || '',            // APT / 오피스텔 등

    // 청약 일정 (API가 이미 YYYY-MM-DD 형식으로 줌)
    announcement_date:  raw.RCRIT_PBLANC_DE   || null,     // 모집공고일
    subscription_start: raw.RCEPT_BGNDE       || null,     // 청약 시작 (일반)
    subscription_end:   raw.RCEPT_ENDDE       || null,     // 청약 마감
    winner_date:        raw.PRZWNER_PRESNATN_DE || null,   // 당첨자 발표
    contract_start:     raw.CNTRCT_CNCLS_BGNDE || null,   // 계약 시작

    // 공급 정보
    total_supply:       parseInt(raw.TOT_SUPLY_HSHLDCO || '0'),

    // 상태 자동 계산
    status: calcStatus(
      raw.RCEPT_BGNDE,
      raw.RCEPT_ENDDE,
      raw.PRZWNER_PRESNATN_DE
    ),

    // 메타
    source_url:  raw.PBLANC_URL || null,
    synced_at:   new Date().toISOString(),
  }
}

// ─────────────────────────────────────────
// 상태 계산
// ─────────────────────────────────────────

function calcStatus(startStr, endStr, winnerStr) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const start  = startStr  ? new Date(startStr)  : null
  const end    = endStr    ? new Date(endStr)    : null
  const winner = winnerStr ? new Date(winnerStr) : null

  if (!start || today < start) return 'upcoming'
  if (today >= start && end && today <= end) return 'open'
  if (winner && today <= winner) return 'closed'
  return 'announced'
}

// ─────────────────────────────────────────
// 메인 수집 함수
// ─────────────────────────────────────────

export async function collectAnnouncements() {
  logger.info('=== 청약 공고 수집 시작 ===')

  const rawItems = await fetchAnnouncements()

  if (!rawItems.length) {
    logger.warn('수집된 청약 공고 없음')
    return []
  }

  logger.info(`원본 ${rawItems.length}건 수집`)

  // 변환 + 유효성 검사
  const transformed = rawItems
    .map(transformAnnouncement)
    .filter((item) => item.announcement_no && item.house_name)

  logger.info(`유효 데이터 ${transformed.length}건`)

  // 중복 없이 DB 저장 (upsert)
  await batchUpsert('announcements', transformed, 'announcement_no')

  logger.info('=== 청약 공고 수집 완료 ===')
  return transformed
}

// ─────────────────────────────────────────
// 공고 상태 일괄 업데이트
// ─────────────────────────────────────────

export async function updateAnnouncementStatuses() {
  logger.info('공고 상태 업데이트 시작')

  const { error } = await supabase.rpc('update_announcement_status')

  if (error) {
    // rpc 없으면 JS에서 직접 처리
    logger.warn('RPC 없음 — JS로 직접 상태 업데이트')
    await updateStatusesDirectly()
    return
  }

  logger.info('공고 상태 업데이트 완료')
}

async function updateStatusesDirectly() {
  const today = new Date().toISOString().split('T')[0]

  const updates = [
    {
      status: 'open',
      filter: (q) => q
        .lte('subscription_start', today)
        .gte('subscription_end', today),
    },
    {
      status: 'closed',
      filter: (q) => q
        .lt('subscription_end', today)
        .gte('winner_date', today),
    },
    {
      status: 'announced',
      filter: (q) => q
        .lt('winner_date', today),
    },
  ]

  for (const update of updates) {
    const { error } = await update.filter(
      supabase.from('announcements').update({ status: update.status })
    )
    if (error) logger.warn(`상태 ${update.status} 업데이트 실패`, { error: error.message })
  }

  logger.info('JS 직접 상태 업데이트 완료')
}