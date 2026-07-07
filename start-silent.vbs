Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c pm2 resurrect", 0, False
