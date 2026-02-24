// ====== CONFIG ======
const API_BASE = "https://mlmotiv.app.n8n.cloud/webhook"; // <-- твой n8n webhook base
const EP = {
  tests: "tg-tests",
  start: "tg-start",
  submit: "tg-submit",
  results: "tg-results",
};

// ====== LOCAL STORAGE (resume progress) ======
const LS_PREFIX = "mlab_quiz_";

function lsKeyActive(testId) {
  return `${LS_PREFIX}active_${String(testId || "").trim()}`;
}
function lsKeyProgress(sessionToken) {
  return `${LS_PREFIX}progress_${String(sessionToken || "").trim()}`;
}
function lsKeyMeta(sessionToken) {
  return `${LS_PREFIX}meta_${String(sessionToken || "").trim()}`;
}

function getActiveToken(testId) {
  const v = localStorage.getItem(lsKeyActive(testId));
  return v && v.trim() ? v.trim() : null;
}
function setActiveToken(testId, token) {
  if (!testId || !token) return;
  localStorage.setItem(lsKeyActive(testId), String(token));
}
function clearActiveToken(testId) {
  localStorage.removeItem(lsKeyActive(testId));
}

function loadJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}

function loadProgress(sessionToken) {
  return loadJSON(lsKeyProgress(sessionToken));
}
function saveProgress(sessionToken, progress) {
  saveJSON(lsKeyProgress(sessionToken), progress);
}
function clearProgress(sessionToken) {
  removeKey(lsKeyProgress(sessionToken));
  removeKey(lsKeyMeta(sessionToken));
}

// ====== STATE ======
const state = {
  user: null,
  tests: [],
  // tg-results (включая started/submitted/timeout) — используем для статистики попыток
  resultsRaw: [],
  testStats: {}, // { [test_id]: { used: number, hasStarted: boolean } }

  session: null, // start payload
  qIndex: 0,
  answers: {},

  timerId: null,
  autoSubmitted: false,

  // таймер: сохраняем skew при первом старте, чтобы resume не ломал таймер
  skewMs: 0,
  expiresLocal: null,
};

function tg() {
  return window.Telegram?.WebApp || null;
}
function el(id) {
  return document.getElementById(id);
}

function setStatus(msg) {
  el("status").textContent = msg || "";
}

// ====== HELPERS ======
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => {
    return (
      {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[m] || m
    );
  });
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function fmtDurationSecToMin(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m} мин ${s} сек`;
}

function fmtDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  // короче, чтобы влезало на экран
  return new Date(n).toLocaleString("ru-RU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function stopTimer() {
  clearInterval(state.timerId);
  state.timerId = null;
  state.autoSubmitted = false;
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

  // n8n иногда отдаёт JSON как СТРОКУ (если в Respond node стоит JSON.stringify($json))
  let json;
  try {
    json = JSON.parse(text);
    if (typeof json === "string") {
      try {
        json = JSON.parse(json);
      } catch {
        // остаётся строкой — дальше упадём с понятной ошибкой
      }
    }
  } catch {
    throw new Error("Сервер вернул не-JSON: " + text);
  }

  // если сервер вернул строку, а не объект
  if (typeof json === "string") {
    throw new Error("Сервер вернул JSON-строку (проверь Respond node в n8n).");
  }

  return json;
}

// ====== UI ======
function renderLoading(title = "Загрузка...") {
  el("main").innerHTML = `<div class="card"><div>${escapeHtml(title)}</div></div>`;
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
    </div>`;
  el("btnBack").onclick = () => loadTests();
}

function setActiveTab(tab) {
  el("tabTests").classList.toggle("active", tab === "tests");
  el("tabResults").classList.toggle("active", tab === "results");
}

