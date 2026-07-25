import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateHp, updateSpellSlots, updateDeathSaves, updateCurrency, useAbility, addPartyInventoryItem, removePartyInventoryItem, updatePartyInventoryItem, setXp, removeInventoryItem, updateCustomItem } from "../../src/tools/character.js";
import type { DdbClient } from "../../src/api/client.js";
import type { DdbCharacter } from "../../src/types/character.js";

const mockCharacter: DdbCharacter = {
  id: 123,
  readonlyUrl: "https://example.com",
  name: "Test Character",
  race: { fullName: "Human", baseRaceName: "Human", isHomebrew: false },
  classes: [
    {
      id: 1,
      definition: { name: "Fighter" },
      subclassDefinition: null,
      level: 5,
      isStartingClass: true,
    },
  ],
  level: 5,
  background: { definition: null },
  stats: [
    { id: 1, value: 16 },
    { id: 2, value: 14 },
    { id: 3, value: 15 },
    { id: 4, value: 10 },
    { id: 5, value: 12 },
    { id: 6, value: 8 },
  ],
  bonusStats: [],
  overrideStats: [],
  modifiers: {
    race: [],
    class: [],
    background: [],
    item: [],
    feat: [],
    condition: [],
  },
  baseHitPoints: 40,
  bonusHitPoints: 5,
  overrideHitPoints: null,
  removedHitPoints: 10,
  temporaryHitPoints: 0,
  currentXp: 6500,
  alignmentId: 1,
  lifestyleId: 1,
  currencies: { cp: 0, sp: 0, ep: 0, gp: 100, pp: 0 },
  spells: {
    race: [],
    class: [],
    background: [],
    item: [],
    feat: [],
  },
  inventory: [],
  deathSaves: { failCount: 0, successCount: 0, isStabilized: false },
  traits: {
    personalityTraits: null,
    ideals: null,
    bonds: null,
    flaws: null,
    appearance: null,
  },
  preferences: {},
  configuration: {},
  campaign: null,
};

// Character with actions for useAbility tests
const mockCharacterWithActions: DdbCharacter = {
  ...mockCharacter,
  actions: {
    class: [
      {
        id: 100,
        entityTypeId: 200,
        name: "Action Surge",
        limitedUse: {
          maxUses: 1,
          numberUsed: 0,
          resetTypeDescription: "Short Rest",
        },
      },
    ],
  },
};

describe("updateHp", () => {
  let mockClient: DdbClient;

  beforeEach(() => {
    mockClient = {
      get: vi.fn().mockResolvedValue(mockCharacter),
      getRaw: vi.fn(),
      put: vi.fn().mockResolvedValue({}),
      invalidateCache: vi.fn(),
    } as unknown as DdbClient;
  });

  it("should heal character when hpChange is positive", async () => {
    const result = await updateHp(mockClient, {
      characterId: 123,
      hpChange: 10,
    });

    expect(mockClient.put).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/life/hp/damage-taken"),
      { characterId: 123, removedHitPoints: 0, temporaryHitPoints: 0 },
      ["character:123"]
    );
    expect(result.content[0].text).toContain("Healed Test Character for 10 HP");
  });

  it("invalidates the cache before reading so the delta is off the live HP", async () => {
    await updateHp(mockClient, { characterId: 123, hpChange: -5 });
    expect(mockClient.invalidateCache).toHaveBeenCalledWith("character:123");
  });

  it("should damage character when hpChange is negative", async () => {
    const result = await updateHp(mockClient, {
      characterId: 123,
      hpChange: -5,
    });

    expect(mockClient.put).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/life/hp/damage-taken"),
      { characterId: 123, removedHitPoints: 15, temporaryHitPoints: 0 },
      ["character:123"]
    );
    expect(result.content[0].text).toContain("Damaged Test Character for 5 HP");
  });

  it("should not allow negative HP", async () => {
    await updateHp(mockClient, {
      characterId: 123,
      hpChange: -100,
    });

    expect(mockClient.put).toHaveBeenCalledWith(
      expect.anything(),
      { characterId: 123, removedHitPoints: 55, temporaryHitPoints: 0 },
      expect.anything()
    );
  });
});

