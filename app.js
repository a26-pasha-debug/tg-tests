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

  clockSkew: 0,      // clientNow - serverStartMs
  expiresLocal: null,// expires_ms + clockSkew

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
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[m]));
}
function escapeAttr(x) { return escapeHtml(x); }

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

  // двойной parse на случай если бек вернул JSON-строку
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

function renderTests() {
  stopTimer();
  const items = (state.tests || []).map(t => {
    const timeMin = Number(t.time_limit_sec || 0) > 0 ? Math.round(Number(t.time_limit_sec) / 60) : 0;
    return `
      <div class="card">
        <div style="font-weight:700">${escapeHtml(t.title)}</div>
        <div class="muted" style="margin-top:6px;">
          Время: ${timeMin ? `${timeMin} мин` : "без лимита"} · Попыток: ${Number(t.max_attempts || 0)}
        </div>
        <div style="margin-top:12px;">
          <button class="btn" data-test="${escapeAttr(t.test_id)}">Начать</button>
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

  const selected = new Set(state.answers[q.question_id] || []);

  // дедуп ответов по answer_id (на случай дублей)
  const seen = new Set();
  const answersList = (q.answers || []).filter(a => {
    const id = String(a?.answer_id || "").trim();
    if (!id) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const answersHtml = answersList.map(a => {
    const aid = String(a.answer_id || "").trim();
    const atext = String(a.answer_text || "").trim();
    const checked = selected.has(aid) ? "checked" : "";
    return `
      <label>
        <input type="checkbox" data-q="${escapeAttr(q.question_id)}" value="${escapeAttr(aid)}" ${checked} />
        ${escapeHtml(atext)}
      </label>
    `;
  }).join("");

  const qText = String(q.question_text || "").trim();
  const imgUrl = String(q.image_url || "").trim();
  const imgHtml = imgUrl
    ? `<div class="q-media"><img class="q-img" src="${escapeAttr(imgUrl)}" alt="" loading="lazy" onerror="this.closest('.q-media')?.remove();" /></div>`
    : "";

  const progress = `${state.qIndex + 1} / ${s.questions.length}`;

  const attemptNo = Number(s.attempt_no || 1);
  const maxAttempts = Number(s?.test?.max_attempts || 0);
  const remainingAfter = maxAttempts > 0 ? Math.max(0, maxAttempts - attemptNo) : Number(s.remaining_attempts || 0);

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
        <button class="btn secondary" id="btnNext" ${state.qIndex === s.questions.length - 1 ? "disabled" : ""}>Далее</button>
      </div>

      <div class="row" style="margin-top:12px;">
        <div class="muted">Попытка: ${attemptNo} · Осталось: ${remainingAfter}</div>
        <button class="btn" id="btnSubmit">${state.qIndex === s.questions.length - 1 ? "Отправить" : "Отправить сейчас"}</button>
      </div>
    </div>
  `;

  document.querySelectorAll('input[type="checkbox"][data-q]').forEach(inp => {
    inp.onchange = () => {
      const qid = inp.getAttribute("data-q");
      const safe = (window.CSS && CSS.escape) ? CSS.escape(qid) : qid.replace(/"/g, '\\"');

      const checkedIds = Array.from(document.querySelectorAll(`input[data-q="${safe}"]`))
        .filter(x => x.checked)
        .map(x => x.value);

      state.answers[qid] = checkedIds;
    };
  });

  el("btnPrev").onclick = () => { state.qIndex--; renderQuestion(); };
  el("btnNext").onclick = () => { state.qIndex++; renderQuestion(); };
  el("btnSubmit").onclick = () => submitCurrent(false);

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
    const r = await api(EP.tests, {});
    if (!r.ok) throw new Error(r.error || "Не удалось загрузить тесты");

    state.user = r.user;
    state.tests = r.tests || [];

    el("userBadge").textContent = state.user?.full_name
      ? `@${state.user.username || ""} ${state.user.full_name}`
      : "";

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

    // Сразу показываем экран отправки (чтобы не было ощущения задержки)
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
    setStatus("");
    renderSubmitResult(r);
  } catch (e) {
    state.isSubmitting = false;
    setStatus("");
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
