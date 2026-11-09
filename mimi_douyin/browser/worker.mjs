// Private-chat DOM selectors were informed by popohuan/douyin-bot (MIT).
// See ATTRIBUTIONS.md. No third-party persona, account state, or sending code is used.
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import readline from 'node:readline';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {enterReply,submitReply} from './browser_actions.mjs';

let context, page, settings;
let keepTimer=null, probeTimer=null, lastHeal=0;
// mimi-keepalive: 弹层祖先被回收（display:none / 宽度归零）= 渲染回收/白屏前兆，
// 原地重开弹层比重启浏览器轻；页面还活着就定时 reload 防积劳崩溃。
const healDialog=async()=>{
  try{
    return await page.evaluate(()=>{
      const d=document.querySelector('[data-e2e="im-dialog"]');
      if(!d)return -1;
      let node=d,guard=0;
      while(node&&guard++<12){
        if(getComputedStyle(node).display==='none')node.style.display='block';
        if(node.getBoundingClientRect().width<50){node.style.width='340px';node.style.height='560px';}
        node=node.parentElement;
      }
      return Math.round(d.getBoundingClientRect().width);
    });
  }catch{return -1;}
};
const reloadPage=async()=>{
  lastHeal=Date.now();
  try{await page.reload({waitUntil:'domcontentloaded',timeout:30000});}catch{}
  await new Promise(r=>setTimeout(r,6000));
  await healDialog();
};
const idle=()=>!Date.now()||Date.now()>=(globalThis.__busyUntil||0);
const scheduleKeepalive=()=>{
  if(keepTimer)clearInterval(keepTimer);
  keepTimer=setInterval(async()=>{
    try{
      if(!page||page.isClosed()||!idle())return;
      const w=await healDialog();
      if(w<100&&Date.now()-lastHeal>90000)await reloadPage();
    }catch{}
  },300000);
};
// 白屏快速探针：每 45 秒只看编辑框宽度，坏了立刻开修，不等 5 分钟大检。
const scheduleProbe=()=>{
  if(probeTimer)clearInterval(probeTimer);
  probeTimer=setInterval(async()=>{
    try{
      if(!page||page.isClosed()||!idle())return;
      const w=await page.evaluate(()=>{
        const x=document.querySelector('.messageEditorinputArea');
        return x?Math.round(x.getBoundingClientRect().width):-1;
      }).catch(()=>-2);
      if((w===-2||w<10)&&Date.now()-lastHeal>90000)await reloadPage();
    }catch{}
  },45000);
};
const hash=x=>createHash('sha256').update(x).digest('hex');
const siteHost=host=>host==='douyin.com'||host.endsWith('.douyin.com')||host==='iesdouyin.com'||host.endsWith('.iesdouyin.com');
const mediaHost=host=>siteHost(host)||['douyinvod.com','douyincdn.com','douyinpic.com','bytecdn.cn','byteimg.com','byteimgtos.com','pstatp.com'].some(x=>host===x||host.endsWith('.'+x));
const publicURL=value=>{
  const raw=String(value||'');
  // data:/blob: 不是网络地址，拆 origin+pathname 会得到 "nullimage/png;base64,..."
  // 这类必须原样保留，否则图片识别和预览都会拿到坏地址。
  if(!raw)return '';
  if(raw.startsWith('data:')||raw.startsWith('blob:'))return raw;
  try{const u=new URL(raw);return u.origin+u.pathname;}catch{return '';}
};

async function open(config) {
  settings=config;
  if(context && page && !page.isClosed()){
    // 旧连接可能已随浏览器重启而失效：探一次，活着才复用。
    // evaluate 的第二个参数是「arg」不是选项，超时必须用 Promise.race 自己实现。
    try{
      await Promise.race([
        page.evaluate('1'),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error('probe timeout')),5000)),
      ]);
      return status();
    }catch{context=null;page=null;}
  }
  const require=createRequire(config.playwright_package);
  const {chromium}=require('playwright');
  await fs.mkdir(config.profile,{recursive:true});
  await fs.mkdir(config.media_dir,{recursive:true});
  const cdpUrl=process.env.MIMI_CDP_URL||'http://127.0.0.1:9222';
  let browser;
  for(let attempt=0;attempt<3;attempt++){
    try{browser=await chromium.connectOverCDP(cdpUrl,{timeout:15000});break;}
    catch(e){if(attempt===2)throw e;await new Promise(r=>setTimeout(r,2000));}
  }
  context=browser.contexts()[0]||await browser.newContext();
  // 明确挑抖音页面：pages()[0] 可能是空白页或残留标签，会导致快照拿不到 peer。
  const pages=context.pages();
  page=pages.find(p=>String(p.url()||'').includes('douyin.com')) || pages[0] || null;
  for(const extra of pages){if(extra!==page){try{await extra.close();}catch{}}}
  let pageAlive=false;
  if(page){
    try{
      await Promise.race([
        page.evaluate('1'),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('dead')),4000)),
      ]);
      pageAlive=true;
    }catch{
      const dead=page;
      page=await context.newPage();
      try{await dead.close();}catch{}
    }
  }else{
    page=await context.newPage();
  }
  /* mimi-focus-fix */
  try{ await page.bringToFront(); }catch(e){}
  try{ const __s=await context.newCDPSession(page); await __s.send("Emulation.setFocusEmulationEnabled",{enabled:true}).catch(()=>{}); await __s.detach().catch(()=>{}); }catch(e){}
  page.setDefaultTimeout(8000);
  const hasDouyin=pageAlive && await page.evaluate(()=>location.hostname.includes('douyin.com') && !!document.querySelector('[data-e2e="im-entry"],[data-e2e="im-dialog"]')).catch(()=>false);
  if(!hasDouyin){
    await page.goto('https://www.douyin.com/',{waitUntil:'domcontentloaded',timeout:45000});
  }
  if(config.restore_peer){
    try{
      // mimi-strong-restore: 逐级展开弹层（抖音把面板挂在 display:none 的祖先下），
      // 比反复点击入口可靠；失败再点一次。
      const reveal=async()=>{
        const w=await healDialog();
        if(w>100)return w;
        try{
          const box=await page.locator('[data-e2e="im-entry"]').first().boundingBox();
          if(box) await page.mouse.click(box.x+box.width/2, box.y+box.height/2);
        }catch{await page.locator('[data-e2e="im-entry"]').click({timeout:10000}).catch(()=>{});}
        await new Promise(r=>setTimeout(r,900));
        return healDialog();
      };
      for(let attempt=0;attempt<4;attempt++){
        if(await reveal()>100)break;
        await new Promise(r=>setTimeout(r,2000));
      }
      // 会话列表先出骨架（只有会话 ID），昵称几秒后才填充；轮询到有可点的项。
      for(let wait=0;wait<40;wait++){
        const count=await page.evaluate(()=>document.querySelectorAll('[data-e2e="conversation-item"]').length).catch(()=>0);
        if(count>0)break;
        await reveal();
        await new Promise(r=>setTimeout(r,1500));
      }
      const listed=await snapshot({conversations_only:true});
      const byID=config.restore_peer.conversation_id?(listed.conversations||[]).filter(
        item=>item.conversation_id===config.restore_peer.conversation_id):[];
      let match=byID.length===1;
      if(match){
        const {activateConversation}=await import('./conversation_ui.mjs');
        await activateConversation(page,byID[0],snapshot);
      }
      else match=await page.evaluate(peer=>{
        const clean=x=>{try{return new URL(x).pathname;}catch{return '';}};
        const items=[...document.querySelectorAll('[data-e2e="conversation-item"]')]
          .filter(x=>x.getBoundingClientRect().width>10);
        // 昵称行可能在会话 ID 骨架之后才渲染；全行扫描而不是只看第一行。
        const hasName=(x,name)=>(x.innerText||'').split('\n').map(t=>t.trim()).filter(Boolean).some(l=>l===name);
        document.querySelectorAll('[data-mimi-restore-peer]').forEach(x=>x.removeAttribute('data-mimi-restore-peer'));
        let hit=items.filter(x=>[...x.querySelectorAll('img')].some(i=>clean(i.src)===clean(peer.avatar))&&hasName(x,peer.name));
        if(hit.length!==1)hit=items.filter(x=>hasName(x,peer.name));
        if(hit.length!==1)return false;
        hit[0].setAttribute('data-mimi-restore-peer','true');return true;
      },config.restore_peer);
      if(match){
        if(byID.length!==1){
          // 抖音不响应 Playwright 合成点击，派发完整 pointer 事件链并允许重试。
          for(let attempt=0;attempt<3;attempt++){
            await page.evaluate(()=>{
              const el=document.querySelector('[data-mimi-restore-peer="true"]');
              if(!el)return;
              const r=el.getBoundingClientRect();
              const o={bubbles:true,cancelable:true,composed:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2,view:window};
              el.dispatchEvent(new PointerEvent('pointerdown',o));
              el.dispatchEvent(new MouseEvent('mousedown',o));
              el.dispatchEvent(new PointerEvent('pointerup',o));
              el.dispatchEvent(new MouseEvent('mouseup',o));
              el.dispatchEvent(new MouseEvent('click',o));
              el.click();
            });
            let ok=false;
            for(let i=0;i<12;i++){
              await page.waitForTimeout(700);
              try{ok=(await snapshot()).peer?.key===config.restore_peer.key;}catch{ok=false;}
              if(ok)break;
            }
            if(ok)break;
          }
        }
        await page.locator('.messageEditorinputArea').waitFor({timeout:10000}).catch(()=>{});
        let restored;
        for(let i=0;i<8;i++){
          try{restored=await snapshot();}catch{restored=null;}
          if(restored?.peer?.key===config.restore_peer.key)break;
          await page.waitForTimeout(700);
        }
        if(restored?.peer?.key!==config.restore_peer.key)return {...await status(),state:'restore_recipient_mismatch'};
      }
    }catch{/* Keep login available for manual selection when restoring is unavailable. */}
  }
  scheduleKeepalive();
  scheduleProbe();
  return status();
}