describe("setXp", () => {
  it("PUTs currentXp to the progression endpoint and invalidates cache", async () => {
    const mockClient = { put: vi.fn().mockResolvedValue({}) } as unknown as DdbClient;

    const result = await setXp(mockClient, { characterId: 123, xp: 1545 });

    expect(mockClient.put).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/character/progression"),
      { characterId: 123, currentXp: 1545 },
      ["character:123"]
    );
    expect(result.content[0].text).toContain("Set XP to 1545");
  });
});

describe("removeInventoryItem", () => {
  it("DELETEs the entry by id after validating it exists", async () => {
    const mockClient = {
      get: vi.fn().mockResolvedValue({ inventory: [{ id: 555, definition: { name: "Fire Opal" } }] }),
      delete: vi.fn().mockResolvedValue({}),
      invalidateCache: vi.fn(),
    } as unknown as DdbClient;

    const result = await removeInventoryItem(mockClient, { characterId: 123, itemId: 555 });

    expect(mockClient.delete).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/inventory/item"),
      { characterId: 123, id: 555 },
      ["character:123"]
    );
    expect(result.content[0].text).toContain('Removed "Fire Opal"');
  });

  it("routes custom items to the custom-item endpoint", async () => {
    // The plain inventory delete only drops the mapping; the definition stays
    // and D&D Beyond re-creates the entry, so the item silently survives.
    const mockClient = {
      get: vi.fn().mockResolvedValue({
        inventory: [{ id: 555, definition: { id: 35678564, name: "Goodberry", isCustomItem: true } }],
      }),
      delete: vi.fn().mockResolvedValue({}),
      invalidateCache: vi.fn(),
    } as unknown as DdbClient;

    await removeInventoryItem(mockClient, { characterId: 123, itemId: 555 });

    expect(mockClient.delete).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/custom/item"),
      { characterId: 123, id: 35678564, mappingId: 555 },
      ["character:123"]
    );
  });

  it("does not DELETE when the entry id is absent", async () => {
    const mockClient = {
      get: vi.fn().mockResolvedValue({ inventory: [{ id: 999, definition: { name: "Other" } }] }),
      delete: vi.fn().mockResolvedValue({}),
      invalidateCache: vi.fn(),
    } as unknown as DdbClient;

    const result = await removeInventoryItem(mockClient, { characterId: 123, itemId: 555 });

    expect(mockClient.delete).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("No inventory item with entry id 555");
  });
});

