// Чистая логика без браузера и Firebase: проверки полей (зеркало database.rules.json),
// работа со списком авто-сообщений и разбор ответа Twitch. Тестируется в Node.

export const LIMITS = {
  nameMin: 3,
  nameMax: 16,
  tagPattern: /^[A-Za-z0-9]{3,5}$/,
  regions: ['eu', 'na', 'ap', 'kr'],
  cmdMax: 20,          // символов после "!"
  textMax: 400,
  timersMax: 20,       // по схеме (ключи 0..19)
  intervalMin: 1,
  intervalMax: 1440,
};

// Встроенные команды бота: свои команды с такими именами бот, скорее всего, не вызовет.
export const RESERVED_COMMANDS = ['!rank', '!setrank', '!join', '!leave'];

const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error });

export function validateValorantName(input) {
  const v = String(input ?? '').trim();
  if (v.length < LIMITS.nameMin || v.length > LIMITS.nameMax) {
    return fail(`Ник Valorant: от ${LIMITS.nameMin} до ${LIMITS.nameMax} символов.`);
  }
  return ok(v);
}

export function validateTag(input) {
  const v = String(input ?? '').trim().replace(/^#/, '');
  if (!LIMITS.tagPattern.test(v)) {
    return fail('Тег: от 3 до 5 латинских букв или цифр (без #), например 1234.');
  }
  return ok(v);
}

export function validateRegion(input) {
  const v = String(input ?? '').trim().toLowerCase();
  if (!LIMITS.regions.includes(v)) return fail('Выберите регион: eu, na, ap или kr.');
  return ok(v);
}

// Символы, запрещённые в ключах Firebase: . $ # [ ] / и управляющие.
const BAD_KEY_CHARS = /[.$#\[\]\/\u0000-\u001f\u007f]/;

export function validateCommandName(input) {
  let v = String(input ?? '').trim().toLowerCase();
  if (v === '') return fail('Введите название команды, например !discord');
  if (!v.startsWith('!')) v = '!' + v;
  const body = v.slice(1);
  if (body.length < 1 || body.length > LIMITS.cmdMax) {
    return fail(`Название команды: ! и от 1 до ${LIMITS.cmdMax} символов.`);
  }
  if (/\s/.test(body)) return fail('В названии команды не должно быть пробелов.');
  if (BAD_KEY_CHARS.test(v)) {
    return fail('В названии команды нельзя использовать . $ # [ ] / и служебные символы.');
  }
  if (RESERVED_COMMANDS.includes(v)) {
    return fail(`${v} — встроенная команда бота, выберите другое название.`);
  }
  return ok(v);
}

// Текст команды и авто-сообщения: 1..400 символов, не начинается с / или . (даже после пробелов).
export function validateMessageText(input) {
  // В чате Twitch нет переносов строк: заменяем их пробелом.
  const v = String(input ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (v.length < 1) return fail('Текст не может быть пустым.');
  if (v.length > LIMITS.textMax) {
    return fail(`Текст слишком длинный: ${v.length} из ${LIMITS.textMax} символов.`);
  }
  if (/^\s*[\/.]/.test(v)) {
    return fail('Текст не должен начинаться с «/» или «.» — Twitch воспримет это как команду.');
  }
  return ok(v);
}

export function validateInterval(input) {
  const raw = String(input ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    return fail(`Интервал: целое число минут от ${LIMITS.intervalMin} до ${LIMITS.intervalMax}.`);
  }
  const n = Number(raw);
  if (n < LIMITS.intervalMin || n > LIMITS.intervalMax) {
    return fail(`Интервал: от ${LIMITS.intervalMin} до ${LIMITS.intervalMax} минут.`);
  }
  return ok(n);
}

// ---------- Авто-сообщения ----------

// Из значения узла timers (массив, объект с ключами или null) получаем плотный массив строк
// в порядке числовых ключей. Дыры и пустые значения пропускаются.
export function timersToList(raw) {
  if (raw == null) return [];
  const entries = Array.isArray(raw)
    ? raw.map((v, i) => [i, v])
    : Object.entries(raw).map(([k, v]) => [Number(k), v]);
  return entries
    .filter(([k, v]) => Number.isInteger(k) && typeof v === 'string' && v !== '')
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
}

// Список -> объект {"0": "...", "1": "..."} или null (пустой список = удалить узел).
export function listToTimers(list) {
  if (!list.length) return null;
  const obj = {};
  list.forEach((text, i) => { obj[String(i)] = text; });
  return obj;
}

// Мутаторы для runTransaction: получают текущее значение узла timers и возвращают новое.
// undefined = отменить транзакцию (список изменился или упёрлись в лимит).
export function timersAdd(text) {
  return (current) => {
    const list = timersToList(current);
    if (list.length >= LIMITS.timersMax) return undefined;
    return listToTimers([...list, text]);
  };
}

export function timersEdit(index, oldText, newText) {
  return (current) => {
    const list = timersToList(current);
    if (list[index] !== oldText) return undefined;
    list[index] = newText;
    return listToTimers(list);
  };
}

export function timersRemove(index, oldText) {
  return (current) => {
    const list = timersToList(current);
    if (list[index] !== oldText) return undefined;
    list.splice(index, 1);
    return listToTimers(list);
  };
}

// ---------- Данные канала ----------

// Приводим узел channels/{ник} к удобному виду для интерфейса.
export function normalizeChannel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const commands = raw.commands && typeof raw.commands === 'object' ? raw.commands : {};
  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    tag: typeof raw.tag === 'string' ? raw.tag : '',
    region: LIMITS.regions.includes(raw.region) ? raw.region : 'eu',
    enabled: raw.enabled !== false,       // нет поля = включён
    timerOff: raw.timerOff === true,
    timerInterval: Number.isInteger(raw.timerInterval) ? raw.timerInterval : null, // null = по умолчанию у бота
    commands: Object.entries(commands)
      .filter(([, v]) => typeof v === 'string')
      .sort(([a], [b]) => a.localeCompare(b, 'ru')),
    timers: timersToList(raw.timers),
  };
}

// ---------- Twitch ----------

// Токен Twitch: правила БД принимают 20-64 символа латиница/цифры.
export const TOKEN_PATTERN = /^[A-Za-z0-9]{20,64}$/;

export function parseTwitchHash(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  return {
    accessToken: params.get('access_token'),
    state: params.get('state'),
    error: params.get('error'),
    errorDescription: params.get('error_description'),
  };
}

export function buildTwitchAuthUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'token',
    state,
  });
  return `https://id.twitch.tv/oauth2/authorize?${q.toString()}`;
}

export function makeState(randomBytes) {
  return Array.from(randomBytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
