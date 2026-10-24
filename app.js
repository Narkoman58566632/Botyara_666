// Кабинет Twitch-бота. Чистый JS-модуль, без сборки.
// Версия Firebase JS SDK зафиксирована в импортах ниже (одна и та же во всех трёх).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getDatabase, ref, onValue, set, update, runTransaction, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';

import { config } from './config.js';
import {
  LIMITS, TOKEN_PATTERN,
  validateValorantName, validateTag, validateRegion, validateCommandName,
  validateMessageText, validateInterval,
  normalizeChannel, timersAdd, timersEdit, timersRemove,
  parseTwitchHash, buildTwitchAuthUrl, makeState,
} from './validation.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['loading', 'error', 'login', 'linking', 'linkfail', 'nochannel', 'dashboard'];
const STATE_KEY = 'twitch_oauth_state';

let auth = null;
let db = null;

// Состояние текущей сессии (сбрасывается при выходе)
let S = null;
function freshState() {
  return {
    id: Date.now() + Math.random(),
    uid: null,
    nick: null,
    channel: undefined,        // undefined = ещё не загружен, null = канала нет
    pendingToken: null,
    linking: false,
    linkTimer: null,
    unsubUser: null,
    unsubChannel: null,
    editingCmd: null,          // название команды, которую правим
    editingTimer: null,        // { index, old }
    dirtyValorant: false,
    dirtyInterval: false,
  };
}

// ---------- Вспомогательное ----------

function showView(name) {
  for (const v of VIEWS) $('view-' + v).hidden = v !== name;
  $('userbox').hidden = !(name === 'dashboard' || name === 'nochannel') || !S?.nick;
}

let toastTimer = null;
function toast(msg, kind = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'err' ? 6500 : 2500);
}

function showFatal(text) {
  $('errorText').textContent = text;
  showView('error');
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function setError(id, msg) {
  const p = $(id);
  p.textContent = msg || '';
  p.hidden = !msg;
}

function friendlyError(e) {
  const code = String(e?.code || '');
  const msg = String(e?.message || '');
  if (/permission_denied/i.test(code + msg)) {
    return 'Сервер не принял изменение. Возможно, бот отключён от канала (!leave) или данные не прошли проверку.';
  }
  if (/network|unavailable|offline|disconnected/i.test(code + msg)) {
    return 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.';
  }
  return 'Не удалось сохранить: ' + (code || msg || 'неизвестная ошибка');
}

async function save(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg, 'ok');
    return true;
  } catch (e) {
    console.error(e);
    toast(friendlyError(e), 'err');
    return false;
  }
}

function channelRef() { return ref(db, `channels/${S.nick}`); }

// ---------- Настройки и запуск ----------

function configProblem() {
  const f = config.firebase || {};
  const needed = [f.apiKey, f.authDomain, f.databaseURL, f.projectId, f.appId, config.twitchClientId];
  if (needed.some((v) => !v || String(v).includes('ВСТАВЬТЕ'))) {
    return 'Сайт ещё не настроен: откройте файл config.js и впишите значения Firebase и Twitch Client ID.';
  }
  return null;
}

function redirectUri() {
  if (config.redirectUri) return config.redirectUri;
  const path = location.pathname.replace(/index\.html$/, '');
  return location.origin + path;
}

function saveOauthState(value) {
  try { sessionStorage.setItem(STATE_KEY, value); return true; } catch { /* ниже запасной вариант */ }
  try { localStorage.setItem(STATE_KEY, value); return true; } catch { return false; }
}
function takeOauthState() {
  let v = null;
  try { v = sessionStorage.getItem(STATE_KEY); sessionStorage.removeItem(STATE_KEY); } catch { /* */ }
  if (!v) {
    try { v = localStorage.getItem(STATE_KEY); localStorage.removeItem(STATE_KEY); } catch { /* */ }
  }
  return v;
}

function startLogin() {
  const state = makeState(crypto.getRandomValues(new Uint8Array(16)));
  if (!saveOauthState(state)) {
    toast('Браузер блокирует хранение данных сайта, вход через Twitch невозможен. Отключите приватный режим или блокировщик.', 'err');
    return;
  }
  location.href = buildTwitchAuthUrl({
    clientId: config.twitchClientId,
    redirectUri: redirectUri(),
    state,
  });
}

