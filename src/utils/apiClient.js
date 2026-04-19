// src/utils/apiClient.js
// 한국부동산원 청약홈 공공 API 클라이언트
//
// 확인된 정보 (2026.04.05)
// Base URL: https://api.odcloud.kr/api
// 응답 형식: JSON
// 응답 구조: { currentCount, data: [...], totalCount, page, perPage }

import axios from 'axios'
import 'dotenv/config'
import { logger } from './logger.js'

// ─────────────────────────────────────────
// 환경변수
// ─────────────────────────────────────────

const BASE_URL  = 'https://api.odcloud.kr/api'
const DELAY_MS  = parseInt(process.env.REQUEST_DELAY_MS || '500')

// API마다 키가 다를 수 있음 — .env에서 각각 관리
const KEYS = {
  DETAIL:   process.env.PUBLIC_DATA_API_KEY,           // 분양정보 조회 서비스
  CMPET:    process.env.PUBLIC_DATA_API_KEY_CMPET   || process.env.PUBLIC_DATA_API_KEY,
  STAT:     process.env.PUBLIC_DATA_API_KEY_STAT    || process.env.PUBLIC_DATA_API_KEY,
}

if (!KEYS.DETAIL) {
  logger.error('.env에 PUBLIC_DATA_API_KEY 없음')
  process.exit(1)
}

// ─────────────────────────────────────────
// 엔드포인트 (Swagger 확인값)
// ─────────────────────────────────────────

export const ENDPOINTS = {
  // 분양정보 조회 서비스 (ApplyhomeInfoDetailSvc) - KEY: DETAIL
  APT_DETAIL:      '/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancDetail',
  APT_TYPE_DETAIL: '/ApplyhomeInfoDetailSvc/v1/getAPTLttotPblancMdl',

  // 분양정보+경쟁률 서비스 (ApplyhomeInfoCmpetRtSvc) - KEY: CMPET
  APT_LIST:        '/ApplyhomeInfoCmpetRtSvc/v1/getAPTLttotPblancCmpet',
  APT_SCORE:       '/ApplyhomeInfoCmpetRtSvc/v1/getAptLttotPblancScore',
  SPL_STATUS:      '/ApplyhomeInfoCmpetRtSvc/v1/getAPTSpsplyReqstStus',

  // 통계 서비스 (ApplyhomeStatSvc) - KEY: STAT
  WINNER_AREA:     '/ApplyhomeStatSvc/v1/getAPTPrzwnerAreaStat',
  SCORE_WINNER:    '/ApplyhomeStatSvc/v1/getAPTApsPrzwnerStat',
}

// 엔드포인트별 사용할 키 매핑
const ENDPOINT_KEY_MAP = {
  '/ApplyhomeInfoDetailSvc':  KEYS.DETAIL,
  '/ApplyhomeInfoCmpetRtSvc': KEYS.CMPET,
  '/ApplyhomeStatSvc':        KEYS.STAT,
}

function getKeyForEndpoint(endpoint) {
  for (const [prefix, key] of Object.entries(ENDPOINT_KEY_MAP)) {
    if (endpoint.startsWith(prefix)) return key
  }
  return KEYS.DETAIL
}

// ─────────────────────────────────────────
// axios 인스턴스
// ─────────────────────────────────────────

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  // 401, 500도 throw 없이 응답 받기 (에러 핸들링 직접)
  validateStatus: (status) => status < 600,
})

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ─────────────────────────────────────────
// 핵심 호출 함수
// ─────────────────────────────────────────

