import { describe, it, expect, vi } from "vitest";
import { getCharacter, listCharacters, fingerprintCharacter } from "../../src/tools/character.js";
import type { DdbClient } from "../../src/api/client.js";
import type { DdbCharacter } from "../../src/types/character.js";

// Extended mock character for testing detail levels
function createDetailedMockCharacter(): DdbCharacter {
  return {
    ...mockCharacter,
    modifiers: {
      ...mockCharacter.modifiers,
      race: [
        { id: "r1", type: "proficiency", subType: "common", value: null, friendlyTypeName: "Proficiency", friendlySubtypeName: "Common", componentId: 1, componentTypeId: 1 },
        { id: "r2", type: "proficiency", subType: "dwarvish", value: null, friendlyTypeName: "Proficiency", friendlySubtypeName: "Dwarvish", componentId: 1, componentTypeId: 1 },
      ],
      class: [
        { id: "c1", type: "proficiency", subType: "light-armor", value: null, friendlyTypeName: "Proficiency", friendlySubtypeName: "Light Armor", componentId: 2, componentTypeId: 2 },
        { id: "c2", type: "proficiency", subType: "martial-weapons", value: null, friendlyTypeName: "Proficiency", friendlySubtypeName: "Martial Weapons", componentId: 2, componentTypeId: 2 },
      ],
    },
    actions: {
      race: [],
      class: [],
      feat: [],
    },
    feats: [
      {
        id: 1,
        definition: {
          id: 101,
          name: "Great Weapon Master",
          description: "<p>You've learned to put the weight of a weapon to your advantage.</p>",
          prerequisite: "Strength 13 or higher",
          sourceId: 1,
        },
        componentId: 1,
        componentTypeId: 12,
      },
    ],
    race: {
      ...mockCharacter.race,
      racialTraits: [
        {
          definition: {
            id: 201,
            name: "Darkvision",
            description: "<p>You can see in dim light within 60 feet.</p>",
            sourceId: 1,
          },
        },
      ],
    },
  };
}

function createMockClient(): DdbClient {
  const client = {
    get: vi.fn(),
    getRaw: vi.fn(),
  } as Record<string, unknown>;
  // getWithMeta delegates to get so existing get mocks keep working; it just
  // wraps the value with freshness metadata (always "live" in tests).
  client.getWithMeta = vi.fn((url: string, key: string, ttl?: number) =>
    (client.get as ReturnType<typeof vi.fn>)(url, key, ttl).then((value: unknown) => ({
      value,
      fromCache: false,
      ageMs: 0,
    }))
  );
  return client as unknown as DdbClient;
}

const mockCharacter: DdbCharacter = {
  id: 12345,
  readonlyUrl: "https://www.dndbeyond.com/characters/12345",
  name: "Thorin Ironforge",
  race: {
    fullName: "Mountain Dwarf",
    baseRaceName: "Dwarf",
    isHomebrew: false,
    racialTraits: [],
  },
  classes: [
    {
      id: 1,
      definition: { name: "Fighter" },
      subclassDefinition: { name: "Battle Master" },
      level: 5,
      isStartingClass: true,
      classFeatures: [],
    },
  ],
  level: 5,
  background: {
    definition: {
      name: "Soldier",
      description: "A veteran warrior",
    },
  },
  stats: [
    { id: 1, value: 16 }, // STR
    { id: 2, value: 14 }, // DEX
    { id: 3, value: 15 }, // CON
    { id: 4, value: 10 }, // INT
    { id: 5, value: 12 }, // WIS
    { id: 6, value: 8 },  // CHA
  ],
  bonusStats: [
    { id: 1, value: 2 }, // +2 STR from race
  ],
  overrideStats: [],
  modifiers: {
    race: [],
    class: [],
    background: [],
    item: [],
    feat: [],
    condition: [],
  },
  baseHitPoints: 42,
  bonusHitPoints: null,
  overrideHitPoints: null,
  removedHitPoints: 10,
  temporaryHitPoints: 5,
  currentXp: 6500,
  alignmentId: 1,
  lifestyleId: 3,
  currencies: {
    cp: 0,
    sp: 50,
    ep: 0,
    gp: 125,
    pp: 2,
  },
  spells: {
    race: [],
    class: [],
    background: [],
    item: [],
    feat: [],
  },
  inventory: [
    {
      id: 1,
      definition: {
        name: "Longsword",
        description: "A versatile blade",
        type: "Weapon",
        rarity: "Common",
        weight: 3,
        cost: 15,
        isHomebrew: false,
      },
      equipped: true,
      quantity: 1,
    },
    {
      id: 2,
      definition: {
        name: "Plate Armor",
        description: "Heavy armor",
        type: "Armor",
        rarity: "Common",
        weight: 65,
        cost: 1500,
        isHomebrew: false,
      },
      equipped: true,
      quantity: 1,
    },
  ],
  deathSaves: {
    failCount: null,
    successCount: null,
    isStabilized: false,
  },
  traits: {
    personalityTraits: "I face problems head-on.",
    ideals: "Honor and duty above all.",
    bonds: "My fellow soldiers are my family.",
    flaws: "I have trouble trusting outsiders.",
    appearance: "Scarred face with a long beard.",
  },
  notes: {
    personalPossessions: null,
    backstory: null,
    otherNotes: null,
    allies: null,
    organizations: null,
  },
  actions: {
    race: [],
    class: [],
    feat: [],
  },
  feats: [],
  preferences: {},
  configuration: {},
  campaign: {
    id: 999,
    name: "Lost Mines of Phandelver",
  },
};

