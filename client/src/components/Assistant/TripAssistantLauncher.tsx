import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Mic, MicOff, Plus, Send, Sparkles, X, Volume2, VolumeX } from 'lucide-react';
import { assistantApi } from '../../api/client';
import type { TripAssistantDraft, TripAssistantMessage, TripAssistantSession } from '@trek/shared';
import { useTranslation } from '../../i18n';
import type { DashboardTrip } from '../../pages/dashboard/dashboardModel';
import { useNavigate } from 'react-router-dom';

const STORAGE_KEY = 'trek_trip_assistant_session_id';

const WELCOME: TripAssistantMessage[] = [
  { role: 'assistant', content: 'I can turn a chat into a trip. Tell me where you want to go, when, and how long you want to stay.' },
];

function speak(text: string): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(text);
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

export default function TripAssistantLauncher({ onTripCreated }: { onTripCreated: (trip: DashboardTrip) => void }): React.ReactElement {
  const { t, locale } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY));
  const [messages, setMessages] = useState<TripAssistantMessage[]>(WELCOME);
  const [draft, setDraft] = useState<TripAssistantDraft>({});
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [listening, setListening] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const recognitionRef = useRef<any>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    assistantApi.getSession(sessionId)
      .then((session: TripAssistantSession) => {
        if (cancelled) return;
        setMessages(session.messages.length > 0 ? session.messages : WELCOME);
        setDraft(session.draft || {});
      })
      .catch(() => {
        if (cancelled) return;
        setSessionId(null);
        localStorage.removeItem(STORAGE_KEY);
      });
    return () => { cancelled = true; };
  }, [open, sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages, open]);

  useEffect(() => {
    if (!voiceEnabled && listening && recognitionRef.current) {
      recognitionRef.current.stop?.();
      setListening(false);
    }
  }, [voiceEnabled, listening]);

  const assistantLabel = useMemo(() => {
    if (draft.title) return draft.title;
    if (draft.destination) return draft.destination;
    return t('dashboard.newTrip');
  }, [draft.destination, draft.title, t]);

  const startVoiceInput = () => {
    const Recognition = (window as Window & { SpeechRecognition?: any; webkitSpeechRecognition?: any }).SpeechRecognition
      || (window as Window & { SpeechRecognition?: any; webkitSpeechRecognition?: any }).webkitSpeechRecognition;
    if (!Recognition) {
      setError('Voice input is not supported in this browser.');
      return;
    }
    if (listening) {
      recognitionRef.current?.stop?.();
      return;
    }
    const recognition = new Recognition();
    recognition.lang = locale || 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => { setListening(true); setError(''); };
    recognition.onerror = () => { setListening(false); setError('Voice input failed. Please type instead.'); };
    recognition.onend = () => setListening(false);
    recognition.onresult = (event: any) => {
      const transcript = event.results?.[0]?.[0]?.transcript?.trim();
      if (transcript) void sendMessage(transcript);
    };
    recognitionRef.current = recognition;
    recognition.start();
  };

  const resetConversation = () => {
    setSessionId(null);
    localStorage.removeItem(STORAGE_KEY);
    setMessages(WELCOME);
    setDraft({});
    setInput('');
    setError('');
  };

  const sendMessage = async (value?: string) => {
    const text = (value ?? input).trim();
    if (!text || busy) return;
    setBusy(true);
    setError('');
    setInput('');
    const optimisticMessages: TripAssistantMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(optimisticMessages);
    try {
      const response = await assistantApi.sendTripMessage({
        session_id: sessionId || undefined,
        message: text,
        locale,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setSessionId(response.session_id);
      localStorage.setItem(STORAGE_KEY, response.session_id);
      setMessages(response.messages?.length ? response.messages : optimisticMessages);
      setDraft(response.draft || {});
      if (voiceEnabled) speak(response.assistant_message);
      if (response.created_trip) {
        onTripCreated(response.created_trip as DashboardTrip);
        navigate(`/trips/${response.created_trip.id}`);
        setOpen(false);
      }
    } catch (err: unknown) {
      setMessages((prev) => [...prev, { role: 'assistant', content: 'I hit a problem creating the trip. Try again or add a little more detail.' }]);
      setError(err instanceof Error ? err.message : 'Assistant request failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="trip-assistant-launcher"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={open ? 'Close trip assistant' : 'Open trip assistant'}
        title={open ? 'Close trip assistant' : 'Open trip assistant'}
      >
        <Sparkles size={18} />
      </button>

      {open && (
        <section className="trip-assistant-panel" aria-label="Trip assistant">
          <header className="trip-assistant-header">
            <div className="trip-assistant-brand">
              <span className="trip-assistant-avatar"><Bot size={17} /></span>
              <div>
                <div className="trip-assistant-title">Trip assistant</div>
                <div className="trip-assistant-subtitle">{assistantLabel}</div>
              </div>
            </div>
            <div className="trip-assistant-actions">
              <button type="button" className="trip-assistant-icon-btn" onClick={() => setVoiceEnabled((prev) => !prev)} aria-label="Toggle voice output">
                {voiceEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
              </button>
              <button type="button" className="trip-assistant-icon-btn" onClick={resetConversation} aria-label="Start a new trip">
                <Plus size={16} />
              </button>
              <button type="button" className="trip-assistant-icon-btn" onClick={() => setOpen(false)} aria-label="Close assistant">
                <X size={16} />
              </button>
            </div>
          </header>

          <div className="trip-assistant-draft">
            <span>{draft.destination || draft.title || 'New trip'}</span>
            <span>{draft.start_date || draft.day_count || 'Tell me the dates'}</span>
          </div>

          <div className="trip-assistant-messages">
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={`trip-assistant-bubble ${message.role}`}>
                {message.content}
              </div>
            ))}
            {busy && <div className="trip-assistant-bubble assistant">Thinking...</div>}
            <div ref={bottomRef} />
          </div>

          {error && <div className="trip-assistant-error">{error}</div>}

          <div className="trip-assistant-suggestions">
            {['Plan a 5-day Tokyo trip in April', 'Create a weekend in Lisbon', 'Book a family trip to New York'].map((prompt) => (
              <button type="button" key={prompt} onClick={() => void sendMessage(prompt)} disabled={busy}>
                {prompt}
              </button>
            ))}
          </div>

          <div className="trip-assistant-composer">
            <button type="button" className="trip-assistant-icon-btn" onClick={startVoiceInput} aria-label="Voice input">
              {listening ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Describe the trip you want to build..."
              rows={2}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <button type="button" className="trip-assistant-send" onClick={() => void sendMessage()} disabled={busy || !input.trim()} aria-label="Send message">
              <Send size={16} />
            </button>
          </div>
        </section>
      )}
    </>
  );
}