describe("updateCustomItem", () => {
  // Entry id 555 is the inventory line; definition id 35677399 is what the
  // write endpoint takes. Conflating the two is the obvious failure mode.
  const CUSTOM_ENTRY = {
    id: 555,
    quantity: 2,
    definition: {
      id: 35677399,
      name: "Heiltrank (1W4+2)",
      description: "Heilt 1W4+2 TP.",
      weight: 0.5,
      cost: 25,
      isCustomItem: true,
    },
  };

  function makeClient(inventory: unknown[] = [CUSTOM_ENTRY]): DdbClient {
    return {
      get: vi.fn().mockResolvedValue({ inventory }),
      put: vi.fn().mockResolvedValue({}),
      invalidateCache: vi.fn(),
    } as unknown as DdbClient;
  }

  it("PUTs the DEFINITION id, not the inventory entry id", async () => {
    const mockClient = makeClient();

    await updateCustomItem(mockClient, { characterId: 123, itemId: 555, name: "Heiltrank (1W12+6)" });

    expect(mockClient.put).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/custom/item"),
      expect.objectContaining({ characterId: 123, id: 35677399 }),
      ["character:123"]
    );
  });

  it("preserves unspecified fields from the current item", async () => {
    const mockClient = makeClient();

    await updateCustomItem(mockClient, { characterId: 123, itemId: 555, name: "Heiltrank (1W12+6)" });

    expect(mockClient.put).toHaveBeenCalledWith(
      expect.anything(),
      {
        characterId: 123,
        id: 35677399,
        name: "Heiltrank (1W12+6)",
        description: "Heilt 1W4+2 TP.",
        quantity: 2,
        weight: 0.5,
        cost: 25,
      },
      ["character:123"]
    );
  });

  it("resolves the entry by name when no id is given", async () => {
    const mockClient = makeClient();

    const result = await updateCustomItem(mockClient, { characterId: 123, itemName: "heiltrank (1w4+2)", quantity: 3 });

    expect(mockClient.put).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 35677399, quantity: 3 }),
      ["character:123"]
    );
    expect(result.content[0].text).toContain("entry 555");
  });

  it("resolves a bare name against a parenthetical suffix", async () => {
    // "Heiltrank" vs "Heiltrank (1W4+2)" is edit-distance 8 — far outside the
    // fuzzy threshold, so substring matching has to carry this case.
    const mockClient = makeClient();

    await updateCustomItem(mockClient, { characterId: 123, itemName: "Heiltrank", quantity: 1 });

    expect(mockClient.put).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 35677399 }),
      ["character:123"]
    );
  });

  it("reports ambiguity instead of guessing between substring matches", async () => {
    const mockClient = makeClient([
      CUSTOM_ENTRY,
      { id: 556, quantity: 1, definition: { id: 2, name: "Heiltrank (groß)", isCustomItem: true } },
    ]);

    const result = await updateCustomItem(mockClient, { characterId: 123, itemName: "Heiltrank", quantity: 1 });

    expect(mockClient.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("is ambiguous");
    expect(result.content[0].text).toContain("Heiltrank (groß)");
  });

  it("still tolerates a typo via fuzzy matching", async () => {
    const mockClient = makeClient([
      { id: 558, quantity: 1, definition: { id: 3, name: "Bierkrug", isCustomItem: true } },
    ]);

    await updateCustomItem(mockClient, { characterId: 123, itemName: "Bierkug", quantity: 2 });

    expect(mockClient.put).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 3, quantity: 2 }),
      ["character:123"]
    );
  });

  it("refuses to edit an item that is not custom", async () => {
    const mockClient = makeClient([
      { id: 777, quantity: 1, definition: { id: 12, name: "Greatsword", isCustomItem: false } },
    ]);

    const result = await updateCustomItem(mockClient, { characterId: 123, itemId: 777, name: "Nope" });

    expect(mockClient.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("is not a custom item");
  });

  it("does not PUT when the item cannot be found", async () => {
    const mockClient = makeClient();

    const result = await updateCustomItem(mockClient, { characterId: 123, itemId: 999, name: "Nope" });

    expect(mockClient.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("No inventory item with entry id 999");
  });

  it("requires either itemId or itemName", async () => {
    const mockClient = makeClient();

    const result = await updateCustomItem(mockClient, { characterId: 123, name: "Nope" });

    expect(mockClient.get).not.toHaveBeenCalled();
    expect(mockClient.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Pass either itemId");
  });
});

describe("updateSpellSlots", () => {
  let mockClient: DdbClient;

  beforeEach(() => {
    mockClient = {
      put: vi.fn().mockResolvedValue({}),
    } as unknown as DdbClient;
  });

  it("should update spell slots for valid level", async () => {
    const result = await updateSpellSlots(mockClient, {
      characterId: 123,
      level: 3,
      used: 2,
    });

    expect(mockClient.put).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/character/123/spell/slots"),
      { level: 3, used: 2 },
      ["character:123"]
    );
    expect(result.content[0].text).toContain("Updated level 3 spell slots to 2 used");
  });

  it("should reject invalid spell level below 1", async () => {
    const result = await updateSpellSlots(mockClient, {
      characterId: 123,
      level: 0,
      used: 1,
    });

    expect(mockClient.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Spell slot level must be between 1 and 9");
  });

  it("should reject invalid spell level above 9", async () => {
    const result = await updateSpellSlots(mockClient, {
      characterId: 123,
      level: 10,
      used: 1,
    });

    expect(mockClient.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Spell slot level must be between 1 and 9");
  });

  it("should reject negative used slots", async () => {
    const result = await updateSpellSlots(mockClient, {
      characterId: 123,
      level: 1,
      used: -1,
    });

    expect(mockClient.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Used spell slots cannot be negative");
  });
});

describe("updateDeathSaves", () => {
  let mockClient: DdbClient;

  beforeEach(() => {
    mockClient = {
      put: vi.fn().mockResolvedValue({}),
    } as unknown as DdbClient;
  });

  it("should update success death saves", async () => {
    const result = await updateDeathSaves(mockClient, {
      characterId: 123,
      type: "success",
      count: 2,
    });

    expect(mockClient.put).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/character/123/life/death-saves"),
      { successCount: 2 },
      ["character:123"]
    );
    expect(result.content[0].text).toContain("Updated death saves: 2 successes");
  });

  it("should update failure death saves", async () => {
    const result = await updateDeathSaves(mockClient, {
      characterId: 123,
      type: "failure",
      count: 1,
    });

    expect(mockClient.put).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/character/123/life/death-saves"),
      { failCount: 1 },
      ["character:123"]
    );
    expect(result.content[0].text).toContain("Updated death saves: 1 failure");
  });

  it("should reject invalid type", async () => {
    const result = await updateDeathSaves(mockClient, {
      characterId: 123,
      type: "invalid" as "success",
      count: 1,
    });

    expect(mockClient.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Death save type must be 'success' or 'failure'");
  });

  it("should reject count below 0", async () => {
    const result = await updateDeathSaves(mockClient, {
      characterId: 123,
      type: "success",
      count: -1,
    });

    expect(mockClient.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Death save count must be between 0 and 3");
  });

  it("should reject count above 3", async () => {
    const result = await updateDeathSaves(mockClient, {
      characterId: 123,
      type: "success",
      count: 4,
    });

    expect(mockClient.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Death save count must be between 0 and 3");
  });
});

describe("updateCurrency", () => {
  let mockClient: DdbClient;

  beforeEach(() => {
    mockClient = {
      // Currency writes read current values first, then PUT the full set.
      get: vi.fn().mockResolvedValue({ currencies: { cp: 0, sp: 0, gp: 0, ep: 0, pp: 0 } }),
      put: vi.fn().mockResolvedValue({}),
    } as unknown as DdbClient;
  });

  it("should update gold pieces", async () => {
    const result = await updateCurrency(mockClient, {
      characterId: 123,
      currency: "gp",
      amount: 150,
    });

    expect(mockClient.put).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/inventory/currency"),
      { characterId: 123, cp: 0, sp: 0, gp: 150, ep: 0, pp: 0 },
      ["character:123"]
    );
    expect(result.content[0].text).toContain("Set GP to 150");
  });

  it("should update all currency types", async () => {
    const currencies = ["cp", "sp", "ep", "gp", "pp"] as const;

    for (const currency of currencies) {
      await updateCurrency(mockClient, {
        characterId: 123,
        currency,
        amount: 10,
      });

      expect(mockClient.put).toHaveBeenCalledWith(
        expect.stringContaining("/character/v5/inventory/currency"),
        expect.objectContaining({ characterId: 123, [currency]: 10 }),
        ["character:123"]
      );
    }
  });

  it("should reject invalid currency type", async () => {
    const result = await updateCurrency(mockClient, {
      characterId: 123,
      currency: "invalid" as "gp",
      amount: 100,
    });

    expect(mockClient.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Currency must be one of: cp, sp, ep, gp, pp");
  });
});

describe("useAbility", () => {
  let mockClient: DdbClient;

  beforeEach(() => {
    mockClient = {
      get: vi.fn().mockResolvedValue(mockCharacterWithActions),
      getRaw: vi.fn(),
      put: vi.fn().mockResolvedValue({}),
    } as unknown as DdbClient;
  });

  it("should use a limited ability", async () => {
    const result = await useAbility(mockClient, {
      characterId: 123,
      abilityName: "Action Surge",
    });

    expect(mockClient.get).toHaveBeenCalled();
    expect(mockClient.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        characterId: 123,
        id: "100",
        entityTypeId: "200",
        uses: 1,
      }),
      ["character:123"]
    );
    expect(result.content[0].text).toContain("Action Surge");
    expect(result.content[0].text).toContain("1/1 uses expended");
  });

  it("should reject empty ability name", async () => {
    const result = await useAbility(mockClient, {
      characterId: 123,
      abilityName: "",
    });

    expect(mockClient.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Ability name cannot be empty");
  });

  it("should reject whitespace-only ability name", async () => {
    const result = await useAbility(mockClient, {
      characterId: 123,
      abilityName: "   ",
    });

    expect(mockClient.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Ability name cannot be empty");
  });
});

describe("updateHp with temporary HP", () => {
  let mockClient: DdbClient;

  beforeEach(() => {
    mockClient = {
      get: vi.fn().mockResolvedValue(mockCharacter),
      getRaw: vi.fn(),
      put: vi.fn().mockResolvedValue({}),
      invalidateCache: vi.fn(),
    } as unknown as DdbClient;
  });

  it("should include temporaryHitPoints in PUT body when tempHp is provided", async () => {
    const result = await updateHp(mockClient, {
      characterId: 123,
      hpChange: 5,
      tempHp: 10,
    });

    expect(mockClient.put).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/life/hp/damage-taken"),
      { characterId: 123, removedHitPoints: 5, temporaryHitPoints: 10 },
      ["character:123"]
    );
    expect(result.content[0].text).toContain("(10 temp HP)");
  });

  it("sends the character's current temporaryHitPoints when tempHp is undefined", async () => {
    // temporaryHitPoints is required by the endpoint; when the caller omits it
    // we must still send the current value (here 0) rather than dropping it.
    await updateHp(mockClient, {
      characterId: 123,
      hpChange: 5,
    });

    expect(mockClient.put).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/life/hp/damage-taken"),
      { characterId: 123, removedHitPoints: 5, temporaryHitPoints: 0 },
      ["character:123"]
    );
  });

  it("should set temporaryHitPoints to 0 when tempHp is 0", async () => {
    const result = await updateHp(mockClient, {
      characterId: 123,
      hpChange: 0,
      tempHp: 0,
    });

    expect(mockClient.put).toHaveBeenCalledWith(
      expect.anything(),
      { characterId: 123, removedHitPoints: 10, temporaryHitPoints: 0 },
      ["character:123"]
    );
    expect(result.content[0].text).toContain("(0 temp HP)");
  });
});

describe("addPartyInventoryItem", () => {
  let mockClient: DdbClient;

  beforeEach(() => {
    mockClient = {
      post: vi.fn().mockResolvedValue({}),
    } as unknown as DdbClient;
  });

  it("should POST a custom item with party-container fields", async () => {
    const result = await addPartyInventoryItem(mockClient, {
      campaignId: 7869524,
      characterId: 167132826,
      name: "Bierfass",
      description: "Ein Fass Bier mit 15 Litern feinstem Bier",
      notes: "15L",
      weight: 15,
    });

    expect(mockClient.post).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5.1/custom/item"),
      {
        characterId: 167132826,
        name: "Bierfass",
        description: "Ein Fass Bier mit 15 Litern feinstem Bier",
        notes: "15L",
        quantity: 1,
        weight: 15,
        cost: null,
        containerEntityId: 7869524,
        containerEntityTypeId: 618115330,
        partyId: 7869524,
      },
      ["campaign:7869524:party-inventory"]
    );
    expect(result.content[0].text).toContain('Added "Bierfass" (x1) to the party inventory of campaign 7869524.');
  });

  it("should default quantity to 1 and weight/cost to null", async () => {
    await addPartyInventoryItem(mockClient, {
      campaignId: 101,
      characterId: 1,
      name: "Torch",
    });

    expect(mockClient.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ quantity: 1, weight: null, cost: null, description: "", notes: "" }),
      ["campaign:101:party-inventory"]
    );
  });
});

