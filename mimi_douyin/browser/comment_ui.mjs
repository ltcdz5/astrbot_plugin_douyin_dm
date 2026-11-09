const editorSelector=[
  '.comment-input-inner-container [contenteditable="true"]','.comment-input-inner-container [contenteditable="plaintext-only"]',
  '.comment-input-inner-container textarea','.comment-input-inner-container input',
  '[data-e2e="comment-input"][contenteditable="true"]','[data-e2e="comment-input"] [contenteditable="true"]',
  '[data-e2e="comment-input"] textarea','textarea[placeholder*="评论"]',
  '[contenteditable="true"][data-placeholder*="评论"]'
].join(',');

export async function getCommentEditor(tab,{timeout=30000}={}) {
  const deadline=Date.now()+timeout;
  do {
    const editor=tab.locator(editorSelector).filter({visible:true});
    const count=await editor.count();
    if(count===1)return editor;
    if(count>1)throw new Error('评论输入框不唯一，未提交。');
    const placeholder=tab.locator('.comment-input-inner-container').filter({visible:true});
    if(await placeholder.count()===1) {
      // The placeholder is replaced by Draft.js after hydration; retry fresh locators.
      await placeholder.evaluate(node=>(node.querySelector('span')||node).click()).catch(()=>{});
    }
    await tab.waitForTimeout(250);
  } while(Date.now()<deadline);
  throw new Error('评论输入框加载超时，请检查账号验证或该作品的评论权限。');
}

// Only "@nick" followed by ASCII spaces (or at end of text) becomes a real
// mention. Selecting a Draft.js candidate always inserts one spacer after the
// entity, so requiring that spacer in the source keeps the final comment
// byte-for-byte equal to the caller's text. Glued punctuation, newlines and
// e-mail-like text stay plain and are never rewritten.
export function commentParts(text) {
  const parts=[];let offset=0;
  const pattern=/(?<!\S)@([^\s@，。！？、：；]{1,40})(?=( +|$))/gu;
  for(const match of text.matchAll(pattern)) {
    const at=match.index;
    if(at>offset)parts.push({text:text.slice(offset,at)});
    parts.push({mention:match[1],spaces:match[2]||''});
    offset=at+1+match[1].length+(match[2]||'').length;
  }
  if(offset<text.length)parts.push({text:text.slice(offset)});
  return parts;
}

export async function fillComment(tab,editor,text,{mentionTimeout=12000,entityTimeout=5000,stableMs=1200}={}) {
  // Draft.js does not always honor a single Control+A / Backspace. Verify the
  // editor is actually empty before typing, so a second draft never appends to
  // the previous comment.
  await editor.focus();
  for(let attempt=0;attempt<4;attempt++) {
    await editor.press('Control+A');await editor.press('Backspace');
    await tab.waitForTimeout(150);
    const left=await editor.evaluate(node=>(node.value??node.innerText).replace(/[\u200b\ufeff]/g,'').trim());
    if(!left)break;
    if(attempt===3)throw new Error('评论编辑器未能清空，未提交。');
  }
  await captureEmptyCommentControls(tab);
  const mentions=[];
  for(const part of commentParts(text)) {
    if(part.text!==undefined) {
      await tab.keyboard.insertText(part.text);continue;
    }
    await editor.focus();
    // insertText('@') skips key handlers on some Draft.js versions.
    await tab.keyboard.type('@',{delay:80});
    await tab.waitForTimeout(700);
    await tab.keyboard.type(part.mention,{delay:100});
    const candidates=tab.locator('.comment-input-inner-container .atBox-inner-container')
      .getByText(part.mention,{exact:true}).filter({visible:true});
    // Wait for this query's result set to stabilize. Clicking the first single
    // hit would bypass ambiguity protection if results arrive in batches.
    const deadline=Date.now()+mentionTimeout;
    let stableSince=0,lastCount=-1,selected=false,ambiguous=false;
    do {
      const count=await candidates.count();
      if(count>1){ambiguous=true;break;}
      if(count===1) {
        if(count!==lastCount){stableSince=Date.now();lastCount=count;}
        if(Date.now()-stableSince>=stableMs) {
          await candidates.evaluate(node=>{
            node.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));
            node.click();
          });
          selected=true;break;
        }
      } else {lastCount=count;stableSince=0;}
      await tab.waitForTimeout(200);
    } while(Date.now()<deadline);
    if(ambiguous)throw new Error('艾特用户存在同名候选：'+part.mention+'，未提交。');
    if(!selected) {
      const state=await editor.evaluate(node=>({expanded:node.getAttribute('aria-expanded'),text:node.innerText}));
      throw new Error('未找到唯一的艾特用户：'+part.mention+'，未提交。'+JSON.stringify(state));
    }
    mentions.push(part.mention);
    // React commits the entity asynchronously; also wait for the popup to close
    // before typing the next segment, otherwise text lands in the search box.
    const entityDeadline=Date.now()+entityTimeout;let ready=false;
    do {
      const state=await editor.evaluate(node=>({
        entities:[...node.querySelectorAll('.douyin_mention_word')].map(x=>x.innerText),
        expanded:node.getAttribute('aria-expanded')
      }));
      if(state.entities.length===mentions.length&&state.entities.at(-1)==='@'+part.mention
          &&state.expanded==='false'){ready=true;break;}
      await tab.waitForTimeout(150);
    } while(Date.now()<entityDeadline);
    if(!ready)throw new Error('艾特用户未生成提及节点或候选面板未关闭，未提交。');
    // The platform already inserted one spacer; restore any extra source spaces.
    if(part.spaces.length>1)await tab.keyboard.insertText(part.spaces.slice(1));
    await editor.focus();await editor.press('End');
  }
  await tab.waitForTimeout(100);
  const entered=await editor.evaluate(node=>node.value??node.innerText);
  const clean=value=>value.replace(/[\u200b\ufeff]/g,'').trim();
  // Compare against the caller's exact wording: any silent rewrite aborts.
  if(clean(entered)!==clean(text))throw new Error('评论输入不一致，未提交。');
  return {text:clean(entered),mentions};
}

