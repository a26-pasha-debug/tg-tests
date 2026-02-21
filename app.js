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

// ====== TESTS ======
function renderTests() {
  const items = state.tests.map(t => `
    <div class="card">
      <div style="font-weight:700">${t.title}</div>
      <div class="muted" style="margin-top:6px;">
        Время: ${Math.round(t.time_limit_sec/60)} мин ·
        Попыток: ${t.max_attempts}
      </div>
      <div style="margin-top:12px;">
        <button class="btn" data-test="${t.test_id}">Начать</button>
      </div>
    </div>
  `).join("");

  el("main").innerHTML = items;

  document.querySelectorAll("button[data-test]").forEach(btn => {
    btn.onclick = () => startTest(btn.dataset.test);
  });
}

// ====== QUESTION ======
function renderQuestion() {
  const s = state.session;
  const q = s.questions[state.qIndex];

  const selected = new Set(state.answers[q.question_id] || []);

  const answersHtml = q.answers.map(a => {
    const checked = selected.has(a.answer_id) ? "checked" : "";
    return `
      <label>
        <input type="checkbox" data-q="${q.question_id}" value="${a.answer_id}" ${checked}/>
        ${a.answer_text}
      </label>`;
  }).join("");

  const imgHtml = q.image_url
    ? `<div class="q-media"><img class="q-img" src="${q.image_url}" alt=""/></div>`
    : "";

  el("main").innerHTML = `
    <div class="card">
      <div class="row">
        <div class="muted">Вопрос ${state.qIndex + 1} / ${s.questions.length}</div>
        <div class="timer" id="timer">${fmtTime(state.expiresLocal - Date.now())}</div>
      </div>

      <div style="font-weight:700; margin-top:10px;">
        ${q.question_text || ""}
      </div>

      ${imgHtml}

      <div class="muted" style="margin-top:6px;">
        Баллы за вопрос: ${q.points}
      </div>

      <div class="answers" style="margin-top:10px;">
        ${answersHtml}
      </div>

      <div class="row" style="margin-top:12px;">
        <button class="btn secondary" id="btnPrev" ${state.qIndex === 0 ? "disabled" : ""}>Назад</button>
        <button class="btn secondary" id="btnNext" ${state.qIndex === s.questions.length - 1 ? "disabled" : ""}>Далее</button>
      </div>

      <div class="row" style="margin-top:12px;">
        <div class="muted">
          Попытка: ${s.attempt_no} · Осталось: ${Math.max(0, s.test.max_attempts - s.attempt_no)}
        </div>
        <button class="btn" id="btnSubmit">
          ${state.qIndex === s.questions.length - 1 ? "Отправить" : "Отправить сейчас"}
        </button>
      </div>
    </div>
  `;

  document.querySelectorAll("input[type=checkbox]").forEach(inp => {
    inp.onchange = () => {
      const qid = inp.dataset.q;
      const checkedIds = Array.from(
        document.querySelectorAll(`input[data-q="${qid}"]`)
      ).filter(x => x.checked).map(x => x.value);
      state.answers[qid] = checkedIds;
    };
  });

  el("btnPrev").onclick = () => { state.qIndex--; renderQuestion(); };
  el("btnNext").onclick = () => { state.qIndex++; renderQuestion(); };
  el("btnSubmit").onclick = () => submitCurrent(false);
}

// ====== TIMER ======
function startTimer() {
  clearInterval(state.timerId);
  state.timerId = setInterval(() => {
    const remain = state.expiresLocal - Date.now();
    const tEl = document.getElementById("timer");
    if (tEl) tEl.textContent = fmtTime(remain);
  }, 250);
}

// ====== ACTIONS ======
async function loadTests() {
  const r = await api(EP.tests);
  state.user = r.user;
  state.tests = r.tests;
  el("userBadge").textContent = `@${state.user.username} ${state.user.full_name}`;
  renderTests();
}

async function startTest(testId) {
  const r = await api(EP.start, { testId });
  state.session = r;
  state.qIndex = 0;
  state.answers = {};
  state.clockSkew = Date.now() - r.start_ms;
  state.expiresLocal = r.expires_ms + state.clockSkew;
  renderQuestion();
  startTimer();
}

async function submitCurrent(auto=false) {
  const s = state.session;
  const r = await api(EP.submit, {
    testId: s.test.test_id,
    start_ms: s.start_ms,
    session_token: s.session_token,
    answers: state.answers,
  });

  el("main").innerHTML = `
    <div class="card">
      <h3>Результат</h3>
      <p>Баллы: ${r.score}/${r.max_score}</p>
      <p>${r.percent}%</p>
      <button class="btn" onclick="loadTests()">К тестам</button>
    </div>
  `;
}

// ====== INIT ======
(function init() {
  const webapp = tg();
  if (webapp) {
    webapp.ready();
    webapp.expand();
  }

  el("tabTests").onclick = loadTests;
  el("tabResults").onclick = async () => {
    const r = await api(EP.results);
    console.log(r);
  };

  loadTests();
})();
