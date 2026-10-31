import { describe, it, expect, vi } from "vitest";
import { getCharacterState, buildCharacterState } from "../../src/tools/character.js";
import type { DdbClient } from "../../src/api/client.js";
import type { DdbCharacter } from "../../src/types/character.js";

const SLOTS: number[][] = Array.from({ length: 21 }, () => [0, 0, 0, 0, 0, 0, 0, 0, 0]);
SLOTS[15] = [4, 3, 3, 2, 0, 0, 0, 0, 0];

function paladin(): DdbCharacter {
  return {
    id: 172822122,
    name: "Ser Brunhild Eisenhain",
    classes: [{ id: 1, level: 15, isStartingClass: true, subclassDefinition: null,
      definition: { name: "Paladin", spellRules: { levelSpellSlots: SLOTS, multiClassSpellSlotDivisor: 2, multiClassSpellSlotRounding: 2 } } }],
    baseHitPoints: 94, bonusHitPoints: null, overrideHitPoints: 199, removedHitPoints: 20, temporaryHitPoints: 5,
    spellSlots: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((level) => ({ level, used: level === 1 ? 2 : 0, available: 0 })),
    pactMagic: null,
    actions: { class: [
      { id: 1, entityTypeId: 2, name: "Channel Divinity", componentId: 0, componentTypeId: 0,
        limitedUse: { maxUses: 3, numberUsed: 1, resetType: 2, resetTypeDescription: "Long Rest" } },
      { id: 3, entityTypeId: 2, name: "Vow of Enmity", componentId: 0, componentTypeId: 0, limitedUse: null },
    ], race: [
      { id: 4, entityTypeId: 2, name: "Stonecunning (Tremorsense)", componentId: 0, componentTypeId: 0,
        limitedUse: { maxUses: 0, numberUsed: 2, resetType: 2, resetTypeDescription: "", useProficiencyBonus: true } },
    ] },
    spells: { class: [
      { id: 5477222, entityTypeId: 420821570, definition: { name: "Find Steed", level: 2 }, prepared: false, alwaysPrepared: true,
        usesSpellSlot: false, limitedUse: { maxUses: 1, numberUsed: 1, resetType: 2 } },
    ], race: [], background: [], item: [], feat: [] },
    classSpells: [],
    inventory: [{ id: 77, definition: { name: "Holy Water" }, quantity: 1, equipped: false }],
    currencies: { cp: 0, sp: 0, ep: 0, gp: 23, pp: 0 },
    deathSaves: { failCount: null, successCount: null, isStabilized: false },
    inspiration: false,
    conditions: [],
    modifiers: {},
    stats: [],
  } as unknown as DdbCharacter;
}

describe("buildCharacterState", () => {
  it("reports HP, real slot caps, scaled resources and free casts", () => {
    const s = buildCharacterState(paladin());
    expect(s.hp).toEqual({ current: 179, max: 199, temp: 5 });
    expect(s.slots).toEqual([
      { level: 1, used: 2, max: 4 }, { level: 2, used: 0, max: 3 }, { level: 3, used: 0, max: 3 }, { level: 4, used: 0, max: 2 },
    ]);
    expect(s.resources).toEqual([
      { name: "Channel Divinity", used: 1, max: 3, reset: "Long Rest" },
      { name: "Stonecunning (Tremorsense)", used: 2, max: 5, reset: "long rest" },
    ]);
    expect(s.freeCasts).toEqual([{ name: "Find Steed", level: 2, used: 1, max: 1, reset: "long rest" }]);
    expect(s.inventory).toEqual([{ id: 77, name: "Holy Water", quantity: 1, equipped: false }]);
  });
});

describe("getCharacterState", () => {
  it("reads live (cache invalidated) and returns JSON", async () => {
    const client = { get: vi.fn().mockResolvedValue(paladin()), invalidateCache: vi.fn() } as unknown as DdbClient;
    const res = await getCharacterState(client, { characterId: 172822122 });
    expect(client.invalidateCache).toHaveBeenCalledWith("character:172822122");
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.name).toBe("Ser Brunhild Eisenhain");
    expect(parsed.slots).toHaveLength(4);
  });
});
