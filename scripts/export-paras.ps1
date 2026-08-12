$dir = "$env:TEMP\para-batches"
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -Force -ItemType Directory $dir | Out-Null
$in = "$env:TEMP\paragraphs-full.sql"
$bytes = [System.IO.File]::ReadAllBytes($in)
$chunk = 80MB
$total = $bytes.Length
$n = 0
for ($i = 0; $i -lt $total; $i += $chunk) {
    $n++
    $len = [Math]::Min($chunk, $total - $i)
    $part = New-Object byte[] $len
    [Array]::Copy($bytes, $i, $part, 0, $len)
    $out = "$dir\para_chunk$($n.ToString('000')).sql"
    [System.IO.File]::WriteAllBytes($out, $part)
}
Write-Output "Split into $n chunks"
