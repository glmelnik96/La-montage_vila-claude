# Click a control of a running app by its accessible name (UI Automation). If the app's web view does
# not expose it, click at an offset from the top-left of the app's main window instead (the offset is
# a measurement, recorded with its date in references/after-effects-link.md).
#   powershell -NoProfile -ExecutionPolicy Bypass -File uiclick.ps1 -Proc "Adobe Premiere Pro*" -Name "Open Project" [-RelX 83 -RelY 238 -MainTitle "Adobe Premiere"] [-DryRun]
# -DryRun does everything but the click itself (the app's window still comes to the front).
# A click lands on whatever is on top at that point. Once another app covered Premiere and three
# clicks went into it. So the app's own window at the point is brought to the front first, and the
# click happens only if the window under the point then belongs to the app. Otherwise nothing is
# clicked (exit 4).
param([Parameter(Mandatory=$true)][string]$Proc, [Parameter(Mandatory=$true)][string]$Name, [int]$RelX = -1, [int]$RelY = -1, [string]$MainTitle = "", [switch]$DryRun)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public class UiClk {
  public struct POINT { public int X, Y; }
  public struct RECT { public int L, T, R, B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  // the app's topmost visible window containing the point (EnumWindows goes top to bottom)
  public static IntPtr AppWindowAt(int x, int y, HashSet<uint> pids) {
    IntPtr hit = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid; GetWindowThreadProcessId(h, out pid); RECT r;
      if (pids.Contains(pid) && IsWindowVisible(h) && GetWindowRect(h, out r) && x >= r.L && x < r.R && y >= r.T && y < r.B) { hit = h; return false; }
      return true;
    }, IntPtr.Zero);
    return hit;
  }
  public static uint PidAt(int x, int y) {
    var p = new POINT(); p.X = x; p.Y = y; uint pid;
    GetWindowThreadProcessId(GetAncestor(WindowFromPoint(p), 2), out pid); return pid;
  }
  // an ALT tap lifts the foreground lock, so SetForegroundWindow works from a background process
  public static void Front(IntPtr h) {
    if (GetForegroundWindow() == h) { return; }
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h); System.Threading.Thread.Sleep(400);
  }
  public static void Click(int x, int y) { SetCursorPos(x, y); System.Threading.Thread.Sleep(150); mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero); }
}
'@
$AE = [System.Windows.Automation.AutomationElement]
$pidSet = New-Object 'System.Collections.Generic.HashSet[uint32]'
Get-Process | Where-Object { $_.ProcessName -like $Proc } | ForEach-Object { [void]$pidSet.Add([uint32]$_.Id) }
if (-not $pidSet.Count) { '{"ok":false,"error":"process not running"}'; exit 2 }
function ClickAt([int]$x, [int]$y, [string]$how) {
  $h = [UiClk]::AppWindowAt($x, $y, $pidSet)
  if ($h -eq [IntPtr]::Zero) { '{"ok":false,"error":"no window of the app at ' + $x + ',' + $y + '"}'; exit 4 }
  [UiClk]::Front($h)
  $owner = [UiClk]::PidAt($x, $y)
  if (-not $pidSet.Contains($owner)) {
    $name = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
    '{"ok":false,"error":"' + $x + ',' + $y + ' is covered by another app (' + $name + '): nothing clicked"}'; exit 4
  }
  if ($DryRun) { '{"ok":true,"dry":true,"how":"' + $how + '","x":' + $x + ',"y":' + $y + '}'; exit 0 }
  [UiClk]::Click($x, $y)
  '{"ok":true,"how":"' + $how + '","x":' + $x + ',"y":' + $y + '}'; exit 0
}
$wins = @()
foreach ($w in $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($pidSet.Contains([uint32]$w.Current.ProcessId)) { $wins += $w }
}
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $Name)
foreach ($w in $wins) {
  $el = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if ($el) {
    $r = $el.Current.BoundingRectangle
    if ($r.Width -gt 0) { ClickAt ([int]($r.X + $r.Width / 2)) ([int]($r.Y + $r.Height / 2)) 'uia' }
  }
}
if ($RelX -ge 0 -and $MainTitle) {
  $main = $wins | Where-Object { $_.Current.Name -like "$MainTitle*" } | Select-Object -First 1
  if ($main) { $r = $main.Current.BoundingRectangle; ClickAt ([int]($r.X + $RelX)) ([int]($r.Y + $RelY)) 'offset' }
}
'{"ok":false,"error":"control not found"}'; exit 3
