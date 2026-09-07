# Coin Pinger

Identify coins by sound, directly in your browser.

Coin Pinger is a private, browser-based coin identifier with curated starter references and shareable frequency profiles. It captures complete pings, rejects poor recordings, extracts stable resonances, and tests each reading against the coin profile you choose.

**[Open Coin Pinger](https://jfanals.github.io/coin-pinger/)**

> Coin Pinger is an acoustic comparison tool, not proof of authenticity. Combine its results with weight, dimensions, and other physical tests.

## Features

- Focused identification against a selected coin
- Six bundled gold and silver coin references
- Guided five-ping calibration for custom coins
- Automatic resonance extraction with manual frequency selection
- Portable profiles encoded in shareable URLs
- Local-only custom library—no account or upload required
- Live input meter, capture diagnostics, WAV playback, and download

## Run locally

Microphone APIs and ES modules require a secure context. `localhost` is considered secure:

```bash
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080) in a current Chromium, Safari, or Firefox browser and grant microphone access.

## Workflow

1. Choose **Identify** on a built-in coin. Listening starts automatically and every clean ping is tested against that reference.
2. If similarity to the selected coin is below 50%, the app checks other ready library profiles and may suggest an alternative.
3. If your coin is not listed, use **Add your coin** at the end of the Library.
4. Enter its name, capture five clean pings, and review the automatically selected frequencies. You can include or exclude occasional frequencies before choosing **Add to library**.
5. Calibration recordings are temporary. After creation, only the coin name and selected frequencies are saved.
6. Use **Share coin** on an identifier to share a portable URL containing its name and target frequencies. A recipient can identify against it immediately or choose **Add to library**.

## URL-based identifiers

Navigation is URL-based, so browser Back and Forward work normally. Local custom coins use `?coin=<id>`, and teaching screens use `?teach=<id>`. Those IDs refer to data in the current browser.

A portable identifier can be created without storing a coin by passing a name and at least two comma-separated frequencies in hertz:

```text
https://jfanals.github.io/coin-pinger/?name=My%20Coin&frequencies=5300,5420,12020
```

Opening that URL creates a temporary focused identifier with ±2% frequency tolerance. It is not saved automatically and no data is uploaded. Choose **Add to library** to retain its name and frequencies locally. Built-in and custom library links use this same simple format; when a link matches an existing coin, that local or bundled entry is restored automatically.

The **Maybe this is…** suggestion is also a link, so it opens the suggested coin’s focused identifier and creates a browser-history entry.

## Built-in references

The starter library includes Gold Sovereign, 1 oz Gold Krugerrand, 1 oz Gold American Eagle, 1 oz Gold Philharmonic, 1 oz Silver American Eagle, and 1 oz Silver Britannia. Their frequencies and tolerances are physics-model estimates adapted from Coin Pinger's MIT-licensed preset data—not an empirical universal database. Coin manufacture, year, wear, temperature, handling, and capture hardware can all affect results.

Reference images are local, reduced-resolution copies of public-domain, CC0, or Creative Commons images from Wikimedia Commons. Credits and source links appear on each coin's details page; full licensing information is in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Custom coin names and frequencies are stored in IndexedDB on the current device. Calibration audio exists only while creating a coin and is discarded after the final profile is added. Nothing is uploaded. Clearing browser site data deletes the custom library.

## Inspecting microphone captures

After every accepted or rejected attempt, the capture panel shows the measured duration, ring duration, input level, signal-to-noise ratio, resonance count, and microphone name. Use the built-in player to hear exactly what reached the browser, or **Download captured WAV** to inspect or share the raw attempt. Playback temporarily pauses microphone capture to prevent feedback and listening resumes when playback pauses or ends.

If pings are repeatedly rejected, check that the expected microphone is selected in the browser or macOS input settings, hold the coin near rather than against the MacBook, and compare the captured WAV with what you heard in the room.

## Analysis pipeline

- Requests mono audio with echo cancellation, noise suppression, and automatic gain control disabled.
- Measures ambient noise and uses an adaptive onset threshold.
- Keeps pre-roll and captures up to 2.8 seconds of the complete decay.
- Rejects quiet, clipped, noisy, short, or spectrally unstable events.
- Tracks FFT peaks over overlapping windows and clusters repeatable resonances.
- Builds specimen profiles from distributions across accepted recordings.
- Uses a confidence threshold so a focused test can return **Not a confident match**.

The displayed match is a similarity score, not an authenticity probability or guarantee. Acoustic testing should be combined with mass, dimensions, and other physical tests for authentication.
