; Guard runs in .onInit/un.onInit, before install/update/removal of application files.
; Keep data outside the installation tree even for a supplied /D or legacy path.
!macro TDBStorageGuard candidate suffix
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  GetFullPathName $R0 "${candidate}"
  StrCmp $R0 "" tdb_storage_unsafe_${suffix}
  StrCpy $R3 $R0 1 -1
  StrCmp $R3 "\" 0 +2
    StrCpy $R0 $R0 -1
  StrCpy $R0 "$R0\"
  ReadEnvStr $R1 "APPDATA"
  StrCmp $R1 "" tdb_storage_unsafe_${suffix}
  GetFullPathName $R1 "$R1\TravelDataBase"
  StrCpy $R1 "$R1\"
  ; StrCmp is case insensitive; trailing separators preserve directory boundaries.
  StrLen $R2 $R0
  StrCpy $R3 $R1 $R2
  StrCmp $R3 $R0 tdb_storage_unsafe_${suffix}
  StrLen $R2 $R1
  StrCpy $R3 $R0 $R2
  StrCmp $R3 $R1 tdb_storage_unsafe_${suffix} tdb_storage_safe_${suffix}
tdb_storage_unsafe_${suffix}:
  IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "Каталог программы пересекается с папкой базы TravelDataBase. Операция остановлена, данные сохранены."
  SetErrorLevel 2
  Quit
tdb_storage_safe_${suffix}:
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro customInit
  !insertmacro TDBStorageGuard "$INSTDIR" install
  ${If} $perUserInstallationFolder != ""
    !insertmacro TDBStorageGuard "$perUserInstallationFolder" install_user
  ${EndIf}
  ${If} $perMachineInstallationFolder != ""
    !insertmacro TDBStorageGuard "$perMachineInstallationFolder" install_machine
  ${EndIf}
!macroend

!macro customUnInit
  !insertmacro TDBStorageGuard "$INSTDIR" uninstall
  ${If} $perUserInstallationFolder != ""
    !insertmacro TDBStorageGuard "$perUserInstallationFolder" uninstall_user
  ${EndIf}
  ${If} $perMachineInstallationFolder != ""
    !insertmacro TDBStorageGuard "$perMachineInstallationFolder" uninstall_machine
  ${EndIf}
!macroend
