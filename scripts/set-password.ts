import bcrypt from 'bcryptjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

async function main() {
  const envPath = resolve(process.cwd(), '.env');
  const rl = createInterface({ input, output, terminal: true });
  const password = await rl.question('Новый пароль для Долголетие: ');
  const confirm = await rl.question('Повторите пароль: ');
  rl.close();

  if (!password || password.length < 6) {
    console.error('Пароль должен быть минимум 6 символов.');
    process.exit(1);
  }
  if (password !== confirm) {
    console.error('Пароли не совпадают.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);

  let env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  // Next.js интерполирует $VAR в .env ДАЖЕ внутри кавычек (кавычки снимаются
  // до интерполяции). Только \$ экранирует, поэтому каждый $ в bcrypt-хеше
  // превращаем в \$.
  const escapedHash = hash.replace(/\$/g, '\\$');
  const line = `APP_PASSWORD_HASH=${escapedHash}`;

  if (/^APP_PASSWORD_HASH=.*$/m.test(env)) {
    env = env.replace(/^APP_PASSWORD_HASH=.*$/m, line);
  } else {
    env = env ? env.trimEnd() + '\n' + line + '\n' : line + '\n';
  }

  writeFileSync(envPath, env, 'utf8');
  console.log(`Пароль сохранён в ${envPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
