# Lecture notes

1. Install Python 3.8+ and Google Chrome, download or clone this repository, and open a terminal in its folder. No extra packages are needed.

2. Create a `.env` file in the project folder with your Gemini API key (one-time setup):

   ```dotenv
   GOOGLE_API_KEY=your-api-key
   ```

   The server loads this automatically. `.env` is excluded from GitHub.

3. Run `python3 server.py` (`python server.py` on Windows), then open **http://127.0.0.1:8000** in Chrome. Allow microphone access to transcribe lectures.

Local use works as above. Each browser gets its own lecture history, saved under the git-ignored `.app-data/` folder. On the first local visit after upgrading, existing `lectures/` files are copied into that browser's private history; the originals are kept. Keep using the same browser and address. Clearing cookies or using incognito starts a separate history. Back up `.app-data/` (including its session secret) and keep it private.

For hosting, set `GOOGLE_API_KEY`, `PUBLIC_ORIGIN=https://your-domain`, and `APP_DATA_DIR` to a private persistent volume directory in the hosting dashboard. The server uses the platform's `PORT` (default 8000) and listens publicly only when `PUBLIC_ORIGIN` is set. HTTPS should be provided by the host. Do not upload `.env`, `.app-data/`, or `lectures/`. Hosted visitors get separate histories and cannot access your local files; there are no accounts or cross-device recovery. Visitors' AI requests use the hosted server's API key.
