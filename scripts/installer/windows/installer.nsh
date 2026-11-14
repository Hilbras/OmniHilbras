; NSIS additions for the Windows installer: put `omnihilbras` on PATH, and take it away again.
;
; ## Why this is needed
;
; The Linux `.deb` gets this for free — electron-builder's generated `after-install` registers
; `/usr/bin/omnihilbras` as an update-alternative pointing at the installed binary, which is verifiable on a
; machine that has the package: `update-alternatives --display omnihilbras`. NSIS does nothing equivalent:
; it creates a desktop shortcut and a Start Menu entry, and leaves the application off `PATH`. So the
; command existed on Linux and not on Windows, which is the platform where a person cannot fix it with a
; symlink in ten seconds.
;
; ## Why the logic is not here
;
; The PATH edit lives in `shortcut.ps1` next to this file. NSIS can do it, but string surgery on a PATH in
; NSIS is label-and-`Goto` code that is easy to get subtly wrong and impossible to test on anything but
; Windows; `Split`/`Join` in PowerShell is readable, reviewable, and is one line to call from here. Keeping
; the fiddly part in the language that can express it is the whole reason this file is short.

!macro customInstall
  DetailPrint "Adding $INSTDIR to PATH…"
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer\shortcut.ps1" -Action Install -InstallDir "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    ; Reported, not fatal: the app is installed and usable from its shortcuts. Failing the install over a
    ; convenience entry would be the wrong trade, and the person can add the directory themselves.
    DetailPrint "Could not update PATH automatically (exit $0). Add $INSTDIR to PATH by hand if you want the `omnihilbras` command."
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing $INSTDIR from PATH…"
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer\shortcut.ps1" -Action Uninstall -InstallDir "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Could not update PATH automatically (exit $0). Remove $INSTDIR from PATH by hand."
  ${EndIf}
!macroend
