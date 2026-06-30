"""
Check first/last frame consistency for ALL video clips (idle + semantic).
"""
import subprocess, os, hashlib, numpy as np
from PIL import Image

ffmpeg = r'C:\Users\leo21\AppData\Local\Programs\Python\Python312\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe'
clips_dir = r'd:\szp\work\real-time-talk\clips\short-hair-teacher-girl'
out_dir = r'd:\szp\work\real-time-talk\_check_idle\clips_check'

os.makedirs(out_dir, exist_ok=True)

videos = [
    # idle
    os.path.join(clips_dir, 'idle', 'idle_breathing.webm'),
    # semantic clips
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
    first_fp = os.path.join(out_dir, f'{name}_first.png')
    last_fp = os.path.join(out_dir, f'{name}_last.png')
    
    # Extract first frame
    subprocess.run([ffmpeg, '-y', '-i', video_path, '-vframes', '1', '-update', '1', '-q:v', '2', first_fp],
                   capture_output=True, timeout=30)
    
    # Extract last frame: seek to near end and extract
    # First get duration
    probe = subprocess.run([ffmpeg, '-i', video_path], capture_output=True, text=True, timeout=15)
    dur_line = [l for l in probe.stderr.split('\n') if 'Duration' in l]
    dur_str = dur_line[0].split('Duration:')[1].split(',')[0].strip() if dur_line else '00:00:00.00'
    # Parse HH:MM:SS.ms
    parts = dur_str.replace('.', ':').split(':')
    dur_sec = float(parts[0])*3600 + float(parts[1])*60 + float(parts[2]) + float(parts[3])/100
    
    # Seek to just before end to extract last frame
    seek_t = max(0, dur_sec - 0.1)
    subprocess.run([ffmpeg, '-y', '-ss', str(seek_t), '-i', video_path, '-vframes', '1', '-update', '1', '-q:v', '2', last_fp],
                   capture_output=True, timeout=30)
    
    if os.path.exists(first_fp) and os.path.exists(last_fp):
        first_arr = np.array(Image.open(first_fp)).astype(np.float32)
        last_arr = np.array(Image.open(last_fp)).astype(np.float32)
        
        if first_arr.shape == last_arr.shape:
            mse = np.mean((first_arr - last_arr) ** 2)
            max_diff = np.max(np.abs(first_arr - last_arr))
            identical = 'IDENTICAL' if max_diff == 0 else 'DIFFER'
            
            # Also check MD5
            with open(first_fp, 'rb') as f:
                md5_first = hashlib.md5(f.read()).hexdigest()
            with open(last_fp, 'rb') as f:
                md5_last = hashlib.md5(f.read()).hexdigest()
            
            print(f'{name}: dur={dur_sec:.2f}s  MSE={mse:.1f}  max_diff={max_diff:.0f}  {identical}  MD5_match={md5_first==md5_last}')
        else:
            print(f'{name}: SHAPE MISMATCH first={first_arr.shape} last={last_arr.shape}')
    else:
        print(f'{name}: extraction failed')
