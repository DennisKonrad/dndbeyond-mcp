import { describe, it, expect, vi, beforeEach } from "vitest";
import { castSpell, useAbility, maxSpellSlots } from "../../src/tools/character.js";
import type { DdbClient } from "../../src/api/client.js";
import type { DdbCharacter, DdbSpell } from "../../src/types/character.js";

// Shapes taken from a live 2024 Paladin 15 (Faithful Steed, Paladin's Smite).
// D&D Beyond reports every spellSlots[].available as 0 and computes the cap
// in the browser from classes[].definition.spellRules.levelSpellSlots.
const PALADIN_SLOTS: number[][] = Array.from({ length: 21 }, () => [0, 0, 0, 0, 0, 0, 0, 0, 0]);
PALADIN_SLOTS[5] = [4, 2, 0, 0, 0, 0, 0, 0, 0];
PALADIN_SLOTS[15] = [4, 3, 3, 2, 0, 0, 0, 0, 0];

function spell(id: number, name: string, level: number, extra: Partial<DdbSpell>): DdbSpell {
  return {
    id,
    entityTypeId: 420821570,
    definition: { name, level } as DdbSpell["definition"],
    prepared: false,
    alwaysPrepared: true,
    usesSpellSlot: true,
    ...extra,
  } as DdbSpell;
}

function paladin(opts: { steedUsed?: number; slot2Used?: number } = {}): DdbCharacter {
  return {
    id: 172822122,
    name: "Ser Brunhild Eisenhain",
    classes: [{
      id: 1,
      level: 15,
      isStartingClass: true,
      subclassDefinition: null,
      definition: {
        name: "Paladin",
        spellRules: { levelSpellSlots: PALADIN_SLOTS, multiClassSpellSlotDivisor: 2, multiClassSpellSlotRounding: 2 },
      },
    }],
    spellSlots: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((level) => ({
      level, used: level === 2 ? (opts.slot2Used ?? 0) : 0, available: 0,
    })),
    pactMagic: null,
    spells: {
      class: [
        spell(5477222, "Find Steed", 2, {
          usesSpellSlot: false,
          limitedUse: { maxUses: 1, numberUsed: opts.steedUsed ?? 0, resetType: 2, useProficiencyBonus: false },
        }),
        spell(5477223, "Find Steed", 2, { usesSpellSlot: true, limitedUse: null }),
        spell(5477224, "Bane", 1, { usesSpellSlot: true, limitedUse: null }),
      ],
      race: [], background: [], item: [], feat: [],
    },
    classSpells: [],
    actions: { class: [], race: [], feat: [] },
    modifiers: {},
    stats: [],
  } as unknown as DdbCharacter;
}

function client(char: DdbCharacter): DdbClient {
  return {
    get: vi.fn().mockResolvedValue(char),
    getRaw: vi.fn(),
    put: vi.fn().mockResolvedValue({}),
    invalidateCache: vi.fn(),
  } as unknown as DdbClient;
}

describe("castSpell with free: true", () => {
  it("spends the feature's free cast through the limited-use endpoint, not a slot", async () => {
    const c = client(paladin());
    const res = await castSpell(c, { characterId: 172822122, spellName: "Find Steed", free: true });
    expect(c.put).toHaveBeenCalledTimes(1);
    expect(c.put).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/action/limited-use"),
      { characterId: 172822122, id: "5477222", entityTypeId: "420821570", uses: 1 },
      ["character:172822122"],
    );
    expect(res.content[0].text).toContain("without a spell slot");
    expect(res.content[0].text).toContain("1/1 used");
  });

  it("refuses when the free cast is already spent", async () => {
    const c = client(paladin({ steedUsed: 1 }));
    const res = await castSpell(c, { characterId: 172822122, spellName: "Find Steed", free: true });
    expect(c.put).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("No free casts of Find Steed left (1/1 used)");
  });

  it("refuses for a spell that has no free cast", async () => {
    const c = client(paladin());
    const res = await castSpell(c, { characterId: 172822122, spellName: "Bane", free: true });
    expect(c.put).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("has no free cast");
  });
});

describe("castSpell with a spell slot", () => {
  it("takes the slot cap from the class table when D&D Beyond reports 0 available", async () => {
    const c = client(paladin());
    const res = await castSpell(c, { characterId: 172822122, spellName: "Find Steed" });
    expect(c.put).toHaveBeenCalledWith(
      expect.stringContaining("/spell/slots"),
      { characterId: 172822122, level2: 1 },
      ["character:172822122"],
    );
    expect(res.content[0].text).toContain("Level 2 slots: 1/3 used");
    expect(res.content[0].text).toContain("free cast is still available");
  });

  it("stops at the class table's cap", async () => {
    const c = client(paladin({ slot2Used: 3, steedUsed: 1 }));
    const res = await castSpell(c, { characterId: 172822122, spellName: "Find Steed" });
    expect(c.put).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("No level 2 spell slots remaining (3/3 used)");
    expect(res.content[0].text).not.toContain("free cast is still available");
  });
});

describe("useAbility on a free spell cast", () => {
  it("finds the free cast by spell name and writes its use", async () => {
    const c = client(paladin());
    const res = await useAbility(c, { characterId: 172822122, abilityName: "Find Steed" });
    expect(c.put).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/action/limited-use"),
      { characterId: 172822122, id: "5477222", entityTypeId: "420821570", uses: 1 },
      ["character:172822122"],
    );
    expect(res.content[0].text).toBe("Find Steed (free cast): 1/1 uses expended.");
  });

  it("can reset the free cast to 0", async () => {
    const c = client(paladin({ steedUsed: 1 }));
    const res = await useAbility(c, { characterId: 172822122, abilityName: "Find Steed", uses: 0 });
    expect(c.put).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ id: "5477222", uses: 0 }), expect.any(Array));
    expect(res.content[0].text).toContain("0/1 uses expended");
  });
});

describe("maxSpellSlots", () => {
  it("prefers a non-zero value D&D Beyond reports", () => {
    const char = paladin();
    char.spellSlots![0].available = 7;
    expect(maxSpellSlots(char, 1)).toBe(7);
  });

  it("reads a single caster's own table", () => {
    const char = paladin();
    expect([1, 2, 3, 4, 5].map((l) => maxSpellSlots(char, l))).toEqual([4, 3, 3, 2, 0]);
  });

  it("uses the multiclass table for several casters, with each class's rounding", () => {
    const char = paladin();
    const wizardSlots = Array.from({ length: 21 }, () => [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    wizardSlots[3] = [4, 2, 0, 0, 0, 0, 0, 0, 0];
    char.classes = [
      { ...char.classes[0], level: 5 },
      {
        id: 2, level: 3, isStartingClass: false, subclassDefinition: null,
        definition: { name: "Wizard", spellRules: { levelSpellSlots: wizardSlots, multiClassSpellSlotDivisor: 1, multiClassSpellSlotRounding: 1 } },
      } as DdbCharacter["classes"][number],
    ];
    // Paladin 5 / 2 rounded up = 3, Wizard 3 / 1 = 3 → caster level 6: 4/3/3.
    expect([1, 2, 3, 4].map((l) => maxSpellSlots(char, l))).toEqual([4, 3, 3, 0]);
  });

  it("ignores Warlock pact slots", () => {
    const char = paladin();
    char.classes = [{ ...char.classes[0], definition: { ...char.classes[0].definition, name: "Warlock" } }];
    expect(maxSpellSlots(char, 1)).toBe(0);
  });
});
