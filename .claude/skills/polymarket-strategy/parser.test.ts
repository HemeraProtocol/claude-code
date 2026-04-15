import { describe, expect, test } from 'bun:test'

import { parseMoneyLabel, parseQuestion } from './parser'

describe('parseMoneyLabel', () => {
  test('parses shorthand suffixes', () => {
    expect(parseMoneyLabel('$60k')).toBe(60_000)
    expect(parseMoneyLabel('$1.5M')).toBe(1_500_000)
  })
})

describe('parseQuestion', () => {
  test('parses directional markets', () => {
    expect(parseQuestion('Bitcoin Up or Down on April 15?')).toEqual({
      questionType: 'directional',
      strike: null,
      strike2: null,
      parser: 'rules',
      confidence: 1,
    })
  })

  test('parses above/below markets', () => {
    expect(parseQuestion('Will the price of Bitcoin be above $62,000 on April 15?').questionType).toBe('above')
    expect(parseQuestion('Will the price of Ethereum be less than $1,800 on April 15?').questionType).toBe('below')
  })

  test('parses range markets', () => {
    expect(parseQuestion('Will the price of Ethereum be between $2,300 and $2,400 on April 15?')).toEqual({
      questionType: 'range',
      strike: 2_300,
      strike2: 2_400,
      parser: 'rules',
      confidence: 1,
    })
  })

  test('parses hit markets', () => {
    expect(parseQuestion('Will Bitcoin reach $80,000 in April?').questionType).toBe('hit')
    expect(parseQuestion('Will Bitcoin dip to $60,000 in April?').questionType).toBe('hit')
  })

  test('parses first-hit markets', () => {
    expect(parseQuestion('Will Bitcoin hit $60k or $80k first?')).toEqual({
      questionType: 'firstHit',
      strike: 60_000,
      strike2: 80_000,
      parser: 'rules',
      confidence: 1,
    })
  })

  test('marks unsupported wording as unknown', () => {
    expect(parseQuestion('Will Bitcoin close in the green this week?').questionType).toBe('unknown')
  })
})
