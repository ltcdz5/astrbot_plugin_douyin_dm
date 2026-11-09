// Keep routine chat actions inside the page instead of issuing mouse clicks.
export async function enterReply(page,text) {
  const editor=page.locator('[data-mimi-dm-editor="true"]').first();
  await editor.focus();
  await editor.press('Control+A');
  await editor.press('Backspace');
  await page.keyboard.insertText(text);
  const norm=value=>String(value||'').replace(/[​﻿]/g,'').replace(/\s+/g,' ').trim();
  const want=norm(text);
  const got=norm(await editor.innerText());
  if(!got) throw new Error('输入框未能正确写入，未发送。');
  const a=got.replace(/ /g,''),b=want.replace(/ /g,'');
  if(a!==b && !a.startsWith(b.slice(0,Math.min(b.length,20))) && !b.startsWith(a.slice(0,Math.min(a.length,20))))
    throw new Error('输入框未能正确写入，未发送。');
}

export async function submitReply(page) {
  // headless 环境下抖音不响应鼠标/键盘合成事件，直接调用 React 的 onClick。
  const nodes=page.locator('.e2e-send-msg-btn');
  if(await nodes.count()===0) throw new Error('没有定位到私信发送按钮。');
  const result=await nodes.first().evaluate(node=>{
    const key=Object.keys(node).find(k=>k.indexOf('__reactProps')===0);
    if(!key) throw new Error('发送按钮缺少 React 处理器，未能发送。');
    const props=node[key]||{};
    if(typeof props.onClick!=='function') throw new Error('私信发送按钮尚未就绪。');
    const fake={preventDefault(){},stopPropagation(){},nativeEvent:{},currentTarget:node,target:node,type:'click',bubbles:true};
    props.onClick(fake);
    return 'react_onClick';
  });
  return result;
}

export async function openBackgroundPage(context,anchor) {
  // This integration uses Chromium's persistent default context. A normal
  // context.newPage() creates an active tab and can activate the browser app.
  const session=await context.newCDPSession(anchor);
  let targetId;
  try {
    const created=context.waitForEvent('page',{timeout:15000});
    created.catch(()=>{});
    ({targetId}=await session.send('Target.createTarget',{url:'about:blank',background:true}));
    const tab=await created;
    const probe=await context.newCDPSession(tab);
    try {
      const {targetInfo}=await probe.send('Target.getTargetInfo');
      if(targetInfo.targetId!==targetId)throw new Error('视频后台标签页未能正确绑定。');
    } finally {await probe.detach();}
    return tab;
  } catch(error) {
    if(targetId)await session.send('Target.closeTarget',{targetId}).catch(()=>{});
    throw error;
  } finally {await session.detach();}
}
