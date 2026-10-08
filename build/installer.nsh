; NSIS custom script for DeepSeek Harness desktop installer and uninstaller

!include "x64.nsh"
; The builder adds its include directories before this hook. Put the narrow
; extraction wrapper in the compiler's working directory so it wins lookup;
; keep the vendor root available for all other stock templates.
!ifndef DSH_NSIS_HOOK_DIR
  !define DSH_NSIS_HOOK_DIR "${__FILEDIR__}"
!endif
!addincludedir "${DSH_NSIS_HOOK_DIR}\..\node_modules\app-builder-lib\templates\nsis"
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    ; Common and multi-user templates have already loaded from their stock
    ; working directory; only the subsequent archive include is redirected.
    !cd "${DSH_NSIS_HOOK_DIR}\nsis"
  !endif
!macroend

!macro dshExtendedPath INPUT OUTPUT
  StrCpy ${OUTPUT} "${INPUT}" 4
  ${If} ${OUTPUT} == "\\?\"
    StrCpy ${OUTPUT} "${INPUT}"
  ${Else}
    StrCpy ${OUTPUT} "${INPUT}" 2
    ${If} ${OUTPUT} == "\\"
      StrCpy ${OUTPUT} "${INPUT}" "" 2
      StrCpy ${OUTPUT} "\\?\UNC\${OUTPUT}"
    ${Else}
      StrCpy ${OUTPUT} "\\?\${INPUT}"
    ${EndIf}
  ${EndIf}
!macroend