function buildTestStats(tests, resultsRaw) {
  const stats = {};
  for (const t of tests) {
    const tid = String(t.test_id || "").trim();
    if (!tid) continue;
    stats[tid] = { used: 0, hasStarted: false, attemptSet: new Set() };
  }

  for (const r of resultsRaw || []) {
    const tid = String(r.test_id || "").trim();
    if (!tid || !stats[tid]) continue;

    const st = String(r.status || "").trim().toLowerCase();
    if (!["started", "submitted", "timeout"].includes(st)) continue;

    const attemptNo = Number(r.attempt_no || 0);
    // attempt_no обычно 1..N. Если вдруг 0 — всё равно считаем как одну попытку
    stats[tid].attemptSet.add(attemptNo > 0 ? attemptNo : `x_${st}_${fmtDate(r.submit_ms || 0)}`);
    if (st === "started") stats[tid].hasStarted = true;
  }

  for (const tid of Object.keys(stats)) {
    stats[tid].used = stats[tid].attemptSet.size;
    delete stats[tid].attemptSet;
  }

  return stats;
}

function renderTests() {
  const tests = state.tests || [];
  const stats = state.testStats || {};

  const items = tests
    .map((t) => {
      const tid = String(t.test_id || "").trim();
      const maxAtt = Math.max(1, Number(t.max_attempts || 1));

      const st = stats[tid] || { used: 0, hasStarted: false };
      const used = Math.min(maxAtt, Math.max(0, Number(st.used || 0)));

      const hasLocal = !!getActiveToken(tid);
      const hasActive = !!st.hasStarted || hasLocal;

      const canStartNew = used < maxAtt;
      const showButton = hasActive || canStartNew;

      const btnLabel = hasActive ? "Продолжить" : "Начать";

      const timeText = t.time_limit_sec
        ? `${Math.round(Number(t.time_limit_sec) / 60)} мин`
        : "без лимита";

      return `
        <div class="card">
          <div style="font-weight:700">${escapeHtml(t.title || "")}</div>
          <div class="muted" style="margin-top:6px;">
            Время: ${escapeHtml(timeText)} · Попыток: ${used}/${maxAtt}
          </div>

          ${
            showButton
              ? `<div style="margin-top:12px;">
                   <button class="btn" data-test="${escapeHtml(tid)}">${escapeHtml(btnLabel)}</button>
                 </div>`
              : `<div class="muted" style="margin-top:12px;">Попытки закончились</div>`
          }
        </div>
      `;
    })
    .join("");

  el("main").innerHTML = items || `<div class="card">Нет активных тестов</div>`;

  document.querySelectorAll("button[data-test]").forEach((btn) => {
    btn.onclick = () => startTest(btn.getAttribute("data-test"));
  });
}

