import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("useDictation exposes a live analyser for the waveform", async () => {
  const source = await readFile(
    new URL("./useDictation.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /createMediaStreamSource\(stream\)/);
  assert.match(source, /createAnalyser\(\)/);
  assert.match(source, /captureRef\.current\.analyser = analyser/);

  // The AudioContext must be closed on cleanup
  assert.match(source, /audioContextRef\.current\.close\(\)/);
});

test("useDictation supports playback preview while paused and review mode upon stop", async () => {
  const source = await readFile(
    new URL("./useDictation.ts", import.meta.url),
    "utf8",
  );

  // Request data on pause to accumulate chunks for preview
  assert.match(source, /recorder\.requestData\(\)/);

  // Exposes preview playback and review states
  assert.match(source, /isReviewing/);
  assert.match(source, /isPlayingPreview/);
  assert.match(source, /playPreview/);
  assert.match(source, /pausePreview/);
  assert.match(source, /seekPreview/);
  assert.match(source, /confirmTranscribe/);

  // Stopping capture transitions to review state instead of immediately transcribing
  assert.match(source, /setIsReviewing\(true\)/);
});

test("RecordingDeck renders left preview play button when paused and in review mode", async () => {
  const deckSource = await readFile(
    new URL("../components/RecordingDeck.tsx", import.meta.url),
    "utf8",
  );

  // Left play preview button when paused or in review mode
  assert.match(deckSource, /onPlayPreview/);
  assert.match(deckSource, /isPlayingPreview/);

  // Review mode renders discard and confirm buttons
  assert.match(deckSource, /isReviewing/);
  assert.match(deckSource, /onConfirmTranscribe/);
});
