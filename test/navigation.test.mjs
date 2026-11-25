import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import vec3 from "vec3";
import pathfinderPkg from "mineflayer-pathfinder";
import { McRuntime } from "../src/behaviors.mjs";
import { loadConfig } from "../src/protocol.mjs";
import {
  HAZARD_AVOID_BLOCKS,
  MOVEMENT_PROFILES,
  applyMovementProfile,
  createMovementProfile,
  isNaturalRockBlock,
  isNaturalSoftBlock,
  isNearPlayerStructure,
  isPlayerBuildSignatureBlock,
  navigateToGoal,
  runSingleNavigation,
} from "../src/navigation.mjs";

const require = createRequire(import.meta.url);
const mcDataLoader = require("minecraft-data");
const PrismarineBlock = require("prismarine-block");
const AStar = require("mineflayer-pathfinder/lib/astar");
const Move = require("mineflayer-pathfinder/lib/move");

const { goals } = pathfinderPkg;
const { GoalNear } = goals;

/**
 * Build a real `minecraft-data("26.1")` + `prismarine-block` voxel world for
 * genuine `mineflayer-pathfinder` A* pathfinding verification (zero fake path mocks).
 */
function makeRealVoxelBot({
  pos = vec3(0.5, 64, 0.5),
  health = 20,
  items = [],
  blockFn = () => "air",
} = {}) {
  const registry = mcDataLoader("26.1");
  const Block = PrismarineBlock(registry);
  const bot = new EventEmitter();
  bot.version = "26.1";
  bot.registry = registry;
  bot.health = health;
  bot.food = 20;
  bot.game = { dimension: "overworld", minY: -64, height: 384 };
  bot.entity = { position: pos.clone(), onGround: true, effects: {} };
  bot.entities = {};

  const invItems = items.map((it) => {
    const def = registry.itemsByName[it.name];
    assert.ok(def, `unknown MC 26.1 item: ${it.name}`);
    return { name: def.name, type: def.id, count: it.count ?? 1, nbt: null };
  });
  bot.heldItem = invItems[0] || null;
  bot.inventory = {
    slots: new Array(46).fill(null),
    items: () => invItems.slice(),
  };

  const blockCache = new Map();
  bot.blockAt = (p) => {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);
    const key = `${x},${y},${z}`;
    if (!blockCache.has(key)) {
      const name = blockFn(x, y, z) || "air";
      const def = registry.blocksByName[name];
      assert.ok(def, `unknown MC 26.1 block: ${name}`);
      const blk = Block.fromStateId(def.defaultState, 0);
      blk.position = vec3(x, y, z);
      blockCache.set(key, blk);
    }
    // Return a fresh clone so Movements.getBlock mutations never leak across runs
    const cached = blockCache.get(key);
    const clone = Block.fromStateId(cached.stateId, 0);
    clone.position = vec3(x, y, z);
    return clone;
  };

  bot.pathfinder = {
    bestHarvestTool: (block) => {
      let fastest = Number.MAX_VALUE;
      let best = null;
      for (const tool of invItems) {
        const dt = block.digTime(tool.type, false, false, false, [], {});
        if (dt < fastest) {
          fastest = dt;
          best = tool;
        }
      }
      return best;
    },
    setMovements: () => {},
    setGoal: () => {},
    stop: () => {},
  };

  return bot;
}

function solveRealAStar(bot, movements, goal, timeoutMs = 4000) {
  const p = bot.entity.position.floored();
  const start = new Move(p.x, p.y, p.z, movements.countScaffoldingItems(), 0);
  const astar = new AStar(start, movements, goal, timeoutMs, timeoutMs, 48);
  return astar.compute();
}

