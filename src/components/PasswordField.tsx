import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  autoFocus?: boolean
  className?: string
}

/**
 * A password input with a button to show what's been typed. A master password can't
 * be recovered, so a typo on a phone keyboard otherwise looks exactly like having
 * the wrong one.
 *
 * Always starts hidden. Shown, it's a text field, so everything that would learn or
 * change the text is asked to stay out of it.
 */
export function PasswordField({ value, onChange, placeholder, autoFocus, className }: Props) {
  const [shown, setShown] = useState(false)
  return (
    <div className="relative">
      <input
        type={shown ? 'text' : 'password'}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${className ?? ''} pr-9`}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        title={shown ? 'Hide password' : 'Show password'}
        // Keeps focus, and so the phone's keyboard, in the field.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShown((v) => !v)}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-chrome/50 hover:text-chrome/90"
      >
        {shown ? <EyeOff size={15} strokeWidth={2} /> : <Eye size={15} strokeWidth={2} />}
      </button>
    </div>
  )
}
