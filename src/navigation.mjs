import vec3 from "vec3";
import pathfinderPkg from "mineflayer-pathfinder";
import { normalizeCanonicalItemId } from "./protocol.mjs";
import { extractCanonicalItemName, getInventoryItems } from "./survival.mjs";

const { Movements } = pathfinderPkg;

/**
 * Navigation profiles inspired by Baritone / Mindcraft / Voyager:
 * - combat_nodig:      pure physical flee/combat (zero digging, zero placing)
 * - cruise_walk:       default zero-terrain-change navigation (walk/sprint/parkour/open gates)
 * - natural_traverse:  default-deny 3D A* allowing ONLY pure natural soft terrain & foliage
 *                      at high cost (digCost=4, placeCost=5) with a 1-block player-build aura
 * - escape_rock:       bounded cave/pit escalation adding raw natural rock ONLY when carrying
 *                      a valid pickaxe, still enforcing the player-build aura and no-flow rules
 */
export const MOVEMENT_PROFILES = Object.freeze({
  COMBAT_NODIG: "combat_nodig",
  CRUISE_WALK: "cruise_walk",
  NATURAL_TRAVERSE: "natural_traverse",
  ESCAPE_ROCK: "escape_rock",
});

export const NATURAL_FOLIAGE_BLOCKS = new Set([
  "vine",
  "glow_lichen",
  "short_grass",
  "grass",
  "tall_grass",
  "fern",
  "large_fern",
  "bush",
  "dead_bush",
  "snow",
  "snow_block",
  "leaf_litter",
  "pink_petals",
  "wildflowers",
  "hanging_roots",
  "moss_carpet",
  "azalea",
  "flowering_azalea",
]);

export const NATURAL_SOFT_TERRAIN_BLOCKS = new Set([
  "dirt",
  "grass_block",
  "coarse_dirt",
  "podzol",
  "rooted_dirt",
  "mud",
  "muddy_mangrove_roots",
  "sand",
  "red_sand",
  "gravel",
  "clay",
  "mycelium",
  "moss_block",
  "soul_sand",
  "soul_soil",
]);

// Intentionally excludes cobblestone & cobbled_deepslate (commonly player-placed).
export const NATURAL_ROCK_TERRAIN_BLOCKS = new Set([
  "stone",
  "deepslate",
  "granite",
  "diorite",
  "andesite",
  "tuff",
  "calcite",
  "dripstone_block",
  "sandstone",
  "red_sandstone",
  "netherrack",
  "basalt",
  "blackstone",
  "end_stone",
]);

export const SAFE_SCAFFOLD_BLOCKS = new Set([
  "dirt",
  "coarse_dirt",
  "cobblestone",
  "cobbled_deepslate",
  "netherrack",
  "sandstone",
  "andesite",
  "diorite",
  "granite",
  "tuff",
  "oak_planks",
  "birch_planks",
  "spruce_planks",
  "jungle_planks",
  "acacia_planks",
  "dark_oak_planks",
  "mangrove_planks",
  "cherry_planks",
  "pale_oak_planks",
]);

export const HAZARD_AVOID_BLOCKS = new Set([
  "lava",
  "flowing_lava",
  "fire",
  "soul_fire",
  "campfire",
  "soul_campfire",
  "magma_block",
  "cactus",
  "sweet_berry_bush",
  "wither_rose",
  "powder_snow",
  "cobweb",
  "web",
  "pointed_dripstone",
]);