describe("removePartyInventoryItem", () => {
  let mockClient: DdbClient;

  beforeEach(() => {
    mockClient = {
      get: vi.fn().mockResolvedValue({
        partyItems: [
          { id: 1045140860, quantity: 1, definition: { id: 35675440, name: "Bierfass" } },
          { id: 1045134207, quantity: 1, definition: { id: 391, name: "Map" } },
        ],
      }),
      delete: vi.fn().mockResolvedValue({}),
      invalidateCache: vi.fn(),
    } as unknown as DdbClient;
  });

  it("should DELETE using the entry id as mappingId and definition id as id", async () => {
    const result = await removePartyInventoryItem(mockClient, {
      campaignId: 7869524,
      characterId: 167132826,
      itemId: 1045140860,
    });

    // Mutable shared state is re-read fresh before deciding what to delete.
    expect(mockClient.invalidateCache).toHaveBeenCalledWith("campaign:7869524:party-inventory");
    expect(mockClient.delete).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5.1/custom/item"),
      {
        characterId: 167132826,
        id: 35675440,
        mappingId: 1045140860,
        partyId: 7869524,
      },
      ["campaign:7869524:party-inventory"]
    );
    expect(result.content[0].text).toContain('Removed "Bierfass"');
  });

  it("should not call delete when the item id is not in the party inventory", async () => {
    const result = await removePartyInventoryItem(mockClient, {
      campaignId: 7869524,
      characterId: 167132826,
      itemId: 999999,
    });

    expect(mockClient.delete).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("No party-inventory item with id 999999");
  });
});

