/* НАСТРОЙКА СЕТИ — ваш проект Supabase (бесплатный тариф, игрокам регистрация
   не нужна). Игра читает этот файл рядом с index.html.
   Ниже вписан ПУБЛИЧНЫЙ ключ (publishable) — он для браузеров и не является
   секретом. Если перевыпустите ключ в дашборде (Settings → API Keys),
   замените его здесь. СЕКРЕТНЫЙ ключ (sb_secret_…) в игру и этот файл
   вставлять НЕЛЬЗЯ — он живёт только на сервере. Пароль базы данных сюда
   и в игру не вписывается — он сети не нужен. */
window.SUPABASE_CFG = {
  db: true,   // регистр комнат в Postgres (supabase-schema.sql): честное «комната не найдена»
  url: 'https://haskxauivkflazbhthmt.supabase.co',
  key: 'sb_publishable_WYTOOey1XNYKL_OCMEHrmQ_c2ObdPe3'
};