// Разбираем ответ Twitch из адресной строки и сразу убираем его оттуда.
function consumeTwitchReturn() {
  if (!/access_token=|error=/.test(location.hash)) return { token: null, message: null };
  const p = parseTwitchHash(location.hash);
  history.replaceState(null, '', location.pathname + location.search);
  const expected = takeOauthState();
  if (p.error) {
    return { token: null, message: 'Вход через Twitch отменён или не удался.' };
  }
  if (!expected || p.state !== expected) {
    return { token: null, message: 'Не удалось подтвердить вход (проверка state). Попробуйте войти ещё раз.' };
  }
  if (!p.accessToken || !TOKEN_PATTERN.test(p.accessToken)) {
    return { token: null, message: 'Twitch вернул неожиданный ответ. Попробуйте войти ещё раз.' };
  }
  return { token: p.accessToken, message: null };
}

function authErrorText(e) {
  const code = String(e?.code || '');
  if (/operation-not-allowed|admin-restricted/.test(code)) {
    return 'В Firebase не включён анонимный вход. Откройте Authentication → Sign-in method и включите «Anonymous».';
  }
  if (/unauthorized-domain/.test(code)) {
    return 'Адрес сайта не добавлен в Firebase: Authentication → Settings → Authorized domains.';
  }
  if (/network/.test(code)) return 'Нет связи с сервером. Проверьте интернет и обновите страницу.';
  return 'Не удалось войти в Firebase: ' + (code || e?.message || 'неизвестная ошибка');
}

function currentUserOnce() {
  return new Promise((resolve) => {
    const off = onAuthStateChanged(auth, (u) => { off(); resolve(u); });
  });
}

async function startSession(pendingToken = null) {
  teardown();
  S = freshState();
  S.pendingToken = pendingToken;
  showView('loading');
  $('loadingText').textContent = 'Загрузка…';
  const sid = S.id;
  try {
    let user = await currentUserOnce();
    if (!user) user = (await signInAnonymously(auth)).user;
    if (!S || S.id !== sid) return;
    S.uid = user.uid;
  } catch (e) {
    console.error(e);
    showFatal(authErrorText(e));
    return;
  }
  subscribeUser();
}

function teardown() {
  if (!S) return;
  clearTimeout(S.linkTimer);
  try { S.unsubUser?.(); } catch { /* */ }
  try { S.unsubChannel?.(); } catch { /* */ }
  S.unsubUser = S.unsubChannel = null;
  S.id = null;
}

// ---------- Привязка ----------

function subscribeUser() {
  const sid = S.id;
  S.unsubUser = onValue(
    ref(db, `users/${S.uid}`),
    (snap) => {
      if (!S || S.id !== sid) return;
      const v = snap.val();
      if (typeof v === 'string' && v) onLinked(v);
      else onUnlinked();
    },
    (err) => {
      console.error(err);
      if (!S || S.id !== sid) return;
      showFatal('Нет доступа к базе данных: ' + (err?.code || err?.message) + '. Проверьте правила базы и адрес databaseURL в config.js.');
    },
  );
}

function onLinked(nick) {
  clearTimeout(S.linkTimer);
  S.linking = false;
  S.pendingToken = null;
  if (S.nick === nick) return;
  S.nick = nick;
  $('userNick').textContent = nick;
  S.channel = undefined;
  $('loadingText').textContent = 'Загружаем настройки…';
  showView('loading');
  subscribeChannel();
}

function onUnlinked() {
  if (S.nick) { // связь пропала на лету: начинаем заново
    try { S.unsubChannel?.(); } catch { /* */ }
    S.nick = null;
    S.channel = undefined;
  }
  if (S.pendingToken) { sendLink(); return; }
  if (!S.linking) showView('login');
}

async function sendLink() {
  const token = S.pendingToken;
  S.pendingToken = null;
  S.linking = true;
  showView('linking');
  const sid = S.id;
  const fail = () => {
    if (!S || S.id !== sid || S.nick) return;
    S.linking = false;
    showView('linkfail');
  };
  S.linkTimer = setTimeout(fail, (config.linkTimeoutSec || 15) * 1000);
  try {
    await set(ref(db, `linkRequests/${S.uid}`), { token, createdAt: serverTimestamp() });
  } catch (e) {
    console.error(e);
    clearTimeout(S.linkTimer);
    fail();
  }
}

// ---------- Канал ----------

