#!/bin/sh
set -eu
# URI-safe independently generated hexadecimal passwords avoid URL ambiguity.
case "$APP_DATABASE_PASSWORD" in
  *[!a-fA-F0-9]*|'') echo 'APP_DATABASE_PASSWORD_MUST_BE_HEX' >&2; exit 1 ;;
esac
if [ "${#APP_DATABASE_PASSWORD}" -lt 32 ]; then
  echo 'APP_DATABASE_PASSWORD_TOO_SHORT' >&2
  exit 1
fi
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 --set=app_password="$APP_DATABASE_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE judo_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'app_password') \gexec
ALTER DATABASE judo_competition OWNER TO judo_app;
GRANT ALL ON SCHEMA public TO judo_app;
SQL
