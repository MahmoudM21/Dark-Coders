/**
 * Spoken filler for slow voice turns.
 *
 * A voice turn that is waiting for the model is silent, and silence reads as "it did
 * not hear me". When a turn that started from the microphone is still unanswered after
 * FILLER_DELAY_MS the console speaks ONE short phrase — Arabic for an Arabic transcript,
 * English otherwise — and stops it the moment the real answer starts, so nothing ever
 * overlaps.
 *
 * The filler is NOT a message: it is never added to the transcript, never sent to the
 * model in `turns`, never saved in history, and it never states a result. It is also
 * never voiced for a typed turn, or when voice replies are switched off.
 *
 * The timer and the decision live here rather than in the component so they can be
 * unit-tested with node:test's mock timers; the speaking itself is injected.
 */

export const FILLER_DELAY_MS = 1200;

export const FILLERS = {
  ar: ["لحظة من فضلك.", "ثواني أشوف."],
  en: ["One moment, please."],
} as const;

/** Arabic letters plus Arabic Supplement/Extended-A and the presentation forms. */
const ARABIC_LETTERS = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export function containsArabic(text: string): boolean {
  return ARABIC_LETTERS.test(text);
}

/** The next phrase for the transcript's language, rotating through the list. Pure. */
export function fillerFor(text: string, rotation: number): { text: string; rotation: number } {
  const list: readonly string[] = containsArabic(text) ? FILLERS.ar : FILLERS.en;
  const index = ((rotation % list.length) + list.length) % list.length;
  return { text: list[index] ?? list[0]!, rotation: rotation + 1 };
}

/** Whether a filler may be spoken at all. Pure. */
export function shouldSpeakFiller(input: {
  voiceInput: boolean;
  voiceRepliesEnabled: boolean;
  alreadySpoken: boolean;
  answerArrived: boolean;
  cancelled: boolean;
}): boolean {
  return (
    input.voiceInput &&
    input.voiceRepliesEnabled &&
    !input.alreadySpoken &&
    !input.answerArrived &&
    !input.cancelled
  );
}

export type FillerSchedulerOptions = {
  /** Speaks through the console's normal TTS path; the signal stops that audio. */
  speak: (text: string, signal: AbortSignal) => void;
  onError?: (message: string) => void;
  delayMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type FillerScheduler = {
  /** Starts the clock for one turn. `heard` is what the caller actually said. */
  arm: (heard: string, options: { voiceInput: boolean; voiceRepliesEnabled: boolean }) => void;
  /** The real answer is here: stop the clock, and stop any filler already playing. */
  answerArrived: () => void;
  /** The turn is over or was aborted: never speak again for it. */
  cancel: () => void;
  /** The phrase spoken for the current turn, or null. For tests and diagnostics. */
  spoken: () => string | null;
};

export function createFillerScheduler(options: FillerSchedulerOptions): FillerScheduler {
  const delayMs = options.delayMs ?? FILLER_DELAY_MS;
  const setTimer =
    options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  let controller: AbortController | null = null;
  let armed = false;
  let spokenPhrase: string | null = null;
  let answerArrived = false;
  let cancelled = false;
  let rotation = 0;
  let armedOptions: { voiceInput: boolean; voiceRepliesEnabled: boolean } = {
    voiceInput: false,
    voiceRepliesEnabled: false,
  };

  function clearTimerOnly() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function stopFillerAudio() {
    controller?.abort();
    controller = null;
  }

  function arm(heard: string, o: { voiceInput: boolean; voiceRepliesEnabled: boolean }) {
    clearTimerOnly();
    stopFillerAudio();
    armed = false;
    spokenPhrase = null;
    answerArrived = false;
    cancelled = false;
    armedOptions = o;
    // Nothing to do for a typed turn or when voice replies are off.
    if (!o.voiceInput || !o.voiceRepliesEnabled) return;
    armed = true;
    timer = setTimer(() => {
      timer = null;
      if (
        !armed ||
        !shouldSpeakFiller({
          voiceInput: armedOptions.voiceInput,
          voiceRepliesEnabled: armedOptions.voiceRepliesEnabled,
          alreadySpoken: spokenPhrase !== null,
          answerArrived,
          cancelled,
        })
      ) {
        return;
      }
      const pick = fillerFor(heard, rotation);
      rotation = pick.rotation;
      spokenPhrase = pick.text;
      const c = new AbortController();
      controller = c;
      try {
        options.speak(pick.text, c.signal);
      } catch (error) {
        options.onError?.(error instanceof Error ? error.message : String(error));
      }
    }, delayMs);
  }

  function answerArrivedNow() {
    answerArrived = true;
    clearTimerOnly();
    // The reply is about to be spoken: stop the filler so the two never overlap.
    stopFillerAudio();
  }

  function cancel() {
    cancelled = true;
    armed = false;
    clearTimerOnly();
    stopFillerAudio();
  }

  return { arm, answerArrived: answerArrivedNow, cancel, spoken: () => spokenPhrase };
}
