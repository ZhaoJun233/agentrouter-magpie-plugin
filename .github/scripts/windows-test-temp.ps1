# CI fixtures only. Do not weaken the application's Windows ACL validation.
$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$privateTemp = Join-Path $env:RUNNER_TEMP 'agentrouter-private-temp'
New-Item -ItemType Directory -Force -Path $privateTemp | Out-Null
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544')) {
  $principal = New-Object System.Security.Principal.SecurityIdentifier($sid)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -Path $privateTemp -AclObject $acl
"TEMP=$privateTemp" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"TMP=$privateTemp" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Write-Host "Fixture account SID: $($identity.User.Value)"
Write-Host "Private fixture ACL: $((Get-Acl -Path $privateTemp).Sddl)"
