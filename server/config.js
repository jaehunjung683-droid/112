'use strict';
/* 서버 설정. 모든 값은 환경 변수로 덮어쓸 수 있다. */
const int = (name, fallback, min, max) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== '' && process.env[name] !== undefined
    ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
};

module.exports = {
  PORT: int('PORT', 3000, 1, 65535),
  MAX_PLAYERS: int('MAX_PLAYERS', 20, 2, 20),
  MATCH_DURATION_MS: int('MATCH_DURATION_SECONDS', 300, 60, 3600) * 1000,
  WEAPON_SELECT_MS: 15000,
  TICK_MS: 50,                       // 스냅샷 전송 주기 (20Hz)
  MAX_PLAYER_HP: 150,
  RESPAWN_MS: 5000,
  RESPAWN_TOLERANCE_MS: 600,         // 네트워크 지연을 고려한 부활 허용 오차
  SPAWN_PROTECT_MS: 2500,
  MAX_MESSAGES_PER_SECOND: 160,
  MAX_PAYLOAD_BYTES: 4096,
  MAX_CONNECTIONS_PER_IP: int('MAX_CONNECTIONS_PER_IP', 30, 1, 1000),
  MAX_ROOMS: int('MAX_ROOMS', 200, 1, 5000),
  TRUST_PROXY: process.env.TRUST_PROXY === '0' ? false : true,   // 기본: 프록시 헤더 사용 (직접 노출 시 TRUST_PROXY=0)
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  MAPS: ['map1', 'map2', 'map3', 'map4', 'map5', 'map6', 'map7', 'map8'],
  CHANNELS: ['1', '2', '3'],
  TEAMS: ['RED', 'BLUE', 'GREEN', 'GOLD'],
  MAP_LIMIT_XZ: 600,
  VOID_Y: -80,
  KICK_STRIKES: 40                   // 이동/사격 위반 누적 시 연결 종료
};
