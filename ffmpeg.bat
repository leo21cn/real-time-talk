@echo off
REM Wrapper: runs ffmpeg inside Docker server image (Linux binary can't run on Windows)
REM All arguments are forwarded. File paths are mounted at same location in container.

set ARGS=%*
REM Convert Windows backslashes to forward slashes for Docker volume paths
set ARGS=%ARGS:\=/%
docker run --rm -v "d:/szp/work/real-time-talk/_work:/app/_work" --entrypoint ffmpeg real-time-talk-server %ARGS%