function subscribeChannel() {
  const sid = S.id;
  const nick = S.nick;
  S.unsubChannel = onValue(
    ref(db, `channels/${nick}`),
    (snap) => {
      if (!S || S.id !== sid || S.nick !== nick) return;
      S.channel = normalizeChannel(snap.val());
      if (!S.channel) {
        S.editingCmd = null;
        S.editingTimer = null;
        showView('nochannel');
      } else {
        showView('dashboard');
        renderDashboard();
      }
    },
    (err) => {
      console.error(err);
      if (!S || S.id !== sid) return;
      showFatal('Нет доступа к настройкам канала (' + (err?.code || err?.message) + '). Попробуйте выйти и войти заново.');
    },
  );
}

// ---------- Отрисовка кабинета ----------

function renderDashboard() {
  const ch = S.channel;
  if (!ch) return;

  // Бот вкл/выкл
  $('enabledToggle').checked = ch.enabled;
  $('enabledLabel').textContent = ch.enabled ? 'Включён' : 'Выключен';
  $('enabledNote').textContent = ch.enabled
    ? 'Бот отвечает в чате: !rank, свои команды и авто-сообщения работают.'
    : 'Бот молчит в чате: !rank, команды и авто-сообщения не отправляются. Управление через чат продолжает работать.';

  // Valorant
  if (!S.dirtyValorant) {
    $('vName').value = ch.name;
    $('vTag').value = ch.tag;
    $('vRegion').value = ch.region;
  }

  renderCommands(ch);
  renderTimers(ch);
}

function renderCommands(ch) {
  const list = $('cmdList');
  list.replaceChildren();
  for (const [name, text] of ch.commands) {
    const li = el('li', { class: 'item' + (S.editingCmd === name ? ' editing' : '') }, [
      el('div', { class: 'item-main' }, [
        el('div', { class: 'item-name', text: name }),
        el('div', { class: 'item-text', text: text }),
      ]),
      el('div', { class: 'item-actions' }, [
        el('button', { class: 'btn small', type: 'button', text: 'Изменить', onclick: () => editCommand(name, text) }),
        el('button', { class: 'btn small danger', type: 'button', text: 'Удалить', onclick: () => deleteCommand(name) }),
      ]),
    ]);
    list.append(li);
  }
  $('cmdEmpty').hidden = ch.commands.length > 0;
  // если правимую команду удалили в чате: выходим из режима правки
  if (S.editingCmd && !ch.commands.some(([n]) => n === S.editingCmd)) resetCommandForm();
}

function renderTimers(ch) {
  $('timerToggle').checked = !ch.timerOff;
  $('timerLabel').textContent = ch.timerOff ? 'Выключены' : 'Включены';

  if (!S.dirtyInterval) $('tInterval').value = ch.timerInterval == null ? '' : String(ch.timerInterval);
  $('intervalNote').textContent = ch.timerInterval == null
    ? 'Сейчас используется интервал по умолчанию, заданный в боте. Чтобы задать свой, введите число минут от 1 до 1440.'
    : `Бот пишет одно сообщение раз в ${ch.timerInterval} мин. (если в чате есть активность). Пустое поле = интервал по умолчанию.`;

  const list = $('timerList');
  list.replaceChildren();
  ch.timers.forEach((text, index) => {
    list.append(el('li', { class: 'item' + (S.editingTimer?.index === index ? ' editing' : '') }, [
      el('div', { class: 'item-main' }, [el('div', { class: 'item-text', text })]),
      el('div', { class: 'item-actions' }, [
        el('button', { class: 'btn small', type: 'button', text: 'Изменить', onclick: () => editTimer(index, text) }),
        el('button', { class: 'btn small danger', type: 'button', text: 'Удалить', onclick: () => deleteTimer(index, text) }),
      ]),
    ]));
  });
  $('timerEmpty').hidden = ch.timers.length > 0;

  const botLimit = config.botTimersLimit;
  const warn = $('timerWarn');
  if (botLimit && ch.timers.length > botLimit) {
    warn.textContent = `Бот по умолчанию принимает до ${botLimit} авто-сообщений (лимит задаёт владелец бота), остальные могут не отправляться.`;
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }

  if (S.editingTimer && ch.timers[S.editingTimer.index] !== S.editingTimer.old) resetTimerForm();
}

// ---------- Действия: бот и Valorant ----------

async function onEnabledChange() {
  const box = $('enabledToggle');
  box.disabled = true;
  await save(() => update(channelRef(), { enabled: box.checked }), box.checked ? 'Бот включён' : 'Бот выключен');
  box.disabled = false;
}

