$ffmpeg = 'C:\Users\leo21\AppData\Local\Programs\Python\Python312\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe'
$idle = 'd:\szp\work\real-time-talk\clips\short-hair-teacher-girl\idle\idle_breathing.webm'
$out = 'd:\szp\work\real-time-talk\_check_idle'

New-Item -ItemType Directory -Force -Path $out | Out-Null

& $ffmpeg -y -i $idle -vframes 1 -q:v 2 "$out\first_frame.png" 2>&1
Write-Host "First frame extracted: $?"

& $ffmpeg -y -sseof -1 -i $idle -vframes 1 -q:v 2 "$out\last_frame.png" 2>&1
Write-Host "Last frame extracted: $?"

Write-Host "DONE"