!ifdef BUILD_UNINSTALLER
  !include "FileFunc.nsh"
  Var /GLOBAL dshRemovalFailed
  Var /GLOBAL dshCheckOnly
  Function un.dshRemoveTree
    Exch $R0
    Push $R1
    Push $R2
    Push $R3
    ; Do not recurse into directory junctions or symbolic links.
    System::Call 'kernel32::GetFileAttributesW(w "$R0") i .s'
    Pop $R3
    ${If} $R3 == -1
      StrCpy $dshRemovalFailed 1
    ${Else}
      IntOp $R3 $R3 & 0x400
      ${If} $R3 != 0
        ${If} $dshCheckOnly == 1
          StrCpy $dshRemovalFailed 1
        ${Else}
        ClearErrors
        RMDir "$R0"
        ${If} ${Errors}
          ClearErrors
          Delete "$R0"
          ${If} ${Errors}
            StrCpy $dshRemovalFailed 1
          ${EndIf}
        ${EndIf}
        ${EndIf}
      ${Else}
        FindFirst $R1 $R2 "$R0\*"
        ${DoWhile} $R2 != ""
          ${If} $R2 != "."
          ${AndIf} $R2 != ".."
            System::Call 'kernel32::GetFileAttributesW(w "$R0\$R2") i .s'
            Pop $R3
            IntOp $R3 $R3 & 0x10
            ${If} $R3 != 0
              Push "$R0\$R2"
              Call un.dshRemoveTree
            ${Else}
              ${If} $dshCheckOnly != 1
              ClearErrors
              Delete "$R0\$R2"
              ${If} ${Errors}
                StrCpy $dshRemovalFailed 1
              ${EndIf}
              ${EndIf}
            ${EndIf}
          ${EndIf}
          FindNext $R1 $R2
        ${Loop}
        FindClose $R1
        ${If} $dshCheckOnly != 1
        ClearErrors
        RMDir "$R0"
        ${If} ${Errors}
          StrCpy $dshRemovalFailed 1
        ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  FunctionEnd

  Var /GLOBAL dshMoveSource
  Var /GLOBAL dshMoveDest
  Function un.dshMoveTree
    Exch $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    Push $R5
    Push $R6
    StrCpy $R3 "$dshMoveSource$R0"
    !insertmacro dshExtendedPath "$R3" $R5
    StrCpy $R3 "$dshMoveDest$R0"
    !insertmacro dshExtendedPath "$R3" $R6
    ClearErrors
    CreateDirectory "$R6"
    ${If} ${Errors}
      StrCpy $dshRemovalFailed 1
      Goto dshMoveDone
    ${EndIf}
    FindFirst $R1 $R2 "$R5\*"
    ${DoWhile} $R2 != ""
      ${If} $R2 != "."
      ${AndIf} $R2 != ".."
        System::Call 'kernel32::GetFileAttributesW(w "$R5\$R2") i .s'
        Pop $R4
        ${If} $R4 == -1
          StrCpy $dshRemovalFailed 1
        ${Else}
          IntOp $R3 $R4 & 0x400
          ${If} $R3 != 0
            StrCpy $dshRemovalFailed 1
          ${Else}
            IntOp $R3 $R4 & 0x10
            ${If} $R3 != 0
              Push "$R0\$R2"
              Call un.dshMoveTree
            ${Else}
              ClearErrors
              Rename "$R5\$R2" "$R6\$R2"
              ${If} ${Errors}
                StrCpy $dshRemovalFailed 1
              ${EndIf}
            ${EndIf}
          ${EndIf}
        ${EndIf}
        ${If} $dshRemovalFailed != 0
          Goto dshMoveClose
        ${EndIf}
      ${EndIf}
      FindNext $R1 $R2
    ${Loop}
    dshMoveClose:
    FindClose $R1
    dshMoveDone:
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  FunctionEnd

  !macro customRemoveFiles
    ${GetRoot} "$INSTDIR" $R0
    StrLen $R0 $R0
    IntOp $R0 $R0 + 1
    StrLen $R1 "$INSTDIR"
    ${If} $R1 <= $R0
      SetErrorLevel 2
      Quit
    ${EndIf}
    ; Move individual old files to a temporary tree before removing the old
    ; directory. Both directions use extended paths so rollback also works
    ; for a file whose full name exceeds MAX_PATH.
    ${If} ${isUpdated}
      ; The stock atomic mover follows links. Reject that update branch
      ; before mutation; ordinary uninstall safely removes the links.
      StrCpy $dshRemovalFailed 0
      StrCpy $dshCheckOnly 1
      !insertmacro dshExtendedPath "$INSTDIR" $R0
      Push "$R0"
      Call un.dshRemoveTree
      StrCpy $dshCheckOnly 0
      ${If} $dshRemovalFailed != 0
        SetErrorLevel 2
        Quit
      ${EndIf}
      SetOutPath "$TEMP"
      StrCpy $dshMoveSource "$INSTDIR"
      StrCpy $dshMoveDest "$PLUGINSDIR\old-install"
      Push ""
      Call un.dshMoveTree
      ${If} $dshRemovalFailed != 0
        StrCpy $dshMoveSource "$PLUGINSDIR\old-install"
        StrCpy $dshMoveDest "$INSTDIR"
        StrCpy $dshRemovalFailed 0
        Push ""
        Call un.dshMoveTree
        DetailPrint "Cannot move the previous installation for update."
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
    SetOutPath "$TEMP"
    StrCpy $dshRemovalFailed 0
    !insertmacro dshExtendedPath "$INSTDIR" $R0
    Push "$R0"
    Call un.dshRemoveTree
    ${If} $dshRemovalFailed != 0
      ${If} ${isUpdated}
        StrCpy $dshMoveSource "$PLUGINSDIR\old-install"
        StrCpy $dshMoveDest "$INSTDIR"
        StrCpy $dshRemovalFailed 0
        Push ""
        Call un.dshMoveTree
      ${EndIf}
      DetailPrint "Some installed files could not be removed."
      SetErrorLevel 2
      Quit
    ${EndIf}
  !macroend
!endif

; Check environment prerequisites before installation starts
!macro customInit
  ${If} ${RunningX64}
    SetRegView 64
    ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64" "Installed"
    ${If} $0 != 1
      ; This installer is 32-bit. Sysnative bypasses WOW64 redirection so the
      ; fallback checks the same x64 DLL as the bundled Node runtime.
      ${IfNot} ${FileExists} "$WINDIR\Sysnative\vcruntime140.dll"
        MessageBox MB_YESNO|MB_ICONEXCLAMATION "检测到当前 Windows 系统缺少微软 Visual C++ 运行库（vcruntime140.dll）。$\r$\n$\r$\n没有该运行库，DeepSeek Harness 将无法启动内置后台服务。$\r$\n$\r$\n是否立即前往微软官网下载并安装？" /SD IDNO IDNO skipVcPrompt
        ExecShell "open" "https://aka.ms/vs/17/release/vc_redist.x64.exe"
        skipVcPrompt:
      ${EndIf}
    ${EndIf}
    SetRegView lastused
  ${EndIf}
!macroend

; Personal data survives uninstall. DSH_HOME may be customized, and its skills
; directory may link to a separate library; the installer does not delete it.
