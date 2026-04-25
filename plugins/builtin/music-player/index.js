/**
 * music-player/index.js
 *
 * Shared music playback for voice channels.
 * The peer who queues a track streams it into the voice channel via
 * Web Audio → MediaStream → existing WebRTC tracks.
 *
 * Inter-plugin events fired (other plugins can listen):
 *   music:play   { url, title, queuedBy }
 *   music:stop   {}
 *   music:queue  { url, title, queuedBy }
 */

let _inVoice    = false;
let _queue      = [];   // [{ url, title, queuedBy }]
let _playing    = null; // { audio: HTMLAudioElement, url, title }
let _source     = null; // MediaElementAudioSourceNode
let _audioCtx   = null;
let _dest        = null; // MediaStreamAudioDestinationNode
let _btnInjected = false;

// ── Inject music button when entering voice ───────────────────────────────────
GilgaMesh.on('voice:joined', async () => {
  _inVoice = true;
  if (!_btnInjected) {
    await GilgaMesh.api.ui.addButton({
      label:      'Music Player',
      icon:       '🎵',
      targetArea: 'header-right',
      eventName:  'music:ui:open',
    });
    _btnInjected = true;
  }
  console.log('[MusicPlayer] Joined voice — music controls active');
});

GilgaMesh.on('voice:left', () => {
  _inVoice = false;
  _stopPlayback();
  console.log('[MusicPlayer] Left voice — music stopped');
});

// ── UI button clicked — open a simple prompt to queue a URL ──────────────────
GilgaMesh.on('music:ui:open', () => {
  const url = prompt('Enter audio stream URL (MP3, OGG, etc.):');
  if (!url?.trim()) return;
  const title = prompt('Track title (optional):') || url;
  _queue.push({ url: url.trim(), title, queuedBy: 'me' });
  GilgaMesh.emit('music:queue', { url: url.trim(), title, queuedBy: 'me' });
  if (!_playing) _playNext();
});

// ── Another peer queued a track (received via inter-plugin emit) ──────────────
GilgaMesh.on('music:queue', ({ url, title, queuedBy }) => {
  if (queuedBy === 'me') return; // we already added it above
  _queue.push({ url, title, queuedBy });
  if (!_playing) _playNext();
});

GilgaMesh.on('music:stop', () => _stopPlayback());

// ── Playback ──────────────────────────────────────────────────────────────────
function _playNext() {
  if (!_queue.length || !_inVoice) return;
  const track = _queue.shift();

  try {
    if (!_audioCtx) {
      _audioCtx = new AudioContext();
      _dest     = _audioCtx.createMediaStreamDestination();
    }

    const audio = new Audio(track.url);
    audio.crossOrigin = 'anonymous';

    if (_source) { try { _source.disconnect(); } catch {} }
    _source = _audioCtx.createMediaElementSource(audio);
    _source.connect(_dest);
    _source.connect(_audioCtx.destination); // local monitoring

    audio.play().then(() => {
      _playing = { audio, ...track };
      console.log('[MusicPlayer] Now playing:', track.title);
      GilgaMesh.emit('music:play', { url: track.url, title: track.title, queuedBy: track.queuedBy });
    }).catch(err => {
      console.warn('[MusicPlayer] Playback error:', err.message);
      _playing = null;
      _playNext();
    });

    audio.onended = () => {
      _playing = null;
      _playNext();
    };
  } catch (err) {
    console.warn('[MusicPlayer] Audio setup error:', err.message);
  }
}

function _stopPlayback() {
  if (_playing?.audio) {
    try { _playing.audio.pause(); _playing.audio.src = ''; } catch {}
  }
  _playing = null;
  _queue   = [];
  GilgaMesh.emit('music:stop', {});
}

GilgaMesh.on('app:boot', () => {
  console.log('[MusicPlayer] Ready. Join a voice channel to activate.');
});
