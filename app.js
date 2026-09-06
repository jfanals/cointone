import { getAll, put, remove, deleteCoinAndRecordings } from './db.js';
import { PingCapture } from './audio.js';
import { analyzePing, buildProfile, matchProfile, encodeWav } from './dsp.js';
import { REFERENCE_COINS } from './references.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const uid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
const formatHz = frequency => frequency >= 1000 ? `${(frequency / 1000).toFixed(2)} kHz` : `${Math.round(frequency)} Hz`;
const relevantResonances = features => features?.resonances?.filter(item => item.frequency >= 2000) || [];
const TRAINING_TARGET = 5;

let coins = [];
let recordings = [];
let activeCapture = null;
let captureMode = null;
let focusedAttempts = [];
let detailCoinId = null;
let transientCoin = null;
let teachingDraft = null;
let draftRecordings = [];
let toastTimer;
const diagnosticUrls = { teach: null, detail: null };

function toast(message, error = false) {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.className = 'toast', 3600);
}

function coinById(coinId) {
  return coins.find(item => item.id === coinId) || (transientCoin?.id === coinId ? transientCoin : null);
}

function coinRecordings(coinId) {
  if (teachingDraft?.id === coinId) return draftRecordings;
  return recordings.filter(recording => recording.coinId === coinId && recording.features?.quality?.accepted);
}

function profileFor(coinId) {
  const coin = coinById(coinId);
  if (coin?.referenceProfile) return coin.referenceProfile;
  return buildProfile(coinRecordings(coinId), coin?.includedFrequencies);
}

function profileIsReady(coin, profile = profileFor(coin.id)) {
  return Boolean(profile && profile.resonances.length >= 2 &&
    (profile.isReference || profile.sampleCount >= TRAINING_TARGET));
}

function coinImageMarkup(coin, detail = false) {
  if (!coin.image) return '';
  const attribution = detail
    ? `<a class="image-credit" href="${escapeHtml(coin.image.source)}" target="_blank" rel="noreferrer">${escapeHtml(coin.image.credit)} · ${escapeHtml(coin.image.license)}</a>`
    : '';
  return `<figure class="coin-image ${detail ? 'detail-image' : ''}"><img src="${escapeHtml(coin.image.path)}" alt="${escapeHtml(coin.image.alt)}">${attribution}</figure>`;
}

function showView(name) {
  $$('.view').forEach(view => view.classList.toggle('active', view.id === `${name}-view`));
  if (name !== captureMode) stopCapture();
  if (name === 'teach') renderTeach();
  if (name === 'library') renderLibrary();
}

function frequenciesParam(coin) {
  return profileFor(coin.id).resonances.map(item => Number(item.frequency.toFixed(2))).join(',');
}

function frequencyTargetUrl(coin) {
  const params = new URLSearchParams({
    name: coin.name,
    frequencies: frequenciesParam(coin)
  });
  return `${location.pathname}?${params}`;
}

function identifyUrl(coin) {
  return frequencyTargetUrl(coin);
}

function teachUrl(coinId) {
  return `${location.pathname}?teach=${encodeURIComponent(coinId)}`;
}

function navigate(url, replace = false) {
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
  applyRoute();
}

function navigateLibrary(replace = false) {
  navigate(location.pathname, replace);
}

function followInternalLink(event, url) {
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(url);
}

