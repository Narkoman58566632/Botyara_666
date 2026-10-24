// ЕДИНСТВЕННЫЙ файл, который нужно отредактировать: впишите свои значения вместо ВСТАВЬТЕ_...
// Всё здесь публично (в браузере всё равно видно). Секретов здесь быть не должно.

export const config = {
  // Firebase Console → ⚙ Project settings → General → Your apps → Web app → SDK setup and configuration
  firebase: {
    apiKey: 'ВСТАВЬТЕ_apiKey',
    authDomain: 'ВСТАВЬТЕ_authDomain',
    databaseURL: 'ВСТАВЬТЕ_databaseURL',
    projectId: 'ВСТАВЬТЕ_projectId',
    appId: 'ВСТАВЬТЕ_appId',
  },

  // Twitch Developer Console → ваше приложение → Client ID
  twitchClientId: 'ВСТАВЬТЕ_Client_ID',

  // Адрес сайта = OAuth Redirect URL в приложении Twitch. Должен совпадать символ в символ.
  // Оставьте пустым, чтобы сайт взял свой собственный адрес автоматически
  // (например https://ваш-ник.github.io/название-репозитория/).
  redirectUri: '',

  // Twitch-ник бота (чат, где пишут !join). Пусто = в подсказках будет просто «в чате бота».
  botName: '',

  // Сколько авто-сообщений бот использует по умолчанию (MAX_TIMERS в боте).
  // Если в списке больше, сайт покажет предупреждение. По схеме БД максимум 20.
  botTimersLimit: 10,

  // Сколько секунд ждать ответа бота после входа через Twitch.
  linkTimeoutSec: 15,
};
