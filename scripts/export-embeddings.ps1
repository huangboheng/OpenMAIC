$pg = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
$dir = "$env:TEMP\emb-batches"
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -Force -ItemType Directory $dir | Out-Null
$step = 25000
$batches = 24
Write-Output "Exporting $batches batches of $step rows each..."

for ($b = 0; $b -lt $batches; $b++) {
    $offset = $b * $step
    $num = "{0:D2}" -f $b
    $batchNum = $b + 1
    $out = "$dir\emb_batch${num}.sql"
    $sql = "\copy (SELECT * FROM classics_paragraph_embeddings ORDER BY paragraph_id LIMIT $step OFFSET $offset) TO '$out' WITH (FORMAT text)"
    Write-Output "Batch ${batchNum}/${batches}: offset=${offset}..."
    & $pg -h localhost -p 5999 -U philochora -d philochora -c $sql 2>&1 | Out-Null
    if (Test-Path $out) {
        $s = [math]::Round((Get-Item $out).Length / 1MB, 1)
        Write-Output "  OK: ${s} MB"
    } else {
        Write-Output "  FAILED"
    }
}
Write-Output "Export done"
