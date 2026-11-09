import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openBackgroundPage} from './browser_actions.mjs';
import {getCommentEditor,getCommentSubmit,captureEmptyCommentControls} from './comment_ui.mjs';

export function videoDurationDecision(duration, maxSeconds=180) {
  const limit=Number(maxSeconds);
  if(!Number.isInteger(limit)||limit<0||limit>10000)throw new Error('视频时长上限应为 0～10000 秒。');
  if(limit===0)return null;
  const known=Number.isFinite(duration)&&duration>0;
  if(known&&duration<=limit)return null;
  const reason=known?'duration_limit':'duration_unknown';
  const message=known
    ?`这条视频时长约 ${Math.ceil(duration)} 秒，超过当前 ${limit} 秒上限，已跳过下载，未观看。请换一个不超过上限的新视频。`
    :`这条视频暂时无法确认时长，当前上限为 ${limit} 秒，已跳过下载，未观看。请换一个能确认时长的新视频。`;
  return {state:'skipped',reason,downloaded:false,verified:false,
    duration:known?duration:null,max_duration_seconds:limit,retry_action:'choose_another_video',message};
}

export function postImageCandidates(detail) {
  const images=Array.isArray(detail?.images)&&detail.images.length?detail.images:detail?.image_post_info?.images;
  if(!Array.isArray(images))return [];
  return images.map(image=>{
    const lists=[image?.display_image?.url_list,image?.owner_watermark_image?.url_list,image?.url_list,image?.download_url_list];
    return [...new Set(lists.flatMap(list=>Array.isArray(list)?list:[]).filter(url=>{
      if(typeof url!=='string')return false;
      try {const target=new URL(url);return target.protocol==='https:'&&!target.username&&!target.password;}
      catch {return false;}
    }))];
  });
}

export function postImages(detail) {
  return postImageCandidates(detail).map(candidates=>candidates[0]);
}

// Observed detail response provides MP4 (muxed) and DASH (video-only) for the same gear.
// Never use music.play_url as a substitute for the work's full soundtrack.
export function selectVideoRendition(video,remaining,targetEdge=720) {
  const candidate=(a,t={},strategy='detail_muxed_mp4')=>{
    const url=(a?.url_list||[]).find(v=>typeof v==='string'&&v.startsWith('https:'));
    const bytes=Number(t.file_size||a?.data_size)||0;
    return {url,bytes,edge:Math.min(Number(t.width||a?.width)||Infinity,Number(t.height||a?.height)||Infinity),
      rate:Number(t.bit_rate)||0,durationMs:t.duration_ms??a?.duration_ms,duration:t.duration??a?.duration,strategy};
  };
  const tiers=(video?.bit_rate||[]).filter(t=>t.format==='mp4').map(t=>candidate(t.play_addr,t))
    .filter(t=>t.url&&(!t.bytes||t.bytes<=remaining));
  const score=t=>Number.isFinite(t.edge)?(t.edge>=540?Math.abs(t.edge-targetEdge):2000+540-t.edge):3000;
  tiers.sort((a,b)=>score(a)-score(b)||a.rate-b.rate);
  if(tiers.length)return tiers[0];
  const base=candidate(video?.play_addr,{},'detail_play_addr');
  if(video?.format!=='dash'&&base.url&&(!base.bytes||base.bytes<=remaining))return base;
  return null;
}

async function fetchAsset(url,{context,page,mediaHost},expected,remaining) {
  let response;
  for(let redirects=0;redirects<5;redirects++) {
    const target=new URL(url);
    if(target.protocol!=='https:'||!mediaHost(target.hostname)||target.username||target.password)
      throw new Error('媒体下载地址不在支持范围。');
    const cookies=await context.cookies(url);
    response=await fetch(url,{redirect:'manual',headers:{Referer:'https://www.douyin.com/',
      'User-Agent':await page.evaluate(()=>navigator.userAgent),Cookie:cookies.map(cookie=>cookie.name+'='+cookie.value).join('; ')},
      signal:AbortSignal.timeout(60000)});
    if(response.status>=300&&response.status<400){url=new URL(response.headers.get('location'),url).href;continue;}
    break;
  }
  const mime=(response?.headers.get('content-type')||'').split(';')[0];
  if(!response?.ok||!mime.startsWith(expected+'/'))throw new Error('实际媒体文件下载失败。');
  if(Number(response.headers.get('content-length'))>remaining)throw new Error('作品媒体总大小超过下载设置。');
  const reader=response.body.getReader();const chunks=[];let bytes=0;
  try {
    while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;
      if(bytes>remaining)throw new Error('作品媒体总大小超过下载设置。');chunks.push(chunk.value);}
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  const extension=expected==='video'?'.mp4':({'image/png':'.png','image/webp':'.webp','image/avif':'.avif','image/gif':'.gif'}[mime]||'.jpg');
  return {data:Buffer.concat(chunks),extension,bytes,mime};
}

