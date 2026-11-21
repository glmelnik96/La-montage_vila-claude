# Capture the Premiere Pro window (Windows) to SEE the timeline panel, not only rendered
# frames. A track reordered with move() gave perfect QE frames while the panel drew V1/A1
# empty; only a picture of the panel showed what the user saw. PrintWindow with
# PW_RENDERFULLCONTENT captures the window even when another one covers it.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prwindow.ps1 <out.png>
#
# Park the playhead where you want to look first (activate the sequence, setPlayerPosition).
param([Parameter(Mandatory = $true)][string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public class PrWin { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
public struct RECT { public int L, T, R, B; } }
'@
$p = Get-Process | Where-Object { $_.ProcessName -like "Adobe Premiere Pro*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Error "Premiere Pro is not running"; exit 2 }
$h = $p.MainWindowHandle
$r = New-Object PrWin+RECT
[PrWin]::GetWindowRect($h, [ref]$r) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[PrWin]::PrintWindow($h, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save($Out); $bmp.Dispose()
"saved $Out"
