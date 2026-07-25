import { describe, it, expect, vi, beforeEach } from "vitest";
import { searchClassFeatures } from "../../src/tools/reference.js";
import { DdbClient } from "../../src/api/client.js";

// Shaped like the live /game-data/classes payload: features nest flat under
// each class as classFeatures[], keyed requiredLevel (not level) with summary
// (not snippet). The dedicated class-feature/collection endpoint answers 404.
const MOCK_CLASSES = [
  {
    id: 9,
    name: "Barbarian",
    hitDice: 12,
    classFeatures: [
      { id: 1, name: "Rage", description: "<p>You can enter a rage.</p>", summary: "Enter a rage.", requiredLevel: 1 },
      { id: 2, name: "Reckless Attack", description: "<p>Advantage, but.</p>", summary: "Attack recklessly.", requiredLevel: 2 },
      { id: 3, name: "Primal Path", description: "<p>Choose a path.</p>", summary: "Pick a subclass.", requiredLevel: 3 },
      { name: "", description: "nameless", requiredLevel: 1 }, // must be skipped
    ],
  },
  {
    id: 2,
    name: "Bard",
    hitDice: 8,
    classFeatures: [
      { id: 4, name: "Bardic Inspiration", description: "<p>Inspire.</p>", summary: "Hand out a die.", requiredLevel: 1 },
      { id: 5, name: "Ability Score Improvement", description: "<p>ASI.</p>", summary: "Raise a score.", requiredLevel: 4 },
    ],
  },
  { id: 3, name: "Druid", hitDice: 8 }, // no classFeatures key at all
];

describe("searchClassFeatures", () => {
  let mockClient: DdbClient;

  beforeEach(() => {
    mockClient = {
      get: vi.fn().mockResolvedValue(MOCK_CLASSES),
      getRaw: vi.fn(),
    } as unknown as DdbClient;
  });

  it("shouldFlattenFeaturesFromClassesWhenNoFilterGiven", async () => {
    const result = await searchClassFeatures(mockClient, {});

    expect(result.content[0].text).toContain("Class Feature Search Results");
    expect(result.content[0].text).toContain("5 found");
  });

  it("shouldAttachOwningClassNameAndLevel", async () => {
    const result = await searchClassFeatures(mockClient, { name: "rage" });

    expect(result.content[0].text).toContain("**Rage** — Barbarian level 1");
  });

  it("shouldTagFeaturesWithSourceIdToSeparate2014From2024", async () => {
    // Same class name and feature name exist twice in the live catalogue, one
    // per ruleset — without sourceId the two are indistinguishable.
    const dualClient = {
      get: vi.fn().mockResolvedValue([
        { id: 9, name: "Barbarian", sources: [{ sourceId: 1 }], classFeatures: [{ id: 1, name: "Primal Path", description: "2014", requiredLevel: 3 }] },
        { id: 99, name: "Barbarian", sources: [{ sourceId: 145 }], classFeatures: [{ id: 2, name: "Barbarian Subclass", description: "2024", requiredLevel: 3 }] },
      ]),
      getRaw: vi.fn(),
    } as unknown as DdbClient;

    const result = await searchClassFeatures(dualClient, { level: 3 });
    const text = result.content[0].text;

    expect(text).toContain("**Primal Path** — Barbarian level 3 (sourceId: 1)");
    expect(text).toContain("**Barbarian Subclass** — Barbarian level 3 (sourceId: 145)");
  });

  it("shouldFilterByClassName", async () => {
    const result = await searchClassFeatures(mockClient, { className: "bard" });
    const text = result.content[0].text;

    expect(text).toContain("Bardic Inspiration");
    expect(text).not.toContain("Reckless Attack");
  });

  it("shouldFilterByRequiredLevel", async () => {
    const result = await searchClassFeatures(mockClient, { level: 1 });
    const text = result.content[0].text;

    expect(text).toContain("2 found");
    expect(text).toContain("Rage");
    expect(text).toContain("Bardic Inspiration");
  });

  it("shouldSortByClassThenLevel", async () => {
    const result = await searchClassFeatures(mockClient, { className: "barbarian" });
    const text = result.content[0].text;

    expect(text.indexOf("Rage")).toBeLessThan(text.indexOf("Reckless Attack"));
    expect(text.indexOf("Reckless Attack")).toBeLessThan(text.indexOf("Primal Path"));
  });

  it("shouldReportUnavailableCatalogueDistinctlyFromNoMatch", async () => {
    const emptyClient = {
      get: vi.fn().mockResolvedValue([]),
      getRaw: vi.fn(),
    } as unknown as DdbClient;

    const empty = await searchClassFeatures(emptyClient, { name: "rage" });
    const unmatched = await searchClassFeatures(mockClient, { name: "nonexistent" });

    expect(empty.content[0].text).toContain("no class features at all");
    expect(unmatched.content[0].text).toContain("No class features found matching");
  });

  it("shouldNotThrowWhenPayloadIsAnObjectInsteadOfArray", async () => {
    const objectClient = {
      get: vi.fn().mockResolvedValue({ definitionData: [], accessTypes: {} }),
      getRaw: vi.fn(),
    } as unknown as DdbClient;

    const result = await searchClassFeatures(objectClient, { name: "rage" });

    expect(result.content[0].text).toContain("no class features at all");
  });
});
