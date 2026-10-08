; The cached builder's template defines all archive dispatch macros first.
!include "${DSH_NSIS_HOOK_DIR}\..\node_modules\app-builder-lib\templates\nsis\include\extractAppPackage.nsh"
; Invoked only after the pinned vendor extraction macros have been defined.
  !ifmacrondef extractUsing7za
    !error "The NSIS extraction template changed; review the wrapper."
  !endif
  !macroundef extractUsing7za
  !macro extractUsing7za FILE
    Push $OUTDIR
    Push $R8
    Push $R9
    !insertmacro dshExtendedPath "$OUTDIR" $R9
    SetOutPath "$PLUGINSDIR"
    File /oname=dsh7za.exe "${DSH_NSIS_HOOK_DIR}\..\node_modules\electron-winstaller\vendor\7z-x64.exe"
    SetOutPath "$R9"
    ; Nsis7z does not report partial write failures. The bundled 7-Zip CLI
    ; returns a process status, including for optional files that could not
    ; be replaced. Preserve the entry-point checks for corrupt archives.
    Delete "$OUTDIR\${APP_EXECUTABLE_FILENAME}"
    Delete "$OUTDIR\resources\runtime\VERSION.json"
    nsExec::ExecToStack '"$PLUGINSDIR\dsh7za.exe" x -y -bd "-o$R9" "${FILE}"'
    Pop $R8
    Pop $R9
    ${If} $R8 != 0
      DetailPrint "The application archive could not be completely extracted (7-Zip exit $R8)."
      SetErrorLevel 2
      Quit
    ${EndIf}
    ${IfNot} ${FileExists} "$OUTDIR\${APP_EXECUTABLE_FILENAME}"
    ${OrIfNot} ${FileExists} "$OUTDIR\resources\runtime\VERSION.json"
    ${OrIfNot} ${FileExists} "$OUTDIR\resources\runtime\host\node_modules\@deepseek-ai\dsh\lib\bin.js"
      DetailPrint "The application archive was not completely extracted."
      SetErrorLevel 2
      Quit
    ${EndIf}
    Pop $R9
    Pop $R8
    Pop $OUTDIR
    SetOutPath "$OUTDIR"
  !macroend

!define DSH_LONG_PATH_EXTRACTION_WRAPPER 1
