# Publishes a GitHub release of the What the Flock! app.
#   1. bump android-app/version.json (versionName + versionCode)
#   2. powershell -ExecutionPolicy Bypass -File G:\flock-you\android-app\release.ps1 -Notes "What changed"
# Pushes main, builds the PUBLIC APK (no keys), verifies no key is inside it,
# then creates tag v<version> with the APK attached. Needs `gh` logged in.
# (Native tools report progress on stderr, which Windows PowerShell treats as
# errors under 'Stop', so each step checks its exit code instead.)
param([Parameter(Mandatory)][string]$Notes, [string]$Repo = 'real-CAK3D/WhatTheFlock')
$ErrorActionPreference = 'Continue'
$root = 'G:\flock-you'; $app = "$root\android-app"
$ver = (Get-Content "$app\version.json" -Raw | ConvertFrom-Json).versionName
$tag = "v$ver"

gh release view $tag -R $Repo *> $null
if ($LASTEXITCODE -eq 0) { throw "Release $tag already exists - bump android-app/version.json first." }

git -C $root push wtf phone-webapp:main 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'git push failed' }

& powershell -NoProfile -ExecutionPolicy Bypass -File "$app\build.ps1" -Public 2>&1 | Out-Host
$apk = "$root\release\WhatTheFlock-v$ver.apk"
if (-not (Test-Path $apk)) { throw "Build failed: $apk not found" }

# Belt and braces: refuse to publish if any local key ended up in the APK.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$keys = @()
if (Test-Path "$root\phone\config.local.js") {
  $keys = [regex]::Matches((Get-Content "$root\phone\config.local.js" -Raw), "Key:\s*'([^']{12,})'") | ForEach-Object { $_.Groups[1].Value }
}
$zip = [IO.Compression.ZipFile]::OpenRead($apk)
try {
  foreach ($e in $zip.Entries | Where-Object { $_.FullName -like 'assets/public/*' }) {
    $r = New-Object IO.StreamReader($e.Open()); $txt = $r.ReadToEnd(); $r.Close()
    foreach ($k in $keys) { if ($txt.Contains($k)) { throw "Key found in $($e.FullName) - not publishing." } }
  }
} finally { $zip.Dispose() }
Write-Host "Key check passed ($($keys.Count) local key(s) checked, none in the APK)."

$notesFile = [IO.Path]::GetTempFileName()
[IO.File]::WriteAllText($notesFile, $Notes, (New-Object Text.UTF8Encoding $false))
gh release create $tag $apk -R $Repo --target main --title "What the Flock! $tag" --notes-file $notesFile 2>&1 | Out-Host
Remove-Item $notesFile -ErrorAction SilentlyContinue
# Judge success by the result (gh's exit code through Out-Host proved unreliable).
gh release view $tag -R $Repo *> $null
if ($LASTEXITCODE -ne 0) { throw "Release $tag was not created - see the gh output above." }
Write-Host "Published: https://github.com/$Repo/releases/tag/$tag"
Write-Host "Download:  https://github.com/$Repo/releases/download/$tag/WhatTheFlock-v$ver.apk"
