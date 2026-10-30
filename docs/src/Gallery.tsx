import { useEffect, useRef, useState } from 'react';
import SparkMD5 from 'spark-md5';
import { login, type Session } from './lib/divoomApi';
import { downloadBinary, type GalleryInfo } from './lib/divoomApi';
import { PyodideDecoder } from './lib/pyodideDecoder';
import './Gallery.css';

type Filter = { category: number; size: number; type: number; sort: number; query: string; author: number | null; authorName: string };
const initial: Filter = { category: 1, size: 127, type: 5, sort: 0, query: '', author: null, authorName: '' };
const categories: [number, string][] = [[1,'全部'],[0,'最新精选'],[18,'推荐'],[3,'角色'],[4,'表情'],[5,'日常'],[6,'自然'],[7,'图标'],[8,'图案 / 几何'],[9,'创意'],[12,'照片'],[17,'节日'],[31,'植物'],[32,'动物'],[33,'人物'],[35,'美食']];
const REMEMBER_KEY = 'divoom-remember-login-v2';
const SESSION_KEY = 'divoom-login-session-v1';
function loadSession(): Session | null { try { const value = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); return value && (typeof value.token === 'string' || typeof value.token === 'number') && typeof value.userId === 'number' && typeof value.email === 'string' ? value : null; } catch { return null; } }
type Artist = { UserId:number; NickName:string; FansCnt:number; HeadId:string; FileList:GalleryInfo[] };
type Album = { AlbumId:number; AlbumName:string; AlbumImageId:string; GalleryCnt:number; GalleryList:GalleryInfo[] };
const save = (blob: Blob, name: string) => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
const fileName = (a: GalleryInfo) => `${String(a.FileName || 'art').replace(/[\\/:*?"<>|]/g, '_')}_${a.GalleryId}`;
const dataBlob = (data: Uint8Array, type: string) => new Blob([new Uint8Array(data)], { type });
async function list(filter: Filter, start: number): Promise<GalleryInfo[]> {
  const endpoint = filter.author ? 'GetSomeoneListV3' : filter.query.trim() ? 'SearchGalleryV3' : 'GetCategoryFileListV2';
  const body = { StartNum: start, EndNum: start + 29, Version: 19, RefreshIndex: 0, FileSize: filter.size, FileType: filter.type, FileSort: filter.sort, Classify: filter.category, ...(filter.author ? { SomeOneUserId: filter.author, ShowAllFlag: 0 } : filter.query.trim() ? { Keywords: filter.query.trim(), KeywordsEn: filter.query.trim() } : {}) };
  const host = 'appin.divoom-gz.com';
  const response = await fetch(`https://${host}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(response.status === 429 ? '请求过于频繁，请稍等一分钟后重试。' : `社区服务返回 HTTP ${response.status}`);
  const result = await response.json();
  if (result.ReturnCode !== 0) throw new Error(`社区接口返回错误 ${result.ReturnCode}，请稍后重试。`);
  return (result.FileList || []).filter((item: GalleryInfo) => !item.HideFlag);
}
// Bounded LRU stores decoded images, not object URLs, so off-screen views can release
// browser image resources while recently viewed artwork remains instant to revisit.
const previewCache = new Map<string, Blob>();
let previewCacheBytes = 0;
const MAX_PREVIEW_BYTES = 128 * 1024 * 1024;
const MAX_PREVIEW_ITEMS = 1500;
function cachedPreview(key:string): Blob | undefined {
  const blob = previewCache.get(key);
  if (blob) { previewCache.delete(key); previewCache.set(key, blob); }
  return blob;
}
function cachePreview(key:string, blob:Blob) {
  const old = previewCache.get(key);
  if (old) { previewCacheBytes -= old.size; previewCache.delete(key); }
  if (blob.size > MAX_PREVIEW_BYTES) return;
  previewCache.set(key, blob); previewCacheBytes += blob.size;
  while (previewCache.size > MAX_PREVIEW_ITEMS || previewCacheBytes > MAX_PREVIEW_BYTES) {
    const first = previewCache.keys().next().value;
    if (first === undefined) break;
    previewCacheBytes -= previewCache.get(first)!.size; previewCache.delete(first);
  }
}
type PreviewJob = { cancelled:boolean; run:()=>Promise<void> };
const previewQueue: PreviewJob[] = [];
let previewRunning = false;
function processPreviews() {
  if (previewRunning) return;
  const job = previewQueue.shift();
  if (!job) return;
  if (job.cancelled) { processPreviews(); return; }
  previewRunning = true;
  void job.run().finally(() => { previewRunning = false; processPreviews(); });
}
function LazyArt({item, decoder, alt = '', fallback = '加载中'}: {item:GalleryInfo; decoder:PyodideDecoder; alt?:string; fallback?:string}) {
  const host = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState(''); const [failed, setFailed] = useState(false);
  useEffect(() => {
    const node = host.current; if (!node || !item.FileId) return;
    let job:PreviewJob | null = null; let objectUrl = ''; let active = false;
    const clear = () => { active = false; if (job) job.cancelled = true; job = null; if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = ''; setUrl(''); };
    const observer = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) { clear(); return; }
      if (active) return; active = true; setFailed(false);
      const existing = cachedPreview(item.FileId);
      if (existing) { objectUrl = URL.createObjectURL(existing); setUrl(objectUrl); return; }
      const task:PreviewJob = { cancelled:false, run:async () => { try { const raw=await downloadBinary(item.FileId); if(task.cancelled) return; const bean=await decoder.decode(raw); const blob=dataBlob(bean.webp,'image/webp'); cachePreview(item.FileId,blob); if(task.cancelled) return; objectUrl=URL.createObjectURL(blob); setUrl(objectUrl); } catch { if(!task.cancelled) setFailed(true); } } };
      job=task; previewQueue.push(task); processPreviews();
    }, { rootMargin:'250px' });
    observer.observe(node);
    return () => { observer.disconnect(); clear(); };
  }, [item.FileId, decoder]);
  return <span ref={host} className="lazy-art">{url ? <img src={url} alt={alt}/> : <span>{failed ? '无法预览' : fallback}</span>}</span>;
}
export default function Gallery() {
  const albumScroll = useRef(0); const authorOrigin = useRef({tab:'artists' as 'square'|'artists'|'albums'|'following',scroll:0,query:''}); const [authorDetail,setAuthorDetail]=useState<Artist | null>(null);
  const [openAlbumInfo, setOpenAlbumInfo] = useState<Album | null>(null); const [albumOffset, setAlbumOffset] = useState(1);
  const [tab, setTab] = useState<'square'|'artists'|'albums'|'following'>('square');
  const [followingArtists, setFollowingArtists] = useState<Artist[]>([]); const [followingMore, setFollowingMore] = useState(false); const [followingOffset, setFollowingOffset] = useState(1); const [remember, setRemember] = useState(() => !!localStorage.getItem(REMEMBER_KEY)); const [artists, setArtists] = useState<Artist[]>([]); const [albums, setAlbums] = useState<Album[]>([]);
  const [follows, setFollows] = useState<number[]>([]); const [actionBusy, setActionBusy] = useState(false);
  const [session, setSession] = useState<Session | null>(loadSession); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [loginOpen, setLoginOpen] = useState(false); const [loginMessage, setLoginMessage] = useState('');
  const [authorId, setAuthorId] = useState(''); const [filter, setFilter] = useState(initial); const [active, setActive] = useState(initial);
  const [items, setItems] = useState<GalleryInfo[]>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [more, setMore] = useState(true); const [start, setStart] = useState(1);
  const [favorites, setFavorites] = useState<GalleryInfo[]>([]);
  const [showFavorites, setShowFavorites] = useState(false); const [preview, setPreview] = useState<GalleryInfo | null>(null);
  const decoder = useRef(new PyodideDecoder()); const cache = useRef(new Map<number, { webp: Uint8Array; gif: Uint8Array; raw: Uint8Array }>()); const busy = useRef(false);
  useEffect(() => { localStorage.removeItem('divoom-local-login-v1'); }, []);
  const api = async (endpoint:string, body:Record<string,unknown>) => { const response = await fetch(`https://app.divoom-gz.com/${endpoint}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}); if (!response.ok) throw new Error(response.status === 429 ? '请求过于频繁，请稍后重试。' : `网络错误 ${response.status}`); const data = await response.json(); if (data.ReturnCode !== 0) throw new Error(`社区接口错误 ${data.ReturnCode}`); return data; };
  const cloud = async (endpoint:string, body:Record<string,unknown>, auth:Session) => api(endpoint,{...body, Token:auth.token, UserId:auth.userId});
  const syncAccount = async (auth:Session) => {
    const common = {StartNum:1,EndNum:100,Version:19,FileSize:127,FileType:5,FileSort:0,RefreshIndex:0,Classify:0};
    const [following, liked] = await Promise.all([cloud('GetFollowListV2',{StartNum:1,EndNum:100,Language:'en'},auth),cloud('GetMyLikeListV3',common,auth)]);
    setFollows((following.FollowList || []).map((x:{UserId:number}) => Number(x.UserId)));
    setFavorites(liked.FileList || []);
  };
  useEffect(() => { if (!session) { localStorage.removeItem(SESSION_KEY); return; } localStorage.setItem(SESSION_KEY, JSON.stringify(session)); void syncAccount(session).catch((e: Error) => { if (e.message.includes('错误 11')) { localStorage.removeItem(SESSION_KEY); const saved = JSON.parse(localStorage.getItem(REMEMBER_KEY) || 'null'); if (saved?.email && saved?.hash) { void login(saved.email, saved.hash).then(setSession).catch(() => { setSession(null); setError('自动登录失败，请重新登录。'); }); } else { setSession(null); setError('登录已过期，请重新登录。'); } } else setError('暂时无法获取账号关注和点赞列表，请检查网络。'); }); }, [session]);
  const loadFollowing = async (auth:Session, start = 1) => { setLoading(true); setError(''); try { const data = await cloud('GetFollowListV2',{StartNum:start,EndNum:start+29,Language:'en'},auth); const page:Artist[] = data.FollowList || []; setFollowingArtists(old => start === 1 ? page : [...old,...page.filter(x=>!old.some(y=>y.UserId===x.UserId))]); setFollowingOffset(start + page.length); setFollowingMore(page.length === 30); } catch(e) { setError(`关注列表加载失败：${(e as Error).message}`); } finally { setLoading(false); } };
  useEffect(() => { if (session) return; try { const saved = JSON.parse(localStorage.getItem(REMEMBER_KEY) || 'null'); if (saved?.email && saved?.hash) { void login(saved.email, saved.hash).then(setSession).catch(() => setLoginMessage('自动登录失败，请重新输入密码。')); } } catch { setLoginMessage('无法读取保存的登录信息。'); } }, []);
  const toggleFollow = async (id:number) => {
    if (!session) { setLoginOpen(true); setLoginMessage('请先登录点音账号。'); return; }
    if (actionBusy) return; setActionBusy(true); setError('');
    try { const info=await cloud('GetSomeoneInfoV2',{SomeOneUserId:id,Language:'en'},session); const next=Number(info.IsFollow) ? 0 : 1; await cloud('FollowExpertV2',{SomeOneUserId:id,IsFollow:next},session); const updated=await cloud('GetSomeoneInfoV2',{SomeOneUserId:id,Language:'en'},session); if (Number(updated.IsFollow)!==next) throw new Error('服务器未确认关注状态，请稍后重试。'); setFollows(old => next ? [...new Set([...old,id])] : old.filter(x=>x!==id)); if (!next) setFollowingArtists(old => old.filter(x=>x.UserId!==id)); }
    catch(e) { setError(`关注操作失败：${(e as Error).message}`); } finally { setActionBusy(false); }
  };
  const toggleFavorite = async (item:GalleryInfo) => {
    if (!session) { setLoginOpen(true); setLoginMessage('请先登录点音账号。'); return; }
    if (actionBusy) return; setActionBusy(true); setError('');
    try { const info=await cloud('Cloud/GalleryInfo',{GalleryId:item.GalleryId},session); const current=Number(info.IsLike ?? info.GalleryInfo?.IsLike ?? 0); const next=current ? 0 : 1; await cloud('GalleryLikeV2',{GalleryId:item.GalleryId,IsLike:next,Classify:item.Classify || 0,Type:0},session); const check=await cloud('Cloud/GalleryInfo',{GalleryId:item.GalleryId},session); const confirmed=check.IsLike ?? check.GalleryInfo?.IsLike; if (confirmed === undefined || Number(confirmed)!==next) throw new Error('服务器未确认点赞状态，请稍后重试。'); setFavorites(old => next ? [...old.filter(x=>x.GalleryId!==item.GalleryId),item] : old.filter(x=>x.GalleryId!==item.GalleryId)); }
    catch(e) { setError(`点赞操作失败：${(e as Error).message}`); } finally { setActionBusy(false); }
  };
  const loadDirectory = async (target:'artists'|'albums') => { setLoading(true); setError(''); try { const key = target === 'artists' ? 'ExpertList' : 'AlbumList'; const endpoint = target === 'artists' ? 'GetExpertListV4' : 'Discover/GetAlbumListV3'; const all = []; for (let start=1; start<=300; start+=30) { const data = await api(endpoint,{StartNum:start,EndNum:start+29,Language:'en',FileSize:127,FileSort:0}); const page = data[key] || []; all.push(...page); if(target === 'artists') setArtists([...all]); else setAlbums([...all]); if (page.length < 30) break; } if(target === 'artists') setArtists(all); else setAlbums(all); } catch(e) { setError((e as Error).message); } finally { setLoading(false); } };
  const albumPage = async (album:Album, offset:number) => { const data = await api('Discover/GetAlbumImageListV3',{AlbumId:album.AlbumId,StartNum:offset,EndNum:offset+29,Version:19,FileSize:127,FileType:5,FileSort:0,RefreshIndex:0}); return (data.FileList || []) as GalleryInfo[]; };
  const openAlbum = async (album:Album, offset=1, fromHistory=false) => { setLoading(true); setError(''); if (offset===1) { if (!fromHistory) { albumScroll.current = window.scrollY; history.replaceState({...history.state,view:'albums',scrollY:albumScroll.current},'',location.pathname + location.search); history.pushState({view:'album',album,scrollY:albumScroll.current},'',`#album=${album.AlbumId}`); } setOpenAlbumInfo(album); setItems([]); setShowFavorites(false); setTab('square'); window.scrollTo({top:0,behavior:'auto'}); } try { const page=await albumPage(album,offset); setItems(old => offset===1 ? page : [...old,...page.filter(x=>!old.some(y=>y.GalleryId===x.GalleryId))]); setAlbumOffset(offset+page.length); setMore(page.length===30); } catch(e) { setError((e as Error).message); } finally { setLoading(false); } };
  const returnToAlbums = () => { setOpenAlbumInfo(null); setTab('albums'); setError(''); requestAnimationFrame(() => window.scrollTo({top:albumScroll.current,behavior:'auto'})); };
  useEffect(() => {
    const navigate = () => {
      const state = history.state;
      if (state?.view === 'album' && state.album) { albumScroll.current=state.scrollY || 0; void openAlbum(state.album,1,true); }
      else if (state?.view === 'author' && state.artist) { authorOrigin.current=state.origin; void openAuthor(state.artist,true); }
      else if (state?.view === 'author-list') { authorOrigin.current=state.origin; returnFromAuthor(); }
      else { albumScroll.current=state?.scrollY ?? albumScroll.current; returnToAlbums(); }
    };
    window.addEventListener('popstate',navigate);
    return () => window.removeEventListener('popstate',navigate);
  }, []);


  const handleLogin = async () => { setLoginMessage('正在登录…'); try { const hash = SparkMD5.hash(password); const result = await login(email,hash); if (remember) localStorage.setItem(REMEMBER_KEY, JSON.stringify({email,hash})); else localStorage.removeItem(REMEMBER_KEY); setPassword(''); setSession(result); setLoginOpen(false); setLoginMessage('');  } catch(e) { setLoginMessage(`登录失败：${(e as Error).message}`); } };
  const load = async (f: Filter, offset: number, append = false) => {
    if (busy.current) return; busy.current = true; setLoading(true); setError('');
    try { const result = await list(f, offset); setItems(old => append ? [...old, ...result.filter(x => !old.some(y => y.GalleryId === x.GalleryId))] : result); setMore(result.length === 30); setStart(offset + result.length); setActive(f); setShowFavorites(false); }
    catch (e) { setError((e as Error).message || '网络请求失败，请检查网络连接。'); }
    finally { busy.current = false; setLoading(false); }
  };
  useEffect(() => { void load(initial, 1); }, []);
  const visible = showFavorites ? favorites : items;
  const download = async (item: GalleryInfo, format: 'webp'|'gif'|'dat') => { try { let data = cache.current.get(item.GalleryId); if (!data) { const raw = await downloadBinary(item.FileId); const bean = await decoder.current.decode(raw); data = {raw, webp:bean.webp, gif:bean.gif}; cache.current.set(item.GalleryId, data); } save(dataBlob(format === 'dat' ? data.raw : data[format], format === 'webp' ? 'image/webp' : format === 'gif' ? 'image/gif' : 'application/octet-stream'), `${fileName(item)}.${format}`); } catch(e) { setError(`下载失败：${(e as Error).message}`); } };
  const returnFromAuthor = () => { setAuthorDetail(null); setTab(authorOrigin.current.tab); setFilter(old=>({...old,query:authorOrigin.current.query})); setError(''); requestAnimationFrame(()=>window.scrollTo({top:authorOrigin.current.scroll,behavior:'auto'})); };
  const openAuthor = async (artist:Artist, fromHistory=false) => {
    if (!fromHistory) { authorOrigin.current={tab,scroll:window.scrollY,query:filter.query}; history.replaceState({view:'author-list',origin:authorOrigin.current},'',location.pathname+location.search); history.pushState({view:'author',artist,origin:authorOrigin.current},'',`#author=${artist.UserId}`); }
    setOpenAlbumInfo(null); setAuthorDetail(artist); setShowFavorites(false); setTab('square'); setItems([]); window.scrollTo({top:0,behavior:'auto'});
    const next={...initial,author:artist.UserId,authorName:artist.NickName}; setFilter(next); await load(next,1);
  };
  const author = (item:GalleryInfo) => { if(item.UserId) void openAuthor({UserId:Number(item.UserId),NickName:String(item.UserName || item.UserId),HeadId:String(item.UserHeaderId || ''),FansCnt:0,FileList:[]}); };

  return <main className="gallery"><header><div><p className="eyebrow">DIVOOM COMMUNITY</p><h1>像素画廊</h1><p>发现社区里的像素灵感 · 无需登录</p></div><div className="header-actions">{session && <button onClick={() => { setTab('square'); setShowFavorites(!showFavorites); }}>{showFavorites ? '返回社区' : `我的点赞 ${favorites.length}`}</button>}{session && <button onClick={() => { if (!session) {setLoginOpen(true); setLoginMessage('请先登录点音账号。'); return;} setTab('following'); setShowFavorites(false); setFilter(initial); void loadFollowing(session); }}>我的关注</button>}<button onClick={() => setLoginOpen(true)}>{session ? `已登录 ${session.email}` : '登录'}</button></div></header><nav className="tabs">{([['square','广场'],['artists','达人'],['albums','合辑']] as const).map(([id,label]) => <button key={id} className={(authorDetail ? id === 'artists' : openAlbumInfo ? id === 'albums' : tab === id) ? 'active' : ''} onClick={() => { setTab(id); setAuthorDetail(null); setOpenAlbumInfo(null); setShowFavorites(false); setError(''); if(id === 'square') void load(initial,1); if(id !== 'square' && !(id === 'artists' ? artists.length : albums.length)) void loadDirectory(id); }}>{label}</button>)}</nav>
    {authorDetail && <div className="album-backbar"><button onClick={()=>history.state?.view === 'author' ? history.back() : returnFromAuthor()}>← 返回{authorOrigin.current.tab === 'following' ? '我的关注' : '达人列表'}</button><div className="artist-avatar">{authorDetail.HeadId && <LazyArt item={{GalleryId:-authorDetail.UserId,FileId:authorDetail.HeadId} as GalleryInfo} decoder={decoder.current}/>}</div><strong>{authorDetail.NickName}</strong><button disabled={actionBusy} onClick={()=>void toggleFollow(authorDetail.UserId)}>{follows.includes(authorDetail.UserId) ? '已关注' : '关注'}</button></div>}
    {openAlbumInfo && <div className="album-backbar"><button onClick={() => history.state?.view === 'album' ? history.back() : returnToAlbums()}>← 返回合辑列表</button><strong>{openAlbumInfo.AlbumName}</strong></div>}
    {tab === 'square' && !showFavorites && !openAlbumInfo && !authorDetail && <nav className="category-tabs" aria-label="广场分类">{categories.map(([id,name]) => <button key={id} className={active.category === id && !active.author && !active.query ? 'active' : ''} disabled={loading} onClick={() => { const next = {...filter, category:id, query:'', author:null, authorName:''}; setFilter(next); setAuthorId(''); void load(next, 1); }}>{name}</button>)}</nav>}
    {!openAlbumInfo && !authorDetail && <section className="filters"><input aria-label="搜索作品" placeholder="搜索当前标签的名称" value={filter.query} onChange={e => setFilter({...filter, query:e.target.value, author:null})} onKeyDown={e => {if(e.key === 'Enter' && tab === 'square') void load({...filter,author:null},1);}} />
      {tab === 'square' && <><input aria-label="作者 ID" placeholder="作者 ID（可选）" inputMode="numeric" value={authorId} onChange={e => setAuthorId(e.target.value.replace(/\D/g, ''))} />
      <select aria-label="尺寸" value={filter.size} onChange={e => setFilter({...filter,size:Number(e.target.value)})}><option value={127}>全部尺寸</option><option value={1}>16 × 16</option><option value={2}>32 × 32</option><option value={4}>64 × 64</option><option value={16}>128 × 128</option><option value={32}>256 × 256</option></select>
      <select aria-label="类型" value={filter.type} onChange={e => setFilter({...filter,type:Number(e.target.value)})}><option value={5}>全部类型</option><option value={0}>静态</option><option value={1}>动画</option></select>
      <select aria-label="排序" value={filter.sort} onChange={e => setFilter({...filter,sort:Number(e.target.value)})}><option value={0}>最新</option><option value={1}>热门</option></select><button disabled={loading} onClick={() => void load(authorId ? {...filter, author:Number(authorId), authorName:authorId, query:''} : filter,1)}>搜索 / 应用</button></>}</section>}
    {tab !== 'square' && error && <p role="alert" className="gallery-error">{error}</p>}{tab !== 'square' && loading && <p>正在加载，请稍候…</p>}
    {(tab === 'artists' || tab === 'following') && <><div className="toolbar">{tab === 'following' ? '我的关注' : '达人'} · {(tab === 'following' ? followingArtists : artists).filter(x => x.NickName?.toLowerCase().includes(filter.query.toLowerCase())).length} 位 </div><section className="directory">{(tab === 'following' ? followingArtists : artists).filter(x => x.NickName?.toLowerCase().includes(filter.query.toLowerCase())).map(a => <article className="directory-card" key={a.UserId}><div className="directory-head"><div className="artist-avatar">{a.HeadId ? <LazyArt item={{GalleryId:-a.UserId,FileId:a.HeadId} as GalleryInfo} decoder={decoder.current} fallback={a.NickName?.slice(0,1) || "?"}/> : <span>{a.NickName?.slice(0,1) || "?"}</span>}</div><div><h3>{a.NickName}</h3><p>{a.FansCnt || 0} 粉丝</p></div></div><button onClick={() => void toggleFollow(a.UserId)}>{follows.includes(a.UserId) ? '已关注' : '关注'}</button><button className="preview-strip preview-entry" aria-label={`查看 ${a.NickName} 的作品`} onClick={() => void openAuthor(a)}>{(a.FileList || []).slice(0,3).map(art => <span key={art.GalleryId} className="preview-tile"><LazyArt item={art} decoder={decoder.current}/></span>)}</button></article>)}</section>{tab === 'following' && !loading && followingArtists.length === 0 && <p>还没有关注的作者。</p>}{tab === 'following' && followingMore && session && <button className="more" disabled={loading} onClick={() => void loadFollowing(session, followingOffset)}>加载更多关注</button>}</>}
    {tab === 'albums' && <><div className="toolbar">合辑 · {albums.filter(x => x.AlbumName?.toLowerCase().includes(filter.query.toLowerCase())).length} 个</div><section className="directory">{albums.filter(x => x.AlbumName?.toLowerCase().includes(filter.query.toLowerCase())).map(a => <article className="directory-card" key={a.AlbumId}><img className="album-cover" crossOrigin="anonymous" src={`https://f.divoom-gz.com/${a.AlbumImageId}`} alt=""/><div><h3>{a.AlbumName}</h3><p>{a.GalleryCnt} 件作品</p></div><button className="preview-strip preview-entry" aria-label={`查看合辑 ${a.AlbumName}`} onClick={() => void openAlbum(a)}>{(a.GalleryList || []).slice(0,3).map(art => <span key={art.GalleryId} className="preview-tile"><LazyArt item={art} decoder={decoder.current}/></span>)}</button></article>)}</section></>}
    {tab === 'square' && <><div className="toolbar"><span>{openAlbumInfo ? `合辑：${openAlbumInfo.AlbumName}` : showFavorites ? '我的点赞' : active.author ? `创作者：${active.authorName}` : active.query ? `搜索：${active.query}` : '社区作品'} · {visible.length} 件</span><div>{active.author && !authorDetail && !showFavorites && !openAlbumInfo && <button onClick={() => { setFilter(initial); void load(initial,1); }}>返回社区</button>}</div></div>
    {error && <p role="alert" className="gallery-error">{error}</p>}{loading && <p>正在加载，请稍候…</p>}{!loading && !visible.length && <p>{openAlbumInfo ? '该合辑暂无作品。' : '暂无作品。尝试调整搜索条件。'}</p>}
    <section className="art-grid">{visible.map(item => <article key={item.GalleryId} className="art-card"><button className="art-image" onClick={() => setPreview(item)} aria-label={`查看 ${item.FileName}`}><LazyArt item={item} decoder={decoder.current} alt={item.FileName || '像素画'} fallback="正在加载预览…"/></button><div className="art-info"><strong title={item.FileName}>{item.FileName || '未命名'}</strong><button className="author" disabled={!item.UserId} onClick={() => author(item)}>{item.UserName || '未知作者'}</button><div className="art-actions"><span className="like-count">♥ {item.LikeCnt || 0}</span><button className={`follow-icon ${follows.includes(Number(item.UserId)) ? 'is-following' : ''}`} disabled={actionBusy || !item.UserId} aria-label={follows.includes(Number(item.UserId)) ? '取消关注作者' : '关注作者'} title={follows.includes(Number(item.UserId)) ? '取消关注作者' : '关注作者'} onClick={() => void toggleFollow(Number(item.UserId))}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 19v-1.1a5.5 5.5 0 0 1 11 0V19"/>{follows.includes(Number(item.UserId)) ? <path d="m16 12 2 2 3-3"/> : <path d="M18 10v6m-3-3h6"/>}</svg></button><button disabled={actionBusy} className="favorite-icon" aria-label={favorites.some(x=>x.GalleryId===item.GalleryId) ? "取消点赞" : "点赞"} title={favorites.some(x=>x.GalleryId===item.GalleryId) ? "取消点赞" : "点赞"} onClick={() => toggleFavorite(item)}><svg viewBox="0 0 24 24" aria-hidden="true" fill={favorites.some(x=>x.GalleryId===item.GalleryId) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg></button></div></div></article>)}</section>
    {!showFavorites && more && <button className="more" disabled={loading} onClick={() => void (openAlbumInfo ? openAlbum(openAlbumInfo,albumOffset) : load(active,start,true))}>加载更多</button>}
    </>}{loginOpen && <div className="modal" onClick={() => setLoginOpen(false)}><div className="modal-card login-card" onClick={e => e.stopPropagation()}><button className="close" onClick={() => setLoginOpen(false)}>关闭 ✕</button><h2>点音账号</h2>{session ? <><p>已登录 {session.email}</p><button onClick={() => {localStorage.removeItem(REMEMBER_KEY); localStorage.removeItem(SESSION_KEY); setRemember(false); setSession(null); setFollows([]); setFollowingArtists([]); setFavorites([]); setShowFavorites(false); setLoginOpen(false);}}>退出登录</button></> : <><input autoComplete="username" aria-label="账号" placeholder="邮箱或手机号" value={email} onChange={e => setEmail(e.target.value)}/><input autoComplete="current-password" aria-label="密码" type="password" placeholder="密码" value={password} onChange={e => setPassword(e.target.value)}/><label className="remember-login"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)}/> 记住密码并自动登录</label><p>勾选后，本浏览器会保存可用于登录的密码哈希；退出登录会清除。</p><button onClick={() => void handleLogin()}>登录</button><p>{loginMessage}</p></>}</div></div>}{preview && <div className="modal" onClick={() => setPreview(null)}><div className="modal-card" onClick={e => e.stopPropagation()}><button className="close" onClick={() => setPreview(null)}>关闭 ✕</button><div className="modal-preview"><LazyArt item={preview} decoder={decoder.current} alt={preview.FileName}/></div><h2>{preview.FileName || '未命名'}</h2><p>作者：<button className="author" onClick={() => { author(preview); setPreview(null); }}>{preview.UserName || '未知作者'}</button> · ♥ {preview.LikeCnt || 0}</p>{error && <p role="alert" className="gallery-error">{error}</p>}<div className="modal-actions"><button disabled={actionBusy || !preview.UserId} onClick={() => void toggleFollow(Number(preview.UserId))}>{follows.includes(Number(preview.UserId)) ? '已关注作者' : '关注作者'}</button><button onClick={() => toggleFavorite(preview)}>{favorites.some(x=>x.GalleryId===preview.GalleryId) ? '取消点赞' : '点赞'}</button>{(['webp','gif','dat'] as const).map(f=><button key={f} onClick={() => void download(preview,f)}>下载 {f.toUpperCase()}</button>)}</div></div></div>}
    <footer>作品来自 Divoom 社区，版权属于原作者。达人与合辑名称搜索仅覆盖已加载的前 300 项。</footer></main>;
}
