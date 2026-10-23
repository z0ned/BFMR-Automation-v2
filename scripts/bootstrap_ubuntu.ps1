param(
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')]
    [string]$ContainerName = ('bfmr-ubuntu-test-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) {
    throw 'Run this launcher from a complete BFMR Git checkout.'
}
if ($repo.Contains(',')) { throw 'Move the checkout to a path without commas before using the Docker bind mount.' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker is unavailable. Run this in Windows PowerShell with Docker Desktop installed.'
}
$null = & docker info --format '{{.ServerVersion}}'
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is not ready. Start it, then rerun this command.' }
$existing = @(& docker container ls -a --format '{{.Names}}')
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Docker containers. Nothing was installed.' }
if ($existing -contains $ContainerName) {
    throw "Container $ContainerName already exists. It was preserved. Choose another -ContainerName for a fresh installation."
}
Write-Host "Creating clean Ubuntu 24.04 container: $ContainerName"
$mount = "type=bind,source=$repo,target=/source,readonly"
$null = & docker run -d --name $ContainerName --shm-size=1g --mount $mount ubuntu:24.04 sleep infinity
if ($LASTEXITCODE -ne 0) { throw 'Could not create the Ubuntu container. Inspect Docker output above.' }
# This command is interpreted only by Bash INSIDE Ubuntu. It neither uses WSL
# nor executes the Windows-mounted file before normalizing its CRLF endings.
$bootstrap = @'
set -euo pipefail
sed 's/\r$//' /source/scripts/bootstrap_ubuntu.sh > /tmp/bfmr-bootstrap.sh
bash /tmp/bfmr-bootstrap.sh --container --source-dir /source
'@
$bootstrap = $bootstrap.Replace("`r`n", "`n")
Write-Host 'Installing BFMR. Package/browser downloads may take several minutes.'
& docker exec $ContainerName bash -c $bootstrap
if ($LASTEXITCODE -ne 0) {
    throw "Bootstrap failed. Container $ContainerName was preserved for inspection. No automatic deletion or database reset was attempted."
}
Write-Host ''
Write-Host "Installation complete in $ContainerName. Both workers remain stopped."
Write-Host 'PostgreSQL remains running in the retained container.'
Write-Host "Open it when needed: docker exec -it $ContainerName bash"
Write-Host 'Private configuration is in /etc/bfmr/production.env and /etc/bfmr/testing.env.'