async function fetchAPI(endpoint, params = {}) {
  const serviceKey = getKeyForEndpoint(endpoint)

  // serviceKey: encodeURIComponent로 특수문자(+, /, =) 인코딩
  // Authorization: Infuser 헤더도 함께 전송 (odcloud 인증 방식)
  const encodedKey = encodeURIComponent(serviceKey)
  const url = `${BASE_URL}${endpoint}?serviceKey=${encodedKey}`

  logger.debug(`API 호출: ${endpoint}`)

  const response = await client.get(url, {
    headers: {
      Authorization: `Infuser ${serviceKey}`,
    },
    params: {
      page: params.pageNo || 1,
      perPage: params.numOfRows || 100,
      ...params,
      pageNo: undefined,
      numOfRows: undefined,
    },
  })

  await delay(DELAY_MS)

  // 에러 응답 처리
  if (response.status === 401) {
    throw new Error(`401 인증 실패: ${JSON.stringify(response.data)}`)
  }
  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(response.data)}`)
  }

  return response.data
}

// ─────────────────────────────────────────
// 페이지네이션
// ─────────────────────────────────────────

async function fetchAllPages(endpoint, params = {}) {
  const perPage  = parseInt(process.env.COLLECT_PAGE_SIZE || '100')
  const maxPages = parseInt(process.env.MAX_PAGES || '10')
  const allItems = []
  let page = 1

  while (page <= maxPages) {
    logger.info(`${endpoint} ${page}페이지 수집 중...`)

    let body
    try {
      body = await fetchAPI(endpoint, { ...params, pageNo: page, numOfRows: perPage })
    } catch (err) {
      logger.error(`${page}페이지 실패`, { error: err.message })
      break
    }

    // odcloud JSON 응답 구조: { data: [...], totalCount, currentCount }
    const items      = body?.data || []
    const totalCount = body?.totalCount || 0

    if (!items.length) {
      logger.info('  → 데이터 없음')
      break
    }

    allItems.push(...items)
    logger.info(`  → ${items.length}건 (누적 ${allItems.length}/${totalCount})`)

    if (allItems.length >= totalCount) break
    page++
  }

  return allItems
}

// ─────────────────────────────────────────
// 공개 API 함수
// ─────────────────────────────────────────

/**
 * APT 분양정보 상세 목록
 * (현재 200 정상 작동 확인)
 */
export async function fetchAnnouncements(params = {}) {
  const today = new Date()
  const sixMonthsLater = new Date(today)
  sixMonthsLater.setMonth(today.getMonth() + 6)
  const threeMonthsAgo = new Date(today)
  threeMonthsAgo.setMonth(today.getMonth() - 3)

  return fetchAllPages(ENDPOINTS.APT_DETAIL, {
    startSubscrptDate: formatDate(threeMonthsAgo),
    endSubscrptDate:   formatDate(sixMonthsLater),
    ...params,
  })
}

/**
 * APT 주택형별 상세
 */
export async function fetchHousingTypes(houseManageNo) {
  const body = await fetchAPI(ENDPOINTS.APT_TYPE_DETAIL, { houseManageNo })
  return body?.data || []
}

/**
 * APT 분양정보 + 경쟁률
 * (별도 키 필요 시 .env PUBLIC_DATA_API_KEY_CMPET 설정)
 */
export async function fetchAnnouncementsWithRate(params = {}) {
  const today = new Date()
  const sixMonthsLater = new Date(today)
  sixMonthsLater.setMonth(today.getMonth() + 6)
  const threeMonthsAgo = new Date(today)
  threeMonthsAgo.setMonth(today.getMonth() - 3)

  return fetchAllPages(ENDPOINTS.APT_LIST, {
    startSubscrptDate: formatDate(threeMonthsAgo),
    endSubscrptDate:   formatDate(sixMonthsLater),
    ...params,
  })
}

/**
 * 지역별 당첨자 통계 (ApplyhomeStatSvc — 과거 커트라인 통계용)
 * 날짜 범위로 조회: startRceptDate, endRceptDate (YYYY-MM-DD)
 */
export async function fetchWinnerStats(params = {}) {
  return fetchAllPages(ENDPOINTS.WINNER_AREA, params)
}

/**
 * 공고별 가점 당첨 커트라인 (APT_SCORE)
 * - 당첨자 발표 이후에만 데이터 존재
 * - 응답 예시 필드: HOUSE_MANAGE_NO, HOUSE_TY, RESIDE_SECD,
 *   SUPLY_HSHLDCO, PRZWNER_CO, MAX_SCORE, MIN_SCORE, AVG_SCORE
 * @param {string} houseManageNo - 주택관리번호
 */
export async function fetchCutoffScores(houseManageNo) {
  const body = await fetchAPI(ENDPOINTS.APT_SCORE, {
    'cond[HOUSE_MANAGE_NO::EQ]': houseManageNo,
  })
  return body?.data || []
}

/**
 * 가점 당첨자 통계 (SCORE_WINNER — 지역/기간별 역대 커트라인)
 * @param {Object} params - startRceptDate, endRceptDate 등
 */
export async function fetchScoreWinnerStats(params = {}) {
  return fetchAllPages(ENDPOINTS.SCORE_WINNER, params)
}

function formatDate(date) {
  return date.toISOString().split('T')[0]  // YYYY-MM-DD (odcloud 형식)
}

// ─────────────────────────────────────────
// 테스트 (npm run test:api)
// ─────────────────────────────────────────

if (process.argv[1]?.includes('apiClient')) {
  logger.info('=== API 클라이언트 테스트 ===')
  logger.info(`DETAIL 키: ${KEYS.DETAIL?.substring(0, 10)}...`)
  logger.info(`CMPET 키:  ${KEYS.CMPET?.substring(0, 10)}...`)

  logger.info('\n[1] 분양정보 상세 목록')
  try {
    const items = await fetchAnnouncements()
    logger.info(`✅ ${items.length}건 수집`)
    if (items.length > 0) {
      logger.info('필드 목록: ' + Object.keys(items[0]).join(', '))
      console.log('\n샘플:', JSON.stringify(items[0], null, 2))
    }
  } catch (err) {
    logger.error('❌ 실패:', err.message)
  }

  logger.info('\n[2] 분양정보+경쟁률 목록 (별도 키 필요할 수 있음)')
  try {
    const items = await fetchAnnouncementsWithRate()
    logger.info(`✅ ${items.length}건 수집`)
  } catch (err) {
    logger.error('❌ 실패:', err.message)
  }
}

// ─────────────────────────────────────────
// 경쟁률 단건 조회 (공고번호로 조회)
// cond[HOUSE_MANAGE_NO::EQ] 파라미터 방식
// ─────────────────────────────────────────

export async function fetchCompetitionRate(houseManageNo) {
  // 경쟁률 API는 날짜 범위 아닌 공고번호로 단건 조회
  const body = await fetchAPI(ENDPOINTS.APT_LIST, {
    'cond[HOUSE_MANAGE_NO::EQ]': houseManageNo,
  })
  return body?.data || []
}