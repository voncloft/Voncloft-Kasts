'use strict';
const $ = id => document.getElementById(id);
const api = new URL('../api/2/', new URL('.', location.href));
const device = 'web-player';
const titles = {overview:'Your library, together.',subscriptions:'Your subscriptions.',discover:'Find your next favorite.',queue:'Up next.',devices:'Your connected apps.',activity:'Your playback records.',account:'Account settings.',podcast:'Episodes.'};
const subtitles = {overview:'A little of everything you love listening to.',subscriptions:'Choose a podcast to browse its episodes.',discover:'Search for podcasts and add them to your shared library.',queue:'Your shared queue, in the order it will play.',devices:'Playback state last reported by your connected apps.',activity:'The latest saved episode updates from your apps.',account:'Manage the password for your sync account.',podcast:'Browse, listen, and add something to your queue.'};
let authorization='', account='', data=null, view='overview', selectedFeed='', limit=40, epoch=0, busy=0, syncChain=Promise.resolve(), loading=false;
let queueDrag=null,accountCSRF='',accountGeneration=0,accountSaving=false;
let navigationDepth=0,focusedEpisode=null,detailQuery='';
let podcastOrigin='subscriptions',podcastCanGoBack=false,discoveryRequest=0;
let metadata=new Map(), feedErrors=new Map(), feedLoads=new Map(), actions=new Map(), discoverResults=[], discoverySearched=false;
const controllers=new Set();
let playing=null, ready=false, played=false, started=0, resumeAt=0, appliedActionTime=0, lastAttempt=0, progressSending=false, pendingProgress=new Map();
const audio=$('audio');
let playContext=null;
let livePlayers=[],presenceError='',presenceServerTime=0,presenceReceivedAt=0,presenceLoading=false;
let presencePending=null,presenceFlight=null,suppressPresence=false,playerInstance='';
function webPlayerInstance(){
  if(playerInstance)return playerInstance;
  try{playerInstance=sessionStorage.getItem('podcast-sync-player')||'';}catch{}
  if(!/^web-[a-z0-9-]{8,80}$/.test(playerInstance)){
    playerInstance='web-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
    try{sessionStorage.setItem('podcast-sync-player',playerInstance);}catch{}
  }
  return playerInstance;
}
function presenceAge(player){return Math.max(0,presenceServerTime+(Date.now()-presenceReceivedAt)/1000-player.updated_at);}
function presenceRow(player){
  const row=element('div','device-row presence-row'),main=element('div','row-main'),age=presenceAge(player),live=age<=90;
  if(player.item)row.append(itemArt(player.item));else row.append(element('span','device-icon','▣'));
  main.append(element('span','row-title',player.caption||player.client||'Player'));
  if(player.item)main.append(element('span','row-subtitle',episodeName(player.item)),element('span','small muted',player.item.podcast_title||feedName(player.item.podcast)));
  const status={playing:'Playing',paused:'Paused',stopped:'Stopped'}[player.state]||'Unknown';
  const info=element('div','presence-status');info.append(element('span','tag'+(live?'':' stale'),'Last reported '+status.toLowerCase()));
  if(player.item)info.append(element('span','small muted',position(player.position)+(player.duration?' / '+position(player.duration):'')));
  info.append(element('span','small muted',age<60?`Reported ${Math.floor(age)}s ago`:`Reported ${Math.floor(age/60)}m ago`));
  if(!live)info.append(element('span','small muted','No newer playback action reported'));
  row.append(main,info);return row;
}
function renderDevices(needle){
  const players=livePlayers.filter(x=>(x.caption+' '+x.client+' '+x.item?.title+' '+x.item?.podcast_title).toLowerCase().includes(needle));
  const devices=data.devices.filter(x=>(x.caption+' '+x.id+' '+x.type).toLowerCase().includes(needle));
  $('list-note').textContent='Playback reports update on actions, not a timer. Open this page or choose Refresh to load the latest reports. A report does not prove a device is still playing or online.';
  $('result-count').textContent=`${number(players.length)} players · ${number(devices.length)} sync identities`;$('load-more').hidden=true;
  const rows=[element('h2','device-section','Last reported playback')];
  if(presenceError)rows.push(element('p','presence-warning error-text',presenceError));
  rows.push(...(players.length?players.map(presenceRow):[empty('No player reports yet. Start playback in the website or an updated Kasts/AntennaPod client.')]));
  rows.push(element('h2','device-section','Registered sync identities'),...devices.map(deviceRow));
  $('list-content').replaceChildren(...rows);renderPodcastHeading();
}
async function loadPresence(){
  if(!account||presenceLoading)return;presenceLoading=true;const token=epoch;
  try{const result=await request(userPath('presence'),undefined,{timeout:8000});if(token!==epoch)return;
    if(result.protocol!=='vonpresence-v1'||!Array.isArray(result.players))throw new Error('Unexpected live-status response.');
    livePlayers=result.players;presenceServerTime=result.server_time;presenceReceivedAt=Date.now();presenceError='';
  }catch(error){if(token===epoch)presenceError=error.status===404?'Install server 1.1.3 to enable live playback status.':error.message;}
  finally{if(token===epoch){presenceLoading=false;if(view==='devices')renderList();}}
}
function reportPresence(state=null,keepalive=false){
  if(!account||!playing||suppressPresence)return Promise.resolve();
  const token=epoch;
  presencePending={state:state||(audio.ended?'stopped':audio.paused?'paused':'playing'),client:'Web player',caption:'Web player',device,item:queueItem(playing),position:Math.max(0,Math.floor(audio.currentTime||0)),duration:Math.max(0,Math.floor(Number.isFinite(audio.duration)?audio.duration:Number(playing.duration)||0))};
  if(presenceFlight)return presenceFlight;
  presenceFlight=(async()=>{
    while(presencePending&&token===epoch){const body=presencePending;presencePending=null;
      try{await request(userPath('presence','/'+webPlayerInstance()),body,{keepalive,timeout:8000});if(view==='devices')loadPresence();}catch{}
    }
  })().finally(()=>{if(token===epoch)presenceFlight=null;});
  return presenceFlight;
}
const sortOrder={subscriptions:'newest',podcast:'newest'};
const countLabels={unplayed:'Unplayed',played:'Played',total:'Total episodes',queued:'In queue',off:'Off'};
let countMode='unplayed';
try{const saved=localStorage.getItem('podcast-sync-count');if(Object.hasOwn(countLabels,saved))countMode=saved;}catch{}
const playbackIndex=new Map(),feedCountsCache=new Map();
function newerAction(a,b){if(!a)return b;if(!b)return a;const delta=eventTime(b.timestamp)-eventTime(a.timestamp);return delta>0||(delta===0&&b.action==='new')?b:a;}
function stateKey(item,kind){return item.podcast+'\n'+kind+'\n'+item[kind];}
function rebuildPlaybackIndex(){
  playbackIndex.clear();feedCountsCache.clear();
  for(const a of actions.values())if(['play','new'].includes(a.action))for(const kind of ['guid','episode'])if(a[kind]){const key=stateKey(a,kind);playbackIndex.set(key,newerAction(playbackIndex.get(key),a));}
}
function feedCounts(url){
  if(feedCountsCache.has(url))return feedCountsCache.get(url);
  const meta=metadata.get(url),entries=meta?.episodes||meta?.episode_index?.map(([guid,episode])=>({podcast:url,guid,episode}));
  let completed=0;
  if(entries)for(const item of entries){const a=playback(item);if(a&&a.total>0&&a.position>=a.total)completed++;}
  const counts={total:entries?entries.length:meta?.episode_count??null,unplayed:entries?entries.length-completed:null,played:entries?completed:null,queued:data.queue.filter(x=>x.podcast===url).length};
  feedCountsCache.set(url,counts);return counts;
}
function compareCounts(a,b){const left=feedCounts(a)[countMode],right=feedCounts(b)[countMode];return left==null?(right==null?0:1):right==null?-1:(sortOrder.subscriptions==='count-low'?left-right:right-left);}
function updateCountControls(){
  $('count-control').hidden=view!=='subscriptions';$('count-mode').value=countMode;
  for(const id of ['sort-count-high','sort-count-low'])$(id).hidden=view!=='subscriptions'||countMode==='off';
}

