# Publishes a GitHub release of the What the Flock! app.
#   1. bump android-app/version.json (versionName + versionCode)
#   2. powershell -ExecutionPolicy Bypass -File G:\flock-you\android-app\release.ps1 -Notes "What changed"
# Pushes main, builds the PUBLIC APK (no keys), verifies no key is inside it,
# then creates tag v<version> with the APK attached. Needs `gh` logged in.
param([Parameter(Mandatory)][string]$Notes, [string]$Repo = 'real-CAK3D/WhatTheFlock')
$ErrorActionPreference = 'Stop'
$root = 'G:\flock-you'; $app = "$root\android-app"
$ver = (Get-Content "$app\version.json" -Raw | ConvertFrom-Json).versionName
$tag = "v$ver"
if (gh release view $tag -R $Repo 2>$null) { throw "Release $tag already exists — bump android-app/version.json first." }

Push-Location $root
git push wtf phone-webapp:main
Pop-Location

& "$app\build.ps1" -Public
$apk = "$root\release\WhatTheFlock-v$ver.apk"

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
    foreach ($k in $keys) { if ($txt.Contains($k)) { throw "Key found in $($e.FullName) — not publishing." } }
  }
} finally { $zip.Dispose() }

gh release create $tag $apk -R $Repo --target main --title "What the Flock! $tag" --notes $Notes
gh release view $tag -R $Repo --json url,assets --jq '.url, (.assets[] | .browserDownloadUrl)'
