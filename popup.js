const inputText = document.getElementById('inputText');
const charCount = document.getElementById('charCount');
const checkBtn = document.getElementById('checkBtn');
const clearBtn = document.getElementById('clearBtn');
const loadInputBtn = document.getElementById('loadInputBtn');
const activeInputBanner = document.getElementById('activeInputBanner');
const activeInputLabel = document.getElementById('activeInputLabel');
const applyBtn = document.getElementById('applyBtn');
const loading = document.getElementById('loading');
const results = document.getElementById('results');
const resultText = document.getElementById('resultText');
const errorList = document.getElementById('errorList');
const errorCount = document.getElementById('errorCount');
const historyList = document.getElementById('historyList');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const autoCheckToggle = document.getElementById('autoCheckToggle');

let activeTab = null;
let hasActiveInput = false;
let correctedText = '';

// ── 웹페이지 자동 검사 on/off ─────────────────────────────────────
const AUTO_CHECK_KEY = 'autoCheckEnabled';

async function loadAutoCheckSetting() {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  const data = await chrome.storage.local.get(AUTO_CHECK_KEY);
  autoCheckToggle.checked = data[AUTO_CHECK_KEY] !== false;
}

autoCheckToggle.addEventListener('change', () => {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  chrome.storage.local.set({ [AUTO_CHECK_KEY]: autoCheckToggle.checked });
});

loadAutoCheckSetting();

// 팝업 열릴 때 활성 탭의 포커스된 인풋 확인
(async () => {
  if (typeof chrome === 'undefined' || !chrome.tabs) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  try {
    chrome.tabs.sendMessage(tab.id, { action: 'getActiveInput' }, (res) => {
      if (chrome.runtime.lastError || !res?.found) return;
      hasActiveInput = true;
      activeInputLabel.textContent = `입력창 감지됨 (${res.tag ?? 'INPUT'})`;
      activeInputBanner.classList.remove('hidden');
      if (res.text?.trim()) {
        inputText.value = res.text;
        charCount.textContent = res.text.length;
      }
    });
  } catch (_) {}
})();

inputText.addEventListener('input', () => {
  charCount.textContent = inputText.value.length;
});

// ── 검사 기록 ──────────────────────────────────────────────────
const HISTORY_KEY = 'spellHistory';

async function loadHistory() {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  const data = await chrome.storage.local.get(HISTORY_KEY);
  renderHistory(data[HISTORY_KEY] || []);
}

function renderHistory(history) {
  if (!history.length) {
    historyList.innerHTML = '<div class="history-empty">아직 검사 기록이 없습니다.</div>';
    return;
  }
  historyList.innerHTML = history.map((h, i) => {
    const hasFix = h.errorCount > 0 && h.corrected && h.corrected !== h.text;
    const body = hasFix
      ? `<div class="history-pair">
           <div class="history-before"><span class="hp-label hp-before">전</span><span>${escapeHtml(h.text)}</span></div>
           <div class="history-after"><span class="hp-label hp-after">후</span><span>${escapeHtml(h.corrected)}</span></div>
         </div>`
      : `<div class="history-text">${escapeHtml(h.text)}</div>`;
    return `
    <div class="history-item" data-idx="${i}">
      <div class="history-item-top">
        <span class="history-badge ${h.errorCount === 0 ? 'no-error' : ''}">${h.errorCount === 0 ? '오류 없음' : h.errorCount + '개'}</span>
        <span class="history-time">${formatTime(h.ts)}</span>
        <span class="history-src">${escapeHtml(h.src || '')}</span>
      </div>
      ${body}
    </div>`;
  }).join('');

  historyList.querySelectorAll('.history-item').forEach(el => {
    el.addEventListener('click', () => {
      const h = history[+el.dataset.idx];
      if (!h) return;
      inputText.value = h.text;
      charCount.textContent = h.text.length;
      results.classList.add('hidden');
      inputText.focus();
    });
  });
}

function formatTime(ts) {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

clearHistoryBtn.addEventListener('click', async () => {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
  renderHistory([]);
});

// 검사가 일어나면(팝업·자동감지 모두) 기록이 갱신되므로 실시간 반영
if (typeof chrome !== 'undefined' && chrome.storage) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[HISTORY_KEY]) {
      renderHistory(changes[HISTORY_KEY].newValue || []);
    }
  });
}

loadHistory();

loadInputBtn.addEventListener('click', () => {
  if (!activeTab) return;
  chrome.tabs.sendMessage(activeTab.id, { action: 'getActiveInput' }, (res) => {
    if (chrome.runtime.lastError || !res?.found || !res.text) return;
    inputText.value = res.text;
    charCount.textContent = res.text.length;
    results.classList.add('hidden');
  });
});