function renderLibrary() {
  const grid = $('#coin-grid');
  grid.replaceChildren();
  if (!coins.length) {
    grid.innerHTML = '<div class="card empty"><strong>No coin profiles yet</strong>Add your first specimen, then record several pings to teach its acoustic signature.</div>';
    return;
  }
  coins.slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt)).forEach(coin => {
    const profile = profileFor(coin.id);
    const card = document.createElement('article');
    card.className = 'card coin-card';
    const ready = profileIsReady(coin, profile);
    const status = ready ? 'Saved coin' : 'Calibration incomplete';
    card.innerHTML = `
      ${coinImageMarkup(coin)}
      ${coin.builtIn ? '' : `<span class="badge ${ready ? '' : 'warn'}">${status}</span>`}
      <h3>${escapeHtml(coin.name)}</h3>
      <div class="resonances">${profile.resonances.slice(0,4).map(r => `<span class="resonance">${formatHz(r.frequency)}</span>`).join('') || '<span class="hint">No stable resonances yet</span>'}</div>
      <div class="actions">${ready ? `<a class="btn primary identify-card" href="${escapeHtml(identifyUrl(coin))}">Identify</a>` : `<a class="btn primary teach-card" href="${escapeHtml(teachUrl(coin.id))}">Finish calibration</a>`}</div>`;
    const identifyLink = card.querySelector('.identify-card');
    if (identifyLink) identifyLink.onclick = event => followInternalLink(event, identifyLink.href);
    const teachLink = card.querySelector('.teach-card');
    if (teachLink) teachLink.onclick = event => followInternalLink(event, teachLink.href);
    grid.appendChild(card);
  });
}

function openTeach(coinId) {
  const coin = teachingDraft?.id === coinId
    ? teachingDraft
    : coins.find(item => item.id === coinId && !item.builtIn && !item.referenceProfile);
  if (!coin) return false;
  detailCoinId = coinId;
  transientCoin = teachingDraft?.id === coinId ? teachingDraft : null;
  document.title = `Create ${coin.name} — CoinTone`;
  showView('teach');
  return true;
}

function renderTeach() {
  const selected = detailCoinId;
  const items = coinRecordings(selected).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const coin = teachingDraft?.id === selected ? teachingDraft : coins.find(item => item.id === selected && !item.builtIn);
  const profile = buildProfile(items, coin?.includedFrequencies);
  $('#teach-title').textContent = coin ? `Create ${coin.name}` : 'Create your coin';
  $('#teach-coin-name').textContent = coin?.name || 'No coin selected';
  $('#teach-coin-meta').textContent = coin
    ? 'Calibrate its acoustic profile before adding it to your library.'
    : 'Return to the library and create a coin.';
  $('#teach-count').textContent = `${Math.min(items.length, TRAINING_TARGET)} / ${TRAINING_TARGET}`;
  $('#teach-progress').style.width = `${Math.min(100, items.length / TRAINING_TARGET * 100)}%`;
  $('#teach-frequencies').innerHTML = profile.candidates.map(item => {
    const support = Math.round(item.support * 100);
    const status = item.automatic ? 'Common' : item.manuallyIncluded ? 'Included' : 'Observed';
    return `<label class="frequency-choice ${item.selected ? 'selected' : ''}">
      <input type="checkbox" data-frequency="${item.frequency}" ${item.selected ? 'checked' : ''} ${item.automatic ? 'disabled' : ''}>
      <span><b>${formatHz(item.frequency)}</b><small>${support}% · ${item.occurrences}/${items.length} readings · ${status}</small></span>
    </label>`;
  }).join('') || '<span class="hint">No frequencies detected yet.</span>';
  $$('#teach-frequencies input:not(:disabled)').forEach(input => input.onchange = () => setFrequencyIncluded(selected, Number(input.dataset.frequency), input.checked));
  const automaticCount = profile.candidates.filter(item => item.automatic).length;
  const manualCount = profile.candidates.filter(item => item.manuallyIncluded && !item.automatic).length;
  $('#teach-frequency-help').textContent = items.length < 2
    ? 'All detected frequencies are shown. Add another reading to find the common ones.'
    : `${automaticCount} selected automatically at 80% support${manualCount ? `; ${manualCount} included by you` : ''}. Select an occasional frequency to keep it in the learned profile.`;
  const canFinish = items.length >= TRAINING_TARGET && profile.resonances.length >= 2;
  $('#finish-teach').disabled = !canFinish;
  $('#finish-teach-help').textContent = canFinish
    ? `${profile.resonances.length} frequencies selected. Add this coin to your library when ready.`
    : `Complete ${Math.max(0, TRAINING_TARGET - items.length)} more accepted reading${TRAINING_TARGET - items.length === 1 ? '' : 's'} and select at least two frequencies.`;
  $('#teach-start').disabled = !coin;
}