// client.get() auto-unwraps the envelope, so mocks return the inner data directly
// Character lookup-by-name and listing now resolve via getUserId() + the
// /characters/list endpoint, which returns { characters: [...] }.
vi.mock("../../src/api/auth.js", () => ({
  getUserId: vi.fn().mockResolvedValue(2),
}));

const mockUserCharacters = {
  characters: [
    {
      id: 12345,
      name: "Thorin Ironforge",
      level: 5,
      raceName: "Mountain Dwarf",
      classDescription: "Fighter (Battle Master) 5",
      campaignName: "Lost Mines of Phandelver",
    },
  ],
};

describe("getCharacter", () => {
  it("should format character data correctly by ID with summary detail", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValue(mockCharacter);

    const result = await getCharacter(client, { characterId: 12345, detail: "summary" });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const text = result.content[0].text;

    expect(text).toContain("Name: Thorin Ironforge");
    expect(text).toContain("Race: Mountain Dwarf");
    expect(text).toContain("Class: Fighter (Battle Master) 5");
    expect(text).toContain("Level: 5");
    expect(text).toContain("HP: 42/52 (+5 temp)");
    expect(text).toContain("Campaign: Lost Mines of Phandelver");
    expect(text).toContain("Inventory (2 items):");
    expect(text).toContain("Longsword [equipped]");
    expect(text).toContain("Plate Armor [equipped]");
  });

  it("should list unequipped inventory items, marking only equipped ones", async () => {
    const client = createMockClient();
    const charWithPack = {
      ...mockCharacter,
      inventory: [
        ...mockCharacter.inventory,
        {
          id: 3,
          definition: { name: "Map to the Ruins", type: "Gear", rarity: "Common", weight: 0, cost: 0, isHomebrew: false, description: "" },
          equipped: false,
          quantity: 1,
        },
        {
          id: 4,
          definition: { name: "Torch", type: "Gear", rarity: "Common", weight: 1, cost: 0, isHomebrew: false, description: "" },
          equipped: false,
          quantity: 10,
        },
      ],
    } as unknown as DdbCharacter;
    vi.mocked(client.get).mockResolvedValue(charWithPack);

    const text = (await getCharacter(client, { characterId: 12345, detail: "summary" })).content[0].text;

    expect(text).toContain("Inventory (4 items):");
    expect(text).toContain("Map to the Ruins"); // unequipped item is shown
    expect(text).not.toContain("Map to the Ruins [equipped]"); // but not marked equipped
    expect(text).toContain("Torch (x10)"); // quantity shown for unequipped
  });

  it("should format character data correctly by name with summary detail", async () => {
    const client = createMockClient();
    vi.mocked(client.get)
      .mockResolvedValueOnce(mockUserCharacters)     // user character list
      .mockResolvedValueOnce(mockCharacter);         // character data

    const result = await getCharacter(client, { characterName: "Thorin Ironforge", detail: "summary" });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("Name: Thorin Ironforge");
  });

  it("should handle missing character by name", async () => {
    const client = createMockClient();
    vi.mocked(client.get)
      .mockResolvedValue(mockUserCharacters);

    const result = await getCharacter(client, { characterName: "Unknown Hero" });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe('Character "Unknown Hero" not found.');
  });

  it("should handle missing parameters", async () => {
    const client = createMockClient();

    const result = await getCharacter(client, {});

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe("Either characterId or characterName must be provided.");
  });
});