function getSelected(qid) {
  const arr = state.answers[qid];
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

function saveCurrentProgress() {
  const s = state.session;
  if (!s?.session_token || !s?.test?.test_id) return;

  const token = String(s.session_token);
  const testId = String(s.test.test_id);

  // сохраняем прогресс
  saveProgress(token, {
    qIndex: state.qIndex,
    answers: state.answers,
    saved_at: Date.now(),
  });

  // сохраняем связь testId -> token (для кнопки "Продолжить")
  setActiveToken(testId, token);

  // сохраняем meta (важно: skewMs, чтобы таймер на resume не ломался)
  saveJSON(lsKeyMeta(token), {
    test_id: testId,
    start_ms: s.start_ms,
    expires_ms: s.expires_ms,
    skew_ms: state.skewMs,
    saved_at: Date.now(),
  });
}

function clearSessionLocal(session) {
  if (!session?.session_token || !session?.test?.test_id) return;
  const token = String(session.session_token);
  const testId = String(session.test.test_id);

  clearProgress(token);

  // очищаем active token для теста, если он совпадает
  const cur = getActiveToken(testId);
  if (cur && cur === token) clearActiveToken(testId);
}

function renderQuestion() {
  const s = state.session;
  if (!s?.questions?.length) {
    renderError("Нет вопросов в тесте");
    return;
  }

  const q = s.questions[state.qIndex];
  const isLast = state.qIndex === s.questions.length - 1;

  const qid = String(q.question_id || "").trim();
  const selected = getSelected(qid);
  const hasSelection = selected.length > 0;

  const inputType = q.multi ? "checkbox" : "radio";
  const groupName = `q_${qid}`;

  const answersHtml = (q.answers || [])
    .map((a) => {
      const aid = String(a.answer_id || "").trim();
      const atext = String(a.answer_text || "");
      const checked = q.multi ? selected.includes(aid) : selected[0] === aid;

      return `
        <label>
          <input
            type="${inputType}"
            ${q.multi ? `data-q="${escapeHtml(qid)}"` : `name="${escapeHtml(groupName)}" data-q="${escapeHtml(qid)}"`}
            value="${escapeHtml(aid)}"
            ${checked ? "checked" : ""}
          />
          ${escapeHtml(atext)}
        </label>
      `;
    })
    .join("");

  const progress = `${state.qIndex + 1} / ${s.questions.length}`;
  const qText = String(q.question_text || "");
  const imgUrl = String(q.image_url || "").trim();

  el("main").innerHTML = `
    <div class="card">
      <div class="row">
        <div class="muted">Вопрос ${escapeHtml(progress)}</div>
        <div class="timer" id="timer">${
          s.expires_ms && state.expiresLocal ? fmtTime(state.expiresLocal - Date.now()) : "∞"
        }</div>
      </div>

      <div style="font-weight:700; margin-top:10px; white-space: pre-wrap;">${escapeHtml(qText)}</div>

      ${
        imgUrl
          ? `
            <div class="q-media" style="margin-top:12px;">
              <img id="qImg" class="q-img" src="${escapeHtml(imgUrl)}" alt="Изображение к вопросу" loading="lazy" />
            </div>
            <div class="muted" id="qImgErr" style="margin-top:6px; display:none;">Не удалось загрузить изображение</div>
          `
          : ""
      }

      <div class="muted" style="margin-top:10px;">Баллы за вопрос: ${Number(q.points || 0)}</div>

      <div class="answers" style="margin-top:10px;">${answersHtml}</div>

      <div class="row" style="margin-top:12px;">
        <button class="btn secondary" id="btnPrev" ${state.qIndex === 0 ? "disabled" : ""}>Назад</button>
        ${
          !isLast
            ? `<button class="btn secondary" id="btnNext" ${hasSelection ? "" : "disabled"}>Далее</button>`
            : ""
        }
      </div>

      <div class="row" style="margin-top:12px;">
        <div class="muted">
          Попытка: ${Number(s.attempt_no || 1)}/${Number(s.test?.max_attempts || 1)} · Осталось: ${Number(
            s.remaining_attempts || 0
          )}
        </div>
        ${
          isLast
            ? `<button class="btn" id="btnSubmit" ${hasSelection ? "" : "disabled"}>Отправить</button>`
            : ""
        }
      </div>
    </div>
  `;

  // image onerror handler (чтобы не превращалось в ссылку)
  const img = document.getElementById("qImg");
  if (img) {
    img.onerror = () => {
      const err = document.getElementById("qImgErr");
      if (err) err.style.display = "block";
      img.style.display = "none";
    };
  }

  // input handlers
  document.querySelectorAll('input[data-q="' + CSS.escape(qid) + '"]').forEach((inp) => {
    inp.onchange = () => {
      const qid2 = inp.getAttribute("data-q");
      const qObj = s.questions[state.qIndex];
      const isMulti2 = !!qObj.multi;

      if (isMulti2) {
        const checkedIds = Array.from(document.querySelectorAll(`input[data-q="${CSS.escape(qid2)}"]`))
          .filter((x) => x.checked)
          .map((x) => x.value);
        state.answers[qid2] = Array.from(new Set(checkedIds));
      } else {
        // radio
        const picked = inp.value ? [inp.value] : [];
        state.answers[qid2] = picked;
      }

      saveCurrentProgress();
      // обновить disabled на кнопках
      renderQuestion();
    };
  });

  // nav
  el("btnPrev").onclick = () => {
    state.qIndex = Math.max(0, state.qIndex - 1);
    saveCurrentProgress();
    renderQuestion();
  };

  const btnNext = document.getElementById("btnNext");
  if (btnNext) {
    btnNext.onclick = () => {
      state.qIndex = Math.min(s.questions.length - 1, state.qIndex + 1);
      saveCurrentProgress();
      renderQuestion();
    };
  }

  const btnSubmit = document.getElementById("btnSubmit");
  if (btnSubmit) {
    btnSubmit.onclick = () => submitCurrent(false);
  }
}

function renderSubmitResult(r) {
  stopTimer();

  const durationText = fmtDurationSecToMin(r.duration_sec);
  const extra = r.expired ? " (время истекло)" : "";

  el("main").innerHTML = `
    <div class="card">
      <div style="font-weight:700; font-size:16px;">Результат</div>

      <div style="margin-top:10px;">
        Баллы: <b>${Number(r.score || 0)}</b> / ${Number(r.max_score || 0)} (${Number(r.percent || 0)}%)
      </div>

      <div class="muted" style="margin-top:6px;">
        Длительность: ${escapeHtml(durationText)} · Попытка: ${Number(r.attempt_no || 1)}${escapeHtml(extra)}
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
  const clean = (results || []).filter((r) => {
    const st = String(r.status || "").trim().toLowerCase();
    return st === "submitted" || st === "timeout";
  });

  if (!clean.length) {
    el("main").innerHTML = `<div class="card">Результатов пока нет.</div>`;
    return;
  }

  const rows = clean
    .map((r) => {
      const dt = fmtDate(r.submit_ms);
      return `
        <tr>
          <td style="text-align:left;">${escapeHtml(r.test_title || r.test_id || "")}</td>
          <td style="text-align:center;">${Number(r.attempt_no || 0)}</td>
          <td style="text-align:center;">${Number(r.score || 0)}/${Number(r.max_score || 0)} (${Number(r.percent || 0)}%)</td>
          <td style="text-align:center;">${escapeHtml(dt)}</td>
        </tr>
      `;
    })
    .join("");

  el("main").innerHTML = `
    <div class="card">
      <div style="font-weight:700; margin-bottom:8px;">Мои результаты</div>
      <table>
        <thead>
          <tr>
            <th style="text-align:left;">Тест</th>
            <th style="text-align:center;">#</th>
            <th style="text-align:center;">Баллы</th>
            <th style="text-align:center;">Дата</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ====== TIMER ======
function startTimer() {
  stopTimer();
  state.autoSubmitted = false;

  if (!state.session?.expires_ms || !state.expiresLocal) return;

  state.timerId = setInterval(() => {
    const tEl = document.getElementById("timer");
    if (!tEl) return;

    const remain = state.expiresLocal - Date.now();
    tEl.textContent = fmtTime(remain);

    if (remain <= 0 && !state.autoSubmitted) {
      state.autoSubmitted = true;
      stopTimer();
      submitCurrent(true).catch(() => {});
    }
  }, 250);
}

// ====== ACTIONS ======
async function loadTests() {
  try {
    stopTimer();
    setStatus("");
    renderLoading("Загрузка тестов...");

    // параллельно подтягиваем tests + results (для подсчёта попыток/started)
    const [rt, rr] = await Promise.allSettled([api(EP.tests, {}), api(EP.results, {})]);

    if (rt.status !== "fulfilled" || !rt.value?.ok) {
      throw new Error(rt.status === "rejected" ? rt.reason?.message : rt.value?.error || "Не удалось загрузить тесты");
    }

    const testsRes = rt.value;
    state.user = testsRes.user;
    state.tests = testsRes.tests || [];

    // results могут упасть — тогда просто не скроем кнопки заранее
    let resultsRaw = [];
    if (rr.status === "fulfilled" && rr.value?.ok) {
      resultsRaw = rr.value.results || [];
    }
    state.resultsRaw = resultsRaw;

    state.testStats = buildTestStats(state.tests, state.resultsRaw);

    // сверху показываем ТОЛЬКО имя (без @username)
    el("userBadge").textContent = state.user?.full_name ? `${state.user.full_name}` : "";

    renderTests();
    setActiveTab("tests");
    setStatus("");
  } catch (e) {
    renderError(e);
  }
}

async function startTest(testId) {
  try {
    stopTimer();
    setStatus("");
    renderLoading("Старт теста...");

    const r = await api(EP.start, { testId });
    if (!r.ok) throw new Error(r.error || "Не удалось стартовать тест");

    state.session = r;

    const token = String(r.session_token || "");
    const tid = String(r.test?.test_id || testId || "");

    // если раньше локально был другой active token по этому тесту — чистим его
    const prevToken = getActiveToken(tid);
    if (prevToken && prevToken !== token) {
      clearProgress(prevToken);
    }

    // skew: берём из meta, если есть (resume), иначе считаем и сохраняем
    const meta = loadJSON(lsKeyMeta(token));
    if (meta && Number.isFinite(meta.skew_ms)) {
      state.skewMs = Number(meta.skew_ms);
    } else if (!r.resume) {
      state.skewMs = Date.now() - Number(r.start_ms || Date.now());
      saveJSON(lsKeyMeta(token), {
        test_id: tid,
        start_ms: r.start_ms,
        expires_ms: r.expires_ms,
        skew_ms: state.skewMs,
        saved_at: Date.now(),
      });
    } else {
      // если резюмим на другом устройстве и meta нет — просто без коррекции
      state.skewMs = 0;
    }

    state.expiresLocal = r.expires_ms ? Number(r.expires_ms) + state.skewMs : null;

    // restore progress if resume=true
    state.qIndex = 0;
    state.answers = {};

    if (r.resume && token) {
      const saved = loadProgress(token);
      if (saved && typeof saved === "object") {
        const idx = Number(saved.qIndex || 0);
        state.qIndex = clamp(idx, 0, (r.questions?.length || 1) - 1);
        state.answers = saved.answers && typeof saved.answers === "object" ? saved.answers : {};
      }
    }

    // сохраняем active + прогресс сразу (чтобы “Продолжить” появлялось)
    setActiveToken(tid, token);
    saveCurrentProgress();

    renderQuestion();
    startTimer();
    setActiveTab("tests");
  } catch (e) {
    renderError(e);
  }
}

async function submitCurrent(auto = false) {
  try {
    if (!state.session) return;

    const s = state.session;

    stopTimer();
    setStatus(auto ? "Время истекло — отправляем ответы..." : "Ответы отправляются...");
    renderLoading(auto ? "Время истекло — отправляем ответы..." : "Ответы отправляются...");

    const r = await api(EP.submit, {
      testId: s.test.test_id,
      start_ms: s.start_ms,
      session_token: s.session_token,
      answers: state.answers,
    });

    if (!r.ok) throw new Error(r.error || "Не удалось отправить ответы");

    // очистка localStorage после успешного submit
    clearSessionLocal(s);

    setStatus("");
    renderSubmitResult(r);
  } catch (e) {
    setStatus("");
    renderError(e);
  }
}

async function loadResults() {
  try {
    stopTimer();
    setStatus("");
    renderLoading("Загрузка результатов...");

    const r = await api(EP.results, {});
    if (!r.ok) throw new Error(r.error || "Не удалось загрузить результаты");

    renderResultsList(r.results || []);
    setActiveTab("results");
    setStatus("");
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
