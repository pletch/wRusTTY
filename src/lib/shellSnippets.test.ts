import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SHELL_SNIPPETS } from './shellSnippets'

/**
 * These snippets exist twice: here, as the text the copy button puts on the
 * clipboard, and in docs/SHELL_INTEGRATION.md, where they are reproduced for
 * anyone reading the repo rather than running the app. That instruction to
 * change both is the kind that gets followed for a while — this makes drift a
 * failing test instead of a wrong document.
 *
 * They can't be tested by *running* them: the shells they target don't exist
 * on a Windows dev box or in CI, and one of the three (fish) has a syntax no
 * other shell will even parse. So what is checked here is that both copies
 * agree, and that each snippet still emits the sequences the app reads.
 */
const DOC = readFileSync(join(__dirname, '../../docs/SHELL_INTEGRATION.md'), 'utf8').replace(
  /\r\n/g,
  '\n',
)

describe('shell snippets', () => {
  it.each(SHELL_SNIPPETS)('$id is reproduced verbatim in the docs', ({ id, script }) => {
    const fence = new RegExp('```' + id + '\n([^]*?)\n```')
    const block = fence.exec(DOC)
    expect(block, `no \`\`\`${id} block in docs/SHELL_INTEGRATION.md`).not.toBeNull()
    expect(block![1]).toBe(script)
  })

  it.each(SHELL_SNIPPETS)('$id reports command boundaries', ({ script }) => {
    // The prompt, the command start, and the exit status. Written with the
    // literal ESC-] the shell will emit, not the escape the snippet spells it
    // with, since bash and zsh spell it differently.
    expect(script).toContain(']133;A')
    expect(script).toContain(']133;C')
    expect(script).toContain(']133;D')
  })

  it.each(SHELL_SNIPPETS)('$id reports the working directory', ({ script }) => {
    expect(script).toContain(']7;file://')
  })

  it.each(SHELL_SNIPPETS.filter((s) => s.id !== 'fish'))(
    '$id percent-encodes the path over bytes, not characters',
    ({ script }) => {
      // Without this the encoder emits one escape per *character* in a UTF-8
      // locale, so `é` goes out as %E9 rather than %C3%A9 and the far side
      // decodes a different path. It is a one-line omission with a failure
      // mode nobody notices until a path has an accent in it.
      expect(script).toContain('LC_ALL=C')
    },
  )
})
