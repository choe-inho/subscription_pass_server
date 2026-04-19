// src/collectors/competitionRates.js
// 청약 경쟁률 수집
//
// 기술문서 확인 (2024.12.03 기준)
// API: ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet
// 파라미터: cond[HOUSE_MANAGE_NO::EQ], cond[PBLANC_NO::EQ] (모두 옵션)
// 응답: CMPET_RATE, REQ_CNT, HOUSE_TY, RESIDE_SECD, SUPLY_HSHLDCO 등

import { fetchCompetitionRate } from '../utils/apiClient.js'
import { supabase, batchUpsert } from '../utils/supabaseClient.js'
import { logger } from '../utils/logger.js'

// ─────────────────────────────────────────
// 데이터 변환
// ─────────────────────────────────────────

function transformCompetitionRate(raw, announcementId) {
  return {
    announcement_id:  announcementId,
    housing_type_id:  null,          // 추후 housing_types와 매핑

    // 경쟁률 (문서 기준 필드명)
    general_rate:     parseFloat(raw.CMPET_RATE || '0'),
    special_rate:     0,             // 특별공급 경쟁률은 별도 API (getAPTSpsplyReqstStus)
    applicant_count:  parseInt(raw.REQ_CNT || '0'),

    recorded_at:      new Date().toISOString(),
  }
}

// ─────────────────────────────────────────
// 단일 공고 경쟁률 수집
// ─────────────────────────────────────────

async function collectRatesForOne(announcement) {
  try {
    const rates = await fetchCompetitionRate(announcement.announcement_no)

    if (!rates.length) {
      logger.debug(`경쟁률 없음: ${announcement.house_name}`)
      return []
    }

    return rates.map(r => transformCompetitionRate(r, announcement.id))
  } catch (err) {
    logger.warn(`경쟁률 수집 실패: ${announcement.house_name}`, {
      error: err.message
    })
    return []
  }
}

// ─────────────────────────────────────────
// 메인 수집 함수 — 접수 중인 공고만 대상
// ─────────────────────────────────────────

export async function collectCompetitionRates() {
  logger.info('=== 경쟁률 수집 시작 ===')

  // 현재 접수 중인 공고만 조회 (경쟁률은 접수 기간 중에만 의미있음)
  const { data: openAnnouncements, error } = await supabase
    .from('announcements')
    .select('id, announcement_no, house_name')
    .eq('status', 'open')

  if (error) {
    logger.error('접수 중 공고 조회 실패', { error: error.message })
    throw error
  }

  if (!openAnnouncements?.length) {
    logger.info('현재 접수 중인 공고 없음 — 경쟁률 수집 스킵')
    return
  }

  logger.info(`접수 중 공고 ${openAnnouncements.length}건 경쟁률 수집`)

  const allRates = []

  for (const ann of openAnnouncements) {
    const rates = await collectRatesForOne(ann)
    allRates.push(...rates)
    if (rates.length > 0) {
      logger.info(`  ${ann.house_name}: ${rates.length}건`)
    }
  }

  if (allRates.length) {
    await batchUpsert('competition_rates', allRates, 'id')
  }

  logger.info(`=== 경쟁률 수집 완료: ${allRates.length}건 ===`)
}