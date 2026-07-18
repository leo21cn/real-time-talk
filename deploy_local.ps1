<#
.SYNOPSIS
  本地 Docker Desktop 无缓存部署脚本
.DESCRIPTION
  每次执行都会：
  1. 清理前端 dist 目录
  2. --no-cache 构建前端镜像
  3. 从容器提取最新 dist
  4. --no-cache 构建服务端镜像
  5. --force-recreate 重新创建所有容器并重启 nginx
#>

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== 本地无缓存部署 ===" -ForegroundColor Cyan
Write-Host "项目根目录: $ProjectRoot" -ForegroundColor Gray

# 1. 清理 dist
Write-Host "`n[1/5] 清理前端 dist 目录..." -ForegroundColor Yellow
$distPath = Join-Path $ProjectRoot "client\dist"
if (Test-Path $distPath) {
    Get-ChildItem $distPath -Recurse | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "      已清理: $distPath" -ForegroundColor Green
} else {
    New-Item -ItemType Directory -Path $distPath -Force | Out-Null
    Write-Host "      已创建: $distPath" -ForegroundColor Green
}

# 2. 无缓存构建前端
Write-Host "`n[2/5] --no-cache 构建前端镜像..." -ForegroundColor Yellow
Push-Location $ProjectRoot
docker build --no-cache -t realtimetalk-frontend-build -f client/Dockerfile.frontend client
if ($LASTEXITCODE -ne 0) { throw "前端构建失败" }
Write-Host "      前端构建完成" -ForegroundColor Green

# 3. 提取 dist
Write-Host "`n[3/5] 从容器提取 dist 文件..." -ForegroundColor Yellow
$containerName = "tmp-extract-" + (Get-Date -Format "yyyyMMdd-HHmmss")
docker create --name $containerName realtimetalk-frontend-build | Out-Null
docker cp "${containerName}:/app/dist/." "$distPath\"
docker rm $containerName | Out-Null
Write-Host "      dist 提取完成" -ForegroundColor Green

# 4. 无缓存构建服务端
Write-Host "`n[4/5] --no-cache 构建服务端镜像..." -ForegroundColor Yellow
docker compose build --no-cache server
if ($LASTEXITCODE -ne 0) { throw "服务端构建失败" }
Write-Host "      服务端构建完成" -ForegroundColor Green

# 5. 启动服务
Write-Host "`n[5/5] 重新创建容器并启动..." -ForegroundColor Yellow
docker compose up -d --force-recreate
docker compose restart nginx
if ($LASTEXITCODE -ne 0) { throw "服务启动失败" }

Pop-Location

Write-Host "`n=== 部署完成 ===" -ForegroundColor Cyan
Write-Host "验证: http://localhost" -ForegroundColor White
docker compose ps --format "table {{.Service}}\t{{.Status}}"