function byPublished(a,b,order){const left=Number(a)||0,right=Number(b)||0;return !left?(!right?0:1):!right?-1:(order==='oldest'?left-right:right-left);}
function orderedEpisodes(url){return [...(metadata.get(url)?.episodes||[])].sort((a,b)=>byPublished(a.published,b.published,sortOrder.podcast));}
function orderedSubscriptions(){return [...data.subscriptions].sort((a,b)=>(sortOrder.subscriptions.startsWith('count-')?compareCounts(a,b):sortOrder.subscriptions==='title'?0:byPublished(metadata.get(a)?.latest_episode,metadata.get(b)?.latest_episode,sortOrder.subscriptions))||feedName(a).localeCompare(feedName(b)));}
function libraryEpisodeMatches(needle){
  const matches=[],seen=new Set();
  const add=item=>{const key=item.podcast+'\n'+(item.guid||item.episode);if(!seen.has(key)&&String(item.title||'').toLowerCase().includes(needle)){seen.add(key);matches.push(item);}};
  for(const url of data.subscriptions){
    const feed=metadata.get(url);
    const episodes=feed?.episodes||feed?.episode_index?.map(([guid,episode,title='',published=0,duration=0])=>({podcast:url,episode,guid,title,published,duration,podcast_title:feed.title}));
    for(const item of episodes||[])add(item);
  }
  for(const item of data.queue)add({...episodeMeta(item),...item,title:episodeName(item)});
  return matches.sort((a,b)=>byPublished(a.published,b.published,sortOrder.subscriptions)||String(a.title).localeCompare(String(b.title)));
}
function renderLibrarySearch(needle){
  const podcasts=orderedSubscriptions().filter(url=>(feedName(url)+' '+url).toLowerCase().includes(needle));
  const episodes=libraryEpisodeMatches(needle),rows=[];
  const pending=data.subscriptions.filter(url=>!metadata.has(url)&&!feedErrors.has(url)).length;
  const unavailable=data.subscriptions.filter(url=>feedErrors.has(url)).length;
  $('list-note').textContent='Search podcast names and episode titles in your subscriptions and shared queue.'+
    (pending?` Loading ${number(pending)} more podcasts…`:'')+(unavailable?` ${number(unavailable)} podcast feeds could not be loaded; use Refresh to retry.`:'');
  $('result-count').textContent=`${number(podcasts.length)} ${podcasts.length===1?'podcast':'podcasts'} · ${number(episodes.length)} ${episodes.length===1?'episode':'episodes'}`;
  $('load-more').hidden=podcasts.length+episodes.length<=limit;
  $('list-content').className='';
  if(podcasts.length){const grid=element('div','feed-grid');grid.append(...podcasts.slice(0,limit).map(feedCard));rows.push(element('h2','search-section','Podcasts'),grid);}
  const shown=episodes.slice(0,Math.max(0,limit-podcasts.length));
  if(shown.length)rows.push(element('h2','search-section','Episodes'),...shown.map(item=>episodeRow(item,true)));
  if(!rows.length)rows.push(empty(pending?'Searching your podcasts as they load…':'No matching podcasts or episode titles. Try another search.'));
  $('list-content').replaceChildren(...rows);renderPodcastHeading();
}
function playbackContext(item,kind){return {kind,items:kind==='queue'?data.queue.slice():kind==='podcast'?orderedEpisodes(item.podcast):kind==='library'?libraryEpisodeMatches($('search').value.trim().toLowerCase()):[item]};}
function nextEpisode(finished){
  if(!playContext)return null;
  const items=playContext.kind==='queue'?data.queue:playContext.items;
  const at=items.findIndex(x=>matching(x,finished));
  if(at>=0)return items[at+1]||null;
  // A phone may have removed the playing item while this tab was listening.
  if(playContext.kind==='queue'){
    const old=playContext.items.findIndex(x=>matching(x,finished));
    return playContext.items.slice(old+1).map(x=>items.find(y=>matching(x,y))).find(Boolean)||items[0]||null;
  }
  return null;
}
const number=value=>new Intl.NumberFormat().format(value);
const element=(tag,cls,text)=>{const n=document.createElement(tag); if(cls)n.className=cls; if(text!==undefined)n.textContent=text; return n;};
const empty=text=>element('div','empty',text);
function safeUrl(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function duration(value){const m=Math.floor(Math.max(0,Number(value)||0)/60);return m>=60?`${Math.floor(m/60)}h ${m%60}m`:`${m}m`;}
function position(value){const s=Math.floor(Math.max(0,Number(value)||0));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}
function eventTime(value){const t=String(value||'');return new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(t)?t:t+'Z').getTime()||0;}
function dateText(ms){return ms?new Date(ms).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Time unavailable';}
function feedName(url){return metadata.get(url)?.title || data?.queue.find(x=>x.podcast===url&&x.podcast_title)?.podcast_title || url || 'Podcast';}
function matching(a,b){return a.podcast===b.podcast&&((a.guid&&b.guid&&a.guid===b.guid)||a.episode===b.episode);}
function episodeMeta(item){return metadata.get(item.podcast)?.episodes?.find(x=>matching(x,item));}
function episodeName(item){return item.title || episodeMeta(item)?.title || data?.queue.find(x=>matching(x,item))?.title || decodeName(item.episode);}
function decodeName(url){try{return decodeURIComponent(new URL(url).pathname.split('/').pop())||'Episode';}catch{return 'Episode';}}
function queueItem(item){const out={};for(const key of ['podcast','episode','guid','title','podcast_title','published','duration'])out[key]=item[key]??(['duration','published'].includes(key)?0:'');return out;}
function inQueue(item){return data?.queue.some(x=>matching(x,item));}
function playback(item){const latest=newerAction(playbackIndex.get(stateKey(item,'episode')),item.guid?playbackIndex.get(stateKey(item,'guid')):null);return latest?.action==='new'?{...latest,position:0,started:0,total:0}:latest;}
function mergeActions(list){for(const a of list){const key=a.podcast+'\n'+a.episode+'\n'+a.action,old=actions.get(key);if(!old||eventTime(a.timestamp)>=eventTime(old.timestamp))actions.set(key,a);}if(data)data.actions=[...actions.values()].sort((a,b)=>eventTime(b.timestamp)-eventTime(a.timestamp));rebuildPlaybackIndex();}
function button(text,cls,fn,write=false){const b=element('button',cls,text);b.type='button';if(write){b.dataset.write='';b.disabled=busy>0;}b.addEventListener('click',fn);return b;}
function showError(message){$('notice').hidden=true;$('dashboard-error').textContent=message;$('dashboard-error').hidden=false;}
function notice(message){$('dashboard-error').hidden=true;const token=epoch;setTimeout(()=>{if(epoch===token&&$('notice').textContent===message)$('notice').hidden=true;},12000);$('notice').textContent=message;$('notice').hidden=false;$('status').textContent=message;}
function updateBusy(){for(const b of document.querySelectorAll('[data-write]'))b.disabled=busy>0||b.dataset.boundary==='true';$('refresh').disabled=busy>0;}
async function request(path,body,options={}){
  const abort=new AbortController(), token=epoch;controllers.add(abort);
  const timeout=setTimeout(()=>abort.abort(),options.timeout||30000);
  try{
    const response=await fetch(new URL(path,api),{method:body===undefined?'GET':'POST',headers:{...(authorization?{Authorization:authorization}:{}),Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin',cache:'no-store',redirect:'error',signal:abort.signal,keepalive:Boolean(options.keepalive)});
    let result;try{result=await response.json();}catch{throw new Error(`The server returned HTTP ${response.status} instead of a sync response.`);}
    if(token!==epoch)throw new DOMException('Signed out','AbortError');
    if(!response.ok){const error=new Error(response.status===401?'The username or password was not accepted. Check your credentials and sign in again.':result.error||`The server returned HTTP ${response.status}.`);error.status=response.status;throw error;}
    return result;
  }catch(error){if(error.name==='AbortError')throw new Error('The request was interrupted or timed out. Check your connection and retry.');if(error instanceof TypeError)throw new Error('Could not reach your server. Check your connection or VPN.');throw error;}
  finally{clearTimeout(timeout);controllers.delete(abort);}
}
function userPath(kind,suffix=''){return `${kind}/${encodeURIComponent(account)}${suffix}.json`;}
function serial(fn){const token=epoch;busy++;updateBusy();const run=syncChain.then(async()=>{if(token!==epoch)return;return fn();});syncChain=run.catch(()=>{});return run.finally(()=>{if(token===epoch){busy--;updateBusy();}});}
function art(url,title,cls=''){const wrapper=element('span','art '+cls);wrapper.setAttribute('aria-hidden','true');wrapper.append(element('span','art-letter',String(title||'P').slice(0,1).toUpperCase()));const src=safeUrl(url);if(src){const image=element('img');image.src=src;image.alt='';image.loading='lazy';image.decoding='async';image.referrerPolicy='no-referrer';image.addEventListener('error',()=>image.remove());wrapper.append(image);}return wrapper;}
function itemArt(item){return art(item.image||episodeMeta(item)?.image||metadata.get(item.podcast)?.image,feedName(item.podcast));}
function playButton(item,kind='single'){const current=playing&&matching(playing,item)&&!audio.paused;const b=button(current?'Ⅱ':'▶','play-button',()=>playEpisode(item,playbackContext(item,kind)));b.setAttribute('aria-label',(current?'Pause ':'Play ')+episodeName(item));return b;}
function progressText(item){const a=playback(item);if(!a)return '';return a.total>0&&a.position>=a.total?'Played':a.position>0?`Resume at ${position(a.position)}`:'';}
function queueRow(item,compact=false){
  const row=element('div','queue-row'+(compact?' compact':''));
  if(!compact)attachQueueDrag(row,item);
  row.append(element('span','queue-index',String(data.queue.findIndex(x=>matching(x,item))+1)),itemArt(item));
  const main=element('div','row-main');main.append(button(episodeName(item),'episode-title row-title'+(compact?' truncate':''),()=>openEpisode(item)),button(feedName(item.podcast),'text-button row-subtitle',()=>openPodcast(item.podcast)));
  const progress=progressText(item);if(progress&&!compact)main.append(element('div','progress-line',progress));row.append(main,playButton(item,'queue'));
  if(!compact){const controls=element('div','row-actions');controls.append(element('span','tag',item.duration?duration(item.duration):'Duration unknown'));
    const at=data.queue.findIndex(x=>matching(x,item));
    const earlier=button('Earlier','small-button',()=>moveQueue(item,-1),true),later=button('Later','small-button',()=>moveQueue(item,1),true);
    earlier.dataset.boundary=String(at===0);later.dataset.boundary=String(at===data.queue.length-1);earlier.disabled=busy>0||at===0;later.disabled=busy>0||at===data.queue.length-1;
    controls.append(earlier,later,button('Remove','small-button',()=>removeQueue(item),true));row.append(controls);}
  return row;
}
function activityRow(item,compact=false){const row=element('div','activity-row compact'),main=element('div','row-main');row.append(itemArt(item));main.append(button(episodeName(item),'episode-title row-title truncate',()=>openEpisode(item)),button(feedName(item.podcast),'text-button row-subtitle',()=>openPodcast(item.podcast)));const meta=element('div','row-meta');meta.append(element('span','',item.action==='play'?position(item.position)+(item.total?' / '+position(item.total):''):({new:'Marked new',download:'Downloaded',delete:'Download removed'}[item.action]||item.action)),element('span','muted',dateText(eventTime(item.timestamp))));row.append(main,meta);if(!compact)row.append(playButton({...episodeMeta(item),...item,title:episodeName(item)}));return row;}
function feedCard(url){
  const meta=metadata.get(url),card=element('article','feed-card'),open=button('','',()=>openPodcast(url)),cover=element('span','feed-cover');
  cover.append(art(meta?.image,feedName(url)));
  if(countMode!=='off'){
    const value=feedCounts(url)[countMode],badge=element('span','feed-count'+(value===0?' zero':''),value==null?'…':number(value));
    badge.title=value==null?'Counts will appear when the feed loads':`${countLabels[countMode]}: ${number(value)}`+(countMode==='queued'?'':meta?.limited?' (within the first 2,000 feed episodes)':' (in the current feed)');
    badge.setAttribute('aria-label',badge.title);cover.append(badge);
  }
  open.append(cover,element('span','row-title truncate',feedName(url)));
  card.append(open,element('span','small',meta?.episode_count!==undefined?`${number(meta.episode_count)} episodes in feed`:feedErrors.has(url)?'Feed unavailable · open to retry':'Loading podcast details…'));
  if(meta?.latest_episode)card.append(element('span','small','Latest: '+new Date(meta.latest_episode*1000).toLocaleDateString()));
  return card;
}
function deviceRow(item){const row=element('div','device-row'),main=element('div','row-main');row.append(element('span','device-icon',item.type==='mobile'?'▯':'▣'));main.append(element('span','row-title',item.caption||item.id),element('span','row-subtitle',item.id));row.append(main,element('span','tag',item.type||'Device'));return row;}
function highlighted(text,query,cls=''){
  const node=element('span',cls),value=String(text||''),term=String(query||'').trim();
  if(!term){node.textContent=value;return node;}
  const lower=value.toLowerCase(),needle=term.toLowerCase();let at=0,index;
  while((index=lower.indexOf(needle,at))!==-1){node.append(document.createTextNode(value.slice(at,index)),element('mark','',value.slice(index,index+term.length)));at=index+term.length;}
  node.append(document.createTextNode(value.slice(at)));return node;
}
function synopsisMatch(item,query){
  const term=query.trim().toLowerCase(),description=String(item.description||'');
  const at=description.toLowerCase().indexOf(term);
  if(!term||String(item.title||'').toLowerCase().includes(term)||at<0)return null;
  const start=Math.max(0,at-70),end=Math.min(description.length,at+term.length+110);
  return (start?'…':'')+description.slice(start,end)+(end<description.length?'…':'');
}
function episodeRow(item,showPodcast=false){
  const row=element('article','episode-row'),focused=Boolean(focusedEpisode&&matching(item,focusedEpisode));
  const query=focused?detailQuery:$('search').value;
  row.dataset.episodeKey=item.podcast+'\n'+(item.guid||item.episode);
  const cover=button('','episode-art-button',()=>openEpisode(item));cover.setAttribute('aria-label','Read synopsis: '+item.title);cover.append(itemArt(item));row.append(cover);
  const main=element('div','row-main'),title=button('','episode-title row-title',()=>openEpisode(item));title.append(highlighted(item.title,query));main.append(title);
  if(showPodcast)main.append(button(item.podcast_title||feedName(item.podcast),'text-button row-subtitle',()=>openPodcast(item.podcast)));
  const info=[item.published?new Date(item.published*1000).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'',item.duration?duration(item.duration):''].filter(Boolean).join(' · ');
  main.append(element('div','row-subtitle',info));const progress=progressText(item);if(progress)main.append(element('div','progress-line',progress));
  const match=synopsisMatch(item,query);
  if(match&&!focused){const preview=element('p','synopsis-match');preview.append(element('strong','','Synopsis match: '),highlighted(match,query));main.append(preview);}
  if(focused){
    const notes=element('section','description full-synopsis');notes.append(element('h3','','Episode synopsis'));
    const text=item.description||(!metadata.get(item.podcast)?.episodes&&!feedErrors.has(item.podcast)?'Loading episode synopsis…':'The publisher has not supplied a synopsis for this episode, or it is no longer in the current feed.');
    notes.append(highlighted(text,query));main.append(notes);
  }else if(item.description){const details=element('details','description');details.append(element('summary','','Episode synopsis'),highlighted(item.description,query));main.append(details);}
  row.append(main);const controls=element('div','row-actions');controls.append(playButton(item,showPodcast?'library':'podcast'),button(inQueue(item)?'Remove from queue':'Add to queue','small-button',()=>toggleQueue(item),true));row.append(controls);return row;
}
function renderOverview(){if(!data)return;$('stat-subscriptions').textContent=number(data.subscriptions.length);$('stat-queue').textContent=number(data.queue.length);$('stat-devices').textContent=number(data.devices.length);$('stat-actions').textContent=number(data.actions.length);$('nav-subscriptions').textContent=number(data.subscriptions.length);$('nav-queue').textContent=number(data.queue.length);const known=data.queue.filter(x=>x.duration>0);$('stat-duration').textContent=known.length?duration(known.reduce((s,x)=>s+x.duration,0))+(known.length<data.queue.length?' known duration':' in your queue'):'In your shared queue';$('queue-preview').replaceChildren(...(data.queue.length?data.queue.slice(0,5).map(x=>queueRow(x,true)):[empty('Nothing queued yet. Open a podcast and choose an episode.')]));$('activity-preview').replaceChildren(...(data.actions.length?data.actions.slice(0,5).map(x=>activityRow(x,true)):[empty('Your listening progress will appear here.')]));$('feed-preview').replaceChildren(...data.subscriptions.slice(0,5).map(feedCard));}
function renderPodcastHeading(){const root=$('podcast-heading');if(view!=='podcast'){root.hidden=true;return;}root.hidden=false;const feed=metadata.get(selectedFeed),hero=element('div','podcast-hero');hero.append(art(feed?.image,feedName(selectedFeed)));const main=element('div','row-main');main.append(element('h2','',feedName(selectedFeed)));if(feed?.description){const details=element('details','description');details.open=true;details.append(element('summary','','Podcast synopsis'),highlighted(feed.description,detailQuery));main.append(details);}const counts=feedCounts(selectedFeed);if(counts.total!==null)main.append(element('p','podcast-counts',`${number(counts.total)} episodes · ${counts.unplayed===null?'…':number(counts.unplayed)} unplayed · ${number(counts.queued)} in queue`));const controls=element('div','row-actions');controls.append(button('All subscriptions','text-button',()=>changeView('subscriptions')),button('Refresh episodes','small-button',()=>loadFeed(selectedFeed,true,true).catch(()=>{})));
  if(focusedEpisode)controls.append(button('Browse all episodes','small-button',()=>openPodcast(selectedFeed)));
  if(data.subscriptions.includes(selectedFeed))controls.append(button('Unsubscribe','small-button',()=>unsubscribe(selectedFeed),true));else controls.append(button('Subscribe','small-button',()=>subscribe(selectedFeed),true));
  main.append(controls);if(feed?.stale)main.append(element('p','error-text','Showing cached episodes. '+(feed.warning||'The publisher is temporarily unavailable.')));if(feedErrors.has(selectedFeed))main.append(element('p','error-text',feedErrors.get(selectedFeed)));hero.append(main);root.replaceChildren(hero);}
function discoveryCard(item){
  const card=element('article','feed-card'),open=button('','',()=>openPodcast(item.url,item));
  open.setAttribute('aria-label','Browse '+item.title);
  open.append(art(item.image,item.title),element('span','row-title',item.title));
  card.append(open,element('span','small',item.author||''));
  const subscribed=data.subscriptions.includes(item.url);
  card.append(button(subscribed?'Browse episodes':'Subscribe','text-button',()=>subscribed?openPodcast(item.url,item):subscribe(item.url,item),!subscribed));
  if(safeUrl(item.website)){const link=element('a','text-button','Apple Podcasts');link.href=item.website;link.target='_blank';link.rel='noopener noreferrer';card.append(link);}
  return card;
}
function renderList(){if(!data||view==='overview'||view==='account'||queueDrag)return;const expanded=new Set([...document.querySelectorAll('.episode-row:has(details[open])')].map(n=>n.dataset.episodeKey));const aboutOpen=Boolean(document.querySelector('#podcast-heading details[open]'));const needle=$('search').value.trim().toLowerCase();let items=[],render,note='';
  $('list-content').className=['subscriptions','discover'].includes(view)?'feed-grid':'';
  if(view==='devices'){renderDevices(needle);return;}
  if(view==='subscriptions'&&needle){renderLibrarySearch(needle);return;}
  if(view==='subscriptions'){items=orderedSubscriptions().filter(x=>(feedName(x)+' '+x).toLowerCase().includes(needle));render=feedCard;note='Choose a thumbnail count, then sort by count, latest episode date, or title. Played and unplayed counts use synced status for episodes in the current feed. In queue includes older queued episodes.';}
  if(view==='queue'){items=data.queue.filter(x=>(episodeName(x)+' '+feedName(x.podcast)).toLowerCase().includes(needle));render=queueRow;note='Drag the grip beside an episode to move it. You can also use Earlier/Later, or focus the grip and use arrow keys, Home or End. Your apps pick up the saved order when they sync.';}
  if(view==='devices'){items=data.devices.filter(x=>(x.caption+' '+x.id+' '+x.type).toLowerCase().includes(needle));render=deviceRow;note='Apps sharing a device name appear once. Registration does not mean a device is online.';}
  if(view==='activity'){items=data.actions.filter(x=>(episodeName(x)+' '+feedName(x.podcast)+' '+x.device).toLowerCase().includes(needle));render=activityRow;note='Latest saved records per episode and action type, rather than every listening event or total listening time.';}
  if(view==='podcast'){items=focusedEpisode?[{...focusedEpisode,...episodeMeta(focusedEpisode)}]:orderedEpisodes(selectedFeed).filter(x=>(x.title+' '+x.description).toLowerCase().includes(needle));render=episodeRow;note=metadata.get(selectedFeed)?.episodes?'Play next follows the episode order selected when you start listening. Older queued episodes remain playable from your queue.':feedErrors.has(selectedFeed)?'Could not load this feed. Use Refresh episodes to retry.':'Loading episodes…';if(focusedEpisode)note='Read the full synopsis below. Back returns to the page you were browsing.';else if(metadata.get(selectedFeed)?.limited)note+=' Showing up to 2,000 episodes.';else if(needle)note='Matches episode titles and synopses. Matches within a synopsis are shown below the title.';}
  if(view==='discover'){items=discoverResults.filter(x=>(x.title+' '+x.author).toLowerCase().includes(needle));render=discoveryCard;note=discoverySearched?'Results from Apple Podcasts. Choose a thumbnail to browse info and episodes, or Subscribe to add a show.':'Search by podcast name, topic, or creator above. You can also add an RSS URL in Subscriptions.';}
  $('list-note').textContent=note;$('result-count').textContent=number(items.length)+(view==='podcast'?(items.length===1?' episode':' episodes'):(items.length===1?' item':' items'));$('load-more').hidden=items.length<=limit;
  const noItems=needle?'No matches. Try another search.':view==='discover'?(discoverySearched?'No podcasts found. Try another search.':'Search for a podcast to get started.'):view==='podcast'&&!metadata.get(selectedFeed)?.episodes?'Your episodes will appear here once the feed loads.':'Nothing here yet.';
  $('list-content').replaceChildren(...(items.length?items.slice(0,limit).map(x=>render(x)):[empty(noItems)]));renderPodcastHeading();for(const row of document.querySelectorAll('.episode-row')){if(expanded.has(row.dataset.episodeKey)&&row.querySelector('details'))row.querySelector('details').open=true;}if(aboutOpen&&document.querySelector('#podcast-heading details'))document.querySelector('#podcast-heading details').open=true;
}
function render(){if(!data)return;feedCountsCache.clear();renderOverview();renderList();if(playing){$('player-art').replaceChildren(itemArt(playing));$('player-podcast').textContent=feedName(playing.podcast);$('player-title').textContent=episodeMeta(playing)?.title||playing.title;}updateBusy();}
function showView(scroll=0){$('page-title').textContent=focusedEpisode?'Episode details.':titles[view];$('page-back').hidden=navigationDepth===0&&view==='overview';$('list-toolbar').hidden=Boolean(focusedEpisode);$('page-subtitle').textContent=subtitles[view];$('overview-view').hidden=view!=='overview';$('detail-view').hidden=['overview','account'].includes(view);$('account-view').hidden=view!=='account';$('stats').hidden=view!=='overview';$('subscription-tools').hidden=view!=='subscriptions';$('discover-tools').hidden=view!=='discover';$('clear-queue').hidden=view!=='queue';$('podcast-heading').hidden=view!=='podcast';$('sort-control').hidden=!['subscriptions','podcast'].includes(view);$('sort-title').hidden=view!=='subscriptions';updateCountControls();if(sortOrder[view])$('list-sort').value=sortOrder[view];for(const b of document.querySelectorAll('.nav-item')){const active=b.dataset.view===view||(view==='podcast'&&b.dataset.view===podcastOrigin);b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}renderList();if(view==='devices')loadPresence();if(view==='account')loadAccountSettings();window.scrollTo(0,scroll);}
function navigationState(){
  return {podcastSync:1,account,view,feed:selectedFeed,origin:podcastOrigin,canGoBack:podcastCanGoBack,depth:navigationDepth,episode:focusedEpisode,detailQuery,
    filter:$('search').value,limit,scroll:window.scrollY||0,sort:{...sortOrder},
    query:$('discover-query').value,results:discoverResults,searched:discoverySearched};
}
function navigationUrl(state){
  const url=new URL(location.href),hash=new URLSearchParams({view:state.view});
  if(state.view==='podcast'){hash.set('feed',state.feed);hash.set('from',state.origin);}
  if(state.episode){hash.set('episode',state.episode.episode);if(state.episode.guid)hash.set('guid',state.episode.guid);}
  if(state.view==='discover'&&state.query)hash.set('q',state.query);
  url.hash=hash.toString();return url;
}
function rememberView(){
  if(!data)return;
  const state=navigationState();history.replaceState(state,'',navigationUrl(state));
}
function changeView(next,{feed='',origin='subscriptions',replace=false,episode=null,query=''}={}){
  if(!data||!Object.hasOwn(titles,next))return;
  if(!replace&&next===view&&(next!=='podcast'||feed===selectedFeed)&&((!episode&&!focusedEpisode)||(episode&&focusedEpisode&&matching(episode,focusedEpisode))))return;
  finishQueueDrag(false);clearAccountSettings();
  if(!replace){rememberView();navigationDepth++;}else navigationDepth=0;
  podcastCanGoBack=!replace&&next==='podcast'&&view===origin;
  view=next;selectedFeed=feed;podcastOrigin=origin;focusedEpisode=episode?queueItem(episode):null;detailQuery=query;limit=40;$('search').value='';
  const state={...navigationState(),scroll:0};
  history[replace?'replaceState':'pushState'](state,'',navigationUrl(state));showView();
}
function restoreView(state){
  if(!data)return;
  finishQueueDrag(false);clearAccountSettings();
  discoveryRequest++;$('discover-submit').disabled=false;$('discover-error').hidden=true;
  if(state?.podcastSync===1&&state.account===account&&Object.hasOwn(titles,state.view)){
    view=state.view;selectedFeed=safeUrl(state.feed)||'';podcastOrigin=state.origin==='discover'?'discover':'subscriptions';
    navigationDepth=Math.max(0,Number(state.depth)||0);focusedEpisode=state.episode&&safeUrl(state.episode.episode)&&state.episode.podcast===selectedFeed?queueItem(state.episode):null;detailQuery=state.detailQuery||'';
    podcastCanGoBack=Boolean(state.canGoBack);limit=Math.max(40,Number(state.limit)||40);$('search').value=state.filter||'';
    $('discover-query').value=state.query||'';discoverResults=Array.isArray(state.results)?state.results:[];discoverySearched=Boolean(state.searched);
    for(const key of ['subscriptions','podcast'])if(state.sort&&['newest','oldest','title','count-high','count-low'].includes(state.sort[key]))sortOrder[key]=state.sort[key];
    if(view==='podcast'&&!selectedFeed)view='discover';showView(Number(state.scroll)||0);
  }else{
    const hash=new URLSearchParams(location.hash.slice(1)),next=hash.get('view');
    const feed=safeUrl(hash.get('feed'))||'';
    $('discover-query').value=hash.get('q')||'';
    changeView(Object.hasOwn(titles,next)&&(next!=='podcast'||feed)?next:'overview',{
      feed,origin:hash.get('from')==='discover'?'discover':'subscriptions',replace:true,episode:safeUrl(hash.get('episode'))?{podcast:feed,episode:hash.get('episode'),guid:hash.get('guid')||''}:null});
    if(view==='discover'&&$('discover-query').value.trim().length>=2)searchDirectory();
  }
  if(view==='podcast')loadFeed(selectedFeed,true).catch(()=>{});
}
window.addEventListener('popstate',event=>restoreView(event.state));
if('scrollRestoration' in history)history.scrollRestoration='manual';
function openPodcast(url,hint){
  url=safeUrl(url);if(!url)return;
  if(hint&&!metadata.has(url))metadata.set(url,{title:hint.title,image:hint.image});
  changeView('podcast',{feed:url,origin:view==='discover'?'discover':view==='podcast'?podcastOrigin:'subscriptions',query:view==='discover'?$('discover-query').value:view==='podcast'?detailQuery:$('search').value});
  loadFeed(url,true).catch(()=>{});
}
function openEpisode(item){
  if(!safeUrl(item.podcast)||!safeUrl(item.episode))return;
  const query=view==='podcast'&&focusedEpisode?detailQuery:$('search').value;
  changeView('podcast',{feed:item.podcast,origin:view==='podcast'?podcastOrigin:'subscriptions',episode:item,query});
  loadFeed(item.podcast,true).catch(()=>{});
}
async function loadFeed(url,full=false,refresh=false){
  if(!account)return;const token=epoch;
  if(!refresh&&metadata.has(url)&&(!full||metadata.get(url).episodes))return metadata.get(url);
  if(feedLoads.has(url)){await feedLoads.get(url).catch(()=>{});if(token!==epoch)return;if(!refresh&&metadata.has(url)&&(!full||metadata.get(url).episodes))return metadata.get(url);}
  const promise=(async()=>{try{const result=await request(userPath('library')+'?feed='+encodeURIComponent(url)+(full?'':'&summary=1')+(refresh?'&refresh=1':'')+(full?'&preview=1':''));if(token!==epoch)return;metadata.set(url,{...metadata.get(url),...result});feedErrors.delete(url);render();return result;}catch(error){if(token===epoch){feedErrors.set(url,error.status===404?'Install the 1.1 server update to load artwork and episodes.':error.message);render();}throw error;}finally{if(token===epoch)feedLoads.delete(url);}})();feedLoads.set(url,promise);return promise;
}
async function warmFeeds(){const token=epoch,urls=[...new Set([...data.queue.map(x=>x.podcast),...data.subscriptions])];let at=0;await Promise.all([0,1,2].map(async()=>{while(at<urls.length&&token===epoch){const url=urls[at++];if(!metadata.has(url)&&!feedErrors.has(url))await loadFeed(url).catch(()=>{});}}));}
async function refreshData(initial=false,quiet=false){
  if(loading||queueDrag||(!initial&&busy))return;loading=true;const token=epoch;
  try{await serial(async()=>{
    const user=encodeURIComponent(account),cursor=data?.cursor||0;
    const [devices,subs,queue,updates]=await Promise.all([request(`devices/${user}.json`),request(`subscriptions/${user}/${device}.json?since=0`),request(`queue/${user}/${device}.json`),request(`episodes/${user}.json?since=${cursor}`)]);
    if(token!==epoch)return;
    if(!Array.isArray(devices)||!Array.isArray(subs.add)||!Array.isArray(queue.items)||!Array.isArray(updates.actions))throw new Error('The server returned an unexpected response.');
    data={devices,subscriptions:[...new Set(subs.add)],queue:queue.items,revision:queue.revision,actions:[],cursor:updates.timestamp};mergeActions(updates.actions);
    $('password').value='';$('login-screen').hidden=true;$('dashboard').hidden=false;$('navigation').hidden=false;$('account-controls').hidden=false;$('account-name').textContent=account;$('account-name').setAttribute('aria-label','Account settings for '+account);$('updated-at').textContent='Updated '+new Date().toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
    if(initial)restoreView(history.state);render();if(!quiet)$('dashboard-error').hidden=true;
  });if(token===epoch&&data){warmFeeds();loadPresence();}}
  catch(error){if(token!==epoch)return;if(initial){authorization='';$('login-error').textContent=error.message;$('login-error').hidden=false;}else showError(error.message+' The last loaded library is still shown.');}
  finally{if(token===epoch){loading=false;$('sign-in').disabled=false;$('sign-in').textContent='Open my library';}}
}
async function editQueue(transform,message){const token=epoch;try{await serial(async()=>{const items=transform(data.queue.map(queueItem));const result=await request(userPath('queue','/'+device),{base_revision:data.revision,items});data.queue=result.items;data.revision=result.revision;render();notice(message+' Saved to server; other apps receive it on their next action or manual sync.');});if(token===epoch)refreshData(false,true);return token===epoch;}catch(error){if(token!==epoch)return false;showError('Queue was not confirmed saved. '+error.message+' Refresh before retrying.');return false;}}
function toggleQueue(item){if(inQueue(item))return removeQueue(item);return editQueue(items=>items.some(x=>matching(x,item))?items:[...items,queueItem(item)],'Episode added.');}
function removeQueue(item){return editQueue(items=>items.filter(x=>!matching(x,item)),'Episode removed from queue.');}
function moveQueue(item,offset){return editQueue(items=>{const from=items.findIndex(x=>matching(x,item)),to=from+offset;if(from>=0&&to>=0&&to<items.length)[items[from],items[to]]=[items[to],items[from]];return items;},'Queue reordered.');}
function confirmAction(title,message,label){const dialog=$('confirm-dialog');$('confirm-title').textContent=title;$('confirm-message').textContent=message;$('confirm-button').textContent=label;dialog.returnValue='cancel';dialog.showModal();return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true}));}
async function subscribe(url,hint){const token=epoch;url=safeUrl(url);if(!url){showError('Enter a valid HTTP or HTTPS podcast feed URL.');return;}try{await serial(async()=>{await request(userPath('subscriptions','/'+device),{add:[url],remove:[]});if(!data.subscriptions.includes(url))data.subscriptions.push(url);if(hint&&!metadata.has(url))metadata.set(url,{title:hint.title,image:hint.image});$('feed-url').value='';render();notice('Subscribed. Other apps receive this podcast on their next action or manual sync.');});if(token!==epoch)return;refreshData(false,true);openPodcast(url);}catch(error){if(token===epoch)showError(error.message);}}
async function unsubscribe(url){const token=epoch;if(!await confirmAction('Unsubscribe from this podcast?',feedName(url)+' will be removed from your shared subscriptions. Episodes already queued stay in the queue.','Unsubscribe')||token!==epoch)return;try{await serial(async()=>{await request(userPath('subscriptions','/'+device),{add:[],remove:[url]});data.subscriptions=data.subscriptions.filter(x=>x!==url);changeView('subscriptions');render();notice('Unsubscribed. Other apps receive the change on their next action or manual sync.');});if(token===epoch)refreshData(false,true);}catch(error){showError('Could not confirm the subscription change. '+error.message);}}
async function searchDirectory(){const term=$('discover-query').value.trim();if(term.length<2)return;const token=epoch,searchToken=++discoveryRequest;$('discover-submit').disabled=true;$('discover-error').hidden=true;try{const result=await request(userPath('discover')+'?q='+encodeURIComponent(term));if(token!==epoch||searchToken!==discoveryRequest)return;discoverResults=result.results;discoverySearched=true;limit=40;$('search').value='';renderList();rememberView();}catch(error){if(token===epoch&&searchToken===discoveryRequest){$('discover-error').textContent=error.message;$('discover-error').hidden=false;}}finally{if(token===epoch&&searchToken===discoveryRequest)$('discover-submit').disabled=false;}}
function registerPlayer(){return request(userPath('devices','/'+device),{caption:'Podcast Sync web player',type:'other'}).then(()=>{if(data&&!data.devices.some(x=>x.id===device)){data.devices.push({id:device,caption:'Podcast Sync web player',type:'other'});renderOverview();}});}
function setPlayerError(text){$('player-error').textContent=text;$('player-error').hidden=!text;}
function queueProgress(complete=false,keepalive=false){if(!playing||!ready||!played)return;const total=Math.floor(Number.isFinite(audio.duration)?audio.duration:Number(playing.duration)||0),pos=complete&&total?total:Math.floor(audio.currentTime||0);const a={podcast:playing.podcast,episode:playing.episode,guid:playing.guid||'',device,action:'play',timestamp:new Date().toISOString(),started:Math.min(started,pos),position:pos,total:Math.max(total,pos)};pendingProgress.set(a.podcast+'\n'+a.episode,a);appliedActionTime=eventTime(a.timestamp);lastAttempt=Date.now();$('progress-status').textContent='Saving progress…';return flushProgress(keepalive);}
async function flushProgress(keepalive=false){if(progressSending||!pendingProgress.size||!account)return;progressSending=true;const token=epoch,batch=[...pendingProgress.values()];try{await request(userPath('episodes'),batch,{keepalive});if(token!==epoch)return;for(const a of batch){const key=a.podcast+'\n'+a.episode;if(pendingProgress.get(key)===a)pendingProgress.delete(key);}mergeActions(batch);$('progress-status').textContent=pendingProgress.size?'Saving progress…':'Progress saved to server';$('retry-progress').hidden=true;setProgressError('');render();}catch(error){if(token===epoch){$('progress-status').textContent='Progress not saved';$('retry-progress').hidden=false;setProgressError(error.message+' Keep this tab open and retry.');}}finally{if(token===epoch){progressSending=false;}}}
function setProgressError(text){$('progress-error').textContent=text;$('progress-error').hidden=!text;}
function startAudio(){const track=playing;audio.play().catch(error=>{if(track!==playing||error.name==='AbortError')return;setPlayerError(error.name==='NotAllowedError'?'Your browser blocked playback. Press Play in the audio controls, or allow autoplay with sound for this site.':'Could not start this audio. Press Play to retry; the publisher may be unavailable or this format may not be supported.');});}
function playEpisode(item,context=null,advancing=false){if(playing&&matching(playing,item)&&!audio.error){if(context)playContext=context;if(audio.paused)startAudio();else audio.pause();return;}
  if(!advancing)queueProgress();ready=false;played=false;audio.pause();playContext=context||playbackContext(item,inQueue(item)?'queue':'single');if(playContext.kind==='queue')playContext.items=data.queue.slice();playing={...episodeMeta(item),...item,title:episodeName(item)};
  const src=safeUrl(playing.episode);if(!src){setPlayerError('This episode has no playable audio URL.');return;}
  const saved=playback(playing);appliedActionTime=eventTime(saved?.timestamp);resumeAt=saved&&!(saved.total>0&&saved.position>=saved.total)?saved.position:0;started=resumeAt;
  $('player').hidden=false;$('player-title').textContent=playing.title;$('player-podcast').textContent=feedName(playing.podcast);$('player-art').replaceChildren(itemArt(playing));$('progress-status').textContent='Loading audio…';setPlayerError('');audio.src=src;audio.playbackRate=Number($('playback-rate').value);audio.load();
  startAudio();
  registerPlayer().catch(error=>showError('Could not register the web player. '+error.message));render();
}
audio.addEventListener('loadedmetadata',()=>{ready=true;if(resumeAt>0&&Number.isFinite(audio.duration)&&resumeAt<audio.duration-1)audio.currentTime=resumeAt;else if(resumeAt>0&&!Number.isFinite(audio.duration))audio.currentTime=resumeAt;started=Math.floor(audio.currentTime||0);$('progress-status').textContent=pendingProgress.size?'Saving progress…':'Progress saves on pause, seek or completion';});
audio.addEventListener('play',()=>{if(ready&&playing){const latest=playback(playing);if(latest&&eventTime(latest.timestamp)>appliedActionTime&&!pendingProgress.has(playing.podcast+'\n'+playing.episode)){const target=latest.total>0&&latest.position>=latest.total?0:latest.position;if(Number.isFinite(target))audio.currentTime=target;appliedActionTime=eventTime(latest.timestamp);started=target;}}played=true;setPlayerError('');render();reportPresence();});
audio.addEventListener('pause',()=>{const token=epoch;Promise.resolve(queueProgress()).then(()=>{if(token===epoch&&data)refreshData(false,true);});render();reportPresence();});
audio.addEventListener('seeked',()=>{const token=epoch;Promise.resolve(queueProgress()).then(()=>{if(token===epoch&&data)refreshData(false,true);});reportPresence();});
audio.addEventListener('error',()=>{if(playing)setPlayerError('The publisher audio could not be loaded. Try Play again or choose another episode. Your queue has not changed.');});
audio.addEventListener('ended',()=>{
  if(!playing||!data)return;
  const finished=playing,next=nextEpisode(finished),queued=inQueue(finished);
  queueProgress(true);
  // Start the next source immediately on the same audio element. Network saves
  // run separately, so slow or failed sync cannot stall continuous playback.
  if($('auto-next').checked&&next)playEpisode(next,playContext,true);
  else $('progress-status').textContent=$('auto-next').checked?'End of this listening list':'Episode finished';
  if(queued)removeQueue(finished);
  reportPresence();
});
$('skip-back').addEventListener('click',()=>{if(ready)audio.currentTime=Math.max(0,audio.currentTime-15);});
$('skip-forward').addEventListener('click',()=>{if(ready)audio.currentTime=Math.min(Number.isFinite(audio.duration)?audio.duration:Infinity,audio.currentTime+30);});
$('playback-rate').addEventListener('change',()=>{audio.playbackRate=Number($('playback-rate').value);});
$('player-podcast').addEventListener('click',()=>{if(playing)openPodcast(playing.podcast);});
$('retry-progress').addEventListener('click',()=>{queueProgress();flushProgress();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)queueProgress();else if(data){refreshData(false,true);flushProgress();}});
window.addEventListener('pagehide',()=>{rememberView();queueProgress(false,true);reportPresence('stopped',true);});
window.addEventListener('beforeunload',event=>{if(pendingProgress.size){event.preventDefault();event.returnValue='';}});
$('page-back').addEventListener('click',()=>{if(navigationDepth>0)history.back();else changeView('overview',{replace:true});});
async function restoreSession(){
  const token=epoch;$('sign-in').disabled=true;$('sign-in').textContent='Checking your session…';
  try{const session=await request('session.json');if(token!==epoch)return;
    if(session.authenticated&&session.username){account=session.username;await refreshData(true);}
  }catch(error){if(token===epoch){$('login-error').textContent='Could not restore your session. '+error.message;$('login-error').hidden=false;}}
  finally{if(token===epoch){$('sign-in').disabled=false;$('sign-in').textContent='Open my library';}}
}
$('login-form').addEventListener('submit',async event=>{
  event.preventDefault();epoch++;suppressPresence=false;account=$('username').value.trim();
  authorization='Basic '+btoa(Array.from(new TextEncoder().encode(account+':'+$('password').value),x=>String.fromCharCode(x)).join(''));
  $('login-error').hidden=true;$('sign-in').disabled=true;$('sign-in').textContent='Opening your library…';
  try{await request(`auth/${encodeURIComponent(account)}/login.json`,{});authorization='';$('password').value='';await refreshData(true);}
  catch(error){account='';$('login-error').textContent=error.message;$('login-error').hidden=false;}
  finally{authorization='';$('password').value='';$('sign-in').disabled=false;$('sign-in').textContent='Open my library';}
});
$('sign-out').addEventListener('click',async()=>{finishQueueDrag(false);clearAccountSettings();await queueProgress();if(pendingProgress.size&&!await confirmAction('Sign out with progress still saving?','Keep this tab open until progress saves to avoid losing your latest listening position.','Sign out'))return;await reportPresence('stopped');try{await request(`auth/${encodeURIComponent(account)}/logout.json`,{});}catch(error){if(error.status!==401){showError('Could not sign out. '+error.message);return;}}suppressPresence=true;epoch++;presencePending=null;presenceFlight=null;presenceLoading=false;livePlayers=[];presenceError='';ready=false;audio.pause();audio.removeAttribute('src');audio.load();playing=null;playContext=null;played=false;setPlayerError('');setProgressError('');for(const c of controllers)c.abort();controllers.clear();authorization='';account='';data=null;metadata=new Map();feedErrors=new Map();feedLoads=new Map();actions=new Map();playbackIndex.clear();feedCountsCache.clear();pendingProgress=new Map();progressSending=false;discoverResults=[];discoverySearched=false;discoveryRequest++;history.replaceState(null,'',new URL('.',location.href));navigationDepth=0;focusedEpisode=null;detailQuery='';busy=0;loading=false;syncChain=Promise.resolve();$('dashboard').hidden=true;$('navigation').hidden=true;$('account-controls').hidden=true;$('player').hidden=true;$('login-screen').hidden=false;$('password').value='';$('sign-in').disabled=false;$('sign-in').textContent='Open my library';for(const id of ['queue-preview','activity-preview','feed-preview','list-content','podcast-heading','player-title','player-art','player-podcast','account-name'])$(id).replaceChildren();$('dashboard-error').hidden=true;$('notice').hidden=true;$('discover-error').hidden=true;$('discover-query').value='';$('feed-url').value='';$('search').value='';$('password').focus();});
document.addEventListener('click',event=>{const b=event.target.closest('button[data-view]');if(b)changeView(b.dataset.view);});
$('refresh').addEventListener('click',()=>{feedErrors.clear();refreshData();});
$('search').addEventListener('input',()=>{limit=40;renderList();rememberView();});
$('count-mode').addEventListener('change',()=>{countMode=$('count-mode').value;try{localStorage.setItem('podcast-sync-count',countMode);}catch{}if(countMode==='off'&&sortOrder.subscriptions.startsWith('count-')){sortOrder.subscriptions='newest';$('list-sort').value='newest';}updateCountControls();limit=40;render();});
$('list-sort').addEventListener('change',()=>{if(sortOrder[view]){sortOrder[view]=$('list-sort').value;limit=40;renderList();rememberView();}});
$('load-more').addEventListener('click',()=>{limit+=40;renderList();rememberView();});
$('subscribe-form').addEventListener('submit',event=>{event.preventDefault();subscribe($('feed-url').value.trim());});
$('discover-form').addEventListener('submit',event=>{event.preventDefault();searchDirectory();});
$('clear-queue').addEventListener('click',async()=>{if(!data.queue.length)return;const token=epoch,shown=data.queue.map(queueItem);if(await confirmAction('Clear your shared queue?',`Remove these ${shown.length} episodes from the queue on all devices? Subscriptions and listening progress stay saved.`,'Clear queue')&&token===epoch)editQueue(items=>items.filter(x=>!shown.some(y=>matching(x,y))),'Queue cleared.');});
$('server-name').textContent=location.host;

