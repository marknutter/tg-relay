' Launches the tg-relay daemon with no visible console window.
'
' Used by the "tg-relay daemon" scheduled task. wscript.exe is windowless
' by default, and WshShell.Run with window style 0 spawns the child fully
' hidden -- so the daemon runs in the interactive user session (required
' so it can read ~/.claude/channels/) but produces no visible terminal.
'
' This replaces direct invocation of bun.exe daemon.ts, which would
' otherwise produce a foregrounded console window on every logon because
' bun.exe is a console application.

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Project root = parent of bin/ where this script lives.
projectDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

' Prefer the standard winget install path for Bun. If absent (custom install,
' chocolatey, manual download), fall back to searching PATH.
bunPath = sh.ExpandEnvironmentStrings( _
  "%LOCALAPPDATA%\Microsoft\WinGet\Packages\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe\bun-windows-x64\bun.exe")

If Not fso.FileExists(bunPath) Then
  bunPath = ""
  pathEnv = sh.Environment("PROCESS").Item("PATH")
  For Each dir In Split(pathEnv, ";")
    If Len(dir) > 0 Then
      candidate = dir & "\bun.exe"
      If fso.FileExists(candidate) Then
        bunPath = candidate
        Exit For
      End If
    End If
  Next
End If

If bunPath = "" Then
  WScript.Echo "bun.exe not found at winget standard path or anywhere on PATH"
  WScript.Quit 1
End If

sh.CurrentDirectory = projectDir
' 0 = SW_HIDE (no window), False = don't wait for the child to exit.
sh.Run """" & bunPath & """ """ & projectDir & "\src\daemon.ts""", 0, False
