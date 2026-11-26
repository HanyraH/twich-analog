# Запуск всех сервисов проекта (FastAPI, Go-чат, React-клиент и MediaMTX).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$pythonExe = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $pythonExe)) {
    $pythonExe = 'python'
}

$mediamtxExe = Join-Path $root 'tools\mediamtx\mediamtx.exe'
if (Test-Path $mediamtxExe) {
    Start-Process powershell -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $root 'start-mediamtx.ps1') -WorkingDirectory $root
} else {
    Write-Host "Внимание: $mediamtxExe не найден — MediaMTX не запущен." -ForegroundColor Yellow
    Write-Host "Скачайте Windows amd64 релиз с https://github.com/bluenviron/mediamtx/releases и положите mediamtx.exe в tools\mediamtx\" -ForegroundColor Yellow
}

Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$root\backend'; & '$pythonExe' -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload"
Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$root\chat'; go run ."
Start-Process powershell -ArgumentList '-NoExit', '-Command', "Set-Location '$root\client'; npm run dev"

Write-Host "Сервисы запускаются в отдельных окнах:" -ForegroundColor Cyan
Write-Host "  Клиент (React):  http://localhost:5173"
Write-Host "  Backend (Python): http://127.0.0.1:8000"
Write-Host "  Chat (Go WS):    ws://127.0.0.1:8081/ws"
Write-Host "  MediaMTX:        http://127.0.0.1:8889 (WebRTC), rtmp://127.0.0.1:1935/live (OBS)"
