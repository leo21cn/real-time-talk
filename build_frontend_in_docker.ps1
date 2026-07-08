# 在 Linux 容器内构建前端（绕开 Windows 上 vite 5.4 html-proxy 路径 bug）
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File build_frontend_in_docker.ps1

$ErrorActionPreference = 'Stop'

$clientDir = "$PSScriptRoot\client"
$imageName = 'realtimetalk-frontend-build'

Write-Host "==> 构建前端 Docker 镜像（linux/amd64）..." -ForegroundColor Cyan
docker build `
  -t $imageName `
  -f Dockerfile.frontend `
  $clientDir

if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: docker build 失败" -ForegroundColor Red
  exit 1
}

Write-Host "==> 在容器内执行 npm run build..." -ForegroundColor Cyan
# 挂载 client/dist 目录，让容器内 build 结果输出到 host
docker run --rm `
  -v "${clientDir}/dist:/app/dist" `
  $imageName

if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: docker run 失败" -ForegroundColor Red
  exit 1
}

Write-Host "==> 前端 build 完成: $clientDir/dist" -ForegroundColor Green
Get-ChildItem "$clientDir\dist" | Select-Object Name | Format-Table -AutoSize