'use strict';
/*
 * IRON VEIL 서버 권위형 게임 로직 (전송 계층과 분리: ws 없이 테스트 가능).
 *
 * 서버가 직접 결정하는 것: 체력, 탄약/장전, 연사 속도, 피해량, 처치/점수, 부활, 폭발 범위 피해, 이동 속도 검증.
 * 클라이언트가 보내는 것은 "발사했다 / 이 대상을 맞췄다고 주장한다" 뿐이며, 서버는 발사 기록과 조준선·거리·시간으로 검증한다.
 * 한계: 맵 지형이 서버에 없으므로 벽 뒤 판정(벽 관통)은 서버가 알 수 없다.
 */
const crypto = require('crypto');
const cfg = require('./config');
const { WEAPONS, THROWABLES, C4, ABILITIES, HEALS } = require('./weapons');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, fb = 0, lo = -1e6, hi = 1e6) => { const n = Number(v); return Number.isFinite(n) ? clamp(n, lo, hi) : fb; };
const r2 = (v) => Math.round(v * 100) / 100;
const cleanText = (s, max) => String(s == null ? '' : s).replace(/[<>\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

const HISTORY_MS = 1200;
const SHOT_MAX_AGE_MS = 1500;
const ROCKET_MAX_AGE_MS = 3500;
const MAX_SHOTS_KEPT = 48;

class Game {
  constructor(opts = {}) {
    this.clock = opts.clock || Date.now;
    this.log = opts.log || (() => {});
    this.rooms = new Map();
    this.players = new Map();   // conn -> player
    this.conns = new Set();
    this.tickCount = 0;
    this.metrics = { joins: 0, kills: 0, rejectedHits: 0, acceptedHits: 0, strikes: 0 };
  }

  /* ───────── 연결 ───────── */
  connect(conn) { this.conns.add(conn); }
  disconnect(conn) {
    this.leave(conn);
    this.conns.delete(conn);
  }

  /* ───────── 메시지 진입점 ───────── */
  handle(conn, msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'list_servers': return this.listServers(conn);
      case 'join_server': case 'quick_match': return this.quickMatch(conn, msg);
      case 'create_room': return this.createRoom(conn, msg);
      case 'join_room': return this.joinSpecific(conn, msg);
      case 'leave_room': return this.leave(conn, true);
      case 'ping': return conn.send({ type: 'pong', t: msg.t, serverTime: this.clock() });
    }
    const p = this.players.get(conn);
    if (!p) return conn.send({ type: 'error', message: '먼저 서버 채널에 참가하세요.' });
    const room = this.rooms.get(p.roomCode);
    if (!room) return;
    switch (msg.type) {
      case 'player_state': return this.onState(room, p, msg);
      case 'choose_weapon': return this.onChooseWeapon(room, p, msg);
      case 'ready': return this.onReady(room, p);
      case 'start_match': return this.onStartMatch(room, p);
      case 'vote_map': return this.onVoteMap(room, p, msg);
      case 'transfer_host': return this.onTransferHost(room, p, msg);
      case 'kick': return this.onKick(room, p, msg);
      case 'fire': return this.onFire(room, p, msg);
      case 'reload': return this.onReload(room, p, msg);
      case 'hit': return this.onHit(room, p, msg);
      case 'throw': return this.onThrow(room, p, msg);
      case 'c4_place': return this.onC4Place(room, p);
      case 'explosion': return this.onExplosion(room, p, msg);
      case 'ability': return this.onAbility(room, p, msg);
      case 'heal': return this.onHeal(room, p, msg);
      case 'teleport': return this.onTeleport(room, p);
      case 'respawn': return this.onRespawn(room, p);
      default: return;
    }
  }

  /* ───────── 방/로비 ───────── */
  members(room) { return [...room.players.values()]; }
  normalizeChannel(v) { return cfg.CHANNELS.includes(String(v)) ? String(v) : '1'; }
  broadcast(room, data, exceptId = null) {
    for (const q of room.players.values()) if (q.id !== exceptId) q.conn.send(data);
  }

  roomSummary(room) {
    return {
      roomCode: room.code, name: room.name, channelId: room.channelId, matchMode: room.matchMode,
      players: room.players.size, maxPlayers: cfg.MAX_PLAYERS,
      hostName: room.players.get(room.hostId)?.name || '',
      status: room.matchStarted ? 'in_game' : 'waiting',
      joinable: !room.matchStarted && room.players.size < cfg.MAX_PLAYERS
    };
  }
  listServers(conn) {
    const rooms = [...this.rooms.values()];
    const channels = cfg.CHANNELS.map(channelId => {
      const inChannel = rooms.filter(r => r.channelId === channelId);
      return { channelId, players: inChannel.reduce((n, r) => n + r.players.size, 0), rooms: inChannel.length };
    });
    conn.send({ type: 'server_list', channels, rooms: rooms.map(r => this.roomSummary(r)) });
  }
  publishRoomLists() {
    for (const conn of this.conns) if (!this.players.has(conn)) this.listServers(conn);
  }

  makeRoom(channelId, matchMode, teamSize, teamCount, name) {
    let code;
    do { code = String(crypto.randomInt(100000, 1000000)); } while (this.rooms.has(code));
    const room = {
      code, channelId, serverType: 'mixed', matchMode, teamSize, teamCount,
      name: cleanText(name, 32) || `방 ${code}`,
      players: new Map(), hostId: null,
      scores: { RED: 0, BLUE: 0, GREEN: 0, GOLD: 0 },
      matchStarted: false, roundState: 'lobby', endsAt: 0, weaponSelectAt: 0,
      mapId: 'map1', mapVotes: {}, tick: 0
    };
    this.rooms.set(code, room);
    return room;
  }
  roomOptions(msg) {
    return {
      channelId: this.normalizeChannel(msg.channelId),
      matchMode: msg.matchMode === 'team' ? 'team' : 'ffa',
      teamSize: clamp(Math.floor(Number(msg.teamSize)) || 1, 1, 10),
      teamCount: clamp(Math.floor(Number(msg.teamCount)) || 2, 2, 4)
    };
  }
  assignTeam(room) {
    if (room.matchMode === 'ffa') return cfg.TEAMS[0];
    const counts = Object.fromEntries(cfg.TEAMS.map(t => [t, 0]));
    for (const q of room.players.values()) counts[q.team] = (counts[q.team] || 0) + 1;
    const allowed = cfg.TEAMS.slice(0, clamp(room.teamCount, 2, 4));
    return allowed.slice().sort((a, b) => counts[a] - counts[b])[0];
  }
  uniqueName(room, name) {
    const taken = new Set(this.members(room).map(q => q.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; i < 100; i++) {
      const candidate = `${name.slice(0, 15)}#${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${name.slice(0, 12)}#${crypto.randomInt(100, 999)}`;
  }

  quickMatch(conn, msg) {
    const o = this.roomOptions(msg);
    const room = [...this.rooms.values()]
      .filter(r => r.channelId === o.channelId && r.matchMode === o.matchMode && !r.matchStarted && r.players.size < cfg.MAX_PLAYERS)
      .sort((a, b) => b.players.size - a.players.size || a.code.localeCompare(b.code))[0];
    if (room) return this.addPlayer(conn, room, msg);
    return this.createRoom(conn, msg);
  }
  createRoom(conn, msg) {
    if (!cleanText(msg.name, 18)) return conn.send({ type: 'error', message: 'Enter a nickname before joining.' });
    if (this.rooms.size >= cfg.MAX_ROOMS) return conn.send({ type: 'error', message: '서버가 가득 찼습니다. 잠시 후 다시 시도하세요.' });
    const o = this.roomOptions(msg);
    const room = this.makeRoom(o.channelId, o.matchMode, o.teamSize, o.teamCount, msg.roomName);
    this.addPlayer(conn, room, msg);
  }
  joinSpecific(conn, msg) {
    const room = this.rooms.get(String(msg.roomCode || '').trim());
    if (!room) return conn.send({ type: 'error', message: 'Room not found. Refresh the room list.' });
    this.addPlayer(conn, room, msg);
  }

  addPlayer(conn, room, msg) {
    if (this.players.has(conn)) this.leave(conn);
    if (!this.rooms.has(room.code)) { return conn.send({ type: 'error', message: 'Room not found. Refresh the room list.' }); }
    if (room.players.size >= cfg.MAX_PLAYERS || room.matchStarted) return conn.send({ type: 'error', message: 'This room is not accepting players.' });
    const base = cleanText(msg.name, 18);
    if (!base) return conn.send({ type: 'error', message: 'Enter a nickname before joining.' });
    const t = this.clock();
    const p = {
      id: crypto.randomBytes(8).toString('hex'), conn, roomCode: room.code, name: this.uniqueName(room, base),
      team: this.assignTeam(room), x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0, weapon: 'aug',
      alive: true, hp: cfg.MAX_PLAYER_HP, kills: 0, deaths: 0, points: 0, ready: false, joinedAt: t,
      killedAt: 0, lastAttackerId: null, spawnProtectUntil: 0, freeMoveUntil: t + 4000,
      lastStateAt: 0, history: [], shots: new Map(), ammo: {}, reloadUntil: 0, reloadWeapon: null,
      lastFire: {}, burstStart: 0, burstCount: 0, lastMelee: 0, strikes: 0,
      ultUsed: false, grenadeReadyAt: 0, grenadeThrownAt: 0, c4Placed: 0, abilityReadyAt: {},
      medkitUsed: 0, potionReadyAt: 0, teleportsLeft: 10, stunUntil: 0
    };
    room.players.set(p.id, p);
    this.players.set(conn, p);
    if (!room.hostId) room.hostId = p.id;
    this.metrics.joins++;
    conn.send({ type: 'room_joined', playerId: p.id, roomCode: room.code, team: p.team, matchMode: room.matchMode, serverType: 'mixed', channelId: room.channelId, mapId: room.mapId });
    this.sendLobby(room); this.publishState(room); this.publishRoomLists();
  }

  leave(conn, notify = false) {
    const p = this.players.get(conn);
    if (!p) return;
    this.players.delete(conn);
    const room = this.rooms.get(p.roomCode);
    if (!room) return;
    room.players.delete(p.id);
    delete room.mapVotes[p.id];
    if (room.hostId === p.id) {
      room.hostId = this.members(room).sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))[0]?.id || null;
    }
    if (room.players.size === 0) this.rooms.delete(room.code);
    else {
      if (room.players.size < 2 && room.matchStarted) this.endMatch(room, '상대 플레이어가 모두 나가 경기가 종료되었습니다.');
      this.sendLobby(room); this.publishState(room);
    }
    if (notify) conn.send({ type: 'left_room' });
    this.publishRoomLists();
  }

  publicPlayer(p) {
    return { id: p.id, name: p.name, x: r2(p.x), y: r2(p.y), z: r2(p.z), yaw: r2(p.yaw), pitch: r2(p.pitch),
      weapon: p.weapon, team: p.team, alive: p.alive, kills: p.kills, deaths: p.deaths, points: p.points, ready: p.ready };
  }
  leaderboard(room) {
    return this.members(room).sort((a, b) => b.points - a.points || b.kills - a.kills || a.deaths - b.deaths)
      .map(p => ({ id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, points: p.points }));
  }
  sendLobby(room) {
    this.broadcast(room, {
      type: 'match_lobby', roomCode: room.code, roomName: room.name, channelId: room.channelId, hostId: room.hostId,
      players: this.members(room).map(p => this.publicPlayer(p)), serverType: room.serverType, matchMode: room.matchMode,
      teamSize: room.teamSize, teamCount: room.teamCount, mapId: room.mapId, mapVotes: room.mapVotes, roundState: room.roundState
    });
  }
  publishState(room) {
    const players = this.members(room).map(p => this.publicPlayer(p));
    const base = {
      type: 'state', serverTime: this.clock(), roomCode: room.code, channelId: room.channelId, hostId: room.hostId,
      serverType: room.serverType, matchMode: room.matchMode, players, scores: room.scores,
      leaderboard: this.leaderboard(room), matchStarted: room.matchStarted, roundState: room.roundState,
      endsAt: room.endsAt || 0, mapId: room.mapId
    };
    for (const q of room.players.values()) q.conn.send(Object.assign({ self: { hp: q.hp, max: cfg.MAX_PLAYER_HP } }, base));
  }

  /* ───────── 경기 흐름 ───────── */
  onChooseWeapon(room, p, msg) {
    const w = String(msg.weapon || '');
    if (WEAPONS[w]) p.weapon = w;
    p.ready = false;
  }
  onReady(room, p) {
    p.ready = true;
    if (room.matchStarted && room.roundState === 'weapon_select') {
      if (this.members(room).every(q => q.ready) || this.clock() >= room.weaponSelectAt) this.beginLive(room);
    }
  }
  onStartMatch(room, p) {
    if (p.id !== room.hostId) return p.conn.send({ type: 'error', message: 'Only the room host can start the match.' });
    this.startMatch(room);
  }
  startMatch(room) {
    if (room.matchStarted || room.players.size === 0) return;
    const t = this.clock();
    room.matchStarted = true; room.roundState = 'weapon_select';
    room.endsAt = t + cfg.MATCH_DURATION_MS; room.weaponSelectAt = t + cfg.WEAPON_SELECT_MS;
    const totals = {};
    for (const m of Object.values(room.mapVotes)) totals[m] = (totals[m] || 0) + 1;
    const top = Math.max(0, ...Object.values(totals));
    const tied = Object.keys(totals).filter(m => totals[m] === top);
    if (top) room.mapId = tied[crypto.randomInt(tied.length)];
    room.mapVotes = {};
    room.scores = { RED: 0, BLUE: 0, GREEN: 0, GOLD: 0 };
    for (const q of room.players.values()) { this.resetStats(q); this.resetLife(q, t); q.ready = false; q.freeMoveUntil = t + 6000; }
    this.broadcast(room, { type: 'match_started', mapId: room.mapId, endsAt: room.endsAt });
    this.publishState(room);
  }
  beginLive(room) {
    const t = this.clock();
    room.roundState = 'live'; room.endsAt = t + cfg.MATCH_DURATION_MS;
    for (const q of room.players.values()) { this.resetLife(q, t); q.freeMoveUntil = t + 4000; }
    this.broadcast(room, { type: 'round_started', endsAt: room.endsAt });
    this.publishState(room);
  }
  endMatch(room, message) {
    const results = this.leaderboard(room);
    let text = message;
    let winnerId = null, winnerTeam = null;
    if (!text) {
      if (room.matchMode === 'ffa') {
        const top = results[0];
        if (top && top.points > 0) { winnerId = top.id; text = `경기 종료 · 우승: ${top.name} (${top.kills}킬)`; }
        else text = '경기 종료 · 무승부';
      } else {
        const entries = Object.entries(room.scores).filter(([t]) => cfg.TEAMS.slice(0, room.teamCount).includes(t)).sort((a, b) => b[1] - a[1]);
        if (entries[0] && entries[0][1] > 0 && (!entries[1] || entries[0][1] > entries[1][1])) { winnerTeam = entries[0][0]; text = `경기 종료 · 우승 팀: ${winnerTeam}`; }
        else text = '경기 종료 · 무승부';
      }
    }
    room.matchStarted = false; room.roundState = 'lobby'; room.endsAt = 0;
    const t = this.clock();
    for (const q of room.players.values()) { q.ready = false; this.resetLife(q, t); q.freeMoveUntil = t + 5000; }
    this.broadcast(room, { type: 'round_end', message: text, results, winnerId, winnerTeam });
    this.sendLobby(room); this.publishState(room);
  }
  resetStats(p) { p.kills = 0; p.deaths = 0; p.points = 0; }
  resetLife(p, t) {
    p.alive = true; p.hp = cfg.MAX_PLAYER_HP; p.killedAt = 0; p.lastAttackerId = null;
    p.spawnProtectUntil = t + cfg.SPAWN_PROTECT_MS;
    p.ammo = {}; p.reloadUntil = 0; p.reloadWeapon = null; p.shots.clear();
    p.burstCount = 0; p.ultUsed = false; p.c4Placed = 0; p.medkitUsed = 0; p.teleportsLeft = 10; p.stunUntil = 0;
  }
  onVoteMap(room, p, msg) {
    if (room.matchStarted || room.roundState !== 'lobby') return p.conn.send({ type: 'error', message: 'Map voting is closed.' });
    if (cfg.MAPS.includes(msg.mapId)) room.mapVotes[p.id] = msg.mapId;
    this.sendLobby(room);
  }
  onTransferHost(room, p, msg) {
    if (p.id !== room.hostId) return p.conn.send({ type: 'error', message: 'Only the room host can transfer host privileges.' });
    const target = room.players.get(String(msg.targetId));
    if (!target || target.id === p.id) return p.conn.send({ type: 'error', message: 'Choose another player in this room.' });
    room.hostId = target.id; this.sendLobby(room); this.publishState(room);
  }
  onKick(room, p, msg) {
    if (p.id !== room.hostId) return p.conn.send({ type: 'error', message: '방장만 플레이어를 내보낼 수 있습니다.' });
    const target = room.players.get(String(msg.targetId));
    if (!target || target.id === p.id) return;
    target.conn.send({ type: 'error', message: '방장에 의해 방에서 내보내졌습니다.' });
    target.conn.close(1000, 'Kicked');
  }

  /* ───────── 이동 검증 ───────── */
  onState(room, p, msg) {
    const t = this.clock();
    if (!p.alive) return;
    if (t - p.lastStateAt < 20) return;
    const dt = clamp((t - (p.lastStateAt || t - 50)) / 1000, 0.02, 1.0);
    const nx = num(msg.x, p.x, -cfg.MAP_LIMIT_XZ, cfg.MAP_LIMIT_XZ);
    const ny = num(msg.y, p.y, -500, 500);
    const nz = num(msg.z, p.z, -cfg.MAP_LIMIT_XZ, cfg.MAP_LIMIT_XZ);
    const first = p.lastStateAt === 0;
    p.lastStateAt = t;
    if (!first && t > p.freeMoveUntil) {
      const horiz = Math.hypot(nx - p.x, nz - p.z), vert = Math.abs(ny - p.y);
      if (horiz > 45 * dt + 2.5 || vert > 75 * dt + 2.5) {
        this.strike(p, 2, 'move');
        p.conn.send({ type: 'correct', x: r2(p.x), y: r2(p.y), z: r2(p.z) });
        return;
      }
    }
    p.x = nx; p.y = ny; p.z = nz;
    p.yaw = num(msg.yaw, p.yaw, -1000, 1000);
    p.pitch = num(msg.pitch, p.pitch, -1000, 1000);
    const w = String(msg.weapon || p.weapon);
    if (WEAPONS[w] && w !== p.weapon) { p.weapon = w; if (p.reloadUntil && p.reloadWeapon !== w) { p.reloadUntil = 0; p.reloadWeapon = null; } }
    p.history.push({ t, x: p.x, y: p.y, z: p.z });
    while (p.history.length && t - p.history[0].t > HISTORY_MS) p.history.shift();
  }
  onTeleport(room, p) {
    if (!p.alive || p.teleportsLeft <= 0) return;
    p.teleportsLeft--; p.freeMoveUntil = this.clock() + 500;
  }
  strike(p, weight, reason) {
    p.strikes += weight; this.metrics.strikes += weight;
    if (p.strikes >= cfg.KICK_STRIKES) {
      this.log('kick_strikes', { name: p.name, reason });
      p.conn.send({ type: 'error', message: '비정상적인 행동이 감지되어 연결이 종료되었습니다.' });
      p.conn.close(1008, 'Policy violation');
    }
  }

  /* ───────── 사격 ───────── */
  settleReload(p, t) {
    if (p.reloadUntil && t >= p.reloadUntil) {
      const def = WEAPONS[p.reloadWeapon];
      if (def) p.ammo[p.reloadWeapon] = def.mag;
      p.reloadUntil = 0; p.reloadWeapon = null;
    }
  }
  onReload(room, p, msg) {
    if (!p.alive) return;
    const w = String(msg.weapon || p.weapon);
    const def = WEAPONS[w];
    const t = this.clock();
    this.settleReload(p, t);
    if (!def || def.kind !== 'gun' || !Number.isFinite(def.mag) || p.reloadUntil) return;
    if ((p.ammo[w] ?? def.mag) >= def.mag) return;
    p.reloadWeapon = w; p.reloadUntil = t + def.reloadMs;
  }
  onFire(room, p, msg) {
    if (!room.matchStarted || room.roundState !== 'live' || !p.alive) return;
    const w = String(msg.weapon || '');
    const def = WEAPONS[w];
    if (!def || def.kind !== 'gun') return;
    const t = this.clock();
    this.settleReload(p, t);
    if (p.reloadUntil && t < p.reloadUntil - 150) return this.deny(p, 'reload');
    if (t < p.stunUntil) return;
    const last = p.lastFire[w] || 0;
    if (def.burst) {
      const b = def.burst, gap = t - last;
      if (p.burstCount > 0 && p.burstCount < b.count && gap >= b.inner * 0.7 && gap <= b.inner * 3) p.burstCount++;
      else if (t - p.burstStart >= ((b.count - 1) * b.inner + b.cooldown) * 0.85) { p.burstStart = t; p.burstCount = 1; }
      else return this.deny(p, 'rate', 0.5);
    } else if (t - last < def.interval * 0.85) return this.deny(p, 'rate', 0.5);
    let ultDamage = 0;
    if (def.energy) {
      if (msg.ult === true) {
        if (p.ultUsed) return this.deny(p, 'ult');
        p.ultUsed = true; ultDamage = clamp(Math.floor(num(msg.dmg, 1, 1, 100)), 1, 100);
      }
    } else {
      const have = p.ammo[w] ?? def.mag;
      if (have <= 0) return this.deny(p, 'ammo', 0.5);
      p.ammo[w] = have - 1;
    }
    p.lastFire[w] = t; p.weapon = w;
    let ox = num(msg.x, p.x), oy = num(msg.y, p.y), oz = num(msg.z, p.z);
    if (Math.hypot(ox - p.x, oy - p.y, oz - p.z) > 8) { ox = p.x; oy = p.y; oz = p.z; }
    const id = Math.floor(num(msg.id, 0, 0, 1e9));
    p.shots.set(id, {
      id, weapon: w, t, ox, oy, oz, yaw: num(msg.yaw, p.yaw, -1000, 1000), pitch: num(msg.pitch, p.pitch, -1000, 1000),
      budget: msg.pierce === true && def.pierce ? def.pierce.max : def.budget, pierce: msg.pierce === true && !!def.pierce,
      hits: 0, perTarget: new Map(), ultDamage, exploded: false, directIds: new Set()
    });
    while (p.shots.size > MAX_SHOTS_KEPT) p.shots.delete(p.shots.keys().next().value);
  }
  deny(p, reason, weight = 0) { if (weight) this.strike(p, weight, reason); }

  friendly(room, a, b) { return room.matchMode !== 'ffa' && a.team === b.team; }
  aimDir(yaw, pitch) {
    const cp = Math.cos(pitch);
    return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
  }
  rayDistance(o, d, px, py, pz, range) {
    const vx = px - o.x, vy = py - o.y, vz = pz - o.z;
    const along = vx * d.x + vy * d.y + vz * d.z;
    if (along < -1 || along > range) return Infinity;
    const cx = vx - d.x * along, cy = vy - d.y * along, cz = vz - d.z * along;
    return Math.hypot(cx, cy, cz);
  }
  samples(target, t) {
    const out = [{ x: target.x, y: target.y, z: target.z }];
    for (const h of target.history) if (h.t >= t - 450 && h.t <= t + 250) out.push(h);
    return out;
  }
  aimCheck(shot, target, def, wantHead) {
    const o = { x: shot.ox, y: shot.oy, z: shot.oz };
    const d = this.aimDir(shot.yaw, shot.pitch);
    let body = Infinity, head = Infinity;
    for (const s of this.samples(target, shot.t)) {
      body = Math.min(body, this.rayDistance(o, d, s.x, s.y - 0.7, s.z, def.range));
      head = Math.min(head, this.rayDistance(o, d, s.x, s.y, s.z, def.range));
    }
    const tol = def.tol + (shot.pierce ? 0.4 : 0);
    if (!(Math.min(body, head) <= tol)) return { ok: false };
    return { ok: true, head: !!wantHead && head <= def.headTol };
  }

  onHit(room, p, msg) {
    if (!room.matchStarted || room.roundState !== 'live' || !p.alive) return;
    const t = this.clock();
    const w = String(msg.weapon || '');
    const def = WEAPONS[w];
    const target = room.players.get(String(msg.targetId));
    if (!def || !target || target === p || !target.alive || this.friendly(room, p, target)) return;
    if (t < target.spawnProtectUntil || t < p.stunUntil) return;
    if (def.kind === 'melee') return this.meleeHit(room, p, target, w, def, msg, t);

    const shot = p.shots.get(Math.floor(num(msg.shotId, -1)));
    const reject = () => { this.metrics.rejectedHits++; this.strike(p, 0.5, 'hit'); };
    if (!shot || shot.weapon !== w) return reject();
    if (t - shot.t > (def.rocket ? ROCKET_MAX_AGE_MS : SHOT_MAX_AGE_MS)) return reject();
    if (shot.hits >= shot.budget) return reject();
    const per = shot.perTarget.get(target.id) || 0;
    const maxPer = def.budget > 1 && !shot.pierce ? def.budget : 1;
    if (per >= maxPer) return reject();
    const aim = this.aimCheck(shot, target, def, msg.head === true);
    if (!aim.ok) return reject();

    let dmg;
    if (shot.ultDamage) dmg = aim.head ? Math.min(149, Math.round(shot.ultDamage * 1.49)) : shot.ultDamage;
    else if (shot.pierce) dmg = Math.round(def.pierce.base * Math.pow(def.pierce.falloff, shot.hits));
    else dmg = aim.head ? def.head : def.body;
    shot.hits++; shot.perTarget.set(target.id, per + 1);
    if (def.rocket) shot.directIds.add(target.id);
    this.metrics.acceptedHits++;
    this.damage(room, p, target, dmg, w, aim.head);
    if (def.stunMs && target.alive) {
      target.stunUntil = t + def.stunMs;
      target.conn.send({ type: 'stun', ms: def.stunMs });
    }
  }
  meleeHit(room, p, target, w, def, msg, t) {
    if (t - p.lastMelee < def.interval * 0.8) return this.strike(p, 0.5, 'melee-rate');
    let nearest = Infinity;
    for (const s of this.samples(target, t)) nearest = Math.min(nearest, Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z));
    if (nearest > def.range) { this.metrics.rejectedHits++; return this.strike(p, 0.5, 'melee-range'); }
    p.lastMelee = t; p.weapon = w;
    let dmg = msg.alt === true ? def.alt : def.dmg;
    if (w === 'knife' && msg.alt === true) {
      const fx = -Math.sin(target.yaw), fz = -Math.cos(target.yaw);
      const ax = p.x - target.x, az = p.z - target.z, len = Math.hypot(ax, az) || 1;
      if ((fx * ax + fz * az) / len < -0.3) dmg = def.backstab;
    }
    this.metrics.acceptedHits++;
    this.damage(room, p, target, dmg, w, false);
  }

  /* ───────── 폭발/투척/능력 ───────── */
  onThrow(room, p, msg) {
    if (!room.matchStarted || room.roundState !== 'live' || !p.alive) return;
    if (msg.kind !== 'grenade') return;
    const t = this.clock();
    if (t < p.grenadeReadyAt) return this.strike(p, 1, 'grenade-cd');
    p.grenadeReadyAt = t + THROWABLES.grenade.cooldownMs - 500;
    p.grenadeThrownAt = t; p.grenadeOrigin = { x: p.x, y: p.y, z: p.z }; p.grenadePending = true;
  }
  onC4Place(room, p) {
    if (!room.matchStarted || room.roundState !== 'live' || !p.alive) return;
    if (p.c4Placed >= C4.max) return this.strike(p, 1, 'c4-max');
    p.c4Placed++;
  }
  onExplosion(room, p, msg) {
    if (!room.matchStarted || room.roundState !== 'live') return;
    const t = this.clock();
    const kind = msg.kind;
    if (kind === 'rocket') {
      const shot = p.shots.get(Math.floor(num(msg.shotId, -1)));
      if (!shot || shot.weapon !== 'rocket' || shot.exploded || t - shot.t > ROCKET_MAX_AGE_MS) return this.strike(p, 1, 'rocket');
      shot.exploded = true;
      const def = WEAPONS.rocket;
      const pos = this.clampPos(msg, shot);
      this.areaDamage(room, p, pos, def.splash.radius, (d) => def.splash.damage * (1 - d / def.splash.radius), 'rocket', shot.directIds);
    } else if (kind === 'grenade') {
      const g = THROWABLES.grenade;
      if (!p.grenadePending || t - p.grenadeThrownAt > g.fuseMaxMs) return this.strike(p, 1, 'grenade');
      p.grenadePending = false;
      const o = p.grenadeOrigin;
      const pos = this.clampPos(msg, { ox: o.x, oy: o.y, oz: o.z }, g.throwRange);
      this.areaDamage(room, p, pos, g.radius, (d) => g.damage * (1 - (1 - g.minFactor) * (d / g.radius)), 'grenade');
    } else if (kind === 'c4') {
      if (p.c4Placed <= 0) return this.strike(p, 1, 'c4');
      const list = Array.isArray(msg.positions) ? msg.positions.slice(0, Math.min(C4.max, p.c4Placed)) : [];
      p.c4Placed = 0;
      for (const raw of list) {
        const pos = this.clampPos(raw || {}, { ox: p.x, oy: p.y, oz: p.z }, C4.range);
        this.areaDamage(room, p, pos, C4.radius, (d) => Math.max(C4.minDamage, C4.damage * (1 - d / C4.radius)), 'c4');
      }
    }
  }
  clampPos(raw, origin, range = 450) {
    const ox = origin.ox, oy = origin.oy, oz = origin.oz;
    let x = num(raw.x, ox), y = num(raw.y, oy), z = num(raw.z, oz);
    const d = Math.hypot(x - ox, y - oy, z - oz);
    if (d > range) { const k = range / d; x = ox + (x - ox) * k; y = oy + (y - oy) * k; z = oz + (z - oz) * k; }
    return { x, y, z };
  }
  areaDamage(room, attacker, pos, radius, fn, weapon, skipIds) {
    const t = this.clock();
    for (const q of this.members(room)) {
      if (!q.alive || q === attacker || this.friendly(room, attacker, q) || (skipIds && skipIds.has(q.id)) || t < q.spawnProtectUntil) continue;
      const d = Math.hypot(q.x - pos.x, q.y - 0.8 - pos.y, q.z - pos.z);
      if (d >= radius) continue;
      const dmg = Math.round(fn(d));
      if (dmg > 0) this.damage(room, attacker, q, dmg, weapon, false);
    }
  }
  onAbility(room, p, msg) {
    if (!room.matchStarted || room.roundState !== 'live' || !p.alive) return;
    const a = ABILITIES[msg.kind];
    if (!a || p.weapon !== a.weapon) return;
    const t = this.clock();
    if (t < (p.abilityReadyAt[msg.kind] || 0)) return this.strike(p, 1, 'ability-cd');
    p.abilityReadyAt[msg.kind] = t + a.cooldownMs - 300;
    const center = { x: p.x, y: p.y - 0.8, z: p.z };
    if (msg.kind === 'hammer') {
      this.areaDamage(room, p, center, a.radius, (d) => a.damage * (1 - d / a.divisor), 'hammer');
    } else {
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      for (const q of this.members(room)) {
        if (!q.alive || q === p || this.friendly(room, p, q) || t < q.spawnProtectUntil) continue;
        const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
        if (d < a.radius + 2 && d > 0 && (dx * fx + dz * fz) / d > 0.2) this.damage(room, p, q, a.damage, 'battleaxe', false);
      }
    }
  }
  onHeal(room, p, msg) {
    if (!room.matchStarted || room.roundState !== 'live' || !p.alive) return;
    const h = HEALS[msg.item];
    if (!h) return;
    const t = this.clock();
    if (msg.item === 'medkit') { if (p.medkitUsed >= h.usesPerLife) return this.strike(p, 1, 'medkit'); }
    else if (t < p.potionReadyAt) return this.strike(p, 1, 'potion');
    if (p.hp >= cfg.MAX_PLAYER_HP) return;
    if (msg.item === 'medkit') p.medkitUsed++; else p.potionReadyAt = t + h.cooldownMs - 500;
    p.hp = Math.min(cfg.MAX_PLAYER_HP, p.hp + h.amount);
    p.conn.send({ type: 'hp', hp: p.hp, max: cfg.MAX_PLAYER_HP });
  }

  /* ───────── 피해/처치/부활 ───────── */
  damage(room, attacker, target, amount, weapon, head) {
    if (!target.alive) return;
    const dmg = Math.max(0, Math.round(amount));
    target.hp -= dmg;
    target.lastAttackerId = attacker ? attacker.id : null;
    const killed = target.hp <= 0;
    if (killed) this.kill(room, attacker, target, weapon, head);
    else target.conn.send({ type: 'hp', hp: target.hp, max: cfg.MAX_PLAYER_HP, dmg, attackerId: attacker?.id || null, weapon });
    if (attacker) attacker.conn.send({ type: 'hit_confirmed', attackerId: attacker.id, targetId: target.id, killed, head: !!head, dmg });
  }
  kill(room, attacker, target, weapon, head) {
    const t = this.clock();
    target.hp = 0; target.alive = false; target.deaths++; target.killedAt = t;
    this.metrics.kills++;
    if (attacker && attacker !== target) {
      attacker.kills++; attacker.points += 2;
      if (room.matchMode !== 'ffa') room.scores[attacker.team] = (room.scores[attacker.team] || 0) + 1;
    }
    target.conn.send({ type: 'hp', hp: 0, max: cfg.MAX_PLAYER_HP });
    target.conn.send({ type: 'player_died', playerId: target.id, attackerId: attacker?.id || null });
    this.broadcast(room, { type: 'kill', attackerId: attacker?.id || null, attackerName: attacker?.name || '', targetId: target.id, targetName: target.name, weapon, head: !!head });
    this.publishState(room);
  }
  onRespawn(room, p) {
    if (p.alive) return;
    const t = this.clock();
    if (!p.killedAt || t - p.killedAt < cfg.RESPAWN_MS - cfg.RESPAWN_TOLERANCE_MS) return p.conn.send({ type: 'error', message: 'Respawn is not ready yet.' });
    this.resetLife(p, t);
    p.freeMoveUntil = t + 4000;
    p.conn.send({ type: 'respawn', playerId: p.id, mapId: room.mapId });
    p.conn.send({ type: 'hp', hp: p.hp, max: cfg.MAX_PLAYER_HP });
    this.publishState(room);
  }

  /* ───────── 주기 처리 ───────── */
  tick() {
    const t = this.clock();
    this.tickCount++;
    for (const room of [...this.rooms.values()]) {
      room.tick++;
      for (const p of room.players.values()) {
        p.strikes = Math.max(0, p.strikes - 0.05);
        if (room.roundState === 'live' && p.alive && p.y < cfg.VOID_Y) this.kill(room, null, p, 'void', false);
      }
      if (room.matchStarted && room.roundState === 'weapon_select' && t >= room.weaponSelectAt) { this.beginLive(room); continue; }
      if (room.matchStarted && room.roundState === 'live' && room.endsAt && t >= room.endsAt) { this.endMatch(room); continue; }
      if (room.players.size > 0 && (room.matchStarted || room.tick % 4 === 0)) this.publishState(room);
    }
  }
  stats() {
    return { rooms: this.rooms.size, players: this.players.size, connections: this.conns.size, metrics: this.metrics };
  }
}

module.exports = { Game };
