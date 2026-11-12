#!/usr/bin/env node
'use strict';
/* ============================================================
   SUPER BOB: локальный сервер для игры вдвоём по сети.
   Один порт — и страничка игры, и сигнальный сервер PeerJS.
   Зачем: облачный сигнальный сервер PeerJS (0.peerjs.com) бывает
   недоступен на некоторых сетях/в некоторых странах — тогда игра
   пишет «СЕТЬ НЕДОСТУПНА». Этот сервер решает проблему полностью:
   хост запускает его, второй игрок открывает показанный адрес —
   соединение идёт напрямую между игроками (P2P WebRTC), сервер
   только «знакомит» их, трафик игры через него не течёт.

   Запуск:  node net/server.js            (или СТАРТ-СЕРВЕРА.bat)
   Игрок 1: http://localhost:9000
   Игрок 2: http://<адрес из списка ниже> (та же Wi-Fi сеть)
   ============================================================ */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const { ExpressPeerServer } = require('peer');

const ROOT = path.join(__dirname, '..');      // папка игры (index.html, map/)
const START_PORT = 9000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json'
};

function startServer(port) {
  const app = express();
  app.disable('x-powered-by');

  /* метка-кука: игра читает её и понимает, что сигнальный сервер живёт на этом
     же адресе (на «глухом» хостинге игра не станет тратить попытку на него) */
  app.use((req, res, next) => { res.cookie('sbnetsrv', '1', { maxAge: 31536000000, sameSite: 'lax' }); next(); });

  /* --- статика игры: index.html, map/maps.js, map/editor.html и т.д. --- */
  app.use(express.static(ROOT, { index: 'index.html', extensions: ['html'] }));

  const server = http.createServer(app);

  /* --- сигнальный сервер PeerJS на том же порту: клиент с path:'/' и
         key:'peerjs' стучится в /peerjs — именно здесь он и отвечает --- */
  const signaling = ExpressPeerServer(server, { key: 'peerjs', debug: false });
  app.use('/', signaling);

  /* красивая 404 вместо стандартной */
  app.use((req, res) => {
    res.status(404).type('html').send(
      '<meta charset="utf-8"><title>SUPER BOB — сервер</title>' +
      '<body style="background:#0a1224;color:#cfe3ff;font-family:sans-serif;text-align:center;padding-top:60px">' +
      '<h1>SUPER BOB: сервер работает</h1><p>Страница <code>' +
      String(req.path).replace(/[<>&"]/g, '') + '</code> не найдена.</p>' +
      '<p>Игра лежит <a style="color:#7ab8ff" href="/">здесь</a>.</p></body>');
  });

  server.on('error', e => {
    if (e && e.code === 'EADDRINUSE' && port < START_PORT + 10) {
      console.log(`Порт ${port} занят — пробую ${port + 1}…`);
      startServer(port + 1);
    } else { console.error('Не удалось запустить сервер:', e.message); process.exit(1); }
  });

  server.listen(port, '0.0.0.0', () => {
    const urls = [];
    const add = (name, addr) => urls.push(`    ${name.padEnd(9)} http://${addr}`);
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const ni of nets[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal) add(name, `${ni.address}:${port}`);
      }
    }
    console.log('');
    console.log('  ================================================');
    console.log('  SUPER BOB: сервер связи запущен!');
    console.log('  ================================================');
    console.log('  На ЭТОМ компьютере:   http://localhost:' + port);
    for (const u of urls) console.log(u);
    console.log('  ------------------------------------------------');
    console.log('  Второй игрок открывает один из адресов выше');
    console.log('  (тот же роутер/Wi-Fi) — и в игре:');
    console.log('  АРЕНА → ИГРАТЬ ВДВОЁМ ПО СЕТИ → создать/войти по коду.');
    console.log('  Окно сервера держи открытым, пока играете.');
    console.log('  Остановить: Ctrl+C');
    console.log('  ================================================');
    console.log('');
  });
}

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('ОШИБКА: рядом с папкой net/ нет index.html — запусти сервер из папки игры.');
  process.exit(1);
}
startServer(process.env.PORT ? +process.env.PORT : START_PORT);
