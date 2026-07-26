import { describe, it, expect } from 'vitest'
import { resultsToMarkdown, roundIsDead, type EngineResult, type WorkloadResult } from './runner'
import { summarize } from './stats'

/**
 * A flood round that parses nothing still completes, still reports a duration,
 * and — being milliseconds long — still looks like the best result in the set.
 * That is how a ~3x-too-fast Ghostty figure survived in the exported findings:
 * two of three rounds died and were averaged in as though they were real.
 *
 * These pin the reporting half of the guard. The detection half (`roundIsDead`)
 * runs inside `measureBlock`, which needs a live rAF loop and a real engine, so
 * it is exercised by the harness rather than here.
 */

function engineResult(name: string, over: Partial<EngineResult> = {}): EngineResult {
  return {
    engine: name,
    stats: summarize([15.9, 15.9, 15.9]),
    parseMeanMs: 3300,
    parseMBs: 30.7,
    drainMeanMs: 3700,
    deliveries: 394,
    emptyTrials: 0,
    failedTrials: 0,
    deadTrials: 0,
    ...over,
  }
}

function floodResult(results: EngineResult[]): WorkloadResult {
  return {
    workloadId: 'flood-100',
    label: 'Flood 100 MB',
    unit: 'ms stall',
    mode: 'block',
    chunkedFeed: true,
    results,
  }
}

const MB = 1024 * 1024

describe('roundIsDead', () => {
  it('condemns a flood the buffer never saw', () => {
    // The observed failure: 100 MB in, buffer unchanged.
    expect(roundIsDead(100 * MB, 0, 18)).toBe(true)
  })

  it('accepts a round that scrolled, however far scrollback capped it', () => {
    // 100 MB into a 5000-line scrollback saturates long before the payload ends,
    // so the test is "did it scroll at all", not "did it retain proportionally".
    expect(roundIsDead(100 * MB, 5000, 18)).toBe(false)
    expect(roundIsDead(100 * MB, 18, 18)).toBe(false)
  })

  /**
   * A tall grid needs a correspondingly taller gain before it counts as having
   * scrolled — otherwise a 60-row terminal that produced 20 rows and stopped
   * would pass a threshold tuned for an 18-row one.
   */
  it('scales the floor with the grid rather than fixing it', () => {
    expect(roundIsDead(100 * MB, 20, 18)).toBe(false)
    expect(roundIsDead(100 * MB, 20, 60)).toBe(true)
  })

  /**
   * Only floods are judged. The latency and throughput workloads write far too
   * little to guarantee a scroll, and failing them for it would be noise.
   */
  it('does not judge payloads too small to guarantee a scroll', () => {
    expect(roundIsDead(64 * 1024, 0, 24)).toBe(false)
  })
})

describe('unparsed flood rounds', () => {
  it('says nothing when every round parsed', () => {
    const md = resultsToMarkdown([floodResult([engineResult('xterm'), engineResult('ghostty')])], 'gpu', 'meta', 15.1)
    expect(md).not.toContain('not quotable')
    expect(md).not.toContain('☠️')
  })

  it('flags the affected engine in its own row', () => {
    const md = resultsToMarkdown(
      [floodResult([engineResult('xterm'), engineResult('ghostty', { deadTrials: 2 })])],
      'gpu',
      'meta',
      15.1,
    )
    const ghosttyRow = md.split('\n').find((l) => l.startsWith('| ghostty'))!
    expect(ghosttyRow).toContain('☠️2 unparsed')
    expect(md.split('\n').find((l) => l.startsWith('| xterm'))).not.toContain('☠️')
  })

  /**
   * The row flag alone is what failed before: it sits inside a wide table that
   * someone reads long after the run. The banner is the part that has to be
   * unmissable, and it has to come before the numbers it disqualifies.
   */
  it('disqualifies the whole run at the top, above the tables', () => {
    const md = resultsToMarkdown(
      [floodResult([engineResult('xterm'), engineResult('ghostty', { deadTrials: 1 })])],
      'gpu',
      'meta',
      15.1,
    )
    expect(md).toContain('not quotable')
    expect(md.indexOf('not quotable')).toBeLessThan(md.indexOf('| engine |'))
  })

  it('counts dead rounds across every engine and workload', () => {
    const md = resultsToMarkdown(
      [
        floodResult([engineResult('xterm'), engineResult('ghostty', { deadTrials: 2 })]),
        floodResult([engineResult('xterm', { deadTrials: 1 }), engineResult('ghostty')]),
      ],
      'gpu',
      'meta',
      15.1,
    )
    expect(md).toContain('3 rounds')
  })

  it('keeps the singular readable for a single dead round', () => {
    const md = resultsToMarkdown(
      [floodResult([engineResult('xterm'), engineResult('ghostty', { deadTrials: 1 })])],
      'gpu',
      'meta',
      15.1,
    )
    expect(md).toContain('1 round accepted')
  })
})
