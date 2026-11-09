param([string]$Mode = 'foreground', [long]$Hwnd = 0)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class PeekWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

function Describe([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { Write-Output 'none'; return }
  if (-not [PeekWin]::IsWindow($h)) { Write-Output 'gone'; return }
  $pid = 0
  [void][PeekWin]::GetWindowThreadProcessId($h, [ref]$pid)
  $proc = ''
  try { $proc = (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch {}
  $sb = New-Object System.Text.StringBuilder 512
  [void][PeekWin]::GetWindowText($h, $sb, 512)
  $title = $sb.ToString()
  $r = New-Object PeekWin+RECT
  [void][PeekWin]::GetWindowRect($h, [ref]$r)
  $min = [PeekWin]::IsIconic($h)
  Write-Output ($proc + "`t" + $title + "`t" + $h.ToInt64() + "`t" + $r.Left + "`t" + $r.Top + "`t" + $r.Right + "`t" + $r.Bottom + "`t" + [int]$min)
}

if ($Mode -eq 'foreground') {
  Describe ([PeekWin]::GetForegroundWindow())
} elseif ($Mode -eq 'rect') {
  Describe ([IntPtr]$Hwnd)
} else {
  Write-Output 'none'
}
