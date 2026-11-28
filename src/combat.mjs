import vec3 from "vec3";
import pathfinderPkg from "mineflayer-pathfinder";
import { normalizeCanonicalItemId } from "./protocol.mjs";
import { MOVEMENT_PROFILES, applyMovementProfile } from "./navigation.mjs";
import {
  collectEquipmentSnapshot,
  equipBestWeapon,
  extractCanonicalItemName,
  getWeaponAttackCooldownMs,
} from "./survival.mjs";

const { goals } = pathfinderPkg;
const { GoalFollow, GoalNearXZ } = goals;

export const HOSTILE_MOBS = new Set([
  "zombie",
  "skeleton",
  "creeper",
  "spider",
  "cave_spider",
  "enderman",
  "witch",
  "pillager",
  "drowned",
  "husk",
  "stray",
  "slime",
  "phantom",
  "bogged",
  "breeze",
  "blaze",
  "piglin_brute",
  "vindicator",
  "evoker",
  "ravager",
  "warden",
  "zombified_piglin",
]);

export const PROTECTED_ENTITIES = new Set([
  "player",
  "iron_golem",
  "snow_golem",
  "villager",
  "wandering_trader",
  "wolf",
  "cat",
  "parrot",
  "horse",
  "donkey",
  "mule",
  "llama",
  "trader_llama",
  "camel",
  "allay",
  "axolotl",
  "fox",
  "bee",
  "dolphin",
  "panda",
  "polar_bear",
  "ocelot",
  "sniffer",
  "armadillo",
  "cow",
  "pig",
  "sheep",
  "chicken",
  "rabbit",
  "turtle",
  "frog",
  "goat",
  "strider",
  "squid",
  "glow_squid",
  "bat",
  "cod",
  "salmon",
  "tropical_fish",
  "pufferfish",
  "mooshroom",
  "armor_stand",
  "item_frame",
  "glow_item_frame",
]);

export const AVOID_ALWAYS_MOBS = new Set(["warden", "ravager", "piglin_brute"]);
export const RANGED_SHIELD_MOBS = new Set(["skeleton", "stray", "bogged", "pillager", "drowned"]);
export const RANGED_HOSTILE_MOBS = new Set([
  "pillager",
  "skeleton",
  "stray",
  "bogged",
  "witch",
  "evoker",
  "blaze",
  "breeze",
]);
export const PROJECTILE_ENTITY_NAMES = new Set([
  "arrow",
  "spectral_arrow",
  "trident",
  "thrown_trident",
  "small_fireball",
  "fireball",
  "wither_skull",
  "llama_spit",
  "potion",
  "wind_charge",
]);
export const WATER_BLOCK_NAMES = new Set(["water", "flowing_water", "bubble_column"]);

export const GUARD_PLAYER_RADIUS = 10;
export const SELF_DEFENSE_RADIUS = 7;
export const MAX_LEASH_FROM_PLAYER = 14;
export const CREEPER_SAFE_DISTANCE = 6;
export const AVOID_HIGH_DANGER_RADIUS = 12;
export const MELEE_EVADE_RADIUS = 8;
export const MELEE_CRITICAL_INTERRUPT_RADIUS = 7;
export const RANGED_EVADE_RADIUS = 18;
export const DROWNED_CONSERVATIVE_RANGED_RADIUS = 12;
export const MELEE_FLEE_DISTANCE = 14;
export const RANGED_FLEE_DISTANCE = 26;
export const RETREAT_HEALTH_THRESHOLD = 7;
export const RESUME_HEALTH_THRESHOLD = 12;
export const MELEE_REACH = 3.2;
export const SHIELD_BLOCK_CYCLE_MS = 2_400;
export const SHIELD_BLOCK_WINDOW_MS = 1_000;
export const SHIELD_POST_HIT_WINDOW_MS = 1_800;
export const SHIELD_CLOSE_MELEE_ABORT_DIST = 5.0;
export const ENDERMAN_AGGRO_TTL_MS = 45_000;
export const ENDERMAN_HURT_AGGRO_RADIUS = 12;
export const ENDERMAN_RUSH_SPEED_THRESHOLD = 4.8;

export function createCombatState() {
  return {
    retreating: false,
    shieldRaised: false,
    shieldWindowStartMs: -Infinity,
    lastDamageAtMs: -Infinity,
    lastAttackAtMs: -Infinity,
    activeTargetId: null,
    aggroEndermen: new Map(),
    endermanTracker: new Map(),
  };
}

export function distanceBetween(a, b) {
  if (!a || !b) return Infinity;
  if (typeof a.distanceTo === "function") {
    const d = a.distanceTo(b);
    return Number.isFinite(d) ? d : Infinity;
  }
  return Math.hypot((b.x ?? 0) - (a.x ?? 0), (b.y ?? 0) - (a.y ?? 0), (b.z ?? 0) - (a.z ?? 0));
}

