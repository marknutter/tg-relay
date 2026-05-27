<#
.SYNOPSIS
  Windows installer for tg-relay (PowerShell port of install.sh).

.DESCRIPTION
  1. Registers the daemon as a user-level Scheduled Task (runs at logon,
     restarts on crash) — the Windows analogue of the macOS launchd LaunchAgent.
  2. Redirects the built-in telegram plugin's .mcp.json to run tg-relay's
     plugin.ts (hijacks every cached version).
  3. Enables the plugin in Claude Code settings.
  4. Installs the claude-channel-add helper.

  Run from a normal (non-elevated) PowerShell — the task runs as you, in your
  user session, so it can read ~/.claude/channels/. Do NOT run elevated; an
  admin/SYSTEM task would not see your user profile (see the cloudflared
  LocalSystem profile pitfall).
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Write UTF-8 WITHOUT a BOM. Windows PowerShell 5.1's `Set-Content -Encoding
# UTF8` prepends a BOM (U+FEFF). A BOM in settings.json or .mcp.json breaks the
# JSON parsers that read them (Node's JSON.parse throws on a leading BOM).
function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding $false))
}

$ScriptDir   = $PSScriptRoot
$TaskName    = 'tg-relay daemon'
$DaemonEntry = Join-Path $ScriptDir 'src\daemon.ts'
$PluginEntry = Join-Path $ScriptDir 'src\plugin.ts'
$ClaudeHome  = Join-Path $env:USERPROFILE '.claude'
$CachedPlugin = Join-Path $ClaudeHome 'plugins\cache\claude-plugins-official\telegram'
$ChannelsRoot = if ($env:TG_RELAY_CHANNELS_ROOT) { $env:TG_RELAY_CHANNELS_ROOT } else { Join-Path $ClaudeHome 'channels' }
$LogFile     = Join-Path $ChannelsRoot 'telegram-router.log'

Write-Host "tg-relay installer (Windows)"
Write-Host "============================"
Write-Host ""

# ── Prerequisite: Bun ─────────────────────────────────────────────────────────
$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunCmd) {
  Write-Error "bun not found on PATH. Install it with 'winget install Oven-sh.Bun' (or from https://bun.sh), then restart your shell and re-run."
  exit 1
}
$Bun = $bunCmd.Source
Write-Host "Using bun at: $Bun"

# Install dependencies if needed
if (-not (Test-Path (Join-Path $ScriptDir 'node_modules'))) {
  Write-Host "Installing dependencies..."
  Push-Location $ScriptDir
  & $Bun install
  Pop-Location
}

# Ensure the log file's parent dir exists
New-Item -ItemType Directory -Path (Split-Path $LogFile -Parent) -Force | Out-Null

# ── 1. Register the daemon as a user-level Scheduled Task ──────────────────────
Write-Host ""
Write-Host "1. Registering daemon scheduled task..."

# Remove any prior registration so we always install the current definition.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "   Removing existing task..."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute $Bun -Argument "`"$DaemonEntry`"" -WorkingDirectory $ScriptDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Mirror launchd KeepAlive + ThrottleInterval(5s): restart on crash, run
# indefinitely, start when available after a missed logon.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
# Run as the logged-in user, in the interactive session (not SYSTEM).
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Write-Host "   Registered '$TaskName' (runs at logon, restarts on crash)."

# Start it now so we don't have to wait for the next logon.
Start-ScheduledTask -TaskName $TaskName
Write-Host "   Started. Daemon polls all configured bots under $ChannelsRoot\telegram-*\"

# ── 2. Hijack the built-in telegram plugin to run tg-relay ────────────────────
# Claude Code only delivers channel notifications to servers named in --channels.
# We redirect the built-in plugin's .mcp.json to run our plugin.ts instead.
Write-Host ""
Write-Host "2. Configuring plugin..."

