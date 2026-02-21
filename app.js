// ====== CONFIG ======
const API_BASE = "https://mlmotiv.app.n8n.cloud/webhook"; // пример: https://xxxx.app.n8n.cloud/webhook
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
  session: null,      // { test, start_ms, expires_ms, session_token, questions, attempt_no, remaining_attempts }
  qIndex: 0,
  answers: {},        // { [question_id]: [answer_id, ...] }
  timerId: null,
  autoSubmitted: false,
  clockSkew: 0,       // clientNow - serverStartMs
  expiresLocal: null, // expires_ms + clockSkew
};

function tg() {
  return window.Telegram?.WebApp || null;
}

function el(id) { return document.getElementById(id); }

function setStatus(msg) {
  el("status").textContent = msg || "";
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// IMPORTANT:
// Отправляем Content-Type: text/plain, чтобы чаще избегать CORS preflight (OPTIONS).
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
  try { json = JSON.parse(text); }
  catch { throw new Error("Сервер вернул не-JSON: " + text); }

  return json;
}

// ====== UI RENDER ======
function renderLoading(title = "Загрузка...") {
  el("main").innerHTML = `<div class="card"><div>${title}</div></div>`;
}

function renderError(err) {
  el("main").innerHTML = `
    <div class="card">
      <div style="font-weight:700; margin-bottom:8px;">Ошибка</div>
      <div class="muted">${String(err?.message || err || "unknown")}</div>
      <div style="margin-top:12px;">
        <button class="btn secondary" id="btnBack">Назад</button>
      </div>
    </div>`;
  document.getElementById("btnBack").onclick = () => loadTests();
}

function renderTests() {
  const tests = state.tests;

  const items = tests.map(t => `
    <div class="card">
      <div style="font-weight:700">${t.title}</div>
      <div class="muted" style="margin-top:6px;">
        Время: ${t.time_limit_sec ? Math.round(t.time_limit_sec/60) + " мин" : "без лимита"} ·
        Попыток: ${t.max_attempts}
      </div>
      <div style="margin-top:12px;">
        <button class="btn" data-test="${t.test_id}">Начать</button>
      </div>
    </div>
  `).join("");

  el("main").innerHTML = items || `<div class="card">Нет активных тестов</div>`;

  document.querySelectorAll("button[data-test]").forEach(btn => {
    btn.onclick = () => startTest(btn.getAttribute("data-test"));
  });
}

function renderQuestion() {
  const s = state.session;
  const q = s.questions[state.qIndex];

  const selected = new Set(state.answers[q.question_id] || []);

  const answersHtml = q.answers.map(a => {
    const checked = selected.has(a.answer_id) ? "checked" : "";
    return `
      <label>
        <input type="checkbox" data-q="${q.question_id}" value="${a.answer_id}" ${checked} />
        ${a.answer_text}
      </label>`;
  }).join("");

  const progress = `${state.qIndex + 1} / ${s.questions.length}`;

  el("main").innerHTML = `
    <div class="card">
      <div class="row">
        <div class="muted">Вопрос ${progress}</div>
        <div class="timer" id="timer">${s.expires_ms ? fmtTime(state.expiresLocal - Date.now()) : "∞"}</div>
      </div>

      <div style="font-weight:700; margin-top:10px;">${q.question_text}</div>
      <div class="muted" style="margin-top:6px;">Баллы за вопрос: ${q.points}</div>

      <div class="answers" style="margin-top:10px;">${answersHtml}</div>

      <div class="row" style="margin-top:12px;">
        <button class="btn secondary" id="btnPrev" ${state.qIndex === 0 ? "disabled" : ""}>Назад</button>
        <button class="btn secondary" id="btnNext" ${state.qIndex === s.questions.length - 1 ? "disabled" : ""}>Далее</button>
      </div>

      <div class="row" style="margin-top:12px;">
        <div class="muted">Попытка: ${s.attempt_no} · Осталось: ${s.remaining_attempts}</div>
        <button class="btn" id="btnSubmit">${state.qIndex === s.questions.length - 1 ? "Отправить" : "Отправить сейчас"}</button>
      </div>
    </div>
  `;

  // checkbox handlers
  document.querySelectorAll("input[type=checkbox][data-q]").forEach(inp => {
    inp.onchange = () => {
      const qid = inp.getAttribute("data-q");
      const checkedIds = Array.from(document.querySelectorAll(`input[data-q="${qid}"]`))
        .filter(x => x.checked)
        .map(x => x.value);
      state.answers[qid] = checkedIds;
    };
  });

  el("btnPrev").onclick = () => { state.qIndex--; renderQuestion(); };
  el("btnNext").onclick = () => { state.qIndex++; renderQuestion(); };
  el("btnSubmit").onclick = () => submitCurrent(false);
}

