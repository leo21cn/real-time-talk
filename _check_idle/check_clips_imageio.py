"""
Check first/last frame consistency using imageio to read frames.
"""
import os, hashlib, numpy as np
from PIL import Image
import imageio_ffmpeg

clips_dir = r'd:\szp\work\real-time-talk\clips\short-hair-teacher-girl'
out_dir = r'd:\szp\work\real-time-talk\_check_idle\clips_check2'

os.makedirs(out_dir, exist_ok=True)

videos = [
    ('idle_breathing', os.path.join(clips_dir, 'idle', 'idle_breathing.webm')),
    ('analysis', os.path.join(clips_dir, 'analysis.mkv')),
    ('comparison', os.path.join(clips_dir, 'comparison.mkv')),
    ('conclusion', os.path.join(clips_dir, 'conclusion.mkv')),
    ('emphasis', os.path.join(clips_dir, 'emphasis.mkv')),
    ('example', os.path.join(clips_dir, 'example.mkv')),
    ('explaining', os.path.join(clips_dir, 'explaining.mkv')),
    ('greeting', os.path.join(clips_dir, 'greeting.mkv')),
    ('introduction', os.path.join(clips_dir, 'introduction.mkv')),
    ('listing', os.path.join(clips_dir, 'listing.mkv')),
    ('thanks', os.path.join(clips_dir, 'thanks.mkv')),
    ('transition', os.path.join(clips_dir, 'transition.mkv')),
]

for name, video_path in videos:
    if not os.path.exists(video_path):
        print(f'SKIP (not found): {name}')
        continue
    
    # Count frames using imageio
    import imageio.v3 as iio
    try:
        # Read all frames metadata to count
        reader = iio.imopen(video_path, 'r', plugin='pyav')
        frame_count = 0
        first_frame = None
        last_frame = None
        for idx, frame in enumerate(reader):
            if idx == 0:
                first_frame = frame.copy()
            last_frame = frame.copy() if frame is not None else last_frame
            frame_count += 1
        reader.close()
        
        if first_frame is None or last_frame is None:
            print(f'{name}: Could not read frames')
            continue
        
        # Convert to RGB if needed
        if first_frame.shape[-1] == 4:
            first_frame = first_frame[:, :, :3]
        if last_frame.shape[-1] == 4:
            last_frame = last_frame[:, :, :3]
        
        # Save for reference
        Image.fromarray(first_frame).save(os.path.join(out_dir, f'{name}_first.png'))
        Image.fromarray(last_frame).save(os.path.join(out_dir, f'{name}_last.png'))
        
        first_arr = first_frame.astype(np.float32)
        last_arr = last_frame.astype(np.float32)
        
        mse = np.mean((first_arr - last_arr) ** 2)
        max_diff = np.max(np.abs(first_arr - last_arr))
        identical = 'IDENTICAL' if max_diff == 0 else 'DIFFER'
        
        with open(os.path.join(out_dir, f'{name}_first.png'), 'rb') as f:
            md5_first = hashlib.md5(f.read()).hexdigest()
        with open(os.path.join(out_dir, f'{name}_last.png'), 'rb') as f:
            md5_last = hashlib.md5(f.read()).hexdigest()
        
        print(f'{name}: frames={frame_count}  MSE={mse:.1f}  max_diff={max_diff:.0f}  {identical}  MD5_match={md5_first==md5_last}')
    
    except Exception as e:
        print(f'{name}: ERROR - {e}')
        # Fallback: use ffmpeg only
        try:
            ffmpeg = r'C:\Users\leo21\AppData\Local\Programs\Python\Python312\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe'
            import subprocess
            # Get duration
            result = subprocess.run([ffmpeg, '-i', video_path], capture_output=True, text=True, timeout=15)
            dur_line = [l for l in result.stderr.split('\n') if 'Duration' in l]
            dur_str = dur_line[0].split('Duration:')[1].split(',')[0].strip() if dur_line else ''
            print(f'  fallback duration: {dur_str}')
        except:
            pass
