import { describe, it, expect, vi } from "vitest";
import { getCharacter } from "../../src/tools/character.js";
import type { DdbClient } from "../../src/api/client.js";
import type { DdbCharacter, DdbSpell } from "../../src/types/character.js";

function createMockClient(character: DdbCharacter): DdbClient {
  const client = { get: vi.fn().mockResolvedValue(character), getRaw: vi.fn(), put: vi.fn() } as Record<string, unknown>;
  client.getWithMeta = vi.fn(async () => ({ value: character, fromCache: false, ageMs: 0 }));
  return client as unknown as DdbClient;
}

function spell(name: string, level: number, flags: Partial<DdbSpell> = {}): DdbSpell {
  return {
    id: Math.floor(Math.random() * 1e6),
    definition: {
      name, level, school: "Evocation", description: "", range: null, duration: null, activation: null,
      components: null, componentsDescription: null, concentration: false, ritual: false,
    },
    prepared: false,
    alwaysPrepared: false,
    usesSpellSlot: true,
    ...flags,
  } as DdbSpell;
}

function character(className: string, def: Record<string, unknown>, list: DdbSpell[], actions = {}): DdbCharacter {
  return {
    id: 1, readonlyUrl: "", name: "T",
    race: { fullName: "Human", baseRaceName: "Human", isHomebrew: false, racialTraits: [] },
    background: { definition: null },
    stats: [1, 2, 3, 4, 5, 6].map((id) => ({ id, value: id === 6 ? 20 : id === 5 ? 18 : 10 })),
    bonusStats: [], overrideStats: [],
    baseHitPoints: 40, bonusHitPoints: null, overrideHitPoints: null, removedHitPoints: 0, temporaryHitPoints: 0,
    currentXp: 0, alignmentId: 1, lifestyleId: 1,
    currencies: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    deathSaves: { failCount: null, successCount: null, isStabilized: false },
    traits: { personalityTraits: null, ideals: null, bonds: null, flaws: null, appearance: null },
    preferences: {}, configuration: {}, campaign: null, feats: [],
    notes: { personalPossessions: null, backstory: null, otherNotes: null, allies: null, organizations: null },
    actions,
    classes: [{ id: 77, definition: { id: 9, name: className, ...def }, subclassDefinition: null, level: 15, isStartingClass: true, classFeatures: [] }],
    inventory: [],
    modifiers: { race: [], class: [], background: [], item: [], feat: [], condition: [] },
    spells: { race: [], class: [], background: [], item: [], feat: [] },
    classSpells: [{ characterClassId: 77, spells: list }],
  } as unknown as DdbCharacter;
}

const sheet = async (c: DdbCharacter) =>
  (await getCharacter(createMockClient(c), { characterId: 1, detail: "sheet" })).content[0].text;

describe("sheet: class spell list", () => {
  it("lists a Bard's learned spells although D&D Beyond never flags them prepared", async () => {
    const text = await sheet(character("Bard", { knowsAllSpells: false, spellPrepareType: null },
      [spell("Vicious Mockery", 0), spell("Hypnotic Pattern", 3)]));
    expect(text).toContain("Vicious Mockery");
    expect(text).toContain("Hypnotic Pattern");
  });

  it("lists only prepared leveled spells for a Cleric, plus cantrips", async () => {
    const text = await sheet(character("Cleric", { knowsAllSpells: true, spellPrepareType: 1 },
      [spell("Sacred Flame", 0), spell("Bless", 1, { prepared: true }), spell("Harm", 6)]));
    expect(text).toContain("Sacred Flame");
    expect(text).toContain("Bless");
    expect(text).not.toContain("Harm");
  });

  it("lists only prepared spells for a Wizard (adds, then prepares)", async () => {
    const text = await sheet(character("Wizard", { knowsAllSpells: false, spellPrepareType: 1 },
      [spell("Shield", 1, { prepared: true }), spell("Fly", 3)]));
    expect(text).toContain("Shield");
    expect(text).not.toContain("Fly");
  });
});

describe("sheet: feature-granted class spells", () => {
  it("lists a spell a class feature grants although both prepared flags are false", async () => {
    const c = character("Bard", { knowsAllSpells: false }, []);
    c.spells.class = [spell("Counterspell", 3)];
    expect(await sheet(c)).toContain("Counterspell");
  });
});

describe("sheet: duplicates between feature and list", () => {
  it("keeps the prepared list copy when the feature only allows a once-a-day cast", async () => {
    const c = character("Cleric", { knowsAllSpells: true, spellPrepareType: 1 }, [spell("Spirit Guardians", 3, { prepared: true })]);
    c.spells.class = [spell("Spirit Guardians", 3, { usesSpellSlot: false, limitedUse: { maxUses: 1, numberUsed: 0, resetType: 2 } } as Partial<DdbSpell>)];
    const text = await sheet(c);
    expect(text.match(/Spirit Guardians/g)?.length).toBe(2);
  });

  it("drops the list copy when a feature already grants the spell with slots", async () => {
    const c = character("Paladin", { knowsAllSpells: false }, [spell("Find Steed", 2)]);
    c.spells.class = [spell("Find Steed", 2, { usesSpellSlot: true })];
    const text = await sheet(c);
    expect(text.match(/Find Steed/g)?.length).toBe(1);
  });
});

describe("sheet: ability-based resource caps", () => {
  it("derives Bardic Inspiration uses from CHA and names the reset", async () => {
    const actions = { class: [{ name: "Bardic Inspiration", limitedUse: { maxUses: 0, numberUsed: 1, resetType: 1, statModifierUsesId: 6 } }] };
    const text = await sheet(character("Bard", { knowsAllSpells: false }, [], actions));
    // CHA 20 = +5, one used
    expect(text).toContain("Bardic Inspiration: 4/5 (short rest)");
  });
});