function renderSubmitResult(r) {
  el("main").innerHTML = `
    <div class="card">
      <div style="font-weight:700; font-size:16px;">Результат</div>
      <div class="muted" style="margin-top:6px;">
        Статус: <b>${r.status}</b>${r.expired ? " (время истекло)" : ""}
      </div>
      <div style="margin-top:10px;">
        Баллы: <b>${r.score}</b> / ${r.max_score} (${r.percent}%)
      </div>
      <div class="muted" style="margin-top:6px;">
        Длительность: ${r.duration_sec} сек · Попытка: ${r.attempt_no}
      </div>

      <div class="row" style="margin-top:12px;">
        <button class="btn secondary" id="btnToTests">К списку тестов</button>
        <button class="btn" id="btnToResults">Мои результаты</button>
      </div>
    </div>
  `;
  el("btnToTests").onclick = () => loadTests();
  el("btnToResults").onclick = () => loadResults();
}

function renderResultsList(results) {
  if (!results.length) {
    el("main").innerHTML = `<div class="card">Результатов пока нет.</div>`;
    return;
  }

  const rows = results.map(r => {
    const dt = r.submit_ms ? new Date(r.submit_ms).toLocaleString() : "";
    return `
      <tr>
        <td>${r.test_title || r.test_id}</td>
        <td>${r.attempt_no}</td>
        <td>${r.status}</td>
        <td>${r.score}/${r.max_score} (${r.percent}%)</td>
        <td>${r.duration_sec}s</td>
        <td>${dt}</td>
      </tr>`;
  }).join("");

  el("main").innerHTML = `
    <div class="card">
      <div style="font-weight:700; margin-bottom:8px;">Мои результаты</div>
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
    </div>`;
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

    if (remain <= 0 && !state.autoSubmitted) {
      state.autoSubmitted = true;
      clearInterval(state.timerId);
      submitCurrent(true).catch(() => {});
    }
  }, 250);
}

// ====== ACTIONS ======
async function loadTests() {
  try {
    setStatus("");
    renderLoading("Загрузка тестов...");
    const r = await api(EP.tests, {});
    if (!r.ok) throw new Error(r.error || "Не удалось загрузить тесты");

    state.user = r.user;
    state.tests = r.tests || [];

    el("userBadge").textContent = state.user?.full_name ? `@${state.user.username || ""} ${state.user.full_name}` : "";

    renderTests();
    setActiveTab("tests");
  } catch (e) {
    renderError(e);
  }
}

async function startTest(testId) {
  try {
    setStatus("");
    renderLoading("Старт теста...");
    const r = await api(EP.start, { testId });
    if (!r.ok) throw new Error(r.error || "Не удалось стартовать тест");

    state.session = r;
    state.qIndex = 0;
    state.answers = {};

    // расчет с поправкой на разницу часов (client vs server)
    state.clockSkew = Date.now() - r.start_ms;
    state.expiresLocal = r.expires_ms ? (r.expires_ms + state.clockSkew) : null;

    renderQuestion();
    startTimer();
  } catch (e) {
    renderError(e);
  }
}

async function submitCurrent(auto = false) {
  try {
    if (!state.session) return;

    setStatus(auto ? "Время истекло — отправляем ответы..." : "Отправляем ответы...");
    const s = state.session;

    const r = await api(EP.submit, {
      testId: s.test.test_id,
      start_ms: s.start_ms,
      session_token: s.session_token,
      answers: state.answers,
    });

    if (!r.ok) throw new Error(r.error || "Не удалось отправить ответы");

    clearInterval(state.timerId);
    setStatus("");
    renderSubmitResult(r);
  } catch (e) {
    setStatus("");
    renderError(e);
  }
}

async function loadResults() {
  try {
    setStatus("");
    renderLoading("Загрузка результатов...");
    const r = await api(EP.results, {});
    if (!r.ok) throw new Error(r.error || "Не удалось загрузить результаты");

    renderResultsList(r.results || []);
    setActiveTab("results");
  } catch (e) {
    renderError(e);
  }
}

function setActiveTab(tab) {
  el("tabTests").classList.toggle("active", tab === "tests");
  el("tabResults").classList.toggle("active", tab === "results");
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
