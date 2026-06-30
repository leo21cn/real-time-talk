"""
Check first/last frame consistency using frame INDEX extraction.
"""
import subprocess, os, hashlib, json, re, numpy as np
from PIL import Image

ffmpeg = r'C:\Users\leo21\AppData\Local\Programs\Python\Python312\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe'
ffprobe = ffmpeg.replace('ffmpeg-win-x86_64-v7.1.exe', 'ffprobe-win-x86_64-v7.1.exe')
clips_dir = r'd:\szp\work\real-time-talk\clips\short-hair-teacher-girl'
out_dir = r'd:\szp\work\real-time-talk\_check_idle\clips_check'

os.makedirs(out_dir, exist_ok=True)

videos = [
    os.path.join(clips_dir, 'idle', 'idle_breathing.webm'),
    os.path.join(clips_dir, 'analysis.mkv'),
    os.path.join(clips_dir, 'comparison.mkv'),
    os.path.join(clips_dir, 'conclusion.mkv'),
    os.path.join(clips_dir, 'emphasis.mkv'),
    os.path.join(clips_dir, 'example.mkv'),
    os.path.join(clips_dir, 'explaining.mkv'),
    os.path.join(clips_dir, 'greeting.mkv'),
    os.path.join(clips_dir, 'introduction.mkv'),
    os.path.join(clips_dir, 'listing.mkv'),
    os.path.join(clips_dir, 'thanks.mkv'),
    os.path.join(clips_dir, 'transition.mkv'),
]

for video_path in videos:
    if not os.path.exists(video_path):
        print(f'SKIP (not found): {os.path.basename(video_path)}')
        continue
    
    name = os.path.basename(video_path).rsplit('.', 1)[0]
    
    # Get frame count using ffprobe
    probe = subprocess.run(
        [ffprobe, '-v', 'error', '-select_streams', 'v:0', '-count_packets',
         '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', video_path],
        capture_output=True, text=True, timeout=15
    )
    frame_count = int(probe.stdout.strip()) if probe.stdout.strip().isdigit() else 0
    
    if frame_count == 0:
        # Fallback: try nb_read_frames
        probe = subprocess.run(
            [ffprobe, '-v', 'error', '-select_streams', 'v:0', '-count_frames',
             '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', video_path],
            capture_output=True, text=True, timeout=15
        )
        frame_count = int(probe.stdout.strip()) if probe.stdout.strip().isdigit() else 0
    
    if frame_count == 0:
        print(f'{name}: Could not determine frame count')
        continue
    
    first_fp = os.path.join(out_dir, f'{name}_first.png')
    last_fp = os.path.join(out_dir, f'{name}_last.png')
    
    # Extract frame 0 (first)
    subprocess.run(
        [ffmpeg, '-y', '-i', video_path, '-vf', 'select=eq(n\,0)', '-vframes', '1', '-update', '1', '-q:v', '2', first_fp],
        capture_output=True, timeout=30
    )
    
    # Extract frame N-1 (last)
    last_idx = frame_count - 1
    subprocess.run(
        [ffmpeg, '-y', '-i', video_path, '-vf', f'select=eq(n\,{last_idx})', '-vframes', '1', '-update', '1', '-q:v', '2', last_fp],
        capture_output=True, timeout=30
    )
    
    if os.path.exists(first_fp) and os.path.exists(last_fp):
        try:
            first_arr = np.array(Image.open(first_fp)).astype(np.float32)
            last_arr = np.array(Image.open(last_fp)).astype(np.float32)
        except Exception as e:
            print(f'{name}: Image load error: {e}')
            continue
        
        if first_arr.shape == last_arr.shape:
            mse = np.mean((first_arr - last_arr) ** 2)
            max_diff = np.max(np.abs(first_arr - last_arr))
            identical = 'IDENTICAL' if max_diff == 0 else 'DIFFER'
            
            with open(first_fp, 'rb') as f:
                md5_first = hashlib.md5(f.read()).hexdigest()
            with open(last_fp, 'rb') as f:
                md5_last = hashlib.md5(f.read()).hexdigest()
            
            print(f'{name}: frames={frame_count}  MSE={mse:.1f}  max_diff={max_diff:.0f}  {identical}  MD5_match={md5_first==md5_last}')
        else:
            print(f'{name}: SHAPE MISMATCH first={first_arr.shape} last={last_arr.shape}')
    else:
        print(f'{name}: extraction failed (first={os.path.exists(first_fp)} last={os.path.exists(last_fp)})')