const PLAYER_BUILD_EXACT_BLOCKS = new Set([
  "chest",
  "trapped_chest",
  "ender_chest",
  "barrel",
  "shulker_box",
  "crafting_table",
  "furnace",
  "blast_furnace",
  "smoker",
  "anvil",
  "chipped_anvil",
  "damaged_anvil",
  "enchanting_table",
  "brewing_stand",
  "beacon",
  "respawn_anchor",
  "lodestone",
  "bell",
  "lectern",
  "composter",
  "smithing_table",
  "fletching_table",
  "cartography_table",
  "grindstone",
  "loom",
  "stonecutter",
  "jukebox",
  "note_block",
  "bookshelf",
  "chiseled_bookshelf",
  "farmland",
  "cobblestone",
  "mossy_cobblestone",
  "cobbled_deepslate",
  "glass",
  "tinted_glass",
  "glass_pane",
  "torch",
  "wall_torch",
  "soul_torch",
  "soul_wall_torch",
  "lantern",
  "soul_lantern",
  "glowstone",
  "sea_lantern",
  "redstone_lamp",
  "ladder",
  "scaffolding",
  "iron_bars",
  "chain",
  "rail",
  "powered_rail",
  "detector_rail",
  "activator_rail",
  "hopper",
  "dropper",
  "dispenser",
  "observer",
  "piston",
  "sticky_piston",
  "redstone_wire",
  "repeater",
  "comparator",
  "lever",
  "hay_block",
  "target",
  "cake",
  "flower_pot",
  "spawner",
  "wheat",
  "carrots",
  "potatoes",
  "beetroots",
  "nether_wart",
  "melon_stem",
  "pumpkin_stem",
  "attached_melon_stem",
  "attached_pumpkin_stem",
  "torchflower_crop",
  "pitcher_crop",
]);

const PLAYER_BUILD_SUFFIXES = [
  "_planks",
  "_bed",
  "_door",
  "_trapdoor",
  "_fence",
  "_fence_gate",
  "_stairs",
  "_slab",
  "_wall",
  "_bricks",
  "_brick",
  "_glass",
  "_glass_pane",
  "_wool",
  "_carpet",
  "_concrete",
  "_concrete_powder",
  "_glazed_terracotta",
  "_banner",
  "_sign",
  "_hanging_sign",
  "_button",
  "_pressure_plate",
  "_shulker_box",
  "_candle",
  "_copper_bulb",
  "_copper_grate",
];

const PLAYER_BUILD_PREFIXES = ["polished_", "cut_", "chiseled_", "smooth_", "stripped_"];

const PICKAXE_ITEM_NAMES = new Set([
  "wooden_pickaxe",
  "golden_pickaxe",
  "stone_pickaxe",
  "iron_pickaxe",
  "diamond_pickaxe",
  "netherite_pickaxe",
]);

const CONTROL_KEYS = ["forward", "back", "left", "right", "jump", "sprint", "sneak"];

export function isNaturalFoliageBlock(name) {
  const clean = normalizeCanonicalItemId(name);
  if (!clean) return false;
  return clean.endsWith("_leaves") || NATURAL_FOLIAGE_BLOCKS.has(clean);
}

export function isNaturalSoftBlock(name) {
  const clean = normalizeCanonicalItemId(name);
  if (!clean) return false;
  return isNaturalFoliageBlock(clean) || NATURAL_SOFT_TERRAIN_BLOCKS.has(clean);
}

export function isNaturalRockBlock(name) {
  const clean = normalizeCanonicalItemId(name);
  if (!clean) return false;
  return NATURAL_ROCK_TERRAIN_BLOCKS.has(clean);
}

export function isPlayerBuildSignatureBlock(name) {
  const clean = normalizeCanonicalItemId(name);
  if (!clean) return false;
  if (PLAYER_BUILD_EXACT_BLOCKS.has(clean)) return true;
  for (const suffix of PLAYER_BUILD_SUFFIXES) {
    if (clean.endsWith(suffix)) return true;
  }
  for (const prefix of PLAYER_BUILD_PREFIXES) {
    if (clean.startsWith(prefix)) return true;
  }
  return false;
}

