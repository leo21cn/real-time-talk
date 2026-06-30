"""
Search the idle video for a frame matching the first frame,
to find the natural loop point.
"""
import subprocess, os, tempfile, numpy as np
from PIL import Image

ffmpeg = r'C:\Users\leo21\AppData\Local\Programs\Python\Python312\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe'
idle = r'd:\szp\work\real-time-talk\clips\short-hair-teacher-girl\idle\idle_breathing.webm'
out_dir = r'd:\szp\work\real-time-talk\_check_idle'

# Load first frame
first = np.array(Image.open(os.path.join(out_dir, 'first_frame.png'))).astype(np.float32)

# Extract frames at regular intervals (every 10 frames = 0.4s at 25fps)
# The video is 5.04s = 126 frames at 25fps
best_score = float('inf')
best_time = -1

for t in [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0]:
    try:
        out_frame = os.path.join(out_dir, f'frame_at_{t:.1f}s.png')
        cmd = [ffmpeg, '-y', '-ss', str(t), '-i', idle, '-vframes', '1', '-update', '1', '-q:v', '2', out_frame]
        subprocess.run(cmd, capture_output=True, timeout=15)
        
        if os.path.exists(out_frame):
            frame = np.array(Image.open(out_frame)).astype(np.float32)
            # MSE (mean squared error)
            mse = np.mean((first - frame) ** 2)
            print(f'  t={t:.1f}s  MSE={mse:.1f}')
            if mse < best_score:
                best_score = mse
                best_time = t
    except Exception as e:
        print(f'  t={t:.1f}s  ERROR: {e}')

print(f'\nBest match: t={best_time:.1f}s  MSE={best_score:.1f}')

# Also try scanning the last second more finely
print('\nFine scan last second (every 2 frames = 80ms):')
for fnum in range(101, 127, 2):
    t = fnum / 25.0
    if t > 5.04:
        break
    try:
        out_frame = os.path.join(out_dir, f'frame_{fnum}.png')
        cmd = [ffmpeg, '-y', '-ss', str(t), '-i', idle, '-vframes', '1', '-update', '1', '-q:v', '2', out_frame]
        subprocess.run(cmd, capture_output=True, timeout=15)
        
        if os.path.exists(out_frame):
            frame = np.array(Image.open(out_frame)).astype(np.float32)
            mse = np.mean((first - frame) ** 2)
            if mse < 100:
                print(f'  frame={fnum} t={t:.2f}s  MSE={mse:.1f}  *** GOOD MATCH ***')
            elif fnum % 4 == 0:
                print(f'  frame={fnum} t={t:.2f}s  MSE={mse:.1f}')
            if mse < best_score:
                best_score = mse
                best_time = t
    except Exception as e:
        print(f'  frame={fnum}  ERROR: {e}')

print(f'\nBest match: t={best_time:.3f}s  MSE={best_score:.1f}')
