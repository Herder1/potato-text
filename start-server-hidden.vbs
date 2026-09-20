' Shukao local API - start hidden, no window. Logs go to runtime-server-3212-current*.log
Option Explicit
Dim shell, fso, base, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = base
cmd = "cmd.exe /c cd /d """ & base & """ && node apps\api\src\server.js >> runtime-server-3212-current.log 2>> runtime-server-3212-current.err.log"
shell.Run cmd, 0, False