describe("updatePartyInventoryItem", () => {
  let mockClient: DdbClient;

  beforeEach(() => {
    mockClient = {
      get: vi.fn().mockResolvedValue({
        partyItems: [
          {
            id: 1045149692,
            quantity: 1,
            definition: { id: 35675618, name: "Bierfass", weight: 39, cost: null, description: "Ein Fass Bier" },
          },
        ],
      }),
      put: vi.fn().mockResolvedValue({}),
      invalidateCache: vi.fn(),
    } as unknown as DdbClient;
  });

  it("should PUT only changed fields and preserve the rest from the current item", async () => {
    const result = await updatePartyInventoryItem(mockClient, {
      campaignId: 7869524,
      characterId: 167132826,
      itemId: 1045149692,
      weight: 40,
    });

    expect(mockClient.invalidateCache).toHaveBeenCalledWith("campaign:7869524:party-inventory");
    expect(mockClient.put).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5.1/custom/item"),
      {
        characterId: 167132826,
        id: 35675618,
        mappingId: 1045149692,
        partyId: 7869524,
        name: "Bierfass",          // preserved
        weight: 40,                 // changed
        cost: null,                 // preserved
        quantity: 1,                // preserved
        description: "Ein Fass Bier", // preserved
        notes: "",                  // not readable -> empty unless supplied
      },
      ["campaign:7869524:party-inventory"]
    );
    expect(result.content[0].text).toContain('Updated "Bierfass"');
  });

  it("should not call put when the item id is not present", async () => {
    const result = await updatePartyInventoryItem(mockClient, {
      campaignId: 7869524,
      characterId: 167132826,
      itemId: 111,
      weight: 10,
    });

    expect(mockClient.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("No party-inventory item with id 111");
  });
});
