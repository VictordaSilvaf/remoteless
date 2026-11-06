#!/bin/sh
set -eu
umask 077
redis_pass=$(cat /run/secrets/redis_password)
case "$redis_pass" in *[!A-Za-z0-9+/=]*) exit 1;; esac
{
  printf 'bind 0.0.0.0\nprotected-mode yes\nport 6379\ndir /data\nappendonly yes\nappendfsync everysec\nmaxmemory 192mb\nmaxmemory-policy noeviction\n'
  printf 'requirepass "%s"\n' "$redis_pass"
} > /tmp/redis.conf
unset redis_pass
exec redis-server /tmp/redis.conf