describe("getCharacter - fuzzy name matching", () => {
  it("should handle exact case-insensitive match", async () => {
    const client = createMockClient();
    vi.mocked(client.get)
      .mockResolvedValueOnce(mockUserCharacters)
      .mockResolvedValueOnce(mockCharacter);

    const result = await getCharacter(client, { characterName: "thorin ironforge", detail: "summary" });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("Name: Thorin Ironforge");
  });

  it("should handle substring match", async () => {
    const client = createMockClient();
    vi.mocked(client.get)
      .mockResolvedValueOnce(mockUserCharacters)
      .mockResolvedValueOnce(mockCharacter);

    const result = await getCharacter(client, { characterName: "Thorin", detail: "summary" });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("Name: Thorin Ironforge");
  });

  it("should handle fuzzy match with typo when only one close match", async () => {
    const client = createMockClient();
    vi.mocked(client.get)
      .mockResolvedValueOnce(mockUserCharacters)
      .mockResolvedValueOnce(mockCharacter);

    const result = await getCharacter(client, { characterName: "Throin", detail: "summary" });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("Name: Thorin Ironforge");
  });

  it("should return not found for no close matches", async () => {
    const client = createMockClient();
    vi.mocked(client.get)
      .mockResolvedValue(mockUserCharacters);

    const result = await getCharacter(client, { characterName: "Gandalf" });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe('Character "Gandalf" not found.');
  });
});

describe("getCharacter - campaign roster name fallback", () => {
  it("should resolve a party member by name via the campaign roster", async () => {
    const client = createMockClient();
    vi.mocked(client.get)
      .mockResolvedValueOnce(mockUserCharacters) // own characters — no "Varis"
      .mockResolvedValueOnce([                    // active campaigns
        { id: 101, name: "DND Arbeit", dmId: 1, dmUsername: "dm", playerCount: 3, dateCreated: "1/1/2026" },
      ])
      .mockResolvedValueOnce([                    // campaign 101 roster
        { id: 999, name: "Varis Greenwood", userId: 20, userName: "player2", avatarUrl: "", characterStatus: 1, isAssigned: true },
      ])
      .mockResolvedValueOnce(mockCharacter);      // character data for resolved id

    const result = await getCharacter(client, { characterName: "Varis Greenwood", detail: "summary" });

    // Resolution succeeded (not the not-found path) and fetched the roster-resolved id.
    expect(result.content[0].text).not.toContain("not found");
    const characterFetchCall = vi.mocked(client.get).mock.calls.find((c) =>
      String(c[0]).includes("/999")
    );
    expect(characterFetchCall).toBeDefined();
  });

  it("should not match own-character ids twice via the roster fallback", async () => {
    const client = createMockClient();
    // "Aragorn" matches nothing in own list or roster → not found, exercising the dedupe path.
    vi.mocked(client.get)
      .mockResolvedValueOnce(mockUserCharacters)
      .mockResolvedValueOnce([
        { id: 101, name: "DND Arbeit", dmId: 1, dmUsername: "dm", playerCount: 3, dateCreated: "1/1/2026" },
      ])
      .mockResolvedValueOnce([
        { id: 12345, name: "Thorin Ironforge", userId: 1, userName: "self", avatarUrl: "", characterStatus: 1, isAssigned: true },
      ]);

    const result = await getCharacter(client, { characterName: "Aragorn" });

    expect(result.content[0].text).toBe('Character "Aragorn" not found.');
  });
});

