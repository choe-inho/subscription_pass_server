// src/pipeline.js
// 메인 파이프라인 — 순서대로 수집 실행

import 'dotenv/config'
import { logger } from './utils/logger.js'
import { collectAnnouncements, updateAnnouncementStatuses } from './controllers/announcements.js'
import { collectHousingTypes } from './controllers/housingTypes.js'
import { collectCompetitionRates } from './controllers/competitionRates.js'
import { collectHistoricalCutoffs } from './controllers/historicalCutoffs.js'
import {
  notifySubscriptionTomorrow,
  notifySubscriptionToday,
  notifyWinnerAnnouncement,
  notifyHotCompetition,
} from './notifier.js'

// ─────────────────────────────────────────
// 파이프라인 실행
// ─────────────────────────────────────────

/**
 * 전체 파이프라인 (매일 새벽 실행)
 * 실행 순서가 중요:
 * 1. 공고 수집 (부모)
 * 2. 주택형 수집 (공고에 의존)
 * 3. 경쟁률 수집 (공고에 의존, open 상태만)
 * 4. 상태 업데이트
 * 5. 과거 커트라인 수집 (상태 업데이트 이후 announced 공고 대상)
 * 6. 유저 알림 발송
 */
export async function runFullPipeline() {
  const startTime = Date.now()
  logger.info('========================================')
  logger.info('🏠 청약 데이터 파이프라인 시작')
  logger.info('========================================')

  const results = {
    announcements:      false,
    housingTypes:       false,
    competition:        false,
    statusUpdate:       false,
    historicalCutoffs:  false,
    notifications:      false,
    errors:             [],
  }

  // Step 1: 청약 공고 수집
  try {
    await collectAnnouncements()
    results.announcements = true
  } catch (err) {
    logger.error('공고 수집 실패', { error: err.message })
    results.errors.push(`공고 수집: ${err.message}`)
    // 공고 수집 실패 시 하위 단계 스킵
    return finalize(results, startTime)
  }

  // Step 2: 주택형 정보 수집
  try {
    await collectHousingTypes()
    results.housingTypes = true
  } catch (err) {
    logger.error('주택형 수집 실패', { error: err.message })
    results.errors.push(`주택형 수집: ${err.message}`)
    // 실패해도 계속 진행
  }

  // Step 3: 경쟁률 수집 (접수 중인 공고만)
  try {
    await collectCompetitionRates()
    results.competition = true
  } catch (err) {
    logger.error('경쟁률 수집 실패', { error: err.message })
    results.errors.push(`경쟁률 수집: ${err.message}`)
  }

  // Step 4: 공고 상태 업데이트
  // 커트라인 수집 전에 반드시 실행 (announced 상태 확정 후 조회)
  try {
    await updateAnnouncementStatuses()
    results.statusUpdate = true
  } catch (err) {
    logger.error('상태 업데이트 실패', { error: err.message })
    results.errors.push(`상태 업데이트: ${err.message}`)
  }

  // Step 5: 과거 커트라인 수집 (당첨 발표 완료 공고 대상)
  // - API가 당첨자 발표 전 조회 시 빈 배열 또는 5xx 반환하므로
  //   반드시 상태 업데이트(Step 4) 이후에 실행
  try {
    await collectHistoricalCutoffs()
    results.historicalCutoffs = true
  } catch (err) {
    logger.error('과거 커트라인 수집 실패', { error: err.message })
    results.errors.push(`커트라인 수집: ${err.message}`)
  }

  // Step 6: 유저 알림 발송
  // 수집/상태 업데이트 완료 후 마지막에 실행
  try {
    logger.info('=== 유저 알림 발송 시작 ===')
    await Promise.allSettled([
      notifySubscriptionTomorrow(),  // D-1 알림 (유료)
      notifySubscriptionToday(),     // D-0 마감 알림 (무료)
      notifyWinnerAnnouncement(),    // 당첨 발표 알림 (무료)
    ])
    results.notifications = true
    logger.info('=== 유저 알림 발송 완료 ===')
  } catch (err) {
    logger.error('알림 발송 실패', { error: err.message })
    results.errors.push(`알림 발송: ${err.message}`)
  }

  return finalize(results, startTime)
}

/**
 * 경쟁률만 빠르게 수집 (청약 기간 중 1시간마다)
 */
export async function runCompetitionOnly() {
  logger.info('⚡ 경쟁률 빠른 수집 시작')
  try {
    await collectCompetitionRates()
    await notifyHotCompetition()   // 급등 시 유료 유저 알림
    logger.info('⚡ 경쟁률 빠른 수집 완료')
  } catch (err) {
    logger.error('경쟁률 빠른 수집 실패', { error: err.message })
  }
}

function finalize(results, startTime) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  logger.info('========================================')
  logger.info(`✅ 파이프라인 종료 (${elapsed}초)`)
  logger.info('결과:', {
    공고수집:      results.announcements     ? '성공' : '실패',
    주택형수집:    results.housingTypes      ? '성공' : '실패',
    경쟁률수집:    results.competition       ? '성공' : '실패',
    상태업데이트:  results.statusUpdate      ? '성공' : '실패',
    커트라인수집:  results.historicalCutoffs ? '성공' : '실패',
    알림발송:      results.notifications     ? '성공' : '실패',
  })

  if (results.errors.length) {
    logger.warn('에러 목록:', results.errors)
  }
  logger.info('========================================')

  return results
}

// ─────────────────────────────────────────
// 직접 실행 시
//   · node src/pipeline.js            → 전체 파이프라인 (full)
//   · node src/pipeline.js competition → 경쟁률만 (hourly용)
// ─────────────────────────────────────────
if (process.argv[1].includes('pipeline')) {
  const mode = (process.argv[2] || 'full').toLowerCase()
  const runner =
    mode === 'competition' ? runCompetitionOnly : runFullPipeline

  logger.info(`[ENTRY] pipeline.js 실행 모드: ${mode}`)

  runner()
    .then((results) => {
      const hasErrors = Array.isArray(results?.errors) && results.errors.length > 0
      process.exit(hasErrors ? 1 : 0)
    })
    .catch((err) => {
      logger.error('예상치 못한 오류', { error: err.message })
      process.exit(1)
    })
}