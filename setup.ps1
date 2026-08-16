<#
.SYNOPSIS
    Whale one-command installer: downloads the project from GitHub, installs
    dependencies, links the `whale` CLI, and sets the user environment
    variables so everything works from any new terminal.

.DESCRIPTION
    Designed to be triggered by a single npm command:

        npx --yes github:EnderofKiwi/Whale setup
        npm run setup                 (inside a cloned repo)

    Steps (each can be skipped):
      1. Download the project  (git clone / pull)  -> -SkipClone
      2. npm install             (project deps)     -> -SkipDeps
      3. Global installs         (dsh + whale)      -> -SkipGlobal
      4. User env variables      (setx)             -> -SkipEnv

.PARAMETER Target
    Where the project is downloaded. Default: $HOME\whale.

.PARAMETER Repo
    GitHub repo to download. Default: https://github.com/EnderofKiwi/Whale.git

.PARAMETER Branch
    Git branch to check out. Default: main

.EXAMPLE
    npx --yes github:EnderofKiwi/Whale setup
    powershell -ExecutionPolicy Bypass -File setup.ps1 -Target D:\whale -Repo https://github.com/EnderofKiwi/Whale.git
#>
[CmdletBinding()]
param(
    [string]$Target = "",
    [string]$Repo = "https://github.com/EnderofKiwi/Whale.git",
    [string]$Branch = "main",
    [switch]$SkipClone,
    [switch]$SkipDeps,
    [switch]$SkipGlobal,
    [switch]$SkipEnv
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
    Write-Host "    $Message" -ForegroundColor Green
}

# ---------------------------------------------------------------- resolve target
if ([string]::IsNullOrWhiteSpace($Target)) {
    $Target = Join-Path $HOME "whale"
}
$Target = [System.IO.Path]::GetFullPath($Target)

Write-Host "Whale setup" -ForegroundColor Magenta
Write-Host "  repo  : $Repo ($Branch)"
Write-Host "  target: $Target"

# ---------------------------------------------------------------- 1. download project
if (-not $SkipClone) {
    Write-Step "Downloading project into $Target"
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { throw "git is required but was not found on PATH" }

    if (Test-Path (Join-Path $Target ".git")) {
        Write-Ok "repo already exists -> git pull"
        git -C $Target fetch origin $Branch
        git -C $Target reset --hard "origin/$Branch"
        if ($LASTEXITCODE -ne 0) { throw "git pull failed (exit $LASTEXITCODE)" }
    } elseif (Test-Path $Target) {
        throw "target '$Target' exists but is not a git repo; remove it or pass a different -Target"
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path $Target) | Out-Null
        git clone --branch $Branch --depth 1 $Repo $Target
        if ($LASTEXITCODE -ne 0) { throw "git clone failed (exit $LASTEXITCODE)" }
        Write-Ok "cloned $Repo"
    }
} else {
    Write-Step "Skipping clone (-SkipClone)"
}

if (-not (Test-Path (Join-Path $Target "package.json"))) {
    throw "no package.json under '$Target' — the download did not produce a whale project"
}

# ---------------------------------------------------------------- 2. project deps
if (-not $SkipDeps) {
    Write-Step "npm install (project dependencies)"
    Push-Location $Target
    try {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
        Write-Ok "dependencies installed"
    } finally {
        Pop-Location
    }
} else {
    Write-Step "Skipping npm install (-SkipDeps)"
}

# ---------------------------------------------------------------- 3. global installs
if (-not $SkipGlobal) {
    Write-Step "Installing global CLI: @deepseek-ai/dsh + whale"
    npm install -g "@deepseek-ai/dsh@^0.1.0-rc.6"
    if ($LASTEXITCODE -ne 0) { Write-Warning "global dsh install failed (exit $LASTEXITCODE); 'whale chat/run' will not work until dsh is on PATH" }
    npm install -g $Target
    if ($LASTEXITCODE -ne 0) { throw "global whale install failed (exit $LASTEXITCODE)" }
    Write-Ok "dsh and whale are on PATH (new terminals only)"
} else {
    Write-Step "Skipping global installs (-SkipGlobal)"
}

# ---------------------------------------------------------------- 4. env variables
if (-not $SkipEnv) {
    Write-Step "Setting user environment variables (new terminals only)"
    $home = Join-Path $Target "whale-home"
    $skills = Join-Path $Target "skills"
    $workspace = Join-Path $Target "workspace"
    $bin = Join-Path $Target "bin"
    New-Item -ItemType Directory -Force -Path $workspace | Out-Null

    [Environment]::SetEnvironmentVariable("DSH_HOME", $home, "User")
    [Environment]::SetEnvironmentVariable("WHALE_SKILLS", $skills, "User")
    [Environment]::SetEnvironmentVariable("WHALE_WORKSPACE", $workspace, "User")

    $path = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $path) { $path = "" }
    $parts = $path.Split(';', [System.StringSplitOptions]::RemoveEmptyEntries)
    if ($parts -notcontains $bin) {
        [Environment]::SetEnvironmentVariable("Path", ($path.TrimEnd(';') + ";" + $bin), "User")
        Write-Ok "PATH += $bin"
    } else {
        Write-Ok "PATH already contains $bin"
    }
    Write-Ok "DSH_HOME=$home"
    Write-Ok "WHALE_SKILLS=$skills"
    Write-Ok "WHALE_WORKSPACE=$workspace"
} else {
    Write-Step "Skipping environment variables (-SkipEnv)"
}

# ---------------------------------------------------------------- summary
Write-Step "Done"
Write-Host ""
Write-Host "Next steps (open a NEW terminal so the env vars apply):" -ForegroundColor Yellow
Write-Host "  1) whale                   # first run: welcome + configure your model"
Write-Host "  2) whale chat              # interactive terminal chat"
Write-Host "  3) whale serve             # gateway + WeChat channel (QR login)"
Write-Host "  4) whale doctor            # sanity check"
Write-Host ""
Write-Host "One-liner alternative (no manual clone needed):" -ForegroundColor Yellow
Write-Host "  npx --yes github:EnderofKiwi/Whale chat"
