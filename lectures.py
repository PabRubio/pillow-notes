"""Local lecture folders. JSON snapshots and immutable PDF files; no database."""
import base64
import hashlib
import json
import re
import shutil
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

LOCK = threading.Lock()
MAX_TEXT = 600_000


def lecture_path(root, lecture_id):
    if not isinstance(lecture_id, str) or not re.fullmatch(r'[a-f0-9]{32}', lecture_id):
        raise ValueError('Invalid lecture ID.')
    return Path(root) / 'lectures' / lecture_id


def load(root, lecture_id):
    folder = lecture_path(root, lecture_id)
    try:
        state = json.loads((folder / 'lecture.json').read_text(encoding='utf-8'))
    except FileNotFoundError:
        raise ValueError('Lecture not found.') from None
    if state.get('slides'):
        state['slides']['data'] = base64.b64encode((folder / state['slides']['file']).read_bytes()).decode()
    return state


def listing(root):
    # The previous app kept only one notes.tex. Import it as a separate lecture,
    # never attach it to newly uploaded slides or transcripts.
    legacy = Path(root) / 'notes.tex'
    legacy_id = hashlib.sha256(b'legacy-notes').hexdigest()[:32]
    if legacy.exists() and not (Path(root) / 'lectures' / '.deleted' / legacy_id).exists() and not (lecture_path(root, legacy_id) / 'lecture.json').exists():
        try:
            save(root, dict(id=legacy_id, revision=0, title='Previous notes', live='',
                            important='', latex=legacy.read_text(encoding='utf-8'), draft='',
                            chat=[], transcripts=[], slides=None, elapsed=0, stale=False))
        except ValueError:
            if not (lecture_path(root, legacy_id) / 'lecture.json').exists():
                raise
    result = []
    for path in (Path(root) / 'lectures').glob('*/lecture.json'):
        state = json.loads(path.read_text(encoding='utf-8'))
        result.append({key: state[key] for key in ('id', 'title', 'updated', 'created', 'revision')})
    return sorted(result, key=lambda item: item['updated'], reverse=True)


def save(root, state):
    if not isinstance(state, dict):
        raise ValueError('Invalid lecture.')
    folder = lecture_path(root, state.get('id'))
    for key in ('title', 'live', 'important', 'latex', 'draft'):
        if not isinstance(state.get(key), str) or len(state[key]) > MAX_TEXT:
            raise ValueError('Invalid or oversized lecture text.')
    if not state['title'].strip() or len(state['title']) > 50:
        raise ValueError('Use a lecture title of 50 characters or fewer.')
    chat = state.get('chat')
    if not isinstance(chat, list) or len(chat) > 200 or any(
        not isinstance(m, dict) or m.get('role') not in ('user', 'assistant')
        or not isinstance(m.get('content'), str) or len(m['content']) > MAX_TEXT for m in chat
    ):
        raise ValueError('Invalid lecture chat.')
    transcripts = state.get('transcripts')
    if not isinstance(transcripts, list) or len(transcripts) > 100 or any(
        not isinstance(t, dict) or not isinstance(t.get('name'), str)
        or not t['name'].lower().endswith('.txt') or not isinstance(t.get('text'), str)
        or not t['text'].strip() or len(t['text']) > MAX_TEXT for t in transcripts
    ):
        raise ValueError('Invalid transcripts.')
    elapsed = state.get('elapsed')
    if not isinstance(elapsed, (float, int)) or not 0 <= elapsed <= 7200000:
        raise ValueError('Invalid recording duration.')
    slides = state.get('slides')
    pdf = None
    if slides is not None:
        if not isinstance(slides, dict) or not isinstance(slides.get('name'), str) or not slides['name'].lower().endswith('.pdf'):
            raise ValueError('Invalid slides.')
        try:
            pdf = base64.b64decode(slides.get('data', ''), validate=True)
        except (ValueError, TypeError):
            raise ValueError('Invalid PDF data.') from None
        if not pdf.startswith(b'%PDF-') or len(pdf) > 20 * 1024 * 1024:
            raise ValueError('Slides must be a PDF under 20 MB.')
        slides = {'name': slides['name'], 'file': hashlib.sha256(pdf).hexdigest() + '.pdf'}
    with LOCK:
        if (Path(root) / 'lectures' / '.deleted' / state['id']).exists():
            raise ValueError('This lecture was deleted. Start a new lecture instead.')
        path = folder / 'lecture.json'
        old = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
        if state.get('revision', 0) != old.get('revision', 0):
            raise ValueError('This lecture changed in another tab. Reload before editing to avoid overwriting it.')
        now = datetime.now(timezone.utc).isoformat()
        saved = {key: state[key] for key in ('id', 'title', 'live', 'important', 'latex', 'draft', 'chat', 'transcripts', 'elapsed')}
        saved.update(custom_title=bool(state.get('custom_title', old.get('custom_title', False))), slides=slides, stale=bool(state.get('stale')), created=old.get('created', now),
                     updated=now, revision=old.get('revision', 0) + 1)
        folder.mkdir(parents=True, exist_ok=True)
        if pdf and not (folder / slides['file']).exists():
            (folder / slides['file']).write_bytes(pdf)
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=folder, delete=False) as output:
            json.dump(saved, output, ensure_ascii=False)
            temporary = Path(output.name)
        temporary.replace(path)
    return {key: saved[key] for key in ('id', 'revision', 'updated', 'created', 'title')}


def delete(root, lecture_id, revision):
    folder = lecture_path(root, lecture_id)
    with LOCK:
        path = folder / 'lecture.json'
        if not path.exists():
            raise ValueError('Lecture not found.')
        state = json.loads(path.read_text(encoding='utf-8'))
        if revision != state['revision']:
            raise ValueError('This lecture changed in another tab. Reopen history before deleting it.')
        # A tombstone prevents old tabs and the legacy importer from resurrecting it.
        deleted = Path(root) / 'lectures' / '.deleted'
        deleted.mkdir(parents=True, exist_ok=True)
        (deleted / lecture_id).touch()
        shutil.rmtree(folder)
    return {'deleted': lecture_id}
