import { useEffect, useState } from 'react';
import { generateCoverage, generateStandup, type DraftSource } from '@/lib/standup';
import { linesToItems, standupToMarkdown, type StandupDraft, type StandupRangeKind } from '@/lib/standup-input';

const RANGE_OPTIONS: { value: StandupRangeKind; label: string }[] = [
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last24h', label: 'Last 24 hours' },
  { value: 'sinceLast', label: 'Since last standup' },
];

function toText(items: string[]): string {
  return items.map((i) => `- ${i}`).join('\n');
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function localDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Next Monday through Friday. */
function nextWorkWeek(): { from: string; to: string } {
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  return { from: localDateInput(monday), to: localDateInput(friday) };
}

function speechText(draft: StandupDraft): string {
  const part = (title: string, items: string[]) => `${title}. ${items.length > 0 ? items.join('. ') : 'Nothing.'}`;
  return [part('Yesterday', draft.yesterday), part('Today', draft.today), part('Blockers', draft.blockers)].join(' ');
}

function DraftSection({ title, text, onChange }: { title: string; text: string; onChange: (text: string) => void }) {
  return (
    <section className="standup-section">
      <h4>{title}</h4>
      <textarea
        className="standup-textarea"
        aria-label={title}
        rows={Math.min(10, Math.max(3, text.split('\n').length + 1))}
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
    </section>
  );
}

function CoveragePanel() {
  const week = nextWorkWeek();
  const [from, setFrom] = useState(week.from);
  const [to, setTo] = useState(week.to);
  const [busy, setBusy] = useState(false);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [source, setSource] = useState<DraftSource>('ai');
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  const create = async () => {
    setBusy(true);
    setCopied(false);
    try {
      const r = await generateCoverage(from, to);
      setMarkdown(r.markdown);
      setSource(r.source);
      setError(r.error);
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (markdown === null) return;
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `coverage-${from}-to-${to}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="coverage-panel">
      <h4>Coverage doc</h4>
      <div className="coverage-dates">
        <label>
          I&apos;m out from <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          to <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button className="btn" disabled={busy || !from || !to || to < from} onClick={create}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>

      {markdown !== null && (
        <>
          {source === 'fallback' && (
            <div className="notice" title={error}>
              AI unavailable — this is a template filled from your local data.
            </div>
          )}
          <textarea
            className="standup-textarea coverage-preview"
            aria-label="Coverage doc"
            rows={16}
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
          />
          <div className="standup-actions">
            <button
              className="btn"
              onClick={async () => {
                await copyText(markdown);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button className="btn" onClick={download}>
              Download .md
            </button>
          </div>
          <div className="doc-seen">Nothing is sent anywhere automatically — copy or download it yourself.</div>
        </>
      )}
    </div>
  );
}

export function StandupTab() {
  const [range, setRange] = useState<StandupRangeKind>('yesterday');
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<DraftSource>('ai');
  const [error, setError] = useState<string | undefined>();
  const [rangeLabel, setRangeLabel] = useState('');
  const [texts, setTexts] = useState<{ yesterday: string; today: string; blockers: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => () => window.speechSynthesis?.cancel(), []);

  const draft = (): StandupDraft | null =>
    texts && {
      yesterday: linesToItems(texts.yesterday),
      today: linesToItems(texts.today),
      blockers: linesToItems(texts.blockers),
    };

  const generate = async () => {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
    setBusy(true);
    setCopied(false);
    try {
      const r = await generateStandup(range);
      setTexts({ yesterday: toText(r.draft.yesterday), today: toText(r.draft.today), blockers: toText(r.draft.blockers) });
      setSource(r.source);
      setError(r.error);
      setRangeLabel(r.rangeLabel);
    } finally {
      setBusy(false);
    }
  };

  const readAloud = () => {
    const d = draft();
    if (!d || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(speechText(d));
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  const stop = () => {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  };

  return (
    <div className="standup-tab">
      <div className="spaces-toolbar">
        <select value={range} onChange={(e) => setRange(e.target.value as StandupRangeKind)} aria-label="Range">
          {RANGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button className="btn" disabled={busy} onClick={generate}>
          {busy ? 'Generating…' : 'Generate'}
        </button>
      </div>

      {texts === null && (
        <div className="ritual-empty">Pick a range and press Generate to draft your standup from your local activity.</div>
      )}

      {texts !== null && (
        <>
          {source === 'fallback' && (
            <div className="notice" title={error}>
              AI unavailable — showing your raw activity under the same headings. Blockers are left empty.
            </div>
          )}
          <div className="doc-seen">Covering {rangeLabel}</div>
          <DraftSection title="Yesterday" text={texts.yesterday} onChange={(yesterday) => setTexts({ ...texts, yesterday })} />
          <DraftSection title="Today" text={texts.today} onChange={(today) => setTexts({ ...texts, today })} />
          <DraftSection title="Blockers" text={texts.blockers} onChange={(blockers) => setTexts({ ...texts, blockers })} />
          <div className="standup-actions">
            <button
              className="btn"
              onClick={async () => {
                const d = draft();
                if (d) await copyText(standupToMarkdown(d));
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy as Markdown'}
            </button>
            {speaking ? (
              <button className="btn" onClick={stop}>
                Stop
              </button>
            ) : (
              <button className="btn" onClick={readAloud}>
                Read aloud
              </button>
            )}
          </div>
        </>
      )}

      <CoveragePanel />
    </div>
  );
}
