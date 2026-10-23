param(
    [string]$Container = $(if ($env:BFMR_POSTGRES_CONTAINER) { $env:BFMR_POSTGRES_CONTAINER } else { 'bfmr-postgres' })
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker is unavailable. Run this on the Windows host with Docker Desktop running, outside the app container.'
}
# Execute the same reviewed clone body as the Linux launcher, inside PostgreSQL.
# No host Bash/WSL, passwords, temporary dumps or SQL text are needed on Windows.
$source = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'clone_test_database.sh') -Raw).Replace("`r`n", "`n")
$match = [regex]::Match($source, "(?s)<<'CLONE'\n(.*?)\nCLONE\s*\z")
if (-not $match.Success) { throw 'Cannot locate the reviewed database clone script body. Update the checkout.' }
# Windows PowerShell adds CRLF when writing native stdin; normalize inside the
# container so the command also works without PowerShell 7 or WSL.
$match.Groups[1].Value | docker exec -i --user postgres $Container bash -o pipefail -c "tr -d '\r' | bash -s"
if ($LASTEXITCODE -ne 0) { throw 'Database clone failed. Review the output above; do not start the test worker.' }
