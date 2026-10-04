# Starts the What the Flock! servers that Tailscale forwards to:
#   127.0.0.1:8088  phone app (served at https://<pc>.ts.net/phone/)
#   127.0.0.1:5000  original Flock You Flask dashboard (https://<pc>.ts.net/)
#   127.0.0.1:8090  shared hazard/police reports (https://<pc>.ts.net/reports/)
# Safe to run repeatedly: a server already listening is left alone.
$py = 'G:\flock-you\api\.venv\Scripts\python.exe'
$logs = 'G:\flock-you\logs'
New-Item -ItemType Directory -Force $logs | Out-Null

function Test-Port($p) { [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }

if (-not (Test-Port 8088)) {
  Start-Process -FilePath $py -WindowStyle Hidden `
    -ArgumentList '-m', 'http.server', '8088', '--bind', '127.0.0.1', '--directory', 'G:\flock-you\phone' `
    -RedirectStandardError "$logs\phone.log" -RedirectStandardOutput "$logs\phone.out.log"
}
if (-not (Test-Port 8090)) {
  Start-Process -FilePath $py -WindowStyle Hidden -WorkingDirectory 'G:\flock-you\reports' -ArgumentList 'reports_server.py' `
    -RedirectStandardError "$logs\reports.log" -RedirectStandardOutput "$logs\reports.out.log"
}
if (-not (Test-Port 5000)) {
  $env:FLOCKYOU_HOST = '127.0.0.1'; $env:FLOCKYOU_PORT = '5000'
  Start-Process -FilePath $py -WindowStyle Hidden -WorkingDirectory 'G:\flock-you\api' -ArgumentList 'flockyou.py' `
    -RedirectStandardError "$logs\dashboard.log" -RedirectStandardOutput "$logs\dashboard.out.log"
}
