import { useCallback, useEffect, useRef, useState } from 'react';

// Local-only recorder hook. Uses native MediaRecorder, never uploads.
// UI state only; transport wiring stays in VoiceTransport for Phase 3.
const formatElapsed = (ms) => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(1, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export const isRecordingSupported = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof window !== 'undefined' &&
  typeof window.MediaRecorder !== 'undefined';

const useLocalRecorder = () => {
  const [status, setStatus] = useState('idle'); // idle | requesting | recording | preview | denied | unsupported
  const [elapsedMs, setElapsedMs] = useState(0);
  const [audioUrl, setAudioUrl] = useState(null);
  const [mimeType, setMimeType] = useState('');
  const [error, setError] = useState('');
  const recRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const startRef = useRef(0);
  const urlRef = useRef(null);

  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch { /* ignore */ }
      streamRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const revokePreview = useCallback(() => {
    if (urlRef.current) {
      try { URL.revokeObjectURL(urlRef.current); } catch { /* ignore */ }
      urlRef.current = null;
    }
    setAudioUrl(null);
  }, []);

  // Unmount safety: stop tracks, stop recorder, revoke preview.
  useEffect(() => () => {
    try { if (recRef.current?.state !== 'inactive') recRef.current?.stop(); } catch { /* ignore */ }
    cleanupStream();
    if (urlRef.current) {
      try { URL.revokeObjectURL(urlRef.current); } catch { /* ignore */ }
    }
  }, [cleanupStream]);

  const start = useCallback(async () => {
    if (!isRecordingSupported()) {
      setStatus('unsupported');
      setError('Voice recording is not supported in this browser. Text and photo input remain fully supported.');
      return;
    }
    setError('');
    setStatus('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mime = window.MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';
      const rec = mime ? new window.MediaRecorder(stream, { mimeType: mime }) : new window.MediaRecorder(stream);
      recRef.current = rec;
      setMimeType(rec.mimeType || mime);
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.start(250);
      startRef.current = Date.now();
      setElapsedMs(0);
      setStatus('recording');
      timerRef.current = setInterval(() => setElapsedMs(Date.now() - startRef.current), 250);
    } catch (err) {
      cleanupStream();
      const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
      setStatus(denied ? 'denied' : 'unsupported');
      setError(
        denied
          ? 'Microphone access was denied. Allow microphone use in the browser, or continue with text and photo.'
          : 'Could not start recording. Text and photo input remain fully supported.'
      );
    }
  }, [cleanupStream]);

  const stop = useCallback(() => new Promise((resolve) => {
    const rec = recRef.current;
    if (!rec || rec.state === 'inactive') {
      cleanupStream();
      resolve(null);
      return;
    }
    rec.onstop = () => {
      cleanupStream();
      try {
        revokePreview();
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        chunksRef.current = [];
        if (blob.size === 0) {
          setStatus('idle');
          setError('Nothing was recorded. Try again, or use text and photo.');
          resolve(null);
          return;
        }
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setAudioUrl(url);
        setStatus('preview');
        resolve({ url, blob, durationMs: Date.now() - startRef.current, mimeType: blob.type });
      } catch {
        setStatus('idle');
        setError('Could not finalize the recording. Text and photo input remain fully supported.');
        resolve(null);
      }
    };
    try { rec.stop(); } catch {
      cleanupStream();
      setStatus('idle');
      resolve(null);
    }
  }), [cleanupStream, revokePreview]);

  const cancel = useCallback(() => {
    try { if (recRef.current?.state !== 'inactive') recRef.current?.stop(); } catch { /* ignore */ }
    chunksRef.current = [];
    cleanupStream();
    revokePreview();
    setElapsedMs(0);
    setError('');
    setStatus('idle');
  }, [cleanupStream, revokePreview]);

  const discardPreview = useCallback(() => {
    revokePreview();
    setElapsedMs(0);
    setError('');
    setStatus('idle');
  }, [revokePreview]);

  return {
    status, elapsedMs, elapsed: formatElapsed(elapsedMs),
    audioUrl, mimeType, error,
    start, stop, cancel, discardPreview,
    supported: isRecordingSupported(),
  };
};

export default useLocalRecorder;