async function status() {
  if(!page || page.isClosed())return {open:false,logged_in:false,state:'browser_closed'};
  const cookies=await context.cookies('https://www.douyin.com');
  const session=cookies.some(x=>['sessionid','sessionid_ss'].includes(x.name)&&x.value);
  const ui=await page.evaluate(()=>({title:document.title,url:location.origin+location.pathname,
    editors:[...document.querySelectorAll('[contenteditable="true"],textarea')].filter(x=>x.getBoundingClientRect().width>20)
      .map(x=>({tag:x.tagName,className:x.className,role:x.getAttribute('role')})).slice(0,8),
    loginButton:[...document.querySelectorAll('button,[role="button"]')].some(x=>x.innerText?.trim()==='登录'&&x.getBoundingClientRect().width>10)}));
  return {open:true,logged_in:session&&!ui.loginButton,state:session?'waiting_for_conversation':'login_required',...ui};
}

async function snapshot(options={}) {
  if(!page || page.isClosed())throw new Error('请先打开浏览器，并登录机器人的抖音账号。');
  const domFile=path.join(path.dirname(fileURLToPath(import.meta.url)),'dom.mjs');
  const version=(await fs.stat(domFile)).mtimeMs;
  const {readChatDOM}=await import(pathToFileURL(domFile).href+'?v='+version);
  const data=await page.evaluate(readChatDOM,{debug:!!options.debug,conversations_only:!!options.conversations_only});
  for(const row of data.conversations||[]){
    row.key=row.conversation_id?hash((row.conversation_type===2?'group:':'')+row.conversation_id):'';
  }
  if(!data.ready)return data;
  const peer=data.peer;
  const group=peer.conversation_type==='group';
  if(group&&!peer.conversation_id)throw new Error('尚未取得稳定的群会话 ID，请打开群资料后重试绑定。');
  const identity=group?'group:'+peer.conversation_id:peer.link?publicURL(peer.link):peer.conversation_id || (peer.name&&peer.avatar?peer.name+'|'+publicURL(peer.avatar):'');
  peer.identity_kind=peer.link?'profile_link':peer.conversation_id?'conversation_id':'name_and_avatar';
  peer.key=identity?hash(identity):'';
  peer.link=publicURL(peer.link);peer.avatar=publicURL(peer.avatar);
  const duplicates=new Map();
  for(const item of data.items) {
    if(group&&item.sender_id&&!/^\d+$/.test(item.sender_id))item.sender_id='dy-member-'+hash(item.sender_id).slice(0,24);
    // Never use the virtual-list index as the message identity: it shifts as new
    // messages arrive. Python aligns repeated content with the previous snapshot.
    item.fingerprint=hash(JSON.stringify([item.sender,item.text,item.links.map(publicURL),item.images.map(publicURL),item.kind,...(group?[item.sender_id]:[])]));
    const occurrence=duplicates.get(item.fingerprint)||0;duplicates.set(item.fingerprint,occurrence+1);
    item.key=item.native_id || item.fingerprint+':'+occurrence;
    item.image_sources=[...(item.images||[])];
    item.images=item.images.map(publicURL);
  }
  return data;
}

async function send(args) {
  const before=await snapshot();
  if(!before.ready || before.peer.key!==args.peer_key)throw new Error('当前私信对象与已绑定对象不一致，未发送。');
  if(args.conversation_type&&before.peer.conversation_type!==args.conversation_type)throw new Error('会话类型已变化，没有发送。');
  if(!before.direction_proven)throw new Error('尚未确认消息的收发方向，未发送。');
  const text=String(args.text||'').trim();
  if(!text || text.length>2000)throw new Error('回复为空或超过当前单条文字限制。');
  const count=before.items.filter(x=>x.sender==='me'&&x.text===text).length;
  await enterReply(page,text);
  await submitReply(page);
  // 回显确认：原来每轮固定等 500ms 再做一次完整 DOM 快照，
  // 且必须熬到第 3 轮（i>=2）才认，单段至少 1.5 秒空等 + 3 次快照。
  // 现在缩短到 200ms 起、逐轮微增，第一轮就接受已确认的回显。
  for(let i=0;i<12;i++) {
    await page.waitForTimeout(i===0?200:Math.min(300+i*60,600));
    const after=await snapshot();
    if(!after.ready || after.peer.key!==args.peer_key)return {state:'unknown',receipt:'conversation_changed_after_send'};
    const matches=after.items.filter(x=>x.sender==='me'&&x.text===text);
    if(matches.length>count) {
      const last=matches.at(-1);
      if(last.failed)return {state:'failed',receipt:'ui_send_failed'};
      if(!last.pending)return {state:'sent',receipt:'ui_own_message_echo',message_key:last.key};
    }
  }
  return {state:'unknown',receipt:'no_confirmed_ui_echo'};
}

