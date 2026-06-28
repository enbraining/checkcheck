importScripts('rules.js');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'checkSpelling') {
    checkSpelling(message.text).then(errors => sendResponse({ errors }));
    return true;
  }
});

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
