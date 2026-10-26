import { describe, it, expect, vi } from "vitest";
import { manageSpells } from "../../src/tools/character.js";
import type { DdbClient } from "../../src/api/client.js";

const ET = 435869154;

function spell(name: string, level: number, id: number, defId: number, extra: Record<string, unknown> = {}) {
  return { id, entityTypeId: ET, definition: { id: defId, name, level }, prepared: false, alwaysPrepared: false, ...extra };
}

function character(classDef: Record<string, unknown>, owned: unknown[], classes?: unknown[]) {
  return {
    id: 1,
    name: "Hero",
    campaign: { id: 77, name: "C" },
    classes: classes ?? [{ id: 500, level: 15, definition: { id: 900, name: "Cleric", canCastSpells: true, ...classDef } }],
    classSpells: [{ characterClassId: 500, spells: owned }],
  };
}

function mockClient(char: unknown, lists: { learnable?: unknown[]; full?: unknown[] } = {}) {
  return {
    get: vi.fn(async (url: string) => {
      if (url.includes("/game-data/spells")) return lists.learnable ?? [];
      if (url.includes("/game-data/always-known-spells")) return lists.full ?? [];
      return char;
    }),
    put: vi.fn().mockResolvedValue(""),
    post: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue(""),
    invalidateCache: vi.fn(),
  } as unknown as DdbClient & { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
}

describe("manageSpells", () => {
  it("prepares a levelled spell from the full list for knowsAllSpells classes", async () => {
    const client = mockClient(character({ knowsAllSpells: true }, []), {
      full: [spell("Spirit Guardians", 3, 21172091, 2619078)],
    });

    const result = await manageSpells(client, { characterId: 1, learn: ["spirit guardians"] });

    expect(client.put).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/spell/prepared"),
      { characterId: 1, characterClassId: 500, spellId: 2619078, id: 21172091, entityTypeId: ET, prepared: true },
      ["character:1"]
    );
    expect(client.post).not.toHaveBeenCalled();
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining("campaignId=77"), expect.any(String), expect.any(Number));
    expect(result.content[0].text).toContain("+ Spirit Guardians: prepared");
  });

  it("adds a cantrip for knowsAllSpells classes instead of preparing it", async () => {
    const client = mockClient(character({ knowsAllSpells: true }, []), {
      full: [spell("Light", 0, 11, 101)],
      learnable: [spell("Light", 0, 11, 101)],
    });

    await manageSpells(client, { characterId: 1, learn: ["Light"] });

    expect(client.post).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/spell"),
      { characterId: 1, characterClassId: 500, spellId: 101, id: 11, entityTypeId: ET },
      ["character:1"]
    );
    expect(client.put).not.toHaveBeenCalled();
  });

  it("adds the spell to the list for list-based casters", async () => {
    const client = mockClient(character({ name: "Warlock", knowsAllSpells: false, spellPrepareType: null }, []), {
      learnable: [spell("Counterspell", 3, 21172061, 2619072)],
    });

    const result = await manageSpells(client, { characterId: 1, learn: ["Counterspell"] });

    expect(client.post).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/spell"),
      { characterId: 1, characterClassId: 500, spellId: 2619072, id: 21172061, entityTypeId: ET },
      ["character:1"]
    );
    expect(client.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("+ Counterspell: added");
  });

  it("adds and then prepares for classes that prepare from their list", async () => {
    const client = mockClient(character({ name: "Wizard", knowsAllSpells: false, spellPrepareType: 1 }, []), {
      learnable: [spell("Shield", 1, 31, 301)],
    });

    const result = await manageSpells(client, { characterId: 1, learn: ["Shield"] });

    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.put).toHaveBeenCalledWith(
      expect.stringContaining("/spell/prepared"),
      expect.objectContaining({ spellId: 301, prepared: true }),
      ["character:1"]
    );
    expect(result.content[0].text).toContain("added and prepared");
  });

  it("does nothing for a spell already on the sheet", async () => {
    const client = mockClient(character({ knowsAllSpells: false }, [spell("Hex", 1, 41, 401)]));

    const result = await manageSpells(client, { characterId: 1, learn: ["Hex"] });

    expect(client.post).not.toHaveBeenCalled();
    expect(client.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("= Hex: already on the sheet");
  });

  it("prepares an owned but unprepared spell for knowsAllSpells classes", async () => {
    const client = mockClient(character({ knowsAllSpells: true }, [spell("Bless", 1, 51, 501)]));

    await manageSpells(client, { characterId: 1, learn: ["Bless"] });

    expect(client.put).toHaveBeenCalledWith(
      expect.stringContaining("/spell/prepared"),
      expect.objectContaining({ spellId: 501, id: 51, prepared: true }),
      ["character:1"]
    );
  });

  it("removes a known spell with DELETE", async () => {
    const client = mockClient(character({ knowsAllSpells: false }, [spell("Charm Person", 1, 61, 601)]));

    const result = await manageSpells(client, { characterId: 1, forget: ["Charm Person"] });

    expect(client.delete).toHaveBeenCalledWith(
      expect.stringContaining("/character/v5/spell"),
      { characterId: 1, characterClassId: 500, spellId: 601, id: 61, entityTypeId: ET },
      ["character:1"]
    );
    expect(result.content[0].text).toContain("- Charm Person: removed");
  });

  it("unprepares instead of deleting for knowsAllSpells classes", async () => {
    const client = mockClient(character({ knowsAllSpells: true }, [spell("Sanctuary", 1, 71, 701, { prepared: true })]));

    const result = await manageSpells(client, { characterId: 1, forget: ["Sanctuary"] });

    expect(client.delete).not.toHaveBeenCalled();
    expect(client.put).toHaveBeenCalledWith(
      expect.stringContaining("/spell/prepared"),
      expect.objectContaining({ spellId: 701, prepared: false }),
      ["character:1"]
    );
    expect(result.content[0].text).toContain("- Sanctuary: unprepared");
  });

  it("leaves always-prepared spells alone", async () => {
    const client = mockClient(character({ knowsAllSpells: true }, [spell("Revivify", 3, 81, 801, { alwaysPrepared: true })]));

    const result = await manageSpells(client, { characterId: 1, forget: ["Revivify"] });

    expect(client.put).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("always prepared");
  });

  it("reports unknown names with a suggestion and writes nothing", async () => {
    const client = mockClient(character({ knowsAllSpells: false }, []), {
      learnable: [spell("Counterspell", 3, 21172061, 2619072)],
    });

    const result = await manageSpells(client, { characterId: 1, learn: ["Counterspel"] });

    expect(client.post).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("x Counterspel");
    expect(result.content[0].text).toContain("Did you mean: Counterspell?");
  });

  it("asks for classMappingId on multiclass characters", async () => {
    const classes = [
      { id: 500, level: 5, definition: { id: 900, name: "Cleric", canCastSpells: true } },
      { id: 501, level: 5, definition: { id: 901, name: "Wizard", canCastSpells: true } },
    ];
    const client = mockClient(character({}, [], classes));

    const result = await manageSpells(client, { characterId: 1, learn: ["Bless"] });

    expect(client.put).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Cleric = 500");
    expect(result.content[0].text).toContain("Wizard = 501");
  });

  it("reports counts against the class maximum", async () => {
    const client = mockClient(
      character(
        { name: "Bard", knowsAllSpells: false, spellRules: { levelCantripsKnownMaxes: Array(21).fill(4), levelSpellKnownMaxes: Array(21).fill(18) } },
        [spell("Vicious Mockery", 0, 1, 1), spell("Healing Word", 1, 2, 2)]
      )
    );

    const result = await manageSpells(client, { characterId: 1, learn: ["Healing Word"] });

    expect(result.content[0].text).toContain("1/4 cantrips, 1/18 known spells");
  });
});
