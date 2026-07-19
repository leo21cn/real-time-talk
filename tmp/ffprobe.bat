@echo off
REM Wrapper: runs ffprobe inside Docker server image
docker run --rm -v "d:/szp/work/real-time-talk/_work:/app/_work" --entrypoint ffprobe real-time-talk-server %*
