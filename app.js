'use strict';
const $ = id => document.getElementById(id);
const STYLE_KEY = 'lecture-note-style-v1';
let styles = [], chat = [], recording = false, starting = false, stopping = false;
let generating = false, chatting = false;
let elapsed = 0, customTitle = false;
let confirmedTranscript = '';
let browserWorkspace = null;
let activeLecture = null, lectureRevision = 0, loading = true, staleNotes = false;
let changeVersion = 0, savedVersion = 0, saveTimer, savePromise, notesURL;
const LAST_LECTURE = 'lecture-active-v1';
const fileCache = new WeakMap();
const LIMIT = 2 * 60 * 60 * 1000;
for (const id of ['slides', 'transcripts', 'styles']) {
  $('choose-' + id).onclick = () => $(id).click();
}

$('notes-upload-pdf').onclick = () => $('slides').click();
$('notes-upload-transcript').onclick = () => $('transcripts').click();

function notice(message) {
  if (message) console.warn(message);
}
function transcriptText() {
  return recording || starting || stopping ? confirmedTranscript : $('live').value;
}
function hasSources() {
  return Boolean($('slides').files.length || $('transcripts').files.length || transcriptText().trim());
}
function hasChatContext() {
  return hasSources() || (!staleNotes && Boolean($('notes-editor').value.trim()));
}
function refresh() {
  const unavailable = loading || !activeLecture;
  $('pdf-uploaded').hidden = !$('slides').files.length;
  $('transcript-uploaded').hidden = !$('transcripts').files.length;
  $('notes-upload-pdf').disabled = unavailable || generating;
  $('notes-upload-transcript').disabled = unavailable || generating;
  const pending = stopping;
  const busy = recording || starting || pending;
  $('generate').hidden = busy;
  $('generate').disabled = unavailable || generating || chatting || !hasSources();
  $('generate').textContent = $('notes-editor').value.trim() ? 'Regenerate notes' : 'Generate notes';
  
  $('record').disabled = unavailable || stopping || generating || elapsed >= LIMIT;
  $('record-from-materials').disabled = unavailable || busy || generating || elapsed >= LIMIT;
  $('materials-record-status').textContent = $('timer').textContent;
  $('record').textContent = starting ? 'Cancel recording' : recording ? 'Stop recording' : 'Start recording';
  $('record').classList.toggle('is-recording', starting || recording);
  $('live').readOnly = unavailable || busy || generating;
  $('download-transcript').disabled = !$('live').value.trim();
  $('ask').classList.toggle('loading', chatting);
  $('ask').setAttribute('aria-busy', String(chatting));
  $('ask').setAttribute('aria-label', chatting ? 'Waiting for response' : 'Send message');
  $('ask').title = chatting ? 'Waiting for response' : 'Send message';
  $('ask').disabled = unavailable || chatting || generating || chat.length >= 200 || !hasChatContext();
  $('question').disabled = unavailable || chatting || generating || !hasChatContext();
  $('question').placeholder = 'Ask a question…';
  if ($('chat-empty')) $('chat-empty').textContent = hasChatContext() ? 'Ask about your lecture materials or notes.' : 'Add slides or a transcript to get started.';
  for (const id of ['slides', 'transcripts', 'styles', 'important']) $(id).disabled = unavailable || generating;
  for (const id of ['slides', 'transcripts', 'styles']) $('choose-' + id).disabled = unavailable || generating;
  for (const id of ['slides', 'transcripts']) {
    $(id + '-filename').textContent = [...$(id).files].map(file => file.name).join(', ') || (id === 'slides' ? 'No file chosen' : 'No files chosen');
  }
}
async function request(url, body, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 210000);
  try {
    const response = await fetch(url, {method: 'POST', body, headers:{...headers, ...(browserWorkspace ? {'X-Lecture-Workspace':browserWorkspace} : {})}, signal: controller.signal});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The request failed. Please try again.');
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The request timed out. Please try again.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function materials(question) {
  const form = new FormData();
  const slides = $('slides').files[0];
  if (slides) form.append('slides', slides);
  for (const file of $('transcripts').files) form.append('transcripts', file);
  for (const file of styles) form.append('styles', new Blob([file.text], {type:'text/plain'}), file.name);
  form.append('live', transcriptText());
  form.append('important', $('important').value);
  form.append('chat', JSON.stringify(chat));
  if (question) {
    form.append('question', question);
    form.append('notes', staleNotes ? '' : $('notes-editor').value);
  }
  let size = 0;
  for (const value of form.values()) size += value instanceof Blob ? value.size : new Blob([value]).size;
  if (size > 20 * 1024 * 1024 - 16384) throw new Error('Keep the combined materials under 20 MB. Remove a large file and try again.');
  return form;
}
function persistStyles() {
  try { localStorage.setItem(STYLE_KEY, JSON.stringify(styles)); }
  catch { notice('These examples work for this session, but browser storage is full or unavailable. They may not persist.'); }
}
function renderStyles() {
  $('style-list').replaceChildren();
  styles.forEach((file, index) => {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = file.name;
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'text-button remove-file'; remove.textContent = '×';
    remove.setAttribute('aria-label', 'Remove ' + file.name);
    remove.onclick = () => { styles.splice(index, 1); persistStyles(); renderStyles(); };
    row.append(label, remove); $('style-list').append(row);
  });
}
try {
  const saved = JSON.parse(localStorage.getItem(STYLE_KEY) || '[]');
  if (Array.isArray(saved) && saved.length <= 3 && saved.every(f => typeof f.name === 'string' && /\.(txt|tex)$/i.test(f.name) && typeof f.text === 'string' && f.text.length <= 600000)) styles = saved;
} catch { notice('Saved examples could not be loaded. You can upload them again.'); }
renderStyles();
$('styles').onchange = async () => {
  try {
    const files = [...$('styles').files];
    if (files.length + styles.length > 3) throw new Error('Keep up to 3 examples. Remove an existing example to add another.');
    const additions = [];
    for (const file of files) {
      if (!/\.(txt|tex)$/i.test(file.name) || file.size > 600000) throw new Error('Use TXT or TEX examples under 600 KB each.');
      let text;
      try { text = new TextDecoder('utf-8', {fatal:true}).decode(await file.arrayBuffer()); }
      catch { throw new Error('Please save examples as UTF-8 text.'); }
      if (!text.trim()) throw new Error(file.name + ' is empty.');
      additions.push({name:file.name, text});
    }
    styles.push(...additions); persistStyles(); renderStyles();
  } catch (error) { notice(error.message); }
  finally { $('styles').value = ''; }
};

let chatScrollFrame;
function scrollChatToBottom() {
  cancelAnimationFrame(chatScrollFrame);
  chatScrollFrame = requestAnimationFrame(() => {
    const messages = $('messages');
    const bottom = Math.max(0, messages.scrollHeight - messages.clientHeight);
    if (Math.abs(messages.scrollTop - bottom) > 1) messages.scrollTop = bottom;
  });
}
function addMessage(message) {
  $('chat-empty')?.remove();
  const box = document.createElement('div'); box.className = 'message ' + message.role;
  const label = document.createElement('strong'); label.textContent = message.role === 'user' ? 'You' : 'Lecture assistant';
  const content = document.createElement('span'); content.textContent = message.content;
  box.append(label, content); $('messages').append(box);
  scrollChatToBottom();
}
$('question').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!$('ask').disabled) $('chat-form').requestSubmit();
  }
};
$('chat-form').onsubmit = async event => {
  event.preventDefault();
  if (loading || chatting || generating || chat.length >= 200 || !hasChatContext()) return;
  const question = $('question').value.trim(); if (!question) return;
  chatting = true; refresh(); 
  scrollChatToBottom();
  try {
    const result = await request('/chat', materials(question));
    const user = {role:'user', content:question}, assistant = {role:'assistant', content:result.answer};
    chat.push(user, assistant); addMessage(user); addMessage(assistant); $('question').value = '';
    markChanged();
  } catch (error) { notice(error.message); }
  finally { chatting = false; refresh(); }
};