async function onValorantSubmit(ev) {
  ev.preventDefault();
  const n = validateValorantName($('vName').value);
  const t = validateTag($('vTag').value);
  const r = validateRegion($('vRegion').value);
  const bad = [n, t, r].find((x) => !x.ok);
  if (bad) { setError('vError', bad.error); return; }
  setError('vError', '');
  $('vSave').disabled = true;
  const ok = await save(() => update(channelRef(), { name: n.value, tag: t.value, region: r.value }), 'Аккаунт Valorant сохранён');
  $('vSave').disabled = false;
  if (ok) {
    S.dirtyValorant = false;
    $('vName').value = n.value;
    $('vTag').value = t.value;
  }
}

// ---------- Действия: команды ----------

function resetCommandForm() {
  S.editingCmd = null;
  $('cmdName').value = '';
  $('cmdText').value = '';
  $('cmdFormTitle').textContent = 'Новая команда';
  $('cmdSave').textContent = 'Добавить команду';
  $('cmdCancel').hidden = true;
  setError('cmdError', '');
  updateCounter('cmdText', 'cmdCount');
}

function editCommand(name, text) {
  S.editingCmd = name;
  $('cmdName').value = name;
  $('cmdText').value = text;
  $('cmdFormTitle').textContent = 'Изменить команду';
  $('cmdSave').textContent = 'Сохранить изменения';
  $('cmdCancel').hidden = false;
  setError('cmdError', '');
  updateCounter('cmdText', 'cmdCount');
  renderCommands(S.channel);
  $('cmdForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('cmdText').focus();
}

async function onCommandSubmit(ev) {
  ev.preventDefault();
  const n = validateCommandName($('cmdName').value);
  if (!n.ok) { setError('cmdError', n.error); return; }
  const t = validateMessageText($('cmdText').value);
  if (!t.ok) { setError('cmdError', t.error); return; }

  const old = S.editingCmd;
  const exists = S.channel.commands.some(([name]) => name === n.value);
  if (exists && n.value !== old) {
    setError('cmdError', `Команда ${n.value} уже есть. Нажмите «Изменить» рядом с ней.`);
    return;
  }
  setError('cmdError', '');

  const changes = { [`commands/${n.value}`]: t.value };
  if (old && old !== n.value) changes[`commands/${old}`] = null; // переименование
  $('cmdSave').disabled = true;
  const ok = await save(() => update(channelRef(), changes), old ? 'Команда изменена' : 'Команда добавлена');
  $('cmdSave').disabled = false;
  if (ok) resetCommandForm();
}

async function deleteCommand(name) {
  if (!confirm(`Удалить команду ${name}?`)) return;
  const ok = await save(() => update(channelRef(), { [`commands/${name}`]: null }), 'Команда удалена');
  if (ok && S.editingCmd === name) resetCommandForm();
}

// ---------- Действия: авто-сообщения ----------

function resetTimerForm() {
  S.editingTimer = null;
  $('timerText').value = '';
  $('timerFormTitle').textContent = 'Новое авто-сообщение';
  $('timerSave').textContent = 'Добавить сообщение';
  $('timerCancel').hidden = true;
  setError('timerError', '');
  updateCounter('timerText', 'timerCount');
}

function editTimer(index, old) {
  S.editingTimer = { index, old };
  $('timerText').value = old;
  $('timerFormTitle').textContent = 'Изменить авто-сообщение';
  $('timerSave').textContent = 'Сохранить изменения';
  $('timerCancel').hidden = false;
  setError('timerError', '');
  updateCounter('timerText', 'timerCount');
  renderTimers(S.channel);
  $('timerForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('timerText').focus();
}

async function timersTransaction(mutator) {
  const res = await runTransaction(ref(db, `channels/${S.nick}/timers`), mutator);
  return res.committed;
}

async function onTimerSubmit(ev) {
  ev.preventDefault();
  const t = validateMessageText($('timerText').value);
  if (!t.ok) { setError('timerError', t.error); return; }
  const editing = S.editingTimer;
  if (!editing && S.channel.timers.length >= LIMITS.timersMax) {
    setError('timerError', `Достигнут максимум: ${LIMITS.timersMax} авто-сообщений. Удалите ненужное.`);
    return;
  }
  setError('timerError', '');
  $('timerSave').disabled = true;
  let committed = false;
  const ok = await save(async () => {
    committed = await timersTransaction(
      editing ? timersEdit(editing.index, editing.old, t.value) : timersAdd(t.value),
    );
  });
  $('timerSave').disabled = false;
  if (!ok) return;
  if (committed) {
    toast(editing ? 'Сообщение изменено' : 'Сообщение добавлено', 'ok');
    resetTimerForm();
  } else {
    toast('Список изменился (возможно, правка из чата) или достигнут лимит. Проверьте список и повторите.', 'err');
  }
}

async function deleteTimer(index, old) {
  if (!confirm('Удалить это авто-сообщение?')) return;
  let committed = false;
  const ok = await save(async () => { committed = await timersTransaction(timersRemove(index, old)); });
  if (!ok) return;
  if (committed) {
    toast('Сообщение удалено', 'ok');
    if (S.editingTimer) resetTimerForm();
  } else {
    toast('Список изменился. Проверьте его и повторите.', 'err');
  }
}

async function onTimerToggle() {
  const box = $('timerToggle');
  box.disabled = true;
  await save(() => update(channelRef(), { timerOff: !box.checked }), box.checked ? 'Авто-сообщения включены' : 'Авто-сообщения выключены');
  box.disabled = false;
}

async function onIntervalSubmit(ev) {
  ev.preventDefault();
  const raw = $('tInterval').value.trim();
  let value;
  if (raw === '') {
    value = null; // сброс до значения по умолчанию в боте
  } else {
    const r = validateInterval(raw);
    if (!r.ok) { setError('intervalError', r.error); return; }
    value = r.value;
  }
  setError('intervalError', '');
  $('tIntervalSave').disabled = true;
  const ok = await save(
    () => update(channelRef(), { timerInterval: value }),
    value === null ? 'Интервал сброшен до значения по умолчанию' : 'Интервал сохранён',
  );
  $('tIntervalSave').disabled = false;
  if (ok) S.dirtyInterval = false;
}

// ---------- Выход ----------

async function logout() {
  teardown();
  S = null;
  try { await signOut(auth); } catch (e) { console.error(e); }
  $('userNick').textContent = '';
  await startSession(null);
}

// ---------- Подсказки ----------

function updateCounter(textId, counterId) {
  const len = $(textId).value.trim().length;
  const c = $(counterId);
  c.textContent = `${len}/${LIMITS.textMax}`;
  c.classList.toggle('over', len > LIMITS.textMax);
}

function fillBotName() {
  if (!config.botName) return;
  const name = String(config.botName).replace(/[^A-Za-z0-9_]/g, '');
  if (!name) return;
  for (const span of document.querySelectorAll('.botname')) {
    span.append(' (', el('a', { href: `https://www.twitch.tv/${name}`, target: '_blank', rel: 'noopener', text: name }), ')');
  }
}

// ---------- Запуск ----------

function bindUi() {
  $('loginBtn').addEventListener('click', startLogin);
  $('linkRetry').addEventListener('click', startLogin);
  $('errorRetry').addEventListener('click', () => location.reload());
  $('logoutBtn').addEventListener('click', logout);

  $('enabledToggle').addEventListener('change', onEnabledChange);
  $('valorantForm').addEventListener('submit', onValorantSubmit);
  for (const id of ['vName', 'vTag', 'vRegion']) {
    $(id).addEventListener('input', () => { if (S) S.dirtyValorant = true; });
    $(id).addEventListener('change', () => { if (S) S.dirtyValorant = true; });
  }

  $('cmdForm').addEventListener('submit', onCommandSubmit);
  $('cmdCancel').addEventListener('click', resetCommandForm);
  $('cmdText').addEventListener('input', () => updateCounter('cmdText', 'cmdCount'));

  $('timerToggle').addEventListener('change', onTimerToggle);
  $('intervalForm').addEventListener('submit', onIntervalSubmit);
  $('tInterval').addEventListener('input', () => { if (S) S.dirtyInterval = true; });
  $('timerForm').addEventListener('submit', onTimerSubmit);
  $('timerCancel').addEventListener('click', resetTimerForm);
  $('timerText').addEventListener('input', () => updateCounter('timerText', 'timerCount'));

  updateCounter('cmdText', 'cmdCount');
  updateCounter('timerText', 'timerCount');
  fillBotName();
}

async function main() {
  bindUi();
  showView('loading');

  const problem = configProblem();
  if (problem) { showFatal(problem); return; }

  const ret = consumeTwitchReturn(); // сразу убирает токен из адресной строки

  try {
    const app = initializeApp(config.firebase);
    auth = getAuth(app);
    db = getDatabase(app);
  } catch (e) {
    console.error(e);
    showFatal('Не удалось запустить Firebase: проверьте значения в config.js.');
    return;
  }

  await startSession(ret.token);
  if (ret.message) toast(ret.message, 'err');
}

main();
