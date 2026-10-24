' Launcher senyap tanpa jendela konsol (style 0 = hidden)
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)

If WScript.Arguments.Count > 0 Then
    cmdTarget = WScript.Arguments(0)
    WshShell.CurrentDirectory = currentDir
    WshShell.Run """" & currentDir & "\" & cmdTarget & """", 0, True
End If
