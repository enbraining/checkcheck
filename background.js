importScripts('rules.js');

// ── Service Worker keep-alive (작업 중일 때만) ───────────────────
// MV3 SW는 idle 30초 / 최대 5분이면 종료된다. 평소엔 꺼져도 메시지가
// 오면 다시 깨어나므로 문제없지만, nara API는 텍스트를 청크·페이지로
// 나눠 여러 번 fetch 하므로 긴 글에서는 검사 도중 SW가 종료돼 응답이
// 유실될 수 있다. → 진행 중인 검사가 있는 동안에만 SW를 깨워둔다.
let activeChecks   = 0;
let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});   // SW idle 타이머 리셋
  }, 25 * 1000);
}

function stopKeepAlive() {
  if (activeChecks > 0 || !keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'checkSpelling') {
    activeChecks++;
    startKeepAlive();
    checkSpelling(message.text)
      .then(errors => { recordHistory(message.text, errors, sender); sendResponse({ errors }); })
      .catch(err => sendResponse({ error: err.message }))   // 포트가 닫힌 채 방치되지 않도록 항상 응답
      .finally(() => { activeChecks--; stopKeepAlive(); });
    return true;   // 비동기 응답 → 응답 전까지 메시지 포트(=SW) 유지
  }
});

// ── 검사 기록 저장 (chrome.storage.local) ───────────────────────
// SW 메모리가 아니라 storage에 저장하므로 SW가 종료돼도 기록이 유지된다.
const HISTORY_KEY = 'spellHistory';
const HISTORY_MAX = 50;

async function recordHistory(text, errors, sender) {
  const trimmed = (text || '').trim();
  if (!trimmed) return;

  // 출처: content script면 도메인, 팝업이면 '직접 입력'
  let src = '직접 입력';
  if (sender?.tab?.url) {
    try { src = new URL(sender.tab.url).hostname; } catch { src = '웹페이지'; }
  }

  // 교정 후 텍스트: 원문에 모든 오류 교정을 적용 (긴 단어 먼저: 부분 겹침 방지)
  let corrected = trimmed;
  const seenWrong = new Set();
  const applied = errors
    .filter(e => e.wrong && e.correct && !seenWrong.has(e.wrong) && seenWrong.add(e.wrong))
    .sort((a, b) => b.wrong.length - a.wrong.length);
  for (const e of applied) corrected = corrected.split(e.wrong).join(e.correct);

  const entry = {
    ts: Date.now(),
    text: trimmed.slice(0, 300),         // 검사 전 원문
    corrected: corrected.slice(0, 300),  // 교정 후 결과
    errorCount: errors.length,
    errors: errors.slice(0, 30).map(e => ({ wrong: e.wrong, correct: e.correct })),
    src,
  };

  const { [HISTORY_KEY]: history = [] } = await chrome.storage.local.get(HISTORY_KEY);

  const prev = history[0];
  const recent = prev && prev.src === src && (entry.ts - prev.ts < 3 * 60 * 1000);

  // 방금 적용한 교정 결과를 재검사한 것 → 바로 위 항목의 '후'와 동일하므로 기록 안 함
  if (recent && prev.corrected === entry.text) return;

  // 같은 출처에서 이어 친 텍스트(타이핑 진행)는 한 항목으로 합쳐 폭주 방지
  const isTypingProgress = recent &&
    (entry.text.startsWith(prev.text) || prev.text.startsWith(entry.text));

  if (isTypingProgress) history[0] = entry;
  else history.unshift(entry);

  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

// ── 메인 검사 함수 ───────────────────────────────────────────────
async function checkSpelling(text) {
  // 1. nara-speller API 시도
  try {
    const errors = await checkNara(text);
    return errors;
  } catch (e) {
    console.warn('[KSC] nara-speller 실패, 규칙 검사로 대체:', e.message);
  }

  // 2. API 실패 시 규칙 기반 검사
  return checkRules(text);
}

// ── nara-speller.co.kr API ──────────────────────────────────────
async function checkNara(text) {
  const chunks = splitText(text.trim(), 500);
  const all = [];
  for (const chunk of chunks) {
    const errors = await fetchNara(chunk);
    all.push(...errors);
  }
  return all;
}

async function fetchNara(text, page = 1) {
  const res = await fetch('https://nara-speller.co.kr/api/check', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Referer':      'https://nara-speller.co.kr/speller/',
      'Origin':       'https://nara-speller.co.kr',
    },
    body: JSON.stringify({ text, page }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  const errors = parseNara(data);

  // 페이지가 여러 개면 나머지 페이지도 가져옴
  if (data.totalPageCnt > page) {
    const next = await fetchNara(text, page + 1);
    errors.push(...next);
  }

  return errors;
}

function parseNara(data) {
  if (!Array.isArray(data.errInfo)) return [];

  return data.errInfo
    .filter(e => e.orgStr && e.candWord)
    .map(e => {
      const correct = e.candWord.split(/[|,]/)[0].trim();
      return {
        wrong:   e.orgStr.trim(),
        correct: correct,
        help:    stripHtml(e.help ?? ''),
      };
    })
    .filter(e => e.wrong && e.correct && e.wrong !== e.correct);
}

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── 규칙 기반 검사 (API 실패 시 폴백) ────────────────────────────
function checkRules(text) {
  const found = new Map();
  for (const rule of RULES) {
    if (!rule.w || !rule.c || rule.w === rule.c) continue;
    const escaped = rule.w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!found.has(rule.w))
        found.set(rule.w, { wrong: rule.w, correct: rule.c, help: rule.h ?? '' });
    }
  }
  return [...found.values()];
}

// ── 텍스트 분할 ───────────────────────────────────────────────────
function splitText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size)
    chunks.push(text.slice(i, i + size));
  return chunks;
}
