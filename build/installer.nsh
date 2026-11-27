; Secure Network inbound HTTPS rule. Needs an elevated installer; otherwise netsh fails quietly
; and Settings offers a one-time fix. Rules are removed by name only.

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FloCafe Secure Network"'
  Pop $0
  nsExec::Exec 'netsh advfirewall firewall add rule name="FloCafe Secure Network" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" protocol=TCP localport=443,3441-3470 profile=private remoteip=localsubnet enable=yes'
  Pop $0
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FloCafe Secure Network"'
  Pop $0
!macroend