export function isTamedOrOwnedEntity(entity) {
  if (!entity || typeof entity !== "object") return false;
  if (entity.tamed === true || entity.isTamed === true) return true;
  if (typeof entity.owner === "string" && entity.owner.length > 0) return true;
  if (typeof entity.ownerUUID === "string" && entity.ownerUUID.length > 0) return true;
  if (Array.isArray(entity.metadata)) {
    for (const meta of entity.metadata) {
      if (meta && typeof meta === "object" && (meta.tamed === true || meta.owner)) {
        return true;
      }
    }
  }
  return false;
}

export function getEntityTrackingKey(entity) {
  if (!entity || typeof entity !== "object") return "";
  if (entity.id !== undefined && entity.id !== null && String(entity.id).length > 0) {
    return String(entity.id);
  }
  if (typeof entity.uuid === "string" && entity.uuid.length > 0) {
    return entity.uuid;
  }
  return "";
}

function pruneAggroEndermen(combatState, nowMs = Date.now()) {
  if (!(combatState?.aggroEndermen instanceof Map)) return;
  for (const [key, expiresAt] of combatState.aggroEndermen.entries()) {
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
      combatState.aggroEndermen.delete(key);
    }
  }
}

export function markEndermanAggro(
  combatState,
  entityOrId,
  { nowMs = Date.now(), ttlMs = ENDERMAN_AGGRO_TTL_MS } = {},
) {
  if (!combatState) return false;
  if (!(combatState.aggroEndermen instanceof Map)) {
    combatState.aggroEndermen = new Map();
  }
  const key =
    typeof entityOrId === "string" || typeof entityOrId === "number"
      ? String(entityOrId)
      : getEntityTrackingKey(entityOrId);
  if (!key) return false;
  pruneAggroEndermen(combatState, nowMs);
  const dur = Math.max(1_000, Number.isFinite(ttlMs) ? ttlMs : ENDERMAN_AGGRO_TTL_MS);
  combatState.aggroEndermen.set(key, nowMs + dur);
  return true;
}

export function isEndermanTrackedAggro(entity, combatState = null, nowMs = Date.now()) {
  if (!combatState || !(combatState.aggroEndermen instanceof Map)) return false;
  const key = getEntityTrackingKey(entity);
  if (!key) return false;
  const expiresAt = combatState.aggroEndermen.get(key);
  if (expiresAt === undefined) return false;
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    combatState.aggroEndermen.delete(key);
    return false;
  }
  return true;
}

/**
 * Mark nearby endermen as aggro when the bot takes damage (handles Paper 26.1.2
 * metadata index drift and instant hit-then-teleport enderman attacks).
 */
export function recordBotHurtEndermanAggro(
  bot,
  combatState,
  { nowMs = Date.now(), attacker = null, radius = ENDERMAN_HURT_AGGRO_RADIUS } = {},
) {
  if (!bot || !combatState) return 0;
  let marked = 0;
  if (attacker && normalizeCanonicalItemId(String(attacker.name || "")) === "enderman") {
    if (markEndermanAggro(combatState, attacker, { nowMs })) {
      marked += 1;
    }
  }
  const origin = bot.entity?.position;
  if (!origin) return marked;

  let hasCloseNonEndermanHostile = false;
  const candidateEndermen = [];
  for (const ent of Object.values(bot.entities || {})) {
    if (!ent || ent === bot.entity || !ent.position) continue;
    const name = normalizeCanonicalItemId(String(ent.name || ""));
    if (!name || !HOSTILE_MOBS.has(name)) continue;
    const dist = distanceBetween(origin, ent.position);
    if (name === "enderman") {
      if (dist <= radius) {
        candidateEndermen.push({ ent, dist });
      }
    } else if (dist <= 6) {
      hasCloseNonEndermanHostile = true;
    }
  }

  for (const { ent, dist } of candidateEndermen) {
    // Always mark endermen right next to the bot (<= 6m), or within radius (12m)
    // when no other melee mob is directly on top of the bot.
    if (dist <= 6 || !hasCloseNonEndermanHostile) {
      if (markEndermanAggro(combatState, ent, { nowMs })) {
        marked += 1;
      }
    }
  }
  return marked;
}

/**
 * Behavioral aggro detector: tracks enderman closing speed and teleport ambushes
 * so Paper 26.1.2 rushing endermen are caught even if metadata flags drift.
 */