describe("getCharacter with detail levels", () => {
  it("should return summary by detail='summary'", async () => {
    const client = createMockClient();
    const detailedChar = createDetailedMockCharacter();
    vi.mocked(client.get).mockResolvedValue(detailedChar);

    const result = await getCharacter(client, { characterId: 12345, detail: "summary" });
    const text = result.content[0].text;

    // Should contain basic info
    expect(text).toContain("Name: Thorin Ironforge");
    expect(text).toContain("Race: Mountain Dwarf");
    expect(text).toContain("Class: Fighter (Battle Master) 5");
    expect(text).toContain("Level: 5");

    // Should NOT contain detailed sections
    expect(text).not.toContain("--- Saving Throws");
    expect(text).not.toContain("--- Skills");
    expect(text).not.toContain("--- Proficiencies");
  });

  it("should return full sheet by detail='sheet' (default)", async () => {
    const client = createMockClient();
    const detailedChar = createDetailedMockCharacter();
    vi.mocked(client.get).mockResolvedValue(detailedChar);

    // Test with explicit 'sheet'
    const result1 = await getCharacter(client, { characterId: 12345, detail: "sheet" });
    const text1 = result1.content[0].text;

    expect(text1).toContain("=== Thorin Ironforge ===");
    expect(text1).toContain("--- Saving Throws");
    expect(text1).toContain("--- Skills");
    expect(text1).toContain("--- Proficiencies");

    // Test default (no detail param)
    vi.mocked(client.get).mockResolvedValue(detailedChar);
    const result2 = await getCharacter(client, { characterId: 12345 });
    const text2 = result2.content[0].text;

    expect(text2).toContain("=== Thorin Ironforge ===");
    expect(text2).toContain("--- Saving Throws");
  });

  it("should return expanded definitions by detail='full'", async () => {
    const client = createMockClient();
    const detailedChar = createDetailedMockCharacter();
    vi.mocked(client.get).mockResolvedValue(detailedChar);

    const result = await getCharacter(client, { characterId: 12345, detail: "full" });
    const text = result.content[0].text;

    // Should contain sheet sections
    expect(text).toContain("=== Thorin Ironforge ===");
    expect(text).toContain("--- Saving Throws");

    // Should contain expanded definition sections (use === headers)
    expect(text).toContain("=== Feat Definitions ===");
    expect(text).toContain("Great Weapon Master");
    expect(text).toContain("=== Racial Trait Definitions ===");
    expect(text).toContain("Darkvision");
  });

  it("should work with detail parameter and characterName", async () => {
    const client = createMockClient();
    const detailedChar = createDetailedMockCharacter();

    vi.mocked(client.get)
      .mockResolvedValueOnce(mockUserCharacters)
      .mockResolvedValueOnce(detailedChar);

    const result = await getCharacter(client, {
      characterName: "Thorin",
      detail: "summary"
    });
    const text = result.content[0].text;

    expect(text).toContain("Name: Thorin Ironforge");
    expect(text).not.toContain("--- Saving Throws");
  });
});

describe("listCharacters", () => {
  it("should return formatted list of characters", async () => {
    const client = createMockClient();
    vi.mocked(client.get)
      .mockResolvedValueOnce(mockUserCharacters)     // user character list
      .mockResolvedValueOnce(mockCharacter);         // character data

    const result = await listCharacters(client);

    expect(result.content).toHaveLength(1);
    const text = result.content[0].text;
    expect(text).toContain("Characters:");
    expect(text).toContain("Thorin Ironforge - Mountain Dwarf Fighter (Battle Master) 5 (Level 5) - Lost Mines of Phandelver");
  });

  it("should handle no characters", async () => {
    const client = createMockClient();
    vi.mocked(client.get).mockResolvedValue([]);

    const result = await listCharacters(client);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe("No characters found.");
  });
});

describe("fingerprintCharacter", () => {
  it("is stable for identical combat state", () => {
    expect(fingerprintCharacter(mockCharacter)).toBe(fingerprintCharacter(mockCharacter));
  });

  it("changes when HP (removedHitPoints) changes", () => {
    const damaged = { ...mockCharacter, removedHitPoints: mockCharacter.removedHitPoints + 1 };
    expect(fingerprintCharacter(damaged)).not.toBe(fingerprintCharacter(mockCharacter));
  });

  it("does NOT change when only dateModified changes", () => {
    // Regression guard: DDB advances dateModified on sheet touches without HP
    // changing; the fingerprint must not treat that as a combat-state change.
    const reEdited = { ...mockCharacter, dateModified: "2099-01-01T00:00:00Z" };
    expect(fingerprintCharacter(reEdited)).toBe(fingerprintCharacter(mockCharacter));
  });
});
