export type { QuestionType, QuestionParser, ParsedQuestion } from './types'
import type { QuestionType, QuestionParser, ParsedQuestion } from './types'

const MONEY_CAPTURE = '([0-9][0-9,]*(?:\\.[0-9]+)?)([kmbt]?)'

function moneyRegex(flags = 'i'): RegExp {
  return new RegExp(`\\$${MONEY_CAPTURE}`, flags)
}

export function parseMoneyValue(value: string, suffix: string = ''): number {
  const base = Number(value.replace(/,/g, ''))
  if (!Number.isFinite(base)) return Number.NaN

  switch (suffix.toLowerCase()) {
    case 'k':
      return base * 1_000
    case 'm':
      return base * 1_000_000
    case 'b':
      return base * 1_000_000_000
    case 't':
      return base * 1_000_000_000_000
    default:
      return base
  }
}

export function parseMoneyLabel(text: string): number | null {
  const match = text.match(new RegExp(`\\$?${MONEY_CAPTURE}`, 'i'))
  if (!match) return null
  const value = parseMoneyValue(match[1]!, match[2]!)
  return Number.isFinite(value) ? value : null
}

function parseFirstMoney(question: string): number | null {
  const match = question.match(moneyRegex())
  if (!match) return null
  const value = parseMoneyValue(match[1]!, match[2]!)
  return Number.isFinite(value) ? value : null
}

export function parseQuestionByRules(question: string): ParsedQuestion {
  // 1. Directional: "Up or Down"
  if (/up or down/i.test(question)) {
    return {
      questionType: 'directional',
      strike: null,
      strike2: null,
      parser: 'rules',
      confidence: 1,
    }
  }

  // 2. Count range: "post 80-99 tweets" or "post 580+ tweets"
  const countRangeMatch = question.match(/\bpost\s+(\d+)\s*[-–]\s*(\d+)\s+(?:tweets|posts)\b/i)
  if (countRangeMatch) {
    const lo = Number(countRangeMatch[1])
    const hi = Number(countRangeMatch[2])
    return {
      questionType: 'count',
      strike: Math.min(lo, hi),
      strike2: Math.max(lo, hi),
      parser: 'rules',
      confidence: 1,
    }
  }
  const countAboveMatch = question.match(/\bpost\s+(\d+)\+\s+(?:tweets|posts)\b/i)
  if (countAboveMatch) {
    return {
      questionType: 'count',
      strike: Number(countAboveMatch[1]),
      strike2: null,
      parser: 'rules',
      confidence: 1,
    }
  }

  // 3. First-hit race: "hit $60k or $80k first"
  const firstHitMatch = question.match(
    new RegExp(`\\bhit\\s+\\$${MONEY_CAPTURE}\\s+or\\s+\\$${MONEY_CAPTURE}\\s+first\\b`, 'i'),
  )
  if (firstHitMatch) {
    const a = parseMoneyValue(firstHitMatch[1]!, firstHitMatch[2]!)
    const b = parseMoneyValue(firstHitMatch[3]!, firstHitMatch[4]!)
    return {
      questionType: 'firstHit',
      strike: Math.min(a, b),
      strike2: Math.max(a, b),
      parser: 'rules',
      confidence: 1,
    }
  }

  // 4. Range: "between $X and $Y"
  const rangeMatch = question.match(
    new RegExp(`between\\s+\\$${MONEY_CAPTURE}\\s+and\\s+\\$${MONEY_CAPTURE}`, 'i'),
  )
  if (rangeMatch) {
    const a = parseMoneyValue(rangeMatch[1]!, rangeMatch[2]!)
    const b = parseMoneyValue(rangeMatch[3]!, rangeMatch[4]!)
    return {
      questionType: 'range',
      strike: Math.min(a, b),
      strike2: Math.max(a, b),
      parser: 'rules',
      confidence: 1,
    }
  }

  // 5. Hit downward: "dip to", "drop to", "fall to"
  if (/\b(?:dip|drop|fall)\s+to\b/i.test(question)) {
    return {
      questionType: 'hit',
      strike: parseFirstMoney(question),
      strike2: null,
      parser: 'rules',
      confidence: 1,
    }
  }

  // 6. Hit upward: "reach $X" or "hit $X"
  if (/\breach\b/i.test(question) || (/\bhit\b/i.test(question) && moneyRegex().test(question))) {
    return {
      questionType: 'hit',
      strike: parseFirstMoney(question),
      strike2: null,
      parser: 'rules',
      confidence: 1,
    }
  }

  // 7. Below: "below", "less than", "under"
  if (/\b(?:below|less than|under)\b/i.test(question)) {
    return {
      questionType: 'below',
      strike: parseFirstMoney(question),
      strike2: null,
      parser: 'rules',
      confidence: 1,
    }
  }

  // 8. Above: "above", "over", "greater than"
  if (/\b(?:above|over|greater than)\b/i.test(question)) {
    return {
      questionType: 'above',
      strike: parseFirstMoney(question),
      strike2: null,
      parser: 'rules',
      confidence: 1,
    }
  }

  return {
    questionType: 'unknown',
    strike: parseFirstMoney(question),
    strike2: null,
    parser: 'rules',
    confidence: 0,
  }
}

export function parseQuestion(question: string): ParsedQuestion {
  return parseQuestionByRules(question)
}
