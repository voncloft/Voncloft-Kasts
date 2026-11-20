'use strict';
const $ = id => document.getElementById(id);
const api = new URL('../api/2/', new URL('.', location.href));
const device = 'web-player';
const titles = {overview:'Your library, together.',subscriptions:'Your subscriptions.',discover:'Find your next favorite.',queue:'Up next.',devices:'Your connected apps.',activity:'Your playback records.',podcast:'Episodes.'};
const subtitles = {overview:'A little of everything you love listening to.',subscriptions:'Choose a podcast to browse its episodes.',discover:'Search for podcasts and add them to your shared library.',queue:'Your shared queue, in the order it will play.',devices:'See what is playing across your connected apps.',activity:'The latest saved episode updates from your apps.',podcast:'Browse, listen, and add something to your queue.'};
let authorization='', account='', data=null, view='overview', selectedFeed='', limit=40, epoch=0, busy=0, syncChain=Promise.resolve(), loading=false;
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
  const info=element('div','presence-status');info.append(element('span','tag'+(live?'':' stale'),live?status:'Last reported '+status.toLowerCase()));
  if(player.item)info.append(element('span','small muted',position(player.position)+(player.duration?' / '+position(player.duration):'')));
  info.append(element('span','small muted',age<60?`Reported ${Math.floor(age)}s ago`:`Reported ${Math.floor(age/60)}m ago`));
  if(!live)info.append(element('span','small muted','Offline or no longer reporting'));
  row.append(main,info);return row;
}
function renderDevices(needle){
  const players=livePlayers.filter(x=>(x.caption+' '+x.client+' '+x.item?.title+' '+x.item?.podcast_title).toLowerCase().includes(needle));
  const devices=data.devices.filter(x=>(x.caption+' '+x.id+' '+x.type).toLowerCase().includes(needle));
  $('list-note').textContent='Live players report about every 15 seconds. Reports expire after 90 seconds without an update. Apps can share a sync identity and still appear as separate players.';
  $('result-count').textContent=`${number(players.length)} players · ${number(devices.length)} sync identities`;$('load-more').hidden=true;
  const rows=[element('h2','device-section','Live players')];
  if(presenceError)rows.push(element('p','presence-warning error-text',presenceError));
  rows.push(...(players.length?players.map(presenceRow):[empty('No player reports yet. Start playback in the website or an updated Kasts/AntennaPod client.')]));
  rows.push(element('h2','device-section','Registered sync identities'),...devices.map(deviceRow));
  $('list-content').replaceChildren(...rows);renderPodcastHeading();
}
async function loadPresence(){
  if(!authorization||presenceLoading)return;presenceLoading=true;const token=epoch;
  try{const result=await request(userPath('presence'),undefined,{timeout:8000});if(token!==epoch)return;
    if(result.protocol!=='vonpresence-v1'||!Array.isArray(result.players))throw new Error('Unexpected live-status response.');
    livePlayers=result.players;presenceServerTime=result.server_time;presenceReceivedAt=Date.now();presenceError='';
  }catch(error){if(token===epoch)presenceError=error.status===404?'Install server 1.1.3 to enable live playback status.':error.message;}
  finally{if(token===epoch){presenceLoading=false;if(view==='devices')renderList();}}
}
function reportPresence(state=null,keepalive=false){
  if(!authorization||!playing||suppressPresence)return Promise.resolve();
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
function playbackContext(item,kind){return {kind,items:kind==='queue'?data.queue.slice():kind==='podcast'?orderedEpisodes(item.podcast):[item]};}
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
    const response=await fetch(new URL(path,api),{method:body===undefined?'GET':'POST',headers:{Authorization:authorization,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),credentials:'omit',cache:'no-store',redirect:'error',signal:abort.signal,keepalive:Boolean(options.keepalive)});
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
  row.append(element('span','queue-index',String(data.queue.findIndex(x=>matching(x,item))+1)),itemArt(item));
  const main=element('div','row-main');main.append(element('span','row-title'+(compact?' truncate':''),episodeName(item)),button(feedName(item.podcast),'text-button row-subtitle',()=>openPodcast(item.podcast)));
  const progress=progressText(item);if(progress&&!compact)main.append(element('div','progress-line',progress));row.append(main,playButton(item,'queue'));
  if(!compact){const controls=element('div','row-actions');controls.append(element('span','tag',item.duration?duration(item.duration):'Duration unknown'));
    const at=data.queue.findIndex(x=>matching(x,item));
    const earlier=button('Earlier','small-button',()=>moveQueue(item,-1),true),later=button('Later','small-button',()=>moveQueue(item,1),true);
    earlier.dataset.boundary=String(at===0);later.dataset.boundary=String(at===data.queue.length-1);earlier.disabled=busy>0||at===0;later.disabled=busy>0||at===data.queue.length-1;
    controls.append(earlier,later,button('Remove','small-button',()=>removeQueue(item),true));row.append(controls);}
  return row;
}
function activityRow(item,compact=false){const row=element('div','activity-row compact'),main=element('div','row-main');row.append(itemArt(item));main.append(element('span','row-title truncate',episodeName(item)),button(feedName(item.podcast),'text-button row-subtitle',()=>openPodcast(item.podcast)));const meta=element('div','row-meta');meta.append(element('span','',item.action==='play'?position(item.position)+(item.total?' / '+position(item.total):''):({new:'Marked new',download:'Downloaded',delete:'Download removed'}[item.action]||item.action)),element('span','muted',dateText(eventTime(item.timestamp))));row.append(main,meta);if(!compact)row.append(playButton({...episodeMeta(item),...item,title:episodeName(item)}));return row;}
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
function episodeRow(item){const row=element('article','episode-row');row.dataset.episodeKey=item.podcast+'\n'+(item.guid||item.episode);row.append(itemArt(item));const main=element('div','row-main');main.append(element('span','row-title',item.title));const info=[item.published?new Date(item.published*1000).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'',item.duration?duration(item.duration):''].filter(Boolean).join(' · ');main.append(element('div','row-subtitle',info));const progress=progressText(item);if(progress)main.append(element('div','progress-line',progress));if(item.description){const details=element('details','description');details.append(element('summary','', 'Episode notes'),element('p','',item.description));main.append(details);}row.append(main);const controls=element('div','row-actions');controls.append(playButton(item,'podcast'),button(inQueue(item)?'Remove from queue':'Add to queue','small-button',()=>toggleQueue(item),true));row.append(controls);return row;}
function renderOverview(){if(!data)return;$('stat-subscriptions').textContent=number(data.subscriptions.length);$('stat-queue').textContent=number(data.queue.length);$('stat-devices').textContent=number(data.devices.length);$('stat-actions').textContent=number(data.actions.length);$('nav-subscriptions').textContent=number(data.subscriptions.length);$('nav-queue').textContent=number(data.queue.length);const known=data.queue.filter(x=>x.duration>0);$('stat-duration').textContent=known.length?duration(known.reduce((s,x)=>s+x.duration,0))+(known.length<data.queue.length?' known duration':' in your queue'):'In your shared queue';$('queue-preview').replaceChildren(...(data.queue.length?data.queue.slice(0,5).map(x=>queueRow(x,true)):[empty('Nothing queued yet. Open a podcast and choose an episode.')]));$('activity-preview').replaceChildren(...(data.actions.length?data.actions.slice(0,5).map(x=>activityRow(x,true)):[empty('Your listening progress will appear here.')]));$('feed-preview').replaceChildren(...data.subscriptions.slice(0,5).map(feedCard));}
function renderPodcastHeading(){const root=$('podcast-heading');if(view!=='podcast'){root.hidden=true;return;}root.hidden=false;const feed=metadata.get(selectedFeed),hero=element('div','podcast-hero');hero.append(art(feed?.image,feedName(selectedFeed)));const main=element('div','row-main');main.append(element('h2','',feedName(selectedFeed)));if(feed?.description){const details=element('details','description');details.append(element('summary','','About this podcast'),element('p','',feed.description));main.append(details);}const counts=feedCounts(selectedFeed);if(counts.total!==null)main.append(element('p','podcast-counts',`${number(counts.total)} episodes · ${counts.unplayed===null?'…':number(counts.unplayed)} unplayed · ${number(counts.queued)} in queue`));const controls=element('div','row-actions');controls.append(button('All subscriptions','text-button',()=>changeView('subscriptions')),button('Refresh episodes','small-button',()=>loadFeed(selectedFeed,true,true).catch(()=>{})));
  if(data.subscriptions.includes(selectedFeed))controls.append(button('Unsubscribe','small-button',()=>unsubscribe(selectedFeed),true));else controls.append(button('Subscribe','small-button',()=>subscribe(selectedFeed),true));
  main.append(controls);if(feed?.stale)main.append(element('p','error-text','Showing cached episodes. '+(feed.warning||'The publisher is temporarily unavailable.')));if(feedErrors.has(selectedFeed))main.append(element('p','error-text',feedErrors.get(selectedFeed)));hero.append(main);root.replaceChildren(hero);}
