'use strict';
const $ = id => document.getElementById(id);
const api = new URL('../api/2/', new URL('.', location.href));
let authorization = '', account = '', data = null, view = 'overview', limit = 50, generation = 0, controller = null;
const number = value => new Intl.NumberFormat().format(value);
const titles = {overview:'Your library, together.',subscriptions:'Your subscriptions.',queue:'Up next.',devices:'Your connected apps.',activity:'Your playback records.'};
const subtitles = {overview:'Everything your apps have shared with this server.',subscriptions:'The podcast feeds currently active on your account.',queue:'Your shared queue, in the order it will play.',devices:'The device identities registered to your account.',activity:'The latest saved episode updates from your apps.'};
$('server-name').textContent = location.host;
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function safeUrl(value) {
  try { const url=new URL(value); return ['http:','https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
function duration(value) {
  const seconds = Math.max(0,Number(value)||0), mins=Math.floor(seconds/60);
  return mins>=60 ? `${Math.floor(mins/60)}h ${mins%60}m` : `${mins}m`;
}
function position(value) {
  const sec=Math.floor(Math.max(0,Number(value)||0));
  return sec>=3600 ? `${Math.floor(sec/3600)}:${String(Math.floor(sec/60)%60).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}` : `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
}
function eventTime(value) {
  if (!value) return null;
  const text=String(value), date=new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(text) ? text : text+'Z');
  return Number.isFinite(date.getTime())?date:null;
}
function dateText(date) {
  return date ? date.toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'Time unavailable';
}
function feedName(url) { return data.feedNames.get(url) || url || 'Unknown podcast'; }
function episodeName(item) {
  const matched=data.episodeNames.get(item.podcast+'\n'+item.episode) || data.episodeNames.get(item.podcast+'\n'+item.guid);
  if (matched) return matched;
  try { const path=new URL(item.episode).pathname.split('/').filter(Boolean).pop(); return decodeURIComponent(path||'Episode'); } catch { return item.episode || item.guid || 'Episode'; }
}
function empty(message) { return element('div','empty',message); }
function queueRow(item,compact=false) {
  const row=element('div','queue-row');
  row.append(element('span','queue-index',String(item.order).padStart(2,'0')));
  row.append(element('span','queue-art',String(item.podcast_title||'P').slice(0,1).toUpperCase()));
  const main=element('div','row-main');
  main.append(element('span','row-title'+(compact?' truncate':''),item.title||'Untitled episode'));
  main.append(element('span','row-subtitle'+(compact?' truncate':''),feedName(item.podcast)));
  row.append(main,element('span','row-meta',item.duration>0?duration(item.duration):'—'));
  return row;
}
function activityRow(item,compact=false) {
  const row=element('div','activity-row'),main=element('div','row-main');
  row.append(element('span','activity-dot'));
  main.append(element('span','row-title'+(compact?' truncate':''),episodeName(item)));
  main.append(element('span','row-subtitle'+(compact?' truncate':''),feedName(item.podcast)));
  const meta=element('div','row-meta');
  const labels={play:'Playback',download:'Downloaded',delete:'Download removed',new:'Marked new'};
  meta.append(element('span','',item.action==='play'&&item.position!==undefined ? position(item.position)+(item.total>0?' / '+position(item.total):'') : (labels[item.action]||item.action||'Update')));
  meta.append(element('span','muted',dateText(item.date)));
  row.append(main,meta);
  return row;
}
function feedRow(url) {
  const row=element('div','feed-row'),main=element('div','row-main');
  row.append(element('span','queue-art',String(feedName(url)).slice(0,1).toUpperCase()));
  main.append(element('span','row-title',feedName(url)));
  if (safeUrl(url)) {
    const link=element('a','feed-link',data.feedNames.has(url)?url:'Open podcast feed ↗');
    link.href=safeUrl(url); link.target='_blank'; link.rel='noopener noreferrer'; main.append(link);
  }
  row.append(main,element('span','tag','Subscribed'));
  return row;
}
function deviceRow(item) {
  const row=element('div','device-row'),main=element('div','row-main');
  row.append(element('span','device-icon',item.type==='mobile'?'▯':'▣'));
  main.append(element('span','row-title',item.caption||item.id));
  main.append(element('span','row-subtitle',item.id));
  row.append(main,element('span','tag',item.type==='other'?'Device':item.type||'Device'));
  return row;
}
function renderOverview() {
  $('stat-subscriptions').textContent=number(data.subscriptions.length);
  $('stat-queue').textContent=number(data.queue.length);
  $('stat-devices').textContent=number(data.devices.length);
  $('stat-actions').textContent=number(data.actions.length);
  $('nav-subscriptions').textContent=number(data.subscriptions.length);
  $('nav-queue').textContent=number(data.queue.length);
  const known=data.queue.filter(item=>item.duration>0), seconds=known.reduce((sum,item)=>sum+item.duration,0);
  $('stat-duration').textContent=known.length?`${duration(seconds)}${known.length<data.queue.length?' known duration':' in your queue'}`:'In your shared queue';
  $('queue-preview').replaceChildren(...(data.queue.length?data.queue.slice(0,6).map(item=>queueRow(item,true)):[empty('Nothing queued yet. Add an episode in one of your apps, then sync.')]));
  $('activity-preview').replaceChildren(...(data.actions.length?data.actions.slice(0,6).map(item=>activityRow(item,true)):[empty('Your playback updates will appear here after your apps sync.')]));
}
function renderList() {
  const needle=$('search').value.trim().toLowerCase();
  let items=[], render, note='';
  if (view==='subscriptions') {
    items=data.subscriptions; render=feedRow;
    note='Active subscriptions. Feed addresses are shown when a podcast name is not available.';
    items=items.filter(url=>(feedName(url)+' '+url).toLowerCase().includes(needle));
  } else if (view==='queue') {
    items=data.queue; render=queueRow; note='Queue changes appear here after syncing your app. Audio files remain with their publishers.';
    items=items.filter(item=>(item.title+' '+feedName(item.podcast)+' '+item.podcast).toLowerCase().includes(needle));
  } else if (view==='devices') {
    items=data.devices; render=deviceRow; note='Apps sharing a device name appear once. Registration does not indicate whether a device is online.';
    items=items.filter(item=>(item.caption+' '+item.id+' '+item.type).toLowerCase().includes(needle));
  } else if (view==='activity') {
    items=data.actions; render=activityRow; note='The latest update per episode and action type, newest first. The server does not keep every past event or measure total listening time.';
    items=items.filter(item=>(episodeName(item)+' '+feedName(item.podcast)+' '+item.device+' '+item.action).toLowerCase().includes(needle));
  }
  $('list-note').textContent=note;
  $('result-count').textContent=number(items.length)+(items.length===1?' item':' items');
  $('list-content').replaceChildren(...(items.length?items.slice(0,limit).map(item=>render(item)):[empty(needle?'No matches. Try another search.':'There is nothing here yet. Sync your apps, then refresh this page.')]));
  $('load-more').hidden=items.length<=limit;
}
function changeView(next) {
  if (!data || !Object.hasOwn(titles,next)) return;
  view=next; limit=50; $('search').value='';
  $('page-title').textContent=titles[view]; $('page-subtitle').textContent=subtitles[view];
  $('overview-view').hidden=view!=='overview'; $('detail-view').hidden=view==='overview';
  $('stats').hidden=view!=='overview';
  for (const button of document.querySelectorAll('.nav-item')) {
    const active=button.dataset.view===view;
    button.classList.toggle('active',active);
    if (active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
  }
  if (view!=='overview') renderList();
  window.scrollTo(0,0);
}
async function request(path,signal) {
  const response=await fetch(new URL(path,api),{headers:{Authorization:authorization,Accept:'application/json'},credentials:'omit',cache:'no-store',signal,redirect:'error'});
  if (!response.ok) {
    const error=new Error(response.status===401?'The username or password was not accepted.':`The server returned HTTP ${response.status}. Please try again.`);
    error.status=response.status; throw error;
  }
  return response.json();
}
async function loadData() {
  const run=++generation, user=encodeURIComponent(account), wasSignedIn=Boolean(data);
  controller=new AbortController(); const currentController=controller;
  const timeout=setTimeout(()=>currentController.abort(),20000);
  $('refresh').disabled=true; $('sign-in').disabled=true;
  $('sign-in').textContent='Opening your library…'; $('status').textContent='Loading your synced library.';
  $('login-error').hidden=true; $('dashboard-error').hidden=true;
  try {
    const devices=await request(`devices/${user}.json`,currentController.signal);
    const [subs,queue,actions]=await Promise.all([
      request(`subscriptions/${user}/dashboard.json?since=0`,currentController.signal),
      request(`queue/${user}/dashboard.json`,currentController.signal),
      request(`episodes/${user}.json?since=0`,currentController.signal)
    ]);
    if (!Array.isArray(devices)||!Array.isArray(subs.add)||!Array.isArray(queue.items)||!Array.isArray(actions.actions)) throw new Error('The server returned an unexpected response.');
    if (run!==generation) return;
    const feedNames=new Map(),episodeNames=new Map();
    const queueItems=queue.items.map((item,index)=>({...item,duration:Math.max(0,Number(item.duration)||0),order:index+1}));
    for (const item of queueItems) {
      if (item.podcast_title) feedNames.set(item.podcast,item.podcast_title);
      if (item.title) { episodeNames.set(item.podcast+'\n'+item.episode,item.title); if (item.guid) episodeNames.set(item.podcast+'\n'+item.guid,item.title); }
    }
    data={devices,subscriptions:[...new Set(subs.add)].sort((a,b)=>(feedNames.get(a)||a).localeCompare(feedNames.get(b)||b)),queue:queueItems,actions:actions.actions.map(item=>({...item,date:eventTime(item.timestamp)})).sort((a,b)=>(b.date?.getTime()||0)-(a.date?.getTime()||0)),feedNames,episodeNames};
    $('password').value=''; $('login-screen').hidden=true; $('dashboard').hidden=false; $('navigation').hidden=false; $('account-controls').hidden=false;
    $('account-name').textContent=account;
    $('updated-at').textContent='Updated '+new Date().toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
    renderOverview();
    if (wasSignedIn) { if (view!=='overview') renderList(); } else changeView('overview');
    $('status').textContent='Library refreshed.';
  } catch(error) {
    if (run!==generation) return;
    currentController.abort();
    const message=error.name==='AbortError'?'The request timed out. Check your connection and try again.':error instanceof TypeError?'Could not reach your sync server. Check your connection and try again.':error.message;
    const target=wasSignedIn?$('dashboard-error'):$('login-error');
    target.textContent=message+(wasSignedIn?' The last loaded data is still shown.':''); target.hidden=false;
    $('status').textContent='Library could not be loaded.';
    if (!wasSignedIn) authorization='';
  } finally {
    clearTimeout(timeout);
    if (run===generation) { $('refresh').disabled=false; $('sign-in').disabled=false; $('sign-in').textContent='Open my library ↗'; }
  }
}
$('login-form').addEventListener('submit',event=>{
  event.preventDefault(); account=$('username').value.trim();
  const bytes=new TextEncoder().encode(account+':'+$('password').value);
  authorization='Basic '+btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join(''));
  loadData();
});
$('sign-out').addEventListener('click',()=>{
  generation++; controller?.abort(); authorization=''; account=''; data=null;
  $('dashboard').hidden=true; $('navigation').hidden=true; $('account-controls').hidden=true; $('login-screen').hidden=false;
  $('password').value=''; $('login-error').hidden=true; $('sign-in').disabled=false; $('sign-in').textContent='Open my library ↗';
  for (const id of ['queue-preview','activity-preview','list-content','account-name']) $(id).replaceChildren();
  $('status').textContent='Signed out.'; $('password').focus();
});
document.addEventListener('click',event=>{const button=event.target.closest('button[data-view]'); if(button)changeView(button.dataset.view);});
$('refresh').addEventListener('click',loadData);
$('search').addEventListener('input',()=>{limit=50;renderList();});
$('load-more').addEventListener('click',()=>{limit+=50;renderList();});