test("Real A* Sandbox 1: reproduces live (5,76,-3) 1-high grass-roofed crawlspace and escapes cleanly under natural_traverse", () => {
  // Exact 3D voxel geometry dumped from overworld r.0.-1.mca around (5, 76, -3):
  // y <= 75: grass_block / dirt
  // y = 76:  crawlspace cavity at (4..6, 76, -4..-2) -> air, outer dirt
  // y = 77:  (5, 77, -3) = air, surrounding ring = dirt (head-blocked on all 4 sides)
  // y = 78:  solid grass_block ceiling over the crawlspace
  // y >= 79: open sky air
  const crawlspaceBot = makeRealVoxelBot({
    pos: vec3(5.5, 76, -2.5),
    items: [{ name: "dirt", count: 30 }],
    blockFn: (x, y, z) => {
      if (y <= 74) return "stone";
      if (y === 75) return "grass_block";
      if (y === 76) {
        if (x >= 4 && x <= 6 && z >= -4 && z <= -2) return "air";
        return "dirt";
      }
      if (y === 77) {
        if (x === 5 && z === -3) return "air";
        return "dirt";
      }
      if (y === 78) return "grass_block";
      return "air";
    },
  });

  const surfaceGoal = new GoalNear(9, 79, -3, 1);

  // 1. cruise_walk (canDig=false) reproduces the exact live noPath trap
  const cruiseMoves = createMovementProfile(crawlspaceBot, MOVEMENT_PROFILES.CRUISE_WALK);
  const cruiseRes = solveRealAStar(crawlspaceBot, cruiseMoves, surfaceGoal);
  assert.equal(cruiseRes.status, "noPath");

  // 2. natural_traverse (Default-Deny natural soft terrain + safe scaffold) solves 3D escape!
  const natMoves = createMovementProfile(crawlspaceBot, MOVEMENT_PROFILES.NATURAL_TRAVERSE);
  const natRes = solveRealAStar(crawlspaceBot, natMoves, surfaceGoal);
  assert.equal(natRes.status, "success");
  assert.ok(natRes.path.length > 0);
  const lastNode = natRes.path[natRes.path.length - 1];
  assert.ok(lastNode.y >= 79, `expected bot to climb out to y>=79, got y=${lastNode.y}`);

  // Every broken block along the planned A* escape must be strictly a natural soft block
  const brokenNames = [];
  for (const step of natRes.path) {
    for (const bpos of step.toBreak || []) {
      const blk = crawlspaceBot.blockAt(bpos);
      brokenNames.push(blk.name);
      assert.ok(
        isNaturalSoftBlock(blk.name),
        `natural_traverse tried to break non-natural block: ${blk.name}`,
      );
    }
  }
  assert.ok(brokenNames.length > 0, "expected natural_traverse to dig through natural dirt/grass cap");
});

test("Real A* Sandbox 2: Zero-Griefing player wooden house & 1-block player-build aura block ALL breaking", () => {
  // Closed 3x3 wooden house at x=0..2, z=0..2, y=64..66, with dirt roof cap touching oak_planks walls
  // and a chest inside. Bot stands inside at (1.5, 64, 1.5) with a diamond_pickaxe!
  const houseBot = makeRealVoxelBot({
    pos: vec3(1.5, 64, 1.5),
    items: [
      { name: "diamond_pickaxe", count: 1 },
      { name: "dirt", count: 32 },
    ],
    blockFn: (x, y, z) => {
      if (y <= 63) return "grass_block";
      const onWall =
        ((x === 0 || x === 2) && z >= 0 && z <= 2) ||
        ((z === 0 || z === 2) && x >= 0 && x <= 2);
      if (y >= 64 && y <= 66 && onWall) {
        if (y === 65 && x === 0 && z === 1) return "glass";
        return "oak_planks";
      }
      if (y === 64 && x === 1 && z === 2) return "chest";
      // Even a dirt roof sitting on top of oak_planks is protected by the 1-block player-build aura!
      if (y === 67 && x >= 0 && x <= 2 && z >= 0 && z <= 2) return "dirt";
      return "air";
    },
  });

  const outsideGoal = new GoalNear(6, 64, 1, 1);

  for (const profile of [MOVEMENT_PROFILES.NATURAL_TRAVERSE, MOVEMENT_PROFILES.ESCAPE_ROCK]) {
    const moves = createMovementProfile(houseBot, profile);
    const res = solveRealAStar(houseBot, moves, outsideGoal);
    assert.equal(
      res.status,
      "noPath",
      `profile ${profile} must NEVER break out of a player wooden house or its adjacent dirt roof`,
    );
  }

  // Verify direct taxonomy & aura helpers
  assert.equal(isPlayerBuildSignatureBlock("oak_planks"), true);
  assert.equal(isPlayerBuildSignatureBlock("cobblestone"), true);
  assert.equal(isPlayerBuildSignatureBlock("chest"), true);
  assert.equal(isPlayerBuildSignatureBlock("glass"), true);
  assert.equal(isPlayerBuildSignatureBlock("dirt"), false);
  assert.equal(isNearPlayerStructure(houseBot, vec3(1, 67, 1)), true); // touches oak_planks walls
  assert.equal(isNearPlayerStructure(houseBot, vec3(10, 64, 10)), false); // open wilderness
});

