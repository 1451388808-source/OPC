# OPC one-click launcher
# Starts MySQL if needed, builds changed sources, then runs Next.js in production mode

$projectPath = 'D:\AI Coding\One Person Company'
$port = 3000
Set-Location $projectPath

function Test-TcpPort($HostName, $Port) {
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect($HostName, $Port)
        $tcp.Close()
        return $true
    }
    catch {
        return $false
    }
}

function Test-Http($Url) {
    try {
        $null = Invoke-WebRequest -Uri $Url -Method GET -TimeoutSec 2 -UseBasicParsing
        return $true
    }
    catch {
        return $false
    }
}

function Test-DevelopmentServer($Url) {
    try {
        $response = Invoke-WebRequest -Uri "$Url/_next/static/development/_devPagesManifest.json" -Method GET -TimeoutSec 2 -UseBasicParsing
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Test-ProductionBuildCurrent($ProjectPath) {
    $buildId = Join-Path $ProjectPath '.next-build\BUILD_ID'
    if (-not (Test-Path -LiteralPath $buildId)) {
        return $false
    }

    $buildTime = (Get-Item -LiteralPath $buildId).LastWriteTimeUtc
    $sourceFiles = @(
        Get-ChildItem -LiteralPath (Join-Path $ProjectPath 'app') -Recurse -File
        Get-ChildItem -LiteralPath (Join-Path $ProjectPath 'lib') -Recurse -File
        Get-Item -LiteralPath (Join-Path $ProjectPath 'next.config.ts')
        Get-Item -LiteralPath (Join-Path $ProjectPath 'package.json')
        Get-Item -LiteralPath (Join-Path $ProjectPath 'package-lock.json')
        Get-Item -LiteralPath (Join-Path $ProjectPath 'tsconfig.json')
    )
    return -not ($sourceFiles | Where-Object { $_.LastWriteTimeUtc -gt $buildTime } | Select-Object -First 1)
}

function Test-Docker {
    try {
        $null = Get-Command docker -ErrorAction Stop
        return $true
    }
    catch {
        return $false
    }
}

function Get-ProcessOwningPort($Port) {
    $conn = netstat -ano | findstr ":$Port"
    foreach ($line in $conn) {
        $parts = $line.Trim() -split '\s+'
        if ($parts[3] -match 'LISTENING') {
            return [int]$parts[4]
        }
    }
    return $null
}

Write-Host ''
Write-Host '[OPC] Starting project...' -ForegroundColor Cyan

# 1. Ensure MySQL is running
if (Test-TcpPort '127.0.0.1' 3306) {
    Write-Host '[OPC] MySQL is already running on 127.0.0.1:3306.' -ForegroundColor Green
}
else {
    Write-Host '[OPC] MySQL not running. Trying Docker Compose...' -ForegroundColor Yellow

    if (Test-Docker) {
        docker compose up -d mysql

        $maxWait = 60
        $waited = 0
        while ((-not (Test-TcpPort '127.0.0.1' 3306)) -and ($waited -lt $maxWait)) {
            Start-Sleep -Seconds 1
            $waited++
        }

        if (Test-TcpPort '127.0.0.1' 3306) {
            Write-Host '[OPC] MySQL is ready.' -ForegroundColor Green
        }
        else {
            Write-Host '[OPC] Warning: MySQL still not reachable. Check Docker logs.' -ForegroundColor Red
        }
    }
    else {
        Write-Host '[OPC] Warning: docker not found. Cannot auto-start MySQL.' -ForegroundColor Red
        Write-Host '        Please start MySQL manually, then run this shortcut again.'
        Write-Host '[OPC] Press any key to exit...'
        $null = [Console]::ReadKey($true)
        exit 1
    }
}

# 2. Reuse current production on port 3000, but replace development or stale production.
$buildCurrent = Test-ProductionBuildCurrent $projectPath
$existingPid = Get-ProcessOwningPort $port
if ($existingPid) {
    $url = "http://localhost:$port"
    if (Test-Http $url) {
        if (Test-DevelopmentServer $url) {
            Write-Host "[OPC] A development server is running on $url. Replacing it with the optimized server..." -ForegroundColor Yellow
            try {
                Stop-Process -Id $existingPid -Force
                Start-Sleep -Seconds 2
            }
            catch {
                Write-Host "[OPC] Could not stop development server process $existingPid." -ForegroundColor Red
                exit 1
            }
        }
        elseif ($buildCurrent) {
            Write-Host "[OPC] The optimized server is already responding on $url. Opening browser..." -ForegroundColor Green
            Start-Process $url
            exit 0
        }
        else {
            Write-Host "[OPC] Application source changed. Restarting the optimized server..." -ForegroundColor Yellow
            try {
                Stop-Process -Id $existingPid -Force
                Start-Sleep -Seconds 2
            }
            catch {
                Write-Host "[OPC] Could not stop stale server process $existingPid." -ForegroundColor Red
                exit 1
            }
        }
    }
    else {
        Write-Host "[OPC] Port $port is occupied by process $existingPid but not responding. Stopping it..." -ForegroundColor Yellow
        try {
            Stop-Process -Id $existingPid -Force
            Start-Sleep -Seconds 2
        }
        catch {
            Write-Host "[OPC] Could not stop process $existingPid. Free port $port and try again." -ForegroundColor Red
            exit 1
        }
    }
}

# 3. Build only when application source is newer than the production build.
if ($buildCurrent) {
    Write-Host '[OPC] Production build is current.' -ForegroundColor Green
}
else {
    Write-Host '[OPC] Building the latest source code...' -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[OPC] Build failed. Fix the error before starting the system.' -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

# 4. Start the production server in the background.
$logDir = Join-Path $projectPath '.opc\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$stdoutLog = Join-Path $logDir 'next-server.log'
$stderrLog = Join-Path $logDir 'next-server-error.log'
Write-Host '[OPC] Starting optimized Next.js server...' -ForegroundColor Cyan
Start-Process npm.cmd -ArgumentList 'run', 'start' -WorkingDirectory $projectPath -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

# 5. Wait for the production server to respond, then open browser.
$maxWait = 30
$waited = 0
$url = "http://localhost:$port"
Write-Host "[OPC] Waiting for $url to be ready..." -ForegroundColor Cyan
while ((-not (Test-Http $url)) -and ($waited -lt $maxWait)) {
    Start-Sleep -Seconds 1
    $waited++
}

if (Test-Http $url) {
    Write-Host "[OPC] Opening $url" -ForegroundColor Green
    Start-Process $url
}
else {
    Write-Host "[OPC] Server did not respond. Check $stderrLog" -ForegroundColor Red
    exit 1
}
