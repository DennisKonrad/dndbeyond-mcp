import { describe, it, expect, vi, beforeEach } from "vitest";
import { searchRacialTraits } from "../../src/tools/reference.js";
import { DdbClient } from "../../src/api/client.js";

// Shaped like the live /game-data/races payload: traits nest under each race as
// { definition: {...} }. The dedicated racial-trait/collection endpoint returns
// an empty catalogue, so races is the only source.
const MOCK_RACES = [
  {
    entityRaceId: 1,
    fullName: "Dwarf",
    baseName: "Dwarf",
    racialTraits: [
      { definition: { id: 10, name: "Darkvision", description: "<p>Range 120 feet.</p>", snippet: "See in the dark." } },
      { definition: { id: 11, name: "Stonecunning", description: "<p>Tremorsense 60 feet.</p>", snippet: "Feel the stone." } },
      { definition: undefined }, // entries without a definition must be skipped
    ],
  },
  {
    entityRaceId: 2,
    fullName: "Elf",
    baseName: "Elf",
    racialTraits: [
      { definition: { id: 20, name: "Darkvision", description: "<p>Range 60 feet.</p>", snippet: "See in the dark." } },
      { definition: { id: 21, name: "Keen Senses", description: "<p>Perception.</p>", snippet: "Sharp eyes." } },
    ],
  },
  { entityRaceId: 3, fullName: "Human", baseName: "Human" }, // no racialTraits key at all
];

describe("searchRacialTraits", () => {
  let mockClient: DdbClient;

  beforeEach(() => {
    mockClient = {
      get: vi.fn().mockResolvedValue(MOCK_RACES),
      getRaw: vi.fn(),
    } as unknown as DdbClient;
  });

  it("shouldFlattenTraitsFromRacesWhenNoFilterGiven", async () => {
    const result = await searchRacialTraits(mockClient, {});

    expect(result.content[0].text).toContain("Racial Trait Search Results");
    expect(result.content[0].text).toContain("4 found");
    expect(result.content[0].text).toContain("Stonecunning");
  });

  it("shouldAttachOwningRaceNameToEachTrait", async () => {
    const result = await searchRacialTraits(mockClient, { name: "stonecunning" });

    expect(result.content[0].text).toContain("**Stonecunning** — Dwarf");
  });

  it("shouldFilterByRaceName", async () => {
    const result = await searchRacialTraits(mockClient, { raceName: "elf" });
    const text = result.content[0].text;

    expect(text).toContain("Keen Senses");
    expect(text).not.toContain("Stonecunning");
  });

  it("shouldMatchSameTraitNameAcrossMultipleRaces", async () => {
    const result = await searchRacialTraits(mockClient, { name: "darkvision" });

    expect(result.content[0].text).toContain("2 found");
  });

  it("shouldReportUnavailableCatalogueDistinctlyFromNoMatch", async () => {
    const emptyClient = {
      get: vi.fn().mockResolvedValue([]),
      getRaw: vi.fn(),
    } as unknown as DdbClient;

    const empty = await searchRacialTraits(emptyClient, { name: "darkvision" });
    const unmatched = await searchRacialTraits(mockClient, { name: "nonexistent" });

    expect(empty.content[0].text).toContain("no racial traits at all");
    expect(unmatched.content[0].text).toContain("No racial traits found matching");
  });

  it("shouldNotThrowWhenCollectionIsAnObjectInsteadOfArray", async () => {
    // The regression that caused "matched.filter is not a function": the old
    // code fed a non-array payload straight into Array.prototype.filter.
    const objectClient = {
      get: vi.fn().mockResolvedValue({ definitionData: [], accessTypes: {} }),
      getRaw: vi.fn(),
    } as unknown as DdbClient;

    const result = await searchRacialTraits(objectClient, { name: "darkvision" });

    expect(result.content[0].text).toContain("no racial traits at all");
  });
});