test("Real A* Sandbox 3: Baritone cost weighting avoids digging or placing in open plains", () => {
  // Open grass plain with a small 2-block-tall dirt pillar at (4, 64..65, 0) between start and goal
  const plainsBot = makeRealVoxelBot({
    pos: vec3(0.5, 64, 0.5),
    items: [{ name: "dirt", count: 32 }],
    blockFn: (x, y, z) => {
      if (y <= 63) return "grass_block";
      if (x === 4 && z === 0 && (y === 64 || y === 65)) return "dirt";
      return "air";
    },
  });

  const moves = createMovementProfile(plainsBot, MOVEMENT_PROFILES.NATURAL_TRAVERSE);
  const res = solveRealAStar(plainsBot, moves, new GoalNear(8, 64, 0, 1));
  assert.equal(res.status, "success");

  let totalBreaks = 0;
  let totalPlaces = 0;
  for (const step of res.path) {
    totalBreaks += (step.toBreak || []).length;
    totalPlaces += (step.toPlace || []).length;
  }
  assert.equal(totalBreaks, 0, "A* should walk around a small dirt mound rather than digging it");
  assert.equal(totalPlaces, 0, "A* should not place scaffold blocks on open plains");
});

test("Real A* Sandbox 4: escape_rock requires pickaxe, breaks only raw stone (never cobblestone), respects water/hazards", () => {
  const stonePitBlockFn = (x, y, z) => {
    if (y <= 63) return "stone";
    if (y >= 64 && y <= 66) {
      if (x === 0 && z === 0) return "air";
      if (Math.abs(x) <= 2 && Math.abs(z) <= 2) return "stone";
    }
    return "air";
  };

  // Barehand bot: escape_rock refuses to punch stone
  const bareBot = makeRealVoxelBot({
    pos: vec3(0.5, 64, 0.5),
    items: [{ name: "dirt", count: 16 }],
    blockFn: stonePitBlockFn,
  });
  const bareRockMoves = createMovementProfile(bareBot, MOVEMENT_PROFILES.ESCAPE_ROCK);
  const stoneId = bareBot.registry.blocksByName.stone.id;
  const cobbleId = bareBot.registry.blocksByName.cobblestone.id;
  assert.equal(bareRockMoves.blocksCantBreak.has(stoneId), true);
  assert.equal(bareRockMoves.blocksCantBreak.has(cobbleId), true);

  // Pickaxe bot: escape_rock allows raw stone, STILL forbids cobblestone, and climbs out of stone pit
  const pickBot = makeRealVoxelBot({
    pos: vec3(0.5, 64, 0.5),
    items: [
      { name: "wooden_pickaxe", count: 1 },
      { name: "dirt", count: 16 },
    ],
    blockFn: stonePitBlockFn,
  });
  const pickRockMoves = createMovementProfile(pickBot, MOVEMENT_PROFILES.ESCAPE_ROCK);
  assert.equal(pickRockMoves.blocksCantBreak.has(stoneId), false);
  assert.equal(pickRockMoves.blocksCantBreak.has(cobbleId), true);
  assert.equal(isNaturalRockBlock("stone"), true);
  assert.equal(isNaturalRockBlock("cobblestone"), false);

  const escapeRes = solveRealAStar(pickBot, pickRockMoves, new GoalNear(5, 64, 0, 1));
  assert.equal(escapeRes.status, "success");

  // Hazard avoidance blocks & no-flow water protection
  for (const hName of ["lava", "fire", "magma_block", "cactus", "sweet_berry_bush", "powder_snow"]) {
    assert.ok(HAZARD_AVOID_BLOCKS.has(hName));
    const hDef = pickBot.registry.blocksByName[hName];
    if (hDef) {
      assert.equal(pickRockMoves.blocksToAvoid.has(hDef.id), true, `should avoid ${hName}`);
    }
  }

  const waterWallBot = makeRealVoxelBot({
    pos: vec3(0.5, 64, 0.5),
    blockFn: (x, y, z) => {
      if (y <= 63) return "stone";
      if (x === 1 && y === 64 && z === 0) return "dirt";
      if (x === 2 && y === 64 && z === 0) return "water";
      return "air";
    },
  });
  const waterMoves = createMovementProfile(waterWallBot, MOVEMENT_PROFILES.NATURAL_TRAVERSE);
  const dirtNextToWater = waterMoves.getBlock(vec3(0, 64, 0), 1, 0, 0);
  assert.equal(waterMoves.safeToBreak(dirtNextToWater), false);
});

