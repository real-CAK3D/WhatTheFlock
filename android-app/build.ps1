# Builds the Flock You Android app (debug-signed APK, for sideloading).
#   powershell -ExecutionPolicy Bypass -File G:\flock-you\android-app\build.ps1
# Output: G:\flock-you\FlockYou.apk
# Everything (JDK, SDK, Gradle and npm caches) lives on G:.
$ErrorActionPreference = 'Stop'
$root = 'G:\flock-you'; $app = "$root\android-app"; $www = "$app\www"
$env:JAVA_HOME = 'G:\android\jdk'; $env:ANDROID_HOME = 'G:\android\sdk'; $env:ANDROID_SDK_ROOT = 'G:\android\sdk'
$env:ANDROID_USER_HOME = 'G:\android\.android'; $env:GRADLE_USER_HOME = 'G:\.gradle'; $env:npm_config_cache = 'G:\npm-cache'
$env:Path = "G:\android\jdk\bin;$env:Path"

# 1. The web app, copied into the APK (so the phone doesn't need this PC).
if (Test-Path $www) { Get-ChildItem $www -Force | Remove-Item -Recurse -Force }
New-Item -ItemType Directory -Force $www | Out-Null
Get-ChildItem "$root\phone" -Force | Where-Object { $_.Name -notin @('test', 'README.md', 'download') } | Copy-Item -Destination $www -Recurse -Force
Copy-Item "$app\native.js" $www
# Served from the APK root, not /phone/; the native bridge loads before the app.
$html = [IO.File]::ReadAllText("$www\index.html")
$html = $html.Replace('<base href="/phone/">', '<base href="/">').Replace('<script src="vendor/leaflet.js"></script>', "<script src=`"native.js`"></script>`n<script src=`"vendor/leaflet.js`"></script>")
[IO.File]::WriteAllText("$www\index.html", $html, (New-Object Text.UTF8Encoding $false))
$man = [IO.File]::ReadAllText("$www\manifest.webmanifest").Replace('"/phone/"', '"/"')
[IO.File]::WriteAllText("$www\manifest.webmanifest", $man, (New-Object Text.UTF8Encoding $false))

# 2. Sync into the Android project and build.
Push-Location $app
npx cap sync android
"sdk.dir=G\:\\android\\sdk" | Set-Content -Encoding ascii "$app\android\local.properties"
Push-Location "$app\android"
.\gradlew.bat assembleDebug --no-daemon -q
Pop-Location; Pop-Location

Copy-Item "$app\android\app\build\outputs\apk\debug\app-debug.apk" "$root\FlockYou.apk" -Force
# Also publish it for download from the phone: https://<pc>.ts.net/phone/download/FlockYou.apk
New-Item -ItemType Directory -Force "$root\phone\download" | Out-Null
Copy-Item "$root\FlockYou.apk" "$root\phone\download\FlockYou.apk" -Force
Get-Item "$root\FlockYou.apk" | Select-Object FullName, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }
