' Starts the dsh-opencode relay supervisor with no visible window.
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c """ & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\run-relay.cmd""", 0, False
