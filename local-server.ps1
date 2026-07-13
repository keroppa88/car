param(
    [ValidateRange(1024, 65525)]
    [int]$Port = 8000,

    [switch]$NoBrowser,

    [string]$StartPath = '/'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$listener = $null

function Get-ContentType([string]$Path) {
    switch ([IO.Path]::GetExtension($Path).ToLowerInvariant()) {
        '.html' { 'text/html; charset=utf-8' }
        '.js'   { 'text/javascript; charset=utf-8' }
        '.css'  { 'text/css; charset=utf-8' }
        '.json' { 'application/json; charset=utf-8' }
        '.gltf' { 'model/gltf+json' }
        '.glb'  { 'model/gltf-binary' }
        '.vox'  { 'application/octet-stream' }
        '.png'  { 'image/png' }
        '.jpg'  { 'image/jpeg' }
        '.jpeg' { 'image/jpeg' }
        '.svg'  { 'image/svg+xml' }
        '.ico'  { 'image/x-icon' }
        '.wav'  { 'audio/wav' }
        '.mp3'  { 'audio/mpeg' }
        default { 'application/octet-stream' }
    }
}

function Write-Response(
    [Net.Sockets.NetworkStream]$Stream,
    [int]$StatusCode,
    [string]$StatusText,
    [string]$ContentType,
    [byte[]]$Body,
    [bool]$HeadOnly = $false
) {
    $headers = "HTTP/1.1 $StatusCode $StatusText`r`n" +
               "Content-Type: $ContentType`r`n" +
               "Content-Length: $($Body.Length)`r`n" +
               "Cache-Control: no-cache`r`n" +
               "Connection: close`r`n`r`n"
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($headers)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if (-not $HeadOnly -and $Body.Length -gt 0) {
        $Stream.Write($Body, 0, $Body.Length)
    }
}

try {
    for ($candidate = $Port; $candidate -le ($Port + 10); $candidate++) {
        try {
            $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $candidate)
            $listener.Start()
            $Port = $candidate
            break
        }
        catch [Net.Sockets.SocketException] {
            $listener = $null
        }
    }

    if ($null -eq $listener) {
        throw "No free local port was found between $Port and $($Port + 10)."
    }

    if (-not $StartPath.StartsWith('/')) {
        $StartPath = '/' + $StartPath
    }
    $url = "http://127.0.0.1:$Port$StartPath"
    Write-Host 'INITIAL T is running.' -ForegroundColor Green
    Write-Host "Game: $url"
    Write-Host 'Keep this window open while playing.'
    Write-Host 'Press Ctrl+C or close this window to stop the server.'
    Write-Host ''
    if (-not $NoBrowser) {
        Start-Process $url
    }

    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $reader = [IO.StreamReader]::new(
                $stream,
                [Text.Encoding]::ASCII,
                $false,
                1024,
                $true
            )

            $requestLine = $reader.ReadLine()
            if ([string]::IsNullOrWhiteSpace($requestLine)) {
                continue
            }

            do { $headerLine = $reader.ReadLine() } while ($null -ne $headerLine -and $headerLine -ne '')

            $parts = $requestLine.Split(' ')
            if ($parts.Length -lt 2 -or $parts[0] -notin @('GET', 'HEAD')) {
                $body = [Text.Encoding]::UTF8.GetBytes('Method Not Allowed')
                Write-Response $stream 405 'Method Not Allowed' 'text/plain; charset=utf-8' $body
                continue
            }

            $headOnly = $parts[0] -eq 'HEAD'
            $urlPath = ($parts[1] -split '\?', 2)[0]
            $urlPath = [Uri]::UnescapeDataString($urlPath)
            $relativePath = $urlPath.TrimStart('/').Replace('/', [IO.Path]::DirectorySeparatorChar)
            if ([string]::IsNullOrWhiteSpace($relativePath)) {
                $relativePath = 'index.html'
            }

            $requestedPath = [IO.Path]::GetFullPath((Join-Path $root $relativePath))
            $rootPrefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
            if (-not $requestedPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                $body = [Text.Encoding]::UTF8.GetBytes('Forbidden')
                Write-Response $stream 403 'Forbidden' 'text/plain; charset=utf-8' $body $headOnly
                continue
            }

            if (Test-Path -LiteralPath $requestedPath -PathType Container) {
                $requestedPath = Join-Path $requestedPath 'index.html'
            }

            if (-not (Test-Path -LiteralPath $requestedPath -PathType Leaf)) {
                $body = [Text.Encoding]::UTF8.GetBytes('Not Found')
                Write-Response $stream 404 'Not Found' 'text/plain; charset=utf-8' $body $headOnly
                continue
            }

            $body = [IO.File]::ReadAllBytes($requestedPath)
            Write-Response $stream 200 'OK' (Get-ContentType $requestedPath) $body $headOnly
        }
        catch {
            if ($null -ne $stream -and $stream.CanWrite) {
                $body = [Text.Encoding]::UTF8.GetBytes('Internal Server Error')
                Write-Response $stream 500 'Internal Server Error' 'text/plain; charset=utf-8' $body
            }
        }
        finally {
            if ($null -ne $reader) { $reader.Dispose() }
            if ($null -ne $stream) { $stream.Dispose() }
            $client.Dispose()
            $reader = $null
            $stream = $null
        }
    }
}
finally {
    if ($null -ne $listener) {
        $listener.Stop()
    }
}
