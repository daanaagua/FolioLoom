[CmdletBinding()]
param(
    [Parameter()]
    [string]$ExplicitRoot,

    [Parameter()]
    [switch]$Doctor,

    [Parameter()]
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$nodeCommand = Get-Command node -ErrorAction Stop
$portableResolver = Join-Path $PSScriptRoot "folioloom_env.mjs"
if (-not (Test-Path -LiteralPath $portableResolver -PathType Leaf)) {
    throw "Portable FolioLoom resolver was not found: $portableResolver"
}

$nodeArguments = @($portableResolver)
if ($Doctor) {
    $nodeArguments += "doctor"
} else {
    $nodeArguments += "resolve"
}
if (-not [string]::IsNullOrWhiteSpace($ExplicitRoot)) {
    $nodeArguments += @("--root", $ExplicitRoot)
}
if ($Json) {
    $nodeArguments += "--json"
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$previousOutputEncoding = $OutputEncoding
$previousConsoleOutputEncoding = [Console]::OutputEncoding
try {
    $OutputEncoding = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
    & $nodeCommand.Source @nodeArguments
    $exitCode = $LASTEXITCODE
} finally {
    $OutputEncoding = $previousOutputEncoding
    [Console]::OutputEncoding = $previousConsoleOutputEncoding
}

if ($exitCode -ne 0) {
    exit $exitCode
}
