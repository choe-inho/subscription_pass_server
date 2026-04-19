// src/collectors/housingTypes.js
// 주택형별 상세 정보 수집 (평형, 분양가 등)

import { fetchHousingTypes } from '../utils/apiClient.js'
import { supabase, batchUpsert } from '../utils/supabaseClient.js'
import { logger } from '../utils/logger.js'

// ─────────────────────────────────────────
// 데이터 변환
// ─────────────────────────────────────────

function transformHousingType(raw, announcementId) {
  return {
    announcement_id:      announcementId,
    type_name:            raw.HOUSE_TY || raw.houseTy || '',           // 주택형 (59A, 84B 등)
    exclusive_area:       parseFloat(raw.EXCLUSE_AR || raw.excluseAr || '0'),    // 전용면적
    supply_area:          parseFloat(raw.SUPLY_AR || raw.suplyAr || '0'),        // 공급면적

    supply_count:         parseInt(raw.SUPLY_HSHLDCO || raw.suplyHshldco || '0'),        // 일반공급
    special_supply_count: parseInt(raw.SPSPLY_HSHLDCO || raw.spsplyHshldco || '0'),     // 특별공급

    // 분양가 (만원 단위)
    sale_price_min:       parsePriceToManWon(raw.LTTOT_TOP_AMOUNT || raw.lttotTopAmount),
    sale_price_max:       parsePriceToManWon(raw.LTTOT_TOP_AMOUNT || raw.lttotTopAmount),
    sale_price_avg:       parsePriceToManWon(raw.LTTOT_TOP_AMOUNT || raw.lttotTopAmount),
  }
}

// 분양가 파싱: 원 단위 → 만원 단위
function parsePriceToManWon(raw) {
  if (!raw) return null
  const won = parseInt(String(raw).replace(/,/g, ''))
  if (isNaN(won)) return null
  return Math.round(won / 10000)
}

// ─────────────────────────────────────────
// 메인 수집 함수
// ─────────────────────────────────────────

/**
 * 특정 공고의 주택형별 정보 수집
 * @param {string} announcementNo - 주택관리번호
 * @param {string} announcementId - DB UUID
 */
async function collectHousingTypesForOne(announcementNo, announcementId) {
  try {
    // fetchHousingTypes는 data 배열 직접 반환
    const types = await fetchHousingTypes(announcementNo)
    if (!types.length) return []

    return types
      .map((t) => transformHousingType(t, announcementId))
      .filter((t) => t.type_name)
  } catch (err) {
    logger.warn(`주택형 수집 실패: ${announcementNo}`, { error: err.message })
    return []
  }
}

/**
 * 최근 수집된 공고들의 주택형 정보 전체 수집
 * - 최근 7일 이내 synced_at 기준 대상 선정
 */
export async function collectHousingTypes() {
  logger.info('=== 주택형 정보 수집 시작 ===')

  // 주택형 정보가 없는 공고 대상 조회
  const { data: announcements, error } = await supabase
    .from('announcements')
    .select('id, announcement_no')
    .in('status', ['upcoming', 'open'])
    .order('subscription_start', { ascending: true })
    .limit(50)   // 한 번에 최대 50개 처리 (API 과호출 방지)

  if (error) {
    logger.error('공고 조회 실패', { error: error.message })
    throw error
  }

  if (!announcements.length) {
    logger.info('처리할 공고가 없습니다')
    return
  }

  logger.info(`${announcements.length}개 공고의 주택형 정보 수집 중...`)

  const allHousingTypes = []

  for (const ann of announcements) {
    const types = await collectHousingTypesForOne(ann.announcement_no, ann.id)
    allHousingTypes.push(...types)
  }

  if (allHousingTypes.length) {
    // [수정 v1.2] 배치 내부 중복 제거
    // 공공데이터 API가 동일 (announcement_id, type_name) 조합을 2회 이상 반환하면
    // Postgres가 "ON CONFLICT DO UPDATE command cannot affect row a second time"
    // 에러를 던짐. 따라서 upsert 직전에 키 기준으로 dedupe(뒤에 오는 값 우선).
    const dedupedMap = new Map()
    for (const row of allHousingTypes) {
      const key = `${row.announcement_id}|${row.type_name}`
      dedupedMap.set(key, row)
    }
    const deduped = Array.from(dedupedMap.values())

    const dupCount = allHousingTypes.length - deduped.length
    if (dupCount > 0) {
      logger.warn(`배치 내 중복 ${dupCount}건 제거 (${allHousingTypes.length} → ${deduped.length})`)
    }

    // conflict 기준: (announcement_id, type_name) — 스키마 unique 제약 전제
    await batchUpsert('housing_types', deduped, 'announcement_id,type_name')

    logger.info(`=== 주택형 정보 수집 완료: ${deduped.length}건 ===`)
  } else {
    logger.info('=== 주택형 정보 수집 완료: 0건 ===')
  }
}