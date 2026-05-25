<#
.SYNOPSIS
  Windows port of bin/claude-channel-add.

.DESCRIPTION
  Creates a tg-relay Telegram channel for a Claude Code project:
    1. Creates state dir at ~/.claude/channels/telegram-<name>/
    2. Saves the bot token to .env
    3. Allowlists your Telegram user ID (no pairing dance)

  After running, the tg-relay daemon picks up the new channel within 30s.

  The owner Telegram user ID is resolved in this order:
    1. -Owner <id> parameter
    2. TG_RELAY_OWNER env var
    3. The allowFrom[0] of any existing channel on this machine
    4. Falls back to pairing mode

.EXAMPLE
  claude-channel-add.ps1 mtl 8675038482:AAE1GTuG...
  claude-channel-add.ps1 eve 123:AA... -Owner 987654321
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)] [string] $Name,
  [Parameter(Mandatory = $true, Position = 1)] [string] $Token,
  [string] $Owner
)

$ErrorActionPreference = 'Stop'

# Channel name: lowercase alphanumeric + hyphens only (keeps pipe names simple)
if ($Name -cnotmatch '^[a-z0-9-]+$') {
  Write-Error "Channel name must be lowercase alphanumeric with hyphens."
  exit 1
}

# Token: <digits>:<base64-ish>
if ($Token -notmatch '^[0-9]+:[A-Za-z0-9_-]+$') {
  Write-Error "Token doesn't match bot-token format (123456789:AAHx...)"
  exit 1
}

$channelsRoot = if ($env:TG_RELAY_CHANNELS_ROOT) { $env:TG_RELAY_CHANNELS_ROOT } else { Join-Path $env:USERPROFILE '.claude\channels' }

# Resolve owner: param -> env var -> allowFrom[0] of an existing channel
if (-not $Owner) { $Owner = $env:TG_RELAY_OWNER }
if (-not $Owner) {
  Get-ChildItem -Path $channelsRoot -Filter 'telegram-*' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    if ($Owner) { return }
    $accessFile = Join-Path $_.FullName 'access.json'
    if (Test-Path $accessFile) {
      try {
        $existing = Get-Content $accessFile -Raw | ConvertFrom-Json
        if ($existing.allowFrom -and $existing.allowFrom.Count -gt 0) { $Owner = [string]$existing.allowFrom[0] }
      } catch {}
    }
  }
}

$stateDir = Join-Path $channelsRoot "telegram-$Name"
if (Test-Path $stateDir) {
  Write-Error "$stateDir already exists. Delete it first if you want to recreate."
  exit 1
}

New-Item -ItemType Directory -Path (Join-Path $stateDir 'approved') -Force | Out-Null

# Write .env (profile dir is already user-private; no chmod equivalent needed)
Set-Content -Path (Join-Path $stateDir '.env') -Value "TELEGRAM_BOT_TOKEN=$Token" -Encoding UTF8 -NoNewline

if ($Owner) {
  $access = [ordered]@{
    dmPolicy  = 'allowlist'
    allowFrom = @($Owner)
    groups    = @{}
    pending   = @{}
  }
  $access | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $stateDir 'access.json') -Encoding UTF8
  # Pre-seed the approval marker so the daemon skips the pairing confirmation.
  Set-Content -Path (Join-Path $stateDir "approved\$Owner") -Value $Owner -Encoding UTF8
  Write-Host "Owner $Owner pre-allowlisted. Bot is ready to receive messages from you."
} else {
  $access = [ordered]@{
    dmPolicy  = 'pairing'
    allowFrom = @()
    groups    = @{}
    pending   = @{}
  }
  $access | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $stateDir 'access.json') -Encoding UTF8
  Write-Host "No owner ID provided - channel opens in pairing mode."
  Write-Host "Next: DM the bot, get a 6-char code, run '/telegram:access pair <code>' in a session."
}

Write-Host ""
Write-Host "Channel '$Name' created at $stateDir"
Write-Host "The tg-relay daemon will pick it up within 30s (see telegram-router.log)."
Write-Host ""
Write-Host "To start a session for this channel:"
Write-Host "  cd <project>   # a dir named '$Name', or drop: '$Name' > .claude-channel"
Write-Host "  claude!"