export function hasPickaxeInInventory(bot) {
  if (!bot) return false;
  const held = extractCanonicalItemName(bot.heldItem);
  if (PICKAXE_ITEM_NAMES.has(held)) return true;
  for (const it of getInventoryItems(bot)) {
    if (PICKAXE_ITEM_NAMES.has(extractCanonicalItemName(it))) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if any block in the 3x3x3 neighborhood around `pos` (excluding `pos` itself)
 * matches a player-built / base / farm signature block. Protects even dirt/grass/stone
 * blocks that form walls, roofs, or borders of a player's build.
 */
export function isNearPlayerStructure(bot, pos, cache = null) {
  if (!bot || typeof bot.blockAt !== "function" || !pos) return false;
  const bx = Math.floor(pos.x ?? pos[0] ?? 0);
  const by = Math.floor(pos.y ?? pos[1] ?? 0);
  const bz = Math.floor(pos.z ?? pos[2] ?? 0);
  if (!Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz)) return false;

  const key = `${bx},${by},${bz}`;
  if (cache && cache.has(key)) {
    return cache.get(key);
  }

  let near = false;
  outer: for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        try {
          const blk = bot.blockAt(vec3(bx + dx, by + dy, bz + dz), false);
          if (blk && isPlayerBuildSignatureBlock(blk.name)) {
            near = true;
            break outer;
          }
        } catch {
          // Ignore unloaded chunk / partial mock lookup errors
        }
      }
    }
  }

  if (cache) {
    cache.set(key, near);
  }
  return near;
}

export function clearBotControlStates(bot) {
  if (!bot) return;
  try {
    if (typeof bot.clearControlStates === "function") {
      bot.clearControlStates();
    }
  } catch {
    // Ignore control clear errors
  }
  if (typeof bot.setControlState === "function") {
    for (const ctrl of CONTROL_KEYS) {
      try {
        bot.setControlState(ctrl, false);
      } catch {
        // Ignore individual control reset errors
      }
    }
  }
  try {
    bot.setSprinting?.(false);
  } catch {
    // Ignore sprint reset errors
  }
}

function collectScaffoldItemIds(bot) {
  const ids = [];
  const itemsByName = bot?.registry?.itemsByName;
  if (!itemsByName) return ids;
  const seen = new Set();
  for (const name of SAFE_SCAFFOLD_BLOCKS) {
    const def = itemsByName[name];
    if (def && typeof def.id === "number" && !seen.has(def.id)) {
      seen.add(def.id);
      ids.push(def.id);
    }
  }
  return ids;
}

function resolveProfileSpec(bot, profileName, opts = {}) {
  const health =
    typeof opts.health === "number" && Number.isFinite(opts.health)
      ? opts.health
      : typeof bot?.health === "number" && Number.isFinite(bot.health)
        ? bot.health
        : null;
  const requestedDrop =
    typeof opts.maxDropDown === "number" && Number.isFinite(opts.maxDropDown)
      ? Math.max(3, Math.min(4, Math.floor(opts.maxDropDown)))
      : null;
  const requestedThinkMs =
    typeof opts.thinkTimeout === "number" && Number.isFinite(opts.thinkTimeout)
      ? Math.max(200, Math.min(5_000, Math.floor(opts.thinkTimeout)))
      : null;
  const requestedSearchRadius =
    typeof opts.searchRadius === "number" && Number.isFinite(opts.searchRadius)
      ? Math.max(8, Math.min(96, Math.floor(opts.searchRadius)))
      : null;

  if (profileName === MOVEMENT_PROFILES.COMBAT_NODIG) {
    return {
      profile: MOVEMENT_PROFILES.COMBAT_NODIG,
      canDig: false,
      allowRockDig: false,
      allowScaffold: false,
      digCost: 8,
      placeCost: 6,
      liquidCost: 4,
      entityCost: 2,
      maxDropDown: 3,
      canOpenDoors: false,
      allowParkour: true,
      allowSprinting: true,
      thinkTimeout: requestedThinkMs ?? 1_200,
      searchRadius: requestedSearchRadius ?? 32,
    };
  }

  if (profileName === MOVEMENT_PROFILES.NATURAL_TRAVERSE) {
    const safeDrop = requestedDrop ?? (health === null || health >= 8 ? 4 : 3);
    return {
      profile: MOVEMENT_PROFILES.NATURAL_TRAVERSE,
      canDig: true,
      allowRockDig: false,
      allowScaffold: opts.allowStepScaffold !== false,
      digCost: 4,
      placeCost: 5,
      liquidCost: 4,
      entityCost: 2,
      maxDropDown: safeDrop,
      canOpenDoors: true,
      allowParkour: true,
      allowSprinting: true,
      thinkTimeout: requestedThinkMs ?? 2_200,
      searchRadius: requestedSearchRadius ?? 48,
    };
  }

  if (profileName === MOVEMENT_PROFILES.ESCAPE_ROCK) {
    const safeDrop = requestedDrop ?? (health === null || health >= 8 ? 4 : 3);
    const canRock = hasPickaxeInInventory(bot);
    return {
      profile: MOVEMENT_PROFILES.ESCAPE_ROCK,
      canDig: true,
      allowRockDig: canRock,
      allowScaffold: opts.allowStepScaffold !== false,
      digCost: 5,
      placeCost: 5,
      liquidCost: 4,
      entityCost: 2,
      maxDropDown: safeDrop,
      canOpenDoors: true,
      allowParkour: true,
      allowSprinting: true,
      thinkTimeout: requestedThinkMs ?? 2_500,
      searchRadius: requestedSearchRadius ?? 40,
    };
  }

  // Default: cruise_walk (backward compatible with applySafeMovements(bot))
  const allowDig = Boolean(opts.allowDig);
  const allowScaffold = Boolean(opts.allowStepScaffold);
  return {
    profile: MOVEMENT_PROFILES.CRUISE_WALK,
    canDig: allowDig,
    allowRockDig: false,
    allowScaffold,
    digCost: 4,
    placeCost: 5,
    liquidCost: 4,
    entityCost: 2,
    maxDropDown: requestedDrop ?? 3,
    canOpenDoors: true,
    allowParkour: true,
    allowSprinting: true,
    thinkTimeout: requestedThinkMs ?? 1_500,
    searchRadius: requestedSearchRadius ?? 48,
  };
}

