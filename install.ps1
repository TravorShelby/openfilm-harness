param(
  [ValidateSet('Native', 'Mcp')]
  [string]$Mode = 'Native',
  [switch]$ReplaceExistingSkills
)

$ErrorActionPreference = 'Stop'
$IntegrationRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$ServerPath = (Resolve-Path -LiteralPath (Join-Path $IntegrationRoot 'server.mjs')).Path
$NodePath = (Get-Command node -ErrorAction Stop).Source
$null = Get-Command codex -ErrorAction Stop
$NodeVersion = & $NodePath -p 'process.versions.node'
if ([version]$NodeVersion -lt [version]'22.18.0') { throw 'Node.js 22.18 or later is required.' }

if (-not (Test-Path -LiteralPath (Join-Path $IntegrationRoot 'node_modules\openfilm\package.json')) -or
    -not (Test-Path -LiteralPath (Join-Path $IntegrationRoot 'node_modules\@modelcontextprotocol\sdk\package.json'))) {
  Push-Location -LiteralPath $IntegrationRoot
  try {
    & npm ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed (npm exit $LASTEXITCODE)." }
  } finally { Pop-Location }
}

# Back up settings without printing their contents. Never replace settings wholesale.
$CodexSettings = Join-Path $env:USERPROFILE '.codex\config.toml'
$BackupRoot = Join-Path $env:LOCALAPPDATA ('OpenFilm-Harness\install-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
function Backup-IntegrationSkill {
  $SkillBase = (Resolve-Path -LiteralPath (Join-Path $env:USERPROFILE '.agents\skills')).Path
  $SkillTarget = Join-Path $SkillBase 'openfilm-codex'
  $SkillItem = Get-Item -LiteralPath $SkillTarget -Force
  $ResolvedSkill = (Resolve-Path -LiteralPath $SkillTarget).Path
  if (($SkillItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
      (Split-Path -Parent $ResolvedSkill) -ne $SkillBase -or
      $ResolvedSkill -ne (Join-Path $SkillBase 'openfilm-codex')) {
    throw 'Refusing to move a linked skill or a path outside the intended skill directory.'
  }
  Move-Item -LiteralPath $ResolvedSkill -Destination (Join-Path $BackupRoot 'openfilm-codex')
}
if (Test-Path -LiteralPath $CodexSettings) {
  Copy-Item -LiteralPath $CodexSettings -Destination (Join-Path $BackupRoot 'config.toml')
}
$ExistingJson = & codex mcp get openfilm-editor --json 2>$null
$Existing = if ($LASTEXITCODE -eq 0) { ($ExistingJson -join "`n") | ConvertFrom-Json } else { $null }
$ManagedRegistration = $false
if ($Existing) {
  $ManagedRegistration = @($Existing.transport.args) -contains $ServerPath
  if ($Mode -eq 'Mcp' -and -not $ManagedRegistration) {
    throw 'An unrelated MCP registration named openfilm-editor already exists. Use configure.mjs and choose another server name.'
  }
}

if ($Mode -eq 'Native') {
  & codex plugin marketplace add $IntegrationRoot --json
  if ($LASTEXITCODE -ne 0) { throw 'Codex could not add the local marketplace.' }
  & codex plugin add 'openfilm-harness@openfilm-harness-local' --json
  if ($LASTEXITCODE -ne 0) { throw 'Codex could not install the plugin.' }
  if ($ManagedRegistration) {
    & codex mcp remove openfilm-editor
    if ($LASTEXITCODE -ne 0) { throw 'Plugin installed, but the old direct MCP registration could not be removed.' }
  }
  $LegacySkillFile = Join-Path $env:USERPROFILE '.agents\skills\openfilm-codex\SKILL.md'
  if (Test-Path -LiteralPath $LegacySkillFile) {
    # Recognize the exact v0.1 prototype. Modified/custom skills are retained by default.
    $LegacyHash = (Get-FileHash -LiteralPath $LegacySkillFile -Algorithm SHA256).Hash
    if ($LegacyHash -eq '8287B915882B69DE96EE302C40852FE292DFF9F8CF98920CC0A3FCB0ADA6D8D4' -or $ReplaceExistingSkills) {
      Backup-IntegrationSkill
      Write-Output 'Backed up the old global integration skill; the native plugin supplies the current version.'
    } else {
      Write-Output 'Kept the existing global openfilm-codex skill. It may shadow the plugin skill; use -ReplaceExistingSkills to back it up.'
    }
  }
} else {
  # Direct MCP fallback for hosts without native plugin support.
  & codex mcp add openfilm-editor -- $NodePath $ServerPath
  if ($LASTEXITCODE -ne 0) { throw 'Codex could not register the OpenFilm MCP server.' }

  $SkillHome = Join-Path $env:USERPROFILE '.agents\skills'
  New-Item -ItemType Directory -Path $SkillHome -Force | Out-Null
  $SkillHome = (Resolve-Path -LiteralPath $SkillHome).Path
  $TargetSkill = Join-Path $SkillHome 'openfilm-codex'
  $CopySkill = $true
  if (Test-Path -LiteralPath $TargetSkill) {
    if (-not $ReplaceExistingSkills) {
      Write-Output 'Kept the existing openfilm-codex skill. Use -ReplaceExistingSkills to update it with a backup.'
      $CopySkill = $false
    } else {
      Backup-IntegrationSkill
    }
  }
  if ($CopySkill) {
    Copy-Item -LiteralPath (Join-Path $IntegrationRoot 'skills\openfilm-codex') -Destination $TargetSkill -Recurse
  }
}

Write-Output "Installed OpenFilm Harness ($Mode). Settings backup: $BackupRoot"
Write-Output 'Keep this directory in place. Refresh/restart Codex, then open a test film and call get_context to verify the new tools.'
