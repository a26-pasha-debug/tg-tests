// ===== CONFIG =====
const API_BASE = "https://mlmotiv.app.n8n.cloud/webhook";

const EP = {
  tests: "tg-tests",
  start: "tg-start",
  submit: "tg-submit",
  results: "tg-results",
};

// ===== STATE =====
const state = {
  user: null,
  tests: [],
  resultsRaw: [],
  testStats: {},
  session: null,
};

// ===== HELPERS =====
function tg() {
  return window.Telegram?.WebApp || null;
}

function el(id) {
  return document.getElementById(id);
}

function norm(x) {
  return String(x ?? "").trim();
}

function toInt(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])
  );
}

function renderLoading(text = "Загрузка...") {
  el("main").innerHTML = `
    <div class="card loader-card">
      <div class="loader"></div>
      <div class="loader-text">${escapeHtml(text)}</div>
    </div>
  `;
}

function renderError(msg) {
  el("main").innerHTML = `
    <div class="card">
      <div style="font-weight:700;margin-bottom:8px;">Ошибка</div>
      <div class="muted">${escapeHtml(msg)}</div>
      <div style="margin-top:12px;">
        <button class="btn secondary" onclick="loadTests()">Назад</button>
      </div>
    </div>
  `;
}

// ===== API =====
async function api(path, data = {}) {
  const webapp = tg();
  if (!webapp) throw new Error("Открой MiniApp внутри Telegram");

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
  } catch {
    throw new Error("Сервер вернул не JSON");
  }

  return json;
}

// ===== BUILD STATS =====
function buildTestStats(tests, results, telegramId) {
  const stats = {};

  for (const t of tests) {
    stats[norm(t.test_id)] = {
      used: 0,
      activeToken: null,
      finalized: new Set(),
      started: new Map(),
    };
  }

  for (const r of results) {
    if (norm(r.telegram_id) !== norm(telegramId)) continue;

    const tid = norm(r.test_id);
    if (!stats[tid]) continue;

    const status = norm(r.status).toLowerCase();
    if (!["started", "submitted", "timeout"].includes(status)) continue;

    const token = norm(r.session_token);
    const startMs = toInt(r.start_ms);

    const key = token || `start:${startMs}`;

    stats[tid].used += 1;

    if (status === "submitted" || status === "timeout") {
      stats[tid].finalized.add(key);
    }

    if (status === "started") {
      stats[tid].started.set(key, {
        startMs,
        expiresMs: toInt(r.expires_ms),
      });
    }
  }

  for (const tid in stats) {
    const s = stats[tid];

    for (const [key, rec] of s.started.entries()) {
      if (!s.finalized.has(key)) {
        s.activeToken = key;
        break;
      }
    }
  }

  return stats;
}

// ===== RENDER TESTS =====
function renderTests() {
  const tests = state.tests;
  const stats = state.testStats;

  const html = tests
    .map((t) => {
      const tid = norm(t.test_id);
      const maxAttempts = Math.max(1, toInt(t.max_attempts, 1));

      const st = stats[tid] || { used: 0, activeToken: null };

      const used = Math.min(st.used, maxAttempts);
      const attemptsLeft = maxAttempts - used;
      const hasActive = !!st.activeToken;

      const showStart = attemptsLeft > 0 && !hasActive;
      const showContinue = hasActive;

      return `
        <div class="card">
          <div style="font-weight:700">${escapeHtml(t.title)}</div>
          <div class="muted" style="margin-top:6px;">
            Время: ${Math.round(toInt(t.time_limit_sec)/60)} мин · Попыток: ${used}/${maxAttempts}
          </div>

          ${
            showContinue
              ? `<button class="btn" onclick="startTest('${tid}')">Продолжить</button>`
              : showStart
              ? `<button class="btn" onclick="startTest('${tid}')">Начать</button>`
              : `<div class="muted" style="margin-top:12px;">Попытки закончились</div>`
          }
        </div>
      `;
    })
    .join("");

  el("main").innerHTML = html || `<div class="card">Нет тестов</div>`;
}

// ===== LOAD TESTS =====
async function loadTests() {
  try {
    renderLoading("Загрузка тестов...");

    const testsRes = await api(EP.tests);
    if (!testsRes.ok) throw new Error(testsRes.error);

    state.user = testsRes.user;
    state.tests = testsRes.tests || [];

    const resultsRes = await api(EP.results);
    if (!resultsRes.ok) throw new Error(resultsRes.error);

    state.resultsRaw = resultsRes.results || [];

    state.testStats = buildTestStats(
      state.tests,
      state.resultsRaw,
      state.user?.telegram_id
    );

    renderTests();
  } catch (e) {
    renderError(e.message);
  }
}

// ===== START TEST =====
async function startTest(testId) {
  try {
    renderLoading("Старт теста...");

    const r = await api(EP.start, { testId });

    if (!r.ok) {
      if (/попытки/i.test(r.error)) {
        await loadTests();
        return;
      }
      throw new Error(r.error);
    }

    state.session = r;

    el("main").innerHTML = `
      <div class="card">
        Тест запущен
      </div>
    `;
  } catch (e) {
    renderError(e.message);
  }
}

// ===== INIT =====
(function init() {
  const webapp = tg();
  if (webapp) {
    webapp.ready();
    webapp.expand();
  }

  loadTests();
})();