clearBtn.addEventListener('click', () => {
  inputText.value = '';
  charCount.textContent = '0';
  results.classList.add('hidden');
  correctedText = '';
});

checkBtn.addEventListener('click', () => {
  const text = inputText.value.trim();
  if (!text) return;
  if (!/[가-힣]/.test(text)) {
    showMessage('한글 텍스트가 없습니다.', false);
    return;
  }
  runCheck(text);
});

applyBtn.addEventListener('click', () => {
  if (!correctedText || !activeTab) return;
  chrome.tabs.sendMessage(activeTab.id, { action: 'replaceActiveInput', text: correctedText }, (res) => {
    if (res?.ok) {
      applyBtn.textContent = '✓ 적용됨';
      applyBtn.disabled = true;
      setTimeout(() => {
        applyBtn.textContent = '입력창에 적용';
        applyBtn.disabled = false;
      }, 2000);
    }
  });
});

// SW가 idle로 종료돼 있던 경우 첫 메시지가 유실될 수 있어 1회 재시도
async function sendCheck(text, retried = false) {
  try {
    return await chrome.runtime.sendMessage({ action: 'checkSpelling', text });
  } catch (e) {
    if (!retried) {
      await new Promise(r => setTimeout(r, 100));
      return sendCheck(text, true);
    }
    throw e;
  }
}

async function runCheck(text) {
  loading.classList.remove('hidden');
  results.classList.add('hidden');
  checkBtn.disabled = true;

  try {
    if (typeof chrome === 'undefined' || !chrome.runtime) throw new Error('크롬 익스텐션 환경에서만 사용 가능합니다.');
    const response = await sendCheck(text);
    if (response.error) throw new Error(response.error);
    renderResults(text, response.errors);
  } catch (e) {
    showMessage(`오류: ${e.message}`, false);
  } finally {
    loading.classList.add('hidden');
    checkBtn.disabled = false;
  }
}

function renderResults(original, errors) {
  const count = errors.length;
  errorCount.textContent = `${count}개 오류`;
  errorCount.className = count === 0 ? 'error-badge no-error' : 'error-badge';

  // 교정된 전체 텍스트 생성 (입력창 적용용)
  correctedText = original;
  for (const err of errors) {
    if (err.correct) {
      correctedText = correctedText.replaceAll(err.wrong, err.correct);
    }
  }

  // 하이라이트 표시
  let annotated = escapeHtml(original);
  const sorted = [...errors].filter(e => e.wrong).sort((a, b) => b.wrong.length - a.wrong.length);
  for (const err of sorted) {
    const esc = escapeHtml(err.wrong);
    const hint = err.correct ? ` → ${escapeHtml(err.correct)}` : '';
    annotated = annotated.replace(
      new RegExp(esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      `<mark title="${hint}">${esc}</mark>`
    );
  }
  resultText.innerHTML = annotated;

  if (count === 0) {
    errorList.innerHTML = '<div class="no-error-msg">✓ 맞춤법 오류가 없습니다.</div>';
    applyBtn.classList.add('hidden');
  } else {
    errorList.innerHTML = errors.map(err => `
      <div class="error-item">
        <div class="error-words">
          <span class="error-wrong">${escapeHtml(err.wrong)}</span>
          ${err.correct ? `<span class="error-arrow">→</span><span class="error-correct">${escapeHtml(err.correct)}</span>` : ''}
        </div>
        ${err.correct ? `<button class="copy-btn" data-correct="${escapeHtml(err.correct)}">복사</button>` : ''}
        ${err.help ? `<div class="error-help">${escapeHtml(err.help)}</div>` : ''}
      </div>
    `).join('');

    errorList.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.correct);
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '복사'; }, 1200);
      });
    });

    if (hasActiveInput) {
      applyBtn.classList.remove('hidden');
      applyBtn.textContent = '입력창에 적용';
      applyBtn.disabled = false;
    }
  }

  results.classList.remove('hidden');
}

function showMessage(msg, isOk) {
  errorCount.textContent = isOk ? '완료' : '오류';
  errorCount.className = isOk ? 'error-badge no-error' : 'error-badge';
  resultText.innerHTML = '';
  errorList.innerHTML = `<div class="no-error-msg" style="color:${isOk ? '#137333' : '#c5221f'}">${escapeHtml(msg)}</div>`;
  applyBtn.classList.add('hidden');
  results.classList.remove('hidden');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
