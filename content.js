(() => {
  const TIP_ID      = '__ksc_tip__';
  const HL_NAME     = 'ksc-spell';
  const DEBOUNCE_MS = 900;

  let currentInput  = null;
  let debounceTimer = null;
  let tipEl         = null;
  let ignoredWords  = new Set();
  let busy          = false;   // 프로그램 교체 중 재검사 차단

  // contenteditable: Range 기반 오류 목록 (span 주입 안 함)
  let errorList = [];   // [{wrong, correct, help, range}]
  let curIdx    = 0;

  // textarea/input 전용
  let pendingErrors = [];
  let errorIndex    = 0;

  /* ── 툴팁 생성 ─────────────────────────────────── */
  function createTip() {
    const el = document.createElement('div');
    el.id = TIP_ID;
    el.innerHTML = `
      <div class="ksc-tip-header">
        <span class="ksc-tip-title">맞춤법 교정</span>
        <button class="ksc-tip-close">✕</button>
      </div>
      <div class="ksc-tip-body">
        <div class="ksc-tip-wrong"></div>
        <div class="ksc-tip-arrow">→ <span class="ksc-tip-correct"></span></div>
        <div class="ksc-tip-help"></div>
      </div>
      <div class="ksc-tip-actions">
        <button class="ksc-btn-replace">바꾸기</button>
        <button class="ksc-btn-ignore">무시하기</button>
      </div>
      <div class="ksc-tip-nav"><span class="ksc-tip-counter"></span></div>
    `;
    el.querySelector('.ksc-tip-close').addEventListener('mousedown',      e => { e.preventDefault(); hideTip(); });
    el.querySelector('.ksc-btn-replace').addEventListener('mousedown', e => { e.preventDefault(); doReplace(); });
    el.querySelector('.ksc-btn-ignore').addEventListener('mousedown',  e => { e.preventDefault(); doIgnore(); });
    document.body.appendChild(el);
    return el;
  }

  function ensureTip() {
    tipEl = document.getElementById(TIP_ID) || createTip();
  }

  /* ── 툴팁 표시/숨김 ────────────────────────────── */
  function showTip(anchorRect, err, idx, total) {
    ensureTip();
    tipEl.querySelector('.ksc-tip-title').textContent   = guessTitle(err.help);
    tipEl.querySelector('.ksc-tip-wrong').textContent   = err.wrong;
    tipEl.querySelector('.ksc-tip-correct').textContent = err.correct;
    tipEl.querySelector('.ksc-tip-help').textContent    = err.help || '';
    tipEl.querySelector('.ksc-tip-counter').textContent = total > 1 ? `${idx + 1} / ${total}` : '';
    tipEl.style.display = 'block';

    const tipH = tipEl.offsetHeight || 130;
    const tipW = tipEl.offsetWidth  || 280;
    let top  = anchorRect.top  - tipH - 8;
    let left = anchorRect.left;
    if (top < 4)                             top  = anchorRect.bottom + 8;
    if (left + tipW > window.innerWidth - 8) left = window.innerWidth - tipW - 8;
    tipEl.style.top  = `${Math.max(4, top)}px`;
    tipEl.style.left = `${Math.max(8, left)}px`;
  }

  function hideTip() {
    if (tipEl) tipEl.style.display = 'none';
  }

  function guessTitle(help) {
    if (!help) return '맞춤법 교정';
    if (help.includes('띄어')) return '띄어쓰기 교정';
    if (help.includes('표준어')) return '표준어 교정';
    if (help.includes('외래어')) return '외래어 표기 교정';
    return '맞춤법 교정';
  }

  /* ── 검사 실행 ─────────────────────────────────── */
  async function runCheck() {
    if (!currentInput || busy) return;
    const text = getInputText(currentInput).trim();
    if (!text || !/[가-힣]/.test(text)) { clearHighlights(); hideTip(); return; }

    try {
      const res = await chrome.runtime.sendMessage({ action: 'checkSpelling', text });
      if (res?.error) throw new Error(res.error);

      const errors = (res.errors || [])
        .filter(e => e.wrong !== e.correct && !ignoredWords.has(e.wrong));

      if (currentInput.isContentEditable) {
        buildErrorRanges(currentInput, errors);
        if (errorList.length === 0) { clearHighlights(); hideTip(); return; }
        curIdx = Math.min(curIdx, errorList.length - 1);
        showCurrentCE();
      } else {
        clearHighlights();
        pendingErrors = errors;
        errorIndex    = 0;
        if (errors.length === 0) { hideTip(); return; }
        showTextareaError();
      }
    } catch (_) {}
  }

  /* ── contenteditable: Range 수집 + CSS Highlight ───
     span 주입 없이 실제 텍스트 노드의 Range만 사용.
     → Slate/ProseMirror 의 내부 모델을 손상시키지 않음. */
  function buildErrorRanges(el, errors) {
    errorList = [];
    for (const err of errors) {
      for (const range of findAllRanges(el, err.wrong)) {
        errorList.push({ ...err, range });
      }
    }
    errorList.sort((a, b) =>
      a.range.compareBoundaryPoints(Range.START_TO_START, b.range));
    paintHighlights();
  }

  function paintHighlights() {
    if (!window.CSS || !CSS.highlights) return;
    const hl = new Highlight();
    for (const e of errorList) hl.add(e.range);
    CSS.highlights.set(HL_NAME, hl);
  }

  function clearHighlights() {
    errorList = [];
    if (window.CSS && CSS.highlights) CSS.highlights.delete(HL_NAME);
  }

  function findAllRanges(el, text) {
    const ranges = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent;
      let idx = 0;
      while ((idx = t.indexOf(text, idx)) !== -1) {
        const r = document.createRange();
        r.setStart(node, idx);
        r.setEnd(node, idx + text.length);
        ranges.push(r);
        idx += text.length;
      }
    }
    return ranges;
  }

  // 단일 텍스트 노드 내부의 첫 출현 Range (Slate가 매핑 가능한 지점)
  function findFirstRange(el, text) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.textContent.indexOf(text);
      if (idx === -1) continue;
      const r = document.createRange();
      r.setStart(node, idx);
      r.setEnd(node, idx + text.length);
      return r;
    }
    return null;
  }

  function showCurrentCE() {
    if (errorList.length === 0) { hideTip(); return; }
    const e = errorList[curIdx];
    showTip(e.range.getBoundingClientRect(), e, curIdx, errorList.length);
  }

  /* ── textarea용 ─────────────────────────────────── */
  function showTextareaError() {
    if (!currentInput || pendingErrors.length === 0) { hideTip(); return; }
    showTip(currentInput.getBoundingClientRect(), pendingErrors[errorIndex], errorIndex, pendingErrors.length);
  }

  function scheduleRecheck() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runCheck, 500);
  }

  // 교체 후 커서를 문서 끝으로 정상 복귀 (Slate가 매핑 가능한 텍스트 노드 지점)
  function moveCaretToEnd() {
    if (!currentInput?.isContentEditable) return;
    const walker = document.createTreeWalker(currentInput, NodeFilter.SHOW_TEXT);
    let last = null, n;
    while ((n = walker.nextNode())) last = n;
    currentInput.focus();
    const r = document.createRange();
    if (last) { r.setStart(last, last.textContent.length); }
    else      { r.selectNodeContents(currentInput); }
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /* ── 한 단어 교체 ──────────────────────────────────
     단일 텍스트 노드 Range만 선택 → Slate가 toSlatePoint 로 매핑 가능.
     전체 선택은 컨테이너 경계라 Slate가 못 풀어
     "Cannot resolve a Slate point" 에러 → 삭제 실패 → 덧붙음. */
  function selectAndInsert(range, text) {
    return new Promise(resolve => {
      currentInput.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const before = getInputText(currentInput);

      setTimeout(() => {
        // 1차: 합성 paste (Slate onPaste → editor.insertData → 모델 갱신)
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          currentInput.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dt, bubbles: true, cancelable: true,
          }));
        } catch (_) {}

        setTimeout(() => {
          // paste 가 모델을 안 바꿨으면(텍스트 변화 없음) beforeinput→execCommand 폴백
          if (getInputText(currentInput) === before) {
            // selection 재설정 (paste 시도로 풀렸을 수 있음)
            const sel2 = window.getSelection();
            sel2.removeAllRanges();
            sel2.addRange(range);
            currentInput.dispatchEvent(new InputEvent('beforeinput', {
              bubbles: true, cancelable: true, inputType: 'insertText', data: text,
            }));
            if (getInputText(currentInput) === before) {
              document.execCommand('insertText', false, text);
            }
          }
          resolve();
        }, 25);
      }, 25);
    });
  }

  /* ── 버튼 액션 ─────────────────────────────────── */
  async function doReplace() {
    if (!currentInput || busy) return;
    if (currentInput.isContentEditable) {
      const e = errorList[curIdx];
      if (!e) return;
      hideTip();
      busy = true;
      try {
        const range = findFirstRange(currentInput, e.wrong);
        if (range) await selectAndInsert(range, e.correct);
        moveCaretToEnd();
      } finally { busy = false; }
      scheduleRecheck();
    } else {
      const err = pendingErrors[errorIndex];
      const t   = getInputText(currentInput);
      const i   = t.indexOf(err.wrong);
      if (i !== -1) setInputText(currentInput, t.slice(0, i) + err.correct + t.slice(i + err.wrong.length));
      pendingErrors.splice(errorIndex, 1);
      errorIndex = Math.min(errorIndex, pendingErrors.length - 1);
      if (errorIndex < 0) { hideTip(); return; }
      showTextareaError();
    }
  }

  function doIgnore() {
    if (!currentInput) return;
    const wrong = currentInput.isContentEditable
      ? errorList[curIdx]?.wrong
      : pendingErrors[errorIndex]?.wrong;
    if (!wrong) return;
    ignoredWords.add(wrong);

    if (currentInput.isContentEditable) {
      errorList = errorList.filter(e => e.wrong !== wrong);
      paintHighlights();
      curIdx = Math.min(curIdx, errorList.length - 1);
      if (errorList.length === 0) { hideTip(); return; }
      showCurrentCE();
    } else {
      pendingErrors = pendingErrors.filter(e => e.wrong !== wrong);
      errorIndex = Math.min(errorIndex, pendingErrors.length - 1);
      if (errorIndex < 0) { hideTip(); return; }
      showTextareaError();
    }
  }

  /* ── 밑줄 클릭 감지 (Range 히트 테스트) ──────────── */
  function onInputClick(e) {
    if (!currentInput?.isContentEditable || errorList.length === 0) return;
    for (let i = 0; i < errorList.length; i++) {
      for (const r of errorList[i].range.getClientRects()) {
        if (e.clientX >= r.left && e.clientX <= r.right &&
            e.clientY >= r.top  && e.clientY <= r.bottom) {
          curIdx = i;
          showCurrentCE();
          return;
        }
      }
    }
  }

  /* ── 텍스트 읽기/쓰기 ───────────────────────────── */
  function getInputText(el) {
    return el.isContentEditable ? el.innerText : el.value;
  }
  function setInputText(el, text) {
    if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll');
      document.execCommand('insertText', false, text);
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  /* ── 입력 감지 ──────────────────────────────────── */
  function isTargetInput(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT' && /^(text|search|email|url|)$/i.test(el.type ?? '')) return true;
    if (el.isContentEditable && el.getAttribute('contenteditable') !== 'false') return true;
    return false;
  }

  document.addEventListener('focusin', e => {
    if (!isTargetInput(e.target)) return;
    const changed = currentInput !== e.target;
    currentInput = e.target;
    if (changed) {
      ignoredWords.clear();
      clearHighlights();
      hideTip();
    }
    const text = getInputText(currentInput).trim();
    if (text && /[가-힣]/.test(text)) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runCheck, DEBOUNCE_MS);
    }
  }, true);

  document.addEventListener('focusout', e => {
    if (!isTargetInput(e.target)) return;
    setTimeout(() => {
      if (tipEl?.contains(document.activeElement)) return;
      hideTip();
    }, 200);
  }, true);

  document.addEventListener('input', e => {
    if (e.target !== currentInput || busy) return;  // 교체 중엔 무시
    clearTimeout(debounceTimer);
    hideTip();
    clearHighlights();
    debounceTimer = setTimeout(runCheck, DEBOUNCE_MS);
  }, true);

  document.addEventListener('click', e => {
    if (tipEl?.contains(e.target)) return;
    onInputClick(e);
  }, true);

  document.addEventListener('mousedown', e => {
    if (tipEl && !tipEl.contains(e.target)) hideTip();
  }, true);

  // 스크롤 시 툴팁 위치 갱신
  window.addEventListener('scroll', () => {
    if (tipEl?.style.display === 'block' && currentInput?.isContentEditable && errorList[curIdx]) {
      const e = errorList[curIdx];
      showTip(e.range.getBoundingClientRect(), e, curIdx, errorList.length);
    }
  }, { passive: true, capture: true });
})();
