!macro customInstall
  ExecWait '"$INSTDIR\resources\native\win32\cpv-driver-manager.exe" --ensure-installed --installer-mode' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Persona Voice could not install its signed audio endpoint (exit code $0). The application was not installed."
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_ICONEXCLAMATION|MB_OKCANCEL "Before removing Persona Voice, restore ChatGPT and Codex Output to Default (or your physical device) in Windows Settings > System > Sound > Volume mixer." IDOK +2
    Abort
    ExecShell "open" "ms-settings:apps-volume"
    MessageBox MB_ICONQUESTION|MB_OKCANCEL "After restoring every ChatGPT/Codex output route, click OK to remove Persona Voice Sink. Click Cancel to keep the driver installed." IDOK +2
    Abort
    ExecWait '"$INSTDIR\resources\native\win32\cpv-driver-manager.exe" --uninstall --installer-mode' $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP|MB_OK "Persona Voice could not remove its audio endpoint (exit code $0). Uninstall was stopped so the driver remains owned and recoverable."
      Abort
    ${EndIf}
  ${endIf}
!macroend
