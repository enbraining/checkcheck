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

let activeTab = null;
let hasActiveInput = false;
let correctedText = '';

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

async function runCheck(text) {
  loading.classList.remove('hidden');
  results.classList.add('hidden');
  checkBtn.disabled = true;

  try {
    if (typeof chrome === 'undefined' || !chrome.runtime) throw new Error('크롬 익스텐션 환경에서만 사용 가능합니다.');
    const response = await chrome.runtime.sendMessage({ action: 'checkSpelling', text });
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
