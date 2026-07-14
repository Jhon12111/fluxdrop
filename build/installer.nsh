!macro customInstall
  ; Allow FluxDrop through Windows Firewall on private/domain networks
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FluxDrop"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="FluxDrop" dir=in action=allow program="$INSTDIR\FluxDrop.exe" enable=yes profile=private,domain'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FluxDrop"'
!macroend