function setCaptureUI(mode, state) {
  const orb = $(`#${mode}-orb`), status = $(`#${mode}-status`), copy = $(`#${mode}-copy`);
  if (!orb || !status || !copy) return;
  orb.className = `mic-orb ${state === 'recording' ? 'recording' : ['calibrating','listening','cooldown'].includes(state) ? 'listening' : ''}`;
  const idleCopy = mode === 'teach'
    ? 'We will first measure the room, then automatically capture the complete ring.'
    : 'Microphone access starts automatically while this coin identifier is open.';
  const messages = {
    idle: [mode === 'detail' ? 'Starting microphone…' : 'Ready to listen', idleCopy],
    calibrating: ['Measuring the room…', 'Stay quiet for a moment while we establish the ambient noise floor.'],
    listening: ['Listening for a ping', 'Ping the coin once. Capture begins automatically.'],
    recording: ['Capturing the ring…', 'Let the sound decay naturally; do not make another impact yet.'],
    cooldown: ['Analyzing reading…', 'Extracting stable resonances and checking recording quality.']
  };
  [status.textContent, copy.textContent] = messages[state] || messages.idle;
}

async function startCapture(mode) {
  if (activeCapture) return;
  if (mode === 'teach' && teachingDraft?.id !== detailCoinId && !coins.some(coin => coin.id === detailCoinId && !coin.builtIn && !coin.referenceProfile)) return toast('Create a coin first.', true);
  if (mode === 'detail') {
    const profile = profileFor(detailCoinId);
    if (!profile || (!profile.isReference && profile.sampleCount < TRAINING_TARGET) || profile.resonances.length < 2) {
      return toast('Teach this coin with five accepted readings before identifying it.', true);
    }
  }
  captureMode = mode;
  const start = $(`#${mode}-start`), stop = $(`#${mode}-stop`);
  if (start) start.hidden = true;
  if (stop) stop.hidden = false;
  activeCapture = new PingCapture({
    onState: state => setCaptureUI(mode, state),
    onLevel: level => $(`#${mode}-level`).style.width = `${Math.round(level * 100)}%`,
    onPing: payload => handlePing(mode, payload),
    onError: error => toast(microphoneMessage(error), true)
  });
  try { await activeCapture.start(); }
  catch {
    if (start) start.hidden = false;
    if (stop) stop.hidden = true;
    activeCapture = null; captureMode = null;
    setCaptureUI(mode, 'idle');
  }
}

function microphoneMessage(error) {
  if (!window.isSecureContext) return 'Microphone capture requires HTTPS or localhost.';
  if (error?.name === 'NotAllowedError') return 'Microphone permission was denied. Allow access in your browser settings.';
  return `Could not start the microphone: ${error?.message || 'unknown error'}`;
}

async function stopCapture() {
  if (!activeCapture) return;
  const mode = captureMode;
  const capture = activeCapture;
  activeCapture = null; captureMode = null;
  await capture.stop();
  if (mode) {
    const start = $(`#${mode}-start`), stop = $(`#${mode}-stop`);
    if (start) start.hidden = false;
    if (stop) stop.hidden = true;
    setCaptureUI(mode, 'idle');
  }
}

function pauseCaptureDuringPlayback(audio, mode) {
  let stopPromise = Promise.resolve();
  audio.addEventListener('play', () => { stopPromise = stopCapture(); });
  const resume = async () => {
    await stopPromise;
    if (mode === 'detail' && $('#detail-view').classList.contains('active') && !activeCapture) startCapture('detail');
  };
  audio.addEventListener('ended', resume);
  audio.addEventListener('pause', () => setTimeout(resume, 0));
}

