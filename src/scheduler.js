// src/scheduler.js
// Cron 스케줄러 + 웹훅 서버 동시 기동

import cron from 'node-cron'
import 'dotenv/config'
import { logger } from './utils/logger.js'
import { runFullPipeline, runCompetitionOnly } from './pipeline.js'
import { app as webhookApp } from './server.js'

logger.info('🕐 스케줄러 시작')

// ─────────────────────────────────────────
// 웹훅 서버 기동 (RevenueCat 이벤트 수신)
// ─────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10)
webhookApp.listen(PORT, () => {
  logger.info(`🌐 웹훅 서버 기동 완료 — http://0.0.0.0:${PORT}`)
})

// ─────────────────────────────────────────
// 스케줄 설정
// ─────────────────────────────────────────

/**
 * [매일 새벽 4시] 전체 파이프라인
 * - 청약 공고 신규 수집
 * - 주택형 정보 업데이트
 * - 공고 상태 갱신
 * cron 표현식: '0 4 * * *'
 */
cron.schedule('0 4 * * *', async () => {
  logger.info('[CRON] 매일 전체 수집 시작')
  await runFullPipeline()
}, {
  timezone: 'Asia/Seoul'
})

/**
 * [매시간 정각] 경쟁률 수집
 * - 청약 접수 기간 중에만 의미 있음
 * - 접수 중인 공고 없으면 자동 스킵
 * cron 표현식: '0 * * * *'
 */
cron.schedule('0 * * * *', async () => {
  logger.info('[CRON] 경쟁률 수집 시작')
  await runCompetitionOnly()
}, {
  timezone: 'Asia/Seoul'
})

/**
 * [매일 자정] 상태 업데이트만
 * - 날짜 바뀌면서 상태 변경되는 공고 처리
 * - 새벽 4시 전체 수집과 중복이지만 자정에도 빠르게 처리
 */
// 필요시 활성화
// cron.schedule('0 0 * * *', async () => {
//   await updateAnnouncementStatuses()
// }, { timezone: 'Asia/Seoul' })

// ─────────────────────────────────────────
// 시작 시 즉시 1회 실행 (옵션)
// ─────────────────────────────────────────

const RUN_ON_START = process.env.RUN_ON_START === 'true'

if (RUN_ON_START) {
  logger.info('시작 시 즉시 전체 파이프라인 실행')
  runFullPipeline().catch((err) => {
    logger.error('초기 실행 실패', { error: err.message })
  })
}

logger.info('스케줄 등록 완료')
logger.info('  - 매일 04:00 (KST): 전체 수집')
logger.info('  - 매시간 00분 (KST): 경쟁률 수집')
logger.info('프로세스 대기 중...')

// 프로세스 종료 방지
process.on('SIGTERM', () => {
  logger.info('SIGTERM 수신 — 스케줄러 종료')
  process.exit(0)
})

process.on('SIGINT', () => {
  logger.info('SIGINT 수신 — 스케줄러 종료')
  process.exit(0)
})