export function observeEndermanBehavior(bot, combatState, { nowMs = Date.now() } = {}) {
  if (!bot?.entity?.position || !combatState) return 0;
  if (!(combatState.endermanTracker instanceof Map)) {
    combatState.endermanTracker = new Map();
  }
  pruneAggroEndermen(combatState, nowMs);

  const origin = bot.entity.position;
  const seenKeys = new Set();
  let newlyMarked = 0;

  for (const ent of Object.values(bot.entities || {})) {
    if (!ent || ent === bot.entity || !ent.position) continue;
    if (normalizeCanonicalItemId(String(ent.name || "")) !== "enderman") continue;
    const key = getEntityTrackingKey(ent);
    if (!key) continue;
    seenKeys.add(key);

    const dist = distanceBetween(origin, ent.position);
    const prev = combatState.endermanTracker.get(key);
    let rapidApproaches = prev ? prev.rapidApproaches : 0;

    // Velocity-based radial rush toward bot (~0.28 blocks/tick ≈ 5.6 m/s)
    if (ent.velocity && dist > 0.25 && dist <= 12) {
      const toBotX = ((origin.x ?? 0) - (ent.position.x ?? 0)) / dist;
      const toBotZ = ((origin.z ?? 0) - (ent.position.z ?? 0)) / dist;
      const radialSpeedPerTick = (ent.velocity.x ?? 0) * toBotX + (ent.velocity.z ?? 0) * toBotZ;
      if (radialSpeedPerTick >= 0.26) {
        if (markEndermanAggro(combatState, ent, { nowMs })) {
          newlyMarked += 1;
        }
      }
    }

    if (prev) {
      const dtSec = (nowMs - prev.atMs) / 1000;
      if (dtSec >= 0.05 && dtSec <= 4.0) {
        const deltaDist = prev.dist - dist;
        const closingSpeed = deltaDist / dtSec;
        // Teleport ambush straight onto the bot
        if (deltaDist >= 4.5 && dist <= 5.5) {
          if (markEndermanAggro(combatState, ent, { nowMs })) {
            newlyMarked += 1;
          }
          rapidApproaches += 2;
        } else if (dist <= 12 && closingSpeed >= ENDERMAN_RUSH_SPEED_THRESHOLD) {
          rapidApproaches += 1;
          if (dist <= 7 || rapidApproaches >= 2) {
            if (markEndermanAggro(combatState, ent, { nowMs })) {
              newlyMarked += 1;
            }
          }
        } else if (deltaDist <= 0.2) {
          rapidApproaches = 0;
        }
      } else if (dtSec > 4.0) {
        rapidApproaches = 0;
      }
    }

    combatState.endermanTracker.set(key, {
      dist,
      atMs: nowMs,
      rapidApproaches,
    });
  }

  for (const [key, sample] of combatState.endermanTracker.entries()) {
    if (!seenKeys.has(key) || nowMs - sample.atMs > 15_000) {
      combatState.endermanTracker.delete(key);
    }
  }
  return newlyMarked;
}

export function isEndermanProvoked(entity, combatState = null, nowMs = Date.now()) {
  if (!entity || typeof entity !== "object") return false;
  if (
    entity.isScreaming === true ||
    entity.angry === true ||
    entity.aggro === true ||
    entity.provoked === true ||
    entity.isStaring === true
  ) {
    return true;
  }
  if (Array.isArray(entity.metadata)) {
    // Defensive range 16..20 covers MC 1.20-1.21 (17/18) and Paper 26.1.2 metadata index drift
    for (let i = 16; i <= 20 && i < entity.metadata.length; i += 1) {
      const val = entity.metadata[i];
      if (val === true) {
        return true;
      }
      if (
        val &&
        typeof val === "object" &&
        (val.creepy === true || val.staredAt === true || val.angry === true)
      ) {
        return true;
      }
    }
  }
  if (combatState && isEndermanTrackedAggro(entity, combatState, nowMs)) {
    return true;
  }
  return false;
}

function itemMatchesCanonical(item, targetName, bot = null) {
  if (!item) return false;
  if (typeof item === "string") {
    return normalizeCanonicalItemId(item) === targetName;
  }
  if (typeof item !== "object") return false;
  if (extractCanonicalItemName(item) === targetName) return true;
  const rawId = Number.isInteger(item.type)
    ? item.type
    : Number.isInteger(item.itemId)
      ? item.itemId
      : Number.isInteger(item.id)
        ? item.id
        : null;
  if (rawId !== null && bot?.registry) {
    const targetDef = bot.registry.itemsByName?.[targetName];
    if (targetDef && targetDef.id === rawId) return true;
    const byId = bot.registry.items?.[rawId];
    if (byId && normalizeCanonicalItemId(byId.name) === targetName) return true;
  }
  if (
    typeof item.displayName === "string" &&
    normalizeCanonicalItemId(item.displayName) === targetName
  ) {
    return true;
  }
  return false;
}

export function isEntityInWater(entity, bot = null) {
  if (!entity || typeof entity !== "object") return false;
  const p = entity.position;
  if (p && bot && typeof bot.blockAt === "function") {
    try {
      const bx = Math.floor(p.x ?? 0);
      const by = Math.floor(p.y ?? 0);
      const bz = Math.floor(p.z ?? 0);
      const feet = bot.blockAt(vec3(bx, by, bz));
      const feetName = normalizeCanonicalItemId(feet?.name);
      if (WATER_BLOCK_NAMES.has(feetName)) return true;
      const head = bot.blockAt(vec3(bx, by + 1, bz));
      const headName = normalizeCanonicalItemId(head?.name);
      if (WATER_BLOCK_NAMES.has(headName)) return true;
      const below = bot.blockAt(vec3(bx, by - 1, bz));
      const belowName = normalizeCanonicalItemId(below?.name);
      if (
        feet &&
        (feetName === "air" || feetName === "cave_air" || feetName === "void_air" || feet.boundingBox === "empty") &&
        below &&
        below.boundingBox !== "empty" &&
        belowName &&
        !WATER_BLOCK_NAMES.has(belowName) &&
        belowName !== "air"
      ) {
        return false;
      }
    } catch {
      // Ignore partial mock lookup errors
    }
  }
  return Boolean(entity.isInWater);
}