test("Event-driven navigateToGoal: rejects silent noPath, auto-escalates cruise_walk -> natural_traverse, handles thrash/abort & clears controls", async () => {
  const bot = new EventEmitter();
  bot.entity = { position: vec3(5.5, 76, -2.5) };
  bot.health = 20;
  bot.inventory = { items: () => [] };
  const appliedProfiles = [];
  const clearedControls = [];
  let clearAllCount = 0;

  bot.clearControlStates = () => {
    clearAllCount += 1;
  };
  bot.setControlState = (ctrl, val) => {
    clearedControls.push({ ctrl, val });
  };
  bot.setSprinting = () => {};

  let currentProfile = "";
  bot.pathfinder = {
    getPathTo: () => ({ status: "noPath", path: [] }),
    setMovements: (m) => {
      currentProfile = m.profileName;
      appliedProfiles.push(m.profileName);
    },
    stop: () => {},
    setGoal: (goal) => {
      if (!goal) return;
      queueMicrotask(() => {
        if (currentProfile === MOVEMENT_PROFILES.CRUISE_WALK) {
          // Exact upstream bug scenario: status='noPath' with path.length===0
          bot.emit("path_update", { status: "noPath", path: [] });
          return;
        }
        if (currentProfile === MOVEMENT_PROFILES.NATURAL_TRAVERSE) {
          bot.entity.position = vec3(9.5, 79, -2.5);
          bot.emit("goal_reached", goal);
        }
      });
    },
  };

  const navRes = await navigateToGoal(bot, new GoalNear(9, 79, -3, 1), {
    stuckCheckIntervalMs: 0,
  });
  assert.equal(navRes.ok, true);
  assert.equal(navRes.profileUsed, MOVEMENT_PROFILES.NATURAL_TRAVERSE);
  assert.equal(navRes.attempts, 2);
  assert.ok(navRes.movedBlocks >= 4);
  assert.deepEqual(appliedProfiles, [
    MOVEMENT_PROFILES.CRUISE_WALK,
    MOVEMENT_PROFILES.NATURAL_TRAVERSE,
    MOVEMENT_PROFILES.CRUISE_WALK, // Restored clean default in finally
  ]);
  assert.ok(clearAllCount >= 1);

  // Thrashing protection: repeated dig_error path_reset aborts cleanly instead of looping forever
  const thrashBot = new EventEmitter();
  thrashBot.entity = { position: vec3(0, 64, 0) };
  thrashBot.inventory = { items: () => [] };
  let thrashCleared = 0;
  thrashBot.clearControlStates = () => {
    thrashCleared += 1;
  };
  thrashBot.pathfinder = {
    getPathTo: () => ({ status: "success", path: [] }),
    setMovements: () => {},
    stop: () => {},
    setGoal: (goal) => {
      if (!goal) return;
      queueMicrotask(() => {
        for (let i = 0; i < 6; i += 1) {
          thrashBot.emit("path_reset", "dig_error");
        }
      });
    },
  };
  const thrashRes = await runSingleNavigation(thrashBot, new GoalNear(10, 64, 0, 1), {
    profile: MOVEMENT_PROFILES.NATURAL_TRAVERSE,
    stuckCheckIntervalMs: 0,
    maxResetThrash: 4,
  });
  assert.equal(thrashRes.ok, false);
  assert.equal(thrashRes.reason, "path_thrashing");
  assert.ok(thrashCleared >= 1);

  // AbortSignal immediately stops & clears control states
  const ctrl = new AbortController();
  const abortBot = new EventEmitter();
  abortBot.entity = { position: vec3(0, 64, 0) };
  abortBot.inventory = { items: () => [] };
  let abortCleared = 0;
  abortBot.clearControlStates = () => {
    abortCleared += 1;
  };
  abortBot.pathfinder = {
    getPathTo: () => ({ status: "partial", path: [] }),
    setMovements: () => {},
    stop: () => {},
    setGoal: (goal) => {
      if (!goal) return;
      setTimeout(() => ctrl.abort(), 10);
    },
  };
  const abortRes = await navigateToGoal(abortBot, new GoalNear(20, 64, 0, 1), {
    signal: ctrl.signal,
    stuckCheckIntervalMs: 0,
  });
  assert.equal(abortRes.ok, false);
  assert.equal(abortRes.aborted, true);
  assert.equal(abortRes.reason, "mc_goal_cancelled");
  assert.ok(abortCleared >= 1);

  // applyMovementProfile combat_nodig strictly forbids dig & scaffold
  const combatMoves = applyMovementProfile(bot, MOVEMENT_PROFILES.COMBAT_NODIG);
  assert.equal(combatMoves.canDig, false);
  assert.equal(combatMoves.allow1by1towers, false);
  assert.deepEqual(combatMoves.scafoldingBlocks, []);
});

