// src/controllers/historicalCutoffs.js
// 과거 커트라인(가점 당첨 최저·최고·평균) 수집
//
// 사용 API
//  ① APT_SCORE  : /ApplyhomeInfoCmpetRtSvc/v1/getAptLttotPblancScore
//     → 특정 공고의 주택형별 가점 커트라인 (당첨자 발표 후에만 반환)
//  ② SCORE_WINNER: /ApplyhomeStatSvc/v1/getAPTApsPrzwnerStat
//     → 지역·기간별 역대 가점 통계 (배치 보완용)
//
// 응답 주요 필드 (APT_SCORE 기준, 2026.04.14 확인)
//   HOUSE_MANAGE_NO, HOUSE_TY, RESIDE_SECD,
//   SUPLY_HSHLDCO, PRZWNER_CO, MAX_SCORE, MIN_SCORE, AVG_SCORE

import { fetchCutoffScores } from '../utils/apiClient.js'
import { supabase, batchUpsert } from '../utils/supabaseClient.js'
import { logger } from '../utils/logger.js'

// ─────────────────────────────────────────
// 데이터 변환
// ─────────────────────────────────────────

/**
 * API 원본 → DB 레코드
 * @param {Object} raw          - API 응답 단일 항목
 * @param {string} announcementId - DB UUID (announcements.id)
 */
function transformCutoff(raw, announcementId) {
  // RESIDE_SECD: '1' 거주자 / '2' 기타경기 / '3' 기타지역 / '' 전체
  const resideMap = { '1': '거주자', '2': '기타경기', '3': '기타지역', '': '전체' }

  return {
    announcement_id:  announcementId,
    housing_type:     raw.HOUSE_TY     || '',         // 주택형 (59A, 84B 등)
    reside_type:      resideMap[raw.RESIDE_SECD] ?? (raw.RESIDE_SECD || '전체'),

    // 공급/당첨 세대수
    supply_count:     parseInt(raw.SUPLY_HSHLDCO || '0'),
    winner_count:     parseInt(raw.PRZWNER_CO    || '0'),

    // 가점 커트라인
    min_score:        raw.MIN_SCORE !== undefined ? parseInt(raw.MIN_SCORE) : null,
    max_score:        raw.MAX_SCORE !== undefined ? parseInt(raw.MAX_SCORE) : null,
    avg_score:        raw.AVG_SCORE !== undefined ? parseFloat(raw.AVG_SCORE) : null,

    collected_at:     new Date().toISOString(),
  }
}

// ─────────────────────────────────────────
// 단일 공고 커트라인 수집
// ─────────────────────────────────────────

async function collectCutoffsForOne(announcement) {
  try {
    const raw = await fetchCutoffScores(announcement.announcement_no)

    if (!raw.length) {
      // 당첨자 발표 전이거나 가점제 미해당 공고 — 정상적으로 빈 배열 반환
      logger.debug(`커트라인 없음: ${announcement.house_name}`)
      return []
    }

    return raw
      .map(r => transformCutoff(r, announcement.id))
      .filter(r => r.housing_type)   // 주택형 없는 행 제외
  } catch (err) {
    // API가 아직 공개 안 된 경우 5xx 반환 가능 — warn 처리 후 스킵
    logger.warn(`커트라인 수집 실패: ${announcement.house_name}`, {
      error: err.message,
    })
    return []
  }
}

// ─────────────────────────────────────────
// 메인 수집 함수
// ─────────────────────────────────────────

/**
 * 당첨자 발표가 완료된 공고(status = 'announced')의 커트라인 수집
 *
 * 실행 시점: 매일 04:00 전체 파이프라인 Step 5 (상태 업데이트 이후)
 * - 당첨자 발표 후 2주 이내 공고만 대상 (과도한 중복 수집 방지)
 * - 이미 수집된 공고는 upsert로 갱신
 */
export async function collectHistoricalCutoffs() {
  logger.info('=== 과거 커트라인 수집 시작 ===')

  // 당첨자 발표 완료 공고 중 최근 60일 이내만 대상
  // (오래된 공고는 이미 수집 완료 또는 API에서 제거됨)
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - 60)
  const cutoffDateStr = cutoffDate.toISOString().split('T')[0]

  const { data: announcements, error } = await supabase
    .from('announcements')
    .select('id, announcement_no, house_name, winner_date')
    .eq('status', 'announced')
    .gte('winner_date', cutoffDateStr)   // 최근 60일 이내 당첨 발표
    .order('winner_date', { ascending: false })
    .limit(30)   // API 과호출 방지

  if (error) {
    logger.error('발표 완료 공고 조회 실패', { error: error.message })
    throw error
  }

  if (!announcements?.length) {
    logger.info('최근 발표 완료 공고 없음 — 커트라인 수집 스킵')
    return
  }

  logger.info(`발표 완료 공고 ${announcements.length}건 커트라인 수집`)

  const allCutoffs = []

  for (const ann of announcements) {
    const cutoffs = await collectCutoffsForOne(ann)
    allCutoffs.push(...cutoffs)
    if (cutoffs.length > 0) {
      logger.info(`  ${ann.house_name}: ${cutoffs.length}건 (당첨일 ${ann.winner_date})`)
    }
  }

  if (allCutoffs.length) {
    // (announcement_id, housing_type, reside_type) 조합으로 upsert
    // → 스키마에 unique(announcement_id, housing_type, reside_type) 제약 필요
    await batchUpsert('announcement_cutoffs', allCutoffs, 'announcement_id,housing_type,reside_type')
  }

  logger.info(`=== 과거 커트라인 수집 완료: ${allCutoffs.length}건 ===`)
}
