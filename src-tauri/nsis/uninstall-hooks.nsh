; 卸载时把「应用数据」真的删干净 —— tauri.conf.json 的 bundle.windows.nsis.installerHooks 指向本文件。
;
; 【为什么要自己写】Tauri 自带的「Delete the application data」只删
; %APPDATA%\app.xiaomo.ai 与 %LOCALAPPDATA%\app.xiaomo.ai（外壳配置 + WebView2 缓存），
; 而聊天记录、记忆、图片在安装目录同级的 xiaomodata 里。用户勾了这一项却留下一库对话，
; 那个勾选就是骗人的。
;
; 【为什么放在 PREUNINSTALL】上游删 AppData 在 POST 之前的一段里做，而我们要读的指针
; 就在 AppData 里；PREUNINSTALL 在任何删除发生之前跑，读得到。
;
; 【为什么还要 ${UpdateMode} <> 1】自动更新走的也是"卸载旧版"这一段。判错一次，
; 每次升级都会把用户全部聊天记录删掉。上游删 AppData 时也带同一个条件，照它抄。

!ifndef XIAOMO_UNINSTALL_HOOKS_NSH
!define XIAOMO_UNINSTALL_HOOKS_NSH

!include TextFunc.nsh

; 读指针：外壳启动与改数据目录时都会写 %APPDATA%\<identifier>\data-dir.txt（一行纯文本）。
; ⚠️ 这段必须待在**宏体**里、不能做成 Function 放在文件顶部：本文件被 tauri 的 installer.nsi
; 在第 31 行 include，而 `!define BUNDLEID` 在第 49 行——编译期就引用 ${BUNDLEID} 的函数体
; 会撞上"还没定义"，NSIS 只报 warning 6000 然后**静默把路径拼错**（实测）。
; 宏在 Section Uninstall 里展开，那时 define 早就有了。
!macro XIAOMO_READ_POINTER
  ; 结果进 $R5，读不到留空
  StrCpy $R5 ""
  ClearErrors
  FileOpen $9 "$APPDATA\${BUNDLEID}\data-dir.txt" r
  ${IfNot} ${Errors}
    FileRead $9 $R5
    FileClose $9
    ${TrimNewLines} $R5 $R5
  ${EndIf}
!macroend

; 护栏：入 $R5 = 候选目录，出 $R8 = ""（放行）或人看的中文原因，$R6 = ASCII 短码（给测试断言用）。
; 为什么两套：NSIS 写日志走系统代码页，中文落盘后外部读回来是乱码，断言没法认。
; 立场是"宁可少删，不能删错"——指针过期只会导致拒绝并说明，不会误删别处。
Function un.XiaomoGuard
  StrCpy $R8 ""
  StrCpy $R6 "ok"

  ${IfNot} ${FileExists} "$R5\xiaomo.db"
    StrCpy $R8 "没看到 xiaomo.db，不认为这是数据目录"
    StrCpy $R6 "no-db"
  ${EndIf}

  ${If} $R8 == ""
    StrLen $R9 "$R5"
    ${If} $R9 < 7
      StrCpy $R8 "路径过短"
      StrCpy $R6 "too-short"
    ${EndIf}
  ${EndIf}

  ; 盘根：结尾是 ":" 或 ":"+"\"
  ${If} $R8 == ""
    StrCpy $R7 "$R5" -1
    ${If} "$R7" == ":"
      StrCpy $R8 "指向盘根"
      StrCpy $R6 "drive-root"
    ${EndIf}
  ${EndIf}
  ${If} $R8 == ""
    StrCpy $R7 "$R5" -2
    ${If} "$R7" == ":\"
      StrCpy $R8 "指向盘根"
      StrCpy $R6 "drive-root"
    ${EndIf}
  ${EndIf}

  ; 系统目录前缀：长度从变量来，不写死盘符（StrCmp 默认忽略大小写）
  ${If} $R8 == ""
    StrLen $R9 "$WINDIR"
    StrCpy $R7 "$R5" $R9
    ${If} "$R7" == "$WINDIR"
      StrCpy $R8 "指向系统目录"
      StrCpy $R6 "win-dir"
    ${EndIf}
  ${EndIf}
  ${If} $R8 == ""
    StrLen $R9 "$PROGRAMFILES"
    StrCpy $R7 "$R5" $R9
    ${If} "$R7" == "$PROGRAMFILES"
      StrCpy $R8 "指向程序安装目录"
      StrCpy $R6 "progfiles"
    ${EndIf}
  ${EndIf}
  ${If} $R8 == ""
    StrLen $R9 "$PROGRAMFILES64"
    StrCpy $R7 "$R5" $R9
    ${If} "$R7" == "$PROGRAMFILES64"
      StrCpy $R8 "指向程序安装目录"
      StrCpy $R6 "progfiles"
    ${EndIf}
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    !insertmacro XIAOMO_READ_POINTER
    ${If} "$R5" == ""
      ; 指针缺失（老版本装的、或没起过应用）：退回默认推导——安装目录同级 xiaomodata
      StrCpy $R5 "$INSTDIR\..\xiaomodata"
    ${EndIf}
    Call un.XiaomoGuard

    ${If} $R8 == ""
      RmDir /r "$R5"
      ${If} ${FileExists} "$R5\xiaomo.db"
        ; 还有文件被占用，没删净
        ${IfNot} ${Silent}
          MessageBox MB_OK|MB_ICONEXCLAMATION "部分数据没能删除：$\r$\n$R5$\r$\n请确认小茉已退出后，手动删除这个文件夹。"
        ${EndIf}
      ${EndIf}
    ${Else}
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONINFORMATION "小茉没有删除数据目录（$R8）：$\r$\n$R5$\r$\n确认后可以手动删除它。"
      ${EndIf}
    ${EndIf}

    !ifdef XIAOMO_UNINSTALL_TEST
      ; 测试模式：把这一轮的结果落到日志，供外部断言（不弹任何窗）。
      ; 别写 $($R5\xiaomo.db)——括号里套路径会被 NSIS 当成 LangString 引用，-WX 下直接失败。
      ${If} ${FileExists} "$R5\xiaomo.db"
        StrCpy $R4 "yes"
      ${Else}
        StrCpy $R4 "no"
      ${EndIf}
      ClearErrors
      FileOpen $8 "$INSTDIR\result.log" a
      ${IfNot} ${Errors}
        FileSeek $8 0 END
        FileWrite $8 "dir=$R5$\r$\nreason=$R6$\r$\nexists=$R4$\r$\n"
        FileClose $8
      ${EndIf}
    !endif
  ${EndIf}
!macroend

!endif
