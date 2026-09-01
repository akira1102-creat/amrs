[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$project = Join-Path $root 'GalaxyLogOffline.csproj'
$release = Join-Path $root 'release'
$publish = Join-Path $root '.work\publish'
$testProject = Join-Path $root 'tests\CsvContractTests.csproj'
New-Item -ItemType Directory -Force -Path $release, $publish | Out-Null
Get-ChildItem -LiteralPath $publish -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force

dotnet restore $project
dotnet run --project $testProject -c Release
if ($LASTEXITCODE -ne 0) { throw 'CSV contract smoke test failed.' }
dotnet publish $project -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None -p:DebugSymbols=false -o $publish
if ($LASTEXITCODE -ne 0) { throw 'Offline tool publish failed.' }
$exe = Join-Path $publish 'GalaxyLogOffline.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "Published EXE not found: $exe" }
$final = Join-Path $release 'GalaxyLogOffline_v1.0.0.exe'
Copy-Item -LiteralPath $exe -Destination $final -Force
Copy-Item -LiteralPath (Join-Path $root 'README.txt') -Destination (Join-Path $release 'README.txt') -Force
$zip = Join-Path $release 'GalaxyLogOffline_v1.0.0.zip'
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -LiteralPath $final -DestinationPath $zip -CompressionLevel Optimal
Write-Host "Release ready: $final"
