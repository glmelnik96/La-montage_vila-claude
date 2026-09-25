# Every visible top-level window of a process, modal dialogs included: they are what blocks a bridge.
#   powershell -NoProfile -ExecutionPolicy Bypass -File wincap.ps1 -Proc "Adobe Premiere Pro*" -List
#   powershell -NoProfile -ExecutionPolicy Bypass -File wincap.ps1 -Proc "AfterFX*" -OutDir <dir> [-MaxW 1400]
# -List prints JSON [{title, cls, main, x, y, w, h}]; `main` marks the process's main window. -OutDir also
# saves each window as a PNG (PrintWindow with PW_RENDERFULLCONTENT captures a window even when
# another one covers it).
param([Parameter(Mandatory=$true)][string]$Proc, [string]$OutDir, [switch]$List, [int]$MaxW = 1400)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class WinCap {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  public struct RECT { public int L, T, R, B; }
  public static List<IntPtr> ForPids(HashSet<uint> pids) {
    var list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) { uint pid; GetWindowThreadProcessId(h, out pid); if (pids.Contains(pid) && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
}
'@
$pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
$mains = New-Object 'System.Collections.Generic.HashSet[int64]'
Get-Process | Where-Object { $_.ProcessName -like $Proc } | ForEach-Object { [void]$pids.Add([uint32]$_.Id); [void]$mains.Add([int64]$_.MainWindowHandle) }
$rows = @()
if ($OutDir) { New-Item -ItemType Directory -Force $OutDir | Out-Null }
$i = 0
foreach ($h in [WinCap]::ForPids($pids)) {
  $r = New-Object WinCap+RECT; [void][WinCap]::GetWindowRect($h, [ref]$r)
  $w = $r.R - $r.L; $hh = $r.B - $r.T
  if ($w -lt 60 -or $hh -lt 40) { continue }
  $row = [ordered]@{ title = [WinCap]::Title($h); cls = [WinCap]::Cls($h); main = $mains.Contains([int64]$h); x = $r.L; y = $r.T; w = $w; h = $hh }
  if ($OutDir) {
    $bmp = New-Object System.Drawing.Bitmap $w, $hh
    $g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc(); [void][WinCap]::PrintWindow($h, $hdc, 2); $g.ReleaseHdc($hdc); $g.Dispose()
    if ($w -gt $MaxW) { $s = $MaxW / $w; $sb = New-Object System.Drawing.Bitmap ([int]($w*$s)), ([int]($hh*$s)); $g2 = [System.Drawing.Graphics]::FromImage($sb); $g2.InterpolationMode = 'HighQualityBicubic'; $g2.DrawImage($bmp, 0, 0, $sb.Width, $sb.Height); $g2.Dispose(); $bmp.Dispose(); $bmp = $sb }
    $f = Join-Path $OutDir ("win{0}.png" -f $i); $bmp.Save($f); $bmp.Dispose(); $row.file = $f
  }
  $rows += [pscustomobject]$row
  $i++
}
if ($List -or -not $OutDir) { ConvertTo-Json -InputObject @($rows) -Compress } else { $rows | ForEach-Object { "{0}x{1} '{2}'{3} -> {4}" -f $_.w, $_.h, $_.title, $(if ($_.main) { ' (main)' } else { '' }), $_.file } }