/**
 * Detect whether a drowned entity is armed with a trident across Mineflayer & Paper 26.1.2
 * entity equipment representations (heldItem, mainHand, offHand, array/object equipment, numeric item IDs).
 */
export function isDrownedHoldingTrident(entity, bot = null) {
  if (!entity || typeof entity !== "object") return false;
  if (entity.hasTrident === true) return true;
  if (itemMatchesCanonical(entity.heldItem, "trident", bot)) return true;
  if (itemMatchesCanonical(entity.mainHand, "trident", bot)) return true;
  if (itemMatchesCanonical(entity.offHand, "trident", bot)) return true;
  if (Array.isArray(entity.equipment)) {
    for (const slotItem of entity.equipment) {
      if (itemMatchesCanonical(slotItem, "trident", bot)) return true;
    }
  } else if (entity.equipment && typeof entity.equipment === "object") {
    for (const slotItem of Object.values(entity.equipment)) {
      if (itemMatchesCanonical(slotItem, "trident", bot)) return true;
    }
  }
  return false;
}

/**
 * Treat trident-armed drowned at full ranged radius, and conservatively treat
 * in-water or close drowned (<= 12 blocks) as ranged/shield high threats so the
 * bot shields and flees instead of getting impaled when equipment sync lags.
 */
export function isDrownedHighThreat(entity, bot = null, dist = null) {
  if (!entity || typeof entity !== "object") return false;
  if (normalizeCanonicalItemId(String(entity.name || "")) !== "drowned") return false;
  if (isDrownedHoldingTrident(entity, bot)) return true;
  if (isEntityInWater(entity, bot) || isEntityInWater(bot?.entity, bot)) return true;
  const effectiveDist =
    typeof dist === "number" && Number.isFinite(dist)
      ? dist
      : bot?.entity?.position && entity.position
        ? distanceBetween(bot.entity.position, entity.position)
        : null;
  if (effectiveDist !== null && effectiveDist <= DROWNED_CONSERVATIVE_RANGED_RADIUS) {
    return true;
  }
  return false;
}

export function isRangedHostileEntity(entity, bot = null, dist = null) {
  if (!entity || typeof entity !== "object") return false;
  const name = normalizeCanonicalItemId(String(entity.name || ""));
  if (RANGED_HOSTILE_MOBS.has(name)) return true;
  if (name === "drowned") {
    return isDrownedHighThreat(entity, bot, dist);
  }
  return false;
}

export function isRangedShieldEntity(entity, bot = null, dist = null) {
  if (!entity || typeof entity !== "object") return false;
  const name = normalizeCanonicalItemId(String(entity.name || ""));
  if (name === "drowned") {
    return isDrownedHighThreat(entity, bot, dist);
  }
  return RANGED_SHIELD_MOBS.has(name);
}

/**
 * Classify an entity under strict zero-PvP, neutral/pet protection,
 * creeper standoff, and high-danger avoidance rules.
 *
 * Returns one of: "ignore" | "protected" | "creeper" | "avoid" | "engageable"
 */
export function classifyCombatEntity(entity, bot = null, combatState = null, nowMs = Date.now()) {
  if (!entity || typeof entity !== "object" || entity === bot?.entity || !entity.position) {
    return "ignore";
  }
  // Zero PvP iron law
  if (
    entity.type === "player" ||
    (typeof entity.username === "string" && entity.username.trim().length > 0)
  ) {
    return "protected";
  }
  // Tamed pet protection
  if (isTamedOrOwnedEntity(entity)) {
    return "protected";
  }

  const name = normalizeCanonicalItemId(String(entity.name || ""));
  if (!name || PROTECTED_ENTITIES.has(name)) {
    return "protected";
  }
  if (name === "creeper") {
    return "creeper";
  }
  if (AVOID_ALWAYS_MOBS.has(name)) {
    return "avoid";
  }
  if (name === "enderman") {
    return isEndermanProvoked(entity, combatState, nowMs) ? "engageable" : "avoid";
  }
  if (HOSTILE_MOBS.has(name)) {
    return "engageable";
  }
  return "protected";
}

export function applyNoDigMovements(bot) {
  return applyMovementProfile(bot, MOVEMENT_PROFILES.COMBAT_NODIG);
}

export function hasShieldEquipped(bot) {
  return collectEquipmentSnapshot(bot).off_hand === "shield";
}

export function raiseShield(bot, combatState) {
  if (!bot || !combatState || combatState.shieldRaised) return false;
  if (!hasShieldEquipped(bot) || typeof bot.activateItem !== "function") return false;
  try {
    bot.activateItem(true);
    combatState.shieldRaised = true;
    return true;
  } catch {
    return false;
  }
}

export function lowerShield(bot, combatState) {
  if (!combatState || !combatState.shieldRaised) return false;
  combatState.shieldRaised = false;
  try {
    bot?.deactivateItem?.();
  } catch {
    // Ignore deactivate errors
  }
  return true;
}

