; 卸载钩子的隔离测试包 —— 只在 %TEMP% 下造夹具，绝不碰真实安装与真实 %APPDATA%\app.xiaomo.ai。
; 用法见 scripts/test-uninstall-hooks.mjs（它会先造夹具，再静默装/卸，最后断言 result.log）。
;
; 覆盖五件事：勾选且非更新→删；更新模式→不删；未勾选→不删；
; 护栏不认（目录里没有 xiaomo.db）→不删并给原因；指针缺失→退回"安装目录同级 xiaomodata"再删。
; 盘根/系统目录那两条前缀分支没法安全地造真夹具（要它们生效，目录里必须先有 xiaomo.db），
; 属于未测分支，别当已覆盖。

!include LogicLib.nsh
!include TextFunc.nsh
; ⚠️ 顺序照真实 installer.nsi：tauri 把 hooks 文件 include 在第 31 行、`!define BUNDLEID` 在第 49 行。
; 测试包要是把 define 放前面，就永远测不出"钩子编译期引用未定义的 BUNDLEID"这个真坑
; （NSIS 只报 warning 6000，然后静默把路径拼错）。
!include "uninstall-hooks.nsh"

!define BUNDLEID "xiaomo-hooktest"
; 打开钩子内部的结果日志（dir=/reason= 那几行），外部断言要用它证明"护栏真的说了原因"
!define XIAOMO_UNINSTALL_TEST

Var DeleteAppDataCheckboxState
Var UpdateMode
Var FixDir
Var Tag

Name "xiaomo hook test"
!ifndef HOOKTEST_OUT
  !define HOOKTEST_OUT "hooktest.exe"
!endif
OutFile "${HOOKTEST_OUT}"
InstallDir "$TEMP\xiaomo-hooktest\install"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow false

Function un.Log
  ClearErrors
  FileOpen $7 "$INSTDIR\result.log" a
  ${IfNot} ${Errors}
    FileSeek $7 0 END
    FileWrite $7 "$Tag|dir=$FixDir$\r$\n"
    FileClose $7
  ${EndIf}
FunctionEnd

; 把指针文件写成 $FixDir（模拟外壳写的 data-dir.txt）
Function un.WritePointer
  CreateDirectory "$APPDATA\${BUNDLEID}"
  ClearErrors
  FileOpen $6 "$APPDATA\${BUNDLEID}\data-dir.txt" w
  ${IfNot} ${Errors}
    FileWrite $6 "$FixDir$\r$\n"
    FileClose $6
  ${EndIf}
FunctionEnd

Function un.DropPointer
  Delete "$APPDATA\${BUNDLEID}\data-dir.txt"
FunctionEnd

Section
  CreateDirectory "$INSTDIR"
  FileOpen $7 "$INSTDIR\result.log" w
  FileWrite $7 "start$\r$\n"
  FileClose $7
  WriteUninstaller "$INSTDIR\uninst-test.exe"
SectionEnd

Section Uninstall
  ; ── case 1：勾选 + 自动更新覆盖装 → 必须不删
  StrCpy $FixDir "$TEMP\xiaomo-hooktest\c1"
  CreateDirectory "$FixDir"
  FileOpen $7 "$FixDir\xiaomo.db" w
  FileWrite $7 "x"
  FileClose $7
  Call un.WritePointer
  StrCpy $DeleteAppDataCheckboxState 1
  StrCpy $UpdateMode 1
  StrCpy $Tag "c1-update-keep"
  !insertmacro NSIS_HOOK_PREUNINSTALL
  ${If} ${FileExists} "$FixDir\xiaomo.db"
    StrCpy $Tag "c1-update-keep OK"
  ${Else}
    StrCpy $Tag "c1-update-keep FAIL-deleted"
  ${EndIf}
  Call un.Log

  ; ── case 2：勾选 + 非更新 + 指针有效 → 必须删
  StrCpy $FixDir "$TEMP\xiaomo-hooktest\c2"
  CreateDirectory "$FixDir"
  FileOpen $7 "$FixDir\xiaomo.db" w
  FileWrite $7 "x"
  FileClose $7
  CreateDirectory "$FixDir\media"
  FileOpen $7 "$FixDir\media\a.png" w
  FileWrite $7 "x"
  FileClose $7
  Call un.WritePointer
  StrCpy $DeleteAppDataCheckboxState 1
  StrCpy $UpdateMode 0
  StrCpy $Tag "c2-checked-delete"
  !insertmacro NSIS_HOOK_PREUNINSTALL
  ${If} ${FileExists} "$FixDir\xiaomo.db"
    StrCpy $Tag "c2-checked-delete FAIL-still-there"
  ${Else}
    StrCpy $Tag "c2-checked-delete OK"
  ${EndIf}
  Call un.Log

  ; ── case 3：未勾选 → 必须不删
  StrCpy $FixDir "$TEMP\xiaomo-hooktest\c3"
  CreateDirectory "$FixDir"
  FileOpen $7 "$FixDir\xiaomo.db" w
  FileWrite $7 "x"
  FileClose $7
  Call un.WritePointer
  StrCpy $DeleteAppDataCheckboxState 0
  StrCpy $UpdateMode 0
  StrCpy $Tag "c3-unchecked-keep"
  !insertmacro NSIS_HOOK_PREUNINSTALL
  ${If} ${FileExists} "$FixDir\xiaomo.db"
    StrCpy $Tag "c3-unchecked-keep OK"
  ${Else}
    StrCpy $Tag "c3-unchecked-keep FAIL-deleted"
  ${EndIf}
  Call un.Log

  ; ── case 4：勾选 + 指针指向一个没有 xiaomo.db 的目录 → 护栏必须拒
  StrCpy $FixDir "$TEMP\xiaomo-hooktest\c4"
  CreateDirectory "$FixDir"
  FileOpen $7 "$FixDir\重要文件.txt" w
  FileWrite $7 "别删我"
  FileClose $7
  Call un.WritePointer
  StrCpy $DeleteAppDataCheckboxState 1
  StrCpy $UpdateMode 0
  StrCpy $Tag "c4-guard-reject"
  !insertmacro NSIS_HOOK_PREUNINSTALL
  ${If} ${FileExists} "$FixDir\重要文件.txt"
    StrCpy $Tag "c4-guard-reject OK"
  ${Else}
    StrCpy $Tag "c4-guard-reject FAIL-deleted"
  ${EndIf}
  Call un.Log

  ; ── case 5：勾选 + 指针缺失 → 回退「安装目录同级 xiaomodata」并删
  StrCpy $FixDir "$INSTDIR\..\xiaomodata"
  CreateDirectory "$FixDir"
  FileOpen $7 "$FixDir\xiaomo.db" w
  FileWrite $7 "x"
  FileClose $7
  Call un.DropPointer
  StrCpy $DeleteAppDataCheckboxState 1
  StrCpy $UpdateMode 0
  StrCpy $Tag "c5-fallback-delete"
  !insertmacro NSIS_HOOK_PREUNINSTALL
  ${If} ${FileExists} "$INSTDIR\..\xiaomodata\xiaomo.db"
    StrCpy $Tag "c5-fallback-delete FAIL-still-there"
  ${Else}
    StrCpy $Tag "c5-fallback-delete OK"
  ${EndIf}
  Call un.Log

  ; 收尾：把测试用的 AppData 目录清掉（真实 app.xiaomo.ai 从头到尾没被碰）
  RmDir /r "$APPDATA\${BUNDLEID}"
SectionEnd
