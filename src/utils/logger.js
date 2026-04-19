// src/utils/logger.js
// 간단한 로거 - 나중에 winston으로 교체 가능

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 }
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info']

function format(level, message, data) {
  const timestamp = new Date().toISOString()
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`
  if (data) {
    return `${prefix} ${message} ${JSON.stringify(data, null, 2)}`
  }
  return `${prefix} ${message}`
}

export const logger = {
  error: (msg, data) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.error)
      console.error(format('error', msg, data))
  },
  warn: (msg, data) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.warn)
      console.warn(format('warn', msg, data))
  },
  info: (msg, data) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.info)
      console.log(format('info', msg, data))
  },
  debug: (msg, data) => {
    if (CURRENT_LEVEL >= LOG_LEVELS.debug)
      console.log(format('debug', msg, data))
  },
}