export function findNearestRangedShieldMob(bot, maxDist = RANGED_EVADE_RADIUS) {
  const origin = bot?.entity?.position;
  if (!origin) return null;
  let best = null;
  for (const ent of Object.values(bot.entities || {})) {
    if (!ent || ent === bot.entity || !ent.position) continue;
    const dist = distanceBetween(origin, ent.position);
    if (dist > maxDist) continue;
    if (!isRangedShieldEntity(ent, bot, dist)) continue;
    const name = normalizeCanonicalItemId(String(ent.name || ""));
    if (!best || dist < best.dist) {
      best = { entity: ent, name, dist };
    }
  }
  return best;
}

/**
 * Pulse-raise the off-hand shield during evade/retreat when ranged arrow/crossbow/trident
 * mobs are nearby (and no close melee/creeper threat demands full-speed sprinting).
 * Raises immediately for 1.8s after taking damage or on a 1.0s-block / 1.4s-sprint cycle
 * so the bot blocks incoming arrows/tridents without getting stuck at crouch speed.
 */
export function updateEvadeShieldDefense({
  bot,
  combatState,
  threats = null,
  nowMs = Date.now(),
  eating = false,
  lookAtEntityFn = null,
} = {}) {
  if (!bot || !combatState) return { raised: false, reason: "no_bot" };
  if (eating || !hasShieldEquipped(bot)) {
    lowerShield(bot, combatState);
    return { raised: false, reason: eating ? "eating" : "no_shield" };
  }

  let nearestRanged = null;
  let hasCloseMeleeOrCreeper = false;

  if (Array.isArray(threats) && threats.length > 0) {
    for (const t of threats) {
      if (!t) continue;
      const ent = t.entity || { name: t.name };
      const name = normalizeCanonicalItemId(String(t.name || t.entity?.name || ""));
      const dist = Number(t.dist ?? Infinity);
      const isRangedShield = isRangedShieldEntity(ent, bot, dist);
      const isTridentOrWaterDrowned =
        name === "drowned" &&
        (isDrownedHoldingTrident(ent, bot) ||
          isEntityInWater(ent, bot) ||
          isEntityInWater(bot?.entity, bot));
      if (name === "creeper" && dist <= CREEPER_SAFE_DISTANCE + 1) {
        hasCloseMeleeOrCreeper = true;
      } else if (
        dist <= SHIELD_CLOSE_MELEE_ABORT_DIST &&
        (!isRangedShield || (name === "drowned" && !isTridentOrWaterDrowned))
      ) {
        hasCloseMeleeOrCreeper = true;
      }
      if (isRangedShield && dist <= RANGED_EVADE_RADIUS) {
        if (!nearestRanged || dist < nearestRanged.dist) {
          nearestRanged = { entity: t.entity, name, dist };
        }
      }
    }
  } else {
    nearestRanged = findNearestRangedShieldMob(bot, RANGED_EVADE_RADIUS);
    const creeper = findNearestCreeper(bot, CREEPER_SAFE_DISTANCE + 1);
    if (creeper) {
      hasCloseMeleeOrCreeper = true;
    } else {
      const anyClose = findNearestAnyHostile(bot, SHIELD_CLOSE_MELEE_ABORT_DIST, combatState, nowMs);
      if (anyClose) {
        const closeRangedShield = isRangedShieldEntity(anyClose.entity, bot, anyClose.dist);
        const closeTridentOrWaterDrowned =
          anyClose.name === "drowned" &&
          (isDrownedHoldingTrident(anyClose.entity, bot) ||
            isEntityInWater(anyClose.entity, bot) ||
            isEntityInWater(bot?.entity, bot));
        if (!closeRangedShield || (anyClose.name === "drowned" && !closeTridentOrWaterDrowned)) {
          hasCloseMeleeOrCreeper = true;
        }
      }
    }
  }

  if (!nearestRanged || hasCloseMeleeOrCreeper) {
    lowerShield(bot, combatState);
    combatState.shieldWindowStartMs = -Infinity;
    return {
      raised: false,
      reason: hasCloseMeleeOrCreeper ? "close_melee_sprint" : "no_ranged_threat",
    };
  }

  const recentlyHit =
    Number.isFinite(combatState.lastDamageAtMs) &&
    nowMs - combatState.lastDamageAtMs >= 0 &&
    nowMs - combatState.lastDamageAtMs <= SHIELD_POST_HIT_WINDOW_MS;

  if (!Number.isFinite(combatState.shieldWindowStartMs)) {
    combatState.shieldWindowStartMs = nowMs;
  }
  const cycleElapsed = Math.max(0, nowMs - combatState.shieldWindowStartMs) % SHIELD_BLOCK_CYCLE_MS;
  const inBlockWindow = recentlyHit || cycleElapsed < SHIELD_BLOCK_WINDOW_MS;

  if (inBlockWindow) {
    if (typeof lookAtEntityFn === "function" && nearestRanged.entity) {
      lookAtEntityFn(bot, nearestRanged.entity);
    }
    const ok = combatState.shieldRaised || raiseShield(bot, combatState);
    return {
      raised: ok,
      reason: recentlyHit ? "post_hit_block" : "ranged_cycle_block",
      target: nearestRanged,
    };
  }

  lowerShield(bot, combatState);
  return { raised: false, reason: "sprint_window", target: nearestRanged };
}