function clearAccountSettings(){
  accountGeneration++;accountCSRF='';
  for(const id of ['current-password','new-password','confirm-password'])$(id).value='';
  $('password-status').hidden=true;$('password-error').hidden=true;$('change-password').disabled=true;
}
async function loadAccountSettings(){
  const generation=++accountGeneration,token=epoch;accountCSRF='';$('change-password').disabled=true;
  try{const session=await request('session.json');if(token!==epoch||generation!==accountGeneration||view!=='account')return;
    if(!session.authenticated||session.username!==account)throw new Error('Your session has ended. Sign out and sign in again.');
    accountCSRF=session.csrf_token;$('change-password').disabled=accountSaving;
  }catch(error){if(token===epoch&&generation===accountGeneration){$('password-error').textContent=error.message;$('password-error').hidden=false;}}
}
$('password-form').addEventListener('submit',async event=>{
  event.preventDefault();if(accountSaving||!accountCSRF)return;
  const current=$('current-password').value,next=$('new-password').value,confirmation=$('confirm-password').value;
  $('password-status').hidden=true;$('password-error').hidden=true;
  let error='';
  if([...next].length<12||new TextEncoder().encode(next).length>72)error='Use at least 12 characters and at most 72 UTF-8 bytes.';
  else if(next!==confirmation)error='New passwords do not match.';
  if(error){$('password-error').textContent=error;$('password-error').hidden=false;return;}
  const token=epoch,generation=accountGeneration;accountSaving=true;$('change-password').disabled=true;$('change-password').textContent='Changing password…';
  try{
    const result=await request(userPath('account'),{current_password:current,new_password:next,confirmation,csrf_token:accountCSRF});
    if(token!==epoch||generation!==accountGeneration)return;
    if(!result.changed)throw new Error('The server did not confirm the password change.');
    accountCSRF=result.csrf_token;
    $('password-status').textContent='Password changed. You are still signed in here. Update Kasts and AntennaPod with your new sync password.';$('password-status').hidden=false;
  }catch(error){if(token===epoch&&generation===accountGeneration){$('password-error').textContent=(error.status?'':'Could not confirm the password change. ')+error.message;$('password-error').hidden=false;}}
  finally{
    accountSaving=false;
    if(token===epoch&&generation===accountGeneration)for(const id of ['current-password','new-password','confirm-password'])$(id).value='';
    $('change-password').textContent='Change password';$('change-password').disabled=!accountCSRF;
  }
});
function queueReposition(items,item,anchor,after){
  const from=items.findIndex(x=>matching(x,item));
  if(from<0||!items.some(x=>matching(x,anchor)))throw new Error('The queue changed. Refresh it before moving this episode.');
  if(matching(item,anchor))return items;
  const [moved]=items.splice(from,1),to=items.findIndex(x=>matching(x,anchor));
  items.splice(to+(after?1:0),0,moved);return items;
}
async function moveQueueTo(item,anchor,after){
  const proposed=queueReposition(data.queue.slice(),item,anchor,after);
  if(proposed.every((x,i)=>matching(x,data.queue[i])))return;
  const saved=await editQueue(items=>queueReposition(items,item,anchor,after),'Queue reordered.');
  if(saved&&view==='queue'){
    const row=[...$('list-content').querySelectorAll('.queue-row')].find(x=>matching(x.queueItem,item));
    row?.querySelector('.queue-grip')?.focus({preventScroll:true});
  }
}
function attachQueueDrag(row,item){
  row.queueItem=item;
  const grip=button('','queue-grip',()=>{},true);
  grip.setAttribute('aria-label','Move episode: '+episodeName(item));
  grip.title='Drag to move. Keyboard: Up, Down, Home, End.';
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
  for(const x of [8,16])for(const y of [5,12,19]){const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');dot.setAttribute('cx',x);dot.setAttribute('cy',y);dot.setAttribute('r','1.7');svg.append(dot);}
  grip.append(svg);row.append(grip);
  grip.addEventListener('keydown',event=>{
    if(busy||queueDrag||!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
    event.preventDefault();const at=data.queue.findIndex(x=>matching(x,item));
    const to=event.key==='Home'?0:event.key==='End'?data.queue.length-1:at+(event.key==='ArrowUp'?-1:1);
    if(to>=0&&to<data.queue.length&&to!==at)moveQueueTo(item,data.queue[to],to>at).catch(error=>showError(error.message));
  });
  grip.addEventListener('pointerdown',event=>{
    if(busy||queueDrag||event.button!==0)return;
    event.preventDefault();grip.focus({preventScroll:true});grip.setPointerCapture(event.pointerId);
    queueDrag={row,grip,item,pointer:event.pointerId,startY:event.clientY,y:event.clientY,startScroll:window.scrollY,active:false,target:null,after:false,frame:0};
  });
  grip.addEventListener('lostpointercapture',()=>finishQueueDrag(false));
}
function positionQueueDrag(){
  const drag=queueDrag;if(!drag?.active)return;
  const rows=[...$('list-content').querySelectorAll('.queue-row')].filter(x=>x!==drag.row);
  for(const row of rows)row.classList.remove('drop-before','drop-after');
  drag.target=null;
  for(const row of rows){const rect=row.getBoundingClientRect();if(drag.y<rect.top+rect.height/2){drag.target=row;drag.after=false;break;}}
  if(!drag.target&&rows.length){drag.target=rows.at(-1);drag.after=true;}
  drag.target?.classList.add(drag.after?'drop-after':'drop-before');
  drag.row.style.transform=`translateY(${drag.y-drag.startY+window.scrollY-drag.startScroll}px)`;
}
function scrollQueueDrag(){
  const drag=queueDrag;if(!drag?.active)return;
  const bottom=$('player').hidden?window.innerHeight:Math.min(window.innerHeight,$('player').getBoundingClientRect().top);
  const speed=drag.y<90?-Math.min(18,(90-drag.y)/3):drag.y>bottom-70?Math.min(18,(drag.y-bottom+70)/3):0;
  if(speed)window.scrollBy(0,speed);
  positionQueueDrag();drag.frame=requestAnimationFrame(scrollQueueDrag);
}
function finishQueueDrag(save){
  const drag=queueDrag;if(!drag)return;queueDrag=null;cancelAnimationFrame(drag.frame);
  if(drag.grip.hasPointerCapture(drag.pointer))drag.grip.releasePointerCapture(drag.pointer);
  drag.row.style.transform='';drag.row.classList.remove('queue-dragging');document.body.classList.remove('dragging-queue');
  for(const row of $('list-content').querySelectorAll('.queue-row'))row.classList.remove('drop-before','drop-after');
  const anchor=drag.target?.queueItem;renderList();
  if(save&&drag.active&&anchor)moveQueueTo(drag.item,anchor,drag.after).catch(error=>showError(error.message));
}
window.addEventListener('pointermove',event=>{
  const drag=queueDrag;if(!drag||event.pointerId!==drag.pointer)return;
  drag.y=event.clientY;
  if(!drag.active&&Math.abs(drag.y-drag.startY)>6){drag.active=true;drag.row.classList.add('queue-dragging');document.body.classList.add('dragging-queue');scrollQueueDrag();}
  if(drag.active){event.preventDefault();positionQueueDrag();}
},{passive:false});
window.addEventListener('pointerup',event=>{if(event.pointerId===queueDrag?.pointer)finishQueueDrag(true);});
window.addEventListener('pointercancel',event=>{if(event.pointerId===queueDrag?.pointer)finishQueueDrag(false);});
window.addEventListener('keydown',event=>{if(event.key==='Escape'&&queueDrag){event.preventDefault();finishQueueDrag(false);}});
window.addEventListener('blur',()=>finishQueueDrag(false));
restoreSession();
