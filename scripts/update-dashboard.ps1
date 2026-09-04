# Runs the daily Google-reviews scrape + merge for the Queen of Sheba reviews
# dashboard. Invoked daily by a Windows Scheduled Task
# ("QueenOfShebaReviewsAutoUpdate"). Safe to run manually too.
#
# NOTE ON ERROR HANDLING (same lesson as housing-dashboard, 2026-08-13):
# Do NOT set $ErrorActionPreference='Stop' globally here, and do NOT capture
# the claude call with `2>&1` into a variable. In Windows PowerShell 5.1 that
# combination turns any stderr line from a native exe into a TERMINATING
# NativeCommandError, which kills the script before it logs anything.
# Native streams are redirected to files instead, which does not wrap them.

$ErrorActionPreference = 'Continue'

$repoDir = "C:\Users\Ayelet Lironne\queen-of-sheba-reviews-dashboard"
$logDir = Join-Path $repoDir "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$logFile = Join-Path $logDir "update-$timestamp.log"
$outFile = Join-Path $logDir "claude-stdout-$timestamp.txt"
$errFile = Join-Path $logDir "claude-stderr-$timestamp.txt"

function Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

Log "=== Starting daily reviews update ==="
Log "PowerShell: $($PSVersionTable.PSVersion) | User: $env:USERNAME"

Set-Location $repoDir

$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($null -eq $claudeCmd) {
    Log "FATAL: 'claude' not found on PATH in this shell. Aborting."
    exit 1
}
Log "claude resolved to: $($claudeCmd.Source)"

$pullOut = & git pull --quiet 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Log "FATAL: git pull failed (exit $LASTEXITCODE): $pullOut"
    exit 1
}
Log "git pull ok."

if (-not (Test-Path (Join-Path $repoDir "node_modules"))) {
    Log "node_modules missing, running npm install..."
    $npmOut = & npm install 2>&1 | Out-String
    Log "npm install output: $npmOut"
}

$promptFile = Join-Path $repoDir "scripts\update-prompt.txt"
if (-not (Test-Path $promptFile)) {
    Log "FATAL: prompt file missing at $promptFile"
    exit 1
}
$prompt = Get-Content $promptFile -Raw -Encoding utf8
Log "Prompt loaded ($($prompt.Length) chars). Invoking claude -p ..."

$prompt | & claude -p `
    --permission-mode bypassPermissions `
    --tools "Bash,Read,Write,Edit,Glob,Grep,WebSearch" `
    --model claude-sonnet-5 `
    --output-format text `
    --no-session-persistence 1> $outFile 2> $errFile

$claudeExit = $LASTEXITCODE
Log "claude exited with code: $claudeExit"

if (Test-Path $outFile) {
    $stdout = Get-Content $outFile -Raw -Encoding utf8
    if ($stdout -and $stdout.Trim().Length -gt 0) {
        Log "--- claude stdout ---"
        $stdout.TrimEnd() -split "`n" | ForEach-Object { Log "  $_" }
    } else {
        Log "(claude produced no stdout)"
    }
}

if (Test-Path $errFile) {
    $stderr = Get-Content $errFile -Raw -Encoding utf8
    if ($stderr -and $stderr.Trim().Length -gt 0) {
        Log "--- claude stderr ---"
        $stderr.TrimEnd() -split "`n" | ForEach-Object { Log "  $_" }
    }
}

Log "=== Run finished (claude exit $claudeExit) ==="
exit $claudeExit
