<#
.SYNOPSIS
  Drives the running wRusTTY window with real OS-level mouse input, and
  screenshots it.

.DESCRIPTION
  For the parts of the app that only exist in a real window: the tab strip, the
  title-bar drag region, window state, and anything Tauri's own injected
  scripts handle. Those never reach `driver.mts` or `visual.html`.

  Input goes through `SendInput`-style `mouse_event`, not synthesized DOM
  events, because the behaviour worth testing up here is frequently *not* the
  app's. Tauri's drag-region script maximizes the window from a raw `mousedown`
  whose `detail` is 2, and `detail` is a platform click counter — a dispatched
  MouseEvent carries whatever `detail` you put in the init dict and proves
  nothing about what Windows would have counted. A dblclick bug was "fixed"
  against passing DOM-level tests here and still reproduced in the window.

  Co-ordinates for -X/-Y are **window-relative**, matching what you measure off
  a screenshot this script took.

.EXAMPLE
  $w = '.claude/skills/run-wrustty/window.ps1'
  & $w -Action wait                          # block until the window exists
  & $w -Action shot -Out shot.png            # screenshot, window only
  & $w -Action click -X 218 -Y 21            # click the "+" in the tab strip
  & $w -Action dblclick -X 335 -Y 21         # double-click a tab's close ✕
  & $w -Action rect                          # JSON: bounds + Maximized
  & $w -Action restore                       # un-maximize between trials
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('wait', 'rect', 'focus', 'shot', 'click', 'dblclick', 'restore', 'maximize')]
  [string]$Action,
  [int]$X = 0,
  [int]$Y = 0,
  [string]$Out = '',
  # Only used by -Action wait.
  [int]$TimeoutSeconds = 600
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WrusttyWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public const int SW_RESTORE = 9, SW_MAXIMIZE = 3;
}
'@

# Via the process, not FindWindow: the window title is set by the app and
# changes with the active tab, and the class name is WebView2's. FindWindow on
# either is unreliable — it was tried and failed.
function Get-AppWindow {
  $p = Get-Process -Name wrustty -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { return [IntPtr]::Zero }
  return $p.MainWindowHandle
}

if ($Action -eq 'wait') {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ((Get-AppWindow) -ne [IntPtr]::Zero) {
      # The handle exists a moment before the webview has painted.
      Start-Sleep -Milliseconds 1500
      'window up'
      exit 0
    }
    Start-Sleep -Seconds 2
  }
  throw "wRusTTY window did not appear within $TimeoutSeconds s — check the tauri dev output."
}

$hwnd = Get-AppWindow
if ($hwnd -eq [IntPtr]::Zero) { throw 'wRusTTY window not found — is `npm run tauri dev` running?' }

$r = New-Object WrusttyWin+RECT
[void][WrusttyWin]::GetWindowRect($hwnd, [ref]$r)

function Move-To([int]$wx, [int]$wy) {
  [void][WrusttyWin]::SetCursorPos($r.Left + $wx, $r.Top + $wy)
  Start-Sleep -Milliseconds 120
}
function Send-Press {
  [WrusttyWin]::mouse_event([WrusttyWin]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
  [WrusttyWin]::mouse_event([WrusttyWin]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
}

switch ($Action) {
  'rect' {
    [pscustomobject]@{
      Left = $r.Left; Top = $r.Top; Right = $r.Right; Bottom = $r.Bottom
      Width = $r.Right - $r.Left; Height = $r.Bottom - $r.Top
      Maximized = [WrusttyWin]::IsZoomed($hwnd)
    } | ConvertTo-Json -Compress
  }
  'focus' {
    [void][WrusttyWin]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 300
  }
  'restore' {
    [void][WrusttyWin]::ShowWindow($hwnd, [WrusttyWin]::SW_RESTORE)
    Start-Sleep -Milliseconds 700
  }
  'maximize' {
    [void][WrusttyWin]::ShowWindow($hwnd, [WrusttyWin]::SW_MAXIMIZE)
    Start-Sleep -Milliseconds 700
  }
  'shot' {
    if (-not $Out) { throw '-Out is required for -Action shot.' }
    $bmp = New-Object Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
    $bmp.Save($Out, [Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    "saved $Out"
  }
  'click' {
    Move-To $X $Y
    Send-Press
    Start-Sleep -Milliseconds 250
  }
  'dblclick' {
    # Cursor stationary across both presses, second well inside the system
    # double-click time — this is what an impatient user does to a button, and
    # it is the gesture that produces `detail == 2`.
    Move-To $X $Y
    Send-Press
    Start-Sleep -Milliseconds 60
    Send-Press
    Start-Sleep -Milliseconds 400
  }
}