/**
 * Build a `mineflayer-pathfinder` Movements instance for the requested profile.
 * Enforces strict Default-Deny block breaking + 1-block player-build aura so A*
 * can solve arbitrary natural terrain while remaining zero-griefing near bases.
 */
export function createMovementProfile(
  bot,
  profileName = MOVEMENT_PROFILES.CRUISE_WALK,
  opts = {},
) {
  if (!bot) return null;
  const spec = resolveProfileSpec(bot, profileName, opts);
  const scaffoldIds = spec.allowScaffold ? collectScaffoldItemIds(bot) : [];
  const auraCache = new Map();
  const auraExclusionBreak = (block) => {
    if (!block?.position) return 0;
    return isNearPlayerStructure(bot, block.position, auraCache) ? 100 : 0;
  };

  if (bot.registry?.blocksByName) {
    try {
      const movements = new Movements(bot);
      movements.profileName = spec.profile;
      movements.canDig = spec.canDig;
      movements.digCost = spec.digCost;
      movements.placeCost = spec.placeCost;
      movements.liquidCost = spec.liquidCost;
      movements.entityCost = spec.entityCost;
      movements.dontCreateFlow = true;
      movements.dontMineUnderFallingBlock = true;
      movements.allow1by1towers = spec.allowScaffold;
      movements.canPlaceOn = Boolean(spec.canDig || spec.allowScaffold);
      if ("allowSprinting" in movements) movements.allowSprinting = spec.allowSprinting;
      if ("allowParkour" in movements) movements.allowParkour = spec.allowParkour;
      if ("maxDropDown" in movements) movements.maxDropDown = spec.maxDropDown;
      if ("canOpenDoors" in movements) movements.canOpenDoors = spec.canOpenDoors;

      // Default-Deny break whitelist: forbid EVERY block except pure natural terrain
      if (spec.canDig && Array.isArray(bot.registry.blocksArray)) {
        movements.blocksCantBreak = new Set();
        for (const blk of bot.registry.blocksArray) {
          if (!blk || typeof blk.id !== "number") continue;
          const allowedSoft = isNaturalSoftBlock(blk.name);
          const allowedRock = spec.allowRockDig && isNaturalRockBlock(blk.name);
          if (!blk.diggable || (!allowedSoft && !allowedRock)) {
            movements.blocksCantBreak.add(blk.id);
          }
        }
        if (Array.isArray(movements.exclusionAreasBreak)) {
          movements.exclusionAreasBreak.push(auraExclusionBreak);
        }
      }

      // Avoid all environmental hazard blocks
      if (movements.blocksToAvoid instanceof Set) {
        for (const hazardName of HAZARD_AVOID_BLOCKS) {
          const def = bot.registry.blocksByName[hazardName];
          if (def && typeof def.id === "number") {
            movements.blocksToAvoid.add(def.id);
          }
        }
      }

      if (Array.isArray(movements.scafoldingBlocks)) {
        movements.scafoldingBlocks = spec.allowScaffold ? scaffoldIds : [];
      }
      movements.thinkTimeout = spec.thinkTimeout;
      movements.searchRadius = spec.searchRadius;

      return movements;
    } catch {
      // Fall through to lightweight safe movements object on partial test registries
    }
  }

  return {
    profileName: spec.profile,
    canDig: spec.canDig,
    allowRockDig: spec.allowRockDig,
    digCost: spec.digCost,
    placeCost: spec.placeCost,
    liquidCost: spec.liquidCost,
    entityCost: spec.entityCost,
    dontCreateFlow: true,
    dontMineUnderFallingBlock: true,
    allow1by1towers: spec.allowScaffold,
    canPlaceOn: Boolean(spec.canDig || spec.allowScaffold),
    allowSprinting: spec.allowSprinting,
    allowParkour: spec.allowParkour,
    maxDropDown: spec.maxDropDown,
    canOpenDoors: spec.canOpenDoors,
    thinkTimeout: spec.thinkTimeout,
    searchRadius: spec.searchRadius,
    scafoldingBlocks: spec.allowScaffold
      ? scaffoldIds.length > 0
        ? scaffoldIds
        : ["dirt", "cobblestone"]
      : [],
    exclusionAreasBreak: spec.canDig ? [auraExclusionBreak] : [],
  };
}

