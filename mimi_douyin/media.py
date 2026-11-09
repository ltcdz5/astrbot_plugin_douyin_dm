from __future__ import annotations
import asyncio
import json
import os
from pathlib import Path
from .errors import BrowserError

async def inspect_video_tracks(file,ffmpeg,ffprobe_binary=None):
    candidate=Path(ffmpeg).with_name('ffprobe.exe' if os.name=='nt' else 'ffprobe')
    ffprobe=ffprobe_binary or (str(candidate) if candidate.is_file() else 'ffprobe')
    process=await asyncio.create_subprocess_exec(ffprobe,'-v','error','-show_entries',
        'stream=codec_type,duration:format=duration','-of','json',str(file),
        stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,
        creationflags=0x08000000 if os.name=='nt' else 0)
    try:output,_=await asyncio.wait_for(process.communicate(),20)
    except BaseException:
        if process.returncode is None:process.kill();await process.wait()
        raise
    if process.returncode:raise BrowserError('下载的文件无法作为视频读取。')
    info=json.loads(output)
    if not any(s.get('codec_type')=='video' for s in info.get('streams',[])):
        raise BrowserError('下载的文件没有视频画面，未把单独音轨当作完整视频。')
    duration=float(info.get('format',{}).get('duration',0))
    audio=next((s for s in info.get('streams',[]) if s.get('codec_type')=='audio'),None)
    audio_duration=None
    if audio and audio.get('duration') not in (None,'N/A'):
        audio_duration=float(audio['duration'])
    return {'duration':duration,'audio_state':'present' if audio else 'no_audio','audio_duration':audio_duration}


async def inspect_video(file,ffmpeg,ffprobe_binary=None):
    return (await inspect_video_tracks(file,ffmpeg,ffprobe_binary))['duration']


def validate_audio_coverage(tracks):
    audio_duration=tracks['audio_duration']
    if tracks['audio_state']=='present' and audio_duration is not None:
        if abs(audio_duration-tracks['duration'])>max(2,tracks['duration']*0.02):
            raise BrowserError('音轨时长与完整视频不符，未将背景音乐片段当作完整音轨。')


async def prepare_video(path,media_dir,ffmpeg,max_mb,expected_duration=None,ffprobe_binary=None):
    file=Path(path).resolve()
    if not file.is_relative_to(Path(media_dir).resolve()) or not file.is_file():
        raise BrowserError('视频文件不在本插件的媒体目录中。')
    tracks=await inspect_video_tracks(file,ffmpeg,ffprobe_binary)
    validate_audio_coverage(tracks)
    duration=tracks['duration']
    if expected_duration and abs(duration-expected_duration)>max(2,expected_duration*0.02):
        raise BrowserError('取得的视频时长与原视频不符，没有把片段当作完整视频。')
    if max_mb<=0 or file.stat().st_size<=max_mb*1024*1024:return str(file)
    output=file.with_name(file.stem+'-model.mp4')
    # Budget bitrate over the complete duration; preserve audio and readable short edge.
    if duration<=0:raise BrowserError('缺少完整视频时长，停止压缩。')
    video_kbps=max(80,int(max_mb*1024*1024*8*0.90/duration/1000)-64)
    # Long clips on mobile CPUs need less encoding work and a duration-aware budget.
    compression_timeout=max(300,min(1800,int(duration*2+60)))
    for edge,factor in (((540,1.0),(480,0.8)) if duration>300 else ((720,1.0),(540,0.8))):
        # Portrait: constrain width (short edge), landscape: constrain height.
        scale=f"scale='if(gte(iw,ih),-2,min(iw,{edge}))':'if(gte(iw,ih),min(ih,{edge}),-2)'"
        process=await asyncio.create_subprocess_exec(ffmpeg,'-hide_banner','-loglevel','error','-threads','4','-i',str(file),
            '-map','0:v:0','-map','0:a:0?','-vf','fps=15,'+scale,'-c:v','libx264','-preset','ultrafast','-threads','4',
            '-b:v',str(int(video_kbps*factor))+'k','-maxrate',str(video_kbps)+'k','-bufsize',str(video_kbps*2)+'k',
            '-c:a','aac','-b:a','64k','-movflags','+faststart','-y',str(output),
            stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL,
            creationflags=0x08000000 if os.name=='nt' else 0)
        try:code=await asyncio.wait_for(process.wait(),compression_timeout)
        except BaseException as exc:
            if process.returncode is None:process.kill();await process.wait()
            output.unlink(missing_ok=True)
            if isinstance(exc,asyncio.TimeoutError):
                raise BrowserError(f'视频已下载，但本地压缩超时（{compression_timeout}秒，原片{duration:.0f}秒）；原片已保留。') from exc
            raise
        if code or not output.is_file():raise BrowserError('视频压缩失败。')
        if output.stat().st_size<=max_mb*1024*1024:break
    else:raise BrowserError('完整视频压缩后仍超出模型输入预算。')
    compressed=await inspect_video_tracks(output,ffmpeg,ffprobe_binary)
    validate_audio_coverage(compressed)
    if tracks['audio_state']=='present' and compressed['audio_state']!='present':
        raise BrowserError('压缩后音轨丢失，停止提交视频。')
    compressed_duration=compressed['duration']
    if abs(compressed_duration-duration)>max(2,duration*0.02):
        raise BrowserError('压缩后的视频时长不完整。')
    return str(output)


