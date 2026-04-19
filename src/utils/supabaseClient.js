// src/utils/supabaseClient.js
// Supabase 클라이언트 싱글톤

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'
import { logger } from './logger.js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  logger.error('Supabase 환경변수 누락. .env 파일을 확인해주세요.')
  process.exit(1)
}

// Service Key 사용 = RLS 우회 가능 (파이프라인 서버에서만 사용)
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
})

// ─────────────────────────────────────────
// 공통 DB 헬퍼
// ─────────────────────────────────────────

/**
 * Upsert (삽입 or 업데이트) - 중복 실행 안전
 * @param {string} table - 테이블명
 * @param {Object|Array} data - 삽입할 데이터
 * @param {string} conflictColumn - 충돌 기준 컬럼
 */
export async function upsert(table, data, conflictColumn = 'id') {
  const { error } = await supabase
    .from(table)
    .upsert(data, { onConflict: conflictColumn, ignoreDuplicates: false })

  if (error) {
    logger.error(`DB upsert 실패: ${table}`, { error: error.message })
    throw error
  }
}

/**
 * 배치 upsert - 대용량 데이터를 청크 단위로 처리
 * @param {string} table - 테이블명
 * @param {Array} items - 전체 데이터 배열
 * @param {string} conflictColumn - 충돌 기준 컬럼
 * @param {number} chunkSize - 한 번에 처리할 수
 */
export async function batchUpsert(
  table,
  items,
  conflictColumn = 'announcement_no',
  chunkSize = 50
) {
  if (!items.length) return

  let successCount = 0

  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize)
    await upsert(table, chunk, conflictColumn)
    successCount += chunk.length
    logger.debug(`  배치 저장: ${successCount}/${items.length}`)
  }

  logger.info(`DB 저장 완료: ${table} ${successCount}건`)
}