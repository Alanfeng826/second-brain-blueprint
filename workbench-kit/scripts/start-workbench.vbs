' ===========================================================================
'  start-workbench.vbs
'  Launch the Workbench dev server as a DETACHED background process, so it
'  keeps running after the terminal / AI Agent session is closed.
'
'  Usage
'    - double-click this file, or
'    - put a shim in the Windows Startup folder (shell:startup) - see README
'
'  All real logic lives in scripts/standalone-launcher.mjs.
'  Keep this file ASCII-only: wscript reads .vbs with the system ANSI codepage
'  and non-ASCII text here turns into mojibake.
' ===========================================================================
Option Explicit

Dim fso, shell, here, launcher, nodeExe
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here     = fso.GetParentFolderName(WScript.ScriptFullName)   ' ...\Workbench\scripts
launcher = fso.BuildPath(here, "standalone-launcher.mjs")

nodeExe = ResolveNode()

If nodeExe = "" Then
  MsgBox "Node.js runtime not found." & vbCrLf & vbCrLf & _
         "Set WORKBENCH_NODE to a node.exe path, or install Node.js 20+.", _
         16, "Workbench"
  WScript.Quit 1
End If

If Not fso.FileExists(launcher) Then
  MsgBox "Launcher not found:" & vbCrLf & "  " & launcher, _
         16, "Workbench"
  WScript.Quit 1
End If

' 0 = hidden window, False = do not wait for it to finish
shell.Run """" & nodeExe & """ """ & launcher & """", 0, False

' ---------------------------------------------------------------------------
' Resolve a usable node.exe, in order:
'   1) %WORKBENCH_NODE%             explicit override
'   2) %ProgramFiles%\nodejs\node.exe
'   3) %LOCALAPPDATA%\Programs\nodejs\node.exe
'   4) managed runtimes under %USERPROFILE%\.workbuddy\binaries\node\versions
'      (honours the "current" pointer, then scans version folders)
'   5) whatever is on PATH
' ---------------------------------------------------------------------------
Function ResolveNode()
  Dim explicitPath, candidates, i, versionsDir, currentFile, ver, candidate, subFolder

  ResolveNode = ""

  explicitPath = shell.ExpandEnvironmentStrings("%WORKBENCH_NODE%")
  If explicitPath <> "%WORKBENCH_NODE%" Then
    If fso.FileExists(explicitPath) Then
      ResolveNode = explicitPath
      Exit Function
    End If
  End If

  candidates = Array( _
    shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe") _
  )
  For i = 0 To UBound(candidates)
    If fso.FileExists(candidates(i)) Then
      ResolveNode = candidates(i)
      Exit Function
    End If
  Next

  versionsDir = shell.ExpandEnvironmentStrings( _
    "%USERPROFILE%\.workbuddy\binaries\node\versions")

  currentFile = fso.BuildPath(versionsDir, "current")
  If fso.FileExists(currentFile) Then
    ver = Trim(ReadAll(currentFile))
    If Len(ver) > 0 Then
      candidate = fso.BuildPath(fso.BuildPath(versionsDir, ver), "node.exe")
      If fso.FileExists(candidate) Then
        ResolveNode = candidate
        Exit Function
      End If
    End If
  End If

  If fso.FolderExists(versionsDir) Then
    For Each subFolder In fso.GetFolder(versionsDir).SubFolders
      candidate = fso.BuildPath(subFolder.Path, "node.exe")
      If fso.FileExists(candidate) Then
        ResolveNode = candidate
        Exit Function
      End If
    Next
  End If

  ResolveNode = "node.exe"
End Function

Function ReadAll(p)
  Dim ts
  Set ts = fso.OpenTextFile(p, 1)
  ReadAll = ts.ReadAll
  ts.Close
End Function