async function writeAsset({data,extension,bytes,mime},{settings}) {
  await fs.mkdir(settings.media_dir,{recursive:true});
  const file=path.join(settings.media_dir,randomUUID()+extension);
  try {await fs.writeFile(file,data);}
  catch(error) {await fs.unlink(file).catch(()=>{});throw error;}
  return {path:file,bytes,mime};
}

async function downloadAsset(url,environment,expected,remaining) {
  return writeAsset(await fetchAsset(url,environment,expected,remaining),environment);
}

export async function downloadImageCandidates(candidates,environment,remaining) {
  let failure=new Error('图文中有原图地址缺失，未把部分图片当作完整作品。');
  // Bound retries per page; each attempt retains the same remaining byte budget.
  for(const url of candidates.slice(0,3)) {
    let asset;
    try {asset=await fetchAsset(url,environment,'image',Math.min(remaining,20*1024*1024));}
    catch(error) {failure=error;continue;}
    // A filesystem error is not evidence that another CDN candidate will work.
    return writeAsset(asset,environment);
  }
  throw failure;
}

async function fetchDetail(tab,id) {
  // 后台标签页在 proot/移动端 Chromium 上经常收不到 detail 的 response 事件。
  // 在页面上下文直接 fetch 同一接口，cookie 自动带，不需要 a_bogus 签名。
  return tab.evaluate(async (postId)=>{
    const base='/aweme/v1/web/aweme/detail/?device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1&version_code=190500&version_name=19.5.0&cookie_enabled=true&platform=PC&aweme_id=';
    const response=await fetch(base+encodeURIComponent(postId),{credentials:'include'});
    if(!response.ok)return null;
    try{return await response.json();}catch{return null;}
  },id).catch(()=>null);
}

