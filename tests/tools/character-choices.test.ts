import { describe, it, expect, vi } from "vitest";
import { getCharacterChoices } from "../../src/tools/character.js";
import type { DdbClient } from "../../src/api/client.js";
import type { DdbCharacter } from "../../src/types/character.js";

// getCharacterChoices reads char.classes, char.feats, and the loosely-typed
// char.choices / char.options. We build minimal fixtures and cast to DdbCharacter.
function makeChar(parts: Record<string, unknown>): DdbCharacter {
  return { name: "Test Hero", classes: [], feats: [], ...parts } as unknown as DdbCharacter;
}

function clientReturning(char: unknown): DdbClient {
  return { get: vi.fn().mockResolvedValue(char), getRaw: vi.fn() } as unknown as DdbClient;
}

async function run(char: unknown): Promise<string> {
  const res = await getCharacterChoices(clientReturning(char), { characterId: 1 });
  return res.content[0].text;
}

describe("getCharacterChoices", () => {
  it("shows resolved value, owning class ids, and full option list for a class choice", async () => {
    const text = await run(
      makeChar({
        classes: [{ definition: { id: 9, name: "Barbarian" }, id: 500, classFeatures: [{ definition: { id: 10 } }] }],
        choices: {
          choiceDefinitions: [
            { id: "100-2", options: [{ id: 6105, label: "Athletics" }, { id: 6108, label: "Perception" }] },
          ],
          class: [{ id: "2-1", componentId: 10, componentTypeId: 100, type: 2, optionValue: 6108, label: "Choose a Skill" }],
        },
      })
    );

    expect(text).toContain("[✓] Choose a Skill → Perception");
    expect(text).toContain('classId=9 classMappingId=500 classFeatureId=10 type=2 choiceKey="2-1"');
    expect(text).toContain("6105 Athletics | 6108 Perception ✓");
    expect(text).toContain("Total choices: 1 | unresolved: 0");
  });

  // Regression guard for review fix #1: large pools must not be collapsed to a count.
  it("emits every option id even for large (>12) pools", async () => {
    const options = Array.from({ length: 15 }, (_, i) => ({ id: 1000 + i, label: `Opt${i}` }));
    const text = await run(
      makeChar({
        classes: [{ definition: { id: 9, name: "Barb" }, id: 500, classFeatures: [{ definition: { id: 10 } }] }],
        choices: {
          choiceDefinitions: [{ id: "100-3", options }],
          class: [{ id: "3-1", componentId: 10, componentTypeId: 100, type: 3, optionValue: 1014, label: "Big Pool" }],
        },
      })
    );

    expect(text).toContain("Opt0");
    expect(text).toContain("1014 Opt14 ✓"); // last option present + marked resolved
    expect(text).not.toContain("available (resolved"); // old count-only fallback is gone
  });

  // Regression guard for review fix #2: each class choice gets its OWNING class's ids.
  it("assigns each class choice the ids of its owning class on a multiclass character", async () => {
    const text = await run(
      makeChar({
        classes: [
          { definition: { id: 9, name: "Barbarian" }, id: 500, classFeatures: [{ definition: { id: 10 } }] },
          { definition: { id: 11, name: "Rogue" }, id: 600, classFeatures: [{ definition: { id: 20 } }] },
        ],
        choices: {
          choiceDefinitions: [
            { id: "100-2", options: [{ id: 1, label: "A" }] },
            { id: "101-2", options: [{ id: 2, label: "B" }] },
          ],
          class: [
            { id: "c-a", componentId: 10, componentTypeId: 100, type: 2, optionValue: 1, label: "Barb pick" },
            { id: "c-b", componentId: 20, componentTypeId: 101, type: 2, optionValue: 2, label: "Rogue pick" },
          ],
        },
      })
    );

    expect(text).toContain("classId=9 classMappingId=500 classFeatureId=10");
    expect(text).toContain("classId=11 classMappingId=600 classFeatureId=20");
    // The Rogue choice must NOT inherit the Barbarian's class ids.
    expect(text).not.toContain("classId=9 classMappingId=500 classFeatureId=20");
  });

  it("flags an unresolved choice", async () => {
    const text = await run(
      makeChar({
        classes: [{ definition: { id: 9, name: "Barb" }, id: 500, classFeatures: [{ definition: { id: 10 } }] }],
        choices: {
          choiceDefinitions: [],
          class: [{ id: "6-1", componentId: 10, componentTypeId: 100, type: 6, label: "Select a Weapon Mastery" }],
        },
      })
    );

    expect(text).toContain("[✗] Select a Weapon Mastery → UNRESOLVED");
    expect(text).toContain("unresolved: 1");
  });

  it("handles a character with no choices", async () => {
    const text = await run(
      makeChar({
        classes: [{ definition: { id: 9, name: "Barb" }, id: 500, classFeatures: [] }],
        choices: {},
      })
    );

    expect(text).toContain("Total choices: 0 | unresolved: 0");
  });
});
