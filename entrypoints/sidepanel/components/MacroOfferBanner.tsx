import { useEffect, useState } from 'react';
import {
  PENDING_MACRO_OFFER_KEY,
  cancelAutoRun,
  clearPendingMacroOffer,
  dismissMacroOffer,
  getPendingMacroOffer,
  runMacro,
  type PendingMacroOffer,
} from '@/lib/macros';

/**
 * "Looks like you're doing X — want me to finish it?"
 *
 * Lives in `App` rather than inside the Macros tab on purpose. The existing dual-surface rule
 * only checks whether the side panel *exists*, not which tab is mounted, so a suggestion raised
 * while the user sat on Rituals was written to session storage and then never seen by anyone —
 * no card, and no notification either, because the panel counted as open.
 */
export function MacroOfferBanner() {
  const [offer, setOffer] = useState<PendingMacroOffer | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPendingMacroOffer().then((o) => {
      if (!cancelled) setOffer(o);
    });

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area !== 'session' || !(PENDING_MACRO_OFFER_KEY in changes)) return;
      setOffer((changes[PENDING_MACRO_OFFER_KEY]?.newValue ?? null) as PendingMacroOffer | null);
    };

    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  // Countdown only exists for an auto-run; a plain offer just waits.
  useEffect(() => {
    if (!offer?.firesAt) {
      setSecondsLeft(null);
      return;
    }
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((offer.firesAt! - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [offer?.firesAt]);

  if (!offer) return null;

  const counting = secondsLeft !== null && secondsLeft > 0;

  return (
    <div className="macro-offer">
      <div className="macro-offer-text">
        <strong>{offer.macroName}</strong>
        <span>
          {counting
            ? `Running on its own in ${secondsLeft}s`
            : `You've done the first ${offer.matched} steps — open the remaining ${offer.remaining}?`}
        </span>
      </div>
      <div className="macro-offer-actions">
        {counting ? (
          <button className="btn btn-secondary" onClick={() => void cancelAutoRun(offer.macroId)}>
            Cancel
          </button>
        ) : (
          <>
            <button
              className="btn btn-accept"
              onClick={async () => {
                await clearPendingMacroOffer();
                await runMacro(offer.macroId);
              }}
            >
              Finish it
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => void dismissMacroOffer(offer.macroId)}
            >
              Not now
            </button>
          </>
        )}
      </div>
    </div>
  );
}