function makeRuntimeConfig(overrides = {}) {
  return loadConfig({
    MC_BRIDGE_TOKEN: "test-token-for-navigation-12345678",
    MC_ENABLED: "true",
    MC_HOST: "127.0.0.1",
    MC_PORT: "25565",
    MC_USERNAME: "HakimiBot",
    MC_ALLOWED_PLAYERS: "BOISER",
    MC_ALLOW_CHAT: "true",
    ...overrides,
  });
}

function makeLightRuntimeBot({ pos = vec3(0, 64, 0), items = [], blockFn = null } = {}) {
  const bot = new EventEmitter();
  bot.username = "HakimiBot";
  bot.health = 20;
  bot.food = 20;
  bot.game = { dimension: "overworld" };
  bot.time = { timeOfDay: 14000 };
  bot.entity = { id: 0, position: pos.clone(), onGround: true, effects: {} };
  bot.entities = { 0: bot.entity };
  bot.players = {};
  bot.heldItem = items[0] ?? null;
  bot.registry = {
    blocksByName: {
      air: { id: 0, name: "air" },
      stone: { id: 1, name: "stone" },
      dirt: { id: 3, name: "dirt" },
      water: { id: 9, name: "water" },
    },
  };
  bot.inventory = {
    items: () => items.slice(),
    emptySlotCount: () => Math.max(0, 36 - items.length),
  };
  bot.blockAt = (p) => {
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    const z = Math.floor(p.z);
    const name = blockFn ? blockFn(x, y, z) : y <= 63 ? "dirt" : "air";
    return {
      name,
      boundingBox: name === "air" || name === "water" ? "empty" : "block",
      position: vec3(x, y, z),
    };
  };
  bot.findBlocks = () => [];
  bot.dig = async () => {};
  bot.placeBlock = async () => {};
  bot.equip = async () => {};
  bot.lookAt = async () => {};
  bot.clearControlStates = () => {};
  bot.setControlState = () => {};
  bot.setSprinting = () => {};
  bot.pathfinder = {
    setMovements: () => {},
    setGoal: () => {},
    stop: () => {},
    goto: async () => {},
  };
  return bot;
}

