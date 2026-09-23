param(
    [ValidateSet('preview', 'map', 'apply', 'watch')]
    [string]$Action = 'preview',
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ToolOptions
)

$ErrorActionPreference = 'Stop'
$addedVariables = [System.Collections.Generic.List[string]]::new()

function Set-EphemeralSecret {
    param([string]$Name, [string]$Prompt)
    if ([Environment]::GetEnvironmentVariable($Name)) { return }
    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        [Environment]::SetEnvironmentVariable($Name, [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer), 'Process')
        $addedVariables.Add($Name)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

try {
    Set-EphemeralSecret -Name 'AMRS_SYNC_CREDENTIAL' -Prompt 'AMRS 個人 Token 或 Deploy ID'
    if ($Action -eq 'apply' -or $Action -eq 'watch') {
        if (-not $env:AFTERSALES_SYNC_USERNAME) {
            $env:AFTERSALES_SYNC_USERNAME = Read-Host 'aftersales 已啟用帳戶名稱'
            $addedVariables.Add('AFTERSALES_SYNC_USERNAME')
        }
        Set-EphemeralSecret -Name 'AFTERSALES_SYNC_PASSWORD' -Prompt 'aftersales 密碼'
    }
    & node (Join-Path $PSScriptRoot 'cli.mjs') $Action @ToolOptions
    $toolExitCode = $LASTEXITCODE
} finally {
    foreach ($name in $addedVariables) {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
}

exit $toolExitCode