function renderDiagnostic(mode, payload, features) {
  const panel = $(`#${mode}-diagnostic`);
  if (diagnosticUrls[mode]) URL.revokeObjectURL(diagnosticUrls[mode]);
  const wav = encodeWav(payload.samples, payload.sampleRate);
  const url = URL.createObjectURL(wav);
  diagnosticUrls[mode] = url;
  const quality = features.quality;
  const heading = document.createElement('h4');
  heading.textContent = quality.accepted ? 'Last capture · accepted' : 'Last capture · rejected';
  const summary = document.createElement('p');
  summary.className = quality.accepted ? 'diagnostic-status good' : 'diagnostic-status bad';
  summary.textContent = quality.accepted ? 'This recording passed all checks.' : quality.reasons.join(' · ');
  const stats = document.createElement('div');
  stats.className = 'diagnostic-stats';
  const values = [
    ['Captured', `${(payload.samples.length / payload.sampleRate).toFixed(2)} s`],
    ['Measured ring', `${quality.ringDuration.toFixed(2)} s`],
    ['Peak', `${(quality.peak * 100).toFixed(1)}%`],
    ['Signal / noise', `${quality.snrDb.toFixed(1)} dB`],
    ['Resonances', String(relevantResonances(features).length)],
    ['Input', payload.metadata.device || 'Default microphone']
  ];
  values.forEach(([label, value]) => {
    const item = document.createElement('span');
    const name = document.createElement('small'); name.textContent = label;
    const content = document.createElement('b'); content.textContent = value;
    item.append(name, content); stats.appendChild(item);
  });
  const resonanceHeading = document.createElement('h4');
  resonanceHeading.textContent = 'Frequencies found';
  const resonances = document.createElement('div');
  resonances.className = 'resonances';
  resonances.innerHTML = relevantResonances(features).map(item => `<span class="resonance">${formatHz(item.frequency)}</span>`).join('') || '<span class="hint">No stable frequencies found.</span>';
  const audio = document.createElement('audio');
  audio.controls = true; audio.preload = 'metadata'; audio.src = url;
  pauseCaptureDuringPlayback(audio, mode);
  const download = document.createElement('a');
  download.className = 'btn diagnostic-download'; download.href = url;
  download.download = `resonance-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
  download.textContent = 'Download captured WAV';
  const help = document.createElement('p');
  help.className = 'hint';
  help.textContent = 'Play this back to hear exactly what the app received. Playback stops microphone capture to prevent feedback.';
  panel.replaceChildren(heading, summary, stats, resonanceHeading, resonances, audio, download, help);
  panel.hidden = false;
}

async function handlePing(mode, payload) {
  const features = analyzePing(payload.samples, payload.sampleRate);
  renderDiagnostic(mode, payload, features);
  if (!features.quality.accepted) {
    toast(`Reading rejected: ${features.quality.reasons.join(', ')}. Try again.`, true);
    return;
  }
  if (mode === 'teach') {
    const coinId = detailCoinId;
    const coin = teachingDraft?.id === coinId ? teachingDraft : coins.find(item => item.id === coinId && !item.builtIn && !item.referenceProfile);
    if (!coin) return;
    const record = {
      id: uid(), coinId, createdAt: new Date().toISOString(), sampleRate: payload.sampleRate,
      duration: payload.samples.length / payload.sampleRate, metadata: payload.metadata,
      features, wav: encodeWav(payload.samples, payload.sampleRate), algorithmVersion: 1
    };
    if (teachingDraft?.id === coinId) draftRecordings.push(record);
    else {
      await put('recordings', record);
      recordings.push(record);
    }
    renderTeach();
    toast(`Accepted: ${relevantResonances(features).length} stable resonances found.`);
  } else if (mode === 'detail') {
    const outcome = identifyPing(features, detailCoinId);
    focusedAttempts.unshift({ id: uid(), features, payload, outcome, capturedAt: new Date().toISOString() });
    renderFocusedReadings();
    renderFocusedResult(outcome);
    const coin = coinById(detailCoinId);
    toast(outcome.accepted
      ? `This ping matches ${coin.name} (${outcome.best.score}%).`
      : outcome.suggestion
        ? `Not ${coin.name}; maybe ${outcome.suggestion.coin.name} (${outcome.suggestion.score}%).`
        : `This ping does not confidently match ${coin.name}.`);
  }
}

function identifyPing(features, coinId) {
  const coin = coinById(coinId);
  if (!coin) return { unavailable: true, accepted: false };
  const profile = profileFor(coinId);
  if (!profileIsReady(coin, profile)) return { unavailable: true, accepted: false };
  const best = { coin, profile, ...matchProfile(features, profile) };
  let suggestion = null;
  if (best.score < 50) {
    suggestion = coins
      .filter(item => item.id !== coinId)
      .map(item => ({ coin: item, profile: profileFor(item.id) }))
      .filter(item => profileIsReady(item.coin, item.profile))
      .map(item => ({ ...item, ...matchProfile(features, item.profile) }))
      .filter(item => item.score >= 50 && item.matched >= 2)
      .sort((a, b) => b.score - a.score)[0] || null;
  }
  return { best, suggestion, accepted: best.score >= 62 && best.matched >= 2, focused: true };
}

function renderFocusedResult(outcome, label = 'Last ping') {
  const result = $('#detail-result');
  if (!result || !outcome) return;
  if (outcome.unavailable) {
    result.innerHTML = `<div class="result unknown"><span class="badge warn">${escapeHtml(label)}</span><h4>Profile not ready</h4><p>Teach this coin before trying to identify it.</p></div>`;
    return;
  }
  const { best, accepted, suggestion } = outcome;
  const suggestionMarkup = suggestion ? `<a class="possible-match" href="${escapeHtml(identifyUrl(suggestion.coin))}">
    ${suggestion.coin.image ? `<img src="${escapeHtml(suggestion.coin.image.path)}" alt="">` : ''}
    <span><small>Possible alternative</small><b>Maybe this is ${escapeHtml(suggestion.coin.name)}</b><small>${suggestion.score}% similarity · ${suggestion.matched} resonances matched · Open identifier →</small></span>
  </a>` : '';
  result.innerHTML = `<div class="result ${accepted ? '' : 'unknown'}">
    <span class="badge ${accepted ? '' : 'warn'}">${escapeHtml(label)}</span>
    <h4>${accepted ? `Matches ${escapeHtml(best.coin.name)}` : `Not a confident match`}</h4>
    <div class="score">${best.score}%</div>
    <p>${best.matched} of ${best.profile.resonances.length} profile resonances matched.</p>
    ${suggestionMarkup}
    <p class="hint">Primarily compared with ${escapeHtml(best.coin.name)}. If similarity is below 50%, other ready profiles are checked for a possible alternative. Scores are not proof of authenticity.</p>
  </div>`;
  const suggestionLink = result.querySelector('.possible-match');
  if (suggestionLink) suggestionLink.onclick = event => followInternalLink(event, suggestionLink.href);
}

function renderFocusedReadings() {
  const list = $('#detail-identify-readings');
  if (!list) return;
  list.innerHTML = focusedAttempts.map((attempt, index) => {
    const suggestion = attempt.outcome.suggestion;
    const title = attempt.outcome.accepted ? 'Match' : suggestion ? `Maybe ${suggestion.coin.name}` : 'Not a match';
    const score = attempt.outcome.accepted ? attempt.outcome.best?.score : suggestion?.score || attempt.outcome.best?.score || 0;
    return `<button class="reading reading-button inspect-focused" data-id="${attempt.id}">${suggestion?.coin.image ? `<img class="reading-coin-image" src="${escapeHtml(suggestion.coin.image.path)}" alt="">` : ''}<span class="reading-summary"><b>${escapeHtml(title)}</b><small>${score}% similarity</small></span><span class="reading-number">Ping ${focusedAttempts.length - index}</span></button>`;
  }).join('') || '<p class="hint">No pings tested against this coin yet.</p>';
  $$('#detail-identify-readings .inspect-focused').forEach(button => button.onclick = () => inspectFocusedAttempt(button.dataset.id));
}

function inspectFocusedAttempt(attemptId) {
  const attempt = focusedAttempts.find(item => item.id === attemptId);
  if (!attempt) return;
  const number = focusedAttempts.length - focusedAttempts.indexOf(attempt);
  renderFocusedResult(attempt.outcome, `Ping ${number}`);
  renderDiagnostic('detail', attempt.payload, attempt.features);
  $('#detail-result')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function showDetail(coinId) {
  if (detailCoinId !== coinId) {
    await stopCapture();
    focusedAttempts = [];
  }
  detailCoinId = coinId;
  const coin = coinById(coinId);
  if (!coin) return;
  document.title = `Identify ${coin.name} — CoinTone`;
  const items = coinRecordings(coinId).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const profile = profileFor(coinId);
  const learned = buildProfile(items, coin.includedFrequencies);
  const ready = profile.isReference || (profile.sampleCount >= TRAINING_TARGET && profile.resonances.length >= 2);
  $('#detail-content').innerHTML = `
    <div class="hero detail-head"><div><h2>Identify ${escapeHtml(coin.name)}</h2><p>Test each ping only against this coin’s acoustic profile.</p></div><div>${coin.urlOnly ? '<button id="add-shared-coin" class="btn primary">Add to library</button> ' : ''}<button id="copy-identify-link" class="btn" ${ready ? '' : 'disabled'}>Share coin</button></div></div>
    <div class="flow detail-identify">
      <section class="card capture" aria-live="polite">
        <div id="detail-orb" class="mic-orb"><span class="mic-icon">⌁</span></div>
        <h3 id="detail-status">${ready ? 'Starting microphone…' : 'Profile not ready'}</h3>
        <p id="detail-copy" class="capture-copy">${ready ? 'Listening starts automatically. Ping the coin whenever you are ready.' : `Complete ${TRAINING_TARGET} accepted teaching readings before identification.`}</p>
        <div class="meter"><span id="detail-level"></span></div>
        <p class="listening-note">${ready ? '● Microphone stays active while this page is open' : 'Microphone is inactive'}</p>
        <div id="detail-result" class="latest-result"></div>
        <div id="detail-diagnostic" class="diagnostic" hidden></div>
      </section>
      <aside class="card focused-profile">
        ${coinImageMarkup(coin, true)}
        <h3>${escapeHtml(coin.name)}</h3>
        <p class="hint">${ready ? 'Results here are not affected by similar coins elsewhere in your library.' : `Complete ${TRAINING_TARGET} accepted teaching readings before identification.`}</p>
        <div class="resonances">${profile.resonances.map(r => `<span class="resonance">${formatHz(r.frequency)}</span>`).join('') || '<span class="hint">No learned frequencies yet.</span>'}</div>
        <h4>Recent tests</h4>
        <div id="detail-identify-readings" class="readings"></div>
      </aside>
    </div>
    <div class="card"><h3>Target frequencies</h3><div class="resonances">${profile.resonances.map(r => `<span class="resonance">${formatHz(r.frequency)}${r.tolerance ? ` · ±${(r.tolerance * 100).toFixed(1)}%` : ''}</span>`).join('')}</div><p class="hint">This identifier stores only the coin name and target frequencies.</p></div>
    ${!coin.builtIn && !coin.urlOnly ? '<div class="detail-footer-actions"><button id="delete-profile" class="btn danger">Delete</button></div>' : ''}`;
  $('#copy-identify-link').onclick = async () => {
    try {
      await navigator.clipboard.writeText(new URL(frequencyTargetUrl(coin), location.href).href);
      toast('Shareable frequency identifier link copied.');
    } catch {
      toast('Could not copy automatically. Copy the URL from the address bar.', true);
    }
  };
  const addButton = $('#add-shared-coin');
  if (addButton) addButton.onclick = () => addSharedCoin(coin);
  const deleteButton = $('#delete-profile');
  if (deleteButton) deleteButton.onclick = () => deleteProfile(coin);
  renderFocusedReadings();
  showView('detail');
  if (ready) await startCapture('detail');
}

async function setFrequencyIncluded(coinId, frequency, included) {
  const coin = teachingDraft?.id === coinId ? teachingDraft : coins.find(item => item.id === coinId);
  if (!coin || coin.builtIn) return;
  const current = coin.includedFrequencies || [];
  const tolerance = Math.max(45, frequency * .012);
  coin.includedFrequencies = included
    ? [...current.filter(item => Math.abs(item - frequency) > tolerance), frequency]
    : current.filter(item => Math.abs(item - frequency) > tolerance);
  if (teachingDraft?.id !== coinId) await put('coins', coin);
  renderTeach();
  toast(included ? `${formatHz(frequency)} added to the learned profile.` : `${formatHz(frequency)} removed from the learned profile.`);
}

function profileFromFrequencies(frequencies, consistency = 'Saved') {
  return {
    isReference: true,
    sampleCount: 0,
    consistency,
    resonances: frequencies.map(frequency => ({ frequency, tolerance: .02, support: 1, strength: 1, decay: null }))
  };
}

async function finishTeaching() {
  const coin = teachingDraft?.id === detailCoinId ? teachingDraft : coins.find(item => item.id === detailCoinId);
  if (!coin) return;
  const items = coinRecordings(coin.id);
  const profile = buildProfile(items, coin.includedFrequencies);
  if (items.length < TRAINING_TARGET || profile.resonances.length < 2) return toast('Complete five readings and select at least two frequencies first.', true);
  await stopCapture();
  const saved = {
    id: coin.id,
    name: coin.name,
    createdAt: coin.createdAt || new Date().toISOString(),
    referenceProfile: profileFromFrequencies(profile.resonances.map(item => Number(item.frequency.toFixed(2))))
  };
  await put('coins', saved);
  if (!coins.some(item => item.id === saved.id)) coins.push(saved);
  else coins = coins.map(item => item.id === saved.id ? saved : item);
  const oldRecordings = recordings.filter(item => item.coinId === saved.id);
  await Promise.all(oldRecordings.map(item => remove('recordings', item.id)));
  recordings = recordings.filter(item => item.coinId !== saved.id);
  teachingDraft = null;
  draftRecordings = [];
  transientCoin = null;
  renderLibrary();
  navigate(identifyUrl(saved), true);
  toast(`${saved.name} was added to your library.`);
}

async function addSharedCoin(coin) {
  const frequencies = profileFor(coin.id).resonances.map(item => Number(item.frequency.toFixed(2)));
  const saved = {
    id: uid(),
    name: coin.name,
    createdAt: new Date().toISOString(),
    referenceProfile: profileFromFrequencies(frequencies, 'Shared')
  };
  await put('coins', saved);
  coins.push(saved);
  transientCoin = null;
  detailCoinId = saved.id;
  renderLibrary();
  navigate(identifyUrl(saved), true);
  toast(`${saved.name} was added to your library.`);
}

async function deleteProfile(coin) {
  const action = coin.builtIn ? 'Hide' : 'Delete';
  if (!confirm(`${action} “${coin.name}” and delete all of its recordings? This cannot be undone.`)) return;
  await deleteCoinAndRecordings(coin.id);
  if (coin.builtIn) {
    const hidden = new Set(JSON.parse(localStorage.getItem('resonance-hidden-references') || '[]'));
    hidden.add(coin.id);
    localStorage.setItem('resonance-hidden-references', JSON.stringify([...hidden]));
  }
  coins = coins.filter(item => item.id !== coin.id);
  recordings = recordings.filter(item => item.coinId !== coin.id);
  detailCoinId = null; renderLibrary(); navigateLibrary(true); toast('Coin profile deleted.');
}

function wireEvents() {
  $('#new-coin').onclick = () => { $('#coin-form').reset(); $('#coin-dialog').showModal(); };
  $('#close-dialog').onclick = $('#cancel-dialog').onclick = () => $('#coin-dialog').close();
  $('#coin-form').onsubmit = async event => {
    event.preventDefault();
    if (!$('#coin-name').value.trim()) return;
    const coin = {
      id: uid(), name: $('#coin-name').value.trim(), includedFrequencies: [], createdAt: new Date().toISOString()
    };
    teachingDraft = coin;
    draftRecordings = [];
    $('#coin-form').reset();
    $('#coin-dialog').close();
    navigate(teachUrl(coin.id));
    toast('Make five clean pings, then add the coin to your library.');
  };
  $('#teach-start').onclick = () => startCapture('teach');
  $('#teach-stop').onclick = stopCapture;
  $('#finish-teach').onclick = finishTeaching;
  $('#teach-back').onclick = $('#detail-back').onclick = () => navigateLibrary();
  window.addEventListener('popstate', applyRoute);
  window.addEventListener('beforeunload', () => {
    activeCapture?.stop();
    Object.values(diagnosticUrls).forEach(url => url && URL.revokeObjectURL(url));
  });
}

function coinFromUrl(params) {
  const name = (params.get('name') || '').trim().slice(0, 100);
  const frequencies = (params.get('frequencies') || '')
    .split(',')
    .map(Number)
    .filter(value => Number.isFinite(value) && value >= 2000 && value <= 24000)
    .slice(0, 12);
  if (!name || frequencies.length < 2) return null;

  const existing = coins.find(coin => {
    if (coin.name !== name) return false;
    const known = profileFor(coin.id).resonances.map(item => Number(item.frequency.toFixed(2)));
    return known.length === frequencies.length && known.every((value, index) => value === frequencies[index]);
  });
  if (existing) return existing;

  return {
    id: `url-${name}-${frequencies.join('-')}`,
    name,
    specimenId: 'Shared frequency target',
    year: '',
    createdAt: new Date(0).toISOString(),
    builtIn: false,
    urlOnly: true,
    referenceProfile: {
      isReference: true,
      sampleCount: 0,
      consistency: 'URL target',
      resonances: frequencies.map(frequency => ({ frequency, tolerance: .02, support: 1, strength: 1, decay: null }))
    }
  };
}

async function applyRoute() {
  const params = new URLSearchParams(location.search);
  const teachId = params.get('teach');
  if (teachId) {
    if (!openTeach(teachId)) {
      navigateLibrary(true);
      toast('That teach profile is not available on this device.', true);
    }
    return;
  }

  const coinId = params.get('coin');
  if (coinId) {
    transientCoin = null;
    if (coins.some(coin => coin.id === coinId)) await showDetail(coinId);
    else {
      navigateLibrary(true);
      toast('That coin is not available on this device.', true);
    }
    return;
  }

  const urlCoin = coinFromUrl(params);
  if (urlCoin) {
    transientCoin = urlCoin.urlOnly ? urlCoin : null;
    await showDetail(urlCoin.id);
    return;
  }

  transientCoin = null;
  detailCoinId = null;
  document.title = 'CoinTone — identify coins by sound';
  showView('library');
}

function showMobileWarning() {
  const userAgent = navigator.userAgent || '';
  const mobile = navigator.userAgentData?.mobile === true ||
    /Android|iPhone|iPod|Windows Phone|IEMobile|BlackBerry|Opera Mini/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1);
  if (!mobile) return;

  const warning = $('#mobile-warning');
  if (typeof warning.showModal === 'function') warning.showModal();
  else warning.setAttribute('open', '');
}

async function init() {
  showMobileWarning();
  try {
    let [savedCoins, savedRecordings] = await Promise.all([getAll('coins'), getAll('recordings')]);
    // Compact profiles created by earlier versions: preserve the selected
    // acoustic signature, then remove calibration audio and specimen metadata.
    for (const coin of savedCoins.filter(item => !item.referenceProfile)) {
      const items = savedRecordings.filter(item => item.coinId === coin.id && item.features?.quality?.accepted);
      const learned = buildProfile(items, coin.includedFrequencies);
      if (learned.sampleCount < TRAINING_TARGET || learned.resonances.length < 2) continue;
      const compact = {
        id: coin.id,
        name: coin.name,
        createdAt: coin.createdAt,
        referenceProfile: profileFromFrequencies(learned.resonances.map(item => Number(item.frequency.toFixed(2))))
      };
      await put('coins', compact);
      await Promise.all(items.map(item => remove('recordings', item.id)));
      savedCoins = savedCoins.map(item => item.id === coin.id ? compact : item);
      savedRecordings = savedRecordings.filter(item => item.coinId !== coin.id);
    }
    const hidden = new Set(JSON.parse(localStorage.getItem('resonance-hidden-references') || '[]'));
    coins = [...savedCoins, ...REFERENCE_COINS.filter(coin => !hidden.has(coin.id))];
    recordings = savedRecordings;
    wireEvents();
    renderLibrary();
    await applyRoute();
  } catch (error) {
    console.error(error); toast('Could not open local storage. Check browser privacy settings.', true);
  }
}
init();
