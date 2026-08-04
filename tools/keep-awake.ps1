# Holds a Windows machine awake for as long as this script runs.
#
# Run it on the *remote* host, inside an SSH session, when you need that host
# to stay up for the length of the session. It is the companion to the
# Wake-on-LAN support in the client: waking a sleeping machine is no use if it
# sleeps again ten minutes later while you are still typing at it.
#
# It has to exist because, since Vista, the Windows idle-sleep timer is reset
# by user input (HID) and by power requests — and by nothing else. Not network
# traffic, not CPU, not disk. `sshd` asserts no power request of its own, so an
# SSH session is completely invisible to the timer no matter how busy it is,
# and the machine sleeps out from under you mid-command. SSH keepalives don't
# help either: they are packets on the wire, which is exactly what the timer
# ignores.
#
# The mechanism is SetThreadExecutionState — the same one media players use.
# It is per-*thread*, and released when that thread exits, which is the whole
# reason this is a script that blocks rather than one that sets a flag and
# returns: a flag set by a process that then exits does nothing at all.
#
#   pwsh -File tools\keep-awake.ps1     # Ctrl-C, or closing the session, releases
#
# Verify it took, from an elevated prompt on that machine:
#
#   powercfg /requests                  # want pwsh.exe under SYSTEM:
#
# Deliberately not `powercfg /change standby-timeout-ac 0`. That works and is
# one line, but it is a permanent settings change on a machine you are usually
# not sitting at — you will forget, and you have then silently given up sleep
# on a desktop that was configured to sleep on purpose. This is scoped to the
# session by construction, which is the point.
#
# There is a lighter-touch variant: the same three lines in the remote user's
# $PROFILE, guarded by `if ($env:SSH_CONNECTION)`, so every SSH login asserts
# it and every logout drops it with no extra process. That works, but PowerShell
# does not guarantee your profile runs on a thread that lives for the whole
# session, so it can silently fail to hold. Check `powercfg /requests` if you
# go that way. This script cannot lose the flag, because the thread holding it
# is the one sitting in the loop below.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The signature is two concatenated pieces rather than one long line on
# purpose: a ~110-character line pasted into a terminal is exactly the kind of
# thing that arrives with a space missing in the middle, and `uintesFlags` is a
# baffling C# compiler error to debug. Short lines cannot lose the space
# between a type and its parameter name, because there isn't one to lose.
if (-not ('Win32.Power' -as [type])) {
    $signature = '[DllImport("kernel32.dll", SetLastError = true)]' +
                 ' public static extern uint SetThreadExecutionState(uint esFlags);'
    Add-Type -Name Power -Namespace Win32 -MemberDefinition $signature | Out-Null
}

# Decimal, not hex. PowerShell reads an 8-digit hex literal as a *signed*
# Int32, so 0x80000001 arrives as -2147483647 and refuses to cast to uint32 —
# which fails at the call, long after the mistake looks like it was made.
$ES_CONTINUOUS_AND_SYSTEM_REQUIRED = [uint32]2147483649  # 0x80000000 | 0x00000001
$ES_CONTINUOUS = [uint32]2147483648                      # 0x80000000 alone: clears it

# Only the system is held awake, not the display: ES_DISPLAY_REQUIRED is
# omitted so the monitor still blanks on its own timer. Nobody is looking at
# the screen of a machine being driven over SSH.
if ([Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS_AND_SYSTEM_REQUIRED) -eq 0) {
    throw 'SetThreadExecutionState failed — the machine is NOT being held awake.'
}

Write-Host "Holding $env:COMPUTERNAME awake (pid $PID). Ctrl-C to release."

try {
    while ($true) { Start-Sleep -Seconds 60 }
}
finally {
    # Belt and braces. The request is tied to this thread, so process exit
    # releases it whatever happens — including a killed SSH session, which is
    # the case that actually matters. This just makes a clean Ctrl-C tidy up
    # without waiting for the process to go.
    [void][Win32.Power]::SetThreadExecutionState($ES_CONTINUOUS)
    Write-Host 'Released. Normal sleep behaviour restored.'
}