export function computeRetreatTarget(origin, threatPos, stepDist = 10, safeAnchorPos = null) {
  const ox = origin.x ?? 0;
  const oz = origin.z ?? 0;
  const tx0 = threatPos.x ?? 0;
  const tz0 = threatPos.z ?? 0;
  const dx = ox - tx0;
  const dz = oz - tz0;
  const len = Math.hypot(dx, dz) || 1;
  let rx = Math.round(ox + (dx / len) * stepDist);
  let rz = Math.round(oz + (dz / len) * stepDist);

  if (safeAnchorPos) {
    const threatToBot = distanceBetween(origin, threatPos);
    const threatToAnchor = distanceBetween(safeAnchorPos, threatPos);
    const botToAnchor = distanceBetween(origin, safeAnchorPos);
    if (botToAnchor <= 24 && threatToAnchor > threatToBot + 2 && threatToAnchor > CREEPER_SAFE_DISTANCE + 2) {
      rx = Math.round(safeAnchorPos.x ?? rx);
      rz = Math.round(safeAnchorPos.z ?? rz);
    }
  }
  return { x: rx, z: rz };
}

export function findNearestCreeper(bot, maxDist = CREEPER_SAFE_DISTANCE) {
  const origin = bot?.entity?.position;
  if (!origin) return null;
  let best = null;
  for (const ent of Object.values(bot.entities || {})) {
    if (classifyCombatEntity(ent, bot) !== "creeper") continue;
    const dist = distanceBetween(origin, ent.position);
    if (dist <= maxDist && (!best || dist < best.dist)) {
      best = { entity: ent, name: "creeper", dist };
    }
  }
  return best;
}

export function findNearestAvoidMob(bot, maxDist = AVOID_HIGH_DANGER_RADIUS) {
  const origin = bot?.entity?.position;
  if (!origin) return null;
  let best = null;
  for (const ent of Object.values(bot.entities || {})) {
    const name = normalizeCanonicalItemId(String(ent?.name || ""));
    if (!AVOID_ALWAYS_MOBS.has(name)) continue;
    if (classifyCombatEntity(ent, bot) !== "avoid") continue;
    const dist = distanceBetween(origin, ent.position);
    if (dist <= maxDist && (!best || dist < best.dist)) {
      best = { entity: ent, name, dist };
    }
  }
  return best;
}

export function findNearestAnyHostile(bot, maxDist = 12, combatState = null, nowMs = Date.now()) {
  const origin = bot?.entity?.position;
  if (!origin) return null;
  let best = null;
  for (const ent of Object.values(bot.entities || {})) {
    const cls = classifyCombatEntity(ent, bot, combatState, nowMs);
    if (cls !== "engageable" && cls !== "creeper" && cls !== "avoid") continue;
    const name = normalizeCanonicalItemId(String(ent.name || ""));
    if (name === "enderman" && !isEndermanProvoked(ent, combatState, nowMs)) continue;
    const dist = distanceBetween(origin, ent.position);
    if (dist <= maxDist && (!best || dist < best.dist)) {
      best = { entity: ent, name, cls, dist };
    }
  }
  return best;
}

/**
 * Identify immediate critical hostile threats that must interrupt a long-running
 * bounded goal (creeper, avoid-always, ranged/trident mob, aggro enderman, close melee).
 */
export function findCriticalGoalInterruptThreat(
  bot,
  { combatState = null, nowMs = Date.now() } = {},
) {
  const origin = bot?.entity?.position;
  if (!origin) return null;
  let best = null;
  const rankOf = { creeper: 0, avoid: 1, enderman: 2, ranged: 3, melee: 4 };

  for (const ent of Object.values(bot.entities || {})) {
    if (!ent || ent === bot.entity || !ent.position) continue;
    const cls = classifyCombatEntity(ent, bot, combatState, nowMs);
    if (cls !== "engageable" && cls !== "creeper" && cls !== "avoid") continue;
    const name = normalizeCanonicalItemId(String(ent.name || ""));
    if (!name) continue;
    if (name === "enderman" && !isEndermanProvoked(ent, combatState, nowMs)) continue;
    const dist = distanceBetween(origin, ent.position);

    let category = "";
    if (name === "creeper" && dist <= CREEPER_SAFE_DISTANCE + 1) {
      category = "creeper";
    } else if (AVOID_ALWAYS_MOBS.has(name) && dist <= AVOID_HIGH_DANGER_RADIUS) {
      category = "avoid";
    } else if (name === "enderman" && dist <= AVOID_HIGH_DANGER_RADIUS) {
      category = "enderman";
    } else if (isRangedHostileEntity(ent, bot, dist) && dist <= RANGED_EVADE_RADIUS) {
      category = "ranged";
    } else if (dist <= MELEE_CRITICAL_INTERRUPT_RADIUS) {
      category = "melee";
    }
    if (!category) continue;

    const candidate = { entity: ent, name, cls, dist, category, rank: rankOf[category] ?? 9 };
    if (
      !best ||
      candidate.rank < best.rank ||
      (candidate.rank === best.rank && candidate.dist < best.dist)
    ) {
      best = candidate;
    }
  }
  return best;
}

