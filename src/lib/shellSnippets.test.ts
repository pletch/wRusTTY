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

  it.each(SHELL_SNIPPETS)('$id marks where the prompt ends', ({ script }) => {
    // `B` is the only sequence that says which cell your own typing starts
    // in, and it is what autocomplete reads the current line from. Without it
    // the prompt's end is inferred from a quiet period, which cannot tell a
    // shell prompt from a program pausing for a keypress.
    expect(script).toContain(']133;B')
  })

  it.each(SHELL_SNIPPETS.filter((s) => s.id === 'bash' || s.id === 'zsh'))(
    '$id re-adds B every prompt without stacking it up',
    ({ script }) => {
      // `B` has to go in PS1, and a prompt framework (starship,
      // powerlevel10k) assigns PS1 afresh on every prompt — so a one-time
      // edit at install would simply be dropped. Appending each cycle fixes
      // that and creates the opposite hazard: a prompt that is *not* rebuilt
      // would grow one copy per prompt. The test for what is already there is
      // what makes both cases work, so it is the part worth pinning.
      expect(script).toContain("[[ $PS1 == *'133;B'* ]] ||")
    },
  )

  it.each(SHELL_SNIPPETS)('$id reports the working directory', ({ script }) => {
    expect(script).toContain(']7;file://')
  })

  it.each(SHELL_SNIPPETS.filter((s) => s.id !== 'fish' && s.id !== 'powershell'))(
    '$id percent-encodes the path over bytes, not characters',
    ({ script }) => {
      // Without this the encoder emits one escape per *character* in a UTF-8
      // locale, so `é` goes out as %E9 rather than %C3%A9 and the far side
      // decodes a different path. It is a one-line omission with a failure
      // mode nobody notices until a path has an accent in it.
      //
      // fish and PowerShell are excluded because neither hand-rolls the
      // encoder: `string escape --style=url` and [uri]::EscapeDataString both
      // already work in bytes.
      expect(script).toContain('LC_ALL=C')
    },
  )

  const powershell = SHELL_SNIPPETS.find((s) => s.id === 'powershell')!

  it('PowerShell reads $? before anything can overwrite it', () => {
    // $? reflects the statement immediately before it, so the capture has to
    // be the first statement in the function — a check inserted above it, or
    // even a comparison, silently makes every command look successful.
    const body = powershell.script.split('function Global:prompt {\n')[1]
    expect(body, 'no prompt function in the PowerShell snippet').toBeDefined()
    const first = body
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'))
    expect(first).toBe('$ok = $?')
  })

  it('PowerShell reports a native exit code only when the command set it', () => {
    // $LASTEXITCODE survives a cmdlet untouched, so without the comparison
    // against the value from before the command ran, a failing cmdlet after a
    // failing `git` is reported with git's exit code.
    expect(powershell.script).toContain('$Global:__osc133_lastexit = $global:LASTEXITCODE')
    expect(powershell.script).toContain('$LASTEXITCODE -ne $Global:__osc133_lastexit')
  })

  it('PowerShell keeps its guard against a non-interactive profile load', () => {
    // `ssh host pwsh -c ...` loads the profile, exactly as bash sources
    // .bashrc for a command run over ssh — anything written to stdout there
    // lands in that command's output.
    expect(powershell.script).toContain('[Console]::IsInputRedirected')
  })
})