test("v2.10.1: per-profile thinkTimeout & searchRadius are applied onto bot.pathfinder with bounded overrides", () => {
  const bot = makeRealVoxelBot({
    items: [{ name: "stone_pickaxe", count: 1 }],
  });

  const expected = [
    [MOVEMENT_PROFILES.COMBAT_NODIG, 1_200, 32],
    [MOVEMENT_PROFILES.CRUISE_WALK, 1_500, 48],
    [MOVEMENT_PROFILES.NATURAL_TRAVERSE, 2_200, 48],
    [MOVEMENT_PROFILES.ESCAPE_ROCK, 2_500, 40],
  ];
  for (const [profile, thinkTimeout, searchRadius] of expected) {
    const moves = applyMovementProfile(bot, profile);
    assert.equal(moves.thinkTimeout, thinkTimeout, `${profile} movements.thinkTimeout`);
    assert.equal(moves.searchRadius, searchRadius, `${profile} movements.searchRadius`);
    assert.equal(bot.pathfinder.thinkTimeout, thinkTimeout, `${profile} pathfinder.thinkTimeout`);
    assert.equal(bot.pathfinder.searchRadius, searchRadius, `${profile} pathfinder.searchRadius`);
  }

  // Custom tight budget overrides and clamping bounds
  const tight = applyMovementProfile(bot, MOVEMENT_PROFILES.CRUISE_WALK, {
    thinkTimeout: 1_000,
    searchRadius: 16,
  });
  assert.equal(tight.thinkTimeout, 1_000);
  assert.equal(tight.searchRadius, 16);
  assert.equal(bot.pathfinder.thinkTimeout, 1_000);
  assert.equal(bot.pathfinder.searchRadius, 16);

  const clamped = applyMovementProfile(bot, MOVEMENT_PROFILES.CRUISE_WALK, {
    thinkTimeout: 50,
    searchRadius: 999,
  });
  assert.equal(clamped.thinkTimeout, 200);
  assert.equal(clamped.searchRadius, 96);
  assert.equal(bot.pathfinder.thinkTimeout, 200);
  assert.equal(bot.pathfinder.searchRadius, 96);
});