export function hasNearbyHostileOrProjectile(
  bot,
  {
    combatState = null,
    nowMs = Date.now(),
    maxHostileDist = RANGED_EVADE_RADIUS + 4,
    maxProjectileDist = 8,
  } = {},
) {
  const origin = bot?.entity?.position;
  if (!origin) return null;
  let best = null;
  for (const ent of Object.values(bot.entities || {})) {
    if (!ent || ent === bot.entity || !ent.position) continue;
    const name = normalizeCanonicalItemId(String(ent.name || ""));
    if (!name) continue;
    const dist = distanceBetween(origin, ent.position);
    if (PROJECTILE_ENTITY_NAMES.has(name) && dist <= maxProjectileDist) {
      if (!best || dist < best.dist) {
        best = { entity: ent, name, dist, kind: "projectile" };
      }
      continue;
    }
    const cls = classifyCombatEntity(ent, bot, combatState, nowMs);
    if (cls !== "engageable" && cls !== "creeper" && cls !== "avoid") continue;
    if (name === "enderman" && !isEndermanProvoked(ent, combatState, nowMs)) continue;
    if (dist <= maxHostileDist && (!best || dist < best.dist)) {
      best = { entity: ent, name, dist, kind: "hostile" };
    }
  }
  return best;
}

export function findGuardTargetHostile(
  bot,
  guardedPlayer = null,
  combatState = null,
  nowMs = Date.now(),
) {
  const origin = bot?.entity?.position;
  if (!origin) return null;
  const playerPos = guardedPlayer?.entity?.position ?? null;

  let best = null;
  for (const ent of Object.values(bot.entities || {})) {
    if (classifyCombatEntity(ent, bot, combatState, nowMs) !== "engageable") continue;
    const distToBot = distanceBetween(origin, ent.position);
    const distToPlayer = playerPos ? distanceBetween(playerPos, ent.position) : Infinity;

    if (playerPos) {
      // Never chase a mob beyond MAX_LEASH_FROM_PLAYER (14 blocks) from guarded player
      if (distToPlayer > MAX_LEASH_FROM_PLAYER) continue;
      // Only engage if within <= 10 blocks of guarded player OR <= 7 blocks of bot (self-defense)
      if (distToPlayer > GUARD_PLAYER_RADIUS && distToBot > SELF_DEFENSE_RADIUS) continue;
    } else if (distToBot > SELF_DEFENSE_RADIUS) {
      continue;
    }

    const name = normalizeCanonicalItemId(String(ent.name || ""));
    const priorityScore = playerPos ? Math.min(distToPlayer, distToBot + 1.5) : distToBot;
    if (!best || priorityScore < best.priorityScore) {
      best = { entity: ent, name, dist: distToBot, distToPlayer, priorityScore };
    }
  }
  return best;
}

