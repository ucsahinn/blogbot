export type FeedbackSound = "boby-open" | "boby-reply" | "notification";

const tones: Record<FeedbackSound, readonly number[]> = {
  "boby-open": [480, 660],
  "boby-reply": [660, 820],
  notification: [540, 720]
};

/** Short locally synthesized cues. They are optional feedback, never speech. */
export function playFeedbackSound(kind: FeedbackSound): void {
  try {
    const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextConstructor) return;
    const context = new AudioContextConstructor();
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.connect(context.destination);
    tones[kind].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const start = context.currentTime + index * 0.085;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, start);
      oscillator.connect(gain);
      oscillator.start(start);
      oscillator.stop(start + 0.07);
    });
    gain.gain.exponentialRampToValueAtTime(0.038, context.currentTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.19);
    window.setTimeout(() => void context.close(), 230);
  } catch {
    // Browser audio policies or an unavailable device must not affect work.
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
