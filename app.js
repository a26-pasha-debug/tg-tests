// ====== CONFIG ======
const API_BASE = "https://mlmotiv.app.n8n.cloud/webhook";
const EP = {
  tests: "tg-tests",
  start: "tg-start",
  submit: "tg-submit",
  results: "tg-results",
};

// ====== STATE ======
const state = {
  user: null,
  tests: [],
  session: null,
  qIndex: 0,
  answers: {},

  timerId: null,
  autoSubmitted: false,

  clockSkew: 0,
  expiresLocal: null,

  isSubmitting: false,
};

function tg() {
  return window.Telegram?.WebApp || null;
}
function el(id) { return document.getElementById(id); }

function setStatus(msg) {
  const s = el("status");
  if (s) s.textContent = msg || "";
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function escapeHtml(x) {
  return String(x ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}
function escapeAttr(x) { return escapeHtml(x); }

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true","1","yes","y","да"].includes(s)) return true;
    if (["false","0","no","n","нет",""].includes(s)) return false;
  }
  return false;
}

function cssEsc(s) {
  try {
    if (window.CSS && typeof CSS.escape === "function") return CSS.escape(String(s));
  } catch {}
  return String(s).replace(/["\\]/g, "\\$&");
}

/**
 * Нормализуем ссылки, которые часто НЕ грузятся в мобильном Telegram:
 * - //domain -> https://domain
 * - http:// -> https://
 * - Google Drive file link -> uc?export=view&id=
 * - Dropbox dl=0 -> raw=1
 * - GitHub blob -> raw.githubusercontent
 */
function normalizeImageUrl(urlRaw) {
  let url = String(urlRaw || "").trim();
  if (!url) return "";

  if (url.startsWith("//")) url = "https:" + url;
  if (url.startsWith("http://")) url = "https://" + url.slice("http://".length);

  // google drive: https://drive.google.com/file/d/<id>/view?...
  const mDrive = url.match(/drive\.google\.com\/file\/d\/([^/]+)\//i);
  if (mDrive && mDrive[1]) {
    url = `https://drive.google.com/uc?export=view&id=${mDrive[1]}`;
  }

  // dropbox
  if (url.includes("dropbox.com") && url.includes("dl=0")) {
    url = url.replace("dl=0", "raw=1");
  }

  // github blob -> raw
  const mGh = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
  if (mGh) {
    url = `https://raw.githubusercontent.com/${mGh[1]}/${mGh[2]}/${mGh[3]}`;
  }

  // аккуратно кодируем пробелы и кириллицу
  try { url = encodeURI(url); } catch {}

  return url;
}

// IMPORTANT: text/plain — меньше шансов на preflight OPTIONS
async function api(path, data = {}) {
  const webapp = tg();
  if (!webapp) throw new Error("Откройте Mini App внутри Telegram.");

  const payload = { ...data, initData: webapp.initData };

  const res = await fetch(`${API_BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();

  let json;
  try {
    json = JSON.parse(text);
    if (typeof json === "string") json = JSON.parse(json);
  } catch {
    throw new Error("Сервер вернул не-JSON: " + text);
  }

  return json;
}

// ====== UI ======
function setActiveTab(tab) {
  el("tabTests")?.classList.toggle("active", tab === "tests");
  el("tabResults")?.classList.toggle("active", tab === "results");
}

function renderLoading(title = "Загрузка...") {
  stopTimer();
  el("main").innerHTML = `
    <div class="card">
      <div class="loading-row">
        <div class="spinner" aria-hidden="true"></div>
        <div>
          <div style="font-weight:700">${escapeHtml(title)}</div>
          <div class="muted" style="margin-top:6px;">Пожалуйста, подождите…</div>
        </div>
      </div>
    </div>
  `;
}

function renderError(err) {
  stopTimer();
  el("main").innerHTML = `
    <div class="card">
      <div style="font-weight:700; margin-bottom:8px;">Ошибка</div>
      <div class="muted">${escapeHtml(String(err?.message || err || "unknown"))}</div>
      <div style="margin-top:12px;">
        <button class="btn secondary" id="btnBack">Назад</button>
      </div>
    </div>
  `;
  el("btnBack").onclick = () => loadTests();
}

// ====== Attempts calculation for tests screen ======
function calcAttemptsUsedByTest(results) {
  const map = new Map(); // test_id -> Set(unique attempt keys)

  for (const r of (results || [])) {
    const testId = String(r.test_id || r.testId || "").trim();
    if (!testId) continue;

    const status = String(r.status || "").trim().toLowerCase();
    if (!["submitted", "timeout"].includes(status)) continue;

    const key =
      String(r.attempt_no ?? "").trim() ||
      String(r.session_token ?? "").trim() ||
      String(r.start_ms ?? "").trim() ||
      String(r.submit_ms ?? "").trim();

    if (!key) continue;

    if (!map.has(testId)) map.set(testId, new Set());
    map.get(testId).add(key);
  }

  return map;
}

function renderTests() {
  stopTimer();

  const items = (state.tests || []).map(t => {
    const timeMin = Number(t.time_limit_sec || 0) > 0 ? Math.round(Number(t.time_limit_sec) / 60) : 0;

    const max = Number(t.max_attempts || 0);
    const used = Number(t.attempts_used || 0);
    const hasLimit = Number.isFinite(max) && max > 0;

    const canStart = !hasLimit || used < max;

    // "Попыток 1/2" (следующая попытка / всего)
    const attemptNo = hasLimit ? Math.min(used + 1, max) : 1;
    const attemptsText = hasLimit ? `${attemptNo}/${max}` : "∞";

    return `
      <div class="card">
        <div style="font-weight:700">${escapeHtml(t.title)}</div>
        <div class="muted" style="margin-top:6px;">
          Время: ${timeMin ? `${timeMin} мин` : "без лимита"} · Попыток: ${attemptsText}
        </div>
        <div style="margin-top:12px;">
          ${
            canStart
              ? `<button class="btn" data-test="${escapeAttr(t.test_id)}">Начать</button>`
              : `<div class="muted">Попытки закончились</div>`
          }
        </div>
      </div>
    `;
  }).join("");

  el("main").innerHTML = items || `<div class="card">Нет активных тестов</div>`;

  document.querySelectorAll("button[data-test]").forEach(btn => {
    btn.onclick = () => startTest(btn.getAttribute("data-test"));
  });

  setActiveTab("tests");
}

function syncAnswersFromDom(qid, isMulti) {
  const qSel = cssEsc(qid);

  if (isMulti) {
    const checkedIds = Array.from(document.querySelectorAll(`input[data-q="${qSel}"][type="checkbox"]`))
      .filter(x => x.checked)
      .map(x => String(x.value || "").trim())
      .filter(Boolean);

    state.answers[qid] = checkedIds;
  } else {
    const picked = document.querySelector(`input[data-q="${qSel}"][type="radio"]:checked`);
    const v = picked ? String(picked.value || "").trim() : "";
    state.answers[qid] = v ? [v] : [];
  }
}

function renderQuestion() {
  const s = state.session;
  if (!s || !Array.isArray(s.questions) || !s.questions.length) {
    renderError("Сессия пуста или не содержит вопросов");
    return;
  }

  const q = s.questions[state.qIndex];
  if (!q) {
    renderError("Вопрос не найден");
    return;
  }

  const isLast = state.qIndex === s.questions.length - 1;

  // ВАЖНО:
  // чтобы радио/чекбоксы работали правильно — сервер должен прислать q.multi (true/false).
  // Если q.multi не пришло — по умолчанию оставляем чекбоксы (чтобы не ломать мультивыбор).
  const hasMultiFlag = (q.multi !== undefined && q.multi !== null);
  const isMulti = hasMultiFlag ? toBool(q.multi) : true;

  const selected = new Set(state.answers[q.question_id] || []);

  // дедуп вариантов по answer_id
  const seen = new Set();
  const answersList = (q.answers || []).filter(a => {
    const id = String(a?.answer_id || "").trim();
    if (!id) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const inputType = isMulti ? "checkbox" : "radio";
  const radioName = `q_${String(q.question_id || "").trim()}`;

  const answersHtml = answersList.map(a => {
    const aid = String(a.answer_id || "").trim();
    const atext = String(a.answer_text || "").trim();
    const checked = selected.has(aid) ? "checked" : "";
    return `
      <label>
        <input
          type="${inputType}"
          ${!isMulti ? `name="${escapeAttr(radioName)}"` : ""}
          data-q="${escapeAttr(q.question_id)}"
          value="${escapeAttr(aid)}"
          ${checked}
        />
        ${escapeHtml(atext)}
      </label>
    `;
  }).join("");

  const qText = String(q.question_text || "").trim();
  const imgUrl = normalizeImageUrl(q.image_url || "");
  const imgHtml = imgUrl
    ? `
      <div class="q-media" id="qMedia">
        <img
          class="q-img"
          src="${escapeAttr(imgUrl)}"
          alt=""
          loading="eager"
          decoding="async"
          referrerpolicy="no-referrer"
          crossorigin="anonymous"
          onerror="(function(img){ try{ const box = img.closest('.q-media'); if(box){ box.innerHTML='<div class=muted style=padding:12px>Не удалось загрузить изображение</div>'; } }catch(e){} })(this)"
        />
      </div>
    `
    : "";

  const progress = `${state.qIndex + 1} / ${s.questions.length}`;

  const attemptNo = Number(s.attempt_no || 1);
  const maxAttempts = Number(s?.test?.max_attempts || 0);
  const remainingAfter = maxAttempts > 0 ? Math.max(0, maxAttempts - attemptNo) : Number(s.remaining_attempts || 0);

  const hasSelection = selected.size > 0;

  // Кнопка "Далее" — нельзя, если не выбран ответ
  const nextDisabled = (!hasSelection) || isLast;

  // Кнопка "Отправить" — только на последнем вопросе и только если выбран ответ
  const submitDisabled = (!hasSelection);

  el("main").innerHTML = `
    <div class="card">
      <div class="row">
        <div class="muted">Вопрос ${escapeHtml(progress)}</div>
        <div class="timer" id="timer">${s.expires_ms ? fmtTime(state.expiresLocal - Date.now()) : "∞"}</div>
      </div>

      ${qText ? `<div style="font-weight:700; margin-top:10px;">${escapeHtml(qText)}</div>` : ""}
      ${imgHtml}

      <div class="muted" style="margin-top:6px;">Баллы за вопрос: ${Number(q.points || 0)}</div>

      <div class="answers" style="margin-top:10px;">
        ${answersHtml || `<div class="muted">Нет вариантов ответа</div>`}
      </div>

      <div class="row" style="margin-top:12px;">
        <button class="btn secondary" id="btnPrev" ${state.qIndex === 0 ? "disabled" : ""}>Назад</button>
        <button class="btn secondary" id="btnNext" ${nextDisabled ? "disabled" : ""}>Далее</button>
      </div>

      <div class="row" style="margin-top:12px;">
        <div class="muted">Попытка: ${attemptNo}/${maxAttempts || "∞"} · Осталось: ${remainingAfter}</div>
        ${isLast ? `<button class="btn" id="btnSubmit" ${submitDisabled ? "disabled" : ""}>Отправить</button>` : ""}
      </div>
    </div>
  `;

  function updateButtons() {
    const nowSelected = new Set(state.answers[q.question_id] || []);
    const ok = nowSelected.size > 0;

    const nextBtn = el("btnNext");
    if (nextBtn) nextBtn.disabled = (!ok) || isLast;

    const submitBtn = el("btnSubmit");
    if (submitBtn) submitBtn.disabled = !ok;
  }

  // handlers
  document.querySelectorAll(`input[data-q="${cssEsc(q.question_id)}"]`).forEach(inp => {
    inp.onchange = () => {
      syncAnswersFromDom(q.question_id, isMulti);
      updateButtons();
    };
  });

  el("btnPrev").onclick = () => { state.qIndex--; renderQuestion(); };

  el("btnNext").onclick = () => {
    // защита на всякий случай
    const arr = state.answers[q.question_id] || [];
    if (!arr.length) return;
    state.qIndex++;
    renderQuestion();
  };

  const submitBtn = el("btnSubmit");
  if (submitBtn) {
    submitBtn.onclick = () => submitCurrent(false);
  }

  startTimer();
}

function renderSubmitResult(r) {
  stopTimer();
  el("main").innerHTML = `
    <div class="card">
      <div style="font-weight:700; font-size:16px;">Результат</div>
      <div class="muted" style="margin-top:6px;">
        Статус: <b>${escapeHtml(r.status)}</b>${r.expired ? " (время истекло)" : ""}
      </div>
      <div style="margin-top:10px;">
        Баллы: <b>${Number(r.score)}</b> / ${Number(r.max_score)} (${Number(r.percent)}%)
      </div>
      <div class="muted" style="margin-top:6px;">
        Длительность: ${Number(r.duration_sec)} сек · Попытка: ${Number(r.attempt_no)}
      </div>

      <div class="row" style="margin-top:12px;">
        <button class="btn secondary" id="btnToTests">К тестам</button>
        <button class="btn" id="btnToResults">Мои результаты</button>
      </div>
    </div>
  `;
  el("btnToTests").onclick = () => loadTests();
  el("btnToResults").onclick = () => loadResults();
}

function renderResultsList(results) {
  stopTimer();

  if (!results || !results.length) {
    el("main").innerHTML = `<div class="card">Результатов пока нет.</div>`;
    setActiveTab("results");
    return;
  }

  const rows = results.map(r => {
    const dt = r.submit_ms ? new Date(Number(r.submit_ms)).toLocaleString() : "";
    return `
      <tr>
        <td>${escapeHtml(r.test_title || r.test_id)}</td>
        <td>${Number(r.attempt_no || 0)}</td>
        <td>${escapeHtml(r.status || "")}</td>
        <td>${Number(r.score || 0)}/${Number(r.max_score || 0)} (${Number(r.percent || 0)}%)</td>
        <td>${Number(r.duration_sec || 0)}s</td>
        <td>${escapeHtml(dt)}</td>
      </tr>
    `;
  }).join("");

  el("main").innerHTML = `
    <div class="card">
      <div style="font-weight:700; margin-bottom:8px;">Мои результаты</div>
      <div style="overflow:auto;">
        <table>
          <thead>
            <tr>
              <th>Тест</th>
              <th>#</th>
              <th>Статус</th>
              <th>Баллы</th>
              <th>Время</th>
              <th>Дата</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;

  setActiveTab("results");
}

// ====== TIMER ======
function startTimer() {
  clearInterval(state.timerId);
  state.autoSubmitted = false;

  if (!state.session?.expires_ms) {
    state.timerId = null;
    return;
  }

  state.timerId = setInterval(() => {
    const tEl = document.getElementById("timer");
    if (!tEl) return;

    const remain = state.expiresLocal - Date.now();
    tEl.textContent = fmtTime(remain);

    if (remain <= 0 && !state.autoSubmitted && !state.isSubmitting) {
      state.autoSubmitted = true;
      clearInterval(state.timerId);
      submitCurrent(true).catch(() => {});
    }
  }, 250);
}

function stopTimer() {
  clearInterval(state.timerId);
  state.timerId = null;
}

// ====== ACTIONS ======
async function loadTests() {
  try {
    if (state.isSubmitting) return;
    setStatus("");
    renderLoading("Загрузка тестов...");

    const [testsRes, resultsRes] = await Promise.all([
      api(EP.tests, {}),
      api(EP.results, {}).catch(() => ({ ok: false, results: [] })),
    ]);

    if (!testsRes.ok) throw new Error(testsRes.error || "Не удалось загрузить тесты");

    state.user = testsRes.user;
    state.tests = testsRes.tests || [];

    // (1) УБРАТЬ @username — показываем только имя
    const nameOnly =
      String(state.user?.full_name || "").trim() ||
      String(state.user?.first_name || "").trim() ||
      String(state.user?.username || "").trim() ||
      "";
    el("userBadge").textContent = nameOnly;

    const results = (resultsRes && resultsRes.ok) ? (resultsRes.results || []) : [];
    const map = calcAttemptsUsedByTest(results);

    state.tests = state.tests.map(t => {
      const testId = String(t.test_id || "").trim();
      const used = map.get(testId)?.size || 0;
      return { ...t, attempts_used: used };
    });

    renderTests();
  } catch (e) {
    renderError(e);
  }
}

async function startTest(testId) {
  try {
    if (state.isSubmitting) return;
    setStatus("");
    renderLoading("Старт теста...");

    const r = await api(EP.start, { testId });
    if (!r.ok) throw new Error(r.error || "Не удалось стартовать тест");

    state.session = r;
    state.qIndex = 0;
    state.answers = {};

    state.clockSkew = Date.now() - r.start_ms;
    state.expiresLocal = r.expires_ms ? (r.expires_ms + state.clockSkew) : null;

    renderQuestion();
  } catch (e) {
    renderError(e);
  }
}

async function submitCurrent(auto = false) {
  if (state.isSubmitting) return;
  if (!state.session) return;

  try {
    state.isSubmitting = true;
    renderLoading(auto ? "Время истекло — отправляем ответы..." : "Ответы отправляются...");

    const s = state.session;

    const r = await api(EP.submit, {
      testId: s.test.test_id,
      start_ms: s.start_ms,
      session_token: s.session_token,
      answers: state.answers,
    });

    if (!r.ok) throw new Error(r.error || "Не удалось отправить ответы");

    state.isSubmitting = false;
    renderSubmitResult(r);
  } catch (e) {
    state.isSubmitting = false;
    renderError(e);
  }
}

async function loadResults() {
  try {
    if (state.isSubmitting) return;
    setStatus("");
    renderLoading("Загрузка результатов...");

    const r = await api(EP.results, {});
    if (!r.ok) throw new Error(r.error || "Не удалось загрузить результаты");

    renderResultsList(r.results || []);
  } catch (e) {
    renderError(e);
  }
}

// ====== INIT ======
(function init() {
  const webapp = tg();
  if (webapp) {
    webapp.ready();
    webapp.expand();
  }

  el("tabTests").onclick = () => loadTests();
  el("tabResults").onclick = () => loadResults();

  loadTests();
})();
