param([string]$VencordPath = '')
$ErrorActionPreference = 'Stop'
try {
    if (-not $VencordPath) {
        $candidates = @((Join-Path $env:USERPROFILE 'Documents\Vencord'), (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Vencord'))
        $VencordPath = $candidates | Where-Object { Test-Path (Join-Path $_ 'scripts\build\build.mjs') } | Select-Object -First 1
        if (-not $VencordPath) { throw 'Vencord source was not found in Documents or OneDrive Documents. Supply -VencordPath with the path to your checkout.' }
    }
    $source = Join-Path $PSScriptRoot 'DMsManager'
    if (-not (Test-Path (Join-Path $source 'index.tsx'))) { throw 'Extract the entire ZIP before running this installer.' }
    if (-not (Test-Path (Join-Path $VencordPath 'scripts\build\build.mjs'))) { throw "Vencord source was not found at $VencordPath. Use the manual instructions in README.md or supply -VencordPath." }
    $pnpm = Get-Command pnpm.cmd -ErrorAction Stop
    $plugins = Join-Path $VencordPath 'src\userplugins'
    New-Item -ItemType Directory -Force -Path $plugins | Out-Null
    $target = Join-Path $plugins 'DMsManager'
    if (Test-Path $target) {
        $backup = Join-Path ([Environment]::GetFolderPath('MyDocuments')) ('DMsManagerBackups\' + [Guid]::NewGuid().ToString())
        New-Item -ItemType Directory -Force -Path $backup | Out-Null
        Copy-Item -LiteralPath $target -Destination $backup -Recurse
        Write-Host "Previous source backed up to $backup"
    }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $target -Recurse -Force
    Push-Location $VencordPath
    try {
        & $pnpm.Source build
        if ($LASTEXITCODE -ne 0) { throw "Vencord build failed (exit $LASTEXITCODE). Check the error above; Discord has not been restarted." }
    } finally { Pop-Location }
    Write-Host 'Installed. Fully quit Discord, reopen it, and enable MessagesManager in Vencord settings.' -ForegroundColor Green
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
