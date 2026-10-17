"""Signed anonymous browser cookies and isolated, on-disk lecture workspaces."""
import hashlib
import hmac
import ipaddress
import os
import re
import secrets
import shutil
import tempfile
import threading
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from urllib.parse import urlsplit


class BrowserSessions:
    def __init__(self, data_dir, source_root, public_origin='', port=8000):
        self.data_dir = Path(data_dir)
        self.source_root = Path(source_root)
        self.origin = public_origin.rstrip('/')
        self.public = bool(self.origin)
        self.port = port
        if self.public:
            url = urlsplit(self.origin)
            if url.scheme != 'https' or not url.netloc or url.path or url.query or url.fragment or url.username:
                raise ValueError('PUBLIC_ORIGIN must be an HTTPS origin, e.g. https://your-app.example.com')
            self.hosts = {url.netloc.lower()}
            self.origins = {self.origin}
        else:
            self.hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
            self.origins = {'http://' + host for host in self.hosts}
        self.cookie_name = '__Host-lecture_session' if self.public else 'lecture_session'
        self.scope = self.origin or 'local'
        self.lock = threading.Lock()
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        secret = self.data_dir / '.session-secret'
        if not secret.exists():
            try:
                fd = os.open(str(secret), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'wb') as output:
                    output.write(secrets.token_bytes(32))
            except FileExistsError:
                pass
        self.secret = secret.read_bytes()
        if len(self.secret) != 32:
            raise ValueError('Invalid session secret file. Restore it from your private backup.')

    def allowed_request(self, headers, peer, allow_navigation=False):
        if headers.get('Host', '').lower() not in self.hosts:
            return False
        if headers.get('Sec-Fetch-Site') == 'cross-site' and not (allow_navigation and headers.get('Sec-Fetch-Mode') == 'navigate'):
            # Cross-site navigation to the homepage is checked separately by the handler.
            return False
        origin = headers.get('Origin')
        if origin and origin not in self.origins:
            return False
        if not self.public:
            try:
                if not ipaddress.ip_address(peer).is_loopback:
                    return False
            except ValueError:
                return False
            # A forwarded local connection must not claim the owner's old files.
            if any(headers.get(name) for name in ('Forwarded', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto')):
                return False
        return True

    def sign(self, token):
        return hmac.new(self.secret, (self.scope + ':' + token).encode(), hashlib.sha256).hexdigest()

    def token(self, cookie_header):
        cookie = SimpleCookie()
        try:
            cookie.load(cookie_header or '')
            value = cookie[self.cookie_name].value if self.cookie_name in cookie else ''
        except CookieError:
            return None
        if not re.fullmatch(r'[a-f0-9]{64}\.[a-f0-9]{64}', value):
            return None
        token, signature = value.split('.')
        return token if hmac.compare_digest(signature, self.sign(token)) else None

    def workspace(self, token):
        # Paths never contain raw bearer credentials, so knowing a directory name
        # or a lecture ID does not grant access through the web API.
        return self.data_dir / ('public' if self.public else 'local') / hashlib.sha256(token.encode()).hexdigest()

    def create(self):
        token = secrets.token_hex(32)
        workspace = self.workspace(token)
        workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not self.public:
            self.claim_legacy(workspace)
        cookie = f'{self.cookie_name}={token}.{self.sign(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000'
        if self.public:
            cookie += '; Secure'
        return workspace, cookie

    def claim_legacy(self, workspace):
        # Only the first browser of the loopback-only local server gets a COPY.
        # Public mode never reads these original files. Originals remain intact.
        marker = self.data_dir / '.local-imported'
        with self.lock:
            if marker.exists():
                return
            source = self.source_root / 'lectures'
            if source.exists():
                staging = Path(tempfile.mkdtemp(prefix='.import-', dir=workspace))
                try:
                    shutil.copytree(source, staging / 'lectures')
                    (staging / 'lectures').replace(workspace / 'lectures')
                finally:
                    shutil.rmtree(staging)
            legacy = self.source_root / 'notes.tex'
            if legacy.exists():
                shutil.copyfile(legacy, workspace / 'notes.tex')
            marker.write_text(workspace.name, encoding='ascii')
