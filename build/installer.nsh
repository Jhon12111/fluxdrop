!macro customInstall
  ; Allow FluxDrop through Windows Firewall on ALL profiles (incl. Public — many
  ; home Wi-Fi networks are mis-classified as Public, which was blocking
  ; discovery). Needs elevation, which perMachine install provides.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FluxDrop"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="FluxDrop" dir=in action=allow program="$INSTDIR\FluxDrop.exe" enable=yes profile=any'
  ; Explicit UDP discovery + TCP transfer port rules as a belt-and-braces backup.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FluxDrop Discovery"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="FluxDrop Discovery" dir=in action=allow protocol=UDP localport=52130 enable=yes profile=any'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FluxDrop Transfer"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="FluxDrop Transfer" dir=in action=allow protocol=TCP localport=52131 enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FluxDrop"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FluxDrop Discovery"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FluxDrop Transfer"'
!macroend