// 抖音 IM 用 semi-design 的 semi-upload 组件接收图片。
// customRequest 是空实现，程序化注入 File 不会产生上传；唯一可靠的路径是
// 真实点击 semi-upload-add 触发浏览器 filechooser，再由 Playwright 交付文件。
// 这条路径在 /chat 页面已验证可用（IM 浮层不可用）。
async function attachImageFileViaChooser(file) {
  const box=await page.evaluate(()=>{
    const a=document.querySelector('.semi-upload-add');
    if(!a)return null;
    const r=a.getBoundingClientRect();
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width)};
  });
  if(!box)return {ok:false,error:'no_upload_button'};
  const chooserPromise=page.waitForEvent('filechooser',{timeout:15000});
  // headless 下 Playwright 合成点击常被遮挡层拦截，用真实鼠标坐标点击。
  await page.mouse.click(box.x,box.y);
  let chooser;
  try{ chooser=await chooserPromise; }
  catch{ return {ok:false,error:'filechooser_not_opened',box}; }
  const bytes=await fs.readFile(file);
  const name=path.basename(file);
  const mime=/\.png$/i.test(name)?'image/png':/\.gif$/i.test(name)?'image/gif':/\.jpe?g$/i.test(name)?'image/jpeg':'image/png';
  await chooser.setFiles({name,mimeType:mime,buffer:bytes});
  return {ok:true,via:'filechooser',name,size:bytes.length};
}

// Playwright 原生 setInputFiles：由驱动层写入 files 并派发完整的
// input/change 事件链，是 semi-upload 这类受控组件唯一认得的注入口。
async function attachImageFileNative(file) {
  const input=page.locator('.MsgInputFileUploadim-saas-fileUploader input[type=file]').first();
  if(await input.count()===0)return {ok:false,error:'no_file_input'};
  const bytes=await fs.readFile(file);
  const name=path.basename(file);
  const mime=/.png$/i.test(name)?'image/png':/\.gif$/i.test(name)?'image/gif':/\.jpe?g$/i.test(name)?'image/jpeg':'image/png';
  try{
    await input.setInputFiles({name,mimeType:mime,buffer:bytes},{timeout:20000});
  }catch(error){
    return {ok:false,error:'set_input_files_failed',detail:String(error.message).slice(0,160)};
  }
  return {ok:true,via:'setInputFiles',name,size:bytes.length};
}

async function attachImageFile(file) {
  const bytes=await fs.readFile(file);
  const name=path.basename(file);
  const mime=/.png$/i.test(name)?'image/png':/\.gif$/i.test(name)?'image/gif':/\.jpe?g$/i.test(name)?'image/jpeg':'image/png';
  const b64=bytes.toString('base64');
  return page.evaluate(({b64,name,mime})=>{
    const input=document.querySelector('.MsgInputFileUploadim-saas-fileUploader input[type=file]')
      ||document.querySelector('input[type=file]');
    if(!input)return {ok:false,error:'no_file_input'};
    const bin=atob(b64);const arr=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
    const f=new File([arr],name,{type:mime});
    const dt=new DataTransfer();
    dt.items.add(f);
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'files').set;
    setter.call(input,dt.files);
    const key=Object.keys(input).find(k=>k.indexOf('__reactProps')===0);
    let handler=null;
    if(key&&input[key]&&typeof input[key].onChange==='function')handler=input[key].onChange;
    const ev=new Event('change',{bubbles:true});
    if(handler){handler({target:input,currentTarget:input,nativeEvent:ev,preventDefault(){},stopPropagation(){}});return {ok:true,via:'react_onChange',size:arr.length,name};}
    input.dispatchEvent(ev);
    return {ok:true,via:'dispatch_change',size:arr.length,name};
  },{b64,name,mime});
}

// 抖音网页私信没有独立的语音入口；通用做法是走文件上传通道发音频，
// 由服务端按扩展名识别。这里复用 semi-upload 的 filechooser，
// accept 里若不含音频则明确报错，避免把 wav 当图片塞给图片组件。
// 诊断：列出私信输入区可用的附件入口，确认音频是否被接受。
// 探测 IM 前端是否暴露语音消息类型（发送音频的唯一非文件途径）
async function probeImTypes(args) {
  return page.evaluate(()=>{
    const out={globals:[],enums:{},audioHints:[]};
    for(const key of Object.keys(window)){
      if(!/im|chat|message|msg/i.test(key))continue;
      try{
        const value=window[key];
        if(!value||typeof value!=='object')continue;
        const names=Object.keys(value).filter(k=>/type|Type|content|Content/i.test(k)).slice(0,12);
        if(names.length){out.globals.push(key);out.enums[key]=names;}
      }catch(e){}
    }
    // 已渲染消息里的音频痕迹
    out.audioHints=[...document.querySelectorAll('[class*="oice"],[class*="udio"],[class*="ecord"]')]
      .map(n=>String(n.className).slice(0,60)).slice(0,10);
    out.fileAccept=[...document.querySelectorAll('input[type=file]')].map(x=>x.accept);
    return out;
  });
}

// 诊断：尝试图片上传并记录期间的所有网络请求，定位真实上传接口。
// 诊断：检查页面内所有可能的图片/文件上传入口与其真实可用性
// 诊断：向输入框派发完整拖拽事件链，看是否有 drop 处理器接手文件
// 读取作品页评论区：文本、作者、点赞、是否含图。
// 关键验证：在 /chat 独立页面用 filechooser 上传，捕获真实网络请求。
// /jingxuan 的 IM 浮层点不动上传按钮，但 /chat 页可以。
// 诊断：/chat 页精确列出输入区每个可点控件的坐标与可见性
async function probeChatToolbar(args) {
  await page.goto('https://www.douyin.com/chat',{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(12000);
  const want=(settings&&settings.restore_peer&&settings.restore_peer.name)||'';
  const listed=await snapshot({conversations_only:true});
  const row=(listed.conversations||[]).find(x=>x.name===want)||(listed.conversations||[])[0];
  if(row){
    const {activateConversation}=await import('./conversation_ui.mjs');
    await activateConversation(page,row,snapshot).catch(()=>{});
  }
  await page.waitForTimeout(4000);
  return page.evaluate(()=>{
    const viewport={w:window.innerWidth,h:window.innerHeight};
    const vis=n=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&r.top>=0&&r.top<window.innerHeight&&r.left>=0&&r.left<window.innerWidth;};
    const ed=document.querySelector('[data-mimi-dm-editor="true"]');
    if(!ed)return {viewport,error:'no_editor'};
    const edRect=ed.getBoundingClientRect();
    let area=ed;
    for(let i=0;i<5&&area.parentElement;i++)area=area.parentElement;
    const controls=[...area.querySelectorAll('svg,[role="button"],button,div[class*="upload"],div[class*="Upload"]')]
      .filter(vis)
      .map(n=>{
        const r=n.getBoundingClientRect();
        return {cls:String(n.className?.baseVal||n.className||'').slice(0,55),
          x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),
          w:Math.round(r.width),h:Math.round(r.height)};
      });
    return {viewport,editorRect:{x:Math.round(edRect.x),y:Math.round(edRect.y),w:Math.round(edRect.width)},
      controls:controls.filter((v,i,a)=>a.findIndex(z=>z.cls===v.cls)===i)};
  });
}

