'use strict';
/*
 * 무기 데이터 (서버가 신뢰하는 유일한 피해/연사/탄약 기준).
 * 클라이언트 weaponStats와 값이 같아야 한다. 클라이언트가 보내는 피해량은 사용하지 않는다.
 */
const gun = (o) => Object.assign({ kind: 'gun', budget: 1, tol: 1.6, headTol: 0.9, range: 300 }, o);
const melee = (o) => Object.assign({ kind: 'melee', range: 5.2 }, o);

const WEAPONS = {
  aug:      gun({ interval: 92,   body: 13, head: 16, mag: 30, reloadMs: 1800 }),
  shotgun:  gun({ interval: 706,  body: 10, head: 10, mag: 7,  reloadMs: 850, budget: 8, tol: 3.4, headTol: 3.4, range: 70 }),
  burst:    gun({ interval: 90,   body: 18, head: 30, mag: 15, reloadMs: 1800, burst: { count: 3, inner: 90, cooldown: 320 } }),
  awp:      gun({ interval: 1334, body: 70, head: 120, mag: 5, reloadMs: 1800, range: 600 }),
  laser:    gun({ interval: 200,  body: 22, head: 34, mag: Infinity, reloadMs: 0, energy: true }),
  rocket:   gun({ interval: 1500, body: 150, head: 150, mag: 1, reloadMs: 2400, rocket: true, tol: 5, splash: { radius: 9, damage: 85 }, range: 400 }),
  pistol:   gun({ interval: 172,  body: 12, head: 15, mag: 15, reloadMs: 1800 }),
  revolver: gun({ interval: 334,  body: 30, head: 50, mag: 6,  reloadMs: 1450 }),
  uzi:      gun({ interval: 71,   body: 9,  head: 12, mag: 25, reloadMs: 1250 }),
  taser:    gun({ interval: 1000, body: 1,  head: 1,  mag: 1,  reloadMs: 1800, stunMs: 3000 }),
  drill:    gun({ interval: 334,  body: 15, head: 60, mag: 4,  reloadMs: 1800, pierce: { base: 28, falloff: 0.8, max: 4 } }),

  knife:     melee({ interval: 500,  dmg: 50, alt: 100, backstab: 150 }),
  katana:    melee({ interval: 600,  dmg: 40, alt: 80 }),
  scythe:    melee({ interval: 750,  dmg: 30, alt: 60 }),
  shield:    melee({ interval: 667,  dmg: 20, alt: 40 }),
  hammer:    melee({ interval: 1091, dmg: 95, alt: 125 }),
  battleaxe: melee({ interval: 706,  dmg: 58, alt: 82 })
};

const THROWABLES = {
  grenade: { cooldownMs: 30000, fuseMaxMs: 6000, radius: 10, damage: 100, minFactor: 0.4, throwRange: 90 }
};
const C4 = { max: 3, radius: 12, damage: 75, minDamage: 10, range: 400 };
const ABILITIES = {
  hammer:    { weapon: 'hammer',    cooldownMs: 5000, radius: 9, damage: 70, divisor: 14 },
  axe_dash:  { weapon: 'battleaxe', cooldownMs: 3500, radius: 5.5, damage: 42 }
};
const HEALS = {
  medkit: { amount: 75, usesPerLife: 1 },
  potion: { amount: 40, cooldownMs: 12000 }
};

module.exports = { WEAPONS, THROWABLES, C4, ABILITIES, HEALS };
