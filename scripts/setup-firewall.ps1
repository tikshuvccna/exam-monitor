# Run elevated by start-server.bat on the first run. Lets student PCs on the LAN reach the server.
param([int]$Port = 4555, [int]$TurnPort = 3478)

$ErrorActionPreference = "Stop"
$ruleName = "Exam Monitor $Port"
$failed = $false

function Add-Rule($name, $protocol, $ports) {
  if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) { return }
  try {
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol $protocol -LocalPort $ports -Action Allow -Profile Any | Out-Null
    Write-Host "Added firewall rule '$name' ($protocol $($ports -join ','))."
  } catch {
    Write-Host "FAILED to add '$name': $_"
    $script:failed = $true
  }
}

# TURN first, web rule last: start-server.bat treats the web rule as the "setup done" marker
Add-Rule "$ruleName TURN UDP" "UDP" @($TurnPort, "49152-65535")
Add-Rule $ruleName "TCP" @($Port)

# Windows creates a Block rule for Node.js when someone clicks Cancel on its firewall popup.
# A Block rule overrides Allow rules and silently stops students from connecting.
$blocks = Get-NetFirewallRule -DisplayName "Node.js JavaScript Runtime" -ErrorAction SilentlyContinue |
  Where-Object { $_.Action -eq "Block" -and $_.Direction -eq "Inbound" }
if ($blocks) {
  $blocks | Remove-NetFirewallRule
  Write-Host "Removed $(@($blocks).Count) Windows rule(s) that blocked Node.js."
}

if ($failed) { Start-Sleep -Seconds 10; exit 1 }
Start-Sleep -Seconds 2