function discoveryCard(item){const card=element('article','feed-card');card.append(art(item.image,item.title),element('span','row-title',item.title),element('span','small',item.author||''));const subscribed=data.subscriptions.includes(item.url);card.append(button(subscribed?'Browse episodes':'Subscribe',subscribed?'text-button':'primary-button',()=>subscribed?openPodcast(item.url):subscribe(item.url,item),!subscribed));if(safeUrl(item.website)){const link=element('a','text-button','Apple Podcasts');link.href=item.website;link.target='_blank';link.rel='noopener noreferrer';card.append(link);}return card;}
function renderList(){if(!data||view==='overview')return;const expanded=new Set([...document.querySelectorAll('.episode-row:has(details[open])')].map(n=>n.dataset.episodeKey));const aboutOpen=Boolean(document.querySelector('#podcast-heading details[open]'));const needle=$('search').value.trim().toLowerCase();let items=[],render,note='';
  $('list-content').className=['subscriptions','discover'].includes(view)?'feed-grid':'';
  if(view==='devices'){renderDevices(needle);return;}
  if(view==='subscriptions'){items=orderedSubscriptions().filter(x=>(feedName(x)+' '+x).toLowerCase().includes(needle));render=feedCard;note='Choose a thumbnail count, then sort by count, latest episode date, or title. Played and unplayed counts use synced status for episodes in the current feed. In queue includes older queued episodes.';}
  if(view==='queue'){items=data.queue.filter(x=>(episodeName(x)+' '+feedName(x.podcast)).toLowerCase().includes(needle));render=queueRow;note='Add, remove, or move episodes here. Your apps pick up the saved order when they sync.';}
  if(view==='devices'){items=data.devices.filter(x=>(x.caption+' '+x.id+' '+x.type).toLowerCase().includes(needle));render=deviceRow;note='Apps sharing a device name appear once. Registration does not mean a device is online.';}
  if(view==='activity'){items=data.actions.filter(x=>(episodeName(x)+' '+feedName(x.podcast)+' '+x.device).toLowerCase().includes(needle));render=activityRow;note='Latest saved records per episode and action type, rather than every listening event or total listening time.';}
  if(view==='podcast'){items=orderedEpisodes(selectedFeed).filter(x=>(x.title+' '+x.description).toLowerCase().includes(needle));render=episodeRow;note=metadata.get(selectedFeed)?.episodes?'Play next follows the episode order selected when you start listening. Older queued episodes remain playable from your queue.':feedErrors.has(selectedFeed)?'Could not load this feed. Use Refresh episodes to retry.':'Loading episodes…';if(metadata.get(selectedFeed)?.limited)note+=' Showing up to 2,000 episodes.';}
  if(view==='discover'){items=discoverResults.filter(x=>(x.title+' '+x.author).toLowerCase().includes(needle));render=discoveryCard;note=discoverySearched?'Results from Apple Podcasts. Subscribe to browse a show’s episodes.':'Search by podcast name, topic, or creator above. You can also add an RSS URL in Subscriptions.';}
  $('list-note').textContent=note;$('result-count').textContent=number(items.length)+(view==='podcast'?(items.length===1?' episode':' episodes'):(items.length===1?' item':' items'));$('load-more').hidden=items.length<=limit;
  const noItems=needle?'No matches. Try another search.':view==='discover'?(discoverySearched?'No podcasts found. Try another search.':'Search for a podcast to get started.'):view==='podcast'&&!metadata.get(selectedFeed)?.episodes?'Your episodes will appear here once the feed loads.':'Nothing here yet.';
  $('list-content').replaceChildren(...(items.length?items.slice(0,limit).map(x=>render(x)):[empty(noItems)]));renderPodcastHeading();for(const row of document.querySelectorAll('.episode-row')){if(expanded.has(row.dataset.episodeKey)&&row.querySelector('details'))row.querySelector('details').open=true;}if(aboutOpen&&document.querySelector('#podcast-heading details'))document.querySelector('#podcast-heading details').open=true;
}
function render(){if(!data)return;feedCountsCache.clear();renderOverview();renderList();if(playing){$('player-art').replaceChildren(itemArt(playing));$('player-podcast').textContent=feedName(playing.podcast);$('player-title').textContent=episodeMeta(playing)?.title||playing.title;}updateBusy();}
function changeView(next){if(!data||!Object.hasOwn(titles,next))return;view=next;limit=40;$('search').value='';$('page-title').textContent=titles[view];$('page-subtitle').textContent=subtitles[view];$('overview-view').hidden=view!=='overview';$('detail-view').hidden=view==='overview';$('stats').hidden=view!=='overview';$('subscription-tools').hidden=view!=='subscriptions';$('discover-tools').hidden=view!=='discover';$('clear-queue').hidden=view!=='queue';$('podcast-heading').hidden=view!=='podcast';$('sort-control').hidden=!['subscriptions','podcast'].includes(view);$('sort-title').hidden=view!=='subscriptions';updateCountControls();if(sortOrder[view])$('list-sort').value=sortOrder[view];for(const b of document.querySelectorAll('.nav-item')){const active=b.dataset.view===view||(view==='podcast'&&b.dataset.view==='subscriptions');b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}renderList();if(view==='devices')loadPresence();window.scrollTo(0,0);}
function openPodcast(url){selectedFeed=url;changeView('podcast');loadFeed(url,true).catch(()=>{});}
async function loadFeed(url,full=false,refresh=false){
  if(!authorization)return;const token=epoch;
  if(!refresh&&metadata.has(url)&&(!full||metadata.get(url).episodes))return metadata.get(url);
  if(feedLoads.has(url)){await feedLoads.get(url).catch(()=>{});if(token!==epoch)return;if(!refresh&&metadata.has(url)&&(!full||metadata.get(url).episodes))return metadata.get(url);}
  const promise=(async()=>{try{const result=await request(userPath('library')+'?feed='+encodeURIComponent(url)+(full?'':'&summary=1')+(refresh?'&refresh=1':''));if(token!==epoch)return;metadata.set(url,{...metadata.get(url),...result});feedErrors.delete(url);render();return result;}catch(error){if(token===epoch){feedErrors.set(url,error.status===404?'Install the 1.1 server update to load artwork and episodes.':error.message);render();}throw error;}finally{if(token===epoch)feedLoads.delete(url);}})();feedLoads.set(url,promise);return promise;
}
async function warmFeeds(){const token=epoch,urls=[...new Set([...data.queue.map(x=>x.podcast),...data.subscriptions])];let at=0;await Promise.all([0,1,2].map(async()=>{while(at<urls.length&&token===epoch){const url=urls[at++];if(!metadata.has(url)&&!feedErrors.has(url))await loadFeed(url).catch(()=>{});}}));}
async function refreshData(initial=false,quiet=false){
  if(loading||(!initial&&busy))return;loading=true;const token=epoch;
  try{await serial(async()=>{
    const user=encodeURIComponent(account),cursor=data?.cursor||0;
    const [devices,subs,queue,updates]=await Promise.all([request(`devices/${user}.json`),request(`subscriptions/${user}/${device}.json?since=0`),request(`queue/${user}/${device}.json`),request(`episodes/${user}.json?since=${cursor}`)]);
    if(token!==epoch)return;
    if(!Array.isArray(devices)||!Array.isArray(subs.add)||!Array.isArray(queue.items)||!Array.isArray(updates.actions))throw new Error('The server returned an unexpected response.');
    data={devices,subscriptions:[...new Set(subs.add)],queue:queue.items,revision:queue.revision,actions:[],cursor:updates.timestamp};mergeActions(updates.actions);
    $('password').value='';$('login-screen').hidden=true;$('dashboard').hidden=false;$('navigation').hidden=false;$('account-controls').hidden=false;$('account-name').textContent=account;$('updated-at').textContent='Updated '+new Date().toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
    if(initial)changeView('overview');render();if(!quiet)$('dashboard-error').hidden=true;
  });if(token===epoch&&data){warmFeeds();loadPresence();}}
  catch(error){if(token!==epoch)return;if(initial){authorization='';$('login-error').textContent=error.message;$('login-error').hidden=false;}else showError(error.message+' The last loaded library is still shown.');}
  finally{if(token===epoch){loading=false;$('sign-in').disabled=false;$('sign-in').textContent='Open my library';}}
}
async function editQueue(transform,message){const token=epoch;try{await serial(async()=>{const items=transform(data.queue.map(queueItem));const result=await request(userPath('queue','/'+device),{base_revision:data.revision,items});data.queue=result.items;data.revision=result.revision;render();notice(message+' Saved to server; sync your other apps to receive it.');});return token===epoch;}catch(error){if(token!==epoch)return false;showError('Queue was not confirmed saved. '+error.message+' Refresh before retrying.');return false;}}
function toggleQueue(item){if(inQueue(item))return removeQueue(item);return editQueue(items=>items.some(x=>matching(x,item))?items:[...items,queueItem(item)],'Episode added.');}
function removeQueue(item){return editQueue(items=>items.filter(x=>!matching(x,item)),'Episode removed from queue.');}
function moveQueue(item,offset){return editQueue(items=>{const from=items.findIndex(x=>matching(x,item)),to=from+offset;if(from>=0&&to>=0&&to<items.length)[items[from],items[to]]=[items[to],items[from]];return items;},'Queue reordered.');}
function confirmAction(title,message,label){const dialog=$('confirm-dialog');$('confirm-title').textContent=title;$('confirm-message').textContent=message;$('confirm-button').textContent=label;dialog.returnValue='cancel';dialog.showModal();return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true}));}
async function subscribe(url,hint){const token=epoch;url=safeUrl(url);if(!url){showError('Enter a valid HTTP or HTTPS podcast feed URL.');return;}try{await serial(async()=>{await request(userPath('subscriptions','/'+device),{add:[url],remove:[]});if(!data.subscriptions.includes(url))data.subscriptions.push(url);if(hint)metadata.set(url,{title:hint.title,image:hint.image});$('feed-url').value='';render();notice('Subscribed. Sync your other apps to add this podcast there.');});if(token!==epoch)return;openPodcast(url);}catch(error){if(token===epoch)showError(error.message);}}
async function unsubscribe(url){const token=epoch;if(!await confirmAction('Unsubscribe from this podcast?',feedName(url)+' will be removed from your shared subscriptions. Episodes already queued stay in the queue.','Unsubscribe')||token!==epoch)return;try{await serial(async()=>{await request(userPath('subscriptions','/'+device),{add:[],remove:[url]});data.subscriptions=data.subscriptions.filter(x=>x!==url);changeView('subscriptions');render();notice('Unsubscribed. Sync your other apps to receive the change.');});}catch(error){showError('Could not confirm the subscription change. '+error.message);}}
async function searchDirectory(){const term=$('discover-query').value.trim();if(term.length<2)return;const token=epoch;$('discover-submit').disabled=true;$('discover-error').hidden=true;try{const result=await request(userPath('discover')+'?q='+encodeURIComponent(term));if(token!==epoch)return;discoverResults=result.results;discoverySearched=true;renderList();}catch(error){if(token===epoch){$('discover-error').textContent=error.message;$('discover-error').hidden=false;}}finally{if(token===epoch)$('discover-submit').disabled=false;}}
function registerPlayer(){return request(userPath('devices','/'+device),{caption:'Podcast Sync web player',type:'other'}).then(()=>{if(data&&!data.devices.some(x=>x.id===device)){data.devices.push({id:device,caption:'Podcast Sync web player',type:'other'});renderOverview();}});}
function setPlayerError(text){$('player-error').textContent=text;$('player-error').hidden=!text;}
function queueProgress(complete=false,keepalive=false){if(!playing||!ready||!played)return;const total=Math.floor(Number.isFinite(audio.duration)?audio.duration:Number(playing.duration)||0),pos=complete&&total?total:Math.floor(audio.currentTime||0);const a={podcast:playing.podcast,episode:playing.episode,guid:playing.guid||'',device,action:'play',timestamp:new Date().toISOString(),started:Math.min(started,pos),position:pos,total:Math.max(total,pos)};pendingProgress.set(a.podcast+'\n'+a.episode,a);appliedActionTime=eventTime(a.timestamp);lastAttempt=Date.now();$('progress-status').textContent='Saving progress…';return flushProgress(keepalive);}
async function flushProgress(keepalive=false){if(progressSending||!pendingProgress.size||!authorization)return;progressSending=true;const token=epoch,batch=[...pendingProgress.values()];try{await request(userPath('episodes'),batch,{keepalive});if(token!==epoch)return;for(const a of batch){const key=a.podcast+'\n'+a.episode;if(pendingProgress.get(key)===a)pendingProgress.delete(key);}mergeActions(batch);$('progress-status').textContent=pendingProgress.size?'Saving progress…':'Progress saved to server';$('retry-progress').hidden=true;setProgressError('');render();}catch(error){if(token===epoch){$('progress-status').textContent='Progress not saved';$('retry-progress').hidden=false;setProgressError(error.message+' Keep this tab open and retry.');}}finally{if(token===epoch){progressSending=false;}}}
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
audio.addEventListener('loadedmetadata',()=>{ready=true;if(resumeAt>0&&Number.isFinite(audio.duration)&&resumeAt<audio.duration-1)audio.currentTime=resumeAt;else if(resumeAt>0&&!Number.isFinite(audio.duration))audio.currentTime=resumeAt;started=Math.floor(audio.currentTime||0);$('progress-status').textContent=pendingProgress.size?'Saving progress…':'Progress saves every 15 seconds';});
audio.addEventListener('play',()=>{if(ready&&playing){const latest=playback(playing);if(latest&&eventTime(latest.timestamp)>appliedActionTime&&!pendingProgress.has(playing.podcast+'\n'+playing.episode)){const target=latest.total>0&&latest.position>=latest.total?0:latest.position;if(Number.isFinite(target))audio.currentTime=target;appliedActionTime=eventTime(latest.timestamp);started=target;}}played=true;setPlayerError('');render();reportPresence();});
audio.addEventListener('pause',()=>{queueProgress();render();reportPresence();});
audio.addEventListener('seeked',()=>{queueProgress();reportPresence();});
audio.addEventListener('timeupdate',()=>{if(ready&&played&&!audio.paused&&Date.now()-lastAttempt>=15000)queueProgress();});
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
window.addEventListener('pagehide',()=>{queueProgress(false,true);reportPresence('stopped',true);});
window.addEventListener('beforeunload',event=>{if(pendingProgress.size){event.preventDefault();event.returnValue='';}});
$('login-form').addEventListener('submit',event=>{event.preventDefault();epoch++;suppressPresence=false;account=$('username').value.trim();authorization='Basic '+btoa(Array.from(new TextEncoder().encode(account+':'+$('password').value),x=>String.fromCharCode(x)).join(''));$('login-error').hidden=true;$('sign-in').disabled=true;$('sign-in').textContent='Opening your library…';refreshData(true);});
$('sign-out').addEventListener('click',async()=>{await queueProgress();if(pendingProgress.size&&!await confirmAction('Sign out with progress still saving?','Keep this tab open until progress saves to avoid losing your latest listening position.','Sign out'))return;await reportPresence('stopped');suppressPresence=true;epoch++;presencePending=null;presenceFlight=null;presenceLoading=false;livePlayers=[];presenceError='';ready=false;audio.pause();audio.removeAttribute('src');audio.load();playing=null;playContext=null;played=false;setPlayerError('');setProgressError('');for(const c of controllers)c.abort();controllers.clear();authorization='';account='';data=null;metadata=new Map();feedErrors=new Map();feedLoads=new Map();actions=new Map();playbackIndex.clear();feedCountsCache.clear();pendingProgress=new Map();progressSending=false;discoverResults=[];discoverySearched=false;busy=0;loading=false;syncChain=Promise.resolve();$('dashboard').hidden=true;$('navigation').hidden=true;$('account-controls').hidden=true;$('player').hidden=true;$('login-screen').hidden=false;$('password').value='';$('sign-in').disabled=false;$('sign-in').textContent='Open my library';for(const id of ['queue-preview','activity-preview','feed-preview','list-content','podcast-heading','player-title','player-art','player-podcast','account-name'])$(id).replaceChildren();$('dashboard-error').hidden=true;$('notice').hidden=true;$('discover-error').hidden=true;$('discover-query').value='';$('feed-url').value='';$('search').value='';$('password').focus();});
document.addEventListener('click',event=>{const b=event.target.closest('button[data-view]');if(b)changeView(b.dataset.view);});
$('refresh').addEventListener('click',()=>{feedErrors.clear();refreshData();});
$('search').addEventListener('input',()=>{limit=40;renderList();});
$('count-mode').addEventListener('change',()=>{countMode=$('count-mode').value;try{localStorage.setItem('podcast-sync-count',countMode);}catch{}if(countMode==='off'&&sortOrder.subscriptions.startsWith('count-')){sortOrder.subscriptions='newest';$('list-sort').value='newest';}updateCountControls();limit=40;render();});
$('list-sort').addEventListener('change',()=>{if(sortOrder[view]){sortOrder[view]=$('list-sort').value;limit=40;renderList();}});
$('load-more').addEventListener('click',()=>{limit+=40;renderList();});
$('subscribe-form').addEventListener('submit',event=>{event.preventDefault();subscribe($('feed-url').value.trim());});
$('discover-form').addEventListener('submit',event=>{event.preventDefault();searchDirectory();});
$('clear-queue').addEventListener('click',async()=>{if(!data.queue.length)return;const token=epoch,shown=data.queue.map(queueItem);if(await confirmAction('Clear your shared queue?',`Remove these ${shown.length} episodes from the queue on all devices? Subscriptions and listening progress stay saved.`,'Clear queue')&&token===epoch)editQueue(items=>items.filter(x=>!shown.some(y=>matching(x,y))),'Queue cleared.');});
setInterval(()=>{if(data&&!document.hidden)refreshData(false,true);if(authorization&&pendingProgress.size)flushProgress();},30000);
setInterval(()=>{if(data)reportPresence();},15000);
setInterval(()=>{if(data&&view==='devices'&&!document.hidden)loadPresence();},10000);
$('server-name').textContent=location.host;
