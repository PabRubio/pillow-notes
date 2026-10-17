'use strict';
// One controller owns browser recognition sessions, including automatic restarts.
class LectureRecorder {
  constructor({onText, onState, onTime, onNotice, Recognition = window.SpeechRecognition || window.webkitSpeechRecognition}) {
    Object.assign(this, {onText, onState, onTime, onNotice, Recognition});
    this.limit = 2 * 60 * 60 * 1000;
    this.elapsed = 0;
    this.active = false;
    this.recognition = null;
    this.failures = 0;
  }
  start(text) {
    if (this.active || this.recognition || this.elapsed >= this.limit) return;
    if (!this.Recognition) {
      this.onNotice('Live transcription is unavailable in this browser. Open the app in Chrome, or upload a transcript.');
      return;
    }
    this.text = text.trim();
    this.interim = '';
    this.active = true;
    this.startedAt = Date.now();
    this.failures = 0;
    this.ticker = setInterval(() => {
      this.onTime(Math.min(this.limit, this.elapsed + Date.now() - this.startedAt));
      if (this.elapsed + Date.now() - this.startedAt >= this.limit) {
        this.onNotice('The two-hour recording limit has been reached.');
        this.stop();
      }
    }, 500);
    this.connect();
  }
  connect() {
    if (!this.active) return;
    this.onState('starting');
    const base = this.text;
    let recognition;
    try {
      recognition = new this.Recognition();
      this.recognition = recognition;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-GB';
      recognition.maxAlternatives = 1;
      let sessionStarted = Date.now();
      let networkError = false;
      recognition.onstart = () => {
        if (this.recognition !== recognition || !this.active) return;
        clearTimeout(this.watchdog);
        sessionStarted = Date.now();
        this.onState('listening');
      };
      recognition.onresult = event => {
        if (this.recognition !== recognition) return;
        const final = [], interim = [];
        // Results contain the current session's full list. Rebuild instead of appending
        // repeated or revised interim results (which would duplicate words).
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          (result.isFinal ? final : interim).push(result[0].transcript.trim());
        }
        this.text = [base, final.join(' ')].filter(Boolean).join('\n\n');
        this.interim = interim.join(' ');
        this.failures = 0;
        this.onText(this.text, this.interim);
      };
      recognition.onerror = event => {
        if (this.recognition !== recognition || !this.active) return;
        if (event.error === 'no-speech') return;
        if (event.error === 'network') { networkError = true; return; }
        const messages = {
          'not-allowed': 'Microphone permission was denied. Allow microphone access in Chrome and try again.',
          'service-not-allowed': 'Chrome speech recognition is unavailable or blocked. Check browser permissions or upload a transcript.',
          'audio-capture': 'No microphone is available. Check your microphone and try again.',
          'language-not-supported': 'English speech recognition is unavailable in this browser.',
        };
        this.onNotice(messages[event.error] || 'Speech recognition stopped. Your transcript is preserved; you can start again.');
        this.stop();
      };
      recognition.onend = () => {
        if (this.recognition !== recognition) return;
        clearTimeout(this.watchdog);
        this.recognition = null;
        this.preserveInterim();
        if (!this.active) { this.finish(); return; }
        this.failures = networkError || Date.now() - sessionStarted < 1500 ? this.failures + 1 : 0;
        if (this.failures >= 3) {
          this.onNotice('Speech recognition keeps disconnecting. Check your connection, then start again. Your transcript is preserved.');
          this.stop();
          return;
        }
        this.onState('reconnecting');
        this.restart = setTimeout(() => this.connect(), networkError ? 1500 : 300);
      };
      this.watchdog = setTimeout(() => {
        if (this.recognition !== recognition) return;
        this.onNotice('Speech recognition did not start. Check Chrome’s microphone permission and your connection.');
        this.stop();
      }, 15000);
      recognition.start();
    } catch {
      this.onNotice('Could not start speech recognition. Open the app in Chrome on localhost or HTTPS and allow microphone access.');
      this.stop();
      this.finish();
    }
  }
  preserveInterim() {
    if (!this.interim) return;
    this.text = [this.text, this.interim].filter(Boolean).join(' ');
    this.interim = '';
    this.onText(this.text, '');
    this.onNotice('Some final words were not confirmed by speech recognition. Review the end of the transcript.');
  }
  stop() {
    if (!this.active) return;
    this.active = false;
    this.elapsed = Math.min(this.limit, this.elapsed + Date.now() - this.startedAt);
    clearInterval(this.ticker);
    clearTimeout(this.restart);
    clearTimeout(this.watchdog);
    this.onTime(this.elapsed);
    if (!this.recognition) { this.finish(); return; }
    this.onState('stopping');
    this.watchdog = setTimeout(() => this.finish(), 3000);
    try { this.recognition.stop(); } catch { this.finish(); }
  }
  finish() {
    clearTimeout(this.watchdog);
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
      try { recognition.abort(); } catch { /* Already ended. */ }
    }
    this.preserveInterim();
    this.onState('stopped');
  }
}
