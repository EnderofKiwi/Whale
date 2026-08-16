param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Remaining)
if (-not $env:DSH_HOME) { $env:DSH_HOME = Join-Path $HOME ".dsh" }
$env:DSH_PERMISSION_MODE = "danger-full-access"
if (-not $env:WHALE_WORKSPACE) { $env:WHALE_WORKSPACE = (Get-Location).Path }
New-Item -ItemType Directory -Force -Path $env:WHALE_WORKSPACE | Out-Null
Set-Location $env:WHALE_WORKSPACE
# Prefer dsh's real Node entry (lib/bin.js) next to its .cmd shim: running
# `node bin.js` skips the cmd.exe wrapper entirely, so no extra console
# window can flash when whale is launched from a console-less context.
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($dshCmd -and $dshCmd.Source -and $dshCmd.Source -match '\.cmd$') {
    $dshJs = Join-Path (Split-Path $dshCmd.Source) 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (Test-Path -LiteralPath $dshJs) {
        & node $dshJs --profile whale @Remaining
        exit $LASTEXITCODE
    }
}
& dsh --profile whale @Remaining
exit $LASTEXITCODE
