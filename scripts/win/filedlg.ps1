# Fill a standard Windows file dialog WITHOUT keystrokes and press its OK button. SendKeys lost
# characters here (a stuck Ctrl turned "C" into Ctrl+C), and UIA shows the file-name box of Premiere's
# dialog as a bare Pane with no ValuePattern, so: find the Edit (AutomationId 1148, class Edit) by UIA,
# take its window handle, WM_SETTEXT the path, post WM_COMMAND IDOK to the dialog.
#   powershell -NoProfile -ExecutionPolicy Bypass -File filedlg.ps1 -Title "Open Project" -Path "C:\x\y.prproj" [-NoSubmit]
param([Parameter(Mandatory=$true)][string]$Title, [Parameter(Mandatory=$true)][string]$Path, [switch]$NoSubmit)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class FD {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
$AE = [System.Windows.Automation.AutomationElement]
$root = $AE::RootElement
$nameCond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $Title)
# the dialog is top-level, or owned by the app's main window (Premiere: one level below the root)
$dlgs = @()
foreach ($d in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $nameCond)) { $dlgs += $d }
foreach ($t in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) { foreach ($d in $t.FindAll([System.Windows.Automation.TreeScope]::Children, $nameCond)) { $dlgs += $d } }
$editCond = New-Object System.Windows.Automation.AndCondition((New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, "1148")), (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, "Edit")))
$dlg = $null; $edit = $null
foreach ($d in $dlgs) { $e = $d.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond); if ($e) { $dlg = $d; $edit = $e; break } }
if (-not $edit) { "no file dialog '$Title' with a file-name Edit"; exit 2 }
$hEdit = [IntPtr]$edit.Current.NativeWindowHandle; $hDlg = [IntPtr]$dlg.Current.NativeWindowHandle
[void][FD]::SendMessage($hEdit, 0x000C, [IntPtr]::Zero, $Path)          # WM_SETTEXT
$sb = New-Object System.Text.StringBuilder 1024
[void][FD]::SendMessage($hEdit, 0x000D, [IntPtr]1024, $sb)               # WM_GETTEXT
"value now: " + $sb.ToString()
if ($NoSubmit) { exit 0 }
[void][FD]::PostMessage($hDlg, 0x0111, [IntPtr]1, [IntPtr]::Zero)       # WM_COMMAND IDOK
"posted IDOK"
