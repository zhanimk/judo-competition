#!/bin/zsh -l
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo 'Не найден Node.js/npm. Установите Node.js 24+ и повторите запуск.'
else
  npm run start:local
fi
echo 'Запуск завершён. Нажмите Enter, чтобы закрыть окно.'
read -r judo_close
