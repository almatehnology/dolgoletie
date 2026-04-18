// Загружаем .env через @next/env (парсер Next.js понимает \$ escape),
// затем запускаем стандартный standalone-сервер Next.js. docker-compose
// НЕ использует env_file для .env — иначе его парсер ломается на bcrypt-хеше.
const path = require('path');
const { loadEnvConfig } = require('@next/env');

loadEnvConfig(path.join(__dirname), false);

require('./server.js');