const recorder = new LectureRecorder({
  onText(text, interim = '') {
    const changed = confirmedTranscript !== text;
    confirmedTranscript = text;
    const display = [text, interim].filter(Boolean).join(' ');
    if ($('live').value !== display) {
      const follow = $('live').scrollHeight - $('live').scrollTop - $('live').clientHeight < 40;
      $('live').value = display;
      if (follow) $('live').scrollTop = $('live').scrollHeight;
    }
    if (changed) markChanged(true);
    refresh();
  },
  onTime(time) {
    const checkpoint = Math.floor(time / 30000) !== Math.floor(elapsed / 30000);
    elapsed = time;
    if (checkpoint) markChanged();
    $('timer').textContent = new Date(time).toISOString().slice(11, 19);
    $('materials-record-status').textContent = $('timer').textContent;
  },
  onNotice: notice,
  onState(state) {
    starting = state === 'starting';
    stopping = state === 'stopping';
    recording = state === 'listening' || state === 'reconnecting';
    refresh();
    if (state === 'stopped') markChanged();
  },
});
$('record').onclick = () => {
  if (recording || starting) { recorder.stop(); return; }
  if (loading || stopping || generating || elapsed >= LIMIT) return;
  notice('');
  confirmedTranscript = $('live').value;
  recorder.start(confirmedTranscript);
};
$('record-from-materials').onclick = () => $('record').click();
$('live').oninput = () => { markChanged(true); refresh(); };
$('important').oninput = () => markChanged();
$('question').oninput = () => markChanged();
$('download-transcript').onclick = () => {
  const url = URL.createObjectURL(new Blob([$('live').value], {type:'text/plain;charset=utf-8'}));
  const link = document.createElement('a'); link.href=url; link.download='lecture-transcript.txt'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
function selectView(view) {
  for (const [name, panel] of Object.entries({materials:'materials-panel', transcript:'transcript-panel', notes:'result'})) {
    $(panel).hidden = view !== name;
    $('view-' + name).setAttribute('aria-pressed', String(view === name));
  }
  $('result-actions').hidden = view !== 'notes' || !$('notes-editor').value;
}
for (const view of ['materials', 'transcript', 'notes']) $('view-' + view).onclick = () => selectView(view);
$('slides').onchange = () => { suggestTitle(); markChanged(true); refresh(); };
let uploadRevision = 0, uploadPending = false;
$('transcripts').onchange = async () => {
  uploadPending = true;
  const revision = ++uploadRevision;
  const files = [...$('transcripts').files].sort((a, b) => a.name.localeCompare(b.name));
  refresh();
  try {
    for (const file of files) {
      if (!/\.txt$/i.test(file.name) || file.size > 2400000) throw new Error('Upload UTF-8 TXT transcripts under 600,000 characters each.');
      const text = new TextDecoder('utf-8', {fatal:true}).decode(await file.arrayBuffer());
      if (!text.trim() || text.length > 600000) throw new Error('Transcripts must be nonempty and under 600,000 characters.');
    }
    if (revision !== uploadRevision) return;
    suggestTitle();
    markChanged(true);
  } catch (error) {
    if (revision !== uploadRevision) return;
    $('transcripts').value = '';
    notice(error.message);
  } finally { if (revision === uploadRevision) uploadPending = false; refresh(); }
};
function showResult(result) {
  $('notes-empty').hidden = true;
  $('result-actions').hidden = false;
  $('notes-editor').value = result.latex;
  $('result-actions').hidden = $('result').hidden;
  $('notes-preview').innerHTML = result.preview;
  if (notesURL) URL.revokeObjectURL(notesURL);
  notesURL = URL.createObjectURL(new Blob([result.latex], {type:'application/x-tex'}));
  $('download-notes').href = notesURL;
  $('download-notes').download = 'notes.tex';
  refresh();
  if (window.MathJax?.typesetPromise) MathJax.typesetPromise([$('notes-preview')]).catch(() => {});
}
$('generate').onclick = async () => {
  if (loading || generating || recording || starting || stopping || chatting) return;
  if (!$('slides').files.length && !$('transcripts').files.length && !$('live').value.trim()) return notice('Add slides, a transcript, or record a lecture first.');
  generating = true; notice(''); refresh();
  try {
    const result = await request('/generate', materials()); staleNotes = false; showResult(result); selectView('notes');
    markChanged();
    $('result').scrollIntoView({behavior:'smooth',block:'start'});
  } catch (error) { notice(error.message); }
  finally { generating = false; refresh(); }
};
$('toggle-preview').onclick = () => {
  const showCode = $('notes-editor').hidden;
  $('notes-editor').hidden = !showCode; $('notes-preview').hidden = showCode;
  $('toggle-preview').setAttribute('aria-checked', String(showCode));
};
function markChanged(affectsNotes = false) {
  if (loading || !activeLecture) return;
  if (affectsNotes && $('notes-editor').value) {
    staleNotes = true;
  }
  changeVersion++;
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; saveLecture().catch(() => {}); }, 600);
}
function suggestTitle() {
  if (customTitle) return;
  const file = $('slides').files[0] || $('transcripts').files[0];
  if (file) $('lecture-title').textContent = file.name.replace(/\.[^.]+$/, '').slice(0, 50);
}
async function readFile(file, pdf = false) {
  if (fileCache.has(file)) return fileCache.get(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let value;
  if (pdf) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    value = {name:file.name, data:btoa(binary)};
  } else value = {name:file.name, text:new TextDecoder('utf-8', {fatal:true}).decode(bytes)};
  fileCache.set(file, value);
  return value;
}
async function snapshot() {
  const slides = $('slides').files[0], transcripts = [...$('transcripts').files];
  const state = {id:activeLecture, revision:lectureRevision, title:$('lecture-title').textContent, custom_title:customTitle,
    live:transcriptText(), important:$('important').value, latex:$('notes-editor').value,
    draft:$('question').value, chat:chat.map(m => ({...m})), elapsed, stale:staleNotes};
  state.slides = slides ? await readFile(slides, true) : null;
  state.transcripts = await Promise.all(transcripts.map(file => readFile(file)));
  return state;
}
async function saveLecture() {
  clearTimeout(saveTimer); saveTimer = null;
  if (savePromise) return savePromise;
  if (!activeLecture || savedVersion === changeVersion) return;
  savePromise = (async () => {
    try {
      while (savedVersion !== changeVersion) {
        const version = changeVersion;
        const state = await snapshot();
        const result = await request('/lectures/save', JSON.stringify(state), {'Content-Type':'application/json'});
        lectureRevision = result.revision;
        savedVersion = version;
      }
    } catch (error) {
      notice('Could not save this lecture: ' + error.message + ' Keep this tab open and try again.');
      throw error;
    } finally { savePromise = null; }
  })();
  return savePromise;
}
function restoreFiles(id, files) {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  $(id).files = transfer.files;
}
function applyLecture(state) {
  activeLecture = state.id; lectureRevision = state.revision || 0;
  changeVersion = savedVersion = 0; staleNotes = Boolean(state.stale);
  customTitle = Boolean(state.custom_title);
  $('lecture-rename').hidden = true; $('lecture-title').hidden = false;
  $('lecture-title').textContent = state.title.slice(0, 50);
  confirmedTranscript = state.live;
  $('live').value = state.live; $('important').value = state.important;
  $('question').value = state.draft || '';
  elapsed = state.elapsed || 0; recorder.elapsed = elapsed;
  $('timer').textContent = new Date(elapsed).toISOString().slice(11, 19);
  $('materials-record-status').textContent = $('timer').textContent;
  const slides = state.slides ? [new File([Uint8Array.from(atob(state.slides.data), c => c.charCodeAt(0))], state.slides.name, {type:'application/pdf'})] : [];
  restoreFiles('slides', slides);
  restoreFiles('transcripts', state.transcripts.map(t => new File([t.text], t.name, {type:'text/plain'})));
  chat = state.chat || []; $('messages').replaceChildren();
  const empty = document.createElement('p'); empty.id = 'chat-empty'; empty.className = 'empty'; $('messages').append(empty);
  chat.forEach(addMessage);
  
  $('notes-editor').value = ''; $('notes-preview').innerHTML = '';
  $('notes-empty').hidden = false; $('notes-editor').hidden = true; $('notes-preview').hidden = false;
  $('toggle-preview').setAttribute('aria-checked', 'false');
  if (notesURL) { URL.revokeObjectURL(notesURL); notesURL = null; }
  $('download-notes').href = '#';
  if (state.latex) showResult({latex:state.latex, preview:state.preview || ''});
  selectView('notes');
  try { localStorage.setItem(LAST_LECTURE, activeLecture); } catch { /* Lecture content is saved on disk. */ }
}
async function getJSON(url) {
  const response = await fetch(url, {headers:browserWorkspace ? {'X-Lecture-Workspace':browserWorkspace} : {}});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not load lectures.');
  return result;
}
function canSwitch() {
  if (loading || uploadPending || recording || starting || stopping || generating || chatting) {
    return false;
  }
  return true;
}
async function switchLecture(id) {
  if (!canSwitch()) return;
  loading = true; refresh();
  try {
    await saveLecture();
    const state = await getJSON('/lectures/' + id);
    applyLecture(state); closeHistory(); notice('');
  } catch (error) { notice(error.message); }
  finally { loading = false; refresh(); }
}
async function createLecture(initial = false) {
  if (!initial && !canSwitch()) return;
  loading = true; refresh();
  try {
    await saveLecture();
    const state = {id:crypto.randomUUID().replaceAll('-', ''), revision:0,
      title:'Untitled lecture · ' + new Date().toLocaleDateString(), live:'', important:'', latex:'', draft:'',
      chat:[], transcripts:[], slides:null, elapsed:0, stale:false};
    const result = await request('/lectures/save', JSON.stringify(state), {'Content-Type':'application/json'});
    applyLecture({...state, ...result}); closeHistory(); notice('');
  } catch (error) { notice(error.message); }
  finally { loading = false; refresh(); }
}
function closeHistory() {
  $('history-drawer').hidden = true;
  document.body.classList.remove('history-open');
  $('history-toggle').setAttribute('aria-expanded', 'false');
  $('history-toggle').focus();
}
$('history-close').onclick = closeHistory;
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('history-drawer').hidden) closeHistory();
});
$('new-lecture').onclick = () => createLecture();
async function renderHistory() {
  const {lectures} = await getJSON('/lectures');
  $('lecture-list').replaceChildren();
  for (const lecture of lectures) {
    const row = document.createElement('div'); row.className = 'lecture-item';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'lecture-select';
    button.setAttribute('aria-current', String(lecture.id === activeLecture));
    const title = document.createElement('strong'); title.textContent = lecture.id === activeLecture ? $('lecture-title').textContent : lecture.title.slice(0, 50);
    const date = document.createElement('small'); date.textContent = new Date(lecture.updated).toLocaleDateString();
    button.append(title, date); button.onclick = () => switchLecture(lecture.id);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'lecture-delete';
    remove.setAttribute('aria-label', 'Delete ' + title.textContent); remove.title = 'Delete lecture';
    remove.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';
    remove.onclick = () => deleteLecture(lecture.id, title.textContent);
    row.append(button, remove); $('lecture-list').append(row);
  }
}
$('history-toggle').onclick = async () => {
  if (!$('history-drawer').hidden) { closeHistory(); return; }
  $('history-drawer').hidden = false;
  document.body.classList.add('history-open');
  $('history-toggle').setAttribute('aria-expanded', 'true');
  
  try { await renderHistory(); } catch (error) { notice(error.message); }
};
async function deleteLecture(id, title) {
  if (!canSwitch() || !window.confirm('Delete “' + title + '” and its materials, notes and chat?')) return;
  loading = true; refresh();
  try {
    await saveLecture();
    const {lectures} = await getJSON('/lectures');
    const target = lectures.find(l => l.id === id);
    if (!target) throw new Error('Lecture not found. Reopen history.');
    let replacement;
    if (id === activeLecture) {
      const next = lectures.find(l => l.id !== id);
      if (next) replacement = await getJSON('/lectures/' + next.id);
      else {
        replacement = {id:crypto.randomUUID().replaceAll('-', ''), revision:0,
          title:'Untitled lecture · ' + new Date().toLocaleDateString(), custom_title:false,
          live:'',important:'',latex:'',draft:'',chat:[],transcripts:[],slides:null,elapsed:0,stale:false};
        Object.assign(replacement, await request('/lectures/save', JSON.stringify(replacement), {'Content-Type':'application/json'}));
      }
    }
    await request('/lectures/delete', JSON.stringify({id, revision:target.revision}), {'Content-Type':'application/json'});
    if (replacement) applyLecture(replacement);
    await renderHistory(); 
  } catch (error) { notice(error.message); }
  finally { loading = false; refresh(); }
}
function beginRename() {
  if (loading || !activeLecture) return;
  $('lecture-rename').value = $('lecture-title').textContent;
  $('lecture-title').hidden = true; $('lecture-rename').hidden = false;
  $('lecture-rename').focus(); $('lecture-rename').select();
}
function finishRename(cancel = false) {
  if ($('lecture-rename').hidden) return;
  const title = $('lecture-rename').value.trim().slice(0, 50);
  $('lecture-rename').hidden = true; $('lecture-title').hidden = false;
  if (!cancel && title && title !== $('lecture-title').textContent) {
    $('lecture-title').textContent = title; customTitle = true; markChanged();
    if (!$('history-drawer').hidden) renderHistory().catch(() => {});
  }
}
$('lecture-title').ondblclick = beginRename;
$('lecture-title').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); beginRename(); } };
$('lecture-rename').onblur = () => finishRename();
$('lecture-rename').onkeydown = event => {
  if (event.key === 'Enter' || event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); finishRename(event.key === 'Escape');
    if (event.key === 'Escape') $('lecture-title').focus();
    else $('lecture-title').blur();
  }
};
window.addEventListener('beforeunload', event => {
  if (recording || starting || stopping || generating || chatting || changeVersion !== savedVersion) {
    event.preventDefault(); event.returnValue = '';
  }
});
async function initializeLectures() {
  try {
    const {lectures, workspace} = await getJSON('/lectures');
    browserWorkspace = workspace;
    let last; try { last = localStorage.getItem(LAST_LECTURE); } catch { /* Use latest lecture. */ }
    const selected = lectures.find(l => l.id === last) || lectures[0];
    if (selected) applyLecture(await getJSON('/lectures/' + selected.id));
    else await createLecture(true);
  } catch (error) { notice('Could not load lecture history: ' + error.message); }
  finally { loading = false; refresh(); }
}
initializeLectures();
refresh();
