import test from "node:test";
import assert from "node:assert/strict";
import EventEmitter from "node:events";
import vec3 from "vec3";

import { McRuntime } from "../src/behaviors.mjs";
import { loadConfig } from "../src/protocol.mjs";
import {
  UnreachableBlockBlacklist,
  createAutoTorchState,
  detectEnvironmentalHazard,
  tryAutoPlaceTorch,
} from "../src/survival.mjs";
import { createCombatState, updateEvadeShieldDefense } from "../src/combat.mjs";
import { executeAcquireAction, parseAcquireParams } from "../src/acquire.mjs";

function makeConfig(overrides = {}) {
  return loadConfig({
    MC_BRIDGE_TOKEN: "test-token-for-acquire-reflex-12345678",
    MC_ENABLED: "true",
    MC_HOST: "127.0.0.1",
    MC_PORT: "25565",
    MC_USERNAME: "HakimiBot",
    MC_ALLOWED_PLAYERS: "BOISER",
    MC_ALLOW_CHAT: "true",
    ...overrides,
  });
}

function makeRichCraftBot({
  pos = vec3(0, 64, 0),
  initialItems = [],
  blocks = new Map(),
  entities = {},
  health = 20,
  food = 20,
  offHandItem = null,
} = {}) {
  const bot = new EventEmitter();
  bot.username = "HakimiBot";
  bot.health = health;
  bot.food = food;
  bot.game = { dimension: "overworld" };
  bot.time = { timeOfDay: 4000 };
  bot.entity = { id: 0, position: pos.clone ? pos.clone() : vec3(pos.x, pos.y, pos.z), equipment: [] };
  bot.entities = { 0: bot.entity, ...entities };
  bot.players = {};

  const itemsByName = {
    oak_log: { id: 17, name: "oak_log" },
    birch_log: { id: 18, name: "birch_log" },
    oak_planks: { id: 5, name: "oak_planks" },
    birch_planks: { id: 6, name: "birch_planks" },
    stick: { id: 280, name: "stick" },
    crafting_table: { id: 58, name: "crafting_table" },
    wooden_pickaxe: { id: 270, name: "wooden_pickaxe" },
    stone_pickaxe: { id: 274, name: "stone_pickaxe" },
    cobblestone: { id: 4, name: "cobblestone" },
    furnace: { id: 61, name: "furnace" },
    coal: { id: 263, name: "coal" },
    raw_iron: { id: 264, name: "raw_iron" },
    iron_ingot: { id: 265, name: "iron_ingot" },
    shield: { id: 442, name: "shield" },
    torch: { id: 50, name: "torch" },
  };
  const itemsById = Object.fromEntries(Object.values(itemsByName).map((it) => [it.id, it]));
  bot.registry = {
    itemsByName,
    items: itemsById,
    blocksByName: {
      air: { id: 0, name: "air" },
      dirt: { id: 3, name: "dirt" },
      stone: { id: 1, name: "stone" },
      cobblestone: { id: 4, name: "cobblestone" },
      oak_log: { id: 17, name: "oak_log" },
      birch_log: { id: 18, name: "birch_log" },
      coal_ore: { id: 16, name: "coal_ore" },
      iron_ore: { id: 15, name: "iron_ore" },
      crafting_table: { id: 58, name: "crafting_table" },
      furnace: { id: 61, name: "furnace" },
      torch: { id: 50, name: "torch" },
    },
  };

  // Mutable inventory map
  const invMap = new Map();
  for (const it of initialItems) {
    invMap.set(it.name, (invMap.get(it.name) ?? 0) + (it.count ?? 1));
  }

  const invSlots = new Array(46).fill(null);
  if (offHandItem) {
    invSlots[45] = { ...offHandItem };
  }
  const toInvArray = () =>
    Array.from(invMap.entries())
      .filter(([, cnt]) => cnt > 0)
      .map(([name, count]) => ({
        name,
        type: itemsByName[name]?.id ?? 999,
        count,
      }));

  bot.heldItem = toInvArray()[0] ?? null;
  bot.quickBarSlot = 0;
  bot.inventory = {
    slots: invSlots,
    items: () => toInvArray(),
    emptySlotCount: () => Math.max(0, 36 - toInvArray().length),
  };
  bot.getEquipmentDestSlot = (dest) => (dest === "off-hand" ? 45 : 36);
  bot._invMap = invMap;
  bot._placed = [];
  bot._dug = [];
  bot._activated = [];
  bot._deactivatedCount = 0;
  bot._controls = [];
  bot._sprinting = false;

  const consumeInv = (name, qty) => {
    const have = invMap.get(name) ?? 0;
    if (have < qty) throw new Error(`missing_${name}`);
    const rem = have - qty;
    if (rem === 0) invMap.delete(name);
    else invMap.set(name, rem);
  };
  const addInv = (name, qty) => {
    invMap.set(name, (invMap.get(name) ?? 0) + qty);
  };

  // Standard MC crafting recipes
  const RECIPES = {
    oak_planks: [{ requiresTable: false, result: { id: 5, count: 4 }, delta: [{ id: 17, name: "oak_log", count: -1 }, { id: 5, name: "oak_planks", count: 4 }] }],
    birch_planks: [{ requiresTable: false, result: { id: 6, count: 4 }, delta: [{ id: 18, name: "birch_log", count: -1 }, { id: 6, name: "birch_planks", count: 4 }] }],
    stick: [
      { requiresTable: false, result: { id: 280, count: 4 }, delta: [{ id: 5, name: "oak_planks", count: -2 }, { id: 280, name: "stick", count: 4 }] },
      { requiresTable: false, result: { id: 280, count: 4 }, delta: [{ id: 6, name: "birch_planks", count: -2 }, { id: 280, name: "stick", count: 4 }] },
    ],
    crafting_table: [
      { requiresTable: false, result: { id: 58, count: 1 }, delta: [{ id: 5, name: "oak_planks", count: -4 }, { id: 58, name: "crafting_table", count: 1 }] },
      { requiresTable: false, result: { id: 58, count: 1 }, delta: [{ id: 6, name: "birch_planks", count: -4 }, { id: 58, name: "crafting_table", count: 1 }] },
    ],
    wooden_pickaxe: [
      { requiresTable: true, result: { id: 270, count: 1 }, delta: [{ id: 5, name: "oak_planks", count: -3 }, { id: 280, name: "stick", count: -2 }, { id: 270, name: "wooden_pickaxe", count: 1 }] },
      { requiresTable: true, result: { id: 270, count: 1 }, delta: [{ id: 6, name: "birch_planks", count: -3 }, { id: 280, name: "stick", count: -2 }, { id: 270, name: "wooden_pickaxe", count: 1 }] },
    ],
    stone_pickaxe: [
      { requiresTable: true, result: { id: 274, count: 1 }, delta: [{ id: 4, name: "cobblestone", count: -3 }, { id: 280, name: "stick", count: -2 }, { id: 274, name: "stone_pickaxe", count: 1 }] },
    ],
    furnace: [
      { requiresTable: true, result: { id: 61, count: 1 }, delta: [{ id: 4, name: "cobblestone", count: -8 }, { id: 61, name: "furnace", count: 1 }] },
    ],
    shield: [
      { requiresTable: true, result: { id: 442, count: 1 }, delta: [{ id: 5, name: "oak_planks", count: -6 }, { id: 265, name: "iron_ingot", count: -1 }, { id: 442, name: "shield", count: 1 }] },
    ],
    torch: [
      { requiresTable: false, result: { id: 50, count: 4 }, delta: [{ id: 263, name: "coal", count: -1 }, { id: 280, name: "stick", count: -1 }, { id: 50, name: "torch", count: 4 }] },
    ],
  };

  const canCraftRecipe = (recipe, tableHint) => {
    if (recipe.requiresTable && !tableHint) return false;
    for (const d of recipe.delta) {
      if (d.count < 0 && (invMap.get(d.name) ?? 0) < -d.count) return false;
    }
    return true;
  };

  bot.recipesAll = (itemId, _meta, tableHint) => {
    const name = itemsById[itemId]?.name;
    const all = RECIPES[name] || [];
    return all.filter((r) => !r.requiresTable || Boolean(tableHint));
  };
  bot.recipesFor = (itemId, _meta, _minRes, tableHint) => {
    const name = itemsById[itemId]?.name;
    const all = RECIPES[name] || [];
    return all.filter((r) => canCraftRecipe(r, tableHint));
  };
  bot.craft = async (recipe, batches = 1, tableBlock = null) => {
    if (recipe.requiresTable && !tableBlock) throw new Error("needs_table");
    for (let i = 0; i < batches; i += 1) {
      for (const d of recipe.delta) {
        if (d.count < 0) consumeInv(d.name, -d.count);
      }
      for (const d of recipe.delta) {
        if (d.count > 0) addInv(d.name, d.count);
      }
    }
  };

  bot.equip = async (item, dest) => {
    if (dest === "hand") bot.heldItem = item;
    if (dest === "off-hand") {
      invSlots[45] = { ...item };
    }
  };
  bot.setQuickBarSlot = (slot) => {
    bot.quickBarSlot = slot;
  };
  bot.activateItem = (offHand = false) => {
    bot._activated.push(Boolean(offHand));
  };
  bot.deactivateItem = () => {
    bot._deactivatedCount += 1;
  };
  bot.setControlState = (control, state) => {
    bot._controls.push({ control, state });
  };
  bot.setSprinting = (val) => {
    bot._sprinting = Boolean(val);
  };
  bot.lookAt = async () => {};

  const blockKey = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  bot.blockAt = (p) => {
    const k = blockKey(p);
    if (blocks.has(k)) {
      const b = blocks.get(k);
      return { position: vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), ...b };
    }
    if (Math.floor(p.y) < 64) {
      return { name: "dirt", boundingBox: "block", position: vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) };
    }
    return { name: "air", boundingBox: "empty", position: vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) };
  };
  bot.findBlocks = ({ matching, maxDistance = 32, count = 16 }) => {
    const out = [];
    for (const [k, b] of blocks.entries()) {
      const [x, y, z] = k.split(",").map(Number);
      const dist = Math.hypot(x - bot.entity.position.x, y - bot.entity.position.y, z - bot.entity.position.z);
      if (dist > maxDistance) continue;
      if (matching(b)) {
        out.push(vec3(x, y, z));
        if (out.length >= count) break;
      }
    }
    return out;
  };
  bot.findBlock = ({ matching, maxDistance = 16 }) => {
    const hits = bot.findBlocks({ matching, maxDistance, count: 1 });
    return hits.length > 0 ? bot.blockAt(hits[0]) : null;
  };
  bot.placeBlock = async (refBlock, face) => {
    const tx = Math.floor(refBlock.position.x + face.x);
    const ty = Math.floor(refBlock.position.y + face.y);
    const tz = Math.floor(refBlock.position.z + face.z);
    const heldName = bot.heldItem?.name || "crafting_table";
    consumeInv(heldName, 1);
    blocks.set(`${tx},${ty},${tz}`, { name: heldName, boundingBox: "block" });
    bot._placed.push({ name: heldName, pos: [tx, ty, tz] });
  };
  bot.dig = async (blk) => {
    const k = blockKey(blk.position);
    blocks.delete(k);
    bot._dug.push({ name: blk.name, pos: [blk.position.x, blk.position.y, blk.position.z] });
    if (blk.name === "stone") addInv("cobblestone", 1);
    else if (blk.name === "iron_ore" || blk.name === "deepslate_iron_ore") addInv("raw_iron", 1);
    else if (blk.name === "coal_ore") addInv("coal", 1);
    else addInv(blk.name, 1);
  };
  bot.openFurnace = async () => {
    let inputCount = 0;
    let outName = "";
    let outCount = 0;
    return {
      outputItem: () => (outCount > 0 ? { name: outName, count: outCount } : null),
      inputItem: () => (inputCount > 0 ? { count: inputCount } : null),
      putFuel: async (typeId, _meta, count) => {
        const fuelName = itemsById[typeId]?.name;
        if (fuelName) consumeInv(fuelName, count);
      },
      putInput: async (typeId, _meta, count) => {
        const inName = itemsById[typeId]?.name;
        if (inName) consumeInv(inName, count);
        inputCount = 0;
        outName = inName === "raw_iron" ? "iron_ingot" : "charcoal";
        outCount = count;
      },
      takeOutput: async () => {
        const qty = outCount;
        outCount = 0;
        if (qty > 0 && outName) addInv(outName, qty);
        return { name: outName, count: qty };
      },
      close: () => {},
    };
  };
  bot.pathfinder = {
    setMovements: () => {},
    setGoal: () => {},
    stop: () => {},
    goto: async () => {},
  };
  return bot;
}