$hijacked = 0
if (Test-Path $CachedPlugin) {
  $mcpContent = @{
    mcpServers = @{
      telegram = @{
        command = $Bun
        args    = @($PluginEntry)
      }
    }
  } | ConvertTo-Json -Depth 10

  foreach ($versionDir in (Get-ChildItem $CachedPlugin -Directory)) {
    $mcpJson = Join-Path $versionDir.FullName '.mcp.json'
    if (Test-Path $mcpJson) {
      if (-not (Test-Path "$mcpJson.bak")) { Copy-Item $mcpJson "$mcpJson.bak" }
      Write-Utf8NoBom $mcpJson $mcpContent
      Write-Host "   Redirected $mcpJson -> $PluginEntry"
      $hijacked++
    }

    # Also patch cached skills so /telegram:access etc. use per-channel state dirs.
    foreach ($skill in @('access', 'configure', 'heartbeat')) {
      $srcSkill = Join-Path $ScriptDir "skills\$skill\SKILL.md"
      $dstSkill = Join-Path $versionDir.FullName "skills\$skill\SKILL.md"
      if (-not (Test-Path $srcSkill)) { continue }
      if ((Test-Path $dstSkill) -and -not (Test-Path "$dstSkill.bak")) { Copy-Item $dstSkill "$dstSkill.bak" }
      New-Item -ItemType Directory -Path (Split-Path $dstSkill -Parent) -Force | Out-Null
      Copy-Item $srcSkill $dstSkill -Force
      Write-Host "   Patched $dstSkill"
    }
  }
}

if ($hijacked -eq 0) {
  Write-Host "   Warning: built-in telegram plugin not found in cache."
  Write-Host "   Make sure telegram@claude-plugins-official is installed."
} else {
  Write-Host "   Hijacked $hijacked cached version(s)."
}

# ── 3. Enable the plugin in settings (native JSON, no python3) ─────────────────
Write-Host ""
Write-Host "3. Configuring settings..."

$settingsFile = Join-Path $ClaudeHome 'settings.json'
if (Test-Path $settingsFile) {
  try {
    $data = Get-Content $settingsFile -Raw | ConvertFrom-Json
    if ($null -eq $data.enabledPlugins) {
      $data | Add-Member -NotePropertyName 'enabledPlugins' -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    $data.enabledPlugins | Add-Member -NotePropertyName 'telegram@claude-plugins-official' -NotePropertyValue $true -Force
    Write-Utf8NoBom $settingsFile ($data | ConvertTo-Json -Depth 20)
    Write-Host "   Enabled telegram plugin in settings (runs tg-relay code)."
  } catch {
    Write-Host "   Warning: could not patch settings.json: $_"
  }
}

# ── 4. Install claude-channel-add helper ──────────────────────────────────────
Write-Host ""
Write-Host "4. Installing claude-channel-add helper..."

$binDir = Join-Path $env:USERPROFILE 'bin'
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
$helperSrc = Join-Path $ScriptDir 'bin\claude-channel-add.ps1'
$helperDst = Join-Path $binDir 'claude-channel-add.ps1'
if (Test-Path $helperSrc) {
  Copy-Item $helperSrc $helperDst -Force
  Write-Host "   Installed: $helperDst"
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$binDir*") {
    Write-Host "   Note: $binDir is not on your user PATH."
    Write-Host "   Add it with:"
    Write-Host "     [Environment]::SetEnvironmentVariable('Path', `"`$env:USERPROFILE\bin;`" + [Environment]::GetEnvironmentVariable('Path','User'), 'User')"
  }
}

# ── 5. Shell alias (PowerShell profile) ───────────────────────────────────────
Write-Host ""
Write-Host "5. Shell alias"
Write-Host ""
Write-Host "   Add this function to your PowerShell profile (`$PROFILE):"
Write-Host ""
Write-Host '   function claude! { claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official @args }'
Write-Host ""
Write-Host "   The --channels flag is required for Claude Code to accept channel notifications."

Write-Host ""
Write-Host "Done! The daemon is running as a scheduled task and polling bots under:"
Write-Host "  $ChannelsRoot\telegram-*\"
Write-Host ""
Write-Host "Add a channel:    claude-channel-add.ps1 <name> <bot-token>"
Write-Host "Check daemon logs: Get-Content '$LogFile' -Tail 40 -Wait"
Write-Host "Manage the task:   Get-ScheduledTask '$TaskName' | Get-ScheduledTaskInfo"
