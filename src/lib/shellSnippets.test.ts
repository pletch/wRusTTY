import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SHELL_SNIPPETS } from './shellSnippets'

/**
 * These snippets exist here (what the copy button copies) and in
 * docs/SHELL_INTEGRATION.md; this fails when they drift. They can't be run
 * (the target shells aren't on a Windows dev box or CI), so this checks that
 * both copies agree and still emit the sequences the app reads.
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
    // Prompt, command start and exit status, as the literal ESC-] the shell
    // emits (bash and zsh spell the escape differently).
    expect(script).toContain(']133;A')
    expect(script).toContain(']133;C')
    expect(script).toContain(']133;D')
  })

  it.each(SHELL_SNIPPETS)('$id marks where the prompt ends', ({ script }) => {
    // `B` marks where typing starts, which autocomplete reads. Without it the
    // prompt's end is guessed from a pause.
    expect(script).toContain(']133;B')
  })

  it.each(SHELL_SNIPPETS.filter((s) => s.id === 'bash' || s.id === 'zsh'))(
    '$id re-adds B every prompt without stacking it up',
    ({ script }) => {
      // Prompt frameworks (starship, powerlevel10k) reassign PS1 every prompt,
      // so `B` is appended each cycle, guarded so a static prompt doesn't grow.
      expect(script).toContain("[[ $PS1 == *'133;B'* ]] ||")
    },
  )

  it.each(SHELL_SNIPPETS)('$id reports the working directory', ({ script }) => {
    expect(script).toContain(']7;file://')
  })

  it.each(SHELL_SNIPPETS.filter((s) => s.id !== 'fish' && s.id !== 'powershell'))(
    '$id percent-encodes the path over bytes, not characters',
    ({ script }) => {
      // Without it, a UTF-8 locale escapes per character (`é` as %E9 rather than
      // %C3%A9). fish and PowerShell use byte-based built-in escapers.
      expect(script).toContain('LC_ALL=C')
    },
  )

  const powershell = SHELL_SNIPPETS.find((s) => s.id === 'powershell')!

  it('PowerShell reads $? before anything can overwrite it', () => {
    // $? reflects the statement just before it, so capturing it must come
    // first, or every command looks successful.
    const body = powershell.script.split('function Global:prompt {\n')[1]
    expect(body, 'no prompt function in the PowerShell snippet').toBeDefined()
    const first = body
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'))
    expect(first).toBe('$ok = $?')
  })

  it('PowerShell reports a native exit code only when the command set it', () => {
    // $LASTEXITCODE survives a cmdlet, so it's compared with its pre-command
    // value, or a failing cmdlet after a failing `git` reports git's code.
    expect(powershell.script).toContain('$Global:__osc133_lastexit = $global:LASTEXITCODE')
    expect(powershell.script).toContain('$LASTEXITCODE -ne $Global:__osc133_lastexit')
  })

  it('PowerShell keeps its guard against a non-interactive profile load', () => {
    // `ssh host pwsh -c ...` loads the profile, so stdout there would land in
    // the command's output.
    expect(powershell.script).toContain('[Console]::IsInputRedirected')
  })
})
