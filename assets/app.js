/* Номенклатура ночи — автономная читалка. Без фреймворков и вложенного скролла. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const baseChapters = [
    {id:1,title:'Человек, которого я жду',description:'Дождливый город, партия в сянци и встреча, которой ждал Цин Чэнь.',state:'ready',pages:[]},
    {id:2,title:'Обратный отсчёт',description:'Незнакомые цифры на коже и подготовка к неизвестному.',state:'ready',pages:[]},
    {id:3,title:'Разрушенный мир',description:'Время останавливается, а реальность больше не подчиняется прежним правилам.',state:'preview',pages:[]},
    {id:4,title:'Больше одного',description:'Тюремный бастион, механические охранники и первые признаки чужого мира.',state:'ready',pages:[]},
    {id:5,title:'Трансцендентный статус',description:'Странный человек в белом, доска сянци и неожиданная тишина.',state:'preview',pages:[]}
  ];
  const defaultPrefs = {theme:'dark',width:'standard',gap:'0'};
  const PREF_KEY = 'nn-reader-prefs-v1';
  const PROGRESS_KEY = 'nn-reader-progress-v1';
  const DB_NAME = 'nn-manhwa-storage';
  let chapters = baseChapters.map((c) => ({...c}));
  let localChapters = new Map();
  let prefs = {...defaultPrefs};
  let activeChapter = null;
  let dbPromise = null;
  let readerUrls = [];
  let coverUrls = [];
  let currentPages = 0;
  let toastTimer = null;
  let saveTimer = null;
  let restoreRatio = null;
  let importing = false;

  function notify(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 3700);
  }
  function readJSON(key, fallback) {
    try { const data = localStorage.getItem(key); return data ? JSON.parse(data) : fallback; }
    catch (_) { return fallback; }
  }
  function saveJSON(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} }
  function applyPrefs() {
    document.body.dataset.theme = prefs.theme;
    const ps = $('pageStack');
    ps.classList.toggle('width-wide', prefs.width === 'wide');
    ps.classList.toggle('width-edge', prefs.width === 'edge');
    ps.style.gap = (Number(prefs.gap) || 0) + 'px';
    $('themeChoice').value = prefs.theme;
    $('widthChoice').value = prefs.width;
    $('gapChoice').value = prefs.gap;
  }
  function openDB() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB не поддерживается'));
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('pages')) {
            const pages = db.createObjectStore('pages', {keyPath:'id'});
            pages.createIndex('chapter','chapter',{unique:false});
          }
          if (!db.objectStoreNames.contains('chapters')) db.createObjectStore('chapters', {keyPath:'id'});
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Ошибка хранилища'));
      }).catch((e) => { dbPromise = null; throw e; });
    }
    return dbPromise;
  }
  async function getStoredChapters() {
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const req = db.transaction('chapters','readonly').objectStore('chapters').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (_) { return []; }
  }
  async function getPage(chapter, number) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('pages','readonly').objectStore('pages').get(chapter + ':' + number);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  async function putPage(chapter, number, blob) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('pages','readwrite');
      transaction.objectStore('pages').put({id:chapter + ':' + number,chapter,number,blob});
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }
  async function putMeta(data) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('chapters','readwrite');
      transaction.objectStore('chapters').put(data);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }
  async function deleteLocalChapter(id) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tr = db.transaction(['pages','chapters'],'readwrite');
      const keys = tr.objectStore('pages').index('chapter').openKeyCursor(IDBKeyRange.only(id));
      keys.onsuccess = () => { const c = keys.result; if (c) { tr.objectStore('pages').delete(c.primaryKey); c.continue(); } };
      tr.objectStore('chapters').delete(id);
      tr.oncomplete = () => resolve();
      tr.onerror = () => reject(tr.error);
    });
  }
  function getChapter(id) { return chapters.find((c) => c.id === Number(id)); }
  function chapterCount(id) { const local = localChapters.get(id); const meta = getChapter(id); return local ? local.count : (meta?.pages?.length || 0); }
  function stateText(chapter) {
    if (localChapters.has(chapter.id)) return 'Сохранена в браузере';
    if (chapter.pages.length) return chapter.state === 'preview' ? 'Предпросмотр' : 'Доступна онлайн';
    return chapter.state === 'preview' ? 'На доработке' : 'Ожидает загрузки';
  }
  function removeCoverUrls() { coverUrls.forEach((url) => URL.revokeObjectURL(url)); coverUrls=[]; }
  function removeReaderUrls() { readerUrls.forEach((url) => URL.revokeObjectURL(url)); readerUrls=[]; }

  async function renderLibrary() {
    removeCoverUrls();
    const grid = $('chapterGrid');
    grid.replaceChildren();
    const available = chapters.filter((c) => chapterCount(c.id) > 0).length;
    $('librarySummary').textContent = available + ' из ' + chapters.length + ' глав доступны в этой читалке';
    const progress = readJSON(PROGRESS_KEY, null);
    const last = progress && getChapter(progress.chapter) && chapterCount(progress.chapter) > 0 ? progress.chapter : null;
    $('resumeBtn').innerHTML = last ? 'Продолжить главу ' + last + ' <span>↗</span>' : 'Начать чтение <span>↗</span>';
    chapters.forEach((chapter) => {
      const count = chapterCount(chapter.id);
      const card = document.createElement('article'); card.className = 'chapter-card';
      const cover = document.createElement('div'); cover.className = 'chapter-cover';
      const fallback = document.createElement('span'); fallback.className = 'cover-fallback'; fallback.textContent = String(chapter.id).padStart(2,'0');
      cover.appendChild(fallback);
      const num = document.createElement('span'); num.className = 'chapter-number'; num.textContent = 'ГЛАВА ' + String(chapter.id).padStart(2,'0'); cover.appendChild(num);
      const body = document.createElement('div'); body.className = 'chapter-card-body';
      const title = document.createElement('h3'); title.textContent = chapter.title;
      const desc = document.createElement('p'); desc.textContent = chapter.description || '';
      const foot = document.createElement('div'); foot.className = 'chapter-foot';
      const status = document.createElement('span'); status.className = 'chapter-status' + (chapter.state==='preview'?' preview':''); status.textContent = stateText(chapter);
      const action = document.createElement('button'); action.className = 'chapter-open'; action.type = 'button'; action.textContent = count ? 'Читать ↗' : 'Добавить ↗';
      action.addEventListener('click', () => { if (count) openChapter(chapter.id); else showImport(chapter.id); });
      foot.append(status,action); body.append(title,desc,foot); card.append(cover,body); grid.appendChild(card);
      const local = localChapters.get(chapter.id);
      if (local) {
        getPage(chapter.id,1).then((pg) => { if (!pg || !card.isConnected) return; const url = URL.createObjectURL(pg.blob); coverUrls.push(url); attachCover(cover,url); }).catch(() => {});
      } else if (chapter.pages.length) attachCover(cover,chapter.pages[0].src);
    });
  }
  function attachCover(cover,src) {
    const img = document.createElement('img'); img.alt='';img.loading='lazy';img.src=src;
    img.onload=()=>{ if(cover.isConnected){ const fb=cover.querySelector('.cover-fallback'); if(fb) fb.remove(); } };
    img.onerror=()=>img.remove();
    cover.insertBefore(img,cover.firstChild);
  }
  function setView(showReader) {
    $('readerView').hidden = !showReader;
    $('libraryView').hidden = showReader;
    $('readingLine').style.width='0';
  }
  function setURL(id,replace) {
    if (location.protocol === 'file:') return;
    const url = new URL(location.href);
    if(id){url.searchParams.set('chapter',id);} else {url.searchParams.delete('chapter');}
    history[replace ? 'replaceState':'pushState']({chapter:id||null},'',url.pathname+url.search+url.hash);
  }
  async function openChapter(id, {resume=false,updateURL=true}={}) {
    const chapter = getChapter(id);
    if (!chapter) {notify('Такой главы пока нет');return;}
    activeChapter=id;
    removeReaderUrls();
    setView(true);
    $('readerHeading').textContent='Глава '+id+'. '+chapter.title;
    $('readerInfo').textContent=stateText(chapter)+' · '+chapterCount(id)+' стр.';
    $('pageStack').replaceChildren();
    $('readerStatus').hidden=true;
    $('readerEnd').hidden=true;
    if (updateURL) setURL(id,false);
    window.scrollTo({top:0,behavior:'instant'});
    const local = localChapters.get(id);
    const pageData=[];
    if(local){
      for(let i=1;i<=local.count;i++){
        const pg=await getPage(id,i).catch(()=>null);
        if(pg){const url=URL.createObjectURL(pg.blob);readerUrls.push(url);pageData.push({src:url});}
      }
    } else if(chapter.pages?.length){pageData.push(...chapter.pages);}
    if(activeChapter!==id) return;
    currentPages=pageData.length;
    if(!pageData.length){
      const status=$('readerStatus');status.hidden=false;
      status.replaceChildren();
      const strong=document.createElement('strong');strong.textContent='Иллюстрации пока не загружены';
      const paragraph=document.createElement('p');paragraph.textContent='Файлы этой главы ещё не опубликованы в репозитории. Можно добавить ZIP/CBZ из своей коллекции, и она сохранится в браузере.';
      const btn=document.createElement('button');btn.className='primary-btn';btn.textContent='Загрузить главу';btn.onclick=()=>showImport(id);
      status.append(strong,paragraph,btn);
      return;
    }
    const stack=$('pageStack');
    pageData.forEach((page,i)=>{
      const wrap=document.createElement('figure');wrap.className='comic-page';wrap.setAttribute('aria-label','Страница '+(i+1));
      const image=document.createElement('img');image.alt='Глава '+id+', страница '+(i+1);image.loading=i<2?'eager':'lazy';image.decoding='async';
      if(page.width && page.height){image.width=page.width;image.height=page.height;}else {image.width=900;image.height=1600;}
      image.src=page.src;
      image.onerror=()=>{
        image.remove();const placeholder=document.createElement('div');placeholder.className='comic-page-error';
        placeholder.textContent='Не удалось открыть страницу '+(i+1)+'. Проверь соединение или импортируй архив главы.';wrap.append(placeholder);
      };
      wrap.append(image);stack.append(wrap);
    });
    $('readerEnd').hidden=false;
    $('endHeading').textContent='Глава '+id+' завершена';
    const prev=chapters.filter((c)=>c.id<id && chapterCount(c.id)>0).at(-1);
    const next=chapters.find((c)=>c.id>id && chapterCount(c.id)>0);
    $('prevChapter').disabled=!prev;
    $('nextChapter').disabled=!next;
    $('prevChapter').onclick=()=>prev&&openChapter(prev.id);
    $('nextChapter').onclick=()=>next&&openChapter(next.id);
    const saved=readJSON(PROGRESS_KEY,null);
    restoreRatio=resume&&saved&&saved.chapter===id?saved.ratio:null;
    if(restoreRatio!==null){
      const restore=()=>{
        if(activeChapter!==id || restoreRatio===null)return;
        const rect=stack.getBoundingClientRect();const top=window.scrollY+rect.top;
        window.scrollTo({top:Math.round(top+Math.max(0,stack.offsetHeight-window.innerHeight)*restoreRatio),behavior:'instant'});
        restoreRatio=null;
      };
      requestAnimationFrame(()=>requestAnimationFrame(restore));
    }
    updateReadingLine();
  }
  function updateReadingLine(){
    if(activeChapter===null || $('readerView').hidden){$('readingLine').style.width='0';return;}
    const stack=$('pageStack');const top=stack.getBoundingClientRect().top+scrollY;
    const total=Math.max(1,stack.offsetHeight-innerHeight);const ratio=Math.max(0,Math.min(1,(scrollY-top)/total));
    $('readingLine').style.width=(ratio*100).toFixed(2)+'%';
    clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveJSON(PROGRESS_KEY,{chapter:activeChapter,ratio,updated:Date.now()}),260);
  }
  function showLibrary({updateURL=true}={}){
    activeChapter=null; removeReaderUrls();setView(false);
    if(updateURL)setURL(null,false);
    renderLibrary();window.scrollTo({top:0,behavior:'instant'});
  }
  function showImport(chapterId){
    if(chapterId)$('chapterSelect').value=String(chapterId);
    $('importProgress').hidden=true;$('zipInput').value='';
    const d=$('importDialog');if(!d.open)d.showModal();
  }
  function guessChapter(filename){
    const matches=filename.match(/(?:chapter|glava|глава|ch)[\s_.-]*0*(\d{1,3})/i);
    if(matches)return Number(matches[1]);
    return Number($('chapterSelect').value)||1;
  }
  async function importArchive(file){
    if(typeof JSZip==='undefined') throw new Error('Библиотека ZIP ещё не загрузилась. Проверь подключение к интернету.');
    const id=guessChapter(file.name);
    if(id<1||id>100)throw new Error('Недопустимый номер главы');
    const zip=await JSZip.loadAsync(file,{checkCRC32:false});
    const candidates=new Map();
    const preference={webp:4,avif:3,jpg:2,jpeg:2,png:1};
    for(const [path,item] of Object.entries(zip.files)){
      if(item.dir||path.startsWith('__MACOSX/')||/thumb|preview|cover|\.DS_Store/i.test(path))continue;
      const name=path.split('/').pop();const match=name.match(/^(\d{1,4})\.(png|jpe?g|webp|avif)$/i);
      if(!match)continue;
      const pageNumber=Number(match[1]);const extension=match[2].toLowerCase();
      const old=candidates.get(pageNumber);
      if(!old||preference[extension]>preference[old.extension])candidates.set(pageNumber,{entry:item,extension});
    }
    const sorted=[...candidates.entries()].sort((a,b)=>a[0]-b[0]);
    if(!sorted.length)throw new Error('В архиве не найдены изображения с именами 01.png, 02.webp и т. д.');
    if(sorted.length>150)throw new Error('Слишком много страниц в одном архиве');
    const updateProgress=(fraction,msg)=>{
      $('importProgress').hidden=false;$('importProgressFill').style.width=(fraction*100).toFixed(1)+'%';$('importProgressText').textContent=msg;
    };
    const payload=[];let size=0;
    for(let i=0;i<sorted.length;i++){
      updateProgress((i+0.25)/sorted.length,'Подготовка страницы '+(i+1)+' из '+sorted.length);
      const {entry,extension}=sorted[i][1];const blob=await entry.async('blob');size+=blob.size;
      if(size>180*1024*1024)throw new Error('Объём распакованных файлов слишком велик');
      payload.push(new Blob([blob],{type:extension==='jpg'?'image/jpeg':'image/'+extension}));
    }
    if(localChapters.has(id))await deleteLocalChapter(id);
    for(let i=0;i<payload.length;i++){
      await putPage(id,i+1,payload[i]);
      updateProgress((i+1)/payload.length,'Сохранено '+(i+1)+' из '+payload.length);
    }
    const meta={id,count:payload.length,sourceName:file.name,updated:Date.now()};
    await putMeta(meta);localChapters.set(id,meta);
    if(!getChapter(id)){
      chapters.push({id,title:'Глава '+id,description:'Импортирована из архива',state:'ready',pages:[]});
      chapters.sort((a,b)=>a.id-b.id);
    }
    return {id,count:payload.length};
  }
  async function onFiles(files){
    if(importing)return;
    const chosen=[...files].filter((file)=>/\.(zip|cbz)$/i.test(file.name));
    if(!chosen.length){notify('Выбери файл .zip или .cbz');return;}
    importing=true;let imported=[];
    try{
      for(let i=0;i<chosen.length;i++){
        $('importProgress').hidden=false;
        $('importProgressText').textContent='Архив '+(i+1)+' из '+chosen.length+': '+chosen[i].name;
        imported.push(await importArchive(chosen[i]));
      }
      $('importDialog').close();
      notify('Готово: '+imported.map((x)=>'глава '+x.id+' ('+x.count+' стр.)').join(', '));
      renderLibrary();
      if(imported.length===1)await openChapter(imported[0].id);
    }catch(e){notify('Не удалось импортировать: '+(e.message||e));}
    finally{importing=false;$('zipInput').value='';}
  }
  async function boot(){
    prefs={...defaultPrefs,...readJSON(PREF_KEY,{})};applyPrefs();
    for(let id=1;id<=100;id++){
      const opt=document.createElement('option');opt.value=String(id);opt.textContent='Глава '+id;$('chapterSelect').appendChild(opt);
    }
    // Встроенный каталог: главы открываются даже из распакованной папки без сервера.
    const embedded=$('embeddedCatalog');
    if(embedded){
      try{
        const data=JSON.parse(embedded.textContent);
        if(Array.isArray(data.chapters)){
          const byId=new Map(baseChapters.map((c)=>[c.id,c]));
          data.chapters.forEach((c)=>byId.set(c.id,{...(byId.get(c.id)||{}),...c}));
          chapters=[...byId.values()].sort((a,b)=>a.id-b.id);
        }
      }catch(_){}
    }
    try{
      const response=await fetch('data/catalog.json',{cache:'no-store'});
      if(response.ok){const catalog=await response.json();if(Array.isArray(catalog.chapters)){
        const byId=new Map(baseChapters.map((c)=>[c.id,c]));
        catalog.chapters.forEach((c)=>byId.set(c.id,{...(byId.get(c.id)||{}),...c}));
        chapters=[...byId.values()].sort((a,b)=>a.id-b.id);
      }}
    }catch(_){ /* Offline fallback */ }
    const stored=await getStoredChapters();stored.forEach((meta)=>localChapters.set(meta.id,meta));
    stored.forEach((meta)=>{if(!getChapter(meta.id))chapters.push({id:meta.id,title:'Глава '+meta.id,description:'Локально сохранённая глава',state:'ready',pages:[]});});
    chapters.sort((a,b)=>a.id-b.id);
    await renderLibrary();
    const params=new URLSearchParams(location.search);const selected=Number(params.get('chapter'));
    if(selected&&getChapter(selected))await openChapter(selected,{updateURL:false});
    $('libraryBtn').onclick=()=>showLibrary();$('homeLink').onclick=(event)=>{event.preventDefault();showLibrary();};
    $('readerBackBtn').onclick=()=>showLibrary();
    for(const id of ['importBtn','heroImportBtn','noteImportBtn'])$(id).onclick=()=>showImport();
    $('resumeBtn').onclick=()=>{
      const last=readJSON(PROGRESS_KEY,null);const target=last&&chapterCount(last.chapter)>0?last.chapter:chapters.find((c)=>chapterCount(c.id)>0)?.id;
      if(target)openChapter(target,{resume:!!last&&last.chapter===target});else showImport(1);
    };
    $('importClose').onclick=()=>$('importDialog').close();
    $('settingsBtn').onclick=()=>$('settingsDialog').showModal();
    $('settingsClose').onclick=()=>$('settingsDialog').close();
    for(const [id,key] of [['themeChoice','theme'],['widthChoice','width'],['gapChoice','gap']]){
      $(id).addEventListener('change',(event)=>{prefs[key]=event.target.value;saveJSON(PREF_KEY,prefs);applyPrefs();});
    }
    $('zipInput').addEventListener('change',(e)=>onFiles(e.target.files));
    const drop=$('dropbox');
    drop.addEventListener('dragover',(e)=>{e.preventDefault();drop.classList.add('dragover');});
    drop.addEventListener('dragleave',()=>drop.classList.remove('dragover'));
    drop.addEventListener('drop',(e)=>{e.preventDefault();drop.classList.remove('dragover');onFiles(e.dataTransfer.files);});
    window.addEventListener('popstate',async()=>{
      const selected=Number(new URLSearchParams(location.search).get('chapter'));
      if(selected&&getChapter(selected))await openChapter(selected,{updateURL:false});else showLibrary({updateURL:false});
    });
    window.addEventListener('scroll',updateReadingLine,{passive:true});
    window.addEventListener('resize',updateReadingLine,{passive:true});
    window.addEventListener('pagehide',()=>{
      if(activeChapter!==null){const stack=$('pageStack');const top=stack.getBoundingClientRect().top+scrollY;const ratio=Math.max(0,Math.min(1,(scrollY-top)/Math.max(1,stack.offsetHeight-innerHeight)));saveJSON(PROGRESS_KEY,{chapter:activeChapter,ratio,updated:Date.now()});}
    });
    if('serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
  boot().catch((err)=>notify('Ошибка запуска читалки: '+(err.message||err)));
})();