export async function getCommentSubmit(tab) {
  const count=await tab.evaluate(()=>{
    document.querySelectorAll('[data-mimi-comment-submit]').forEach(node=>node.removeAttribute('data-mimi-comment-submit'));
    const inner=document.querySelector('.comment-input-inner-container');
    let root=inner;
    for(let depth=0;root&&root.parentElement&&depth<3;depth++) {
      if(root.parentElement.querySelector('[data-e2e="comment-list"]'))break;
      root=root.parentElement;
    }
    const nodes=root?[root,...root.querySelectorAll('button,[role="button"],div,span,[data-e2e]')]
      :[...document.querySelectorAll('[data-e2e="comment-post"],[data-e2e="comment-submit"]')];
    const candidates=nodes.filter(node=>/^(发送|发布)$/.test((node.innerText||'').replace(/\s+/g,''))
      &&node.getBoundingClientRect().width>0&&node.getBoundingClientRect().height>0);
    const leaves=candidates.filter(node=>!candidates.some(child=>child!==node&&node.contains(child)));
    let controls=[...new Set(leaves.map(node=>node.closest('button,[role="button"]')||node))];
    if(!controls.length) {
      // The observed Draft.js composer uses an unlabelled SVG send control.
      // Select it only when exactly one composer control changes state from
      // the empty draft to the filled draft; never guess by screen position.
      controls=[...document.querySelectorAll('.commentInput-right-ct [data-mimi-empty-comment-class]')]
        .filter(node=>(node.getAttribute('class')||'')!==node.getAttribute('data-mimi-empty-comment-class'));
    }
    if(controls.length===1)controls[0].setAttribute('data-mimi-comment-submit','true');
    return controls.length;
  });
  if(count!==1)throw new Error('没有定位到唯一的评论提交按钮，未提交。');
  return tab.locator('[data-mimi-comment-submit="true"]');
}

export async function captureEmptyCommentControls(tab) {
  await tab.waitForTimeout(100);
  await tab.evaluate(()=>{
    for(const node of document.querySelectorAll('.commentInput-right-ct span')) {
      const props=Object.keys(node).filter(key=>key.startsWith('__reactProps')).map(key=>node[key]);
      if(!node.querySelector('span')&&props.some(prop=>typeof prop?.onClick==='function'))
        node.setAttribute('data-mimi-empty-comment-class',node.getAttribute('class')||'');
    }
  });
}