test("v2.10.1: explore timeout preserves real partial displacement (>=2.5 blocks) and fails on zero progress", async () => {
  // 1. Timed out after moving 6 blocks horizontally -> partial success
  const movingBot = makeLightRuntimeBot({ pos: vec3(0, 64, 0) });
  movingBot.pathfinder.goto = async () => {
    setTimeout(() => {
      movingBot.entity.position = vec3(6, 64, 0);
    }, 15);
    await new Promise(() => {});
  };
  const movingRt = new McRuntime({
    config: makeRuntimeConfig(),
    createBotFn: () => movingBot,
    actionTimeoutMs: 120,
    stuckCheckIntervalMs: 5_000,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  try {
    movingRt.connectBot();
    movingBot.emit("spawn");
    const res = await movingRt.dispatchGoal({ action_type: "explore", timeout_ms: 120 });
    assert.equal(res.ok, true);
    assert.equal(res.partial, true);
    assert.equal(res.moved_blocks, 6);
    assert.match(res.summary, /探索推进至\(6,0\).*移动6格\(时间上限\)/);
  } finally {
    movingRt.stop();
  }

  // 2. Timed out with zero movement -> still fails as mc_goal_timeout
  const stuckBot = makeLightRuntimeBot({ pos: vec3(0, 64, 0) });
  stuckBot.pathfinder.goto = async () => {
    await new Promise(() => {});
  };
  const stuckRt = new McRuntime({
    config: makeRuntimeConfig(),
    createBotFn: () => stuckBot,
    actionTimeoutMs: 120,
    stuckCheckIntervalMs: 5_000,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  try {
    stuckRt.connectBot();
    stuckBot.emit("spawn");
    const res = await stuckRt.dispatchGoal({ action_type: "explore", timeout_ms: 120 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "mc_goal_timeout");
    assert.equal(res.moved_blocks, 0);
  } finally {
    stuckRt.stop();
  }
});

test("v2.10.1: goto timeout preserves forward progress and rejects stationary or wrong-way timeouts", async () => {
  async function runGotoCase(moveToPos) {
    const bot = makeLightRuntimeBot({ pos: vec3(0, 64, 0) });
    bot.pathfinder.goto = async () => {
      if (moveToPos) {
        setTimeout(() => {
          bot.entity.position = moveToPos.clone();
        }, 15);
      }
      await new Promise(() => {});
    };
    const rt = new McRuntime({
      config: makeRuntimeConfig(),
      createBotFn: () => bot,
      actionTimeoutMs: 120,
      stuckCheckIntervalMs: 5_000,
      snapshotIntervalMs: 60_000,
      survivalTickMs: 60_000,
      companionTickMs: 60_000,
    });
    try {
      rt.connectBot();
      bot.emit("spawn");
      return await rt.dispatchGoal({ action_type: "goto", x: 20, y: 64, z: 0, timeout_ms: 120 });
    } finally {
      rt.stop();
    }
  }

  // Forward progress (+6 blocks closer to (20,64,0)) -> partial ok
  const forwardRes = await runGotoCase(vec3(6, 64, 0));
  assert.equal(forwardRes.ok, true);
  assert.equal(forwardRes.partial, true);
  assert.equal(forwardRes.moved_blocks, 6);

  // Near destination (within 4.5 blocks of (20,64,0)) -> full ok (partial=false)
  const nearRes = await runGotoCase(vec3(17, 64, 0));
  assert.equal(nearRes.ok, true);
  assert.equal(nearRes.partial, false);
  assert.equal(nearRes.moved_blocks, 17);

  // Wrong-way displacement (-6 blocks away) -> rejected as timeout
  const awayRes = await runGotoCase(vec3(-6, 64, 0));
  assert.equal(awayRes.ok, false);
  assert.equal(awayRes.reason, "mc_goal_timeout");
  assert.equal(awayRes.moved_blocks, 6);

  // Stationary -> rejected as timeout
  const idleRes = await runGotoCase(null);
  assert.equal(idleRes.ok, false);
  assert.equal(idleRes.reason, "mc_goal_timeout");
  assert.equal(idleRes.moved_blocks, 0);
});

test("v2.10.1: shelter enter spot probing uses tight cruise_walk without 3-tier escalation and restores defaults", async () => {
  // Standing at (0,64,0) above water (cannot dig shaft here), while (2,64,0) has 3-deep dirt over stone
  const bot = makeLightRuntimeBot({
    pos: vec3(0, 64, 0),
    items: [
      { name: "stone_pickaxe", type: 274, count: 1 },
      { name: "dirt", type: 3, count: 6 },
    ],
    blockFn: (x, y, z) => {
      if (x === 0 && z === 0 && y === 63) return "water";
      if (y <= 60) return "stone";
      if (y <= 63) return "dirt";
      return "air";
    },
  });

  const movementTrace = [];
  bot.pathfinder = {
    getPathTo: () => ({ status: "noPath", path: [] }),
    setMovements: (m) => {
      movementTrace.push({
        profile: m.profileName,
        thinkTimeout: bot.pathfinder.thinkTimeout,
        searchRadius: bot.pathfinder.searchRadius,
      });
    },
    stop: () => {},
    setGoal: (goal) => {
      if (!goal) return;
      queueMicrotask(() => {
        bot.emit("path_update", { status: "noPath", path: [] });
      });
    },
  };

  const rt = new McRuntime({
    config: makeRuntimeConfig(),
    createBotFn: () => bot,
    stuckCheckIntervalMs: 5_000,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  try {
    rt.connectBot();
    bot.emit("spawn");
    movementTrace.length = 0;

    const res = await rt.dispatchGoal({ action_type: "shelter", mode: "enter" });
    assert.equal(res.ok, false);
    assert.ok(movementTrace.length >= 2, `expected shelter probe + restore, got ${movementTrace.length}`);
    // Never escalated to natural_traverse or escape_rock even while holding stone_pickaxe
    for (const entry of movementTrace) {
      assert.equal(entry.profile, MOVEMENT_PROFILES.CRUISE_WALK);
    }
    // Probing calls used the tight 1000ms / 16-block budget
    assert.equal(movementTrace[0].thinkTimeout, 1_000);
    assert.equal(movementTrace[0].searchRadius, 16);
    // Final restore reset bot.pathfinder back to standard cruise_walk defaults
    assert.equal(bot.pathfinder.thinkTimeout, 1_500);
    assert.equal(bot.pathfinder.searchRadius, 48);
  } finally {
    rt.stop();
  }
});