async function probeChatUpload(args) {
  const file=String(args.path||'');
  await fs.access(file);
  const bytes=await fs.readFile(file);
  const name=path.basename(file);
  const seen=[];
  const listener=request=>{
    const url=request.url();
    if(/upload|imagex|tos-|aweme\/v1|\/api\//i.test(url))seen.push(request.method()+' '+url.slice(0,140));
  };
  page.on('request',listener);
  let out={};
  try{
    await page.goto('https://www.douyin.com/chat',{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(12000);
    // 选中已绑定会话
    const want=(settings&&settings.restore_peer&&settings.restore_peer.name)||'';
    const listed=await snapshot({conversations_only:true});
    const row=(listed.conversations||[]).find(x=>x.name===want)||(listed.conversations||[])[0];
    if(row){
      const {activateConversation}=await import('./conversation_ui.mjs');
      await activateConversation(page,row,snapshot).catch(()=>{});
    }
    await page.waitForTimeout(4000);
    out.picked=row&&row.name;
    out.hasEditor=await page.evaluate(()=>!!document.querySelector('[data-mimi-dm-editor="true"]'));
    const beforeCount=(await snapshot()).items.length;
    out.before=beforeCount;
    // filechooser 路径
    const box=await page.evaluate(()=>{
      const a=document.querySelector('.semi-upload-add');
      if(!a)return null;
      const r=a.getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
    });
    out.box=box;
    if(box){
      const chooserPromise=page.waitForEvent('filechooser',{timeout:15000});
      await page.mouse.click(box.x,box.y);
      try{
        const chooser=await chooserPromise;
        out.chooser='opened';
        await chooser.setFiles({name,mimeType:'image/png',buffer:bytes});
        out.setFiles='ok';
      }catch(error){
        out.chooser='failed';
        out.chooserError=String(error.message).slice(0,120);
      }
      await page.waitForTimeout(5000);
    }
    out.state=await page.evaluate(()=>({
      uploadItems:document.querySelectorAll('.semi-upload-list-item').length,
      draft:(document.querySelector('[data-mimi-dm-editor="true"]')?.innerText||'').replace(/\u200b/g,'').slice(0,60)
    }));
    const after=await snapshot();
    out.after=after.items.length;
    out.newItems=after.items.slice(beforeCount).map(x=>({kind:x.kind,sender:x.sender,text:String(x.text).slice(0,30)}));
  }finally{
    page.off('request',listener);
  }
  out.requests=seen.slice(0,15);
  return out;
}

// 诊断：作品页里与评论相关的所有容器 class，用于确认真实选择器
// 读取私信里「分享的评论」卡片：文字、配图、表情、语音都可能出现。
// 诊断：dump 分享评论卡片的真实 DOM 结构，区分评论正文与视频标题
// 诊断：把评论区的每个子节点文本与 HTML 都列出来，确认正文是否真的缺失
async function dumpCommentSection(args) {
  return page.evaluate(()=>{
    const vis=n=>{const r=n.getBoundingClientRect();return r.width>10&&r.height>8;};
    const ed=document.querySelector('[data-mimi-dm-editor="true"]');
    let root=ed;
    while(root.parentElement && !root.querySelector('div[data-index],[data-message-id],[data-msg-id]'))root=root.parentElement;
    const boxes=[...root.querySelectorAll('div[data-index]')].filter(vis);
    const cards=boxes.filter(b=>b.querySelector('[class*="CommentSharecardInner"]'));
    const out=[];
    for(const card of cards){
      const sec=card.querySelector('[class*="CommentSharecommentSection"]');
      const aweme=card.querySelector('[class*="CommentShareawemeSection"]');
      const cover=card.querySelector('[class*="CommentSharecommentCover"]');
      out.push({
        commentSectionHTML:(sec?.outerHTML||'').slice(0,1200),
        commentSectionText:(sec?.innerText||'').replace(/\u200b/g,''),
        coverHTML:(cover?.outerHTML||'').slice(0,600),
        coverImgAlt:cover?.querySelector('img')?.alt||'',
        coverImgSrc:(cover?.querySelector('img')?.src||'').slice(0,120),
        isBigEmoji:!!card.querySelector('[class*="bigEmojiCoverWrapper"]'),
        awemeText:(aweme?.innerText||'').replace(/\u200b/g,'').slice(0,120)
      });
    }
    return {count:cards.length,cards:out};
  });
}

async function dumpCommentCard(args) {
  return page.evaluate(()=>{
    const vis=n=>{const r=n.getBoundingClientRect();return r.width>10&&r.height>8;};
    const ed=document.querySelector('[data-mimi-dm-editor="true"]');
    if(!ed)return {ready:false};
    let root=ed;
    while(root.parentElement && !root.querySelector('div[data-index],[data-message-id],[data-msg-id]'))root=root.parentElement;
    const boxes=[...root.querySelectorAll('[data-message-id],[data-msg-id],div[data-index]')]
      .filter(x=>vis(x)&&!x.parentElement?.closest('[data-message-id],[data-msg-id],div[data-index]'));
    const cards=boxes.filter(b=>/的评论/.test(b.innerText||''));
    const pick=cards[cards.length-1];
    if(!pick)return {ready:true,found:false,total:cards.length};
    // 逐层列出带文字的叶子节点及其 class，定位「哪一块是评论正文」
    const leaves=[];
    const walk=(node,depth)=>{
      if(depth>12||!node)return;
      for(const child of node.children||[]){
        const txt=(child.innerText||'').trim();
        if(!txt)continue;
        const own=[...child.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join('').trim();
        leaves.push({d:depth,
          tag:child.tagName,
          cls:String(child.className||'').slice(0,60),
          ownText:own.slice(0,120),
          fullText:txt.slice(0,160),
          childCount:child.children.length});
        if(child.children.length)walk(child,depth+1);
      }
    };
    walk(pick,0);
    return {ready:true,found:true,
      outerHTML:pick.outerHTML.slice(0,3000),
      leaves:leaves.slice(0,40)};
  });
}

async function dumpMessageHtml(args) {
  const id=String(args.id||'');
  const tail=Number(args.tail||3);
  return page.evaluate(({id,tail})=>{
    const vis=n=>{const r=n.getBoundingClientRect();return r.width>10&&r.height>8;};
    const ed=document.querySelector('[data-mimi-dm-editor="true"]');
    if(!ed)return {ready:false,reason:'no_editor'};
    let root=ed;
    while(root.parentElement && !root.querySelector('div[data-index],[data-message-id],[data-msg-id]'))root=root.parentElement;
    const boxes=[...root.querySelectorAll('[data-message-id],[data-msg-id],div[data-index]')]
      .filter(x=>vis(x)&&!x.parentElement?.closest('[data-message-id],[data-msg-id],div[data-index]'));
    const pick=id?boxes.filter(b=>(b.getAttribute('data-message-id')||b.getAttribute('data-msg-id'))===id):boxes.slice(-tail);
    return {ready:true,count:pick.length,boxes:pick.map(b=>{
      const r=b.getBoundingClientRect();
      const nodes=[...b.querySelectorAll('*')];
      return {
        id:b.getAttribute('data-message-id')||b.getAttribute('data-msg-id')||'',
        className:String(b.className),
        w:Math.round(r.width),h:Math.round(r.height),
        text:(b.innerText||'').replace(/\u200b/g,'').trim().slice(0,160),
        tags:[...new Set(nodes.map(n=>n.tagName))].slice(0,20),
        classes:[...new Set(nodes.map(n=>String(n.className||'')).filter(Boolean))].slice(0,40),
        videos:[...b.querySelectorAll('video')].map(v=>({src:String(v.src||'').slice(0,100),duration:v.duration,readyState:v.readyState})),
        audios:b.querySelectorAll('audio').length,
        imgs:[...b.querySelectorAll('img')].map(i=>String(i.src||'').slice(0,70)).slice(0,4),
        html:b.outerHTML.slice(0,2200)
      };
    })};
  },{id,tail});
}

async function readSharedComment(args) {
  const key=String(args.message_key||'');
  return page.evaluate(targetKey=>{
    const vis=n=>{const r=n.getBoundingClientRect();return r.width>10&&r.height>8;};
    const ed=document.querySelector('[data-mimi-dm-editor="true"]');
    if(!ed)return {ready:false,reason:'no_editor'};
    let root=ed;
    while(root.parentElement && !root.querySelector('div[data-index],[data-message-id],[data-msg-id]'))root=root.parentElement;
    const boxes=[...root.querySelectorAll('[data-message-id],[data-msg-id],div[data-index]')]
      .filter(x=>vis(x)&&!x.parentElement?.closest('[data-message-id],[data-msg-id],div[data-index]'));
    let cards=boxes.filter(b=>b.querySelector('[class*="CommentSharecardInner"]'));
    if(!cards.length)cards=boxes.filter(b=>/的评论/.test(b.innerText||''));
    const parseCard=(node)=>{
      const commentSection=node.querySelector('[class*="CommentSharecommentSection"]');
      const awemeSection=node.querySelector('[class*="CommentShareawemeSection"]');
      const titleEl=node.querySelector('[class*="CommentSharecommentTitle"]');
      const authorEl=node.querySelector('[class*="CommentSharetitleName"]');
      const coverEl=node.querySelector('[class*="CommentSharecommentCover"]');
      const isBigEmoji=!!node.querySelector('[class*="bigEmojiCoverWrapper"]');
      const titleText=(titleEl?.innerText||'').replace(/\u200b/g,'').trim();
      const textEl=commentSection?.querySelector('[class*="CommentSharecommentText"]');
      let commentText='';
      if(textEl)commentText=(textEl.innerText||textEl.textContent||'').replace(/\u200b/g,'').trim();
      if(!commentText){
        const sectionText=(commentSection?.innerText||'').replace(/\u200b/g,'').trim();
        commentText=sectionText;
        if(titleText&&commentText.startsWith(titleText))commentText=commentText.slice(titleText.length);
      }
      commentText=commentText.replace(/\s{2,}/g,' ').trim();
      return {
        native_id:node.getAttribute('data-message-id')||node.getAttribute('data-msg-id')||'',
        author:(authorEl?.innerText||'').trim(),
        comment_text:commentText,
        comment_is_emoji:isBigEmoji,
        comment_images:coverEl?[...coverEl.querySelectorAll('img')].map(i=>({src:i.src,alt:i.alt||''})):[],
        aweme_text:(awemeSection?.innerText||'').replace(/\u200b/g,'').replace(/\s{2,}/g,' ').trim(),
        aweme_images:awemeSection?[...awemeSection.querySelectorAll('img')]
          .filter(i=>/awemeCover/.test(String(i.className)||''))
          .map(i=>({src:i.src,alt:i.alt||''})):[],
        voices:[...node.querySelectorAll('audio,[class*="voice"],[class*="Voice"]')]
          .map(a=>({tag:a.tagName,cls:String(a.className).slice(0,50),src:a.src||''}))
      };
    };
    if(!cards.length)return {ready:true,found:false,cards:0};
    const wanted=targetKey?cards.filter(b=>{
      const id=b.getAttribute('data-message-id')||b.getAttribute('data-msg-id');
      return id===targetKey;
    }):[];
    const list=wanted.length?wanted:cards;
    const parsed=list.map(parseCard);
    const pick=parsed[parsed.length-1];
    return {ready:true,found:true,...pick,all:parsed,cardCount:parsed.length};

    // 按抖音真实结构分区读取，不做文本猜测：
    const commentSection=pick.querySelector('[class*="CommentSharecommentSection"]');
    const awemeSection=pick.querySelector('[class*="CommentShareawemeSection"]');
    const titleEl=pick.querySelector('[class*="CommentSharecommentTitle"]');
    const authorEl=pick.querySelector('[class*="CommentSharetitleName"]');
    const coverEl=pick.querySelector('[class*="CommentSharecommentCover"]');
    const isBigEmoji=!!pick.querySelector('[class*="bigEmojiCoverWrapper"]');

    const titleText=(titleEl?.innerText||'').replace(/\u200b/g,'').trim();
    // 评论正文优先从 commentText 读（文字评论），其次才从整段里剥标题。
    // 表情包评论没有 commentText 节点，只有 bigEmojiCover 图片。
    const textEl=commentSection?.querySelector('[class*="CommentSharecommentText"]');
    let commentText='';
    if(textEl){
      commentText=(textEl.innerText||textEl.textContent||'').replace(/\u200b/g,'').trim();
    }
    if(!commentText){
      const sectionText=(commentSection?.innerText||'').replace(/\u200b/g,'').trim();
      commentText=sectionText;
      if(titleText&&commentText.startsWith(titleText))commentText=commentText.slice(titleText.length);
    }
    commentText=commentText.replace(/\s{2,}/g,' ').trim();

    const coverImages=coverEl?[...coverEl.querySelectorAll('img')].map(i=>({src:i.src,alt:i.alt||''})):[];
    const awemeImgs=awemeSection?[...awemeSection.querySelectorAll('img')]
      .filter(i=>/awemeCover/.test(String(i.className)||''))
      .map(i=>({src:i.src,alt:i.alt||''})):[];
    const awemeText=(awemeSection?.innerText||'').replace(/\u200b/g,'').replace(/\s{2,}/g,' ').trim();
    const voices=[...pick.querySelectorAll('audio,[class*="voice"],[class*="Voice"]')]
      .map(a=>({tag:a.tagName,cls:String(a.className).slice(0,50),src:a.src||''}));

    return {ready:true,found:true,
      native_id:pick.getAttribute('data-message-id')||pick.getAttribute('data-msg-id')||'',
      author:(authorEl?.innerText||'').trim(),
      comment_title:titleText,
      comment_text:commentText,
      comment_is_emoji:isBigEmoji,
      comment_images:coverImages,
      aweme_text:awemeText,
      aweme_images:awemeImgs,
      voices,
      cardCount:cards.length};
  },key);
}

async function probeCommentDom(args) {
  const url=String(args.url||'');
  const {openBackgroundPage}=await import('./browser_actions.mjs');
  const tab=await openBackgroundPage(context,page);
  try{
    await tab.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
    await tab.waitForTimeout(7000);
    await tab.evaluate(async()=>{ for(let i=0;i<5;i++){ window.scrollBy(0,900); await new Promise(r=>setTimeout(r,600)); } });
    await tab.waitForTimeout(2000);
    return await tab.evaluate(()=>{
      const vis=n=>{const r=n.getBoundingClientRect();return r.width>10&&r.height>8;};
      const all=[...document.querySelectorAll('*')].filter(vis);
      const commentish=all.filter(n=>/comment/i.test(String(n.className||'')+' '+(n.getAttribute('data-e2e')||'')))
        .map(n=>({tag:n.tagName,cls:String(n.className).slice(0,70),e2e:n.getAttribute('data-e2e')}));
      const uniq=[];const seen=new Set();
      for(const c of commentish){const k=c.cls+c.e2e;if(!seen.has(k)){seen.add(k);uniq.push(c);}}
      // 找一个看起来像单条评论的节点
      const sample=uniq.find(c=>/item/i.test(c.cls+c.e2e))||uniq[0];
      let sampleHTML='';
      if(sample){
        const el=all.find(n=>String(n.className).slice(0,70)===sample.cls);
        if(el)sampleHTML=el.outerHTML.slice(0,900);
      }
      return {total:uniq.length,classes:uniq.slice(0,25),sampleHTML,
        e2eAll:[...new Set([...document.querySelectorAll('[data-e2e]')].map(x=>x.getAttribute('data-e2e')))].slice(0,25)};
    });
  }finally{ await tab.close().catch(()=>{}); }
}

async function readPostComments(args) {
  const url=String(args.url||'');
  if(!url)throw new Error('缺少作品链接。');
  const limit=Math.max(1,Math.min(50,Number(args.limit||20)));
  const {openBackgroundPage}=await import('./browser_actions.mjs');
  const tab=await openBackgroundPage(context,page);
  try{
    await tab.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
    await tab.waitForTimeout(6000);
    // 评论区常需滚动才渲染，先把评论面板滚几屏。
    await tab.evaluate(async ()=>{
      // 评论列表在 [data-e2e="comment-list"] 里，先滚动它让内容渲染
      const panel=document.querySelector('[data-e2e="comment-list"]')||document.scrollingElement;
      for(let i=0;i<6;i++){
        panel.scrollBy(0,800);
        await new Promise(r=>setTimeout(r,700));
      }
      await new Promise(r=>setTimeout(r,1200));
    });
    const data=await tab.evaluate(limit=>{
      const vis=n=>n.getBoundingClientRect().width>10&&n.getBoundingClientRect().height>8;
      const root=document.querySelector('[data-e2e="comment-list"]')||document;
      // 单条评论在 comment-list 内，用结构区分：含作者名与内容且带头像
      const nodes=[...root.querySelectorAll('[class*="commentItem"],[class*="CommentItem"],div[class*="comment"]')]
        .filter(vis)
        .filter(n=>{
          const hasAvatar=!!n.querySelector('img');
          const txt=(n.innerText||'').trim();
          return hasAvatar&&txt.length>2&&txt.length<600;
        });
      const rows=[];
      for(const node of nodes.slice(0,limit)){
        const textNode=node.querySelector('[class*="content"],[class*="Content"],[class*="text"],[class*="Text"]');
        const text=(textNode?.innerText||node.innerText||'').replace(/\s+/g,' ').trim();
        if(!text)continue;
        const author=node.querySelector('[class*="name"],[class*="Name"],[class*="nickname"],[class*="NickName"]')?.innerText?.trim()||'';
        const likes=node.querySelector('[class*="like"],[class*="Like"]')?.innerText?.trim()||'';
        const images=[...node.querySelectorAll('img')]
          .filter(img=>!img.closest('[class*="avatar"],[class*="Avatar"]'))
          .map(img=>img.src).slice(0,3);
        rows.push({author,text:text.slice(0,300),likes,images});
      }
      return {total:nodes.length,rows,
        e2eNames:[...new Set([...document.querySelectorAll('[data-e2e]')].map(x=>x.getAttribute('data-e2e')))].filter(x=>/comment/i.test(x)).slice(0,12)};
    },limit);
    return data;
  }finally{
    await tab.close().catch(()=>{});
  }
}

async function probeDropUpload(args) {
  const file=String(args.path||'');
  await fs.access(file);
  const bytes=await fs.readFile(file);
  const name=path.basename(file);
  const before=await snapshot();
  const count=before.items.length;
  const seen=[];
  const listener=request=>{
    const url=request.url();
    if(/upload|imagex|tos-|aweme\/v1/i.test(url))seen.push(request.method()+' '+url.slice(0,120));
  };
  page.on('request',listener);
  try{
    await page.evaluate(async ({b64,fileName})=>{
      const bin=atob(b64);const arr=new Uint8Array(bin.length);
      for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
      const file=new File([arr],fileName,{type:'image/png'});
      const dt=new DataTransfer();dt.items.add(file);
      const targets=[document.querySelector('[data-mimi-dm-editor="true"]'),
        document.querySelector('.messageEditorimChatEditorContainer'),
        document.querySelector('.semi-upload')];
      for(const target of targets){
        if(!target)continue;
        for(const type of ['dragenter','dragover','drop']){
          target.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt}));
        }
      }
      await new Promise(r=>setTimeout(r,3000));
    },{b64:bytes.toString('base64'),fileName:name});
    await page.waitForTimeout(3000);
  }finally{
    page.off('request',listener);
  }
  const after=await page.evaluate(()=>({
    uploadItems:document.querySelectorAll('.semi-upload-list-item').length,
    draft:(document.querySelector('[data-mimi-dm-editor="true"]')?.innerText||'').replace(/\u200b/g,'').slice(0,60)
  }));
  const post=await snapshot();
  return {requests:seen.slice(0,12),state:after,itemsBefore:count,itemsAfter:post.items.length};
}

async function probeUploadEntries(args) {
  return page.evaluate(()=>{
    const describe=el=>{
      const fiberKey=Object.keys(el).find(k=>k.indexOf('__reactFiber')===0);
      let custom=null,action=null;
      if(fiberKey){
        let fiber=el[fiberKey];let guard=0;
        while(fiber&&guard++<25){
          const props=fiber.memoizedProps;
          if(props&&props.customRequest){custom=String(props.customRequest).slice(0,60);action=props.action;break;}
          fiber=fiber.return;
        }
      }
      return {cls:String(el.className?.baseVal||el.className||'').slice(0,55),
        accept:el.accept||null,custom,action};
    };
    return {
      allInputs:[...document.querySelectorAll('input[type=file]')].map(describe),
      uploadRoots:[...document.querySelectorAll('.semi-upload,[class*="FileUpload"]')].map(describe),
      // 页面是否有拖拽上传提示层
      dropZones:[...document.querySelectorAll('[class*="drop"],[class*="Drop"]')].length
    };
  });
}

async function confirmSendFileModal() {
  for(let wait=0;wait<16;wait++){
    const clicked=await page.evaluate(()=>{
      const btn=document.querySelector('button[class*="MsgInputSendFileModalbtnSure"],[class*="MsgInputSendFileModalbtnSure"]')
        ||[...document.querySelectorAll('.semi-modal button,[class*="SendFileModal"] button')].find(b=>/发送/.test(b.innerText||''));
      if(!btn||btn.getBoundingClientRect().width<10)return null;
      const r=btn.getBoundingClientRect();
      const o={bubbles:true,cancelable:true,composed:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2,view:window};
      btn.dispatchEvent(new PointerEvent('pointerdown',o));
      btn.dispatchEvent(new MouseEvent('mousedown',o));
      btn.dispatchEvent(new PointerEvent('pointerup',o));
      btn.dispatchEvent(new MouseEvent('mouseup',o));
      btn.dispatchEvent(new MouseEvent('click',o));
      btn.click();
      return {text:(btn.innerText||'').trim(),x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
    });
    if(clicked)return {confirmed:true,...clicked};
    await page.waitForTimeout(250);
  }
  return {confirmed:false};
}

async function probeImageUpload(args) {
  const file=String(args.path||'');
  if(!file)throw new Error('缺少图片路径。');
  await fs.access(file);
  const seen=[];
  const listener=request=>{
    const url=request.url();
    if(/upload|imagex|tos-|aweme\/v1|\/api\//i.test(url))seen.push(request.method()+' '+url.slice(0,130));
  };
  page.on('request',listener);
  let attached={ok:false},modal={confirmed:false};
  try{
    attached=await attachImageFileNative(file);
    if(!attached.ok)attached=await attachImageFileViaChooser(file);
    modal=await confirmSendFileModal();
    await page.waitForTimeout(3500);
  }finally{
    page.off('request',listener);
  }
  const state=await page.evaluate(()=>({
    uploadItems:document.querySelectorAll('.semi-upload-list-item').length,
    draft:(document.querySelector('[data-mimi-dm-editor="true"]')?.innerText||'').replace(/\u200b/g,'').slice(0,60)
  }));
  return {attached,modal,requests:seen.slice(0,15),state};
}

async function inspectVoice(args) {
  return page.evaluate(()=>{
    const vis=n=>n.getBoundingClientRect().width>8&&n.getBoundingClientRect().height>8;
    const ed=document.querySelector('[data-mimi-dm-editor="true"]');
    if(!ed)return {ready:false,reason:'no_editor'};
    let area=ed;
    for(let i=0;i<6&&area.parentElement;i++)area=area.parentElement;
    const nodes=[...area.querySelectorAll('svg,[role="button"],button,[class*="upload"]')].filter(vis)
      .map(n=>({tag:n.tagName,cls:String(n.className?.baseVal||n.className||'').slice(0,60),apm:n.getAttribute('data-apm-action')}));
    const uniq=[];const seen=new Set();
    for(const n of nodes){const k=n.cls+n.apm;if(!seen.has(k)){seen.add(k);uniq.push(n);}}
    return {ready:true,fileAccept:[...document.querySelectorAll('input[type=file]')].map(x=>x.accept),controls:uniq};
  });
}

const keySet=snap=>new Set((snap.items||[]).map(x=>x.key||x.native_id).filter(Boolean));
const freshMine=(snap,seen)=>((snap.items||[]).filter(x=>x.sender==='me'&&!seen.has(x.key||x.native_id)));

async function sendRecord(args) {
  const before=await snapshot();
  if(!before.ready || before.peer.key!==args.peer_key)throw new Error('当前私信对象与已绑定对象不一致，未发送。');
  if(args.conversation_type&&before.peer.conversation_type!==args.conversation_type)throw new Error('会话类型已变化，没有发送。');
  if(!before.direction_proven)throw new Error('尚未确认消息的收发方向，未发送。');
  const file=String(args.path||'');
  if(!file)throw new Error('缺少要发送的语音文件。');
  await fs.access(file);
  const bytes=await fs.readFile(file);
  if(bytes.length<1000)throw new Error('语音文件内容为空。');
  const name=path.basename(file);
  const mime=/\.mp3$/i.test(name)?'audio/mpeg':/\.m4a$/i.test(name)?'audio/mp4':/\.mp4$/i.test(name)?'video/mp4':'audio/wav';
  const beforeCount=before.items.length;
  const input=page.locator('.MsgInputFileUploadim-saas-fileUploader input[type=file]').first();
  if(await input.count()===0)throw new Error('私信面板未提供文件上传入口。');
  const seen=keySet(before);
  await input.setInputFiles({name,mimeType:mime,buffer:bytes},{timeout:20000});
  const modal=await confirmSendFileModal();
  if(!modal.confirmed)await submitReply(page);
  // 文件/video 消息上传比文字慢：服务端转码 + 回包常常 15 秒以上，
  // 早期版本只等 10 秒就判 unknown，导致"其实发出去了却报告失败"。
  for(let i=0;i<60;i++){
    await page.waitForTimeout(500);
    const after=await snapshot();
    if(!after.ready||after.peer.key!==args.peer_key)return {state:'unknown',receipt:'conversation_changed_after_send',modal};
    const fresh=freshMine(after,seen);
    if(fresh.length){
      const hit=fresh.at(-1);
      if(hit.failed)return {state:'failed',receipt:'ui_send_failed',modal};
      if(!hit.pending)return {state:'sent',receipt:'ui_record_echo',message_key:hit.key,kind:hit.kind,modal};
    }
  }
  return {state:'unknown',receipt:'no_confirmed_record_echo',modal};
}

async function sendImage(args) {
  const before=await snapshot();
  if(!before.ready || before.peer.key!==args.peer_key)throw new Error('当前私信对象与已绑定对象不一致，未发送。');
  if(args.conversation_type&&before.peer.conversation_type!==args.conversation_type)throw new Error('会话类型已变化，没有发送。');
  if(!before.direction_proven)throw new Error('尚未确认消息的收发方向，未发送。');
  const file=String(args.path||'');
  if(!file)throw new Error('缺少要发送的图片文件。');
  await fs.access(file);
  const seen=keySet(before);
  let attached=await attachImageFileNative(file);
  if(!attached.ok)attached=await attachImageFileViaChooser(file);
  if(!attached.ok)attached=await attachImageFile(file);
  if(!attached.ok)throw new Error('私信面板未提供图片上传入口。');
  const modal=await confirmSendFileModal();
  if(!modal.confirmed){
    await page.waitForTimeout(1000);
    await submitReply(page);
  }
  for(let i=0;i<60;i++) {
    await page.waitForTimeout(500);
    const after=await snapshot();
    if(!after.ready || after.peer.key!==args.peer_key)return {state:'unknown',receipt:'conversation_changed_after_send',attached,modal};
    const fresh=freshMine(after,seen);
    if(fresh.length){
      const hit=fresh.at(-1);
      if(hit.failed)return {state:'failed',receipt:'ui_send_failed',attached,modal};
      if(!hit.pending)return {state:'sent',receipt:'ui_image_echo',message_key:hit.key,kind:hit.kind,attached,modal};
    }
  }
  return {state:'unknown',receipt:'no_confirmed_image_echo',attached,modal};
}

async function gotoChat(args) {
  try{ await page.bringToFront(); }catch(e){}
  try{ const __s=await context.newCDPSession(page); await __s.send('Emulation.setFocusEmulationEnabled',{enabled:true}).catch(()=>{}); await __s.detach().catch(()=>{}); }catch(e){}
  await page.goto('https://www.douyin.com/chat',{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(12000);
  let listed=await snapshot({conversations_only:true});
  let rows=listed.conversations||[];
  // /chat 页必须先点开会话才会渲染编辑器；优先恢复已绑定会话。
  const want=args.name||(settings&&settings.restore_peer&&settings.restore_peer.name)||'';
  const wantID=args.conversation_id||(settings&&settings.restore_peer&&settings.restore_peer.conversation_id)||'';
  const pick=rows.find(x=>wantID&&x.conversation_id===wantID)||rows.find(x=>want&&x.name===want)||rows[0];
  if(pick){
    const {activateConversation}=await import('./conversation_ui.mjs');
    try{ await activateConversation(page,pick,snapshot); }catch(e){}
  }
  await page.waitForTimeout(3000);
  listed=await snapshot({conversations_only:true});
  rows=listed.conversations||[];
  return {url:page.url(),picked:pick&&pick.name,conversations:rows.length,
    names:rows.slice(0,5).map(x=>x.name)};
}

async function selectConversation(args) {
  const list=await snapshot({conversations_only:true});
  const matches=(list.conversations||[]).filter(item=>args.conversation_id?
    item.conversation_id===args.conversation_id:item.name===args.name);
  if(matches.length!==1)throw new Error(matches.length?'存在同名会话，请使用会话 ID 选择。':'当前列表未找到指定会话，请先在抖音消息列表中打开它。');
  const {activateConversation}=await import('./conversation_ui.mjs');
  return activateConversation(page,matches[0],snapshot);
}

async function download(args) {
  const mediaFile=path.join(path.dirname(fileURLToPath(import.meta.url)),'media.mjs');
  const version=(await fs.stat(mediaFile)).mtimeMs;
  const {downloadVideo}=await import(pathToFileURL(mediaFile).href+'?v='+version);
  return downloadVideo(args,{context,page,settings,snapshot,siteHost,mediaHost,publicURL});
}

async function postInfo(args) {
  const {readPost}=await import('./post_media.mjs');
  return await readPost({...args,info_only:true,probe_comment:true},{context,page,settings,snapshot,siteHost,mediaHost,publicURL});
}

async function explore(action,args) {
  const {browsePost,publishComment}=await import('./explore.mjs');
  const environment={context,page,settings,snapshot,siteHost,mediaHost,publicURL};
  return await (action==='browse'?browsePost:publishComment)(args,environment);
}

const input=readline.createInterface({input:process.stdin});
let queue=Promise.resolve();
input.on('line',line=>{queue=queue.then(async()=>{
  let request;
  try {
    request=JSON.parse(line);
    const actions={open:()=>open(request.args),status,snapshot:()=>snapshot(request.args),conversations:()=>snapshot({conversations_only:true}),select_conversation:()=>selectConversation(request.args),send:()=>send(request.args),send_image:()=>sendImage(request.args),send_record:()=>sendRecord(request.args),inspect_voice:()=>inspectVoice(request.args),probe_im_types:()=>probeImTypes(request.args),probe_image_upload:()=>probeImageUpload(request.args),probe_upload_entries:()=>probeUploadEntries(request.args),probe_drop_upload:()=>probeDropUpload(request.args),read_comments:()=>readPostComments(request.args),probe_comment_dom:()=>probeCommentDom(request.args),read_shared_comment:()=>readSharedComment(request.args),dump_message_html:()=>dumpMessageHtml(request.args),dump_comment_card:()=>dumpCommentCard(request.args),dump_comment_section:()=>dumpCommentSection(request.args),probe_chat_upload:()=>probeChatUpload(request.args),probe_chat_toolbar:()=>probeChatToolbar(request.args),goto_chat:()=>gotoChat(request.args),download:()=>download(request.args),post_info:()=>postInfo(request.args),
      browse:()=>explore('browse',request.args),comment:()=>explore('comment',request.args),
      set_busy:async()=>{globalThis.__busyUntil=(request.args&&request.args.busy)?Date.now()+180000:0;return {busyUntil:globalThis.__busyUntil}},
      heal:async()=>{
        if(!page||page.isClosed())throw new Error('页面不存在。');
        let w=await healDialog();
        if(w<100&&Date.now()-lastHeal>90000){await reloadPage();w=await healDialog();}
        const ed=await page.evaluate(()=>{
          const x=document.querySelector('.messageEditorinputArea');
          return x?Math.round(x.getBoundingClientRect().width):-1;
        }).catch(()=>-1);
        return {dialog:w,editor:ed};
      },
      configure:async()=>{
        const limit=request.args.max_download_mb??settings.max_download_mb;
        const durationLimit=request.args.max_video_duration_seconds??settings.max_video_duration_seconds??180;
        if(!Number.isInteger(limit)||limit<1||limit>10000)throw new Error('作品下载大小上限应为 1～10000 MB。');
        if(!Number.isInteger(durationLimit)||durationLimit<0||durationLimit>10000)throw new Error('视频时长上限应为 0～10000 秒。');
        await fs.mkdir(request.args.media_dir,{recursive:true});
        settings.media_dir=request.args.media_dir;settings.max_download_mb=limit;settings.max_video_duration_seconds=durationLimit;
        return {media_dir:settings.media_dir,max_download_mb:settings.max_download_mb,max_video_duration_seconds:durationLimit};
      },
      close:async()=>{if(keepTimer)clearInterval(keepTimer);if(probeTimer)clearInterval(probeTimer);keepTimer=null;probeTimer=null;context=null;page=null;return {closed:true};}};
    if(!actions[request.action])throw new Error('未知浏览器操作。');
    const action=String(request.action||'');
    const limits={browse:95000,comment:95000,open:60000,download:120000,post_info:90000};
    const hardLimit=limits[action]||45000;
    let timer;
    try{
      const result=await Promise.race([
        actions[request.action](),
        new Promise((_,rej)=>{timer=setTimeout(()=>rej(new Error('browser action hard timeout: '+action)),hardLimit)})
      ]);
      process.stdout.write(JSON.stringify({id:request.id,ok:true,result})+'\n');
    }finally{if(timer)clearTimeout(timer)}
  } catch(error) {
    // Do not put signed media URLs, cookies, or page HTML in logs.
    const message=String(error.message||error).replace(/https?:\/\/\S+/g,'[URL]').slice(0,500);
    process.stdout.write(JSON.stringify({id:request?.id,ok:false,error:message})+'\n');
  }
});});
input.on('close',()=>{queue.finally(async()=>{if(keepTimer)clearInterval(keepTimer);if(probeTimer)clearInterval(probeTimer);process.exit(0);});});