export async function runGuardCombatStep({
  bot,
  combatState,
  guardedPlayer = null,
  health = null,
  food = null,
  nowMs,
  autoEquip = true,
  eating = false,
  lookAtEntityFn = null,
  onNeedHealEat = null,
  onCreeperAlert = null,
  onRetreatAlert = null,
}) {
  const origin = bot?.entity?.position;
  if (!origin) return { handled: false, inCombat: false };

  const playerPos = guardedPlayer?.entity?.position ?? null;

  // 0. Low-health retreat & heal hysteresis (<= 7 retreat, >= 12 resume)
  if (typeof health === "number" && Number.isFinite(health)) {
    if (health <= RETREAT_HEALTH_THRESHOLD) {
      combatState.retreating = true;
    } else if (combatState.retreating && health >= RESUME_HEALTH_THRESHOLD) {
      combatState.retreating = false;
    }
  }

  if (combatState.retreating) {
    combatState.activeTargetId = null;
    const nearestThreat = findNearestAnyHostile(bot, 12, combatState, nowMs);
    const shieldRes = updateEvadeShieldDefense({
      bot,
      combatState,
      nowMs,
      eating,
      lookAtEntityFn,
    });
    if (nearestThreat) {
      const dest = computeRetreatTarget(origin, nearestThreat.entity.position, 10, playerPos);
      applyNoDigMovements(bot);
      try {
        bot.pathfinder?.setGoal?.(new GoalNearXZ(dest.x, dest.z, 2), true);
      } catch {
        // Ignore pathfinder errors
      }
    }
    if (typeof onRetreatAlert === "function") {
      onRetreatAlert({ health, food });
    }
    if (typeof onNeedHealEat === "function" && (food === null || food < 20)) {
      onNeedHealEat();
    }
    return {
      handled: true,
      inCombat: false,
      action: "retreat_heal",
      shieldRaised: shieldRes.raised,
      activity: shieldRes.raised ? "举盾撤退回血" : "残血撤退回血",
    };
  }

  // 1. Creeper safe standoff (> 6 blocks, NEVER melee!)
  const creeper = findNearestCreeper(bot, CREEPER_SAFE_DISTANCE);
  if (creeper) {
    lowerShield(bot, combatState);
    combatState.activeTargetId = null;
    const dest = computeRetreatTarget(origin, creeper.entity.position, 10, playerPos);
    applyNoDigMovements(bot);
    try {
      bot.pathfinder?.setGoal?.(new GoalNearXZ(dest.x, dest.z, 2), true);
    } catch {
      // Ignore pathfinder errors
    }
    if (typeof onCreeperAlert === "function") {
      onCreeperAlert(creeper);
    }
    return {
      handled: true,
      inCombat: false,
      action: "creeper_standoff",
      creeper,
      activity: "远离苦力怕",
    };
  }

  // 2. Avoid high-danger mobs (warden, ravager, piglin_brute)
  const avoidMob = findNearestAvoidMob(bot, AVOID_HIGH_DANGER_RADIUS);
  if (avoidMob) {
    lowerShield(bot, combatState);
    combatState.activeTargetId = null;
    const dest = computeRetreatTarget(origin, avoidMob.entity.position, 14, playerPos);
    applyNoDigMovements(bot);
    try {
      bot.pathfinder?.setGoal?.(new GoalNearXZ(dest.x, dest.z, 2), true);
    } catch {
      // Ignore pathfinder errors
    }
    return {
      handled: true,
      inCombat: false,
      action: "avoid_danger",
      avoidMob,
      activity: "避开高危怪物",
    };
  }

  // 3. Enforce max leash distance (<= 14 blocks from guarded player)
  if (playerPos && distanceBetween(origin, playerPos) > MAX_LEASH_FROM_PLAYER) {
    lowerShield(bot, combatState);
    combatState.activeTargetId = null;
    applyNoDigMovements(bot);
    try {
      bot.pathfinder?.setGoal?.(new GoalFollow(guardedPlayer.entity, 3), true);
    } catch {
      // Ignore pathfinder errors
    }
    return {
      handled: true,
      inCombat: false,
      action: "leash_return",
      activity: `归队护卫:${guardedPlayer.username}`,
    };
  }

  // 4. Engage valid hostile within guard (<=10) / self-defense (<=7) & leash (<=14)
  const target = findGuardTargetHostile(bot, guardedPlayer, combatState, nowMs);
  if (!target) {
    lowerShield(bot, combatState);
    combatState.activeTargetId = null;
    return { handled: false, inCombat: false };
  }

  // Re-verify safety classification immediately before any engagement
  if (classifyCombatEntity(target.entity, bot, combatState, nowMs) !== "engageable") {
    lowerShield(bot, combatState);
    combatState.activeTargetId = null;
    return { handled: false, inCombat: false };
  }

  combatState.activeTargetId = target.entity.id ?? target.name;
  let weaponName = extractCanonicalItemName(bot.heldItem);
  if (autoEquip && !eating) {
    weaponName = await equipBestWeapon(bot);
  }
  const cooldownMs = getWeaponAttackCooldownMs(weaponName);
  const isRangedSkeleton = isRangedShieldEntity(target.entity, bot, target.dist);
  const shieldReady = hasShieldEquipped(bot);

  if (typeof lookAtEntityFn === "function") {
    lookAtEntityFn(bot, target.entity);
  }

  if (target.dist > MELEE_REACH) {
    if (isRangedSkeleton && shieldReady && !eating) {
      raiseShield(bot, combatState);
    } else {
      lowerShield(bot, combatState);
    }
    applyNoDigMovements(bot);
    try {
      bot.pathfinder?.setGoal?.(new GoalFollow(target.entity, 2), true);
    } catch {
      // Ignore pathfinder errors
    }
    return {
      handled: true,
      inCombat: true,
      action: "approach_hostile",
      attacked: false,
      target,
      cooldownMs,
      activity: `护卫迎击:${target.name}`,
    };
  }

  // Within melee reach: enforce 1.9+ attack speed cooldown (sword ~625ms, axe ~1000ms)
  const elapsed = nowMs - combatState.lastAttackAtMs;
  if (elapsed >= cooldownMs && !eating) {
    if (classifyCombatEntity(target.entity, bot, combatState, nowMs) !== "engageable") {
      lowerShield(bot, combatState);
      return { handled: false, inCombat: false };
    }
    lowerShield(bot, combatState);
    if (typeof bot.attack === "function") {
      try {
        bot.attack(target.entity);
        combatState.lastAttackAtMs = nowMs;
      } catch {
        // Ignore attack errors
      }
    }
    return {
      handled: true,
      inCombat: true,
      action: "attack_hostile",
      attacked: true,
      target,
      cooldownMs,
      activity: `护卫迎击:${target.name}`,
    };
  }

  if (isRangedSkeleton && shieldReady && !eating) {
    raiseShield(bot, combatState);
  }
  return {
    handled: true,
    inCombat: true,
    action: "combat_cooldown",
    attacked: false,
    target,
    cooldownMs,
    activity: `护卫迎击:${target.name}`,
  };
}
