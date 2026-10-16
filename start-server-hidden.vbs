' Shukao local API - start hidden, no window. Logs go to runtime-server-3212-current*.log
' 出站代理：与 start-server.cmd 一样，用 scripts/tools/print-proxy-env.js 生成环境变量，
' 否则 Node 的内置 fetch 不读 Windows 系统代理，上游按地区限制时报 451。
Option Explicit
Dim shell, fso, base, cmd, exec, line, envPrefix
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = base
envPrefix = ""
Set exec = shell.Exec("node scripts\tools\print-proxy-env.js")
Do While Not exec.StdOut.AtEndOfStream
  line = Trim(exec.StdOut.ReadLine())
  If Left(line, 4) = "set " Then envPrefix = envPrefix & line & " && "
Loop
cmd = "cmd.exe /c cd /d """ & base & """ && " & envPrefix & "node apps\api\src\server.js >> runtime-server-3212-current.log 2>> runtime-server-3212-current.err.log"
shell.Run cmd, 0, False