test("P1: UnreachableBlockBlacklist skips stubborn blocks across turns and expires after TTL", async () => {
  const bl = new UnreachableBlockBlacklist({ ttlMs: 10_000, maxEntries: 32 });
  assert.equal(bl.has([10, 64, 10], 1_000), false);
  bl.markColumn([10, 64, 10], { nowMs: 1_000 });
  assert.equal(bl.has([10, 64, 10], 5_000), true);
  assert.equal(bl.has([10, 66, 10], 5_000), true);
  assert.equal(bl.has([10, 64, 10], 11_001), false);

  let fakeNow = 100_000;
  const blocks = new Map([
    ["5,64,0", { name: "oak_log", boundingBox: "block" }],
    ["8,64,0", { name: "oak_log", boundingBox: "block" }],
  ]);
  const bot = makeRichCraftBot({ blocks });
  const gotoTargets = [];
  bot.pathfinder.goto = async (goal) => {
    gotoTargets.push(`${Math.floor(goal.x)},${Math.floor(goal.y)},${Math.floor(goal.z)}`);
    if (Math.floor(goal.x) === 5) {
      const err = new Error("path_stuck");
      err.code = "path_stuck";
      throw err;
    }
    bot.entity.position = vec3(goal.x, goal.y, goal.z);
  };

  const rt = new McRuntime({
    config: makeConfig(),
    createBotFn: () => bot,
    nowFn: () => fakeNow,
    unreachableBlockTtlMs: 60_000,
    pickupSettleMs: 0,
    stuckCheckIntervalMs: 0,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  rt.connectBot();
  bot.emit("spawn");

  // Turn 1: fails on (5,64,0) -> blacklists column (5,*,0) and harvests (8,64,0)
  const r1 = await rt.dispatchGoal({ action_type: "gather", block_type: "oak_log", count: 1 });
  assert.equal(r1.ok, true);
  assert.deepEqual([...new Set(gotoTargets)], ["5,64,0", "8,64,0"]);
  assert.equal(rt._unreachableBlocks.has([5, 64, 0], fakeNow), true);
  assert.ok(r1.snapshot.reflex_modes.includes("unstuck_blacklist"));

  // Turn 2: (5,64,0) is still the only oak_log left -> immediately skipped as all_candidates_unreachable without re-pathing!
  gotoTargets.length = 0;
  const r2 = await rt.dispatchGoal({ action_type: "gather", block_type: "oak_log", count: 1 });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "all_candidates_unreachable");
  assert.deepEqual(gotoTargets, []);
  // Also hidden from nearby_resources while blacklisted
  assert.equal(r2.snapshot.nearby_resources.includes("oak_log"), false);

  rt.stop();
});

test("P1: off-hand shield pulse defense raises against ranged mobs during evade and lowers for close melee", async () => {
  const combatState = createCombatState();
  const bot = makeRichCraftBot({
    offHandItem: { name: "shield", count: 1 },
    entities: {
      10: { id: 10, name: "skeleton", position: vec3(12, 64, 0) },
    },
  });

  // Start of cycle (t=0): raises shield against 12-block skeleton
  const s1 = updateEvadeShieldDefense({ bot, combatState, nowMs: 1_000 });
  assert.equal(s1.raised, true);
  assert.equal(combatState.shieldRaised, true);
  assert.deepEqual(bot._activated, [true]);

  // Mid-cycle sprint window (t=+1200ms): lowers shield so bot can sprint away
  const s2 = updateEvadeShieldDefense({ bot, combatState, nowMs: 2_200 });
  assert.equal(s2.raised, false);
  assert.equal(combatState.shieldRaised, false);

  // Immediately after taking damage: overrides sprint window and raises shield!
  combatState.lastDamageAtMs = 2_300;
  const s3 = updateEvadeShieldDefense({ bot, combatState, nowMs: 2_500 });
  assert.equal(s3.raised, true);
  assert.equal(s3.reason, "post_hit_block");

  // Close zombie within 4 blocks: must drop shield to sprint away
  bot.entities[11] = { id: 11, name: "zombie", position: vec3(4, 64, 0) };
  const s4 = updateEvadeShieldDefense({ bot, combatState, nowMs: 2_600 });
  assert.equal(s4.raised, false);
  assert.equal(s4.reason, "close_melee_sprint");

  // Integrated evade companionTick check
  delete bot.entities[11];
  let fakeNow = 10_000;
  const rt = new McRuntime({
    config: makeConfig({ MC_COMPANION_MODE: "true", MC_COMBAT_MODE: "evade" }),
    createBotFn: () => bot,
    nowFn: () => fakeNow,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  rt.connectBot();
  bot.emit("spawn");
  await rt._companionTick();
  assert.equal(rt.activity, "举盾躲避");
  const snap = rt.getSnapshot();
  assert.ok(snap.reflex_modes.includes("shield_ready"));
  assert.ok(snap.reflex_modes.includes("shield_raised"));
  rt.stop();
});

test("P1: auto-torch places torch in dark cave with spacing/cooldown and restores main hand", async () => {
  const blocks = new Map([
    ["0,64,0", { name: "air", boundingBox: "empty", light: 2, skyLight: 0 }],
    ["0,63,0", { name: "stone", boundingBox: "block" }],
  ]);
  const bot = makeRichCraftBot({
    initialItems: [
      { name: "stone_pickaxe", count: 1 },
      { name: "torch", count: 4 },
    ],
    blocks,
  });
  const torchState = createAutoTorchState();
  const r1 = await tryAutoPlaceTorch(bot, torchState, { nowMs: 10_000, timeOfDay: "day" });
  assert.equal(r1.placed, true);
  assert.deepEqual(r1.pos, [0, 64, 0]);
  assert.equal(bot.heldItem?.name, "stone_pickaxe");

  // Cooldown blocks immediate re-placement
  const r2 = await tryAutoPlaceTorch(bot, torchState, { nowMs: 12_000, timeOfDay: "day" });
  assert.equal(r2.placed, false);
  assert.equal(r2.reason, "cooldown");

  // Spacing blocks placement within 7 blocks even after cooldown
  bot.entity.position = vec3(3, 64, 0);
  blocks.set("3,64,0", { name: "air", boundingBox: "empty", light: 1, skyLight: 0 });
  blocks.set("3,63,0", { name: "stone", boundingBox: "block" });
  const r3 = await tryAutoPlaceTorch(bot, torchState, { nowMs: 25_000, timeOfDay: "day" });
  assert.equal(r3.placed, false);
  assert.equal(r3.reason, "too_close_to_last");

  // Bright area skips placement
  bot.entity.position = vec3(12, 64, 0);
  blocks.set("12,64,0", { name: "air", boundingBox: "empty", light: 12, skyLight: 15 });
  blocks.set("12,63,0", { name: "stone", boundingBox: "block" });
  const r4 = await tryAutoPlaceTorch(bot, torchState, { nowMs: 30_000, timeOfDay: "day" });
  assert.equal(r4.placed, false);
  assert.equal(r4.reason, "bright_enough");
});

test("P1: environmental hazard detection spots lava/fire and low oxygen", () => {
  const lavaBlocks = new Map([["0,64,0", { name: "lava", boundingBox: "empty" }]]);
  const lavaBot = makeRichCraftBot({ blocks: lavaBlocks });
  const h1 = detectEnvironmentalHazard(lavaBot);
  assert.equal(h1.hazard, "hazard_fire");
  assert.equal(h1.severity, 3);

  // Dry-land bot with polluted oxygenLevel (upstream mineflayer 4.39.0 entities.js bug) must NOT trigger hazard_water
  const dryLandBot = makeRichCraftBot();
  dryLandBot.oxygenLevel = 4;
  const hDry = detectEnvironmentalHazard(dryLandBot);
  assert.equal(hDry.hazard, "");

  // Submerged bot with low oxygen DOES trigger hazard_water
  const waterBot = makeRichCraftBot({
    blocks: new Map([
      ["0,64,0", { name: "water", boundingBox: "empty" }],
      ["0,65,0", { name: "water", boundingBox: "empty" }],
    ]),
  });
  waterBot.oxygenLevel = 4;
  const h2 = detectEnvironmentalHazard(waterBot);
  assert.equal(h2.hazard, "hazard_water");
  assert.equal(h2.severity, 2);
});

test("P0: mc.acquire decomposes stone_pickaxe from bare hands in one 0-Token call and is idempotent", async () => {
  const blocks = new Map([
    ["2,64,0", { name: "oak_log", boundingBox: "block" }],
    ["2,65,0", { name: "oak_log", boundingBox: "block" }],
    ["2,66,0", { name: "oak_log", boundingBox: "block" }],
    ["2,67,0", { name: "oak_log", boundingBox: "block" }],
    ["-2,64,0", { name: "stone", boundingBox: "block" }],
    ["-2,64,1", { name: "stone", boundingBox: "block" }],
    ["-2,64,2", { name: "stone", boundingBox: "block" }],
    ["-2,64,3", { name: "stone", boundingBox: "block" }],
  ]);
  const bot = makeRichCraftBot({ initialItems: [], blocks });
  const rt = new McRuntime({
    config: makeConfig(),
    createBotFn: () => bot,
    pickupSettleMs: 0,
    stuckCheckIntervalMs: 0,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  rt.connectBot();
  bot.emit("spawn");

  const res = await rt.dispatchGoal({
    action_type: "acquire",
    item_name: "stone_pickaxe",
    count: 1,
  });
  assert.equal(res.ok, true);
  assert.equal(res.item_name, "stone_pickaxe");
  assert.equal(res.already_owned, false);
  assert.equal(bot._invMap.get("stone_pickaxe"), 1);
  assert.ok(res.steps_completed.some((s) => s.startsWith("gather:oak_log")));
  assert.ok(res.steps_completed.some((s) => s.startsWith("craft:wooden_pickaxe")));
  assert.ok(res.steps_completed.some((s) => s.startsWith("gather:stone")));
  assert.ok(res.steps_completed.some((s) => s.startsWith("craft:stone_pickaxe")));

  // Calling acquire again is idempotent (already_owned=true)
  const res2 = await rt.dispatchGoal({
    action_type: "acquire",
    item_name: "stone_pickaxe",
    count: 1,
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.already_owned, true);
  assert.equal(res2.acquired_count, 0);

  rt.stop();
});

test("P0: mc.acquire crafts shield via iron ore + furnace + smelting and auto-equips off-hand, and rejects unsupported items", async () => {
  assert.equal(parseAcquireParams({ item_name: "bedrock" }).error, "acquire_item_not_supported");

  const blocks = new Map([
    ["3,64,0", { name: "iron_ore", boundingBox: "block" }],
    ["3,64,1", { name: "coal_ore", boundingBox: "block" }],
    ["-1,64,0", { name: "crafting_table", boundingBox: "block" }],
    ["-1,64,1", { name: "furnace", boundingBox: "block" }],
  ]);
  const bot = makeRichCraftBot({
    initialItems: [
      { name: "stone_pickaxe", count: 1 },
      { name: "oak_planks", count: 8 },
    ],
    blocks,
  });

  const rt = new McRuntime({
    config: makeConfig(),
    createBotFn: () => bot,
    pickupSettleMs: 0,
    smeltPollIntervalMs: 10,
    stuckCheckIntervalMs: 0,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  rt.connectBot();
  bot.emit("spawn");

  const res = await rt.dispatchGoal({ action_type: "acquire", item_name: "shield", count: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.item_name, "shield");
  assert.equal(res.snapshot.equipment.off_hand, "shield");
  assert.ok(res.snapshot.reflex_modes.includes("shield_ready"));

  // Creeper interruption aborts acquire safely
  const dangerBot = makeRichCraftBot({
    initialItems: [],
    entities: { 99: { id: 99, name: "creeper", position: vec3(3, 64, 0) } },
  });
  const dangerRes = await executeAcquireAction(
    dangerBot,
    { item_name: "wooden_pickaxe", count: 1 },
    { gatherBlocksFn: async () => ({ ok: false, reason: "block_not_found" }) },
  );
  assert.equal(dangerRes.ok, false);
  assert.equal(dangerRes.reason, "interrupted_by_threat");

  rt.stop();
});

test("P0+P1 autonomy: low-health acquire proceeds safely when no hostiles nearby, and water explore heads to dry land", async () => {
  // 1. Low health (3.3) with NO nearby hostiles -> acquire is NOT blocked by low-health guard
  const safeLowHpBlocks = new Map([
    ["2,64,0", { name: "oak_log", boundingBox: "block" }],
    ["2,65,0", { name: "oak_log", boundingBox: "block" }],
    ["2,66,0", { name: "oak_log", boundingBox: "block" }],
  ]);
  const safeLowHpBot = makeRichCraftBot({
    health: 3.3,
    food: 17,
    initialItems: [{ name: "rotten_flesh", count: 7 }],
    blocks: safeLowHpBlocks,
  });
  const safeRt = new McRuntime({
    config: makeConfig(),
    createBotFn: () => safeLowHpBot,
    pickupSettleMs: 0,
    stuckCheckIntervalMs: 0,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  safeRt.connectBot();
  safeLowHpBot.emit("spawn");

  // Snapshot reports safe_food_count=0 (rotten_flesh excluded) and in_water=false
  const snapBefore = safeRt.getSnapshot();
  assert.equal(snapBefore.safe_food_count, 0);
  assert.equal(snapBefore.in_water, false);

  const acqRes = await safeRt.dispatchGoal({
    action_type: "acquire",
    item_name: "wooden_pickaxe",
    count: 1,
  });
  assert.equal(acqRes.ok, true);
  assert.equal(safeLowHpBot._invMap.get("wooden_pickaxe"), 1);

  // 2. Same low health WITH a nearby zombie within 10 blocks -> still interrupts safely
  const hostileBot = makeRichCraftBot({
    health: 3.3,
    entities: { 77: { id: 77, name: "zombie", position: vec3(8, 64, 0) } },
  });
  const hostileRes = await executeAcquireAction(
    hostileBot,
    { item_name: "wooden_pickaxe", count: 1 },
    { gatherBlocksFn: async () => ({ ok: true, collected_count: 1, block: "oak_log" }) },
  );
  assert.equal(hostileRes.ok, false);
  assert.equal(hostileRes.reason, "interrupted_by_low_health");

  // 3. In-water explore picks nearby dry land first and reports in_water=true in snapshot
  const waterBlocks = new Map([
    ["0,62,0", { name: "water", boundingBox: "empty" }],
    ["3,62,0", { name: "grass_block", boundingBox: "block" }],
    ["3,63,0", { name: "air", boundingBox: "empty" }],
    ["3,64,0", { name: "air", boundingBox: "empty" }],
  ]);
  const waterBot = makeRichCraftBot({
    pos: vec3(0, 62.7, 0),
    blocks: waterBlocks,
  });
  waterBot.entity.isInWater = true;
  const exploreGoals = [];
  waterBot.pathfinder.goto = async (goal) => {
    exploreGoals.push([Math.round(goal.x), Math.round(goal.z)]);
    waterBot.entity.position = vec3(goal.x, 63, goal.z);
  };
  const waterRt = new McRuntime({
    config: makeConfig(),
    createBotFn: () => waterBot,
    stuckCheckIntervalMs: 0,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  waterRt.connectBot();
  waterBot.emit("spawn");
  assert.equal(waterRt.getSnapshot().in_water, true);
  const expRes = await waterRt.dispatchGoal({ action_type: "explore" });
  assert.equal(expRes.ok, true);
  assert.equal(expRes.moved_blocks, 3);
  assert.deepEqual(exploreGoals[0], [3, 0]);

  safeRt.stop();
  waterRt.stop();
});

test("live-log fixes: unreachable remote crafting_table falls back locally, explore verifies displacement, stone-pit pillar unstick, neutral enderman", async () => {
  // 1. Unreachable remote crafting_table at (10,64,0) throws NoPath -> blacklisted, falls back to local table craft/place without crashing
  const remoteTableBlocks = new Map([
    ["10,64,0", { name: "crafting_table", boundingBox: "block" }],
    ["1,63,0", { name: "grass_block", boundingBox: "block" }],
    ["1,64,0", { name: "air", boundingBox: "empty" }],
    ["0,63,0", { name: "grass_block", boundingBox: "block" }],
  ]);
  const craftBot = makeRichCraftBot({
    pos: vec3(0, 64, 0),
    initialItems: [
      { name: "oak_planks", count: 8 },
      { name: "stick", count: 2 },
    ],
    blocks: remoteTableBlocks,
  });
  craftBot.pathfinder.goto = async (goal) => {
    if (Math.round(goal.x) === 10) {
      throw new Error("NoPath: cannot reach remote table");
    }
  };
  const craftRt = new McRuntime({
    config: makeConfig(),
    createBotFn: () => craftBot,
    pickupSettleMs: 0,
    stuckCheckIntervalMs: 0,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  craftRt.connectBot();
  craftBot.emit("spawn");

  const acqRes = await craftRt.dispatchGoal({
    action_type: "acquire",
    item_name: "wooden_pickaxe",
    count: 1,
  });
  assert.equal(acqRes.ok, true);
  assert.equal(craftBot._invMap.get("wooden_pickaxe"), 1);
  assert.equal(craftRt._unreachableBlocks.has([10, 64, 0], craftRt.nowFn()), true);

  // 2. explore rejects silent zero-displacement goto resolves and succeeds when actually displaced
  const stuckExpBot = makeRichCraftBot({ pos: vec3(0, 64, 0), blocks: new Map() });
  stuckExpBot.pathfinder.goto = async () => {
    // Resolves immediately without changing bot.entity.position
  };
  const stuckExpRt = new McRuntime({
    config: makeConfig(),
    createBotFn: () => stuckExpBot,
    stuckCheckIntervalMs: 0,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  stuckExpRt.connectBot();
  stuckExpBot.emit("spawn");

  const zeroExp = await stuckExpRt.dispatchGoal({ action_type: "explore" });
  assert.equal(zeroExp.ok, false);
  assert.equal(zeroExp.reason, "no_movement_progress");
  assert.equal(zeroExp.moved_blocks, 0);

  stuckExpBot.pathfinder.goto = async () => {
    stuckExpBot.entity.position = vec3(6, 64, 0);
  };
  const movedExp = await stuckExpRt.dispatchGoal({ action_type: "explore" });
  assert.equal(movedExp.ok, true);
  assert.equal(movedExp.moved_blocks, 6);

  // 3. _tryNaturalUnstick places 1 dirt underfoot when trapped in a 2-high stone pit with headroom
  const pitBlocks = new Map([["0,63,0", { name: "stone", boundingBox: "block" }]]);
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    pitBlocks.set(`${dx},64,${dz}`, { name: "stone", boundingBox: "block" });
    pitBlocks.set(`${dx},65,${dz}`, { name: "stone", boundingBox: "block" });
  }
  const pitBot = makeRichCraftBot({
    pos: vec3(0, 64, 0),
    initialItems: [{ name: "dirt", count: 4 }],
    blocks: pitBlocks,
  });
  const placedOn = [];
  pitBot.placeBlock = async (ref, face) => {
    placedOn.push([ref.position.x, ref.position.y, ref.position.z, face.y]);
  };
  const pitRt = new McRuntime({
    config: makeConfig(),
    createBotFn: () => pitBot,
    stuckCheckIntervalMs: 25,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  pitRt.connectBot();
  pitBot.emit("spawn");
  const unstuck = await pitRt._tryNaturalUnstick(pitBot, null);
  assert.equal(unstuck, true);
  assert.deepEqual(placedOn, [[0, 63, 0, 1]]);

  // 4. Unprovoked enderman is labeled enderman(neutral) and ignored by evade threats; screaming enderman stays hostile
  const enderBot = makeRichCraftBot({
    pos: vec3(0, 64, 0),
    entities: {
      10: { id: 10, name: "enderman", type: "mob", position: vec3(5, 64, 0), isScreaming: false },
    },
  });
  const enderRt = new McRuntime({
    config: makeConfig(),
    createBotFn: () => enderBot,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  enderRt.connectBot();
  enderBot.emit("spawn");
  assert.deepEqual(enderRt.getSnapshot().nearby_entities, ["enderman(neutral)"]);
  assert.equal(enderRt._findEvadeThreats(enderBot), null);

  enderBot.entities[10].isScreaming = true;
  enderRt._refreshFromBot();
  assert.deepEqual(enderRt.getSnapshot().nearby_entities, ["enderman"]);
  assert.ok(enderRt._findEvadeThreats(enderBot) !== null);

  craftRt.stop();
  stuckExpRt.stop();
  pitRt.stop();
  enderRt.stop();
});

test("v2.9.8 live-log fixes: intercept noPath empty-path resolve, enforce dig reach, guard acquire null reason, and steep-terrain unstick fallback", async () => {
  // 1. mineflayer-pathfinder silent noPath (path.length === 0) is rejected by _gotoGoal;
  //    goto falls back to steep-terrain movements and never falsely succeeds when stationary.
  const noPathBot = makeRichCraftBot({ pos: vec3(5.5, 76, -2.5), blocks: new Map() });
  const seenMoves = [];
  noPathBot.pathfinder.setMovements = (m) => seenMoves.push({ ...m });
  noPathBot.pathfinder.goto = async () => {
    noPathBot.emit("path_update", { status: "noPath", path: [] });
  };
  const noPathRt = new McRuntime({
    config: makeConfig(),
    createBotFn: () => noPathBot,
    stuckCheckIntervalMs: 0,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  noPathRt.connectBot();
  noPathBot.emit("spawn");

  const gotoFail = await noPathRt.dispatchGoal({ action_type: "goto", x: 8, y: 71, z: 9 });
  assert.equal(gotoFail.ok, false);
  assert.equal(gotoFail.reason, "path_stuck");
  assert.ok(
    seenMoves.some(
      (m) =>
        m.profileName === "natural_traverse" &&
        m.maxDropDown === 4 &&
        m.allow1by1towers === true &&
        m.canDig === true &&
        Array.isArray(m.exclusionAreasBreak) &&
        m.exclusionAreasBreak.length >= 1,
    ),
  );
  // Restored strict cruise_walk defaults after escalation
  const lastMoveAfterGoto = seenMoves[seenMoves.length - 1];
  assert.equal(lastMoveAfterGoto.profileName, "cruise_walk");
  assert.equal(lastMoveAfterGoto.maxDropDown, 3);
  assert.equal(lastMoveAfterGoto.allow1by1towers, false);
  assert.equal(lastMoveAfterGoto.canDig, false);

  // 2. gather refuses to ghost-dig an out-of-reach tree (20 blocks away) when pathfinder doesn't reach it
  const farTreeBot = makeRichCraftBot({
    pos: vec3(0, 64, 0),
    blocks: new Map([["20,64,0", { name: "oak_log", boundingBox: "block" }]]),
  });
  farTreeBot.pathfinder.goto = async () => {
    // Resolves without moving bot close to (20, 64, 0)
  };
  const farTreeRt = new McRuntime({
    config: makeConfig(),
    createBotFn: () => farTreeBot,
    stuckCheckIntervalMs: 0,
    pickupSettleMs: 0,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  farTreeRt.connectBot();
  farTreeBot.emit("spawn");

  const ghostGather = await farTreeRt.dispatchGoal({
    action_type: "gather",
    block_type: "oak_log",
    count: 2,
  });
  assert.equal(ghostGather.ok, false);
  assert.equal(farTreeBot._dug.length, 0);
  assert.equal(farTreeRt._unreachableBlocks.has([20, 64, 0], farTreeRt.nowFn()), true);

  // 3. acquire ensureWoodPlanks never throws TypeError on g.reason when gather reports ok without adding logs
  const ghostAcqBot = makeRichCraftBot({
    pos: vec3(0, 64, 0),
    initialItems: [
      { name: "stick", count: 4 },
      { name: "birch_planks", count: 2 },
      { name: "oak_planks", count: 1 },
      { name: "crafting_table", count: 1 },
    ],
    blocks: new Map([["18,64,0", { name: "oak_log", boundingBox: "block" }]]),
  });
  let gatherInvocations = 0;
  const ghostAcqRes = await executeAcquireAction(
    ghostAcqBot,
    { item_name: "wooden_pickaxe", count: 1 },
    {
      gatherBlocksFn: async () => {
        gatherInvocations += 1;
        return { ok: true, collected_count: 1, block: "oak_log" };
      },
    },
  );
  assert.equal(ghostAcqRes.ok, false);
  assert.equal(ghostAcqRes.reason, "missing_materials");
  assert.ok(gatherInvocations <= 3);

  // 4. explore triggers safe steep-terrain fallback (maxDropDown=4, allowStepScaffold=true, canDig=false)
  //    on attempt 1 after attempt 0 hits noPath, escapes 7 blocks, and restores strict defaults.
  const cliffBot = makeRichCraftBot({
    pos: vec3(5.5, 76, -2.5),
    initialItems: [{ name: "dirt", count: 30 }],
    blocks: new Map(),
  });
  const cliffMoves = [];
  let curMoveMode = null;
  cliffBot.pathfinder.setMovements = (m) => {
    curMoveMode = { ...m };
    cliffMoves.push(curMoveMode);
  };
  cliffBot.pathfinder.goto = async () => {
    if (!curMoveMode?.allow1by1towers) {
      cliffBot.emit("path_update", { status: "noPath", path: [] });
      return;
    }
    cliffBot.entity.position = vec3(12.5, 72, -2.5);
  };
  const cliffRt = new McRuntime({
    config: makeConfig(),
    createBotFn: () => cliffBot,
    stuckCheckIntervalMs: 0,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  cliffRt.connectBot();
  cliffBot.emit("spawn");

  const escRes = await cliffRt.dispatchGoal({ action_type: "explore" });
  assert.equal(escRes.ok, true);
  assert.equal(escRes.moved_blocks, 7);
  assert.ok(
    cliffMoves.some(
      (m) =>
        m.profileName === "natural_traverse" &&
        m.maxDropDown === 4 &&
        m.allow1by1towers === true &&
        m.canDig === true,
    ),
  );
  assert.equal(cliffMoves[cliffMoves.length - 1].profileName, "cruise_walk");
  assert.equal(cliffMoves[cliffMoves.length - 1].maxDropDown, 3);
  assert.equal(cliffMoves[cliffMoves.length - 1].allow1by1towers, false);

  noPathRt.stop();
  farTreeRt.stop();
  cliffRt.stop();
});

test("v2.10.5 live-Paper fixes: bounded goals stop background evade pathfinder, settle onGround before digging, preserve partial gather on timeout, and prefer trunk-base logs", async () => {
  // 1. Background _companionTick evade sets pathfinder goal without _activeGoalCancel;
  //    starting shelter must stop pathfinder, clear _evadePlan, and clear controls before digging.
  const shBlocks = new Map();
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let y = 60; y <= 63; y += 1) {
        shBlocks.set(`${dx},${y},${dz}`, { name: "dirt", boundingBox: "block" });
      }
      shBlocks.set(`${dx},64,${dz}`, { name: "air", boundingBox: "empty" });
    }
  }
  const shBot = makeRichCraftBot({
    pos: vec3(0.5, 64, 0.5),
    initialItems: [{ name: "dirt", count: 8 }],
    blocks: shBlocks,
    entities: {
      77: { id: 77, name: "zombie", type: "mob", position: vec3(5, 64, 0) },
    },
  });
  let bgGoalActive = false;
  let stopCalls = 0;
  shBot.pathfinder.setGoal = (g) => {
    bgGoalActive = Boolean(g);
  };
  shBot.pathfinder.stop = () => {
    stopCalls += 1;
    bgGoalActive = false;
  };
  shBot.entity.onGround = false;
  let sawBgGoalDuringDig = false;
  let digOnGroundStates = [];
  shBot.dig = async (blk) => {
    if (bgGoalActive) sawBgGoalDuringDig = true;
    digOnGroundStates.push(shBot.entity.onGround);
    if (blk?.position) {
      shBlocks.set(`${blk.position.x},${blk.position.y},${blk.position.z}`, {
        name: "air",
        boundingBox: "empty",
      });
      shBot.entity.position = vec3(0.5, blk.position.y, 0.5);
    }
  };
  shBot.placeBlock = async (ref, face) => {
    const px = ref.position.x + face.x;
    const py = ref.position.y + face.y;
    const pz = ref.position.z + face.z;
    shBlocks.set(`${px},${py},${pz}`, { name: "dirt", boundingBox: "block" });
  };
  const shRt = new McRuntime({
    config: makeConfig({ MC_COMPANION_MODE: "true" }),
    createBotFn: () => shBot,
    stuckCheckIntervalMs: 0,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  shRt.connectBot();
  shBot.emit("spawn");

  await shRt._companionTick();
  assert.equal(bgGoalActive, true);
  assert.ok(shRt._evadePlan !== null);

  // Simulate landing 30ms into shelter start -> waitForStableGround must wait until onGround === true
  setTimeout(() => {
    shBot.entity.onGround = true;
  }, 30);

  const shRes = await shRt.dispatchGoal({ action_type: "shelter", mode: "enter" });
  assert.equal(shRes.ok, true);
  assert.equal(sawBgGoalDuringDig, false);
  assert.ok(stopCalls >= 1);
  assert.equal(shRt._evadePlan, null);
  assert.deepEqual(digOnGroundStates, [true, true, true]);
  shRt.stop();

  // 2. gather prefers trunk-base log (dirt below) over upper canopy log closer in 3D distance,
  //    waits for onGround before bot.dig, and preserves partial collected_count on timeout.
  const treeBlocks = new Map([
    ["5,60,0", { name: "dirt", boundingBox: "block" }],
    ["5,61,0", { name: "oak_log", boundingBox: "block" }],
    ["5,62,0", { name: "oak_log", boundingBox: "block" }],
    ["5,63,0", { name: "oak_log", boundingBox: "block" }],
    ["5,64,0", { name: "oak_log", boundingBox: "block" }],
    ["4,61,0", { name: "air", boundingBox: "empty" }],
    ["4,62,0", { name: "air", boundingBox: "empty" }],
    ["4,63,0", { name: "air", boundingBox: "empty" }],
    ["4,64,0", { name: "air", boundingBox: "empty" }],
  ]);
  const treeBot = makeRichCraftBot({
    pos: vec3(0, 65, 0),
    blocks: treeBlocks,
  });
  // Return upper log FIRST in findBlocks (closer to hillside y=65), base log SECOND
  treeBot.findBlocks = ({ matching }) => {
    const ordered = [vec3(5, 64, 0), vec3(5, 63, 0), vec3(5, 62, 0), vec3(5, 61, 0)];
    return ordered.filter((p) => {
      const b = treeBlocks.get(`${p.x},${p.y},${p.z}`);
      return b && matching(b);
    });
  };
  treeBot.entity.onGround = true;
  const dugLogs = [];
  treeBot.pathfinder.goto = async (goal) => {
    treeBot.entity.position = vec3(goal.x - 1, goal.y, goal.z);
    // Simulate landing slightly after goto resolves
    treeBot.entity.onGround = false;
    setTimeout(() => {
      treeBot.entity.onGround = true;
    }, 25);
  };
  treeBot.dig = async (blk) => {
    dugLogs.push({ y: blk.position.y, onGround: treeBot.entity.onGround });
    if (dugLogs.length === 1) {
      treeBlocks.set(`${blk.position.x},${blk.position.y},${blk.position.z}`, {
        name: "air",
        boundingBox: "empty",
      });
      return;
    }
    // 2nd log hangs past timeout_ms -> must preserve collected_count=1 as partial success!
    await new Promise((r) => setTimeout(r, 500));
  };
  const treeRt = new McRuntime({
    config: makeConfig(),
    createBotFn: () => treeBot,
    pickupSettleMs: 0,
    stuckCheckIntervalMs: 0,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  treeRt.connectBot();
  treeBot.emit("spawn");

  const gRes = await treeRt.dispatchGoal({
    action_type: "gather",
    block_type: "oak_log",
    count: 2,
    timeout_ms: 180,
  });
  assert.equal(gRes.ok, true);
  assert.equal(gRes.partial, true);
  assert.equal(gRes.collected_count, 1);
  assert.match(gRes.summary, /时间上限/);
  assert.equal(dugLogs[0].y, 61);
  assert.equal(dugLogs[0].onGround, true);
  treeRt.stop();

  // 3. place skips interactive ground (crafting_table) and tries next solid ground spot;
  //    acquire(coal) verifies inventory gain after coal_ore gather and falls back to charcoal when drop lost.
  const placeBlocks = new Map([
    ["1,63,0", { name: "crafting_table", boundingBox: "block" }],
    ["1,64,0", { name: "air", boundingBox: "empty" }],
    ["-1,63,0", { name: "grass_block", boundingBox: "block" }],
    ["-1,64,0", { name: "air", boundingBox: "empty" }],
  ]);
  const placeBot = makeRichCraftBot({
    pos: vec3(0.5, 64, 0.5),
    initialItems: [{ name: "chest", count: 1 }],
    blocks: placeBlocks,
  });
  const placeRefs = [];
  placeBot.placeBlock = async (ref, face) => {
    placeRefs.push(ref.name);
    const px = ref.position.x + face.x;
    const py = ref.position.y + face.y;
    const pz = ref.position.z + face.z;
    placeBlocks.set(`${px},${py},${pz}`, { name: "chest", boundingBox: "block" });
  };
  const placeRt = new McRuntime({
    config: makeConfig(),
    createBotFn: () => placeBot,
    snapshotIntervalMs: 60_000,
    survivalTickMs: 60_000,
    companionTickMs: 60_000,
  });
  placeRt.connectBot();
  placeBot.emit("spawn");
  const plRes = await placeRt.dispatchGoal({ action_type: "place", item_name: "chest" });
  assert.equal(plRes.ok, true);
  assert.deepEqual(placeRefs, ["grass_block"]);
  assert.deepEqual(plRes.placed_pos, [-1, 64, 0]);
  placeRt.stop();

  // Lost underwater coal drop -> acquire must verify coal inventory count and fall back to charcoal!
  const coalBot = makeRichCraftBot({
    pos: vec3(0, 64, 0),
    initialItems: [
      { name: "wooden_pickaxe", count: 1 },
      { name: "oak_log", count: 2 },
    ],
    blocks: new Map([["3,62,0", { name: "coal_ore", boundingBox: "block" }]]),
  });
  let gatherCoalCalled = 0;
  const coalRes = await executeAcquireAction(
    coalBot,
    { item_name: "coal", count: 1 },
    {
      gatherBlocksFn: async (names) => {
        if (names.includes("coal_ore")) {
          gatherCoalCalled += 1;
          // Simulates digging coal_ore but losing the drop (coal stays 0 in inventory)
          return { ok: true, collected_count: 1, block: "coal_ore" };
        }
        return { ok: false, reason: "block_not_found" };
      },
    },
  );
  assert.equal(gatherCoalCalled, 1);
  // Must NOT falsely return ok=true when coal=0; falls back toward charcoal/furnace
  assert.equal(coalRes.ok, false);
});