export async function readPost(args,environment) {
  const {context,page,settings,siteHost,mediaHost,publicURL}=environment;
  const url=new URL(args.url);
  if(url.protocol!=='https:'||!siteHost(url.hostname)||url.username||url.password)throw new Error('作品来源不受支持。');
  const tab=await openBackgroundPage(context,page);
  const media=[];
  const detailPromise=tab.waitForResponse(response=>/\/aweme\/v1\/web\/aweme\/detail\//.test(response.url())
    && response.status()===200 && (response.headers()['content-type']||'').includes('json'),{timeout:18000})
    .then(response=>response.json()).catch(()=>null);
  tab.on('response',response=>{
    if((response.headers()['content-type']||'').startsWith('video/')&&mediaHost(new URL(response.url()).hostname))media.push(response.url());
  });
  try {
    await tab.goto(url.href,{waitUntil:'domcontentloaded',timeout:45000});
    if(/验证码|安全验证/.test(await tab.title()))throw new Error('抖音要求账号验证，请在登录窗口完成后重试。');
    let payload=await detailPromise;
    const id=new URL(tab.url()).pathname.match(/\/(?:video|note)\/(\d+)/)?.[1]
      ||url.pathname.match(/\/(?:video|note)\/(\d+)/)?.[1];
    if(!payload && id)payload=await fetchDetail(tab,id);
    const detail=payload?.aweme_detail;
    if(detail && id && String(detail.aweme_id)!==id)throw new Error('作品详情标识不匹配，未读取其他内容。');
    const images=postImageCandidates(detail);
    const postID=String(detail?.aweme_id||id||'');
    const info={kind:images.length?'images':'video',description:String(detail?.desc||''),
      source:postID?`https://www.douyin.com/${images.length?'note':'video'}/${postID}`:publicURL(tab.url()),post_id:postID,image_count:images.length,
      has_video:!!detail?.video,metadata_fields:detail?Object.keys(detail):[]};
    if(args.info_only) {
      await tab.waitForSelector('video,[data-e2e*="comment"]',{timeout:10000}).catch(()=>{});
      await tab.waitForTimeout(1000);
      if(args.probe_comment) {
        let editor;
        try {
          editor=await getCommentEditor(tab);
          if(args.probe_text){await editor.focus();await editor.press('Control+A');await editor.press('Backspace');await captureEmptyCommentControls(tab);await tab.keyboard.insertText('临时检查，未发送');await tab.waitForTimeout(300);}
          const submit=await getCommentSubmit(tab);
          info.comment_ui={editor_count:await editor.count(),submit_count:await submit.count(),submitted:false};
        } catch(error) {info.comment_ui={ready:false,reason:String(error.message),submitted:false};}
        finally {
          if(args.probe_text)info.comment_ui.scene=await tab.evaluate(()=>{
            const inner=document.querySelector('.comment-input-inner-container');
            const parent=inner?.parentElement?.parentElement;
            if(!parent)return [];
            return [...parent.querySelectorAll('button,div,span,svg,use')].slice(-45).map(node=>({tag:node.tagName,
              cls:node.getAttribute('class'),label:node.getAttribute('aria-label'),title:node.getAttribute('title'),
              role:node.getAttribute('role'),href:node.getAttribute('href')||node.getAttribute('xlink:href'),
              text:node.tagName.toLowerCase()==='svg'?'':(node.innerText||'').slice(0,35),
              handlers:Object.keys(node).filter(key=>key.startsWith('__reactProps')).flatMap(key=>Object.keys(node[key]||{}).filter(name=>name.startsWith('on')))}));
          });
          if(args.probe_text&&editor){await editor.focus();await editor.press('Control+A');await editor.press('Backspace');await tab.waitForTimeout(300);
            info.comment_ui.draft_cleared=(await editor.innerText()).replace(/[\u200b\ufeff]/g,'').trim()==='';}
        }
      }
      info.comment_permission={allow_comment:detail?.status?.allow_comment,video_allow_comment:detail?.video_control?.allow_comment};
      info.comment_controls=await tab.evaluate(()=>{
        const visible=node=>node.getBoundingClientRect().width>10&&node.getBoundingClientRect().height>8;
        const describe=node=>({tag:node.tagName,cls:String(node.className),e2e:node.getAttribute('data-e2e'),
          editable:node.getAttribute('contenteditable'),role:node.getAttribute('role'),visible:visible(node),
          placeholder:node.getAttribute('placeholder')||node.getAttribute('data-placeholder'),
          text:(node.tagName==='BUTTON'||node.getAttribute('role')==='button')?(node.innerText||'').slice(0,40):''});
        return {editors:[...document.querySelectorAll('textarea,input,[contenteditable]')].map(describe).slice(0,25),
          e2e:[...new Set([...document.querySelectorAll('[data-e2e]')].map(node=>node.getAttribute('data-e2e')))].slice(0,70),
          inputs:[...document.querySelectorAll('[class*="comment-input"],[class*="CommentInput"],[class*="commentInput"],[data-placeholder],[data-slate-editor]')].map(describe).slice(0,20),
          composer:[...document.querySelectorAll('.commentInput-right-ct')].map(node=>({parent_class:String(node.parentElement.className),parent_text:node.parentElement.innerText.slice(0,180),
            children:[...node.parentElement.querySelectorAll('div,span,button')].slice(-16).map(child=>({tag:child.tagName,cls:String(child.className),text:child.innerText.slice(0,30)}))})),
          iframes:[...document.querySelectorAll('iframe')].map(node=>({title:node.title,path:(()=>{try{return new URL(node.src).pathname;}catch{return '';}})()})).slice(0,8),
          buttons:[...document.querySelectorAll('button,[role="button"],[data-e2e*="comment"]')].filter(visible)
            .filter(node=>/comment|评论|发送|发布/.test(String(node.className)+' '+node.getAttribute('data-e2e')+' '+node.innerText)).map(describe).slice(0,25)};
      });
      return info;
    }
    let remaining=(settings.max_download_mb||64)*1024*1024;
    if(images.length) {
      if(images.length>Number(settings.max_post_images||30))throw new Error('图文图片数量超过设置，未仅下载封面。');
      if(images.some(candidates=>!candidates.length))throw new Error('图文中有原图地址缺失，未把部分图片当作完整作品。');
      const files=[];
      try {
        for(const candidates of images){const image=await downloadImageCandidates(candidates,environment,remaining);
          files.push(image);remaining-=image.bytes;}
        return {...info,images:files,bytes:files.reduce((sum,image)=>sum+image.bytes,0)};
      } catch(error) {
        await Promise.all(files.map(file=>fs.unlink(file.path).catch(()=>{})));
        throw error;
      }
    }
    if(!detail?.video && /\/note\//.test(tab.url()))throw new Error('图文详情没有返回原图，未用封面代替。');
    // Prefer readable subtitles within the download budget, using short edge rather than bitrate alone.
    const targetEdge=settings.subtitle_dense?1080:720;
    const chosen=selectVideoRendition(detail?.video,remaining,targetEdge)||{url:''};
    if(detail?.video&&!chosen.url)throw new Error('下载预算内没有完整音画档位，未将 DASH 单独画面当作完整视频。');
    const playURL=chosen.url;
    // 实测：抖音在私信分享的详情里，video.duration 存的是毫秒（8 秒视频 = 8058），
    // 而且没有 duration_ms 字段。但有接口会给秒。
    // 判定：优先采信"除以1000后落在1秒~3小时"的解释；只有原值本身明显是秒
    // （且除以1000后不足1秒）时才按秒处理。
    const MAX_SEC=10800;
    const toSec=v=>{
      const n=Number(v);
      if(!Number.isFinite(n)||n<=0)return null;
      const asMs=n/1000;
      if(asMs>=1&&asMs<=MAX_SEC)return asMs;      // 主流：毫秒
      if(n>=1&&n<=MAX_SEC)return n;                // 少数：本来就是秒
      return null;
    };
    let knownDuration=null;
    for(const field of [detail?.video?.duration_ms,detail?.video?.duration,
                        detail?.duration,detail?.video?.play_addr?.duration_ms,
                        detail?.video?.play_addr?.duration,chosen.durationMs,chosen.duration]){
      const v=toSec(field);
      if(v!=null){knownDuration=v;break;}
    }
    let probe={url:'',duration:knownDuration,title:await tab.title()};
    if(!playURL){
      // 详情没给播放地址才等播放器；后台作品页在移动端可能永远不创建 <video>。
      await tab.waitForFunction(()=>[...document.querySelectorAll('video')].some(video=>video.currentSrc&&video.readyState>=1),undefined,{timeout:20000});
      probe=await tab.evaluate(()=>{
        const video=[...document.querySelectorAll('video')].filter(item=>item.currentSrc&&item.readyState>=1)
          .sort((a,b)=>b.getBoundingClientRect().width*b.getBoundingClientRect().height-a.getBoundingClientRect().width*a.getBoundingClientRect().height)[0];
        if(!video)return {url:'',duration:null,title:document.title};
        try{video.play().catch(()=>{});}catch{}
        return {url:video.currentSrc,duration:video.duration,title:document.title};
      });
      await tab.waitForTimeout(1200);
    }
    const skipped=videoDurationDecision(probe.duration,settings.max_video_duration_seconds??180);
    if(skipped)return {...info,...skipped,title:probe.title,
      _debug_duration:{picked:knownDuration,
        video_duration_ms:detail?.video?.duration_ms,
        video_duration:detail?.video?.duration,
        top_duration:detail?.duration,
        play_addr_duration:detail?.video?.play_addr?.duration,
        play_addr_duration_ms:detail?.video?.play_addr?.duration_ms,
        chosen:chosen.duration,
        chosenMs:chosen.durationMs}};
    const assetURL=playURL||(probe.url.startsWith('https:')?probe.url:media.at(-1));
    if(!assetURL)throw new Error('没有取得实际视频文件。');
    if(chosen.bytes&&chosen.bytes>remaining)
      throw new Error('作品媒体总大小超过下载设置。');
    const file=await downloadAsset(assetURL,environment,'video',remaining);
    return {...info,...file,duration:Number.isFinite(probe.duration)?probe.duration:null,title:probe.title,
      download_strategy:chosen.strategy||'player_source',media_response_count:media.length};
  } finally {await tab.close();}
}