export function applyMovementProfile(
  bot,
  profileName = MOVEMENT_PROFILES.CRUISE_WALK,
  opts = {},
) {
  if (!bot) return null;
  if (!bot.pathfinder && typeof bot.loadPlugin === "function" && bot.registry?.blocksByName) {
    bot.loadPlugin(pathfinderPkg.pathfinder);
  }
  if (!bot.pathfinder || typeof bot.pathfinder.setMovements !== "function") return null;
  const movements = createMovementProfile(bot, profileName, opts);
  if (movements) {
    if (typeof movements.thinkTimeout === "number") {
      bot.pathfinder.thinkTimeout = movements.thinkTimeout;
    }
    if (typeof movements.searchRadius === "number") {
      bot.pathfinder.searchRadius = movements.searchRadius;
    }
    bot.pathfinder.setMovements(movements);
  }
  return movements;
}

function posTuple(pos) {
  if (!pos || typeof pos !== "object") return null;
  const x = Number(pos.x);
  const y = Number(pos.y);
  const z = Number(pos.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

function dist3d(a, b) {
  if (!a || !b) return 0;
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function isAlreadyAtGoal(bot, goal) {
  const cur = bot?.entity?.position;
  if (!cur || typeof goal?.isEnd !== "function") return false;
  try {
    return Boolean(
      goal.isEnd({
        x: Math.floor(cur.x ?? 0),
        y: Math.floor(cur.y ?? 0),
        z: Math.floor(cur.z ?? 0),
      }),
    );
  } catch {
    return false;
  }
}

function stopPathfinderSafe(bot) {
  try {
    bot?.pathfinder?.stop?.();
  } catch {
    // Ignore stop errors
  }
  try {
    bot?.pathfinder?.setGoal?.(null);
  } catch {
    // Ignore setGoal clear errors
  }
}

/**
 * Single-profile navigation driver that replaces upstream `mineflayer-pathfinder/lib/goto.js`.
 * - Uses direct event-driven `setGoal(goal)` on live `mineflayer-pathfinder` bots
 *   (immune to `lib/goto.js:23` resolving silently on `noPath` with `path.length === 0`).
 * - Falls back seamlessly to `bot.pathfinder.goto(goal)` (with `path_update` `noPath`
 *   interception) on lightweight unit-test mocks that only mock `goto`.
 * - Always clears goal and all movement control states in `finally`.
 */
export async function runSingleNavigation(
  bot,
  goal,
  {
    profile = MOVEMENT_PROFILES.CRUISE_WALK,
    profileOpts = {},
    signal = null,
    stuckCheckIntervalMs = 2_500,
    onStuckStrike = null,
    useEventDriver = null,
    maxResetThrash = 6,
    maxPartialStall = 8,
  } = {},
) {
  if (!bot?.pathfinder) {
    throw new Error("pathfinder_unavailable");
  }
  if (signal?.aborted) {
    return { ok: false, aborted: true, reason: "mc_goal_cancelled", movedBlocks: 0, profile };
  }

  const startPos = posTuple(bot.entity?.position);
  applyMovementProfile(bot, profile, profileOpts);

  const hasLiveEventDriver =
    useEventDriver === true ||
    (useEventDriver !== false &&
      typeof bot.pathfinder.getPathTo === "function" &&
      typeof bot.pathfinder.setGoal === "function" &&
      typeof bot.on === "function");

  if (!hasLiveEventDriver && typeof bot.pathfinder.goto !== "function") {
    throw new Error("pathfinder_unavailable");
  }

  let settled = false;
  let stuckTimer = null;
  let nudgeTimer = null;
  let lastPos = startPos;
  let stuckStrikes = 0;
  let unsticking = false;
  let resetThrashCount = 0;
  let partialStallCount = 0;
  let noPathDetected = false;
  let noPathReason = "";

  const computeMoved = () => {
    const endPos = posTuple(bot.entity?.position);
    return startPos && endPos ? dist3d(startPos, endPos) : 0;
  };

  let resolveRun;
  const runPromise = new Promise((resolve) => {
    resolveRun = resolve;
  });

  const finish = (result, { clearGoal = true } = {}) => {
    if (settled) return;
    settled = true;
    cleanup({ clearGoal });
    resolveRun({
      movedBlocks: computeMoved(),
      profile,
      ...result,
    });
  };

  const triggerMicroNudge = () => {
    try {
      bot.setControlState?.("jump", true);
      if (nudgeTimer) clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => {
        nudgeTimer = null;
        try {
          bot.setControlState?.("jump", false);
        } catch {
          // Ignore jump release errors
        }
      }, 220);
      if (typeof nudgeTimer.unref === "function") nudgeTimer.unref();
    } catch {
      // Ignore micro-nudge errors
    }
  };

  const onAbort = () => {
    finish({ ok: false, aborted: true, reason: "mc_goal_cancelled" });
  };

  const onGoalReached = () => {
    finish({ ok: true, reason: "goal_reached" }, { clearGoal: false });
  };

  const onPathStop = () => {
    if (signal?.aborted) {
      finish({ ok: false, aborted: true, reason: "mc_goal_cancelled" }, { clearGoal: false });
    } else {
      finish({ ok: false, reason: "path_stopped" }, { clearGoal: false });
    }
  };

  const onGoalUpdated = (newGoal) => {
    if (newGoal !== goal) {
      finish(
        {
          ok: false,
          aborted: Boolean(signal?.aborted),
          reason: signal?.aborted ? "mc_goal_cancelled" : "goal_changed",
        },
        { clearGoal: false },
      );
    }
  };

  const onPathReset = (reason) => {
    if (settled) return;
    const r = String(reason || "");
    if (r === "dig_error" || r === "place_error" || r === "no_scaffolding_blocks") {
      resetThrashCount += 1;
      if (resetThrashCount >= maxResetThrash) {
        finish({ ok: false, reason: "path_thrashing" });
      }
    }
  };

  const onPathUpdate = (results) => {
    if (settled || !results || typeof results !== "object") return;
    const status = String(results.status || "");
    const len = Array.isArray(results.path) ? results.path.length : -1;

    if (status === "noPath" || status === "timeout") {
      if (isAlreadyAtGoal(bot, goal)) {
        if (hasLiveEventDriver) {
          finish({ ok: true, reason: "goal_reached" });
        }
        return;
      }
      const errReason = status === "timeout" ? "path_timeout" : "no_path";
      noPathDetected = true;
      noPathReason = errReason;
      if (hasLiveEventDriver) {
        finish({ ok: false, reason: errReason });
      }
      return;
    }

    if (status === "success" && len === 0 && hasLiveEventDriver && isAlreadyAtGoal(bot, goal)) {
      finish({ ok: true, reason: "goal_reached" });
      return;
    }

    if (status === "partial") {
      const cur = posTuple(bot.entity?.position);
      const moved = lastPos && cur ? dist3d(lastPos, cur) : 0;
      if (moved < 0.25) {
        partialStallCount += 1;
        if (hasLiveEventDriver && partialStallCount >= maxPartialStall) {
          finish({ ok: false, reason: "path_partial_stall" });
        }
      } else {
        partialStallCount = 0;
      }
    } else if (status === "success") {
      partialStallCount = 0;
    }
  };

  const cleanup = ({ clearGoal = true } = {}) => {
    signal?.removeEventListener?.("abort", onAbort);
    bot.removeListener?.("path_update", onPathUpdate);
    if (hasLiveEventDriver) {
      bot.removeListener?.("goal_reached", onGoalReached);
      bot.removeListener?.("path_stop", onPathStop);
      bot.removeListener?.("goal_updated", onGoalUpdated);
      bot.removeListener?.("path_reset", onPathReset);
    }
    if (stuckTimer) {
      clearInterval(stuckTimer);
      stuckTimer = null;
    }
    if (nudgeTimer) {
      clearTimeout(nudgeTimer);
      nudgeTimer = null;
    }
    if (clearGoal) {
      stopPathfinderSafe(bot);
    }
    clearBotControlStates(bot);
  };

  signal?.addEventListener?.("abort", onAbort, { once: true });
  bot.on?.("path_update", onPathUpdate);

  if (stuckCheckIntervalMs > 0 && startPos) {
    stuckTimer = setInterval(() => {
      if (settled || signal?.aborted || unsticking) return;
      const curPos = posTuple(bot.entity?.position);
      if (!curPos) return;
      const moved = lastPos ? dist3d(lastPos, curPos) : 0;
      lastPos = curPos;
      if (moved >= 0.35) {
        stuckStrikes = 0;
        return;
      }
      stuckStrikes += 1;
      if (stuckStrikes === 1) {
        triggerMicroNudge();
        return;
      }
      if (stuckStrikes === 2 && typeof onStuckStrike === "function") {
        unsticking = true;
        void Promise.resolve(onStuckStrike(bot, signal))
          .catch(() => false)
          .finally(() => {
            unsticking = false;
            if (!settled && !signal?.aborted) {
              triggerMicroNudge();
            }
          });
        return;
      }
      finish({ ok: false, reason: "path_stuck" });
    }, stuckCheckIntervalMs);
    if (typeof stuckTimer.unref === "function") stuckTimer.unref();
  }

  if (hasLiveEventDriver) {
    bot.on("goal_reached", onGoalReached);
    bot.on("path_stop", onPathStop);
    bot.on("goal_updated", onGoalUpdated);
    bot.on("path_reset", onPathReset);
    try {
      bot.pathfinder.setGoal(goal, false);
    } catch (err) {
      finish({ ok: false, reason: "path_error", error: err });
    }
    return await runPromise;
  }

  // Mock/compatibility driver when `bot.pathfinder.goto` is provided without live `getPathTo`.
  Promise.resolve()
    .then(() => bot.pathfinder.goto(goal))
    .then(
      () => {
        if (settled) return;
        if (signal?.aborted) {
          finish({ ok: false, aborted: true, reason: "mc_goal_cancelled" }, { clearGoal: false });
          return;
        }
        if (noPathDetected) {
          finish({ ok: false, reason: noPathReason || "no_path" }, { clearGoal: false });
          return;
        }
        finish({ ok: true, reason: "goal_reached" }, { clearGoal: false });
      },
      (err) => {
        if (settled) return;
        if (signal?.aborted) {
          finish({ ok: false, aborted: true, reason: "mc_goal_cancelled" }, { clearGoal: false });
          return;
        }
        const reason =
          err?.code === "path_stuck"
            ? "path_stuck"
            : /timeout/i.test(String(err?.name || err?.message || ""))
              ? "path_timeout"
              : "no_path";
        finish({ ok: false, reason, error: err }, { clearGoal: false });
      },
    );

  return await runPromise;
}

/**
 * High-level tiered navigation engine:
 * Starts with `startProfile` (default `cruise_walk` for zero terrain change),
 * automatically escalates on `no_path`/`path_stuck` to `natural_traverse`
 * (Default-Deny natural soft terrain + player-build aura + safe scaffolding),
 * and optionally to `escape_rock` when carrying a pickaxe.
 */
export async function navigateToGoal(
  bot,
  goal,
  {
    signal = null,
    startProfile = MOVEMENT_PROFILES.CRUISE_WALK,
    escalate = true,
    escalateOnStuck = true,
    allowRockEscape = true,
    profileOpts = {},
    stuckCheckIntervalMs = 2_500,
    onStuckStrike = null,
    onBeforeEscalate = null,
    useEventDriver = null,
    restoreDefaultAfter = true,
  } = {},
) {
  if (!bot?.pathfinder) {
    throw new Error("pathfinder_unavailable");
  }
  const ladder = [startProfile];
  if (escalate) {
    if (startProfile === MOVEMENT_PROFILES.CRUISE_WALK) {
      ladder.push(MOVEMENT_PROFILES.NATURAL_TRAVERSE);
    }
    if (
      allowRockEscape &&
      (startProfile === MOVEMENT_PROFILES.CRUISE_WALK ||
        startProfile === MOVEMENT_PROFILES.NATURAL_TRAVERSE) &&
      hasPickaxeInInventory(bot)
    ) {
      ladder.push(MOVEMENT_PROFILES.ESCAPE_ROCK);
    }
  }

  let lastResult = { ok: false, reason: "no_path", movedBlocks: 0, profile: startProfile };
  let totalMoved = 0;
  const startPos = posTuple(bot.entity?.position);

  try {
    for (let idx = 0; idx < ladder.length; idx += 1) {
      if (signal?.aborted) {
        return {
          ok: false,
          aborted: true,
          reason: "mc_goal_cancelled",
          movedBlocks: totalMoved,
          profileUsed: ladder[idx],
          attempts: idx,
        };
      }
      const profile = ladder[idx];
      const res = await runSingleNavigation(bot, goal, {
        profile,
        profileOpts,
        signal,
        stuckCheckIntervalMs,
        onStuckStrike,
        useEventDriver,
      });
      const curPos = posTuple(bot.entity?.position);
      totalMoved = startPos && curPos ? dist3d(startPos, curPos) : Math.max(totalMoved, res.movedBlocks ?? 0);
      lastResult = res;

      if (res.ok || res.aborted || signal?.aborted) {
        return {
          ...res,
          movedBlocks: totalMoved,
          profileUsed: profile,
          attempts: idx + 1,
        };
      }

      const canEscalate =
        idx < ladder.length - 1 &&
        (res.reason === "no_path" ||
          res.reason === "path_timeout" ||
          res.reason === "path_partial_stall" ||
          res.reason === "path_thrashing" ||
          (escalateOnStuck && res.reason === "path_stuck"));
      if (!canEscalate) {
        break;
      }
      if (typeof onBeforeEscalate === "function") {
        try {
          await onBeforeEscalate({ fromProfile: profile, toProfile: ladder[idx + 1], result: res });
        } catch {
          // Best-effort escalation hook
        }
      }
    }

    return {
      ...lastResult,
      movedBlocks: totalMoved,
      profileUsed: lastResult.profile || startProfile,
      attempts: ladder.length,
    };
  } finally {
    const hasCustomBudget =
      profileOpts &&
      (profileOpts.thinkTimeout !== undefined || profileOpts.searchRadius !== undefined);
    if (
      restoreDefaultAfter &&
      (ladder.length > 1 || startProfile !== MOVEMENT_PROFILES.CRUISE_WALK || hasCustomBudget)
    ) {
      applyMovementProfile(bot, MOVEMENT_PROFILES.CRUISE_WALK);
    }
  }
}
