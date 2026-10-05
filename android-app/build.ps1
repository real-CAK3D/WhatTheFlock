# Builds the What the Flock! Android app (APK for sideloading).
#   powershell -ExecutionPolicy Bypass -File G:\flock-you\android-app\build.ps1           personal build
#   powershell -ExecutionPolicy Bypass -File G:\flock-you\android-app\build.ps1 -Public   GitHub release build
# Personal: G:\flock-you\WhatTheFlock.apk, also served at https://<pc>.ts.net/phone/download/
#           (includes phone/config.local.js, i.e. your TomTom key).
# Public:   G:\flock-you\release\WhatTheFlock-v<version>.apk — WITHOUT config.local.js, so no
#           keys ship; the key is entered once in the app (Settings → Traffic).
# Version comes from android-app/version.json. Everything (JDK, SDK, caches) lives on G:.
param([switch]$Public)
$ErrorActionPreference = 'Stop'
$root = 'G:\flock-you'; $app = "$root\android-app"; $www = "$app\www"
$env:JAVA_HOME = 'G:\android\jdk'; $env:ANDROID_HOME = 'G:\android\sdk'; $env:ANDROID_SDK_ROOT = 'G:\android\sdk'
$env:ANDROID_USER_HOME = 'G:\android\.android'; $env:GRADLE_USER_HOME = 'G:\.gradle'; $env:npm_config_cache = 'G:\npm-cache'
$env:Path = "G:\android\jdk\bin;$env:Path"
$utf8 = New-Object Text.UTF8Encoding $false
$ver = Get-Content "$app\version.json" -Raw | ConvertFrom-Json

# 1. The web app, copied into the APK (so the phone doesn't need this PC).
if (Test-Path $www) { Get-ChildItem $www -Force | Remove-Item -Recurse -Force }
New-Item -ItemType Directory -Force $www | Out-Null
$skip = @('test', 'README.md', 'download')
if ($Public) { $skip += 'config.local.js' }   # never ship keys in a public build
Get-ChildItem "$root\phone" -Force | Where-Object { $_.Name -notin $skip } | Copy-Item -Destination $www -Recurse -Force
Copy-Item "$app\native.js" $www
[IO.File]::WriteAllText("$www\version.js", "window.FY_VERSION = '$($ver.versionName)'; window.FY_PUBLIC_BUILD = $(if ($Public) {'true'} else {'false'});`n", $utf8)
# Served from the APK root, not /phone/; version + native bridge load before the app.
$html = [IO.File]::ReadAllText("$www\index.html")
$html = $html.Replace('<base href="/phone/">', '<base href="/">').Replace('<script src="vendor/leaflet.js"></script>', "<script src=`"version.js`"></script>`n<script src=`"native.js`"></script>`n<script src=`"vendor/leaflet.js`"></script>")
if ($Public) { $html = $html.Replace("<script src=`"config.local.js`"></script>`n", '') }
[IO.File]::WriteAllText("$www\index.html", $html, $utf8)
$man = [IO.File]::ReadAllText("$www\manifest.webmanifest").Replace('"/phone/"', '"/"')
[IO.File]::WriteAllText("$www\manifest.webmanifest", $man, $utf8)

# 2. Version into the Android project, sync and build.
$gradle = "$app\android\app\build.gradle"
$g = [IO.File]::ReadAllText($gradle)
$g = [regex]::Replace($g, 'versionCode \d+', "versionCode $($ver.versionCode)")
$g = [regex]::Replace($g, 'versionName "[^"]*"', "versionName `"$($ver.versionName)`"")
[IO.File]::WriteAllText($gradle, $g, $utf8)
Push-Location $app
npx cap sync android
"sdk.dir=G\:\\android\\sdk" | Set-Content -Encoding ascii "$app\android\local.properties"
Push-Location "$app\android"
.\gradlew.bat assembleDebug --no-daemon -q
Pop-Location; Pop-Location
$apk = "$app\android\app\build\outputs\apk\debug\app-debug.apk"

# 3. Outputs. Same appId and signing key every time, so it installs over the old app and keeps its data.
#    (The signing key is G:\android\.android\debug.keystore — back it up; a new key means uninstalling first.)
if ($Public) {
  New-Item -ItemType Directory -Force "$root\release" | Out-Null
  $out = "$root\release\WhatTheFlock-v$($ver.versionName).apk"
  Copy-Item $apk $out -Force
} else {
  $out = "$root\WhatTheFlock.apk"
  Copy-Item $apk $out -Force
  New-Item -ItemType Directory -Force "$root\phone\download" | Out-Null
  Copy-Item $out "$root\phone\download\WhatTheFlock.apk" -Force
  Copy-Item $out "$root\phone\download\FlockYou.apk" -Force   # old link keeps working
}
Get-Item $out | Select-Object FullName, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }
